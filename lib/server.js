'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function createServer(engine) {
  const clients = new Set();
  const broadcast = (event, data) => { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); };
  let pending = null;
  engine.on('state', () => { if (pending) return; pending = setTimeout(() => { pending = null; broadcast('state', engine.getState()); }, 30); });
  engine.on('log', (e) => broadcast('log', e));

  const routes = [];
  const route = (method, re, fn) => routes.push({ method, re, fn });

  route('GET', /^\/api\/state$/, () => engine.getState());
  route('GET', /^\/api\/log$/, () => engine.logs);
  route('GET', /^\/api\/settings$/, () => engine.publicSettings());
  route('POST', /^\/api\/settings$/, async (b) => { engine.updateSettings(b); await engine.connect(); return engine.getState(); });
  route('POST', /^\/api\/connect$/, async () => { await engine.connect(); return engine.getState(); });
  route('POST', /^\/api\/destinations\/refresh$/, async () => { await engine.connect(); return engine.getState(); });
  route('POST', /^\/api\/destinations\/([SAsa]\d+)\/toggle$/, (b, m) => ({ selection: engine.toggleDest(m[1]) }));
  route('POST', /^\/api\/selection$/, (b) => ({ selection: engine.setSelection(b.destinations || []) }));
  route('POST', /^\/api\/capture$/, (b) => engine.exclusive(async () => {
    const dests = (b.destinations && b.destinations.length ? b.destinations : [...engine.selection]);
    const cap = await engine.capture(dests);
    return { memories: cap.memories, warnings: cap.warnings };
  }));
  route('POST', /^\/api\/presets$/, (b) => engine.savePreset(b));
  route('GET', /^\/api\/presets\/(\d+)$/, (b, m) => { const p = engine.getPreset(m[1]); if (!p) throw Object.assign(new Error('not found'), { status: 404 }); return p; });
  route('PUT', /^\/api\/presets\/(\d+)$/, (b, m) => engine.editPreset(m[1], b));
  route('DELETE', /^\/api\/presets\/(\d+)$/, (b, m) => { engine.deletePreset(m[1]); return { ok: true }; });
  route('POST', /^\/api\/presets\/(\d+)\/recall$/, (b, m) => engine.recall(m[1]));
  route('POST', /^\/api\/presets\/(\d+)\/update$/, (b, m) => engine.updatePreset(m[1], b));
  route('POST', /^\/api\/presets\/(\d+)\/duplicate$/, (b, m) => engine.duplicatePreset(m[1], b.toNumber));
  route('POST', /^\/api\/take$/, () => engine.take());
  route('POST', /^\/api\/cut$/, () => engine.cut());
  route('POST', /^\/api\/autotake$/, (b) => ({ autoTake: engine.setAutoTake(b.value) }));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(engine.getState())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return json(404, { error: `No route ${req.method} ${url.pathname}` });
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        let body = {};
        if (raw) { try { body = JSON.parse(raw); } catch { return json(400, { error: 'Invalid JSON body' }); } }
        try { const out = await r.fn(body || {}, url.pathname.match(r.re)); json(200, out === undefined ? { ok: true } : out); }
        catch (e) { engine.log('error', `${req.method} ${url.pathname}: ${e.message}`); json(e.status || 400, { error: e.message }); }
      });
      return;
    }

    // static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (file === '/settings') file = '/index.html';
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  server.closeClients = () => { for (const c of clients) c.end(); clients.clear(); };
  return server;
}

module.exports = { createServer };
