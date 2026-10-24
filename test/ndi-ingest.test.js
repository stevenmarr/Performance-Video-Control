'use strict';
// 0.20.0-dev: NDI ingest into the scopes relay (not NDI publish). No NDI hardware.
// The built-in ndi:mock source and the Mac sidecar --mock path both feed the same
// WebSocket the camera RTSP pipe uses. --source is refused on a Pi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { NdiIngest, toAnnexB } = require('../lib/scopes/ndi-ingest');
const { loadFile } = require('../lib/scopes/sources');
const { StreamRelay } = require('../lib/stream-relay');
const { attachScopes } = require('../lib/scopes/service');
const { feedAnnex, flushAnnex, receivePlan, isRaspberryPi } = require('../sidecar/ndi/ndi-sidecar');

const FX = path.join(__dirname, 'fixtures', 'scopes');
const BARS = path.join(FX, 'bars.h264');
const SIDECAR = path.join(__dirname, '..', 'sidecar', 'ndi', 'ndi-sidecar.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(20); }
  throw new Error('timeout');
};

function fakeWs() {
  const ee = new EventEmitter();
  const sent = [];
  return {
    sent, buffered: 0,
    on: ee.on.bind(ee), emit: ee.emit.bind(ee),
    send(d) { sent.push(d); return true; },
    close() {},
  };
}

test('Annex-B push enters the same relay contract as an RTSP access unit', () => {
  const ingest = new NdiIngest();
  const reg = ingest.register({ id: 'cam-a', name: 'CAM A' });
  assert.equal(reg.key, 'ndi:cam-a');
  const hit = ingest.resolve('cam-a');
  const relay = new StreamRelay({ log() {} });
  const ws = fakeWs();
  relay.attach('ndi:cam-a', hit.make, ws, hit.meta);
  const file = loadFile(BARS);
  const pushed = ingest.push('cam-a', toAnnexB(file.aus[0].nals), { pts: 0 });
  assert.equal(pushed.aus, 1);
  const texts = ws.sent.filter((x) => typeof x === 'string').map((x) => JSON.parse(x));
  const cfg = texts.find((m) => m.type === 'config');
  assert.equal(cfg.kind, 'ndi');
  assert.equal(cfg.width, 1280);
  assert.equal(cfg.label, 'NDI · CAM A');
  const bins = ws.sent.filter(Array.isArray);
  assert.ok(bins.length >= 1);
  assert.equal(bins[0][0][1] & 1, 1, 'first picture is a key frame');
  relay.closeAll();
});

test('ingest id rules: mock is reserved when the fixture is mounted, bad ids rejected', () => {
  const ingest = new NdiIngest({ mockFile: BARS });
  assert.equal(ingest.list()[0].key, 'ndi:mock');
  assert.throws(() => ingest.register({ id: 'mock', name: 'x' }), /built-in/);
  assert.throws(() => ingest.register({ id: '../etc', name: 'x' }), /id/);
  assert.throws(() => ingest.push('nope', toAnnexB([Buffer.from([0x65, 1])])), /register/);
  const again = new NdiIngest();
  again.register({ id: 'lab', name: 'Lab' });
  again.register({ id: 'lab', name: 'Lab 2' });
  assert.equal(again.list().length, 1);
  assert.equal(again.list()[0].label, 'NDI · Lab 2');
});

test('Annex-B reassembly across chunks (sidecar stdout)', () => {
  const nals = [Buffer.from([0x67, 1, 2, 3, 4]), Buffer.from([0x65, 9, 8, 7])];
  const blob = toAnnexB(nals);
  const state = { buf: Buffer.alloc(0) };
  const got = [];
  assert.equal(feedAnnex(state, blob.subarray(0, 5), (n) => got.push(n)), 0);
  feedAnnex(state, blob.subarray(5), (n) => got.push(n));
  flushAnnex(state, (n) => got.push(n));
  assert.equal(got.length, 2);
  assert.ok(got[0].equals(nals[0]));
  assert.ok(got[1].equals(nals[1]));
});

test('ffmpeg NDI receive plan is an argv array (no shell) and refuses a build without an NDI demuxer', () => {
  const no = receivePlan({ ffmpeg: 'ffmpeg', demuxers: ' D  h264            raw H.264 video\n', source: 'CAM' });
  assert.equal(no.ok, false);
  assert.match(no.reason, /no NDI demuxer/);
  const yes = receivePlan({
    ffmpeg: '/usr/local/bin/ffmpeg',
    demuxers: ' D  libndi_newtek   NDI input\n',
    source: 'CAM A; rm -rf /',
  });
  assert.equal(yes.ok, true);
  assert.equal(yes.demuxer, 'libndi_newtek');
  const i = yes.argv.indexOf('-i');
  assert.equal(yes.argv[i + 1], 'CAM A; rm -rf /', 'source is one argument, not a shell string');
  assert.equal(yes.argv[0], '/usr/local/bin/ffmpeg');
  assert.ok(yes.argv.includes('pipe:1'));
  assert.equal(receivePlan({ ffmpeg: '', demuxers: '', source: 'CAM' }).ok, false);
});

