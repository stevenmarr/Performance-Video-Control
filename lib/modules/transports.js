'use strict';
// HTTP, UDP, TCP, a small WebSocket client (OBS), VISCA-over-IP, PJLink and OSC.
// No extra packages: Node's http, dgram, net and crypto.

const http = require('http');
const https = require('https');
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const osc = require('../drivers/osc');
const { encodePayload, decodePayload } = require('./encode');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function httpRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = 4000, retries = 0, auth = null }) {
  const attempts = Math.max(0, Math.min(5, Number(retries) || 0)) + 1;
  const go = (left) => new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(fail(`Bad URL ${url}`)); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const hdrs = { ...headers };
    if (auth && auth.type === 'basic') hdrs.Authorization = `Basic ${Buffer.from(`${auth.user || ''}:${auth.password || ''}`).toString('base64')}`;
    if (auth && auth.type === 'bearer' && auth.token) hdrs.Authorization = `Bearer ${auth.token}`;
    const payload = body == null || body === '' ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (payload && !hdrs['Content-Type'] && !hdrs['content-type']) hdrs['Content-Type'] = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
    if (payload) hdrs['Content-Length'] = payload.length;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: `${u.pathname}${u.search}`,
      method: String(method || 'GET').toUpperCase(), headers: hdrs, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const statusCode = res.statusCode || 0;
        if (statusCode >= 500 && left > 1) { go(left - 1).then(resolve, reject); return; }
        resolve({ status: statusCode, headers: res.headers, body: text });
      });
    });
    req.on('timeout', () => req.destroy(fail(`Timed out after ${timeoutMs} ms`, 504)));
    req.on('error', (e) => {
      if (left > 1) go(left - 1).then(resolve, reject);
      else reject(fail(e.message || 'HTTP request failed', 502));
    });
    if (payload) req.write(payload);
    req.end();
  });
  return go(attempts);
}

function sendUdp({ host, port, payload, broadcast = false, multicast = '', ttl = 1 }) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const done = (err, bytes) => { try { sock.close(); } catch { /* closed */ } if (err) reject(err); else resolve({ bytes }); };
    sock.once('error', (e) => done(e));
    if (broadcast) sock.bind(0, () => { try { sock.setBroadcast(true); } catch { /* still try the send */ } sock.send(payload, port, host, done); });
    else if (multicast) {
      sock.bind(0, () => {
        try { sock.setMulticastTTL(Math.max(1, Number(ttl) || 1)); } catch { /* default ttl */ }
        sock.send(payload, port, multicast, done);
      });
    } else sock.send(payload, port, host, done);
  });
}

function listenUdp({ port, multicast = '', onMessage }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => onMessage(msg, rinfo));
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(Number(port) || 0, () => {
      if (multicast) { try { sock.addMembership(multicast); } catch (e) { sock.close(); reject(e); return; } }
      resolve(sock);
    });
  });
}

