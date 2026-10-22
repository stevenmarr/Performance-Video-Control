'use strict';
// Panasonic PTZ cameras (AW-UE / AW-HE / AW-UN / AW-HR series) over the cameras' HTTP CGI interface.
// Sources (nothing here is invented; each command carries its source in lib/drivers/ptz-commands.js):
//   * the Bitfocus Companion module bitfocus/companion-module-panasonic-ptz v2.6.1 (commit 18caabf, MIT):
//     transport (src/actions.js sendPTZ / sendCam / sendWeb), status page (src/index.js getCameraInformation),
//     every action, and the model -> series -> capability table (src/models.js, src/choices.js, generated into
//     lib/drivers/panasonic-data.js by tools/gen-panasonic-data.mjs)
//   * Panasonic "AW-UE150 / AW-HE145 Interface Specifications" v2.94 for the commands the module lacks (paint,
//     OSD menu, AWB / ABB, shutter mode / synchro, detail, gamma, knee, matrix, chroma), the error replies
//     (eR1 / ER1 = unsupported, ER2 = busy / standby, ER3 = out of range), the 40 ms minimum gap between pan-tilt
//     head commands, the position fields in camdata.html (aPC / axz / axf / axi) and, from its "Supplement for
//     Web Control", the preset thumbnail CGI (/cgi-bin/get_preset_thumbnail?preset_number=N).
// Paths: GET /cgi-bin/aw_ptz?cmd=%23<CMD>&res=1, GET /cgi-bin/aw_cam?cmd=<CMD>&res=1, GET /cgi-bin/<web>,
//        GET /live/camdata.html ("KEY:VALUE" lines).
//
// Motion safety: moves are hold-to-run. Every camera has one send queue (one request in flight, >= 40 ms after a
// pan-tilt head command, per the spec); a newer pan/tilt, zoom or focus speed replaces one still waiting (a stop
// always replaces a pending move). A move is sent only when its speed code changes (the spec: do not send setting
// commands at regular intervals); the control surface's keep-alives only re-arm the server-side dead-man, which
// stops the camera by itself when no keep-alive arrives within `deadmanMs`. Stop is sent on release, cancel, blur,
// page hide and dead-man expiry.
const http = require('http');
const P = require('./ptz-commands');

