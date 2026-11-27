'use strict';
// Mitti (Imimot) over OSC, plus the OSC Query HTTP server Mitti opens on that
// same port (Imimot: Settings → OSC, http://<mac>:51000).
// Playback commands are the addresses Mitti lists: /mitti/play, /mitti/stop,
// /mitti/pause, /mitti/togglePlay, /mitti/cue, /mitti/gotoCueByName.
// Remaining time, elapsed time, and the cue list come from OSC feedback
// (/mitti/cueTimeLeft, /mitti/cueTimeElapsed, /mitti/{id}/cueName, and the
// current/previous/next cue names) and from OSC Query VALUES when the query
// server includes them. Connecting sends no play, stop, or cue. It only reads
// the query server and asks Mitti to resend feedback.
const dgram = require('dgram');
const http = require('http');
const osc = require('./osc');

const COMMANDS = {
  play: { address: '/mitti/play' },
  stop: { address: '/mitti/stop' },
  pause: { address: '/mitti/pause' },
  toggle: { address: '/mitti/togglePlay' },
  next: { address: '/mitti/cueNext' },
  prev: { address: '/mitti/cuePrev' },
  cue: { address: '/mitti/cue', arg: 'index' },
  cueName: { address: '/mitti/gotoCueByName', arg: 'name' },
};

const NOT_CUES = new Set([
  'play', 'stop', 'pause', 'toggleplay', 'cue', 'cuenext', 'cueprev', 'gotocuebyname',
  'resendoscfeedback', 'ping', 'pong', 'time', 'cuetimeleft', 'cuetimeelapsed',
  'currentcuename', 'currentcueid', 'previouscuename', 'nextcuename', 'currentcuetrt',
  'selectedcuename', 'selectedcueid', 'all', 'selected', 'current', 'previous', 'next',
  'togglevideooutputs', 'toggleaudio', 'videooutputson', 'videooutputsoff',
  'playcuewithcueid', 'mitti',
]);

class MittiDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'mitti';
    this.log = log;
    this.onChange = onChange;
    this.capabilities = { mitti: true, transport: true, cues: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.sock = null;
    this.configure(conn);
  }
  configure(conn) { this.close(); this.conn = { host: '', port: 51000, ...conn }; this._blank(); }
  _blank() {
    this.mode = 'stop';
    this.cue = null;
    this.cueName = '';
    this.previousName = '';
    this.nextName = '';
    this.cues = [];
    this.elapsed = '';
    this.remaining = '';
    this.duration = '';
    this.time = '';
  }
  status() { return { ...this.st, info: this.st.info ? { ...this.st.info } : null }; }
  close() {
    if (this.sock) { try { this.sock.close(); } catch { /* already closed */ } }
    this.sock = null;
    this.st.connected = false;
  }
  _changed() { if (this._chg) return; this._chg = setTimeout(() => { this._chg = null; this.onChange(); }, 20); if (this._chg.unref) this._chg.unref(); }

  connect() {
    if (!this.conn.host) return Promise.reject(new Error('Mitti: no IP address set (SYSTEMS tab)'));
    this.close();
    this._blank();
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('error', (e) => { this.st.error = e.message; this.log('warn', `Mitti: ${e.message}`); });
    sock.on('message', (buf) => {
      const msg = osc.decode(buf);
      if (!msg) return;
      this._onOsc(msg);
    });
    return new Promise((resolve, reject) => {
      const onErr = (e) => reject(new Error(`Mitti: ${e.message}`));
      sock.once('error', onErr);
      sock.bind(0, () => {
        sock.removeListener('error', onErr);
        this.st.connected = true;
        this.st.error = null;
        this.st.lastSeen = Date.now();
        const feedbackPort = sock.address().port;
        this.st.info = { model: 'Mitti', version: '', feedbackPort };
        // Read the cue list and the clock. This does not play, stop, or cue.
        this._refresh().then(() => { this._changed(); resolve(this.st.info); }, () => { this._changed(); resolve(this.st.info); });
      });
    });
  }
  async heartbeat() {
    if (!this.sock || !this.st.connected) throw new Error(this.st.error || 'not connected');
    await this._refresh();
  }
  async _refresh() {
    if (!this.sock || !this.st.connected) return;
    const json = await this._query().catch(() => null);
    if (json) this._applyQuery(json);
    // Resend is a feedback refresh, not a transport command. Mitti sends the
    // current cue, the clock, and each cue name to the feedback target.
    await this._sendRaw('/mitti/resendOSCFeedback', []).catch(() => {});
    await wait(40);
    this._changed();
  }
  _query() {
    const port = Number(this.conn.port) || 51000;
    const host = this.conn.host;
    return getJson(queryUrl(host, port, '/mitti')).catch(() => getJson(queryUrl(host, port, '/')));
  }
  _applyQuery(json) {
    const found = { cues: [], values: {} };
    walkQuery(json, found);
    if (found.cues.length) {
      const prev = new Map(this.cues.map((c) => [String(c.id), c]));
      this.cues = found.cues.map((c) => {
        const old = prev.get(String(c.id));
        return { id: String(c.id), name: c.name || (old && old.name) || '' };
      }).sort(cueSort);
    }
    const v = found.values;
    if (v.cuetimeleft != null) this.remaining = cleanTc(v.cuetimeleft);
    if (v.cuetimeelapsed != null) this.elapsed = cleanTc(v.cuetimeelapsed);
    if (v.time != null) this.time = cleanTc(v.time);
    if (v.currentcuetrt != null) this.duration = cleanTc(v.currentcuetrt);
    if (v.currentcuename != null) this.cueName = String(v.currentcuename);
    if (v.previouscuename != null) this.previousName = String(v.previouscuename);
    if (v.nextcuename != null) this.nextName = String(v.nextcuename);
    if (v.currentcueid != null && String(v.currentcueid) !== '') this.cue = String(v.currentcueid);
    if (v.toggleplay != null) this.mode = Number(v.toggleplay) === 0 ? 'pause' : 'play';
    this._changed();
  }
  _onOsc(msg) {
    this.st.lastSeen = Date.now();
    const parts = String(msg.address || '').split('/').filter(Boolean);
    if (!parts.length || parts[0].toLowerCase() !== 'mitti') return;
    const arg = msg.args && msg.args[0] ? msg.args[0].value : undefined;
    if (parts.length >= 3 && parts[1].toLowerCase() === 'feedback') {
      if (parts[2].toLowerCase() === 'transport' && arg != null) this.mode = String(arg);
      else if (parts[2].toLowerCase() === 'cue' && arg != null) this.cue = arg;
    } else if (parts.length === 3 && parts[2].toLowerCase() === 'cuename') {
      this._setCueName(parts[1], arg == null ? '' : String(arg));
    } else if (parts.length === 2) {
      this._master(parts[1], arg);
    } else return;
    this._changed();
  }
  _master(name, arg) {
    const key = String(name || '').toLowerCase();
    if (key === 'cuetimeleft') this.remaining = cleanTc(arg);
    else if (key === 'cuetimeelapsed') this.elapsed = cleanTc(arg);
    else if (key === 'time') this.time = cleanTc(arg);
    else if (key === 'currentcuetrt') this.duration = cleanTc(arg);
    else if (key === 'currentcuename') this.cueName = arg == null ? '' : String(arg);
    else if (key === 'previouscuename') this.previousName = arg == null ? '' : String(arg);
    else if (key === 'nextcuename') this.nextName = arg == null ? '' : String(arg);
    else if (key === 'currentcueid' && arg != null && String(arg) !== '') this.cue = String(arg);
    else if (key === 'toggleplay' && arg != null) this.mode = Number(arg) === 0 ? 'pause' : 'play';
  }
  _setCueName(id, name) {
    const key = String(id);
    const row = this.cues.find((c) => String(c.id) === key);
    if (row) row.name = name;
    else this.cues.push({ id: key, name });
    this.cues.sort(cueSort);
    if (String(this.cue) === key) this.cueName = name;
  }
  _sendRaw(address, args) {
    if (!this.sock || !this.st.connected) return Promise.reject(Object.assign(new Error('Mitti not connected'), { status: 409 }));
    const packet = osc.encode(address, args);
    return new Promise((resolve, reject) => {
      this.sock.send(packet, Number(this.conn.port) || 51000, this.conn.host, (err) => (err ? reject(err) : resolve()));
    });
  }
  async send(name, value) {
    const spec = COMMANDS[name];
    if (!spec) throw Object.assign(new Error(`Unknown Mitti command "${name}"`), { status: 404 });
    if (!this.sock || !this.st.connected) throw Object.assign(new Error('Mitti not connected'), { status: 409 });
    let args = [];
    if (spec.arg === 'index') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error('A Mitti cue index starts at 0'), { status: 400 });
      args = [n];
      this.cue = n;
    } else if (spec.arg === 'name') {
      const s = String(value || '').trim();
      if (!s) throw Object.assign(new Error('A Mitti cue needs a name'), { status: 400 });
      args = [s];
      this.cue = s;
      this.cueName = s;
    }
    if (name === 'play' || name === 'stop' || name === 'pause') this.mode = name === 'pause' ? 'pause' : name;
    if (name === 'toggle') this.mode = this.mode === 'play' ? 'pause' : 'play';
    await this._sendRaw(spec.address, args);
    this.st.lastSeen = Date.now();
    this._changed();
    return { ok: true, address: spec.address, mode: this.mode, cue: this.cue, remaining: this.remaining, elapsed: this.elapsed };
  }
  view() {
    return {
      mode: this.mode,
      transport: this.mode,
      cue: this.cue,
      cueName: this.cueName,
      previous: this.previousName,
      next: this.nextName,
      cues: this.cues.map((c) => ({ id: c.id, name: c.name })),
      elapsed: this.elapsed,
      remaining: this.remaining,
      duration: this.duration,
      time: this.time,
      variables: {
        connected: this.st.connected ? 'true' : 'false',
        transport: this.mode || '',
        cue: this.cue == null ? '' : String(this.cue),
        elapsed: this.elapsed || '',
        remaining: this.remaining || '',
        cues: this.cues.map((c) => c.name || c.id).join(', '),
      },
      modes: ['play', 'pause', 'stop', 'toggle'],
      commands: Object.keys(COMMANDS),
    };
  }
}

