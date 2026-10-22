'use strict';
// Blackmagic ATEM switcher driver: native UDP client (dgram) for the protocol in ./atem-proto.js. The session
// logic follows Sofie atem-connection src/lib/atemSocketChild.ts: send the hello, take the session id the
// switcher answers with, ack every AckRequest packet (in order; later ones are dropped and the switcher resends),
// send our commands as AckRequest packets and resend them until acked. The state dump ends with InCm.
const dgram = require('dgram');
const P = require('./atem-proto');

const CONNECT_TIMEOUT = 4000; const SILENCE_TIMEOUT = 5000; const RESEND_MS = 80; const MAX_RESEND = 10;

class AtemDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'atem';
    this.log = log; this.onChange = onChange;
    this.capabilities = { atemSwitcher: true, atemAux: true, atemMacros: true, atem: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.sock = null; this.state = P.emptyState(); this.silenceMs = SILENCE_TIMEOUT; this.connectMs = CONNECT_TIMEOUT;
    this.configure(conn);
  }
  configure(conn) { this.close(); this.conn = { host: '', port: 9910, me: 1, ...conn }; }
  get me() { return Math.max(0, (Number(this.conn.me) || 1) - 1); }
  status() { return { ...this.st }; }
  close() {
    if (this.sock) { try { this.sock.close(); } catch { /* already closed */ } }
    this.sock = null; this.inflight = []; this.st.connected = false;
    if (this._resend) clearInterval(this._resend); this._resend = null;
  }
  _changed() { if (this._chg) return; this._chg = setTimeout(() => { this._chg = null; this.onChange(); }, 20); if (this._chg.unref) this._chg.unref(); }

  connect() {
    if (!this.conn.host) return Promise.reject(new Error('ATEM: no IP address set (SYSTEMS tab)'));
    this.close();
    this.state = P.emptyState(); this.session = 0; this.lastRemote = 0; this.nextId = 1; this.inflight = [];
    const sock = dgram.createSocket('udp4'); this.sock = sock;
    return new Promise((resolve, reject) => {
      let done = false;
      const fin = (e) => { if (done) return; done = true; clearTimeout(t); if (e) { this.st.error = e.message; this.close(); reject(e); } else resolve(this.st.info); };
      const t = setTimeout(() => fin(new Error(`ATEM ${this.conn.host}:${this.conn.port}: no answer within ${this.connectMs / 1000} s`)), this.connectMs);
      this._onInit = () => fin(null);
      sock.on('error', (e) => fin(new Error(`ATEM: ${e.message}`)));
      sock.on('message', (m, r) => this._receive(m, r));
      sock.bind(0, () => { this._send(P.HELLO); });
      this._resend = setInterval(() => this._checkResend(), RESEND_MS); if (this._resend.unref) this._resend.unref();
    });
  }
  async heartbeat() {
    if (!this.st.connected) throw new Error(this.st.error || 'not connected');
    if (Date.now() - this.st.lastSeen > this.silenceMs) { this.st.connected = false; this.st.error = 'switcher stopped answering'; this.close(); this._changed(); throw new Error(this.st.error); }
  }
  _send(b) { if (this.sock) this.sock.send(b, 0, b.length, Number(this.conn.port) || 9910, this.conn.host); }
  _ack(id) { this._send(P.header(P.FLAG.AckReply, 12, this.session, { ack: id })); }
  _receive(m, rinfo) {
    const h = P.parseHeader(m); if (!h || h.length !== rinfo.size) return;
    this.st.lastSeen = Date.now(); this.session = h.session;
    if (h.flags & P.FLAG.NewSessionId) { this.lastRemote = h.packetId; this._ack(h.packetId); return; }
    if (h.flags & P.FLAG.RetransmitRequest) this._resendFrom(h.retransmitFrom % P.MAX_PACKET_ID);
    if (h.flags & P.FLAG.AckRequest) {
      const dist = (h.packetId - this.lastRemote + P.MAX_PACKET_ID) % P.MAX_PACKET_ID;
      if (dist === 1) {
        this.lastRemote = h.packetId;
        if (m.length > 12) this._commands(m.subarray(12));
        this._ack(h.packetId);
      } else if (dist === 0 || dist > P.MAX_PACKET_ID / 2) this._ack(this.lastRemote); // a resend of something we have
    }
    if (h.flags & P.FLAG.AckReply) {
      const covered = (ack, id) => id === ack || ((ack - id + P.MAX_PACKET_ID) % P.MAX_PACKET_ID) < P.MAX_PACKET_ID / 2;
      const left = [];
      for (const f of this.inflight) { if (covered(h.ack, f.id)) f.resolve(); else left.push(f); }
      this.inflight = left;
    }
  }
  _commands(payload) {
    let any = false;
    for (const c of P.splitCommands(payload)) { try { if (P.applyCommand(this.state, c.name, c.data)) any = true; } catch (e) { this.log('warn', `ATEM: bad ${c.name} (${e.message})`); } }
    if (this.state.initComplete && !this.st.connected) {
      this.st.connected = true; this.st.error = null;
      this.st.info = { model: this.state.product || P.MODELS[this.state.model] || 'ATEM', version: `${this.state.version >> 16}.${this.state.version & 0xffff}`, modelId: this.state.model };
      if (this._onInit) { const f = this._onInit; this._onInit = null; f(); }
    }
    if (any && this.st.connected) this._changed();
  }
  _resendFrom(id) { for (const f of this.inflight) if (f.id === id || ((f.id - id + P.MAX_PACKET_ID) % P.MAX_PACKET_ID) < P.MAX_PACKET_ID / 2) { f.sent = Date.now(); f.tries++; this._send(f.buf); } }
  _checkResend() {
    const now = Date.now();
    for (const f of this.inflight.slice()) {
      if (now - f.sent < RESEND_MS) continue;
      if (f.tries >= MAX_RESEND) { this.inflight = this.inflight.filter((x) => x !== f); f.reject(new Error('ATEM did not acknowledge the command')); continue; }
      f.sent = now; f.tries++; const b = Buffer.from(f.buf); b.writeUInt16BE(b.readUInt16BE(0) | (P.FLAG.IsRetransmit << 11), 0); this._send(b);
    }
  }
  send(...cmds) {
    if (!this.st.connected || !this.sock) return Promise.reject(Object.assign(new Error('ATEM not connected'), { status: 409 }));
    const payload = Buffer.concat(cmds);
    const id = this.nextId; this.nextId = (this.nextId + 1) % P.MAX_PACKET_ID;
    const b = Buffer.concat([P.header(P.FLAG.AckRequest, 12 + payload.length, this.session, { packetId: id }), payload]);
    return new Promise((resolve, reject) => { this.inflight.push({ id, buf: b, sent: Date.now(), tries: 0, resolve, reject }); this._send(b); });
  }

  // ---------- commands (names as in the ATEM SDK / Companion module) ----------
  _src(s) { const n = Number(s); if (!Number.isInteger(n) || !this.state.inputs[n]) throw Object.assign(new Error(`ATEM has no source ${s}`), { status: 400 }); return n; }
  _me(me) { const m = me === undefined ? this.me : Number(me); const tot = (this.state.topology && this.state.topology.mixEffects) || 1; if (!(m >= 0 && m < tot)) throw Object.assign(new Error(`ATEM has no M/E ${m + 1}`), { status: 400 }); return m; }
  cut(me) { return this.send(P.OUT.cut(this._me(me))); }
  auto(me) { return this.send(P.OUT.auto(this._me(me))); }
  program(src, me) { return this.send(P.OUT.program(this._me(me), this._src(src))); }
  preview(src, me) { return this.send(P.OUT.preview(this._me(me), this._src(src))); }
  style(style, me) { const i = typeof style === 'number' ? style : P.STYLES.indexOf(String(style).toUpperCase()); if (i < 0 || i > 4) throw Object.assign(new Error('Style must be MIX, DIP, WIPE, DVE or STING'), { status: 400 }); return this.send(P.OUT.style(this._me(me), i)); }
  mixRate(rate, me) { const r = Number(rate); if (!(r >= 1 && r <= 250)) throw Object.assign(new Error('Rate is 1..250 frames'), { status: 400 }); return this.send(P.OUT.mixRate(this._me(me), r)); }
  ftb(me) { return this.send(P.OUT.ftb(this._me(me))); }
  ftbRate(rate, me) { const r = Number(rate); if (!(r >= 1 && r <= 250)) throw Object.assign(new Error('Rate is 1..250 frames'), { status: 400 }); return this.send(P.OUT.ftbRate(this._me(me), r)); }
  // next transition: background + keys (TIE on an upstream key = include it in the next transition)
  nextSelection(sel, me) { const v = Number(sel) & 0x1f; if (!v) throw Object.assign(new Error('The next transition needs at least one layer'), { status: 400 }); return this.send(P.OUT.nextSelection(this._me(me), v)); }
  uskTie(key, on, me) { const m = this._me(me); const cur = (this.state.mes[m] || {}).nextSelection || 1; const bit = 1 << (Number(key) + 1); return this.nextSelection(on ? cur | bit : cur & ~bit, m); }
  uskOnAir(key, on, me) { const m = this._me(me); const n = Number(key); if (!(n >= 0 && n < ((this.state.mes[m] || {}).keyCount || 0))) throw Object.assign(new Error(`No upstream key ${n + 1}`), { status: 400 }); return this.send(P.OUT.uskOnAir(m, n, on)); }
  _dsk(i) { const n = Number(i); const tot = (this.state.topology && this.state.topology.downstreamKeyers) || 0; if (!(n >= 0 && n < tot)) throw Object.assign(new Error(`No downstream key ${n + 1}`), { status: 400 }); return n; }
  dskAuto(i) { return this.send(P.OUT.dskAuto(this._dsk(i), this.state.version)); }
  dskOnAir(i, on) { return this.send(P.OUT.dskOnAir(this._dsk(i), on)); }
  dskTie(i, tie) { return this.send(P.OUT.dskTie(this._dsk(i), tie)); }
  aux(i, src) { const n = Number(i); const tot = (this.state.topology && this.state.topology.auxilliaries) || 0; if (!(n >= 0 && n < tot)) throw Object.assign(new Error(`No aux ${n + 1}`), { status: 400 }); return this.send(P.OUT.aux(n, this._src(src))); }
  macroRun(i) { const n = Number(i); if (!this.state.macros[n] || !this.state.macros[n].isUsed) throw Object.assign(new Error(`Macro ${n + 1} is empty`), { status: 400 }); return this.send(P.OUT.macroRun(n)); }
  macroStop() { return this.send(P.OUT.macroStop()); }

  view() {
    const s = this.state; const me = this.me; const m = s.mes[me] || {};
    const inputs = Object.values(s.inputs).sort((a, b) => a.id - b.id);
    const tally = s.tally;
    const on = (x) => inputs.filter((i) => tally[i.id] && tally[i.id][x]).map((i) => i.shortName || String(i.id));
    return {
      topology: s.topology, protocol: s.version ? `${s.version >> 16}.${s.version & 0xffff}` : '', product: s.product, model: P.MODELS[s.model] || '', me: me + 1,
      bus: inputs.filter((i) => i.meAvailability & (1 << me)).map((i) => ({ id: i.id, long: i.longName, short: i.shortName, type: i.internalPortType, pgm: m.program === i.id, pvw: m.preview === i.id })),
      auxSources: inputs.filter((i) => i.sourceAvailability & 0x01).map((i) => ({ id: i.id, long: i.longName, short: i.shortName })),
      inputs: inputs.map((i) => ({ id: i.id, long: i.longName, short: i.shortName, type: i.internalPortType, tally: tally[i.id] || null })),
      program: m.program, preview: m.preview, style: P.STYLES[m.style] || String(m.style), nextStyle: P.STYLES[m.nextStyle] || String(m.nextStyle), styles: P.STYLES,
      nextSelection: m.nextSelection || 1, inTransition: !!m.inTransition, remainingFrames: m.remainingFrames || 0, handle: m.handle || 0, mixRate: m.mixRate,
      ftb: m.ftb || null, keyers: Array.from({ length: m.keyCount || 0 }, (_, k) => ({ index: k, onAir: !!(m.keyers && m.keyers[k] && m.keyers[k].onAir), tie: !!((m.nextSelection || 0) & (1 << (k + 1))) })),
      dsk: Array.from({ length: (s.topology && s.topology.downstreamKeyers) || 0 }, (_, k) => ({ index: k, ...(s.dsk[k] || {}) })),
      aux: Array.from({ length: (s.topology && s.topology.auxilliaries) || 0 }, (_, k) => ({ index: k, source: s.aux[k] })),
      macros: Object.values(s.macros).filter((x) => x.isUsed).sort((a, b) => a.index - b.index), macroRun: s.macroRun,
      tally: { program: on('program'), preview: on('preview') },
    };
  }
}

module.exports = { AtemDriver };