test('Pi guard: real NDI receive is refused, the built-in detector honours PV_NDI_FORCE_PI', () => {
  const prev = process.env.PV_NDI_FORCE_PI;
  process.env.PV_NDI_FORCE_PI = '1';
  try { assert.equal(isRaspberryPi(), true); }
  finally { if (prev === undefined) delete process.env.PV_NDI_FORCE_PI; else process.env.PV_NDI_FORCE_PI = prev; }
  const r = spawnSync(process.execPath, [SIDECAR, '--source', 'CAM A', '--app', 'http://127.0.0.1:9'], {
    env: { ...process.env, PV_NDI_FORCE_PI: '1' }, encoding: 'utf8',
  });
  assert.equal(r.status, 3);
  assert.match(`${r.stderr}${r.stdout}`, /Raspberry Pi/);
});

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.get(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    req.on('response', (res) => reject(new Error(`HTTP ${res.statusCode}`)));
    req.on('upgrade', (res, sock, head) => {
      const acc = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (res.headers['sec-websocket-accept'] !== acc) return reject(new Error('bad accept'));
      const msgs = []; let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const pull = () => {
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f; let o = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
          if (buf.length < o + len) return;
          const op = buf[0] & 15; const p = buf.subarray(o, o + len); buf = buf.subarray(o + len);
          msgs.push(op === 1 ? JSON.parse(p.toString()) : Buffer.from(p));
        }
      };
      pull();
      sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pull(); });
      resolve({ msgs, close: () => sock.destroy() });
    });
    req.on('error', reject);
  });
}

test('mock app exposes ndi:mock on the scopes WebSocket and does not receive NDI itself', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ndi-mock-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sc = attachScopes(srv, { dataDir: data, mock: true, testDir: FX, log() {} });
  t.after(() => sc.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const B = `http://127.0.0.1:${srv.address().port}`;
  const info = await (await fetch(`${B}/api/scopes/ndi`)).json();
  assert.equal(info.role, 'ingest');
  assert.equal(info.publish, false);
  assert.equal(info.receive, 'mac-sidecar');
  assert.equal(info.piReceive, false);
  assert.ok(info.sources.some((s) => s.key === 'ndi:mock' && s.mock));
  const listed = await (await fetch(`${B}/api/scopes/sources`)).json();
  assert.ok(listed.sources.some((s) => s.key === 'ndi:mock' && s.kind === 'ndi'));
  const w = await wsConnect(`${B}/api/scopes/ws?src=ndi:mock`);
  t.after(() => w.close());
  await until(() => w.msgs.filter(Buffer.isBuffer).length >= 3);
  const cfg = w.msgs.find((m) => m && m.type === 'config');
  assert.equal(cfg.kind, 'ndi');
  assert.equal(cfg.width, 1280);
  assert.equal(cfg.label, 'NDI · Mock bars');
});

test('sidecar --mock pushes frames into a non-mock app (CI without NDI hardware)', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ndi-side-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sc = attachScopes(srv, { dataDir: data, mock: false, log() {} });
  t.after(() => sc.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const B = `http://127.0.0.1:${port}`;
  const before = await (await fetch(`${B}/api/scopes/ndi`)).json();
  assert.equal(before.sources.length, 0, 'no built-in NDI source unless --mock');
  const child = spawn(process.execPath, [SIDECAR, '--mock', '--app', B, '--id', 'lab', '--name', 'Lab feed', '--count', '12', '--pace', '0'], {
    env: { ...process.env, PV_NDI_FORCE_PI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', () => {});
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, err);
  // Viewer joins after the sidecar has finished. The relay replays the GOP the sidecar pushed.
  const w = await wsConnect(`${B}/api/scopes/ws?src=ndi:lab`);
  t.after(() => w.close());
  await until(() => w.msgs.filter(Buffer.isBuffer).length >= 3, 8000);
  const cfg = w.msgs.find((m) => m && m.type === 'config');
  assert.equal(cfg.kind, 'ndi');
  assert.equal(cfg.label, 'NDI · Lab feed');
  assert.equal(cfg.width, 1280);
  const after = await (await fetch(`${B}/api/scopes/ndi`)).json();
  assert.ok(after.sources.find((s) => s.key === 'ndi:lab').frames >= 12);
});

test('Lightning and TSL stay separate surfaces; NDI help is ingest, not publish', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /data-sysview="tallies"/);
  assert.match(html, /id="sysTallies"/);
  assert.match(html, /id="ndiSource"/);
  assert.match(html, /NDI ingest/);
  assert.doesNotMatch(html, /OBS \+ DistroAV/);
  assert.doesNotMatch(html, /lightning-tsl/i);
  assert.doesNotMatch(html, /Future: Mac sidecar/);
  const talliesAt = html.indexOf('id="sysTallies"');
  const lightningAt = html.indexOf('id="pane-lightning"');
  const tslAt = html.indexOf('id="tslPanel"');
  assert.ok(tslAt > talliesAt && tslAt < lightningAt, 'TSL panel lives in the TALLIES view, not inside Lightning');
  const pkg = require('../package.json');
  assert.equal(pkg.version, '0.20.0-dev');
  assert.equal(pkg.dependencies && Object.keys(pkg.dependencies).length, 0);
});
