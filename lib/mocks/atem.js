'use strict';
// Mock Blackmagic ATEM (UDP) for tests and --mock: a Television Studio HD8 ISO-like 1 M/E switcher. Speaks the
// handshake and session rules of Sofie atem-connection's atemSocketChild.ts from the switcher's side (hello reply
// with NewSessionId, reliable packets with ids, acks, a ~1 s keep-alive), sends a state dump that ends with InCm,
// applies the commands the driver sends and answers with the same update commands a switcher sends. Transitions
// run in mock time (frames at 50 fps, sped up 4x). A test double, not an emulator; every command is in `history`.
const dgram = require('dgram');
const P = require('../drivers/atem-proto');

const VERSION = 0x00020020; // 2.32 (ProtocolVersion.V9_6)
const INPUTS = [
  [0, 'Black', 'BLK', 1, 0x1e, 0x01], ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, ['Cam 1 Wide', 'Cam 2 Tight', 'Cam 3 Jib', 'Cam 4 PTZ', 'Playback', 'Laptop', 'Graphics', 'Remote'][n - 1], n <= 4 ? `CAM${n}` : ['PLAY', 'LAPT', 'GFX', 'REMT'][n - 5], 0, 0x1f, 0x01]),
  [1000, 'Color Bars', 'BARS', 2, 0x1e, 0x01], [2001, 'Color 1', 'COL1', 3, 0x1e, 0x01], [2002, 'Color 2', 'COL2', 3, 0x1e, 0x01],
  [3010, 'Media Player 1', 'MP1', 4, 0x1f, 0x01], [3020, 'Media Player 2', 'MP2', 4, 0x1f, 0x01],
  [10010, 'Program', 'PGM', 128, 0x01, 0x00], [10011, 'Preview', 'PVW', 128, 0x01, 0x00],
]; // [id, long, short, internalPortType, sourceAvailability, meAvailability]
const MACROS = [[0, 'Opener roll', 'Bars, then Cam 1'], [1, 'Lower third in', ''], [2, 'Break loop', ''], [5, 'Reset keys', '']];

