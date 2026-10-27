'use strict';
// Desktop Video ingest: host gate, missing helper, sidecar fixture push, hello kind=decklink,
// source menu order. No DeckLink hardware and no SDK in the tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { hostRole, assertDeckLinkHost } = require('../lib/ndi/host');
const { helloExtras, connectIngest } = require('../lib/ndi/ingest-client');
const { helperPath, missingHelperMessage, assertHelperPresent } = require('../tools/decklink-sidecar');
const { sourceMenu, sourceGroups, preferLiveSource } = require('../public/scopes-sources');
const { attachScopes } = require('../lib/scopes/service');
const { parseList } = require('../lib/scopes/decklink-devices');

const BARS = path.join(__dirname, 'fixtures', 'scopes', 'bars.h264');
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

test('Desktop Video receive is macOS only, same gate as the sidecar', () => {
  const mac = hostRole({ platform: 'darwin', arch: 'arm64', model: '' });
  assert.equal(mac.decklinkReceiveAllowed, true);
  assert.doesNotThrow(() => assertDeckLinkHost(mac));
  const pi = hostRole({ platform: 'linux', arch: 'aarch64', model: 'Raspberry Pi 5 Model B Rev 1.0' });
  assert.equal(pi.decklinkReceiveAllowed, false);
  assert.throws(() => assertDeckLinkHost(pi), (e) => e.code === 'DECKLINK_HOST' && /Raspberry Pi/.test(e.message));
  const linux = hostRole({ platform: 'linux', arch: 'x64', model: '' });
  assert.throws(() => assertDeckLinkHost(linux), (e) => e.code === 'DECKLINK_HOST' && /macOS only/.test(e.message));
});

test('decklink-sidecar --device exits 2 on a non-Mac even if a helper path is set', { skip: hostRole().decklinkReceiveAllowed ? 'this host may capture' : false }, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'decklink-sidecar.js'), '--device', '0', '--app', 'http://127.0.0.1:9'], {
    encoding: 'utf8',
    env: { ...process.env, RS6_DECKLINK_RECV: '/tmp/does-not-exist-decklink-recv' },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /macOS only|Raspberry Pi/);
  assert.doesNotMatch(r.stderr, /not built/);
});

test('missing Desktop Video helper names the Mac build, and does not claim a device', () => {
  const msg = missingHelperMessage('/no/such/decklink-recv');
  assert.match(msg, /not built/);
  assert.match(msg, /tools\/native\/decklink-recv/);
  assert.match(msg, /does not link Desktop Video/);
  assert.throws(() => assertHelperPresent('/no/such/decklink-recv'), (e) => e.code === 'DECKLINK_HELPER');
  assert.match(helperPath(), /decklink-recv$/);
});

test('hello extras keep kind decklink and drop anything else', () => {
  assert.deepEqual(helloExtras({ kind: 'decklink', device: '0', mode: 'auto', connection: 'SDI', extra: 'no' }), {
    kind: 'decklink', device: '0', mode: 'auto', connection: 'SDI',
  });
  assert.deepEqual(helloExtras({ kind: 'sidecar' }), {});
});

test('source menu: Desktop Video first, no mock group, NDI only when a sidecar exists', () => {
  const empty = sourceGroups([]);
  assert.equal(empty[0].label, 'Desktop Video');
  assert.match(sourceMenu([]), /Desktop Video/);
  assert.match(sourceMenu([]), /No Desktop Video input/);
  assert.doesNotMatch(sourceMenu([]), /does not create a device/);
  assert.doesNotMatch(sourceMenu([]), /Mock/);
  assert.doesNotMatch(sourceMenu([]), /NDI \(advanced\)/);
  const html = sourceMenu([
    { key: 'ndi:decklink-0', label: 'Desktop Video · DECKLINK 0', kind: 'ndi', via: 'decklink', ok: true },
    { key: 'ndi:side-bars', label: 'NDI · SIDE BARS', kind: 'ndi', via: 'sidecar', ok: true },
    { key: 'cam:cam1', label: 'Cam 1', kind: 'camera', ok: true },
    { key: 'builtin:bars.h264', label: 'Test: bars.h264', kind: 'file', ok: true },
  ]);
  assert.ok(html.indexOf('Desktop Video') < html.indexOf('Cameras'));
  assert.ok(html.indexOf('Cameras') < html.indexOf('Test clips'));
  assert.ok(html.indexOf('Test clips') < html.indexOf('NDI (advanced)'));
  assert.equal(preferLiveSource([{ key: 'a', via: 'sidecar', ok: true }, { key: 'b', via: 'decklink', ok: true }]).key, 'b');
  assert.equal(preferLiveSource([{ key: 'ndi:mock-bars', via: 'mock', ok: true }]), null);
});

