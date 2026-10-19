'use strict';
// AWJ protocol client over raw TCP 10606 (AWJ Programmer's Guide v6.2, p.3-4).
// Every message is a JSON object terminated by ASCII 0x04. "get" replies carry {"path","value"};
// "replace" commands usually return nothing; errors come back as {"error":{"code","message"}} without a path.
const net = require('net');
const EOT = 0x04;

class AwjClient {
  constructor({ host, port = 10606, timeoutMs = 1500, log = () => {} }) {
    this.host = host; this.port = Number(port) || 10606; this.timeoutMs = timeoutMs; this.log = log;
    this.sock = null; this.buf = Buffer.alloc(0); this.queue = []; this.current = null; this.connecting = null;
  }

  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const to = setTimeout(() => { sock.destroy(); reject(new Error(`AWJ connect timeout ${this.host}:${this.port}`)); }, this.timeoutMs * 2);
      sock.once('connect', () => { clearTimeout(to); this.sock = sock; this.connecting = null; resolve(); });
      sock.once('error', (e) => { clearTimeout(to); this.connecting = null; this._failAll(e); reject(e); });
      sock.on('data', (d) => this._onData(d));
      sock.on('close', () => { this.sock = null; this._failAll(new Error('AWJ connection closed')); });
    });
    return this.connecting;
  }

  close() { if (this.sock) this.sock.destroy(); this.sock = null; }

  _failAll(err) {
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(err); this.current = null; }
    for (const q of this.queue) q.reject(err);
    this.queue = [];
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    let i;
    while ((i = this.buf.indexOf(EOT)) >= 0) {
      const frame = this.buf.subarray(0, i).toString('utf8').trim();
      this.buf = this.buf.subarray(i + 1);
      if (!frame) continue;
      let msg;
      try { msg = JSON.parse(frame); } catch { this.log('warn', `AWJ: unparseable frame ${frame.slice(0, 120)}`); continue; }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    const cur = this.current;
    if (msg && msg.error) {
      if (cur) { this._finish(new Error(`AWJ ${msg.error.code}: ${msg.error.message}`)); }
      else this.log('warn', `AWJ error: ${msg.error.code} ${msg.error.message}`);
      return;
    }
    if (cur && cur.op === 'get' && typeof msg.path === 'string' && msg.path.trim().replace(/^\//, '') === cur.path) {
      this._finish(null, msg.value);
    }
    // Anything else is a subscription notification; ignored (we do not subscribe).
  }

  _finish(err, value) {
    const cur = this.current; this.current = null;
    if (!cur) return;
    clearTimeout(cur.timer);
    if (err) cur.reject(err); else cur.resolve(value);
    this._pump();
  }

  _pump() {
    if (this.current || !this.queue.length || !this.sock) return;
    const item = this.queue.shift();
    this.current = item;
    const frame = JSON.stringify(item.cmd);
    this.sock.write(Buffer.concat([Buffer.from(frame, 'utf8'), Buffer.from([EOT])]));
    if (item.op === 'replace') {
      // Writes return no string (AWJ p.9 etc). Give the device a short window to report an error.
      item.timer = setTimeout(() => this._finish(null, true), 60);
    } else {
      item.timer = setTimeout(() => this._finish(new Error(`AWJ get timeout: ${item.path}`)), this.timeoutMs);
    }
  }

  async _send(cmd) {
    await this.connect();
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, op: cmd.op, path: cmd.path, resolve, reject });
      this._pump();
    });
  }

  get(path) { return this._send({ op: 'get', path }); }
  replace(path, value) { return this._send({ op: 'replace', path, value }); }
}

module.exports = { AwjClient, EOT };
