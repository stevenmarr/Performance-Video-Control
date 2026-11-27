'use strict';
// Playout (stevenmarr/Playout, menu name Vantage). The control API documented in
// docs/API.md on cursor/media-server-m0-m3-2d3f is three loopback listeners that
// share one router:
//   HTTP  :8080  GET /health, GET /status, POST /transport/play|pause|stop|go, POST /rpc
//   OSC   :8000  /playout/transport/*, /playout/cue/jump
//   HyperDeck :9993  play, stop, goto, transport info
// This driver uses HTTP, the only listener that answers with status. OSC and the
// HyperDeck port are the same verbs and do not push feedback (the server says the
// feedback set is not open). Connect only GETs. It never posts play, pause, stop,
// cue, next, or go.
//
// GET /status today is {ok, transport, frame, buffered}. Clip, playlist, elapsed,
// remaining, standby, and cued are copied when the server sends them and left
// empty when it does not. A bare frame index is shown as elapsed, because that
// is the position the current status document carries. Remaining is never invented.

const http = require('http');

const DEFAULT_PORT = 8080;

const COMMANDS = {
  play: { method: 'POST', path: '/transport/play' },
  pause: { method: 'POST', path: '/transport/pause' },
  stop: { method: 'POST', path: '/transport/stop' },
  cue: { method: 'POST', path: '/rpc', rpc: 'playout.cues.jump' },
  next: { method: 'POST', path: '/transport/next' },
};

const VARIABLES = [
  { id: 'connected', label: 'Connected' },
  { id: 'transport', label: 'Transport' },
  { id: 'clip', label: 'Current clip' },
  { id: 'playlist', label: 'Playlist' },
  { id: 'elapsed', label: 'Elapsed' },
  { id: 'remaining', label: 'Remaining time' },
  { id: 'standby', label: 'Standby' },
  { id: 'cued', label: 'Cued' },
  { id: 'frame', label: 'Frame' },
  { id: 'buffered', label: 'Buffered frames' },
];

const FEEDBACKS = [
  { id: 'connected', label: 'Link is up', variable: 'connected', op: 'eq', value: 'true' },
  { id: 'playing', label: 'Playing', variable: 'transport', op: 'eq', value: 'playing' },
  { id: 'paused', label: 'Paused', variable: 'transport', op: 'eq', value: 'paused' },
  { id: 'stopped', label: 'Stopped', variable: 'transport', op: 'eq', value: 'stopped' },
  { id: 'cued', label: 'Standby is cued', variable: 'cued', op: 'truthy', value: 'true' },
  { id: 'remaining', label: 'Remaining time is known', variable: 'remaining', op: 'truthy', value: 'true' },
];

function emptyState() {
  return {
    transport: 'stopped',
    frame: null,
    buffered: null,
    elapsed: null,
    remaining: null,
    cue: null,
    clip: null,
    clips: [],
    playlist: [],
    standby: null,
    cued: null,
  };
}

function parseJson(text) {
  if (text == null || text === '') return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function timeOf(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      const inner = v.timecode || v.time || v.text || v.display;
      if (inner != null && inner !== '') return String(inner);
      if (v.frames != null && v.frames !== '') return String(v.frames);
    }
  }
  return null;
}

function clipName(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const name = v.name || v.title || v.clip || v.tag;
    if (name != null && name !== '') return String(name);
    if (v.id != null && v.id !== '') return String(v.id);
  }
  return null;
}

function asClips(value) {
  const arr = Array.isArray(value) ? value
    : (value && typeof value === 'object' && (Array.isArray(value.clips) || Array.isArray(value.playlist) || Array.isArray(value.items)))
      ? (value.clips || value.playlist || value.items)
      : null;
  if (!arr) return [];
  const out = [];
  arr.forEach((item, i) => {
    if (item == null || item === '') return;
    if (typeof item === 'string' || typeof item === 'number') {
      out.push({ id: String(i + 1), name: String(item), number: String(i + 1) });
      return;
    }
    if (typeof item !== 'object') return;
    const name = clipName(item) || '';
    const id = item.id != null && item.id !== '' ? String(item.id) : String(i + 1);
    const number = item.number != null && item.number !== '' ? String(item.number)
      : (item.index != null && item.index !== '' ? String(item.index) : String(i + 1));
    if (!name && !id) return;
    out.push({ id, name: name || id, number });
  });
  return out;
}