test('a decklink hello is listed as Desktop Video; --mock on the server adds no ndi:mock source', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'decklink-ingest-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('app'); });
  const sc = attachScopes(srv, { systems: { drivers: { ptz: { cams: new Map() } } }, dataDir: data, mock: true, testDir: path.join(__dirname, 'fixtures', 'scopes'), log: () => {} });
  t.after(() => sc.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const B = `http://127.0.0.1:${port}`;
  const before = await (await fetch(`${B}/api/scopes/ndi`)).json();
  assert.equal(before.mock, true);
  assert.ok(!before.sources.some((s) => String(s.key).startsWith('ndi:mock-')));

  const cli = await connectIngest({
    app: B, id: 'decklink-0', name: 'DECKLINK 0', fps: 30,
    hello: { kind: 'decklink', device: '0', mode: '1080p5994', connection: 'SDI' },
  });
  t.after(() => cli.close());
  const row = await until(async () => {
    const j = await (await fetch(`${B}/api/scopes/ndi`)).json();
    return j.sources.find((s) => s.key === 'decklink:0' && s.via === 'decklink' && s.ok);
  });
  assert.equal(row.label, 'DECKLINK 0');
  assert.equal(row.kind, 'ndi');

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'tools', 'decklink-sidecar.js'), '--mock', '--app', B,
    '--id', 'side-bars', '--name', 'SIDE BARS', '--file', BARS, '--fps', '50',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGTERM'); } catch { /* */ } });
  const side = await until(async () => {
    const j = await (await fetch(`${B}/api/scopes/ndi`)).json();
    return j.sources.find((s) => s.key === 'ndi:side-bars' && s.via === 'sidecar' && s.ok);
  }, 5000);
  assert.match(side.label, /NDI · SIDE BARS/);
  assert.notEqual(side.via, 'decklink');
});

test('a listed Desktop Video device is an input before capture starts', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'decklink-list-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('app'); });
  const sc = attachScopes(srv, {
    systems: { drivers: { ptz: { cams: new Map() } } },
    dataDir: data,
    log: () => {},
    decklinkList: async () => ({ devices: [{ index: 0, name: 'UltraStudio Replay', connections: 'SDI' }], error: null }),
  });
  t.after(() => sc.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const j = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/scopes/sources`)).json();
  const row = j.sources.find((s) => s.key === 'decklink:0');
  assert.equal(row.label, 'UltraStudio Replay');
  assert.equal(row.via, 'decklink');
  assert.equal(row.ok, true);
  assert.deepEqual(parseList('index\tname\tconnections\tmodes\n0\tUltraStudio Replay\tSDI\t1080p59.94\n'), [{ index: 0, name: 'UltraStudio Replay', connections: 'SDI', modes: '1080p59.94' }]);
});

test('native helper sources are present and do not reference an NDI SDK', () => {
  const dir = path.join(__dirname, '..', 'tools', 'native', 'decklink-recv');
  for (const f of ['main.cc', 'capture.mm', 'capture.h', 'encode.mm', 'encode.h', 'convert.cc', 'convert.h', 'Makefile', 'README.md']) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(text.length > 20, f);
    assert.doesNotMatch(text, /libndi|NDIlib/);
  }
});

test('Makefile refuses to link Desktop Video off macOS', { skip: process.platform === 'darwin' ? 'this host is macOS' : false }, () => {
  const r = spawnSync('make', ['-C', path.join(__dirname, '..', 'tools', 'native', 'decklink-recv')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}\n${r.stdout}`, /macOS only|Desktop Video/);
});

test('ATEM page owns the TSL panel; SYSTEMS does not', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const atem = html.slice(html.indexOf('id="pane-atem"'), html.indexOf('id="pane-arouter"'));
  const system = html.slice(html.indexOf('id="pane-system"'), html.indexOf('id="pane-xpresets"'));
  assert.match(atem, /id="tslPanel"/);
  assert.doesNotMatch(system, /id="tslPanel"/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'tsl.js'), 'utf8'), /ev\.detail === 'atem'/);
});
