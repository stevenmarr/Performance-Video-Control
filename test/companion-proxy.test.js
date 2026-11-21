'use strict';
// 0.34.0: Companion's web UI and tRPC websocket under Control Center's own address (/companion/), through
// lib/companion/proxy.js and the routes in lib/server.js. A fake upstream stands in for Companion.
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { createCompanionProxy, upstreamPath, rewriteLocation, originAllowed } = require('../lib/companion/proxy');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');

function fakeCompanion() {
  const seen = [];
  const upgrades = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('X-App', 'Bitfocus Companion');
      if (req.url === '/connections/instance/x') { res.writeHead(301, { Location: '/instance/x' }); return res.end(); }
      if (req.url === '/abs') { res.writeHead(302, { Location: `http://127.0.0.1:${srv.address().port}/buttons` }); return res.end(); }
      res.setHeader('Content-Type', 'text/plain');
      res.end(`ok ${req.method} ${req.url} ${body}`);
    });
  });
  srv.on('upgrade', (req, socket) => {
    upgrades.push({ url: req.url, headers: req.headers });
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (d) => socket.write(d)); // echo raw bytes
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
    open.add(socket); socket.on('close', () => open.delete(socket));
  });
  const open = new Set();
  const close = srv.close.bind(srv);
  srv.close = (cb) => { for (const s of open) s.destroy(); srv.closeAllConnections(); return close(cb); };
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen, upgrades })));
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// raw websocket handshake; resolves {status, socket}
const clientSockets = new Set();
test.afterEach(() => { for (const s of clientSockets) s.destroy(); clientSockets.clear(); });
function wsHandshake(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const h = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13', ...headers };
      s.write(`GET ${path} HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    clientSockets.add(s);
    let buf = '';
    const onData = (d) => { buf += d.toString('latin1'); const i = buf.indexOf('\r\n\r\n'); if (i >= 0) { s.off('data', onData); resolve({ status: Number(buf.split(' ')[1]), head: buf.slice(0, i), socket: s }); } };
    s.on('data', onData);
    s.on('error', reject);
    s.on('close', () => { if (!buf) resolve({ status: 0, socket: s }); });
  });
}

test('path mapping: /companion → /companion/, /companion/x → /x, help and module aliases pass through', () => {
  assert.deepEqual(upstreamPath('/companion'), { redirect: '/companion/' });
  assert.deepEqual(upstreamPath('/companion?x=1'), { redirect: '/companion/?x=1' });
  assert.deepEqual(upstreamPath('/companion/'), { path: '/' });
  assert.deepEqual(upstreamPath('/companion/assets/a.js?v=2'), { path: '/assets/a.js?v=2' });
  assert.deepEqual(upstreamPath('/user-guide/config'), { path: '/user-guide/config' });
  assert.deepEqual(upstreamPath('/instance/abc/x'), { path: '/instance/abc/x' });
  assert.equal(upstreamPath('/companionx'), null);
  assert.equal(upstreamPath('/api/companion'), null);
  const t = { host: '127.0.0.1', port: 8000 };
  assert.equal(rewriteLocation('/instance/x', t), '/companion/instance/x');
  assert.equal(rewriteLocation('http://127.0.0.1:8000/buttons', t), '/companion/buttons');
  assert.equal(rewriteLocation('/companion/ok', t), '/companion/ok');
  assert.equal(rewriteLocation('https://bitfocus.io/', t), 'https://bitfocus.io/');
  assert.equal(originAllowed({ headers: { host: 'pv-m2:8080', origin: 'http://pv-m2:8080' } }), true);
  assert.equal(originAllowed({ headers: { host: 'pv-m2:8080', origin: 'http://evil.example' } }), false);
  assert.equal(originAllowed({ headers: { host: 'pv-m2:8080', origin: 'null' } }), false);
  assert.equal(originAllowed({ headers: { host: 'pv-m2:8080' } }), true);
});

test('HTTP: prefix stripped, companion-custom-prefix and X-Forwarded-* set (spoofed ones replaced), body and redirects', async () => {
  const up = await fakeCompanion();
  const proxy = createCompanionProxy({ target: () => ({ host: '127.0.0.1', port: up.port }) });
  const front = http.createServer((req, res) => { if (!proxy.web(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;
  try {
    const r = await request(fp, '/companion/buttons?x=1', { headers: { Host: 'pv-m2.local:8080', 'companion-custom-prefix': 'evil', 'X-Forwarded-Host': 'evil.example' } });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'ok GET /buttons?x=1 ');
    const h = up.seen.at(-1).headers;
    assert.equal(h['companion-custom-prefix'], 'companion');
    assert.equal(h['x-forwarded-host'], 'pv-m2.local:8080');
    assert.equal(h.host, `127.0.0.1:${up.port}`);
    assert.equal(h['x-forwarded-for'], '127.0.0.1');
    assert.equal(r.headers['x-app'], 'Bitfocus Companion');
    const post = await request(fp, '/companion/api/location/1/0/0/press', { method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(post.body, 'ok POST /api/location/1/0/0/press hello');
    const red = await request(fp, '/companion');
    assert.equal(red.status, 302); assert.equal(red.headers.location, '/companion/');
    const loc = await request(fp, '/companion/connections/instance/x');
    assert.equal(loc.status, 301); assert.equal(loc.headers.location, '/companion/instance/x');
    const abs = await request(fp, '/companion/abs');
    assert.equal(abs.headers.location, '/companion/buttons');
    const help = await request(fp, '/user-guide/');
    assert.equal(help.body, 'ok GET /user-guide/ ');
  } finally { proxy.close(); front.closeAllConnections(); front.close(); up.srv.closeAllConnections(); up.srv.close(); }
});

test('HTTP: nothing to proxy to, or Companion down → 502 that says why (HTML page retries)', async () => {
  let target = null;
  const proxy = createCompanionProxy({ target: () => target, info: () => ({ state: 'starting', message: 'Companion is starting.' }) });
  const front = http.createServer((req, res) => proxy.web(req, res));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;
  try {
    const html = await request(fp, '/companion/', { headers: { Accept: 'text/html' } });
    assert.equal(html.status, 502);
    assert.match(html.body, /COMPANION · STARTING/);
    assert.match(html.body, /http-equiv="refresh"/);
    const js = await request(fp, '/companion/trpc/x');
    assert.equal(js.status, 502);
    assert.equal(JSON.parse(js.body).state, 'starting');
    const closed = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    target = { host: '127.0.0.1', port: closed };
    const down = await request(fp, '/companion/', { headers: { Accept: 'application/json' } });
    assert.equal(down.status, 502);
    assert.match(JSON.parse(down.body).error, /ECONNREFUSED/);
  } finally { proxy.close(); front.closeAllConnections(); front.close(); }
});

test('websocket: same-origin upgrade reaches Companion with its own Origin, no X-Forwarded-Host; cross-origin is refused', async () => {
  const up = await fakeCompanion();
  const proxy = createCompanionProxy({ target: () => ({ host: '127.0.0.1', port: up.port }) });
  const front = http.createServer((req, res) => proxy.web(req, res));
  front.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fp = front.address().port;
  try {
    const ok = await wsHandshake(fp, '/companion/trpc', { Host: 'pv-m2.local:8080', Origin: 'http://pv-m2.local:8080' });
    assert.equal(ok.status, 101);
    const u = up.upgrades.at(-1);
    assert.equal(u.url, '/trpc');
    assert.equal(u.headers.origin, `http://127.0.0.1:${up.port}`);
    assert.equal(u.headers.host, `127.0.0.1:${up.port}`);
    assert.equal(u.headers['x-forwarded-host'], undefined);
    assert.equal(u.headers['companion-custom-prefix'], 'companion');
    // bytes flow both ways after the handshake
    const echoed = await new Promise((r) => { ok.socket.once('data', (d) => r(d.toString())); ok.socket.write('ping-bytes'); });
    assert.equal(echoed, 'ping-bytes');
    ok.socket.destroy();
    const bad = await wsHandshake(fp, '/companion/trpc', { Host: 'pv-m2.local:8080', Origin: 'http://evil.example' });
    assert.equal(bad.status, 403);
    assert.equal(up.upgrades.length, 1, 'the refused upgrade never reached Companion');
  } finally { proxy.close(); front.closeAllConnections(); front.close(); up.srv.closeAllConnections(); up.srv.close(); }
});

