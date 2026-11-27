'use strict';
// The status wall. /status is the read-only screen. /status/config is the
// editor. Both read Control Center's own state and, when a screen asks, a
// read-only Companion connection. Layouts are saved next to the show.

const fs = require('fs');
const path = require('path');
const { LayoutStore, companionNames } = require('./layouts');
const { gather, sourceCatalog } = require('./gather');
const { renderBoard } = require('./map');
const { CompanionClient } = require('./companion');
const ws = require('./ws');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

function create(ctx = {}) {
  const store = new LayoutStore(ctx.dataDir);
  const companion = new CompanionClient({
    target: () => {
      try {
        if (ctx.companion && ctx.companion.uiTarget) return ctx.companion.uiTarget();
      } catch { /* use the default */ }
      return { host: '127.0.0.1', port: 8000 };
    },
    variables: companionNames(store.list()),
  });
  const sockets = new Set();
  let started = false;
  let pushTimer = null;

  function stateNow() {
    return gather({
      engine: ctx.engine, systems: ctx.systems, cues: ctx.cues, masters: ctx.masters,
      modules: ctx.modules, companion: companion.snapshot(),
    });
  }

  function boardFor(query) {
    const layout = store.find(query);
    if (!layout) {
      return { missing: true, name: query ? String(query) : '', names: store.names(), at: Date.now() };
    }
    return renderBoard({ now: Date.now(), layout, state: stateNow() });
  }

  function refreshNames() {
    companion.setVariables(companionNames(store.list()));
  }

  function push() {
    if (!sockets.size) return;
    for (const client of sockets) {
      try { client.send(JSON.stringify({ type: 'board', board: boardFor(client.layout) })); }
      catch { /* a closed screen drops out on its own */ }
    }
  }

  function schedule() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; push(); }, 80);
    if (pushTimer.unref) pushTimer.unref();
  }

  function start() {
    if (started) return;
    started = true;
    companion.start();
    if (ctx.engine && ctx.engine.on) ctx.engine.on('state', schedule);
    if (ctx.systems && ctx.systems.on) ctx.systems.on('state', schedule);
    if (ctx.modules && ctx.modules.on) ctx.modules.on('state', schedule);
  }

  function stop() {
    clearTimeout(pushTimer);
    pushTimer = null;
    companion.stop();
    if (ctx.engine && ctx.engine.off) ctx.engine.off('state', schedule);
    if (ctx.systems && ctx.systems.off) ctx.systems.off('state', schedule);
    if (ctx.modules && ctx.modules.off) ctx.modules.off('state', schedule);
    for (const client of sockets) client.close();
    sockets.clear();
    started = false;
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function sendHtml(res, file) {
    fs.readFile(path.join(PUBLIC, file), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  async function route(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/status' || p === '/status/')) return sendHtml(res, 'status.html');
    if (req.method === 'GET' && (p === '/status/config' || p === '/status/config/')) return sendHtml(res, 'status-config.html');
    if (!p.startsWith('/api/status')) return false;
    start();
    try {
      if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, boardFor(url.searchParams.get('layout')));
      if (req.method === 'GET' && p === '/api/status/sources') return sendJson(res, 200, { sources: sourceCatalog(stateNow()) });
      if (req.method === 'GET' && p === '/api/status/layouts') return sendJson(res, 200, { layouts: store.list() });
      if (req.method === 'GET' && p === '/api/status/export') return download(res, 'status-layouts.json', store.exportAll());
      const one = /^\/api\/status\/layouts\/([A-Za-z0-9_-]+)$/.exec(p);
      if (one && req.method === 'PUT') {
        const layout = store.update(one[1], await readBody(req));
        refreshNames();
        schedule();
        return sendJson(res, 200, layout);
      }
      if (one && req.method === 'DELETE') {
        const gone = store.remove(one[1]);
        refreshNames();
        return sendJson(res, 200, gone);
      }
      const exp = /^\/api\/status\/layouts\/([A-Za-z0-9_-]+)\/export$/.exec(p);
      if (exp && req.method === 'GET') {
        const body = store.exportOne(exp[1]);
        return download(res, `${body.layout.id}.status-layout.json`, body);
      }
      if (req.method === 'POST' && p === '/api/status/layouts') {
        const layout = store.create(await readBody(req));
        refreshNames();
        return sendJson(res, 200, layout);
      }
      if (req.method === 'POST' && p === '/api/status/import') {
        const layouts = store.importBody(await readBody(req));
        refreshNames();
        schedule();
        return sendJson(res, 200, { layouts });
      }
      if (req.method === 'POST' && p === '/api/status/preview') {
        const { cleanLayout } = require('./layouts');
        const layout = cleanLayout(await readBody(req));
        await companion.ensure(companionNames(layout));
        return sendJson(res, 200, renderBoard({ now: Date.now(), layout, state: stateNow() }));
      }
      return sendJson(res, 404, { error: 'No status route for that.' });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message || 'Could not do that.' });
    }
  }

  function download(res, name, body) {
    const safe = String(name).replace(/[^\w.-]+/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${safe}"`,
    });
    res.end(JSON.stringify(body, null, 2));
  }

  function handle(req, res, url) {
    const p = url.pathname;
    const ours = p === '/status' || p === '/status/' || p === '/status/config' || p === '/status/config/' || p.startsWith('/api/status');
    if (!ours) return false;
    route(req, res, url);
    return true;
  }

  function handleUpgrade(req, socket, head) {
    let pathname = '/';
    let layout = '';
    try {
      const url = new URL(req.url, 'http://x');
      pathname = url.pathname;
      layout = url.searchParams.get('layout') || '';
    } catch { return false; }
    if (pathname !== '/status/ws') return false;
    start();
    ws.upgrade(req, socket, head, (sock) => {
      const client = ws.attach(sock, { onClose: () => sockets.delete(client) });
      client.layout = layout;
      sockets.add(client);
      client.send(JSON.stringify({ type: 'board', board: boardFor(layout) }));
    });
    return true;
  }

  return { handle, handleUpgrade, stop, store, companion, boardFor };
}

module.exports = { create };
