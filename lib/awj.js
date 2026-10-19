'use strict';
// AWJ protocol client over raw TCP 10606 (AWJ Programmer's Guide v6.2, p.3-4).
// Every message is a JSON object terminated by ASCII 0x04. "get" replies carry {"path","value"};
// "replace" commands usually return nothing; errors come back as {"error":{"code","message"}} without a path.
const net = require('net');
const { EventEmitter } = require('events');
const EOT = 0x04;

// Events: 'connect', 'close', 'notify' ({path, value}) for every message that is not the reply to
// the pending get (i.e. subscription notifications, §1.4 p.4-5, and echoes of replace commands).
class AwjClient extends EventEmitter {
  constructor({ host, port = 10606, timeoutMs = 1500, log = () => {} }) {
    super();
    this.host = host; this.port = Number(port) || 10606; this.timeoutMs = timeoutMs; this.log = log;
    this.sock = null; this.buf = Buffer.alloc(0); this.queue = []; this.current = null; this.connecting = null;
  }

  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const to = setTimeout(() => { sock.destroy(); reject(new Error(`AWJ connect timeout ${this.host}:${this.port}`)); }, this.timeoutMs * 2);
      sock.once('connect', () => { clearTimeout(to); this.sock = sock; this.connecting = null; sock.setKeepAlive(true, 5000); sock.setNoDelay(true); resolve(); this.emit('connect'); });
      sock.once('error', (e) => { clearTimeout(to); this.connecting = null; this._failAll(e); reject(e); });
      sock.on('data', (d) => this._onData(d));
      sock.on('close', () => { const was = this.sock === sock; if (was) this.sock = null; this._failAll(new Error('AWJ connection closed')); if (was) this.emit('close'); });
    });
    return this.connecting;
  }

  get connected() { return !!(this.sock && !this.sock.destroyed); }
  close() { this.closed = true; if (this.sock) this.sock.destroy(); this.sock = null; }

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
    if (cur && cur.batch) {
      const path0 = typeof msg.path === 'string' ? msg.path.trim().replace(/^\//, '') : null;
      if (msg && msg.error) cur.errors++;
      else if (path0 && cur.pending.has(path0)) { cur.pending.delete(path0); cur.results[path0] = msg.value; }
      else if (path0) this.emit('notify', { path: path0, value: msg.value });
      if (cur.pending.size <= cur.errors) this._finish(null, cur.results);
      return;
    }
    if (msg && msg.error) {
      if (cur) { this._finish(new Error(`AWJ ${msg.error.code}: ${msg.error.message}`)); }
      else this.log('warn', `AWJ error: ${msg.error.code} ${msg.error.message}`);
      return;
    }
    const path = typeof msg.path === 'string' ? msg.path.trim().replace(/^\//, '') : null;
    if (cur && cur.expectReply && path === cur.path) { this._finish(null, msg.value); return; }
    if (path) this.emit('notify', { path, value: msg.value });
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
    if (item.batch) {
      // Pipelined gets: replies carry their path; errors do not, so they are only counted.
      const bufs = []; for (const p of item.batch) bufs.push(Buffer.from(JSON.stringify({ op: 'get', path: p }), 'utf8'), Buffer.from([EOT]));
      this.sock.write(Buffer.concat(bufs));
      item.timer = setTimeout(() => this._finish(null, item.results), this.timeoutMs * 2);
      return;
    }
    const frame = JSON.stringify(item.cmd);
    this.sock.write(Buffer.concat([Buffer.from(frame, 'utf8'), Buffer.from([EOT])]));
    if (item.op === 'replace' && !item.expectReply) {
      // Writes return no string (AWJ p.9 etc). Give the device a short window to report an error.
      item.timer = setTimeout(() => this._finish(null, true), 60);
    } else {
      item.timer = setTimeout(() => this._finish(new Error(`AWJ get timeout: ${item.path}`)), this.timeoutMs);
    }
  }

  async _send(cmd, expectReply) {
    await this.connect();
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, op: cmd.op, path: cmd.path, expectReply, resolve, reject });
      this._pump();
    });
  }

  get(path) { return this._send({ op: 'get', path }, true); }
  replace(path, value) { return this._send({ op: 'replace', path, value }, false); }
  // replace that waits for the device's {"path","value"} answer (e.g. Subscriptions, §1.4 p.5)
  replaceAndWait(path, value) { return this._send({ op: 'replace', path, value }, true); }
  // Many gets, pipelined in windows of `win`. Paths that error (E12 = absent) or time out are left undefined.
  async getMany(paths, win = 50) {
    const uniq = [...new Set(paths)]; const out = {};
    await this.connect();
    for (let i = 0; i < uniq.length; i += win) {
      const chunk = uniq.slice(i, i + win);
      const res = await new Promise((resolve, reject) => {
        this.queue.push({ batch: chunk, pending: new Set(chunk), results: {}, errors: 0, op: 'batch', resolve, reject });
        this._pump();
      });
      Object.assign(out, res);
    }
    return out;
  }
}

module.exports = { AwjClient, EOT };
