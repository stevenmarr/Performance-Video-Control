'use strict';
// Control Center's side of the tracker socket. The browser never opens it; this process does,
// so a page on another machine does not have to be allowed to talk to the Mac directly.
const { connectWebSocket } = require('./ws');

class TrackingBridge {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.link = { host: '127.0.0.1', port: 8765 };
    this.connected = false;
    this.error = null;
    this.protocol = null;
    this.status = new Map();
    this.socket = null;
    this.timer = null;
    this.closed = false;
    this.attempt = 0;
    this.queue = [];
  }

  configure(link) {
    this.link = { host: link.host, port: link.port };
  }

  connect() {
    this.closed = false;
    this._open();
  }

  close() {
    this.closed = true;
    this._clear();
    if (this.socket) { const s = this.socket; this.socket = null; s.close(); }
    this.connected = false;
  }

  send(message) {
    const text = JSON.stringify(message);
    if (this.connected && this.socket) { this.socket.send(text); return true; }
    this.queue.push(text);
    if (this.queue.length > 20) this.queue.shift();
    return false;
  }

  statusFor(cameraId) { return this.status.get(cameraId) || null; }

  snapshot() {
    return { host: this.link.host, port: this.link.port, connected: this.connected, error: this.error, protocol: this.protocol };
  }

  _clear() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  _open() {
    this._clear();
    if (this.closed) return;
    if (this.socket) { const s = this.socket; this.socket = null; s.close(); }
    let socket;
    try {
      socket = connectWebSocket({ host: this.link.host, port: this.link.port, path: '/v1' });
    } catch (e) {
      this.error = e.message;
      this._retry();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.connected = true;
      this.error = null;
      this.attempt = 0;
      this.log('info', `tracking: connected to ${this.link.host}:${this.link.port}`);
      socket.send(JSON.stringify({ v: 1, type: 'hello', role: 'control', name: 'control-center', protocol: 1 }));
      for (const text of this.queue) socket.send(text);
      this.queue = [];
    });
    socket.on('message', (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || msg.v !== 1) return;
      if (msg.type === 'hello') this.protocol = msg.protocol || 1;
      else if (msg.type === 'status' && msg.cameraId) this.status.set(msg.cameraId, msg);
      else if (msg.type === 'error') this.error = msg.message || msg.code || 'tracker error';
    });
    socket.on('error', (err) => {
      if (this.socket !== socket) return;
      this.error = err.message;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const was = this.connected;
      this.connected = false;
      if (was) this.log('warn', 'tracking: the Mac app disconnected');
      this._retry();
    });
  }

  _retry() {
    if (this.closed) return;
    this._clear();
    const wait = Math.min(8000, 500 * (2 ** this.attempt));
    this.attempt = Math.min(this.attempt + 1, 5);
    this.timer = setTimeout(() => this._open(), wait);
    if (this.timer.unref) this.timer.unref();
  }
}

module.exports = { TrackingBridge };
