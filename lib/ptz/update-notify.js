'use strict';
// Panasonic update-notification client. The camera is told to push OSx:yy:data
// lines to a TCP port we listen on:
//   GET /cgi-bin/event?connect=start&my_port=<port>&uid=0
//   GET /cgi-bin/event?connect=stop&my_port=<port>&uid=0
// (UE150 spec p.25 note ※2; UE160 p.87). Used to cache scene values after a
// recall. Tests inject lines without opening a socket.

const net = require('net');
const http = require('http');
const { parseNotifyLine } = require('./scene-baseline');

function createNotifier({ baseline, fetch, listenHost = '0.0.0.0', decode } = {}) {
  let server = null;
  let port = 0;
  const cameras = new Map(); // camId -> { ip, started }

  function handleLine(camId, line) {
    const parsed = parseNotifyLine(line);
    if (!parsed) return null;
    const value = decode ? decode(camId, parsed.key, parsed.data) : parsed.data;
    if (baseline) {
      if (value && typeof value === 'object' && !Array.isArray(value)) baseline.remember(camId, value, { source: 'notify' });
      else if (value !== undefined) baseline.remember(camId, { [parsed.key]: value }, { source: 'notify' });
      baseline.remember(camId, { [`cgi:${parsed.key}`]: parsed.data }, { source: 'notify' });
    }
    return parsed;
  }

  function ingest(camId, text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const p = handleLine(camId, line);
      if (p) out.push(p);
    }
    return out;
  }

  async function listen() {
    if (server) return port;
    server = net.createServer((sock) => {
      let buf = '';
      let camId = cameras.size === 1 ? [...cameras.keys()][0] : null;
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() || '';
        for (const line of parts) ingest(camId, line);
      });
      sock.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, listenHost, () => {
        port = server.address().port;
        resolve();
      });
    });
    return port;
  }

  async function startCamera(camId, ip, { httpGet } = {}) {
    const p = await listen();
    const get = httpGet || fetch || defaultGet;
    const url = `http://${ip}/cgi-bin/event?connect=start&my_port=${p}&uid=0`;
    try {
      await get(url);
      cameras.set(camId, { ip, started: true, port: p });
    } catch (e) {
      cameras.set(camId, { ip, started: false, error: e.message, port: p });
      throw e;
    }
    return cameras.get(camId);
  }

  async function stopCamera(camId, { httpGet } = {}) {
    const row = cameras.get(camId);
    if (!row || !row.started) { cameras.delete(camId); return; }
    const get = httpGet || fetch || defaultGet;
    try { await get(`http://${row.ip}/cgi-bin/event?connect=stop&my_port=${row.port}&uid=0`); } catch { /* best effort */ }
    cameras.delete(camId);
  }

  async function close() {
    const ids = [...cameras.keys()];
    for (const id of ids) await stopCamera(id).catch(() => {});
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    server = null;
    port = 0;
  }

  return { listen, startCamera, stopCamera, close, ingest, handleLine, port: () => port, cameras };
}

function defaultGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.setTimeout(3000, () => { req.destroy(new Error('event CGI timed out')); });
    req.on('error', reject);
  });
}

module.exports = { createNotifier };