class TcpSession extends EventEmitter {
  constructor({ host, port, delimiter = '\n', reconnect = true, backoffMs = 500, maxBackoffMs = 8000 }) {
    super();
    this.host = host;
    this.port = Number(port);
    this.delimiter = delimiter == null ? '\n' : String(delimiter);
    this.reconnect = reconnect !== false;
    this.backoffMs = backoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    this.attempt = 0;
    this.timer = null;
  }
  start() {
    this.closed = false;
    return this._connect();
  }
  _connect() {
    if (this.closed) return Promise.reject(fail('TCP session is closed', 409));
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      this.sock = sock;
      let settled = false;
      const ok = () => { if (settled) return; settled = true; this.attempt = 0; this.emit('status', { connected: true }); resolve(); };
      const bad = (e) => { if (settled) this._schedule(); else { settled = true; reject(e); this._schedule(); } };
      sock.setTimeout(4000, () => { sock.destroy(); bad(fail(`TCP ${this.host}:${this.port} timed out`, 504)); });
      sock.once('connect', () => { sock.setTimeout(0); ok(); });
      sock.on('data', (chunk) => this._data(chunk));
      sock.on('error', (e) => bad(fail(e.message, 502)));
      sock.on('close', () => { this.sock = null; this.emit('status', { connected: false }); this._failWaiters(fail('TCP connection closed', 502)); if (!settled) bad(fail('TCP connection closed', 502)); else this._schedule(); });
    });
  }
  _schedule() {
    if (this.closed || !this.reconnect) return;
    const wait = Math.min(this.maxBackoffMs, this.backoffMs * (2 ** Math.min(this.attempt, 4)));
    this.attempt += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this._connect().catch(() => {}); }, wait);
    if (this.timer.unref) this.timer.unref();
  }
  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.delimiter) {
      this.emit('data', this.buf);
      this._resolveNext(this.buf);
      this.buf = Buffer.alloc(0);
      return;
    }
    const text = this.buf.toString('utf8');
    const parts = text.split(this.delimiter);
    this.buf = Buffer.from(parts.pop(), 'utf8');
    for (const part of parts) {
      if (!part) continue;
      this.emit('data', part);
      this._resolveNext(part);
    }
  }
  _resolveNext(part) {
    const w = this.waiters.shift();
    if (!w) return;
    clearTimeout(w.timer);
    if (w.expect && !w.expect.test(String(part))) {
      this.waiters.unshift(w);
      return;
    }
    w.resolve(part);
  }
  _failWaiters(err) {
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(err); }
    this.waiters = [];
  }
  send(payload, { expect = null, timeoutMs = 4000 } = {}) {
    if (!this.sock) return Promise.reject(fail('TCP is not connected', 409));
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    return new Promise((resolve, reject) => {
      const row = { resolve, reject, expect: expect ? new RegExp(expect) : null, timer: null };
      if (expect) {
        row.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== row);
          reject(fail('TCP reply timed out', 504));
        }, timeoutMs);
        if (row.timer.unref) row.timer.unref();
        this.waiters.push(row);
      }
      this.sock.write(buf, (err) => {
        if (err) { if (expect) this.waiters = this.waiters.filter((w) => w !== row); reject(err); return; }
        if (!expect) resolve(null);
      });
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.reconnect = false;
    if (this.sock) { try { this.sock.destroy(); } catch { /* already closed */ } }
    this.sock = null;
    this._failWaiters(fail('TCP session closed', 409));
  }
}

function listenTcp({ host = '127.0.0.1', port, delimiter = '\n', onLine }) {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (!delimiter) { onLine(buf, sock); buf = ''; return; }
      const parts = buf.split(delimiter);
      buf = parts.pop();
      for (const part of parts) if (part) onLine(part, sock);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port) || 0, host, () => resolve(server));
  });
}

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(String(key).trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function wsFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6); }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function wsTake(state, chunk) {
  state.buf = state.buf && state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
  const out = [];
  for (;;) {
    const buf = state.buf;
    if (!buf || buf.length < 2) break;
    const b1 = buf[1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readUInt32BE(6)); off = 10; }
    const need = off + (masked ? 4 : 0) + len;
    if (buf.length < need) break;
    let payload = buf.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    out.push({ opcode: buf[0] & 0x0f, payload });
    state.buf = buf.subarray(need);
  }
  return out;
}