function queryUrl(host, port, path) {
  const h = String(host).includes(':') && !String(host).startsWith('[') ? `[${host}]` : host;
  return `http://${h}:${port}${path}`;
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1500, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('OSC Query response is too large')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`OSC Query HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('OSC Query did not answer')));
    req.on('error', reject);
  });
}
function valueOf(node) {
  if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, 'VALUE')) return undefined;
  const v = node.VALUE;
  if (Array.isArray(v)) return v.length ? v[0] : undefined;
  return v;
}
function walkQuery(node, into) {
  const contents = node && node.CONTENTS;
  if (!contents || typeof contents !== 'object') return;
  for (const key of Object.keys(contents)) {
    const child = contents[key];
    const low = key.toLowerCase();
    const val = valueOf(child);
    if (val !== undefined) into.values[low] = val;
    if (isCueNode(key, child)) {
      const nameNode = child.CONTENTS && (child.CONTENTS.cueName || child.CONTENTS.CueName);
      const name = valueOf(nameNode);
      into.cues.push({ id: key, name: name == null ? '' : String(name) });
    } else {
      walkQuery(child, into);
    }
  }
}
function isCueNode(key, node) {
  if (!node || typeof node !== 'object' || !node.CONTENTS) return false;
  if (NOT_CUES.has(String(key).toLowerCase())) return false;
  if (node.CONTENTS.cueName || node.CONTENTS.CueName) return true;
  return /^\d+$/.test(String(key));
}
function cueSort(a, b) {
  const na = /^\d+$/.test(String(a.id));
  const nb = /^\d+$/.test(String(b.id));
  if (na && nb) return Number(a.id) - Number(b.id);
  return String(a.id).localeCompare(String(b.id));
}
function cleanTc(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^-?(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return '';
  return [m[1], m[2], m[3], m[4]].map((p) => p.padStart(2, '0')).join(':');
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { MittiDriver, COMMANDS };
