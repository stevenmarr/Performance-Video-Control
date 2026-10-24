'use strict';
// WebSocket client for the Mac sidecar. Pushes Annex-B H.264 to Control Center.
// Loopback HTTP is the normal path. No npm deps.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function toAnnexB(nals) {
  const parts = [];
  for (const n of nals) { parts.push(Buffer.from([0, 0, 0, 1])); parts.push(Buffer.from(n)); }
  return Buffer.concat(parts);
}

function sendFrame(sock, opcode, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = buf.length; let hdr;
  if (len < 126) hdr = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | opcode; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | opcode; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const data = Buffer.from(buf);
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  sock.write(Buffer.concat([hdr, mask, data]));
}

function connectIngest({ app, id, name, fps }) {
  return new Promise((resolve, reject) => {
    const u = new URL(app);
    const proto = u.protocol === 'https:' ? https : http;
    const path = `/api/scopes/ndi/ingest?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name || id)}&fps=${encodeURIComponent(fps || '')}`;
    const key = crypto.randomBytes(16).toString('base64');
    const req = proto.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path, method: 'GET',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      rejectUnauthorized: process.env.RS6_NDI_INSECURE === '1' ? false : undefined,
    });
    req.on('upgrade', (res, sock) => {
      sock.setNoDelay(true);
      const api = {
        sendBytes(payload) {
          const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
          const MAX = 64 * 1024;
          for (let o = 0; o < buf.length; o += MAX) sendFrame(sock, 2, buf.subarray(o, Math.min(buf.length, o + MAX)));
        },
        sendAu(nals) { api.sendBytes(toAnnexB(nals)); },
        sendText(obj) { sendFrame(sock, 1, Buffer.from(JSON.stringify(obj))); },
        close() { try { sock.end(); } catch { /* */ } },
      };
      api.sendText({ type: 'hello', id, name, fps: Number(fps) || 0 });
      resolve(api);
    });
    req.on('response', (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => reject(new Error(`ingest HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 240)}`)));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { connectIngest, toAnnexB, sendFrame };
