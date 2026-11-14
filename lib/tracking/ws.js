'use strict';
// A small WebSocket client (RFC 6455). The desk has no control-path dependencies, and Node 16 has no
// built-in WebSocket, so the bridge speaks the framing itself. Server frames are unmasked; ours are masked.
const crypto = require('crypto');
const net = require('net');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload, maskKey) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const mask = maskKey || crypto.randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }
  return Buffer.concat([header, mask, masked]);
}

function encodeText(text) { return encodeFrame(0x1, Buffer.from(String(text))); }

class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 2) {
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        if (this.buf.readUInt32BE(2) !== 0) throw new Error('frame too large');
        len = this.buf.readUInt32BE(6);
        off = 10;
      }
      if (len > 1_048_576) throw new Error('frame too large');
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) break;
      let payload = this.buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.slice(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = this.buf.slice(off + maskLen + len);
      out.push({ opcode, payload });
    }
    return out;
  }
}

function connectWebSocket({ host, port, path = '/' }) {
  const socket = net.connect({ host, port });
  const decoder = new FrameDecoder();
  const listeners = { open: [], message: [], close: [], error: [] };
  const on = (name, fn) => { listeners[name].push(fn); return api; };
  const emit = (name, arg) => { for (const fn of listeners[name]) { try { fn(arg); } catch { /* a listener must not kill the socket */ } } };
  let opened = false;
  let buffer = Buffer.alloc(0);
  const key = crypto.randomBytes(16).toString('base64');
  const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.on('connect', () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });
  socket.on('data', (chunk) => {
    if (!opened) {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffer.slice(0, end).toString('utf8');
      const accept = /sec-websocket-accept:\s*(.+)/i.exec(head);
      if (!/^HTTP\/1\.1 101/.test(head) || !accept || accept[1].trim() !== expect) {
        socket.destroy(new Error('tracker did not accept the WebSocket upgrade'));
        return;
      }
      opened = true;
      const rest = buffer.slice(end + 4);
      buffer = Buffer.alloc(0);
      emit('open');
      if (rest.length) feed(rest);
      return;
    }
    feed(chunk);
  });
  function feed(chunk) {
    let frames;
    try { frames = decoder.push(chunk); } catch (e) { socket.destroy(e); return; }
    for (const frame of frames) {
      if (frame.opcode === 0x1) emit('message', frame.payload.toString('utf8'));
      else if (frame.opcode === 0x9) { try { socket.write(encodeFrame(0xA, frame.payload)); } catch { /* closing */ } }
      else if (frame.opcode === 0x8) socket.end();
    }
  }
  socket.on('error', (err) => emit('error', err));
  socket.on('close', () => emit('close'));
  const api = {
    on,
    send(text) { if (opened && !socket.destroyed) socket.write(encodeText(text)); },
    close() { if (!socket.destroyed) { try { socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch { /* already gone */ } socket.destroy(); } },
    get opened() { return opened; },
  };
  return api;
}

module.exports = { connectWebSocket, encodeText, FrameDecoder, GUID };
