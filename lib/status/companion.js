'use strict';
// Read-only Companion client for the version this app talks to (4.3 and newer).
// HTTP (the remote-control API on Companion's web port):
//   GET /api/connections
//   GET /api/custom-variable/<name>/value
// WebSocket (the satellite API, default port 16623):
//   read BEGIN for the version, answer PING with PONG, send our own PING.
// This client never presses a button, never sets a variable, and never
// registers a surface.

const http = require('http');

// Minimal WebSocket client for Node without global.WebSocket (Node 20).
// Speaks the same frames as lib/status/ws.js so the status-wall tests and the
// Companion satellite link work without an extra dependency.
const net = require('net');
const crypto = require('crypto');
class NodeWebSocket {
  constructor(url) {
    const u = new URL(url);
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port) || 80, u.hostname || '127.0.0.1');
    this._sock = sock;
    let buf = Buffer.alloc(0);
    let upgraded = false;
    sock.on('connect', () => {
      const req = [
        `GET ${u.pathname || '/'} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      sock.write(req);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end).toString('utf8');
        buf = buf.slice(end + 4);
        upgraded = /101/.test(head);
        if (!upgraded) {
          if (this.onerror) this.onerror(new Error('upgrade failed'));
          sock.destroy();
          return;
        }
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (opcode === 1 && this.onmessage) this.onmessage({ data: payload.toString('utf8') });
        if (opcode === 8) { sock.end(); return; }
      }
    });
    sock.on('error', (e) => { if (this.onerror) this.onerror(e); });
    sock.on('close', () => {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    });
  }
  send(data) {
    if (this.readyState !== 1) return;
    const body = Buffer.from(String(data), 'utf8');
    const mask = crypto.randomBytes(4);
    const len = body.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, 0x80 | len, ...mask]);
    } else if (len < 65536) {
      header = Buffer.alloc(6);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = body[i] ^ mask[i % 4];
    this._sock.write(Buffer.concat([header, masked]));
  }
  close() {
    try { this._sock.destroy(); } catch { /* ignore */ }
  }
}

function parseLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const sp = s.indexOf(' ');
  const cmd = (sp < 0 ? s : s.slice(0, sp)).toUpperCase();
  const rest = sp < 0 ? '' : s.slice(sp + 1);
  const args = {};
  const re = /([A-Za-z0-9_-]+)=("([^"]*)"|[^\s]+)/g;
  let m;
  while ((m = re.exec(rest))) args[m[1]] = m[3] != null ? m[3] : m[2];
  return { cmd, args, rest };
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json, text/plain' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function cleanNames(list) {
  const out = [];
  const seen = new Set();
  for (const name of list || []) {
    const s = String(name || '').trim();
    if (!s || seen.has(s) || !/^[A-Za-z0-9_.-]+$/.test(s)) continue;
    seen.add(s);
    if (out.length < 24) out.push(s);
  }
  return out;
}

class CompanionClient {
  constructor(opts = {}) {
    this.target = opts.target || (() => ({ host: '127.0.0.1', port: 8000 }));
    this.wsPort = opts.wsPort || 16623;
    this.get = opts.fetch || httpGet;
    this.WebSocket = opts.WebSocket || global.WebSocket || NodeWebSocket;
    this.timeoutMs = opts.timeoutMs || 1200;
    this.pollMs = opts.pollMs || 2000;
    this.pingMs = opts.pingMs || 2000;
    this.variables = cleanNames(opts.variables);
    this.snap = emptySnap();
    this.timer = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.ws = null;
    this.stopped = true;
    this.backoff = 1000;
    this._reading = false;
  }

  setVariables(names) {
    this.variables = cleanNames(names);
  }

  snapshot() {
    return {
      ...this.snap,
      connections: this.snap.connections.map((row) => ({ ...row })),
      variables: { ...this.snap.variables },
    };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const kick = () => { this.read().catch(() => {}); this.openSocket(); };
    this.timer = setInterval(kick, this.pollMs);
    if (this.timer.unref) this.timer.unref();
    kick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.timer = this.pingTimer = this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  async ensure(names) {
    const extra = cleanNames(names).filter((name) => !this.variables.includes(name));
    if (extra.length) this.variables = cleanNames(this.variables.concat(extra));
    if (!this.snap.checked || extra.length) await this.read();
  }

  async read() {
    if (this._reading) return this.snapshot();
    this._reading = true;
    try {
      const base = this.baseUrl();
      let connections = [];
      let httpOnline = false;
      let error = '';
      try {
        const res = await this.get(`${base}/api/connections`, this.timeoutMs);
        if (res.status === 200) {
          const parsed = parseJson(res.body);
          if (Array.isArray(parsed)) {
            httpOnline = true;
            connections = parsed.map(connectionRow).filter(Boolean);
          } else error = 'Companion answered, but the connection list was not a list.';
        } else error = `Companion HTTP answered ${res.status}.`;
      } catch (e) {
        error = 'Companion is not answering.';
        void e;
      }
      const variables = {};
      if (httpOnline) {
        await Promise.all(this.variables.map(async (name) => {
          try {
            const res = await this.get(`${base}/api/custom-variable/${encodeURIComponent(name)}/value`, this.timeoutMs);
            if (res.status === 404) variables[name] = { found: false, value: '' };
            else if (res.status === 200) variables[name] = { found: true, value: valueText(res) };
            else variables[name] = { found: false, value: '', error: `HTTP ${res.status}` };
          } catch {
            variables[name] = { found: false, value: '', error: 'no answer' };
          }
        }));
      }
      this.snap = {
        ...this.snap,
        checked: true,
        httpOnline,
        error: httpOnline ? '' : error,
        connections,
        variables: httpOnline ? variables : this.snap.variables,
      };
      return this.snapshot();
    } finally {
      this._reading = false;
    }
  }

  baseUrl() {
    const t = this.target() || {};
    const host = t.host || '127.0.0.1';
    const port = t.port || 8000;
    return `http://${host}:${port}`;
  }

  openSocket() {
    if (this.stopped || this.ws || !this.WebSocket) return;
    const t = this.target() || {};
    const host = t.host || '127.0.0.1';
    let ws;
    try {
      ws = new this.WebSocket(`ws://${host}:${this.wsPort}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const fail = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.snap = { ...this.snap, wsOnline: false };
      this.scheduleReconnect();
    };
    ws.onopen = () => {
      this.backoff = 1000;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        try { ws.send('PING status'); } catch { /* closed */ }
      }, this.pingMs);
      if (this.pingTimer.unref) this.pingTimer.unref();
    };
    ws.onmessage = (ev) => this.onMessage(ws, ev.data);
    ws.onerror = () => {};
    ws.onclose = fail;
  }

  onMessage(ws, data) {
    const text = typeof data === 'string' ? data : String(data || '');
    for (const line of text.split(/\r?\n/)) {
      const msg = parseLine(line);
      if (!msg) continue;
      if (msg.cmd === 'BEGIN') {
        this.snap = {
          ...this.snap,
          wsOnline: true,
          version: msg.args.CompanionVersion || this.snap.version,
          apiVersion: msg.args.ApiVersion || this.snap.apiVersion,
        };
      } else if (msg.cmd === 'PING') {
        try { ws.send(`PONG ${msg.rest}`.trimEnd()); } catch { /* closed */ }
      }
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, wait);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }
}

function emptySnap() {
  return { checked: false, httpOnline: false, wsOnline: false, version: '', apiVersion: '', error: '', connections: [], variables: {} };
}

function parseJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function valueText(res) {
  const type = String((res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '');
  if (type.includes('json')) {
    const parsed = parseJson(res.body);
    if (typeof parsed === 'string') return parsed;
    if (parsed == null) return String(res.body || '').trim();
    return JSON.stringify(parsed);
  }
  return String(res.body || '').trim();
}

function connectionRow(row) {
  if (!row || typeof row !== 'object') return null;
  const status = row.status || {};
  const level = String(status.level || status.category || '').toLowerCase();
  return {
    id: String(row.id || ''),
    label: String(row.label || row.moduleId || 'Connection'),
    moduleId: String(row.moduleId || ''),
    enabled: row.enabled !== false,
    online: level === 'ok' || level === 'good',
    message: String(status.message || ''),
  };
}

module.exports = { CompanionClient, parseLine, connectionRow };