test('Control Center server: /companion/ goes to the COMPANION tab address, the service route works without a supervisor, other upgrades get 404', async () => {
  const up = await fakeCompanion();
  const env = await setup();
  const server = createServer(env.engine, null);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const cfg = await request(port, '/api/companion/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: '127.0.0.1', port: up.port }) });
    assert.equal(cfg.status, 200);
    const view = JSON.parse(cfg.body);
    assert.equal(view.uiUrl, '/companion/');
    assert.equal(view.service, null);
    const r = await request(port, '/companion/surfaces');
    assert.equal(r.body, 'ok GET /surfaces ');
    const svc = JSON.parse((await request(port, '/api/companion/service')).body);
    assert.equal(svc.managed, false);
    const start = await request(port, '/api/companion/service/start', { method: 'POST' });
    assert.equal(start.status, 409);
    const ws = await wsHandshake(port, '/companion/trpc', { Origin: `http://127.0.0.1:${port}` });
    assert.equal(ws.status, 101); ws.socket.destroy();
    const other = await wsHandshake(port, '/api/events');
    assert.equal(other.status, 404);
    const ver = JSON.parse((await request(port, '/api/version')).body);
    assert.ok(ver.features.includes('companionService') && ver.features.includes('companionProxy'));
  } finally { server.closeClients(); server.closeAllConnections(); server.close(); up.srv.closeAllConnections(); up.srv.close(); await env.teardown(); }
});

