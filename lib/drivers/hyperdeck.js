'use strict';
// Blackmagic HyperDeck Ethernet Protocol (TCP 9993). Record / play / stop are
// the transport machine in the core. This driver sends the words and keeps the
// last status the deck reported.
const net = require('net');

const COMMANDS = {
  record: 'record',
  play: 'play',
  stop: 'stop',
  preview: 'preview: enable: true',
  info: 'transport info',
};

class HyperDeckDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'hyperdeck';
    this.log = log;
    this.onChange = onChange;
    this.capabilities = { hyperdeck: true, transport: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.sock = null;
    this.buf = '';
    this.waiters = [];
    this.transport = { status: 'stopped', speed: 0, slot: 1, clip: null, timecode: null };
    this.configure(conn);
  }
  configure(conn) { this.close(); this.conn = { host: '', port: 9993, ...conn }; }
  status() { return { ...this.st, info: this.st.info ? { ...this.st.info } : null }; }
  close() {
    if (this.sock) { try { this.sock.destroy(); } catch { /* already closed */ } }
    this.sock = null;
    this.st.connected = false;
    for (const w of this.waiters) w.reject(new Error('HyperDeck closed'));
    this.waiters = [];
  }
  _changed() { if (this._chg) return; this._chg = setTimeout(() => { this._chg = null; this.onChange(); }, 20); if (this._chg.unref) this._chg.unref(); }

  connect() {
    if (!this.conn.host) return Promise.reject(new Error('HyperDeck: no IP address set (SYSTEMS tab)'));
    this.close();
    this.buf = '';
    const sock = net.connect({ host: this.conn.host, port: Number(this.conn.port) || 9993 });
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => this._data(chunk));
    sock.on('close', () => { this.st.connected = false; this._changed(); });
    sock.on('error', () => {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.st.error = 'no answer'; this.close(); reject(new Error(`HyperDeck ${this.conn.host}: no answer within 4 s`)); }, 4000);
      sock.once('error', (e) => { clearTimeout(timer); this.close(); reject(new Error(`HyperDeck: ${e.message}`)); });
      this._hello = (info) => { clearTimeout(timer); this._hello = null; resolve(info); };
    });
  }
  async heartbeat() {
    if (!this.sock || !this.st.connected) throw new Error(this.st.error || 'not connected');
    await this._command('transport info');
  }
  _data(chunk) {
    this.buf += chunk;
    const parts = this.buf.split('\n\n');
    this.buf = parts.pop();
    for (const part of parts) if (part.trim()) this._response(part);
  }
  _response(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    const head = lines[0] || '';
    const code = Number(head.slice(0, 3));
    this.st.lastSeen = Date.now();
    if (head.startsWith('500 connection info')) {
      const model = field(lines, 'model') || 'HyperDeck';
      this.st.connected = true;
      this.st.error = null;
      this.st.info = { model, version: field(lines, 'protocol version') || '' };
      if (this._hello) this._hello(this.st.info);
      this._changed();
      return;
    }
    if (head.startsWith('208 transport info')) {
      this.transport = {
        status: (field(lines, 'status') || 'stopped').toLowerCase(),
        speed: Number(field(lines, 'speed')) || 0,
        slot: Number(field(lines, 'slot id')) || 1,
        clip: field(lines, 'clip id'),
        timecode: field(lines, 'display timecode') || field(lines, 'timecode'),
      };
      this._changed();
    }
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (code >= 200 && code < 300) waiter.resolve({ code, lines });
    else waiter.reject(Object.assign(new Error(head || 'HyperDeck refused the command'), { status: 409 }));
  }
  _command(line) {
    if (!this.sock || !this.st.connected) return Promise.reject(Object.assign(new Error('HyperDeck not connected'), { status: 409 }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== row); reject(new Error('HyperDeck did not answer')); }, 4000);
      const row = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      this.waiters.push(row);
      this.sock.write(`${line}\n`, (err) => { if (err) row.reject(err); });
    });
  }
  async transportCmd(name, body = {}) {
    let line = COMMANDS[name];
    if (name === 'goto') line = `goto: clip id: ${Math.round(Number(body.clip) || body.value || 1)}`;
    else if (name === 'slot') line = `slot select: slot id: ${Math.round(Number(body.slot) || body.value || 1)}`;
    else if (name === 'speed') line = `play: speed: ${Number(body.speed != null ? body.speed : body.value) || 0}`;
    else if (name === 'previewOff') line = 'preview: enable: false';
    if (!line) throw Object.assign(new Error('HyperDeck command is record, play, stop, preview, goto, slot, speed, or clips'), { status: 404 });
    const r = await this._command(line);
    if (name === 'record') this.transport.status = 'record';
    else if (name === 'play') this.transport.status = 'play';
    else if (name === 'stop') this.transport.status = 'stopped';
    else if (name === 'preview') this.transport.status = 'preview';
    else if (name === 'previewOff') this.transport.status = 'preview';
    else if (name === 'speed') this.transport.status = 'play';
    this._changed();
    return { ok: true, status: this.transport.status, code: r.code };
  }
  view() { return { transport: { ...this.transport }, modes: ['record', 'play', 'stop', 'preview', 'previewOff', 'goto', 'slot', 'speed', 'clips'] }; }
}

function field(lines, name) {
  const row = lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return row ? row.slice(row.indexOf(':') + 1).trim() : '';
}

module.exports = { HyperDeckDriver, COMMANDS };