function mergeSrc(data) {
  const src = { ...data };
  if (data.result && typeof data.result === 'object') Object.assign(src, data.result);
  if (data.status && typeof data.status === 'object') Object.assign(src, data.status);
  return src;
}

// Copies whatever the body actually contains. Missing keys stay as they were.
function applyStatus(state, body) {
  const data = typeof body === 'string' || body == null ? parseJson(body) : body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return state;
  const src = mergeSrc(data);
  if (src.transport != null && typeof src.transport !== 'object') state.transport = String(src.transport);
  else if (typeof src.status === 'string') state.transport = src.status;
  if (src.frame != null && src.frame !== '' && typeof src.frame !== 'object' && Number.isFinite(Number(src.frame))) state.frame = Number(src.frame);
  if (src.buffered != null && src.buffered !== '' && typeof src.buffered !== 'object' && Number.isFinite(Number(src.buffered))) state.buffered = Number(src.buffered);
  const elapsed = timeOf(src.elapsed, src.elapsedTime, src.timecode, src.displayTimecode);
  if (elapsed != null) state.elapsed = elapsed;
  const remaining = timeOf(src.remaining, src.remainingTime, src.timeRemaining, src.remain);
  if (remaining != null) state.remaining = remaining;
  const clip = clipName(src.clip != null ? src.clip : (src.current != null ? src.current : src.currentClip));
  if (clip != null) state.clip = clip;
  if (src.cue != null && typeof src.cue !== 'object') state.cue = String(src.cue);
  else {
    const named = clipName(src.cue);
    if (named) state.cue = named;
  }
  if (src.clips != null || src.clipList != null) state.clips = asClips(src.clips != null ? src.clips : src.clipList);
  if (src.playlist != null || src.playlists != null) state.playlist = asClips(src.playlist != null ? src.playlist : src.playlists);
  const standby = clipName(src.standby != null ? src.standby : src.standbyClip);
  if (standby != null) state.standby = standby;
  const cued = clipName(src.cued != null ? src.cued : src.armed);
  if (cued != null) state.cued = cued;
  if (state.elapsed == null && state.frame != null) state.elapsed = String(state.frame);
  if (!state.playlist.length && state.clips.length) state.playlist = state.clips.map((c) => ({ ...c }));
  return state;
}

function varMap(driver) {
  const s = driver.state;
  const names = (s.playlist.length ? s.playlist : s.clips).map((c) => c.name).filter(Boolean);
  return {
    connected: driver.st.connected ? 'true' : 'false',
    transport: s.transport || '',
    clip: s.clip || '',
    playlist: names.join(', '),
    elapsed: s.elapsed || '',
    remaining: s.remaining || '',
    standby: s.standby || '',
    cued: s.cued || '',
    frame: s.frame == null ? '' : String(s.frame),
    buffered: s.buffered == null ? '' : String(s.buffered),
  };
}

function feedbackOn(spec, vars) {
  const value = vars[spec.variable] == null ? '' : String(vars[spec.variable]);
  if (spec.id === 'playing') return value === 'playing' || value === 'play';
  if (spec.op === 'truthy') return value !== '' && value !== 'false' && value !== '0';
  return value === String(spec.value);
}

function request({ host, port, method, path, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { Connection: 'close' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({
      host, port, method, path, headers, timeout: timeoutMs, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`Playout ${host}: no answer within ${Math.round(timeoutMs / 1000)} s`), { status: 504 }));
    });
    req.on('error', (e) => reject(Object.assign(new Error(e.status ? e.message : `Playout: ${e.message}`), { status: e.status || 502 })));
    if (payload) req.write(payload);
    req.end();
  });
}

class PlayoutDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'playout';
    this.log = log;
    this.onChange = onChange;
    this.capabilities = { playout: true, transport: true, cues: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.state = emptyState();
    this.timeoutMs = 4000;
    this._rpc = 0;
    this.configure(conn);
  }

  configure(conn) {
    this.close();
    this.conn = { host: '', port: DEFAULT_PORT, ...conn };
  }

  status() { return { ...this.st, info: this.st.info ? { ...this.st.info } : null }; }

  close() {
    this.st.connected = false;
  }

  _changed() {
    if (this._chg) return;
    this._chg = setTimeout(() => { this._chg = null; this.onChange(); }, 20);
    if (this._chg.unref) this._chg.unref();
  }

  variables() {
    const vars = varMap(this);
    return VARIABLES.map((v) => ({ ...v, value: vars[v.id] }));
  }

  feedbacks() {
    const vars = varMap(this);
    return FEEDBACKS.map((f) => ({ ...f, active: feedbackOn(f, vars) }));
  }

  view() {
    const s = this.state;
    return {
      transport: s.transport,
      frame: s.frame,
      buffered: s.buffered,
      elapsed: s.elapsed,
      remaining: s.remaining,
      cue: s.cue,
      clip: s.clip,
      clips: s.clips.map((c) => ({ ...c })),
      playlist: s.playlist.map((c) => ({ ...c })),
      standby: s.standby,
      cued: s.cued,
      variables: this.variables(),
      feedbacks: this.feedbacks(),
      commands: Object.keys(COMMANDS),
    };
  }

  async connect() {
    if (!this.conn.host) return Promise.reject(new Error('Playout: no IP address set (SYSTEMS tab)'));
    this.close();
    const health = await this._request('GET', '/health');
    if (health.status >= 400) {
      this.st.error = `health ${health.status}`;
      throw Object.assign(new Error(`Playout ${this.conn.host}: health returned ${health.status}`), { status: 502 });
    }
    const info = parseJson(health.body) || {};
    this.st.connected = true;
    this.st.error = null;
    this.st.lastSeen = Date.now();
    this.st.info = { model: info.model || 'Playout', version: info.version ? String(info.version) : '' };
    try {
      await this.read();
    } catch (e) {
      this.st.error = e.message;
      this.log('warn', `Playout: connected, status unread (${e.message})`);
    }
    this._changed();
    return { ...this.st.info };
  }

  async heartbeat() {
    if (!this.st.connected) throw new Error(this.st.error || 'not connected');
    return this.read();
  }

  async read() {
    if (!this.st.connected) throw Object.assign(new Error('Playout not connected'), { status: 409 });
    const status = await this._request('GET', '/status');
    if (status.status >= 400) throw Object.assign(new Error(`Playout status returned ${status.status}`), { status: status.status });
    const next = emptyState();
    applyStatus(next, status.body);
    const clips = await this._optional('/clips');
    if (clips) applyStatus(next, clips);
    const playlist = await this._optional('/playlist');
    if (playlist) applyStatus(next, playlist);
    const standby = await this._optional('/standby');
    if (standby) applyStatus(next, standby);
    if (!next.playlist.length && next.clips.length) next.playlist = next.clips.map((c) => ({ ...c }));
    this.state = next;
    this.st.lastSeen = Date.now();
    this.st.error = null;
    this._changed();
    return this.view();
  }

  async _optional(path) {
    try {
      const res = await this._request('GET', path);
      if (res.status === 404 || res.status === 405 || res.status >= 400) return null;
      return res.body;
    } catch {
      return null;
    }
  }

  async send(name, body = {}) {
    if (!COMMANDS[name]) throw Object.assign(new Error(`Unknown Playout command "${name}"`), { status: 404 });
    if (!this.st.connected) throw Object.assign(new Error('Playout not connected'), { status: 409 });
    if (name === 'next') return this._next(body);
    if (name === 'cue') return this._cue(body);
    const res = await this._request('POST', COMMANDS[name].path, {});
    this._accept(res);
    await this.read().catch(() => {});
    return { ok: true, transport: this.state.transport, clip: this.state.clip, remaining: this.state.remaining, cued: this.state.cued };
  }

  async _cue(body) {
    const value = body.value != null ? body.value
      : body.cue != null ? body.cue
        : body.tag != null ? body.tag
          : body.number != null ? body.number
            : body.name;
    const text = String(value == null ? '' : value).trim();
    if (!text) throw Object.assign(new Error('A Playout cue needs a name or a number'), { status: 400 });
    const params = /^\d+(\.\d+)?$/.test(text) ? { number: text } : { tag: text };
    const res = await this._request('POST', '/rpc', {
      jsonrpc: '2.0',
      id: ++this._rpc,
      method: 'playout.cues.jump',
      params,
    });
    this._accept(res);
    await this.read().catch(() => {});
    return { ok: true, transport: this.state.transport, clip: this.state.clip, cue: this.state.cue, cued: this.state.cued, standby: this.state.standby };
  }

  async _next(body) {
    const res = await this._request('POST', '/transport/next', body && body.value != null ? { value: body.value } : {});
    if (res.status === 404 || res.status === 405) {
      const target = this._nextTarget();
      if (!target) throw Object.assign(new Error('Playout has no next clip'), { status: 409 });
      return this._cue({ value: target.number || target.name });
    }
    this._accept(res);
    await this.read().catch(() => {});
    return { ok: true, transport: this.state.transport, clip: this.state.clip, cued: this.state.cued, standby: this.state.standby };
  }

  _nextTarget() {
    const list = this.state.playlist.length ? this.state.playlist : this.state.clips;
    if (!list.length) return null;
    const cue = this.state.cue == null ? '' : String(this.state.cue);
    const idx = list.findIndex((c) => (this.state.clip && c.name === this.state.clip) || (cue && (c.number === cue || c.id === cue || c.name === cue)));
    if (idx < 0) return list[0];
    if (idx + 1 >= list.length) return null;
    return list[idx + 1];
  }

  _accept(res) {
    const data = parseJson(res.body);
    if (data && data.error) {
      const message = data.error.message || 'Playout refused the command';
      throw Object.assign(new Error(message), { status: data.error.code === -32001 ? 409 : 400 });
    }
    if (res.status === 409 || res.status >= 400) {
      throw Object.assign(new Error((data && (data.message || data.error)) || `Playout returned ${res.status}`), { status: res.status >= 500 ? 502 : 409 });
    }
  }

  _request(method, path, body) {
    return request({
      host: this.conn.host,
      port: Number(this.conn.port) || DEFAULT_PORT,
      method,
      path,
      body: body === undefined ? null : body,
      timeoutMs: this.timeoutMs,
    });
  }
}

