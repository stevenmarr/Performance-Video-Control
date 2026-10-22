'use strict';
// AV Stumpfl Pixera: JSON-RPC 2.0 over TCP, framed the way Pixera's API and bitfocus/companion-module-avstumpfl-pixera
// (src/Pixera.js) speak it. An 8-byte header — the ASCII magic "pxr1" then the body length as a little-endian
// uint32 — then the UTF-8 JSON body {"jsonrpc":"2.0","id":N,"method":"...","params":{...}}. The reply uses the
// same frame. (The docs' trailing "0xPX" marker is the JSON/TCP(dl) test tool, not this path.) The port is the
// one chosen in Pixera; Companion's default, and this driver's, is 1400. Pixera is the TCP server.
const net = require('net');

const MAGIC = Buffer.from('pxr1');
const CONNECT_TIMEOUT = 4000;
const CALL_TIMEOUT = 4000;
const MODES = { play: 1, pause: 2, stop: 3 };
const CUE_METHODS = {
  next: 'Pixera.Timelines.Timeline.moveToNextCue',
  prev: 'Pixera.Timelines.Timeline.moveToPreviousCue',
  nextIgnore: 'Pixera.Timelines.Timeline.moveToNextCueIgnoreProperties',
  prevIgnore: 'Pixera.Timelines.Timeline.moveToPreviousCueIgnoreProperties',
};

function frame(body) {
  const b = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const h = Buffer.alloc(8);
  MAGIC.copy(h, 0); h.writeUInt32LE(b.length, 4);
  return Buffer.concat([h, b]);
}
// One or more complete frames out of a byte stream. Leftover bytes stay in `state.buf`.
function takeFrames(state, chunk) {
  state.buf = state.buf && state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
  const out = [];
  for (;;) {
    if (state.buf.length < 8) break;
    const at = state.buf.indexOf(MAGIC);
    if (at < 0) { state.buf = state.buf.subarray(Math.max(0, state.buf.length - 3)); break; }
    if (at > 0) state.buf = state.buf.subarray(at);
    if (state.buf.length < 8) break;
    const len = state.buf.readUInt32LE(4);
    if (len > 8e6) { state.buf = state.buf.subarray(4); continue; } // a corrupt length: resync on the next magic
    if (state.buf.length < 8 + len) break;
    out.push(state.buf.subarray(8, 8 + len).toString('utf8'));
    state.buf = state.buf.subarray(8 + len);
  }
  return out;
}

class PixeraDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'pixera';
    this.log = log; this.onChange = onChange;
    this.capabilities = { pixeraTransport: true, pixeraCues: true, pixeraTimelines: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.sock = null; this.connectMs = CONNECT_TIMEOUT; this.callMs = CALL_TIMEOUT;
    this.configure(conn);
  }
  configure(conn) { this.close(); this.conn = { host: '', port: 1400, ...conn }; this._reset(); }
  status() { return { ...this.st, info: this.st.info ? { ...this.st.info } : null }; }
  _reset() {
    this.nextId = 1; this.pending = new Map(); this.rx = { buf: null };
    this.timelines = []; this.modeOf = {}; this.cues = {}; this.selected = null;
  }
  close() {
    if (this.sock) { this.sock.removeAllListeners(); try { this.sock.destroy(); } catch { /* already gone */ } }
    this.sock = null; this.st.connected = false;
    for (const p of this.pending ? this.pending.values() : []) { clearTimeout(p.t); p.reject(new Error('Pixera connection closed')); }
    if (this.pending) this.pending.clear();
  }
  _changed() { if (this._chg) return; this._chg = setTimeout(() => { this._chg = null; this.onChange(); }, 20); if (this._chg.unref) this._chg.unref(); }
  _fail(msg) { this.st.connected = false; this.st.error = msg; this.close(); this._changed(); }

  connect() {
    if (!this.conn.host) return Promise.reject(new Error('Pixera: no IP address set (SYSTEMS tab)'));
    this.close(); this._reset();
    const sock = net.connect({ host: this.conn.host, port: Number(this.conn.port) || 1400 });
    this.sock = sock;
    return new Promise((resolve, reject) => {
      let done = false;
      const fin = (e, info) => {
        if (done) return; done = true; clearTimeout(t);
        if (e) { this.st.error = e.message; this.close(); reject(e); } else resolve(info);
      };
      const t = setTimeout(() => fin(new Error(`Pixera ${this.conn.host}:${this.conn.port}: no answer within ${this.connectMs / 1000} s`)), this.connectMs);
      sock.on('error', (e) => fin(new Error(`Pixera: ${e.message}`)));
      sock.on('close', () => { if (!done) fin(new Error('Pixera closed the connection')); else if (this.st.connected) this._fail('Pixera closed the connection'); });
      sock.on('data', (c) => this._data(c));
      // The handshake is one call. Timelines are read afterwards (load), so a connect does not depend on them.
      sock.on('connect', () => {
        this.call('Pixera.Utility.getApiRevision').then((rev) => {
          this.st.connected = true; this.st.error = null; this.st.lastSeen = Date.now();
          this.st.info = { model: 'Pixera', version: rev == null ? '' : String(rev) };
          this._changed(); fin(null, this.st.info);
        }).catch((e) => fin(e));
      });
    });
  }
  async heartbeat() {
    if (!this.st.connected) throw new Error(this.st.error || 'not connected');
    const rev = await this.call('Pixera.Utility.getApiRevision');
    this.st.lastSeen = Date.now(); this.st.info = { ...(this.st.info || {}), model: 'Pixera', version: rev == null ? '' : String(rev) };
  }
  // A JSON-RPC call. Resolves with the reply's `result` (context.handle, when Pixera sends one, is kept on it).
  call(method, params) {
    if (!this.sock || this.sock.destroyed) return Promise.reject(Object.assign(new Error('Pixera not connected'), { status: 409 }));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method }; if (params) msg.params = params;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`Pixera did not answer ${method}`), { status: 504 })); }, this.callMs);
      if (t.unref) t.unref();
      this.pending.set(id, { resolve, reject, t, method });
      try { this.sock.write(frame(msg)); } catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
    });
  }
  _data(chunk) {
    let frames;
    try { frames = takeFrames(this.rx, chunk); } catch { return; }
    for (const raw of frames) {
      let msg; try { msg = JSON.parse(raw); } catch { this.log('warn', 'Pixera: reply was not JSON'); continue; }
      if (msg.id === undefined) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id); clearTimeout(p.t); this.st.lastSeen = Date.now();
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || `Pixera refused ${p.method}`), { status: 400 }));
      else p.resolve(msg.result);
    }
  }
  _ready(info) {
    this.st.connected = true; this.st.error = null; this.st.lastSeen = Date.now();
    this.st.info = { model: 'Pixera', version: info && info.version != null ? String(info.version) : (this.st.info && this.st.info.version) || '' };
    this._changed();
  }

  // ---------- the useful surface: timelines, transport, cues ----------
  async load() {
    const version = await this.call('Pixera.Utility.getApiRevision').catch(() => null);
    await this.call('Pixera.Utility.setShowContextInReplies', { enable: true }).catch(() => {});
    const handles = await this.call('Pixera.Timelines.getTimelines');
    const list = Array.isArray(handles) ? handles : [];
    const timelines = [];
    for (const handle of list) {
      let attr = {};
      try { attr = await this.call('Pixera.Timelines.Timeline.getAttributes', { handle }) || {}; } catch { /* a timeline with no attributes still lists */ }
      const name = attr.name || attr.Name || `Timeline ${timelines.length + 1}`;
      timelines.push({ handle: Number(handle), name: String(name), fps: Number(attr.fps || attr.FPS || 0) || null });
    }
    this.timelines = timelines;
    if (!timelines.some((t) => t.handle === this.selected)) this.selected = timelines.length ? timelines[0].handle : null;
    this._ready({ version });
    this._changed();
    return this.view();
  }
  timeline(handle) {
    const h = Number(handle === undefined || handle === null || handle === '' ? this.selected : handle);
    const t = this.timelines.find((x) => x.handle === h);
    if (!t) throw Object.assign(new Error(this.timelines.length ? `Pixera has no timeline ${handle}` : 'Pixera reports no timelines'), { status: 400 });
    return t;
  }
  async transport(mode, handle) {
    const t = this.timeline(handle); const m = String(mode || '').toLowerCase();
    if (m === 'toggle') await this.call('Pixera.Timelines.Timeline.toggleTransport', { handle: t.handle });
    else if (MODES[m]) await this.call('Pixera.Timelines.Timeline.setTransportMode', { handle: t.handle, mode: MODES[m] });
    else throw Object.assign(new Error('Transport is play, pause, stop or toggle'), { status: 400 });
    this.modeOf[t.handle] = m; this.selected = t.handle; this._changed();
    return { handle: t.handle, mode: m };
  }
  async cue(which, handle, { ignore = false } = {}) {
    const t = this.timeline(handle); const dir = which === 'prev' || which === 'previous' ? 'prev' : which === 'next' ? 'next' : '';
    if (!dir) throw Object.assign(new Error('Cue step is next or previous'), { status: 400 });
    const method = CUE_METHODS[dir + (ignore ? 'Ignore' : '')];
    const cue = await this.call(method, { handle: t.handle });
    const name = cue && typeof cue === 'object' ? (cue.name || cue.Name || null) : (cue == null ? null : String(cue));
    this.cues[t.handle] = name; this.selected = t.handle; this._changed();
    return { handle: t.handle, cue: name };
  }
  // Apply a cue by name (Pixera.Compound.applyCueOnTimeline) or, with {index:true}, by zero-based index.
  async applyCue({ timeline, cue, index = false, blend } = {}) {
    const blendDuration = blend === undefined || blend === null || blend === '' ? undefined : Number(blend);
    if (blendDuration !== undefined && !Number.isFinite(blendDuration)) throw Object.assign(new Error('Blend duration must be a number of seconds'), { status: 400 });
    let result;
    if (index) {
      const cueIndex = Number(cue); const timelineIndex = Number(timeline);
      if (!Number.isInteger(cueIndex) || cueIndex < 0 || !Number.isInteger(timelineIndex) || timelineIndex < 0) throw Object.assign(new Error('Cue and timeline indexes start at 0'), { status: 400 });
      const params = { cueIndex, timelineIndex }; if (blendDuration !== undefined) params.blendDuration = blendDuration;
      result = await this.call('Pixera.Compound.applyCueAtIndexOnTimelineAtIndex', params);
    } else {
      const timelineName = String(timeline || '').trim(); const cueName = String(cue || '').trim();
      if (!timelineName || !cueName) throw Object.assign(new Error('Applying a cue needs a timeline name and a cue name'), { status: 400 });
      const params = { timelineName, cueName }; if (blendDuration !== undefined) params.blendDuration = blendDuration;
      result = await this.call('Pixera.Compound.applyCueOnTimeline', params);
      const known = this.timelines.find((t) => t.name === timelineName);
      if (known) { this.cues[known.handle] = cueName; this.selected = known.handle; }
    }
    this._changed();
    return { ok: result !== false, cue: index ? Number(cue) : String(cue) };
  }
  async refresh() { if (!this.st.connected) throw Object.assign(new Error('Pixera not connected'), { status: 409 }); return this.load(); }
  select(handle) { const t = this.timeline(handle); this.selected = t.handle; this._changed(); return t.handle; }

  view() {
    return {
      timelines: this.timelines.map((t) => ({ ...t, transport: this.modeOf[t.handle] || null, cue: this.cues[t.handle] || null, selected: t.handle === this.selected })),
      selected: this.selected, modes: ['play', 'pause', 'stop', 'toggle'],
    };
  }
}

module.exports = { PixeraDriver, frame, takeFrames, MODES, CUE_METHODS };