test('Control Center server with a supervisor: managed mode targets 127.0.0.1:<service port> and the routes drive it', async () => {
  const up = await fakeCompanion();
  const env = await setup();
  const calls = [];
  const sup = {
    managed: true, port: up.port, state: 'running',
    target: () => ({ host: '127.0.0.1', port: up.port }),
    status: () => ({ mode: 'managed', managed: true, state: 'running', port: up.port, message: 'ok' }),
    start: () => { calls.push('start'); return { ok: 1 }; },
    stop: async () => { calls.push('stop'); return { ok: 1 }; },
    restart: async () => { calls.push('restart'); return { ok: 1 }; },
    applyConfig: async (b) => { calls.push(['config', b]); return { ok: 1 }; },
    logsView: (q) => { calls.push(['logs', q]); return { seq: 0, lines: [] }; },
  };
  const server = createServer(env.engine, null, { companionSupervisor: sup });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // the saved host/port points elsewhere; managed mode ignores it
    await request(port, '/api/companion/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: '10.9.9.9', port: 1 }) });
    const view = JSON.parse((await request(port, '/api/companion')).body);
    assert.equal(view.webUrl, `http://127.0.0.1:${up.port}`);
    assert.equal(view.service.state, 'running');
    assert.equal((await request(port, '/companion/')).body, 'ok GET / ');
    for (const a of ['start', 'stop', 'restart']) assert.equal((await request(port, `/api/companion/service/${a}`, { method: 'POST' })).status, 200);
    await request(port, '/api/companion/service/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'external' }) });
    await request(port, '/api/companion/service/logs?since=5&limit=10');
    assert.deepEqual(calls, ['start', 'stop', 'restart', ['config', { mode: 'external' }], ['logs', { since: '5', limit: '10' }]]);
  } finally { server.closeClients(); server.closeAllConnections(); server.close(); up.srv.closeAllConnections(); up.srv.close(); await env.teardown(); }
});