class WebSocketClient extends EventEmitter {
  constructor() { super(); this.sock = null; this.rx = { buf: null }; this.open = false; }
  connect({ host, port, path = '/', timeoutMs = 4000 }) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port: Number(port) });
      this.sock = sock;
      let head = Buffer.alloc(0);
      let done = false;
      const fin = (err) => { if (done) return; done = true; clearTimeout(timer); if (err) { this.close(); reject(err); } else resolve(); };
      const timer = setTimeout(() => fin(fail('WebSocket handshake timed out', 504)), timeoutMs);
      const key = crypto.randomBytes(16).toString('base64');
      sock.on('error', (e) => fin(fail(e.message, 502)));
      sock.on('data', (chunk) => {
        if (!this.open) {
          head = Buffer.concat([head, chunk]);
          const at = head.indexOf('\r\n\r\n');
          if (at < 0) return;
          const text = head.subarray(0, at).toString('utf8');
          if (!/^HTTP\/1\.[01] 101/i.test(text)) { fin(fail(`WebSocket refused the upgrade (${text.split('\r\n')[0]})`, 502)); return; }
          const accept = /sec-websocket-accept:\s*(\S+)/i.exec(text);
          if (!accept || accept[1] !== wsAcceptKey(key)) { fin(fail('WebSocket accept key did not match', 502)); return; }
          this.open = true;
          this.emit('open');
          const rest = head.subarray(at + 4);
          head = Buffer.alloc(0);
          if (rest.length) this._frames(rest);
          fin(null);
          return;
        }
        this._frames(chunk);
      });
      sock.on('close', () => { this.open = false; this.emit('close'); });
      sock.on('connect', () => {
        sock.write([
          `GET ${path} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '\r\n',
        ].join('\r\n'));
      });
    });
  }
  _frames(chunk) {
    for (const frame of wsTake(this.rx, chunk)) {
      if (frame.opcode === 0x8) { this.close(); return; }
      if (frame.opcode === 0x9) { try { this.sock.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload])); } catch { /* pong is best effort */ } continue; }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) this.emit('message', frame.payload.toString('utf8'));
    }
  }
  send(text) {
    if (!this.open || !this.sock) return Promise.reject(fail('WebSocket is not open', 409));
    return new Promise((resolve, reject) => this.sock.write(wsFrame(text), (err) => (err ? reject(err) : resolve())));
  }
  close() { this.open = false; if (this.sock) { try { this.sock.destroy(); } catch { /* closed */ } this.sock = null; } }
}

function obsPassword(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(String(password) + String(salt)).digest('base64');
  return crypto.createHash('sha256').update(secret + String(challenge)).digest('base64');
}

class ObsClient extends EventEmitter {
  constructor() { super(); this.ws = new WebSocketClient(); this.pending = new Map(); this.identified = false; }
  connect({ host, port = 4455, password = '', timeoutMs = 4000 }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fin = (err) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { this.close(); reject(err); } else resolve(); };
      const timer = setTimeout(() => fin(fail('OBS did not identify', 504)), timeoutMs);
      this.ws.on('message', (text) => {
        let msg; try { msg = JSON.parse(text); } catch { return; }
        if (msg.op === 0) {
          const auth = msg.d && msg.d.authentication;
          const d = { rpcVersion: 1 };
          if (auth) d.authentication = obsPassword(password, auth.salt, auth.challenge);
          this.ws.send(JSON.stringify({ op: 1, d })).catch((e) => fin(e));
          return;
        }
        if (msg.op === 2) { this.identified = true; fin(null); return; }
        if (msg.op === 7 && msg.d) {
          const row = this.pending.get(msg.d.requestId);
          if (!row) return;
          this.pending.delete(msg.d.requestId);
          clearTimeout(row.timer);
          if (msg.d.requestStatus && msg.d.requestStatus.result === false) row.reject(fail(msg.d.requestStatus.comment || 'OBS refused the request', 409));
          else row.resolve(msg.d.responseData || {});
        }
      });
      this.ws.connect({ host, port, timeoutMs }).catch(fin);
    });
  }
  request(requestType, requestData, timeoutMs = 4000) {
    if (!this.identified) return Promise.reject(fail('OBS is not identified', 409));
    const requestId = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(fail(`OBS did not answer ${requestType}`, 504)); }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      const d = { requestType, requestId };
      if (requestData && Object.keys(requestData).length) d.requestData = requestData;
      this.ws.send(JSON.stringify({ op: 6, d })).catch((e) => { clearTimeout(timer); this.pending.delete(requestId); reject(e); });
    });
  }
  close() { this.identified = false; for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(fail('OBS closed', 409)); } this.pending.clear(); this.ws.close(); }
}

function viscaPacket(bytes, seq = 1) {
  const body = Buffer.from(bytes);
  const head = Buffer.alloc(8);
  head.writeUInt16BE(0x0100, 0);
  head.writeUInt16BE(body.length, 2);
  head.writeUInt32BE(seq >>> 0, 4);
  return Buffer.concat([head, body]);
}

function pjlinkAuth(seed, password, command) {
  if (!seed) return command;
  const hash = crypto.createHash('md5').update(String(seed) + String(password || '')).digest('hex');
  return hash + command;
}

function oscMessage(address, args) {
  const list = (Array.isArray(args) ? args : String(args || '').split(/\s+/).filter(Boolean)).map((a) => {
    if (typeof a === 'number') return a;
    const s = String(a);
    if (s === '') return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d+\.\d+$/.test(s)) return Number(s);
    return s;
  }).filter((a) => a != null);
  return osc.encode(address, list);
}

function takeJsonObjects(state, chunk) {
  state.buf = (state.buf || '') + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''));
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  let keep = 0;
  for (let i = 0; i < state.buf.length; i++) {
    const c = state.buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(state.buf.slice(start, i + 1));
        keep = i + 1;
        start = -1;
      }
    }
  }
  state.buf = depth > 0 && start >= 0 ? state.buf.slice(start) : state.buf.slice(keep);
  return out;
}

class JsonRpcClient extends EventEmitter {
  constructor({ host, port }) {
    super();
    this.host = host;
    this.port = Number(port);
    this.sock = null;
    this.rx = { buf: '' };
    this.pending = new Map();
    this.next = 1;
  }
  start() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      this.sock = sock;
      let settled = false;
      const fin = (err) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { this.close(); reject(err); } else resolve(); };
      const timer = setTimeout(() => fin(fail('JSON-RPC connect timed out', 504)), 4000);
      sock.once('connect', () => fin(null));
      sock.on('error', (e) => fin(fail(e.message, 502)));
      sock.on('close', () => { this.sock = null; this._fail(fail('JSON-RPC connection closed', 502)); this.emit('close'); });
      sock.on('data', (chunk) => {
        for (const raw of takeJsonObjects(this.rx, chunk)) {
          let msg; try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.id != null && this.pending.has(msg.id)) {
            const row = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(row.timer);
            if (msg.error) row.reject(fail(msg.error.message || 'JSON-RPC error', 409));
            else row.resolve(msg.result);
          } else if (msg.method) this.emit('notify', msg);
        }
      });
    });
  }
  call(method, params, timeoutMs = 4000) {
    if (!this.sock) return Promise.reject(fail('JSON-RPC is not connected', 409));
    const id = this.next++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail(`JSON-RPC did not answer ${method}`, 504)); }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(`${JSON.stringify(msg)}\n`, (err) => { if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); } });
    });
  }
  _fail(err) {
    for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(err); }
    this.pending.clear();
  }
  close() { this._fail(fail('JSON-RPC closed', 409)); if (this.sock) { try { this.sock.destroy(); } catch { /* closed */ } this.sock = null; } }
}

function artDmx({ universe = 0, sequence = 0, slots = [] } = {}) {
  const data = Buffer.alloc(Math.max(2, slots.length));
  for (let i = 0; i < slots.length && i < data.length; i++) data[i] = Number(slots[i]) & 0xff;
  const packet = Buffer.alloc(18 + data.length);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(14, 10);
  packet[12] = Number(sequence) & 0xff;
  packet[13] = 0;
  packet.writeUInt16LE(Number(universe) & 0x7fff, 14);
  packet.writeUInt16BE(data.length, 16);
  data.copy(packet, 18);
  return packet;
}

function novastarBrightness(level) {
  const xx = Math.max(0, Math.min(255, Math.round(Number(level) || 0)));
  const body = [0x00, 0x00, 0xfe, 0xff, 0x01, 0xff, 0xff, 0xff, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x00, xx];
  let sum = 0x5555;
  for (const b of body) sum = (sum + b) & 0xffff;
  return Buffer.from([0x55, 0xaa, ...body, sum & 0xff, (sum >> 8) & 0xff]);
}

function sacnAddress(universe) {
  const u = Math.max(1, Math.min(63999, Number(universe) || 1));
  return `239.255.${(u >> 8) & 0xff}.${u & 0xff}`;
}

function sacnPacket({ universe = 1, sequence = 0, slots = [], source = 'Control Center', priority = 100 } = {}) {
  const dmx = Buffer.alloc(512);
  for (let i = 0; i < Math.min(512, slots.length); i++) dmx[i] = Number(slots[i]) & 0xff;
  const name = Buffer.alloc(64);
  Buffer.from(String(source).slice(0, 63), 'utf8').copy(name);
  const cid = Buffer.alloc(16);
  cid.write('cc-helios-sacn', 0, 'ascii');
  const dmp = Buffer.alloc(2 + 1 + 1 + 2 + 2 + 2 + 1 + 512);
  const dmpLen = dmp.length;
  dmp.writeUInt16BE(0x7000 | dmpLen, 0);
  dmp[2] = 0x02;
  dmp[3] = 0xa1;
  dmp.writeUInt16BE(0x0000, 4);
  dmp.writeUInt16BE(0x0001, 6);
  dmp.writeUInt16BE(513, 8);
  dmp[10] = 0x00;
  dmx.copy(dmp, 11);
  const framingLen = 2 + 4 + 64 + 1 + 2 + 1 + 1 + 2 + dmp.length;
  const framing = Buffer.alloc(framingLen);
  framing.writeUInt16BE(0x7000 | framingLen, 0);
  framing.writeUInt32BE(0x00000002, 2);
  name.copy(framing, 6);
  framing[70] = Math.max(0, Math.min(200, Number(priority) || 100));
  framing.writeUInt16BE(0, 71);
  framing[73] = Number(sequence) & 0xff;
  framing[74] = 0;
  framing.writeUInt16BE(Math.max(1, Math.min(63999, Number(universe) || 1)), 75);
  dmp.copy(framing, 77);
  const rootLen = 2 + 4 + 16 + framing.length;
  const root = Buffer.alloc(rootLen);
  root.writeUInt16BE(0x7000 | rootLen, 0);
  root.writeUInt32BE(0x00000004, 2);
  cid.copy(root, 6);
  framing.copy(root, 22);
  const preamble = Buffer.alloc(16);
  preamble.writeUInt16BE(0x0010, 0);
  preamble.write('ASC-E1.17', 4, 'ascii');
  return Buffer.concat([preamble, root]);
}

function jsonPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null) return undefined;
    const m = /^([^[]+)\[(\d+)\]$/.exec(part);
    if (m) cur = cur[m[1]] && cur[m[1]][Number(m[2])];
    else cur = cur[part];
  }
  return cur;
}

function p2000Packet({ instruction = 1, input = 1, output = 1, machine = 1 } = {}) {
  const packet = Buffer.alloc(4);
  packet[0] = Number(instruction) & 0x3f;
  packet[1] = (Number(input) & 0x7f) | 0x80;
  packet[2] = (Number(output) & 0x7f) | 0x80;
  packet[3] = (Number(machine) & 0x1f) | 0x80;
  return packet;
}

function dliveChannel(channel) {
  return Math.max(0, Math.min(0x7f, (Number(channel) || 1) - 1));
}

function dliveMidi(spec, fallback) {
  const raw = spec.midiChannel != null && spec.midiChannel !== '' ? spec.midiChannel : fallback;
  return (Math.max(1, Math.min(16, Number(raw) || 1)) - 1) & 0x0f;
}

function dliveMute({ channel = 1, on = true, midi = 0 } = {}) {
  const status = 0x90 | (Number(midi) & 0x0f);
  const note = dliveChannel(channel);
  const velocity = on ? 0x7f : 0x3f;
  return Buffer.from([status, note, velocity, status, note, 0x00]);
}

function dliveFader({ channel = 1, level = 0, midi = 0 } = {}) {
  const status = 0xb0 | (Number(midi) & 0x0f);
  const note = dliveChannel(channel);
  const value = Math.max(0, Math.min(0x7f, Math.round(Number(level) || 0)));
  return Buffer.from([status, 0x63, note, status, 0x62, 0x17, status, 0x06, value]);
}

function dliveScene({ scene = 1, midi = 0 } = {}) {
  const n = Number(midi) & 0x0f;
  const index = Math.max(1, Math.min(500, Math.round(Number(scene) || 1))) - 1;
  return Buffer.from([0xb0 | n, 0x00, Math.floor(index / 128), 0xc0 | n, index % 128]);
}

module.exports = {
  httpRequest, sendUdp, listenUdp, TcpSession, listenTcp,
  WebSocketClient, ObsClient, obsPassword, wsAcceptKey, wsFrame, wsTake,
  viscaPacket, pjlinkAuth, oscMessage, jsonPath, JsonRpcClient, takeJsonObjects,
  novastarBrightness, sacnPacket, sacnAddress, artDmx,
  p2000Packet, dliveMute, dliveFader, dliveScene, dliveMidi,
};