function register(api) {
  if (!api || api.SystemManager.__playout) return api;
  const { SystemManager, SYSTEMS, NET_SYS, CONN_DEFAULTS, MEDIA_SYS } = api;
  if (!SYSTEMS || !SystemManager) return api;
  SYSTEMS.playout = { label: 'Playout', short: 'Playout', kind: 'playout', group: 'Media servers' };
  if (Array.isArray(NET_SYS) && !NET_SYS.includes('playout')) NET_SYS.push('playout');
  if (Array.isArray(MEDIA_SYS) && !MEDIA_SYS.includes('playout')) MEDIA_SYS.push('playout');
  if (CONN_DEFAULTS) CONN_DEFAULTS.playout = { host: '', port: DEFAULT_PORT };

  const ensure = (sm, id) => {
    const slot = sm.pool && sm.pool.get(String(id));
    if (!slot || slot.type !== 'playout' || slot.driver) return slot && slot.driver;
    const driver = new PlayoutDriver(sm.conn(id), (l, m) => sm.log(l, m), () => sm.changed());
    slot.driver = driver;
    if (slot.primary) sm.drivers.playout = driver;
    return driver;
  };

  const origMake = SystemManager.prototype._makeDriver;
  SystemManager.prototype._makeDriver = function (type, conn) {
    if (type === 'playout') return new PlayoutDriver(conn, (l, m) => this.log(l, m), () => this.changed());
    return origMake.call(this, type, conn);
  };
  const origDriver = SystemManager.prototype.driver;
  SystemManager.prototype.driver = function (id) {
    ensure(this, id);
    return origDriver.call(this, id);
  };
  const origStart = SystemManager.prototype.start;
  SystemManager.prototype.start = function () {
    if (this.pool && this.pool.has('playout')) ensure(this, 'playout');
    return origStart.call(this);
  };
  const origConnect = SystemManager.prototype.connect;
  SystemManager.prototype.connect = async function (sys, opts) {
    ensure(this, sys);
    return origConnect.call(this, sys, opts);
  };
  const origView = SystemManager.prototype.view;
  SystemManager.prototype.view = function (sys) {
    if (this.typeOf(sys) === 'playout') {
      const d = this.driver(sys);
      return { ...this.base(sys), ...(d ? d.view() : {}) };
    }
    return origView.call(this, sys);
  };
  const origCounts = SystemManager.prototype.counts;
  SystemManager.prototype.counts = function (k) {
    if ((this.typeOf(k) || k) === 'playout') {
      const d = this.driver(k);
      const v = d && d.view ? d.view() : {};
      return {
        transport: v.transport || null,
        clip: v.clip || null,
        elapsed: v.elapsed || null,
        remaining: v.remaining || null,
        standby: v.standby || null,
        cued: v.cued || null,
        playlist: (v.playlist || []).length,
      };
    }
    return origCounts.call(this, k);
  };
  const origRefresh = SystemManager.prototype.refresh;
  SystemManager.prototype.refresh = async function (sys) {
    if (this.typeOf(sys) === 'playout') {
      const gear = this.driver(sys);
      if (gear && gear.status().connected) await gear.read().catch(() => {});
      this.changed();
      return gear ? gear.view() : {};
    }
    return origRefresh.call(this, sys);
  };
  const origFixture = SystemManager.prototype.startFixture;
  SystemManager.prototype.startFixture = async function (sys, opts) {
    if (sys !== 'playout') return origFixture.call(this, sys, opts);
    const { MockPlayout } = require('../mocks/playout');
    const m = new MockPlayout();
    try {
      const port = await m.start(0, '127.0.0.1');
      return { conn: { host: '127.0.0.1', port }, stop: () => m.stop(), model: 'Playout' };
    } catch (e) {
      try { await m.stop(); } catch { /* already stopped */ }
      throw e;
    }
  };
  SystemManager.prototype.playout = async function (name, b = {}) {
    const id = (b && b.instance) || 'playout';
    const d = this.driver(id);
    if (this.typeOf(id) !== 'playout') {
      const error = new Error('Not a Playout');
      error.status = 404;
      throw error;
    }
    if (!d.status().connected) {
      const error = new Error('Playout not connected');
      error.status = 409;
      throw error;
    }
    const r = await this._act('playout', id, name, () => d.send(name, b || {}));
    if (this.os && (name === 'play' || name === 'pause' || name === 'stop')) this.os.noteTransport(id, 0, name);
    this.log('info', `Playout: ${name}`);
    this.changed();
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  };
  SystemManager.__playout = true;
  return api;
}

module.exports = {
  PlayoutDriver,
  COMMANDS,
  VARIABLES,
  FEEDBACKS,
  DEFAULT_PORT,
  applyStatus,
  emptyState,
  register,
};
