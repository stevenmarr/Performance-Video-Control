'use strict';
// 0.12.0 scopes: minimal WebSocket server side (RFC 6455) for the stream relay. Binary + text frames out (unmasked),
// small text / ping / close frames in (masked). No extensions, no fragmentation on send. No deps.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return null; }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  socket.setNoDelay(true);
  return new WsConn(socket, head);
}
function frameHeader(op, len) {
  if (len < 126) return Buffer.from([0x80 | op, len]);
  if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); return h; }
  const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h;
}
class WsConn extends EventEmitter {
  constructor(socket, head) {
    super(); this.socket = socket; this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0); this.open = true;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    socket.on('close', () => this._closed()); socket.on('error', () => this._closed());
  }
  get buffered() { return this.socket.writableLength; }
  _closed() { if (!this.open) return; this.open = false; this.emit('close'); }
  send(data) { // Buffer -> binary, string -> text; a Buffer[] is sent as one binary message
    if (!this.open) return false;
    const parts = Array.isArray(data) ? data : [typeof data === 'string' ? Buffer.from(data) : data];
    const len = parts.reduce((s, p) => s + p.length, 0);
    this.socket.cork(); this.socket.write(frameHeader(typeof data === 'string' ? 1 : 2, len)); for (const p of parts) this.socket.write(p); process.nextTick(() => this.socket.uncork());
    return true;
  }
  close(code = 1000) { if (!this.open) return; const b = Buffer.alloc(2); b.writeUInt16BE(code); try { this.socket.write(Buffer.concat([frameHeader(8, 2), b])); this.socket.end(); } catch { /* */ } this._closed(); }
  _parse() {
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 0x0f; const masked = this.buf[1] & 0x80; let len = this.buf[1] & 0x7f; let o = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); o = 4; } else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); o = 10; }
      // 8 MB: one H.264 access unit from the NDI sidecar can exceed 1 MB at 1080p
      if (len > 8 * 1024 * 1024) { this.close(1009); return; }
      const mo = o; if (masked) o += 4; if (this.buf.length < o + len) return;
      const p = Buffer.from(this.buf.subarray(o, o + len)); if (masked) for (let i = 0; i < len; i++) p[i] ^= this.buf[mo + (i & 3)];
      this.buf = this.buf.subarray(o + len);
      if (op === 1) this.emit('text', p.toString('utf8'));
      else if (op === 2) this.emit('binary', p);
      else if (op === 8) { this.close(); return; }
      else if (op === 9) { if (this.open) this.socket.write(Buffer.concat([frameHeader(10, p.length), p])); }
    }
  }
}
module.exports = { accept, WsConn, frameHeader };
