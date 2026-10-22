'use strict';
// Panasonic PTZ cameras (AW-UE / AW-HE / AW-UN / AW-HR series) over the cameras' HTTP CGI interface.
// Reference: the Bitfocus Companion module bitfocus/companion-module-panasonic-ptz (v2.6.1, commit 18caabf,
// https://github.com/bitfocus/companion-module-panasonic-ptz), src/actions.js and src/index.js. That module is the
// source for every command below; nothing here was invented:
//   pan/tilt / lens / presets / power: GET /cgi-bin/aw_ptz?cmd=%23<CMD>&res=1   (sendPTZ, actions.js)
//   camera (image) settings:           GET /cgi-bin/aw_cam?cmd=<CMD>&res=1      (sendCam, actions.js)
//   status:                            GET /live/camdata.html  "KEY:VALUE" lines (getCameraInformation, index.js)
// Commands (actions.js):
//   PTS<pp><tt>  pan / tilt speed, 01..99 each, 50 = stop; pan > 50 right, tilt > 50 up      ('Pan/Tilt - ...')
//   APC7FFF7FFF  home                     Z<nn> zoom 01..99 (> 50 tele), Z50 stop     F<nn> focus (> 50 far), F50 stop
//   D11 / D10    auto / manual focus      OSE:69:1 one-touch auto focus (aw_cam)
//   I<nn>        iris 00..99              D31 / D30 auto / manual iris (see note)
//   R<nn> / M<nn> recall / store preset nn = 00..99 (preset 1 = 00)
//   O1 / O0      power on / standby       DA1 / DA0 red tally (aw_ptz); TLR:<0|1> / TLG:<0|1> red / green tally (aw_cam)
//   OGU:<hex>    gain (80 = auto, 08 = 0 dB ... ; CHOICES_GAIN_HR140, used for UE150)
//   OSH:<code>   shutter (AW-HE130 table; the module has no shutter for the UE150 series)
//   OAW:<0|1|2>  white balance mode Auto / A / B (series with whiteBalanceMode, e.g. UE150)
// camdata.html keys parsed like storeData(): OID (model), TITLE (name), p1 / p0 (power), dA1 / dA0 and TLR / TLG
// (tally), OAF (focus mode), d31 / d30 (iris mode), OGU (gain), qSV3<ver> (firmware), rER<nn> (error state).
// Note: the module's iris-mode ACTION sends D30 for "Auto", but its status parser reads d31 as Auto. This driver
// follows the status parser (D31 = auto), which matches the AF pair (D11 = auto); see the open questions.
//
// One "system" holds many cameras. Moves are hold-to-run: the UI repeats a move every 400 ms while held, and the
// driver stops a camera by itself when no repeat arrives within `deadmanMs` (a lost tablet never leaves a camera
// panning). Stop is also sent on release, cancel and page blur.
const http = require('http');

const GAINS = [['80', 'Auto']].concat(Array.from({ length: 43 }, (_, i) => [(8 + i).toString(16).toUpperCase().padStart(2, '0'), `${i} dB`]));
const SHUTTERS = [['0', 'Off'], ['2', '1/60'], ['3', '1/100'], ['4', '1/120'], ['5', '1/250'], ['6', '1/500'], ['7', '1/1000'], ['8', '1/2000'], ['9', '1/4000'], ['A', '1/10000'], ['B', 'Synchro scan'], ['C', 'ELC']];
const WB = [['0', 'Auto'], ['1', 'A'], ['2', 'B']];
const two = (n) => String(Math.max(0, Math.min(99, Math.round(n)))).padStart(2, '0');
const speedCode = (s) => two(50 + Math.max(-49, Math.min(49, Math.round(Number(s) || 0))));
const PRESET_COUNT = 100;

