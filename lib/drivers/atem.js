'use strict';
// Blackmagic ATEM switcher driver: native UDP client (dgram) for the protocol in ./atem-proto.js. The session
// logic follows Sofie atem-connection src/lib/atemSocketChild.ts: send the hello, take the session id the
// switcher answers with, ack every AckRequest packet (in order; later ones are dropped and the switcher resends),
// send our commands as AckRequest packets and resend them until acked. The state dump ends with InCm.
const dgram = require('dgram');
const P = require('./atem-proto');
const M = require('./atem-models');

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const clampN = (v, a, b) => { const n = Number(v); if (!Number.isFinite(n)) throw bad(`${v} is not a number`); return Math.max(a, Math.min(b, n)); };
const clampDb = (v, a, b) => (v === '-inf' || v === -Infinity || v === null ? a : clampN(v, a, b));

const CONNECT_TIMEOUT = 4000; const SILENCE_TIMEOUT = 5000; const RESEND_MS = 80; const MAX_RESEND = 10;

class AtemDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'atem';
    this.log = log; this.onChange = onChange;
    this.capabilities = { atemSwitcher: true, atemAux: true, atemMacros: true, atem: true, atemRouter: true, atemAudio: true, atemKeys: true, atemSuperSource: true };
    this._lastMix = {};
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

  // ---------- 0.10.0: model profile, router, audio, keyers, DSK, SuperSource ----------
  // Indexes here are 0-based (M/E, key, DSK, aux, multiviewer, window, SuperSource, box); the HTTP ops are 1-based.
  profileInfo() {
    const s = this.state; const d = M.detect(s.model, s.topology); const p = d && M.profile(d.key);
    return p ? { ...M.summary(p), mismatch: d.mismatch, detected: true } : null;
  }
  _profile() { const s = this.state; const d = M.detect(s.model, s.topology); return d ? M.profile(d.key) : null; }
  _key(me, key) { const m = this._me(me); const n = Number(key); if (!(Number.isInteger(n) && n >= 0 && n < ((this.state.mes[m] || {}).keyCount || 0))) throw bad(`No upstream key ${n + 1} on M/E ${m + 1}`); return [m, n]; }
  _srcFor(src, bit, what) { const n = this._src(src); if (!(this.state.inputs[n].sourceAvailability & bit)) throw bad(`${this.state.inputs[n].longName || n} cannot be routed to ${what}`); return n; }
  _mvCount() { const t = this.state.topology; const p = this._profile(); return t && t.multiviewers >= 0 ? t.multiviewers : p ? p.multiviewers : Object.keys(this.state.mv).length; }
  _mvWindows() { const c = this.state.mvConfig; const p = this._profile(); return (c && c.windowCount) || (p && p.mvWindows) || 0; }
  _mvRoutable(w) { const p = this._profile(); const r = p ? p.mvRoutable : 'all'; return r === 'all' || (r === 'small' && w >= 2); }
  // Router: an output key is 'aux:<i>', 'me:<m>:program' | 'me:<m>:preview' or 'mv:<m>:<w>' (all 0-based)
  route(output, src) {
    const k = String(output).split(':');
    if (k[0] === 'aux') return this.aux(k[1], this._srcFor(src, M.AV.Auxiliary, 'an aux output'));
    if (k[0] === 'me') { const m = this._me(k[1]); const n = this._src(src); if (!(this.state.inputs[n].meAvailability & (1 << m))) throw bad(`${this.state.inputs[n].longName || n} is not on the M/E ${m + 1} bus`); if (k[2] === 'program') return this.program(n, m); if (k[2] === 'preview') return this.preview(n, m); }
    if (k[0] === 'mv') return this.mvSource(k[1], k[2], src);
    throw bad(`Unknown output ${output}`);
  }
  mvSource(mv, win, src) {
    const m = Number(mv); const w = Number(win);
    if (!(Number.isInteger(m) && m >= 0 && m < this._mvCount())) throw bad(`No multiviewer ${m + 1}`);
    if (!(Number.isInteger(w) && w >= 0 && w < this._mvWindows())) throw bad(`No multiviewer window ${w + 1}`);
    if (!this._mvRoutable(w)) throw bad(`Multiviewer window ${w + 1} is fixed on this model`);
    return this.send(P.OUT.mvSource(m, w, this._srcFor(src, M.AV.Multiviewer, 'a multiviewer window')));
  }
  // Upstream keys. `changes` uses the switcher's own integer units (see atem-proto.js); unknown fields are refused.
  _masked(cmdName, cur, changes) {
    const names = P.MASKS[cmdName]; const keys = Object.keys(changes || {});
    for (const k of keys) if (!names.includes(k)) throw bad(`${cmdName}: unknown field ${k} (fields: ${names.filter(Boolean).join(', ')})`);
    if (!keys.length) throw bad('Nothing to change');
    const props = { ...cur }; for (const k of keys) props[k] = typeof changes[k] === 'boolean' ? changes[k] : Number(changes[k]);
    for (const k of keys) if (typeof props[k] === 'number' && !Number.isFinite(props[k])) throw bad(`${k} must be a number`);
    return [props, P.maskOf(cmdName, keys)];
  }
  uskType(me, key, type, flyEnabled) {
    const [m, k] = this._key(me, key); const cur = this.state.mes[m].keyers[k] || {}; const ch = {};
    if (type !== undefined) { const t = typeof type === 'number' ? type : P.KEY_TYPES.indexOf(String(type).toLowerCase()); if (!(t >= 0 && t <= 3)) throw bad('Key type is luma, chroma, pattern or dve'); ch.type = t; }
    if (flyEnabled !== undefined) ch.flyEnabled = !!flyEnabled;
    const p = this._profile();
    if (ch.type === 3 && p && !p.dve) throw bad(`${p.name} has no DVE`);
    const [props, mask] = this._masked('CKTp', { type: cur.type || 0, flyEnabled: !!cur.flyEnabled }, ch);
    return this.send(P.OUT.uskType(m, k, props, mask));
  }
  uskSources(me, key, { fill, cut } = {}) {
    const [m, k] = this._key(me, key); const out = [];
    if (fill !== undefined) out.push(P.OUT.uskFill(m, k, this._srcFor(fill, M.AV.KeySource, 'a key fill')));
    if (cut !== undefined) out.push(P.OUT.uskCut(m, k, this._src(cut)));
    if (!out.length) throw bad('Give fill and / or cut'); return this.send(...out);
  }
  uskLuma(me, key, ch) { const [m, k] = this._key(me, key); const [p, mask] = this._masked('CKLm', (this.state.mes[m].keyers[k] || {}).luma, ch); return this.send(P.OUT.uskLuma(m, k, p, mask)); }
  uskChroma(me, key, ch) { const [m, k] = this._key(me, key); const [p, mask] = this._masked('CKCk', (this.state.mes[m].keyers[k] || {}).chroma, ch); return this.send(P.OUT.uskChroma(m, k, p, mask)); }
  uskPattern(me, key, ch) { const [m, k] = this._key(me, key); const [p, mask] = this._masked('CKPt', (this.state.mes[m].keyers[k] || {}).pattern, ch); return this.send(P.OUT.uskPattern(m, k, p, mask)); }
  uskMask(me, key, ch) { const [m, k] = this._key(me, key); const [p, mask] = this._masked('CKMs', (this.state.mes[m].keyers[k] || {}).mask, ch); return this.send(P.OUT.uskMask(m, k, p, mask)); }
  uskDve(me, key, ch) { const [m, k] = this._key(me, key); const p0 = this._profile(); if (p0 && !p0.dve) throw bad(`${p0.name} has no DVE`); const [p, mask] = this._masked('CKDV', (this.state.mes[m].keyers[k] || {}).dve, ch); return this.send(P.OUT.uskDve(m, k, p, mask)); }
  uskFlyStore(me, key, frame) { const [m, k] = this._key(me, key); const f = P.FLY_FRAMES[String(frame).toLowerCase()]; if (f !== 1 && f !== 2) throw bad('Key frame is A or B'); return this.send(P.OUT.uskFlyStore(m, k, f)); }
  uskFlyRun(me, key, frame, direction = 0) { const [m, k] = this._key(me, key); const f = P.FLY_FRAMES[String(frame).toLowerCase()]; if (!f) throw bad('Run to A, B, full or infinite'); return this.send(P.OUT.uskFlyRun(m, k, f, Number(direction) || 0)); }
  // Downstream keys
  dskSources(i, { fill, cut } = {}) { const n = this._dsk(i); const out = []; if (fill !== undefined) out.push(P.OUT.dskFill(n, this._src(fill))); if (cut !== undefined) out.push(P.OUT.dskCut(n, this._src(cut))); if (!out.length) throw bad('Give fill and / or cut'); return this.send(...out); }
  dskGeneral(i, ch) { const n = this._dsk(i); const [p, mask] = this._masked('CDsG', this.state.dsk[n], ch); return this.send(P.OUT.dskGeneral(n, p, mask)); }
  dskMask(i, ch) { const n = this._dsk(i); const [p, mask] = this._masked('CDsM', (this.state.dsk[n] || {}).mask, ch); return this.send(P.OUT.dskMask(n, p, mask)); }
  dskRate(i, rate) { const n = this._dsk(i); const r = Number(rate); if (!(r >= 1 && r <= 250)) throw bad('Rate is 1..250 frames'); return this.send(P.OUT.dskRate(n, r)); }
  // SuperSource
  _ss(i) { const n = Number(i); const tot = (this.state.topology && this.state.topology.superSources) || 0; if (!(Number.isInteger(n) && n >= 0 && n < tot)) throw bad(`No SuperSource ${n + 1}`); return n; }
  _box(ss, b) { const n = Number(b); const cnt = (this.state.ssConfig[ss] || {}).boxCount || 4; if (!(Number.isInteger(n) && n >= 0 && n < cnt)) throw bad(`No SuperSource box ${n + 1}`); return n; }
  ssBox(ss, box, ch) {
    const i = this._ss(ss); const b = this._box(i, box); const c = { ...ch };
    if (c.source !== undefined) c.source = this._srcFor(c.source, M.AV.SuperSourceBox, 'a SuperSource box');
    const [p, mask] = this._masked('CSBP', (this.state.ss[i] && this.state.ss[i].boxes[b]) || {}, c);
    return this.send(P.OUT.ssBox(i, b, p, mask, this.state.version));
  }
  ssProps(ss, ch) { const i = this._ss(ss); const c = { ...ch }; if (c.artFillSource !== undefined) c.artFillSource = this._srcFor(c.artFillSource, M.AV.SuperSourceArt, 'the SuperSource art'); if (c.artCutSource !== undefined) c.artCutSource = this._src(c.artCutSource);
    const [p, mask] = this._masked('CSSc', (this.state.ss[i] || {}).props, c); return this.send(P.OUT.ssProps(i, p, mask)); }
  ssBorder(ss, ch) { const i = this._ss(ss); const [p, mask] = this._masked('CSBd', (this.state.ss[i] || {}).border, ch); return this.send(P.OUT.ssBorder(i, p, mask)); }
  // A layout: [{ box, enabled, x, y, size, cropped, cropTop, ... , source? }]; sources are only sent with withSources
  ssLayout(ss, boxes, withSources = false) {
    const i = this._ss(ss); if (!Array.isArray(boxes) || !boxes.length) throw bad('A layout needs boxes');
    const out = [];
    for (const [n, x] of boxes.entries()) {
      const b = this._box(i, x.box !== undefined ? x.box : n);
      const ch = {}; for (const f of ['enabled', 'x', 'y', 'size', 'cropped', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight']) if (x[f] !== undefined) ch[f] = x[f];
      if (withSources && x.source !== undefined) ch.source = this._srcFor(x.source, M.AV.SuperSourceBox, 'a SuperSource box');
      const [p, mask] = this._masked('CSBP', (this.state.ss[i] && this.state.ss[i].boxes[b]) || {}, ch);
      out.push(P.OUT.ssBox(i, b, p, mask, this.state.version));
    }
    return this.send(...out);
  }
  // Audio: friendly units for both mixers. dB for gain / fader, balance -100 (left) .. +100 (right), mix 'on' | 'off' | 'afv'.
  _audioType() { return this.state.audioMixer ? this.state.audioMixer.type : this.state.fairlight ? 'fairlight' : this.state.classic ? 'classic' : null; }
  _audioIn(id) {
    const n = Number(id); const t = this._audioType(); if (!t) throw bad('This switcher reported no audio mixer');
    const x = t === 'classic' ? this.state.classic.inputs[n] : this.state.fairlight.inputs[n];
    if (!x) throw bad(`No audio input ${id}`); return [t, n, x];
  }
  _flSrc(x) { const keys = Object.keys(x.sources || {}); return keys.includes(P.FL_STEREO) ? P.FL_STEREO : keys[0]; }
  audioInput(id, { mix, gain, fader, balance } = {}) {
    const [t, n, x] = this._audioIn(id);
    if (t === 'classic') {
      const ch = {};
      if (mix !== undefined) { const i = P.MIX.classic.indexOf(String(mix).toLowerCase()); if (i < 0) throw bad('mix is on, off or afv'); ch.mixOption = i; }
      const lvl = fader !== undefined ? fader : gain; // the classic mixer has one level per input
      if (lvl !== undefined) ch.gain = P.dbToU16(clampDb(lvl, -60, 6));
      if (balance !== undefined) ch.balance = Math.round(clampN(balance, -100, 100) * 100);
      const [p, mask] = this._masked('CAMI', x, ch); return this.send(P.OUT.classicInput(n, p, mask));
    }
    const sid = this._flSrc(x); const cur = x.sources[sid]; if (!cur) throw bad(`Audio input ${id} has no channel`);
    const ch = {};
    if (mix !== undefined) { const v = P.FL_MIX[String(mix).toLowerCase()]; if (!v) throw bad('mix is on, off or afv'); if (cur.supportedMixOptions && !(cur.supportedMixOptions & v)) throw bad(`Audio input ${id} has no ${mix} option`); ch.mixOption = v; }
    if (gain !== undefined) ch.gain = Math.round(clampDb(gain, -100, 6) * 100);
    if (fader !== undefined) ch.faderGain = Math.round(clampDb(fader, -100, 10) * 100);
    if (balance !== undefined) ch.balance = Math.round(clampN(balance, -100, 100) * 100);
    const [p, mask] = this._masked('CFSP', cur, ch); return this.send(P.OUT.flSource(n, sid, p, mask));
  }
  audioMute(id, mute) {
    const [t, n, x] = this._audioIn(id); const cur = this._audioView(t, n, x);
    const want = mute === 'toggle' || mute === undefined ? !cur.muted : !!mute;
    if (want) { if (cur.mix !== 'off') this._lastMix[`${t}:${n}`] = cur.mix; return this.audioInput(n, { mix: 'off' }); }
    const back = this._lastMix[`${t}:${n}`] || 'on'; return this.audioInput(n, { mix: back });
  }
  audioNudge(id, delta) { const [t, n, x] = this._audioIn(id); const v = this._audioView(t, n, x); const d = Number(delta); if (!Number.isFinite(d)) throw bad('delta (dB) must be a number'); const from = Number.isFinite(v.fader) ? v.fader : -60; return this.audioInput(n, { fader: from + d }); }
  audioMaster({ fader, followFadeToBlack } = {}) {
    const t = this._audioType(); if (!t) throw bad('This switcher reported no audio mixer'); const ch = {};
    if (t === 'classic') { if (fader !== undefined) ch.gain = P.dbToU16(clampDb(fader, -60, 6)); if (followFadeToBlack !== undefined) ch.followFadeToBlack = !!followFadeToBlack; const [p, mask] = this._masked('CAMM', this.state.classic.master, ch); return this.send(P.OUT.classicMaster(p, mask)); }
    if (fader !== undefined) ch.faderGain = Math.round(clampDb(fader, -100, 10) * 100); if (followFadeToBlack !== undefined) ch.followFadeToBlack = !!followFadeToBlack;
    const [p, mask] = this._masked('CFMP', this.state.fairlight.master, ch); return this.send(P.OUT.flMaster(p, mask));
  }
  audioMasterNudge(delta) { const v = this.audioView(); if (!v) throw bad('This switcher reported no audio mixer'); const d = Number(delta); if (!Number.isFinite(d)) throw bad('delta (dB) must be a number'); return this.audioMaster({ fader: (Number.isFinite(v.master.fader) ? v.master.fader : -60) + d }); }
  audioMonitor({ gain, mute, dim, enabled } = {}) {
    const t = this._audioType(); const ch = {};
    if (t === 'classic') { const cur = this.state.classic.monitor; if (!cur) throw bad('No monitor output'); if (gain !== undefined) ch.gain = P.dbToU16(clampDb(gain, -60, 6)); if (mute !== undefined) ch.mute = !!mute; if (dim !== undefined) ch.dim = !!dim; if (enabled !== undefined) ch.enabled = !!enabled;
      const [p, mask] = this._masked('CAMm', cur, ch); return this.send(P.OUT.classicMonitor(p, mask)); }
    if (t !== 'fairlight' || !this.state.fairlight.monitor) throw bad('This switcher has no monitor / headphone output');
    if (gain !== undefined) ch.gain = Math.round(clampDb(gain, -60, 6) * 100); if (mute !== undefined) ch.inputMasterMuted = !!mute;
    const [p, mask] = this._masked('CFMH', this.state.fairlight.monitor, ch); return this.send(P.OUT.flMonitor(p, mask));
  }
  audioHeadphones({ gain, program, talkback, sidetone } = {}) {
    if (this._audioType() !== 'classic' || !this.state.classic.headphones) return this.audioMonitor({ gain }); // Fairlight: the monitor bus feeds the headphones
    const ch = {}; const db = (v) => P.dbToU16(clampDb(v, -60, 6));
    if (gain !== undefined) ch.gain = db(gain); if (program !== undefined) ch.programOutGain = db(program); if (talkback !== undefined) ch.talkbackGain = db(talkback); if (sidetone !== undefined) ch.sidetoneGain = db(sidetone);
    const [p, mask] = this._masked('CAMH', this.state.classic.headphones, ch); return this.send(P.OUT.classicHeadphones(p, mask));
  }
  audioSolo(id, on = true) {
    const t = this._audioType();
    if (t === 'classic') { const ch = { solo: !!on }; if (on) ch.soloSource = this._audioIn(id)[1]; const [p, mask] = this._masked('CAMm', this.state.classic.monitor, ch); return this.send(P.OUT.classicMonitor(p, mask)); }
    if (t !== 'fairlight' || !this.state.fairlight.monitor) throw bad('This switcher has no solo bus');
    if (!on) return this.send(P.OUT.flSolo({ solo: false }, 1));
    const [, n, x] = this._audioIn(id); return this.send(P.OUT.flSolo({ solo: true, index: n, source: this._flSrc(x) }, 3));
  }
  audioRoute(output, source) {
    const o = this.state.routing.outputs[Number(output)]; if (!o) throw bad(`No audio routing output ${output}`);
    const s = this.state.routing.sources[Number(source)]; if (!s) throw bad(`No audio routing source ${source}`);
    return this.send(P.OUT.audioRoute(o.id, s.id));
  }
  _audioView(t, n, x) {
    if (t === 'classic') return { id: n, mix: P.MIX.classic[x.mixOption] || 'off', muted: x.mixOption === 0, fader: P.u16ToDb(x.gain), gain: null, balance: Math.round(x.balance / 100), supported: x.id < 1000 || x.id >= 2000 ? ['off', 'on', 'afv'] : ['off', 'on'], ext: x.portType };
    const sid = this._flSrc(x); const c = (x.sources || {})[sid] || {};
    const sup = ['off', 'on', 'afv'].filter((k) => !c.supportedMixOptions || c.supportedMixOptions & P.FL_MIX[k]);
    return { id: n, source: sid, mix: P.MIX.fairlight[c.mixOption] || 'off', muted: c.mixOption === 1, fader: c.faderGain / 100, gain: c.gain / 100, balance: Math.round(c.balance / 100), supported: sup, ext: (x.props || {}).externalPortType, framesDelay: c.framesDelay };
  }
  audioView() {
    const t = this._audioType(); if (!t) return null; const p = this._profile() || { audio: { type: t }, family: '' };
    const name = (id) => M.audioName(id, p); const ext = (e) => M.EXT_NAME[e] || '';
    if (t === 'classic') {
      const c = this.state.classic; const mo = c.monitor;
      return { type: t, inputs: Object.values(c.inputs).sort((a, b) => a.id - b.id).map((x) => { const v = this._audioView(t, x.id, x); return { ...v, name: name(x.id), port: ext(x.portType), solo: !!(mo && mo.solo && mo.soloSource === x.id) }; }),
        master: { fader: P.u16ToDb((c.master || {}).gain || 0), balance: Math.round(((c.master || {}).balance || 0) / 100), followFadeToBlack: !!(c.master || {}).followFadeToBlack },
        monitor: mo ? { gain: P.u16ToDb(mo.gain), mute: mo.mute, dim: mo.dim, enabled: mo.enabled, solo: mo.solo, soloSource: mo.soloSource } : null, headphones: c.headphones ? { gain: P.u16ToDb(c.headphones.gain) } : null, afv: !!c.afv, routing: null };
    }
    const f = this.state.fairlight; const so = f.solo;
    const r = this.state.routing; const srcName = (id) => (r.sources[id] ? r.sources[id].name : id >>> 16 ? `Source ${id >>> 16}` : 'No Audio');
    return { type: t, inputs: Object.values(f.inputs).sort((a, b) => a.id - b.id).map((x) => { const v = this._audioView(t, x.id, x); return { ...v, name: name(x.id), port: ext((x.props || {}).externalPortType), solo: !!(so && so.solo && so.index === x.id) }; }),
      master: { fader: (f.master.faderGain || 0) / 100, followFadeToBlack: !!f.master.followFadeToBlack },
      monitor: f.monitor ? { gain: f.monitor.gain / 100, mute: !!f.monitor.inputMasterMuted, solo: !!(so && so.solo), soloSource: so && so.solo ? so.index : null } : null, headphones: null,
      madi: { inputs: Object.values(f.inputs).filter((x) => (x.props || {}).externalPortType === M.EXT.MADI).length, outputs: Object.values(r.outputs).filter((o) => o.externalPortType === M.EXT.MADI).length },
      routing: Object.keys(r.outputs).length ? { outputs: Object.values(r.outputs).sort((a, b) => a.id - b.id).map((o) => ({ id: o.id, name: o.name, source: o.source, sourceName: srcName(o.source), madi: o.externalPortType === M.EXT.MADI })),
        sources: Object.values(r.sources).sort((a, b) => a.id - b.id).map((s) => ({ id: s.id, name: s.name, madi: s.externalPortType === M.EXT.MADI })) } : null };
  }
  routerView(inputs) {
    const s = this.state; const p = this._profile(); const nm = (id) => { const i = s.inputs[id]; return i ? i.longName : id === undefined ? '' : String(id); };
    const sh = (id) => { const i = s.inputs[id]; return i ? i.shortName : ''; };
    const out = [];
    const nAux = (s.topology && s.topology.auxilliaries) || 0;
    for (let i = 0; i < nAux; i++) out.push({ key: `aux:${i}`, group: 'aux', label: (p && p.aux[i] && p.aux[i].name) || `Aux ${i + 1}`, kind: (p && p.aux[i] && p.aux[i].kind) || 'sdi', accepts: 'aux', source: s.aux[i], sourceName: nm(s.aux[i]), sourceShort: sh(s.aux[i]) });
    // 0.11.0: M/E program / preview are buses, not router outputs (SWITCHER drives them); route('me:<m>:program', ...) still works
    const nMv = this._mvCount(); const nW = this._mvWindows();
    for (let m = 0; m < nMv; m++) for (let w = 0; w < nW; w++) {
      const win = ((s.mv[m] || {}).windows || {})[w]; if (!win && !this._mvRoutable(w)) continue;
      out.push({ key: `mv:${m}:${w}`, group: 'mv', mv: m, window: w, label: `${nMv > 1 ? `MV ${m + 1} ` : 'MV '}Window ${w + 1}`, accepts: 'mv', routable: this._mvRoutable(w), source: win ? win.source : null, sourceName: win ? nm(win.source) : '', sourceShort: win ? sh(win.source) : '' });
    }
    return out;
  }
  keyView(m) {
    const x = this.state.mes[m] || {}; const ns = x.nextSelection || 0;
    return Array.from({ length: x.keyCount || 0 }, (_, k) => { const y = (x.keyers || {})[k] || {};
      return { index: k, onAir: !!y.onAir, tie: !!(ns & (1 << (k + 1))), type: P.KEY_TYPES[y.type] || 'luma', flyEnabled: !!y.flyEnabled, canFlyKey: !!y.canFlyKey, fill: y.fill, cut: y.cut, mask: y.mask || null,
        luma: y.luma || null, chroma: y.chroma || null, pattern: y.pattern || null, dve: y.dve || null, fly: y.fly || null, keyframes: y.keyframes || {} }; });
  }

  meView(i, inputs = Object.values(this.state.inputs).sort((a, b) => a.id - b.id)) {
    const x = this.state.mes[i] || {};
    return { index: i, bus: inputs.filter((n) => n.meAvailability & (1 << i)).map((n) => ({ id: n.id, long: n.longName, short: n.shortName, type: n.internalPortType, pgm: x.program === n.id, pvw: x.preview === n.id })),
      program: x.program, preview: x.preview, style: P.STYLES[x.style] || String(x.style ?? ''), nextStyle: P.STYLES[x.nextStyle] || String(x.nextStyle ?? ''), nextSelection: x.nextSelection || 1,
      inTransition: !!x.inTransition, remainingFrames: x.remainingFrames || 0, handle: x.handle || 0, mixRate: x.mixRate, ftb: x.ftb || null,
      keyers: Array.from({ length: x.keyCount || 0 }, (_, k) => ({ index: k, onAir: !!(x.keyers && x.keyers[k] && x.keyers[k].onAir), tie: !!((x.nextSelection || 0) & (1 << (k + 1))) })) };
  }
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
      // 0.10.0
      profile: this.profileInfo(),
      sources: inputs.map((i) => ({ id: i.id, long: i.longName, short: i.shortName, port: i.internalPortType, ext: M.EXT_NAME[i.externalPortType] || '', kind: M.kindOf({ id: i.id, port: i.internalPortType }), adv: M.isAdvanced({ id: i.id, port: i.internalPortType }), sa: i.sourceAvailability, ma: i.meAvailability })),
      outputs: this.routerView(inputs),
      mixEffects: Array.from({ length: (s.topology && s.topology.mixEffects) || 1 }, (_, i) => { const x = s.mes[i] || {}; return { index: i, program: x.program, preview: x.preview, inTransition: !!x.inTransition, keyers: this.keyView(i) }; }),
      // 0.11.0: the full switcher state of every M/E (the SWITCHER tab's M/E selector / side-by-side view)
      mes: Array.from({ length: (s.topology && s.topology.mixEffects) || 1 }, (_, i) => this.meView(i, inputs)),
      dves: { count: (s.topology && s.topology.DVEs) || 0, inUse: Object.values(s.mes).reduce((n, x) => n + Object.values(x.keyers || {}).filter((k) => k.type === 3).length, 0) },
      multiviewers: Array.from({ length: this._mvCount() }, (_, i) => ({ index: i, layout: (s.mv[i] || {}).layout || 0, windows: Array.from({ length: this._mvWindows() }, (_, w) => ({ index: w, source: (((s.mv[i] || {}).windows || {})[w] || {}).source, routable: this._mvRoutable(w) })) })),
      superSources: Array.from({ length: (s.topology && s.topology.superSources) || 0 }, (_, i) => { const x = s.ss[i] || { boxes: {} }; const n = (s.ssConfig[i] || {}).boxCount || 4;
        return { index: i, boxes: Array.from({ length: n }, (_, b) => ({ index: b, ...(x.boxes[b] || {}) })), props: x.props || {}, border: x.border || {} }; }),
      audio: this.audioView(),
    };
  }
}

module.exports = { AtemDriver };
