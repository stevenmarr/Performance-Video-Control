'use strict';
// HTTP API hosted by the Path C Stream Deck plugin (com.performancevideo.control).
// Control Center calls this to list connected decks and to push a page stack.
// The hardware adapter is required. This module does not invent a deck.

const http = require('http');
const { isLoopbackAddress } = require('../ndi/host');

const DEFAULT_PORT = 9721;
const PLUGIN_UUID = 'com.performancevideo.control';

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function createPluginServer({ hardware, host = '127.0.0.1', port = DEFAULT_PORT } = {}) {
  if (!hardware || typeof hardware.devices !== 'function' || typeof hardware.deploy !== 'function') {
    throw new Error('Path C plugin HTTP needs a hardware adapter (devices + deploy)');
  }
  const send = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer(async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress) && process.env.RS6_DECK_PLUGIN_LAN !== '1') {
      return send(res, 403, { error: 'Path C plugin API accepts loopback only' });
    }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'bad url' }); }
    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return send(res, 200, { ok: true, plugin: PLUGIN_UUID });
      }
      if (req.method === 'GET' && url.pathname === '/v1/devices') {
        const devices = await hardware.devices();
        return send(res, 200, { devices: Array.isArray(devices) ? devices : [] });
      }
      if (req.method === 'POST' && url.pathname === '/v1/deploy') {
        const body = await readBody(req);
        const deviceId = String(body.deviceId || '');
        if (!deviceId) return send(res, 400, { error: 'deviceId required' });
        if (!Array.isArray(body.pages)) return send(res, 400, { error: 'pages required' });
        const result = await hardware.deploy(deviceId, { pages: body.pages });
        return send(res, 200, result);
      }
      return send(res, 404, { error: `No route ${req.method} ${url.pathname}` });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || String(e) });
    }
  });
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return {
    server,
    url,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          const addr = server.address();
          const published = `http://127.0.0.1:${addr.port}`;
          let closed = false;
          resolve({
            url: published,
            port: addr.port,
            close: () => new Promise((r) => {
              if (closed) return r();
              closed = true;
              server.close(() => r());
            }),
          });
        });
      });
    },
  };
}

module.exports = { createPluginServer, DEFAULT_PORT, PLUGIN_UUID };
