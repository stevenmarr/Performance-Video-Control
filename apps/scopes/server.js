#!/usr/bin/env node
'use strict';
// Scopes. A standalone Mac app for waveform, parade, vectorscope, Lightning and picture.
// Usage: node server.js [--port 8092] [--host 0.0.0.0] [--data <dir>] [--mock]
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { attachScopes } = require('./lib/service');
const { listen } = require('./lib/listen');
const { resolveDataDir, importLegacy } = require('./lib/datadir');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.map': 'application/json', '.woff2': 'font/woff2',
};

function main() {
  const mock = !!arg('mock', false) || process.env.SCOPES_MOCK === '1' || process.env.RS6_MOCK === '1';
  const port = Number(arg('port', process.env.PORT || 8092));
  const bind = String(arg('host', process.env.HOST || '0.0.0.0'));
  const appDir = __dirname;
  const where = resolveDataDir({ argData: arg('data', null), mock, appDir });
  const dataDir = where.dir;
  fs.mkdirSync(dataDir, { recursive: true });
  let imported = { imported: false };
  if (where.source === 'default') {
    try { imported = importLegacy({ destDir: dataDir }); } catch (e) { console.error(`Scopes import: ${e.message}`); }
  }
  const publicDir = path.join(appDir, 'public');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = decodeURIComponent(url.pathname);
    if (file === '/' || file === '/index.html' || file === '/scopes.html' || file === '/lightning' || file === '/lightning.html') file = '/scopes.html';
    const abs = path.normalize(path.join(publicDir, file));
    if (!abs.startsWith(publicDir)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(abs, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });
  const scopes = attachScopes(server, { dataDir, appDir, mock, log: (lv, m) => console.log(`[${lv}] ${m}`) });
  listen(server, port, bind, () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`Scopes: http://localhost:${port}${ips.map((ip) => `  http://${ip}:${port}`).join('')}`);
    console.log(`Data dir: ${dataDir}`);
    if (imported.imported) console.log(`Imported scopes settings from ${imported.from}`);
  });
  const shutdown = async () => { await scopes.close(); server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