// 0.7.0 exports kept for callers of the old API (the HR140 gain table, the HE130 shutter table, WB 0/1/2)
const GAINS = [['80', 'Auto']].concat(Array.from({ length: 43 }, (_, i) => [(8 + i).toString(16).toUpperCase().padStart(2, '0'), `${i} dB`]));
const SHUTTERS = [['0', 'Off'], ['2', '1/60'], ['3', '1/100'], ['4', '1/120'], ['5', '1/250'], ['6', '1/500'], ['7', '1/1000'], ['8', '1/2000'], ['9', '1/4000'], ['A', '1/10000'], ['B', 'Synchro scan'], ['C', 'ELC']];
const WB = [['0', 'ATW'], ['1', 'AWC A'], ['2', 'AWC B']];
const two = (n) => String(Math.max(0, Math.min(99, Math.round(n)))).padStart(2, '0');
const speedCode = (s) => two(50 + Math.max(-49, Math.min(49, Math.round(Number(s) || 0))));
const PRESET_COUNT = 100;
const STOP = { pt: 'PTS5050', z: 'Z50', f: 'F50' };
const ERR = { 1: 'unsupported command', 2: 'camera busy or in standby', 3: 'value out of range' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet({ host, port, path, timeout = 2500, binary = false, max = 1e6 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: 'GET', path, timeout, headers: { Connection: 'close' } }, (res) => {
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > max) req.destroy(new Error('response too large')); else parts.push(c); });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        const body = Buffer.concat(parts);
        resolve(binary ? { type: String(res.headers['content-type'] || ''), body } : body.toString('latin1'));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeout} ms`)));
    req.on('error', reject);
    req.end();
  });
}

// camdata.html -> the 0.7.0 fields (storeData() in the module) + `raw`, every field by key:
//   "OSJ:03:0x1" -> raw['OSJ:03'] = '1'    "OGU:0x08" -> raw.OGU = '08'    "aPC80008000" -> raw.aPC = '80008000'
function parseCamdata(text) {
  const d = { raw: {} }; const raw = d.raw;
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    const str = s.split(':');
    const k = str[0];
    let m;
    if ((m = /^([A-Z]{3}):([0-9A-F]{2}):(.+)$/.exec(s))) raw[`${m[1]}:${m[2]}`] = m[3].replace(/^0x/i, '');
    else if ((m = /^([A-Z]{2,6}):(.*)$/.exec(s))) raw[m[1]] = m[2].replace(/^0x/i, '');
    else if ((m = /^(aPC|axz|axf|axi|uPVS|iNS|dA|d1|d3|d6|p|s)([0-9A-Fa-f]+)$/.exec(s))) raw[m[1]] = m[2];
    if (k.startsWith('rER')) d.error = k === 'rER00' ? null : k;
    if (k.startsWith('qSV3')) d.version = k.slice(4);
    switch (k) {
      case 'OID': d.model = str[1]; break;
      case 'TITLE': d.title = str.slice(1).join(':'); break;
      case 'p1': d.power = 'on'; break;
      case 'p0': d.power = 'standby'; break;
      case 'p3': d.power = 'turning on'; break;
      case 'dA0': d.tally = false; break;
      case 'dA1': d.tally = true; break;
      case 'TLR': d.tally = str[1] === '1'; break;
      case 'TLG': d.tallyGreen = str[1] === '1'; break;
      case 'OAF': d.autoFocus = str[1] === '1'; break;
      case 'd30': d.autoIris = false; break;
      case 'd31': d.autoIris = true; break;
      case 'OGU': d.gain = String(str[1] || '').replace('0x', '').toUpperCase(); break;
      default: break;
    }
  }
  return d;
}
// Positions from camdata (spec: aPC pan/tilt 0000h..FFFFh, 8000h centre; axz / axf / axi 555h..FFFh).
// Degrees use the spec's pan scale (2D09h = -175 deg, D2F5h = +175 deg, 121.4 counts per degree) for both axes,
// 8000h = 0. The spec labels the tilt limits 5555h (-30 deg) and 8E38h (+90 deg), which does not fit any one scale
// around 8000h (at 121.4 counts per degree they are 90 and 30 degrees away): readouts only, never used to drive
// the camera; see ptz/API-NOTES.md.
const PER_DEG = (0xD2F5 - 0x2D09) / 350;
function positions(raw) {
  const pct = (k) => (raw[k] ? Math.round(((parseInt(raw[k], 16) - 0x555) / (0xFFF - 0x555)) * 1000) / 10 : null);
  const out = { zoom: pct('axz'), focus: pct('axf'), iris: pct('axi'), pan: null, tilt: null, panRaw: null, tiltRaw: null };
  if (raw.aPC && raw.aPC.length === 8) {
    const p = parseInt(raw.aPC.slice(0, 4), 16); const t = parseInt(raw.aPC.slice(4), 16);
    out.panRaw = raw.aPC.slice(0, 4); out.tiltRaw = raw.aPC.slice(4);
    out.pan = Math.round(((p - 0x8000) / PER_DEG) * 10) / 10; out.tilt = Math.round(((t - 0x8000) / PER_DEG) * 10) / 10;
  }
  return out;
}

class PTZDriver {
  constructor(conn = {}, log = () => {}) {
    this.system = 'ptz';
    this.log = log;
    this.capabilities = { ptzCameras: true, ptzControl: true, ptzPresets: true, cameras: true, ptzCatalog: true, ptzProportional: true, ptzThumbnails: true };
    this.cams = new Map(); // id -> { conf, st, axes, sent, q, deadman }
    this.deadmanMs = 1500;
    this.gapMs = 40;
    this.configure(conn);
  }
  configure(conn) {
    this.conn = { cameras: [], timeout: 2500, ...conn };
    const keep = new Set();
    for (const c of this.conn.cameras || []) {
      keep.add(c.id);
      const cur = this.cams.get(c.id);
      if (cur && cur.conf.host === c.host && cur.conf.port === c.port) { cur.conf = { ...c }; cur.st.series = P.seriesFor(cur.st.data.model, c.series); continue; }
      if (cur) this._clearDeadman(cur);
      this.cams.set(c.id, { conf: { ...c }, st: { connected: false, error: null, lastSeen: 0, data: {}, raw: {}, opt: {}, polledAt: 0, series: P.seriesFor('', c.series), lastError: null },
        axes: { pt: false, z: false, f: false }, sent: {}, q: [], busy: false, nextAt: 0, deadman: null, thumbs: new Map() });
    }
    for (const [id, c] of this.cams) if (!keep.has(id)) { this._clearDeadman(c); this.cams.delete(id); }
  }
  close() { for (const c of this.cams.values()) { this._clearDeadman(c); c.st.connected = false; } }
  status() {
    const list = [...this.cams.values()];
    const on = list.filter((c) => c.st.connected);
    const first = on[0];
    return { connected: on.length > 0, online: on.length, total: list.length, lastSeen: Math.max(0, ...list.map((c) => c.st.lastSeen)),
      error: on.length ? null : list.length ? (list[0].st.error || 'no camera answers') : 'no cameras added',
      info: first ? { model: `${on.length}/${list.length} cameras`, version: '' } : null };
  }
  cam(id) { const c = this.cams.get(String(id)); if (!c) throw Object.assign(new Error(`No camera "${id}"`), { status: 404 }); return c; }

  // ---------- transport ----------
  async _http(c, path, opts = {}) {
    const { host, port } = c.conf;
    if (!host) throw new Error(`${c.conf.name}: no IP address`);
    try {
      const r = await httpGet({ host, port: Number(port) || 80, path, timeout: this.conn.timeout, ...opts });
      c.st.lastSeen = Date.now(); c.st.connected = true; c.st.error = null;
      return typeof r === 'string' ? r.trim() : r;
    } catch (e) { if (!e.status) { c.st.connected = false; c.st.error = e.message; } throw Object.assign(new Error(`${c.conf.name}: ${e.message}`), e.status ? { status: e.status === 404 ? 404 : 502 } : {}); }
  }
  // Error replies: the spec's eR<n>:<cmd> (aw_ptz) / ER<n>:<cmd> (aw_cam), and bare E1..E3 from older firmware
  _checkReply(c, cmd, r) {
    const m = /^(?:[eE]R([123])(?::.*)?|E([123]))$/.exec(r);
    if (m) { const n = m[1] || m[2]; c.st.lastError = { cmd, reply: r, at: Date.now() }; throw Object.assign(new Error(`${c.conf.name}: camera refused ${cmd} (${r}: ${ERR[n]})`), { status: 409, reply: r }); }
    return r;
  }
  _url(path, cmd) {
    if (path === 'ptz') return `/cgi-bin/aw_ptz?cmd=%23${encodeURIComponent(cmd)}&res=1`;
    if (path === 'cam') return `/cgi-bin/aw_cam?cmd=${encodeURIComponent(cmd).replace(/%3A/g, ':')}&res=1`;
    if (path === 'web') return `/cgi-bin/${cmd}`;
    throw new Error(`bad path ${path}`);
  }
  // One request in flight per camera; >= gapMs after a pan-tilt head command; `key` coalesces (latest wins)
  _send(c, path, cmd, key = null) {
    return new Promise((resolve, reject) => {
      if (key) { const w = c.q.find((x) => x.key === key); if (w) { w.cmd = cmd; w.path = path; w.waiters.push({ resolve, reject }); return; } }
      c.q.push({ path, cmd, key, waiters: [{ resolve, reject }] });
      this._pump(c);
    });
  }
  async _pump(c) {
    if (c.busy) return;
    const it = c.q.shift(); if (!it) return;
    c.busy = true;
    try {
      const wait = c.nextAt - Date.now(); if (wait > 0) await sleep(wait);
      const r = this._checkReply(c, it.cmd, await this._http(c, this._url(it.path, it.cmd)));
      for (const w of it.waiters) w.resolve(r);
    } catch (e) { for (const w of it.waiters) w.reject(e); } finally {
      c.nextAt = Date.now() + (it.path === 'ptz' ? this.gapMs : 0); c.busy = false;
      if (c.q.length) this._pump(c);
    }
  }
  async ptz(id, cmd) { return this._send(this.cam(id), 'ptz', cmd); }
  async camCmd(id, cmd) { return this._send(this.cam(id), 'cam', cmd); }

  async poll(id) {
    const c = this.cam(id); const at = Date.now();
    const d = parseCamdata(await this._http(c, '/live/camdata.html'));
    const { raw, ...rest } = d;
    c.st.data = { ...c.st.data, ...rest }; c.st.raw = { ...c.st.raw, ...raw }; c.st.polledAt = at;
    c.st.series = P.seriesFor(c.st.data.model, c.conf.series);
    return c.st;
  }
  async connect() {
    if (!this.cams.size) throw new Error('PTZ: no cameras added (SYSTEMS tab)');
    await Promise.all([...this.cams.keys()].map((id) => this.poll(id).catch(() => null)));
    const s = this.status();
    if (!s.connected) throw new Error(s.error || 'no camera answers');
    return s.info;
  }
  async heartbeat() { await Promise.all([...this.cams.keys()].map((id) => this.poll(id).catch(() => null))); if (!this.status().connected) throw new Error(this.status().error); }

  // ---------- motion (hold to run) ----------
  _clearDeadman(c) { if (c.deadman) clearTimeout(c.deadman); c.deadman = null; }
  _arm(c, id) {
    this._clearDeadman(c);
    if (!c.axes.pt && !c.axes.z && !c.axes.f) return;
    c.deadman = setTimeout(() => { c.deadman = null; this.log('warn', `PTZ ${c.conf.name}: no keep-alive from the control surface, stopping`); this.stop(id).catch(() => {}); }, this.deadmanMs);
    if (c.deadman.unref) c.deadman.unref();
  }
  get moving() { return [...this.cams.values()].some((c) => c.axes.pt || c.axes.z || c.axes.f); }
  async _axis(id, axis, code) {
    const c = this.cam(id);
    c.axes[axis] = code !== STOP[axis];
    this._arm(c, id);
    if (c.sent[axis] === code && code !== STOP[axis]) return { sent: false }; // unchanged: keep-alive only
    c.sent[axis] = code;
    try { await this._send(c, 'ptz', code, axis); } catch (e) { c.sent[axis] = null; throw e; }
    return { sent: true };
  }
  // pan / tilt: signed speeds -49..+49 each (right / up positive); 0 / 0 stops pan-tilt
  move(id, { pan = 0, tilt = 0 } = {}) { return this._axis(id, 'pt', `PTS${speedCode(pan)}${speedCode(tilt)}`); }
  zoom(id, { speed = 0 } = {}) { return this._axis(id, 'z', `Z${speedCode(speed)}`); }
  focus(id, { speed = 0 } = {}) { return this._axis(id, 'f', `F${speedCode(speed)}`); }
  keepalive(id) { const c = this.cam(id); this._arm(c, id); return { moving: c.axes.pt || c.axes.z || c.axes.f }; }
  async stop(id, axes = ['pt', 'z', 'f']) {
    const c = this.cam(id);
    // only the axes this series has (a camcorder without a pan-tilt head would refuse PTS5050); unknown model: all
    const caps = P.seriesSpec(c.st.series).caps; const CAP = { pt: 'panTilt', z: 'zoom', f: 'focus' };
    if (c.st.data.model || c.conf.series) axes = axes.filter((a) => caps[CAP[a]]);
    for (const a of axes) { c.axes[a] = false; c.sent[a] = STOP[a]; }
    this._arm(c, id);
    const r = await Promise.allSettled(axes.map((a) => this._send(c, 'ptz', STOP[a], a)));
    const bad = r.find((x) => x.status === 'rejected'); if (bad) throw bad.reason;
  }
  async stopAll() { await Promise.allSettled([...this.cams.keys()].map((id) => this.stop(id))); }
  async home(id) { return this.op(id, 'home'); }

  // ---------- every catalog command (lib/drivers/ptz-commands.js) ----------
  series(id) { return this.cam(id).st.series; }
  catalog(id) { return P.catalogFor(this.series(id)); }
  // the series decides what is valid: read the model once before the first command if it is not known yet
  async _ensure(c, id) { if (!c.st.data.model && !c.conf.series && !c.st.triedModel) { c.st.triedModel = true; await this.poll(id).catch(() => {}); } }
  async op(id, name, value) {
    const c = this.cam(id); await this._ensure(c, id);
    const b = P.build(c.st.series, name, value);
    const r = await this._send(c, b.path, b.cmd);
    if (b.op.type !== 'button') c.st.opt[name] = { v: b.value, at: Date.now() };
    return { ok: true, cmd: b.cmd, reply: r, value: b.value };
  }
  values(c) {
    const v = P.readback(c.st.series, c.st.raw);
    if (c.st.data.tally !== undefined) v.tallyRed = !!c.st.data.tally;
    if (c.st.data.power) v.power = c.st.data.power === 'on';
    for (const [k, o] of Object.entries(c.st.opt)) if (v[k] === undefined || c.st.polledAt <= o.at) v[k] = o.v;
    return v;
  }

  // ---------- presets / power / tally ----------
  _slot(n) { const k = Number(n); if (!Number.isInteger(k) || k < 1 || k > PRESET_COUNT) throw Object.assign(new Error(`Preset must be 1..${PRESET_COUNT}`), { status: 400 }); return two(k - 1); }
  _needCap(c, k, what) { const s = P.seriesSpec(c.st.series); if (!s.caps[k]) throw Object.assign(new Error(`${what}: not supported on the ${c.st.series} series`), { status: 409 }); }
  async recall(id, n) { const c = this.cam(id); await this._ensure(c, id); this._needCap(c, 'preset', 'Presets'); const r = await this._send(c, 'ptz', `R${this._slot(n)}`); c.st.opt.lastPreset = { v: Number(n), at: Date.now() }; return r; }
  async store(id, n) { const c = this.cam(id); await this._ensure(c, id); this._needCap(c, 'preset', 'Presets'); const r = await this._send(c, 'ptz', `M${this._slot(n)}`); c.thumbs.delete(Number(n)); return r; }
  // Preset name kept on the camera (spec OSJ:35:<nn>:<name>, 15 characters, UE150 series only)
  async presetName(id, n, name) {
    const c = this.cam(id); if (!P.SPEC_SERIES.has(c.st.series)) return { sent: false };
    const clean = String(name || '').replace(/[^\x20-\x7e]/g, '').replace(/:/g, ' ').slice(0, 15);
    await this._send(c, 'cam', `OSJ:35:${this._slot(n)}:${clean}`); return { sent: true };
  }
  async thumbnail(id, n) {
    const c = this.cam(id); const k = Number(this._slot(n)) + 1;
    const hit = c.thumbs.get(k); if (hit && Date.now() - hit.at < 60000) return hit;
    const r = await this._http(c, `/cgi-bin/get_preset_thumbnail?preset_number=${k}`, { binary: true, max: 2e6 }).catch((e) => { throw Object.assign(e, { quiet: true }); });
    if (!/^image\/(jpeg|png|gif|svg\+xml)/i.test(r.type)) throw Object.assign(new Error(`${c.conf.name}: preset ${k} thumbnail is not an image (${r.type || 'no type'})`), { status: 404, quiet: true });
    const out = { type: r.type, body: r.body, at: Date.now() }; c.thumbs.set(k, out); return out;
  }
  async power(id, on) { await this.op(id, 'power', !!on); this.cam(id).st.data.power = on ? 'on' : 'standby'; }
  async tally(id, on, color = 'red') {
    if (color === 'green') { await this.op(id, 'tallyGreen', !!on); this.cam(id).st.data.tallyGreen = !!on; }
    else { await this.op(id, 'tallyRed', !!on); this.cam(id).st.data.tally = !!on; }
  }
  // ---------- lens / image (0.7.0 names) ----------
  async autoFocus(id, on) { await this.op(id, 'focusMode', !!on); this.cam(id).st.data.autoFocus = !!on; }
  async oneTouchAF(id) { return this.op(id, 'oneTouchAF'); }
  async iris(id, v) { const n = Math.max(1, Math.min(99, Math.round(Number(v)))); await this.op(id, 'iris', n); this.cam(id).st.data.iris = n; }
  async autoIris(id, on) { await this.op(id, 'irisMode', !!on); this.cam(id).st.data.autoIris = !!on; }
  async gain(id, code) { await this.op(id, 'gain', String(code)); this.cam(id).st.data.gain = String(code); }
  async shutter(id, code) { await this.op(id, 'shutter', String(code)); this.cam(id).st.data.shutter = String(code); }
  async whiteBalance(id, mode) { await this.op(id, 'wbMode', String(mode)); this.cam(id).st.data.wb = String(mode); }

  cameraList() {
    return [...this.cams.values()].map((c) => ({ ...c.conf, connected: c.st.connected, error: c.st.error, lastSeen: c.st.lastSeen, moving: c.axes.pt || c.axes.z || c.axes.f,
      axes: { ...c.axes }, sent: { ...c.sent }, ...c.st.data, series: c.st.series, seriesOverride: !!c.conf.series, values: this.values(c), pos: positions(c.st.raw), lastError: c.st.lastError }));
  }
}

module.exports = { PTZDriver, parseCamdata, positions, GAINS, SHUTTERS, WB, PRESET_COUNT, speedCode, STOP };
