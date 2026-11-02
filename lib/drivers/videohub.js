'use strict';
// Blackmagic Videohub Ethernet Protocol (the text blocks on TCP 9990).
// A crosspoint is a plain value: output N is fed by input M. The connection
// machine lives in the core. This file only speaks the protocol.
const net = require('net');

function blocks(text) {
  const out = [];
  let head = '';
  let lines = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) {
      if (head) out.push({ head, lines });
      head = ''; lines = [];
      continue;
    }
    if (line.endsWith(':') && !head) { head = line.slice(0, -1); continue; }
    if (head) lines.push(line);
  }
  if (head) out.push({ head, lines });
  return out;
}

class VideohubDriver {
  constructor(conn = {}, log = () => {}, onChange = () => {}) {
    this.system = 'videohub';
    this.log = log;
    this.onChange = onChange;
    this.capabilities = { videohub: true, router: true };
    this.st = { connected: false, info: null, error: null, lastSeen: 0 };
    this.sock = null;
    this.buf = '';
    this.inputs = [];
    this.outputs = [];
    this.routing = {};
    this.configure(conn);
  }
  configure(conn) { this.close(); this.conn = { host: '', port: 9990, ...conn }; }
  status() { return { ...this.st, info: this.st.info ? { ...this.st.info } : null }; }
  close() {
    if (this.sock) { try { this.sock.destroy(); } catch { /* already closed */ } }
    this.sock = null;
    this.st.connected = false;
  }
  _changed() { if (this._chg) return; this._chg = setTimeout(() => { this._chg = null; this.onChange(); }, 20); if (this._chg.unref) this._chg.unref(); }

  connect() {
    if (!this.conn.host) return Promise.reject(new Error('Videohub: no IP address set (SYSTEMS tab)'));
    this.close();
    this.buf = '';
    const sock = net.connect({ host: this.conn.host, port: Number(this.conn.port) || 9990 });
    this.sock = sock;
    sock.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      let done = false;
      const fin = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) { this.st.error = err.message; this.close(); reject(err); }
        else resolve(this.st.info);
      };
      const timer = setTimeout(() => fin(new Error(`Videohub ${this.conn.host}: no status within 4 s`)), 4000);
      sock.on('error', (e) => fin(new Error(`Videohub: ${e.message}`)));
      sock.on('data', (chunk) => {
        this.buf += chunk;
        this._parse(this.buf);
        if (this.st.connected) fin(null);
      });
      sock.on('close', () => { this.st.connected = false; this._changed(); });
    });
  }
  async heartbeat() {
    if (!this.sock || !this.st.connected) throw new Error(this.st.error || 'not connected');
    if (Date.now() - this.st.lastSeen > 15000) {
      this.st.connected = false;
      this.st.error = 'router stopped answering';
      this.close();
      throw new Error(this.st.error);
    }
  }
  _parse(text) {
    let saw = false;
    for (const block of blocks(text)) {
      saw = true;
      if (block.head === 'VIDEOHUB DEVICE') {
        const model = (block.lines.find((l) => l.startsWith('Model name:')) || '').slice(12).trim();
        this.st.info = { model: model || 'Videohub', version: '' };
        this.st.connected = true;
        this.st.error = null;
        this.st.lastSeen = Date.now();
      }
      if (block.head === 'INPUT LABELS') this.inputs = block.lines.map(labelLine).filter(Boolean);
      if (block.head === 'OUTPUT LABELS') this.outputs = block.lines.map(labelLine).filter(Boolean);
      if (block.head === 'VIDEO OUTPUT ROUTING') {
        for (const line of block.lines) {
          const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
          if (m) this.routing[m[1]] = Number(m[2]);
        }
        this.st.lastSeen = Date.now();
        this._changed();
      }
    }
    if (saw) this.buf = tailAfterLastBlank(text);
  }
  _send(body) {
    if (!this.sock || !this.st.connected) return Promise.reject(Object.assign(new Error('Videohub not connected'), { status: 409 }));
    return new Promise((resolve, reject) => {
      this.sock.write(body, (err) => (err ? reject(err) : resolve()));
    });
  }
  // output and input are 0-based, the way the Videohub protocol numbers them.
  async crosspoint(output, input) {
    const o = Number(output);
    const i = Number(input);
    if (!Number.isInteger(o) || o < 0 || !Number.isInteger(i) || i < 0) {
      throw Object.assign(new Error('Crosspoint needs an output and an input, starting at 0'), { status: 400 });
    }
    await this._send(`VIDEO OUTPUT ROUTING:\n${o} ${i}\n\n`);
    this.routing[String(o)] = i;
    this._changed();
    return { output: o, input: i };
  }
  view() {
    return {
      inputs: this.inputs.map((x) => ({ ...x })),
      outputs: this.outputs.map((x) => ({ ...x, source: this.routing[String(x.index)] == null ? null : this.routing[String(x.index)] })),
      routing: { ...this.routing },
    };
  }
}

function labelLine(line) {
  const m = /^(\d+)\s+(.+)$/.exec(line.trim());
  return m ? { index: Number(m[1]), name: m[2] } : null;
}
function tailAfterLastBlank(text) {
  const i = text.lastIndexOf('\n\n');
  return i < 0 ? text : text.slice(i + 2);
}

module.exports = { VideohubDriver, blocks };
