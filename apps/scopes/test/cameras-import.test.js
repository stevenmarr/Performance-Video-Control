'use strict';
// Standalone cameras: add, import from a Control Center views payload, JPEG from the camera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { attachScopes } = require('../lib/service');

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

test('a camera added in Scopes is an RTSP source with Control Center not running', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'scopes-cam-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sc = attachScopes(srv, { dataDir: data, log: () => {} });
  t.after(() => sc.close());
  const port = await listen(srv);
  t.after(() => srv.close());
  const B = `http://127.0.0.1:${port}`;
  const added = await (await fetch(`${B}/api/scopes/cameras`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'wide', name: 'Wide', host: '192.0.2.20', model: 'AW-UE160', stream: 2 }),
  })).json();
  assert.equal(added.cameras.wide.host, '192.0.2.20');
  assert.equal(added.cameras.wide.loginFrom, 'factory');
  assert.ok(!JSON.stringify(added).includes('12345'));
  const s = await (await fetch(`${B}/api/scopes/sources`)).json();
  const row = s.sources.find((x) => x.key === 'cam:wide');
  assert.equal(row.ok, true);
  assert.match(row.detail, /^rtsp:\/\/192\.0\.2\.20\/MediaInput\/h264\/stream_2$/);
});

test('import copies host and name and still lists the camera after Control Center stops', async (t) => {
  const cc = http.createServer((req, res) => {
    if (req.url === '/api/sys/views') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ views: { ptz: { cameras: [{ id: 'cam1', name: 'Wide', host: '192.0.2.10', port: 80, model: 'AW-UE150', user: 'op' }] } } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const ccPort = await listen(cc);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'scopes-imp-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sc = attachScopes(srv, { dataDir: data, log: () => {} });
  t.after(() => sc.close());
  const port = await listen(srv);
  t.after(() => { srv.close(); cc.close(); });
  const B = `http://127.0.0.1:${port}`;
  const down = await fetch(`${B}/api/scopes/cameras/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:1' }),
  });
  assert.equal(down.status, 502);
  const imported = await (await fetch(`${B}/api/scopes/cameras/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${ccPort}` }),
  })).json();
  assert.equal(imported.imported, 1);
  assert.equal(imported.settings.cameras.cam1.name, 'Wide');
  assert.equal(imported.settings.cameras.cam1.host, '192.0.2.10');
  assert.equal(imported.settings.cameras.cam1.model, 'AW-UE150');
  assert.ok(!JSON.stringify(imported).includes('12345'));
  cc.close();
  const s = await (await fetch(`${B}/api/scopes/sources`)).json();
  assert.equal(s.sources.find((x) => x.key === 'cam:cam1').label.startsWith('Wide'), true);
});

test('JPEG snapshot is fetched from the camera, not from Control Center', async (t) => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const cam = http.createServer((req, res) => {
    if (String(req.url || '').startsWith('/cgi-bin/camera')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(jpeg);
      return;
    }
    res.writeHead(404); res.end('not the camera');
  });
  const camPort = await listen(cam);
  t.after(() => cam.close());
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'scopes-jpg-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sc = attachScopes(srv, { dataDir: data, log: () => {} });
  t.after(() => sc.close());
  const port = await listen(srv);
  t.after(() => srv.close());
  const B = `http://127.0.0.1:${port}`;
  await fetch(`${B}/api/scopes/cameras`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'cam1', name: 'Cam', host: '127.0.0.1', httpPort: camPort, model: 'AW-HE130' }),
  });
  const r = await fetch(`${B}/api/scopes/cameras/cam1/snapshot`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/jpeg/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpeg);
  const missing = await fetch(`${B}/api/sys/ptz/cameras/cam1/snapshot`);
  assert.equal(missing.status, 404);
});