class MockAtem {
  constructor() {
    this.history = []; this.sock = null; this.clients = new Map(); this.speed = 4; this.dropIncoming = 0; this.packets = [];
    this.s = { program: 1, preview: 2, style: 0, nextSelection: 1, mixRate: 25, inTransition: false, remaining: 0, handle: 0,
      ftb: { black: false, inTransition: false, remaining: 0, rate: 25 }, keyers: [false, false, false, false],
      dsk: [{ onAir: false, tie: false, rate: 25, inTransition: false }, { onAir: false, tie: false, rate: 25, inTransition: false }],
      aux: [10010, 1], macroRun: { running: false, index: 0xffff } };
    this.timers = new Set();
  }
  calls(name) { return this.history.filter((h) => h.name === name); }
  // ---------- state commands (deserialize layouts mirrored) ----------
  c = {
    ver: () => P.cmd('_ver', (() => { const b = Buffer.alloc(4); b.writeUInt32BE(VERSION, 0); return b; })()),
    pin: () => { const b = Buffer.alloc(44); b.write('ATEM Television Studio HD8 ISO', 0, 40, 'utf8'); b.writeUInt8(0x1b, 40); return P.cmd('_pin', b); },
    top: () => { const b = Buffer.alloc(24); b.writeUInt8(1, 0); b.writeUInt8(INPUTS.length, 1); b.writeUInt8(2, 2); b.writeUInt8(2, 3); b.writeUInt8(0, 4); b.writeUInt8(2, 5); b.writeUInt8(1, 6); return P.cmd('_top', b); },
    mec: () => P.cmd('_MeC', Buffer.from([0, 4, 0, 0])),
    inpr: ([id, long, short, type, srcAv, meAv]) => { const b = Buffer.alloc(36); b.writeUInt16BE(id, 0); b.write(long, 2, 20, 'utf8'); b.write(short, 22, 4, 'utf8'); b.writeUInt8(1, 26); b.writeUInt16BE(type === 0 ? 1 : 0, 28); b.writeUInt8(type, 32); b.writeUInt8(srcAv, 34); b.writeUInt8(meAv, 35); return P.cmd('InPr', b); },
    prg: () => { const b = Buffer.alloc(4); b.writeUInt16BE(this.s.program, 2); return P.cmd('PrgI', b); },
    prv: () => { const b = Buffer.alloc(8); b.writeUInt16BE(this.s.preview, 2); return P.cmd('PrvI', b); },
    trss: () => P.cmd('TrSS', Buffer.from([0, this.s.style, this.s.nextSelection, this.s.style, this.s.nextSelection, 0, 0, 0])),
    trps: () => { const b = Buffer.alloc(8); b.writeUInt8(this.s.inTransition ? 1 : 0, 1); b.writeUInt8(this.s.remaining, 2); b.writeUInt16BE(this.s.handle, 4); return P.cmd('TrPs', b); },
    tmx: () => P.cmd('TMxP', Buffer.from([0, this.s.mixRate, 0, 0])),
    ftbs: () => P.cmd('FtbS', Buffer.from([0, this.s.ftb.black ? 1 : 0, this.s.ftb.inTransition ? 1 : 0, this.s.ftb.remaining])),
    ftbp: () => P.cmd('FtbP', Buffer.from([0, this.s.ftb.rate, 0, 0])),
    keon: (k) => P.cmd('KeOn', Buffer.from([0, k, this.s.keyers[k] ? 1 : 0, 0])),
    dsks: (k) => { const d = this.s.dsk[k]; return P.cmd('DskS', Buffer.from([k, d.onAir ? 1 : 0, d.inTransition ? 1 : 0, d.inTransition ? 1 : 0, 1, 0, 0, 0])); },
    dskp: (k) => { const d = this.s.dsk[k]; const b = Buffer.alloc(20); b.writeUInt8(k, 0); b.writeUInt8(d.tie ? 1 : 0, 1); b.writeUInt8(d.rate, 2); return P.cmd('DskP', b); },
    aux: (i) => { const b = Buffer.alloc(4); b.writeUInt8(i, 0); b.writeUInt16BE(this.s.aux[i], 2); return P.cmd('AuxS', b); },
    mprp: (i) => { const m = MACROS.find((x) => x[0] === i); const name = Buffer.from(m ? m[1] : ''); const desc = Buffer.from(m ? m[2] : ''); const b = Buffer.alloc(8 + name.length + desc.length); b.writeUInt16BE(i, 0); b.writeUInt8(m ? 1 : 0, 2); b.writeUInt16BE(name.length, 4); b.writeUInt16BE(desc.length, 6); name.copy(b, 8); desc.copy(b, 8 + name.length); return P.cmd('MPrp', b); },
    mrpr: () => { const b = Buffer.alloc(4); b.writeUInt8(this.s.macroRun.running ? 1 : 0, 0); b.writeUInt16BE(this.s.macroRun.index, 2); return P.cmd('MRPr', b); },
    tlsr: () => {
      const ids = INPUTS.filter((x) => x[3] !== 128).map((x) => x[0]);
      const b = Buffer.alloc(2 + ids.length * 3); b.writeUInt16BE(ids.length, 0);
      ids.forEach((id, i) => { const pgm = id === this.s.program || (this.s.inTransition && id === this.s.preview); const pvw = id === this.s.preview; b.writeUInt16BE(id, 2 + i * 3); b.writeUInt8((pgm ? 1 : 0) | (pvw ? 2 : 0), 4 + i * 3); });
      return P.cmd('TlSr', b);
    },
    incm: () => P.cmd('InCm', Buffer.from([1, 0, 0, 0])),
  };
  dump() {
    const c = this.c;
    return [c.ver(), c.pin(), c.top(), c.mec(), ...INPUTS.map((x) => c.inpr(x)), c.prg(), c.prv(), c.trss(), c.trps(), c.tmx(), c.ftbs(), c.ftbp(),
      ...[0, 1, 2, 3].map((k) => c.keon(k)), ...[0, 1].map((k) => c.dsks(k)), ...[0, 1].map((k) => c.dskp(k)), ...[0, 1].map((i) => c.aux(i)),
      ...Array.from({ length: 10 }, (_, i) => c.mprp(i)), c.mrpr(), c.tlsr(), c.incm()];
  }
  // ---------- transport ----------
  start(port = 0, host = '127.0.0.1') {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, r) => this._recv(m, r));
    this._ka = setInterval(() => { for (const cl of this.clients.values()) if (cl.ready) this._reliable(cl, []); }, 1000); if (this._ka.unref) this._ka.unref();
    return new Promise((res) => this.sock.bind(port, host, () => res(this.sock.address().port)));
  }
  stop() {
    clearInterval(this._ka); for (const t of this.timers) clearTimeout(t); this.timers.clear();
    return new Promise((r) => { if (!this.sock) return r(); try { this.sock.close(() => r()); } catch { r(); } this.sock = null; });
  }
  _out(cl, b) { if (this.sock) this.sock.send(b, 0, b.length, cl.port, cl.address); }
  _reliable(cl, cmds) {
    // pack into packets of <= 1400 bytes
    const packets = []; let cur = [];
    let size = 0; for (const c of cmds) { if (size + c.length > 1400 && cur.length) { packets.push(cur); cur = []; size = 0; } cur.push(c); size += c.length; }
    packets.push(cur);
    for (const p of packets) {
      const payload = Buffer.concat(p); cl.nextId = (cl.nextId + 1) % P.MAX_PACKET_ID;
      this._out(cl, Buffer.concat([P.header(P.FLAG.AckRequest, 12 + payload.length, cl.session, { packetId: cl.nextId }), payload]));
    }
  }
  broadcast(cmds) { for (const cl of this.clients.values()) if (cl.ready) this._reliable(cl, cmds); }
  _recv(m, r) {
    const h = P.parseHeader(m); if (!h || h.length !== m.length) return;
    const key = `${r.address}:${r.port}`;
    if (h.flags & P.FLAG.NewSessionId) { // hello
      const cl = { address: r.address, port: r.port, session: 0x8000 | (this.clients.size + 1), nextId: 0, lastIn: 0, ready: false, helloSession: h.session };
      this.clients.set(key, cl);
      const reply = Buffer.concat([P.header(P.FLAG.NewSessionId, 20, h.session, {}), Buffer.from([0x02, 0, 0, 0, 0, 0, 0, 0])]);
      this._out(cl, reply);
      return;
    }
    const cl = this.clients.get(key); if (!cl) return;
    this.packets.push({ flags: h.flags, packetId: h.packetId, length: h.length });
    if ((h.flags & P.FLAG.AckRequest) && this.dropIncoming > 0) { this.dropIncoming--; return; } // simulate a lost packet
    if ((h.flags & P.FLAG.AckReply) && !cl.ready) { cl.ready = true; this._reliable(cl, this.dump()); }
    if (h.flags & P.FLAG.AckRequest) {
      const fresh = h.packetId !== cl.lastIn; cl.lastIn = h.packetId;
      this._out(cl, P.header(P.FLAG.AckReply, 12, cl.session, { ack: h.packetId }));
      if (fresh && m.length > 12) for (const c of P.splitCommands(m.subarray(12))) this._apply(c.name, c.data);
    }
  }
  _later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms / this.speed); this.timers.add(t); }
  _apply(name, d) {
    this.history.push({ name, hex: d.toString('hex'), at: Date.now() });
    const s = this.s; const c = this.c;
    switch (name) {
      case 'CPgI': s.program = d.readUInt16BE(2); return this.broadcast([c.prg(), c.tlsr()]);
      case 'CPvI': s.preview = d.readUInt16BE(2); return this.broadcast([c.prv(), c.tlsr()]);
      case 'DCut': { [s.program, s.preview] = [s.preview, s.program]; this._keysAfter(); return this.broadcast([c.prg(), c.prv(), c.tlsr(), ...[0, 1, 2, 3].map((k) => c.keon(k))]); }
      case 'DAut': {
        if (s.inTransition) return;
        s.inTransition = true; s.remaining = s.mixRate; this.broadcast([c.trps(), c.tlsr()]);
        return this._later(s.mixRate * 20, () => { s.inTransition = false; s.remaining = 0; [s.program, s.preview] = [s.preview, s.program]; this._keysAfter(); this.broadcast([c.trps(), c.prg(), c.prv(), c.tlsr(), ...[0, 1, 2, 3].map((k) => c.keon(k))]); });
      }
      case 'CTTp': { const f = d.readUInt8(0); if (f & 1) s.style = d.readUInt8(2); if (f & 2) s.nextSelection = d.readUInt8(3) || 1; return this.broadcast([c.trss()]); }
      case 'CTMx': s.mixRate = d.readUInt8(1); return this.broadcast([c.tmx()]);
      case 'FtbA': { s.ftb.inTransition = true; this.broadcast([c.ftbs()]); return this._later(s.ftb.rate * 20, () => { s.ftb.inTransition = false; s.ftb.black = !s.ftb.black; this.broadcast([c.ftbs()]); }); }
      case 'FtbC': s.ftb.rate = d.readUInt8(2); return this.broadcast([c.ftbp()]);
      case 'CKOn': s.keyers[d.readUInt8(1)] = d.readUInt8(2) === 1; return this.broadcast([c.keon(d.readUInt8(1))]);
      case 'CDsL': s.dsk[d.readUInt8(0)].onAir = d.readUInt8(1) === 1; return this.broadcast([c.dsks(d.readUInt8(0))]);
      case 'CDsT': s.dsk[d.readUInt8(0)].tie = d.readUInt8(1) === 1; return this.broadcast([c.dskp(d.readUInt8(0))]);
      case 'DDsA': { const k = d.readUInt8(1); const x = s.dsk[k]; if (!x) return; x.inTransition = true; this.broadcast([c.dsks(k)]); return this._later(x.rate * 20, () => { x.inTransition = false; x.onAir = !x.onAir; this.broadcast([c.dsks(k)]); }); }
      case 'CAuS': s.aux[d.readUInt8(1)] = d.readUInt16BE(2); return this.broadcast([c.aux(d.readUInt8(1))]);
      case 'MAct': {
        const i = d.readUInt16BE(0); const a = d.readUInt8(2);
        if (a === 0 && MACROS.some((x) => x[0] === i)) { s.macroRun = { running: true, index: i }; this.broadcast([c.mrpr()]); return this._later(2000, () => { s.macroRun = { running: false, index: 0xffff }; this.broadcast([c.mrpr()]); }); }
        if (a === 1) { s.macroRun = { running: false, index: 0xffff }; return this.broadcast([c.mrpr()]); }
        return undefined;
      }
      default: return undefined;
    }
  }
  _keysAfter() { // keys tied to the transition flip on air with it
    const s = this.s; for (let k = 0; k < 4; k++) if (s.nextSelection & (1 << (k + 1))) s.keyers[k] = !s.keyers[k];
    for (const x of s.dsk) if (x.tie) x.onAir = !x.onAir;
  }
}

module.exports = { MockAtem, INPUTS, MACROS };