function httpText({ host, port, path, timeout = 2500 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: 'GET', path, timeout }, (res) => {
      let raw = ''; res.setEncoding('latin1');
      res.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(new Error('response too large')); });
      res.on('end', () => (res.statusCode >= 400 ? reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })) : resolve(raw)));
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeout} ms`)));
    req.on('error', reject);
    req.end();
  });
}

function parseCamdata(text) {
  const d = {};
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    const str = s.split(':');
    const k = str[0];
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

class PTZDriver {
  constructor(conn = {}, log = () => {}) {
    this.system = 'ptz';
    this.log = log;
    this.capabilities = { ptzCameras: true, ptzControl: true, ptzPresets: true, cameras: true };
    this.cams = new Map(); // id -> { conf, st, moving, deadman }
    this.deadmanMs = 1500;
    this.configure(conn);
  }
  configure(conn) {
    this.conn = { cameras: [], timeout: 2500, ...conn };
    const keep = new Set();
    for (const c of this.conn.cameras || []) {
      keep.add(c.id);
      const cur = this.cams.get(c.id);
      if (cur && cur.conf.host === c.host && cur.conf.port === c.port) { cur.conf = { ...c }; continue; }
      if (cur) this._clearDeadman(cur);
      this.cams.set(c.id, { conf: { ...c }, st: { connected: false, error: null, lastSeen: 0, data: {} }, moving: false, deadman: null });
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

  async _get(c, path) {
    const { host, port } = c.conf;
    if (!host) throw new Error(`${c.conf.name}: no IP address`);
    try {
      const r = await httpText({ host, port: Number(port) || 80, path, timeout: this.conn.timeout });
      c.st.lastSeen = Date.now(); c.st.connected = true; c.st.error = null;
      return r.trim();
    } catch (e) { c.st.connected = false; c.st.error = e.message; throw new Error(`${c.conf.name}: ${e.message}`); }
  }
  // Panasonic CGI answers an unsupported / busy / out-of-range command with E1 / E2 / E3 (camera spec; the
  // Companion module ignores the body). Treated as errors so the UI can say so.
  _checkReply(c, cmd, r) { if (/^(E[123]|ER[123](:.*)?)$/.test(r)) throw Object.assign(new Error(`${c.conf.name}: camera refused ${cmd} (${r})`), { status: 409 }); return r; }
  async ptz(id, cmd) { const c = this.cam(id); return this._checkReply(c, cmd, await this._get(c, `/cgi-bin/aw_ptz?cmd=%23${encodeURIComponent(cmd)}&res=1`)); }
  async camCmd(id, cmd) { const c = this.cam(id); return this._checkReply(c, cmd, await this._get(c, `/cgi-bin/aw_cam?cmd=${encodeURIComponent(cmd).replace(/%3A/g, ':')}&res=1`)); }

  async poll(id) {
    const c = this.cam(id);
    const d = parseCamdata(await this._get(c, '/live/camdata.html'));
    c.st.data = { ...c.st.data, ...d };
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
  _arm(c, id) { this._clearDeadman(c); c.deadman = setTimeout(() => { c.deadman = null; this.log('warn', `PTZ ${c.conf.name}: no keep-alive from the control surface, stopping`); this.stop(id).catch(() => {}); }, this.deadmanMs); if (c.deadman.unref) c.deadman.unref(); }
  async move(id, { pan = 0, tilt = 0 } = {}) { const c = this.cam(id); c.moving = true; this._arm(c, id); return this.ptz(id, `PTS${speedCode(pan)}${speedCode(tilt)}`); }
  async zoom(id, { speed = 0 } = {}) { const c = this.cam(id); c.moving = true; this._arm(c, id); return this.ptz(id, `Z${speedCode(speed)}`); }
  async focus(id, { speed = 0 } = {}) { const c = this.cam(id); c.moving = true; this._arm(c, id); return this.ptz(id, `F${speedCode(speed)}`); }
  async stop(id) {
    const c = this.cam(id); this._clearDeadman(c); c.moving = false;
    const r = await Promise.allSettled([this.ptz(id, 'PTS5050'), this.ptz(id, 'Z50'), this.ptz(id, 'F50')]);
    const bad = r.find((x) => x.status === 'rejected'); if (bad) throw bad.reason;
  }
  async stopAll() { await Promise.allSettled([...this.cams.keys()].map((id) => this.stop(id))); }
  async home(id) { return this.ptz(id, 'APC7FFF7FFF'); }

  // ---------- presets / power / tally ----------
  _slot(n) { const k = Number(n); if (!Number.isInteger(k) || k < 1 || k > PRESET_COUNT) throw Object.assign(new Error(`Preset must be 1..${PRESET_COUNT}`), { status: 400 }); return two(k - 1); }
  async recall(id, n) { return this.ptz(id, `R${this._slot(n)}`); }
  async store(id, n) { return this.ptz(id, `M${this._slot(n)}`); }
  async power(id, on) { await this.ptz(id, on ? 'O1' : 'O0'); this.cam(id).st.data.power = on ? 'on' : 'standby'; }
  async tally(id, on, color = 'red') {
    if (color === 'green') { await this.camCmd(id, `TLG:${on ? 1 : 0}`); this.cam(id).st.data.tallyGreen = !!on; }
    else { await this.ptz(id, on ? 'DA1' : 'DA0'); this.cam(id).st.data.tally = !!on; }
  }
  // ---------- lens / image ----------
  async autoFocus(id, on) { await this.ptz(id, on ? 'D11' : 'D10'); this.cam(id).st.data.autoFocus = !!on; }
  async oneTouchAF(id) { return this.camCmd(id, 'OSE:69:1'); }
  async iris(id, v) { await this.ptz(id, `I${two(Number(v))}`); this.cam(id).st.data.iris = Math.round(Number(v)); }
  async autoIris(id, on) { await this.ptz(id, on ? 'D31' : 'D30'); this.cam(id).st.data.autoIris = !!on; }
  async gain(id, code) { if (!GAINS.some(([k]) => k === String(code))) throw Object.assign(new Error('Unknown gain value'), { status: 400 }); await this.camCmd(id, `OGU:${code}`); this.cam(id).st.data.gain = String(code); }
  async shutter(id, code) { if (!SHUTTERS.some(([k]) => k === String(code))) throw Object.assign(new Error('Unknown shutter value'), { status: 400 }); await this.camCmd(id, `OSH:${code}`); this.cam(id).st.data.shutter = String(code); }
  async whiteBalance(id, mode) { if (!WB.some(([k]) => k === String(mode))) throw Object.assign(new Error('Unknown white balance mode'), { status: 400 }); await this.camCmd(id, `OAW:${mode}`); this.cam(id).st.data.wb = String(mode); }

  cameraList() {
    return [...this.cams.values()].map((c) => ({ ...c.conf, connected: c.st.connected, error: c.st.error, lastSeen: c.st.lastSeen, moving: c.moving, ...c.st.data }));
  }
}

module.exports = { PTZDriver, parseCamdata, GAINS, SHUTTERS, WB, PRESET_COUNT, speedCode };
