'use strict';
// Mitti (Imimot) over OSC. The addresses are the ones Mitti lists under
// Settings → OSC (play, stop, pause, toggle, cue by index, cue by name).
// Like Millumin, a silent Mac is still a target: "connected" means the socket
// is open toward the address you typed. Cue and transport state are the last
// command we sent, until Mitti sends feedback.
const dgram = require('dgram');
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

class MittiDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'mitti';
    this.log = log;
    this.onChange = onChange;
    this.capabilities = { mitti: true, transport: true, cues: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.sock = null;
    this.mode = 'stop';
    this.cue = null;
    this.configure(conn);
  }
  configure(conn) { this.close(); this.conn = { host: '', port: 51000, ...conn }; }
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
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('error', (e) => { this.st.error = e.message; this.log('warn', `Mitti: ${e.message}`); });
    sock.on('message', (buf) => {
      const msg = osc.decode(buf);
      if (!msg) return;
      this.st.lastSeen = Date.now();
      if (msg.address === '/mitti/feedback/transport' && msg.args[0]) this.mode = String(msg.args[0].value);
      if (msg.address === '/mitti/feedback/cue' && msg.args[0]) this.cue = msg.args[0].value;
      this._changed();
    });
    return new Promise((resolve, reject) => {
      sock.once('error', (e) => reject(new Error(`Mitti: ${e.message}`)));
      sock.bind(0, () => {
        this.st.connected = true;
        this.st.error = null;
        this.st.lastSeen = Date.now();
        this.st.info = { model: 'Mitti', version: '' };
        this._changed();
        resolve(this.st.info);
      });
    });
  }
  async heartbeat() {
    if (!this.sock || !this.st.connected) throw new Error(this.st.error || 'not connected');
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
    }
    if (name === 'play' || name === 'stop' || name === 'pause') this.mode = name === 'pause' ? 'pause' : name;
    if (name === 'toggle') this.mode = this.mode === 'play' ? 'pause' : 'play';
    const packet = osc.encode(spec.address, args);
    await new Promise((resolve, reject) => {
      this.sock.send(packet, Number(this.conn.port) || 51000, this.conn.host, (err) => (err ? reject(err) : resolve()));
    });
    this.st.lastSeen = Date.now();
    this._changed();
    return { ok: true, address: spec.address, mode: this.mode, cue: this.cue };
  }
  view() { return { mode: this.mode, cue: this.cue, modes: ['play', 'pause', 'stop', 'toggle'], commands: Object.keys(COMMANDS) }; }
}

module.exports = { MittiDriver, COMMANDS };
