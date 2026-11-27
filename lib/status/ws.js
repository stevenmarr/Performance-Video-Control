'use strict';
// A small WebSocket helper. The status wall pushes a snapshot to each open
// screen. Companion's satellite link is a WebSocket too; the client for that
// one is in companion.js. This file is only the server side of /status/ws.

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

function takeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const n = buf.readBigUInt64BE(2);
    if (n > 1000000n) return { opcode: 8, payload: Buffer.alloc(0), rest: Buffer.alloc(0) };
    len = Number(n);
    off = 10;
  }
  if (len > 1000000) return { opcode: 8, payload: Buffer.alloc(0), rest: Buffer.alloc(0) };
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { opcode, payload, rest: buf.subarray(off + maskLen + len) };
}

function upgrade(req, socket, head, onSocket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    try { socket.destroy(); } catch { /* already gone */ }
    return false;
  }
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ];
  socket.write(lines.join('\r\n'));
  if (head && head.length) socket.unshift(head);
  onSocket(socket);
  return true;
}

function attach(socket, handlers) {
  let buf = Buffer.alloc(0);
  const onText = handlers.onText || (() => {});
  const onClose = handlers.onClose || (() => {});
  let closed = false;
  const finish = () => { if (closed) return; closed = true; onClose(); };
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const frame = takeFrame(buf);
      if (!frame) break;
      buf = frame.rest;
      if (frame.opcode === 8) {
        try { socket.end(encodeFrame(8, frame.payload)); } catch { /* closing */ }
        finish();
        return;
      }
      if (frame.opcode === 9) {
        try { socket.write(encodeFrame(10, frame.payload)); } catch { /* gone */ }
        continue;
      }
      if (frame.opcode === 1) onText(frame.payload.toString('utf8'));
    }
  });
  socket.on('close', finish);
  socket.on('error', () => {});
  return {
    send(text) { try { socket.write(encodeFrame(1, text)); } catch { /* gone */ } },
    close() { try { socket.end(encodeFrame(8, Buffer.alloc(0))); } catch { /* gone */ } finish(); },
  };
}

module.exports = { upgrade, attach, encodeFrame, takeFrame, acceptKey };
