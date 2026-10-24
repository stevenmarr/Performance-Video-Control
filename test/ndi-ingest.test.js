'use strict';
// 0.20.0 Lightning NDI ingest: mock fixtures through the scopes relay, sidecar push of Annex-B
// H.264 into the same path, and the Mac-only / not-on-Pi receive gate. No NDI hardware.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const H = require('../lib/scopes/h264');
const { AnnexBStream } = require('../lib/scopes/ndi-ingest');
const { hostRole, isLoopbackAddress, ingestAllowed, assertReceiveHost } = require('../lib/ndi/host');
const { slug } = require('../tools/ndi-sidecar');
const { attachScopes } = require('../lib/scopes/service');

const BARS = path.join(__dirname, 'fixtures', 'scopes', 'bars.h264');
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.get(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    req.on('response', (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 180)}`))); });
    req.on('upgrade', (res, sock, head) => {
      const msgs = []; let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break; let len = buf[1] & 0x7f; let o = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); o = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); o = 10; }
          if (buf.length < o + len) break;
          const op = buf[0] & 15; const p = buf.subarray(o, o + len); buf = buf.subarray(o + len);
          if (op === 1) msgs.push(JSON.parse(p.toString())); else if (op === 2) msgs.push(Buffer.from(p));
        }
      });
      resolve({ msgs, close: () => sock.destroy() });
    });
    req.on('error', reject);
  });
}

test('NDI host role: receive is macOS sidecar only, never in-process, never a Pi', () => {
  const mac = hostRole({ platform: 'darwin', arch: 'arm64', model: '' });
  assert.equal(mac.receive, 'sidecar'); assert.equal(mac.inProcess, false); assert.equal(mac.ndiReceiveAllowed, true);
  assert.doesNotThrow(() => assertReceiveHost(mac));
  const pi = hostRole({ platform: 'linux', arch: 'aarch64', model: 'Raspberry Pi 5 Model B Rev 1.0' });
  assert.equal(pi.pi, true); assert.equal(pi.ndiReceiveAllowed, false);
  assert.throws(() => assertReceiveHost(pi), /Raspberry Pi/);
  const linux = hostRole({ platform: 'linux', arch: 'x64', model: '' });
  assert.equal(linux.pi, false); assert.equal(linux.ndiReceiveAllowed, false);
  assert.throws(() => assertReceiveHost(linux), /macOS only/);
  assert.equal(hostRole({ platform: 'darwin', arch: 'arm64', model: 'Raspberry Pi 5' }).ndiReceiveAllowed, false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(ingestAllowed('10.1.1.1', { allowLan: false }), false);
  assert.equal(ingestAllowed('10.1.1.1', { allowLan: true }), true);
  assert.equal(ingestAllowed('127.0.0.1', {}), true);
  assert.equal(slug('CAM A (Host)'), 'cam-a-host');
  assert.equal(slug('mock-bars'), 'src-bars');
});

test('Annex-B stream reassembles NALs split across arbitrary chunks', () => {
  const buf = fs.readFileSync(BARS);
  const expect = H.splitAnnexB(buf).map((n) => Buffer.from(n));
  const got = [];
  const stream = new AnnexBStream((n) => got.push(n));
  for (let i = 0; i < buf.length; i += 17) stream.push(buf.subarray(i, Math.min(buf.length, i + 17)));
  stream.end();
  assert.equal(got.length, expect.length);
  assert.ok(got.every((n, i) => n.equals(expect[i])));
});

test('sidecar --ndi is refused on this host (no receive, no ffmpeg spawn)', { skip: hostRole().ndiReceiveAllowed ? 'this host is allowed to receive NDI' : false }, () => {
  const r = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'ndi-sidecar.js'), '--ndi', 'SOME SOURCE', '--app', 'http://127.0.0.1:9'], { encoding: 'utf8' });
  return new Promise((resolve, reject) => {
    let err = ''; r.stderr.on('data', (d) => { err += d; });
    r.on('close', (code) => {
      try {
        assert.equal(code, 2);
        assert.match(err, /macOS only|Raspberry Pi/);
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test('scopes: --mock does not invent NDI fixtures; a sidecar push still shares the relay', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ndi-ingest-')); t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const systems = { drivers: { ptz: { cams: new Map() } } };
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('app'); });
  const sc = attachScopes(srv, { systems, dataDir: data, mock: true, testDir: path.join(__dirname, 'fixtures', 'scopes'), log: () => {} });
  t.after(() => sc.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const port = srv.address().port; const B = `http://127.0.0.1:${port}`;

  const listed = await (await fetch(`${B}/api/scopes/ndi`)).json();
  assert.equal(listed.receive, 'sidecar'); assert.equal(listed.inProcess, false); assert.equal(listed.mock, true);
  assert.equal(listed.ingest, 'loopback');
  assert.ok(!listed.sources.some((s) => String(s.key || '').startsWith('ndi:mock-')), 'no in-process NDI fixtures');
  assert.ok(!listed.sources.some((s) => s.via === 'mock'));

  await assert.rejects(wsConnect(`${B}/api/scopes/ws?src=ndi:mock-bars`), /HTTP 404|no NDI source|ECONNRESET|socket hang up/);
  await assert.rejects(wsConnect(`${B}/api/scopes/ndi/ingest?id=mock-bars&name=nope`), /HTTP 400|bad NDI|ECONNRESET|socket hang up/);
  await assert.rejects(wsConnect(`${B}/api/scopes/ndi/ingest?id=Bad_ID&name=nope`), /HTTP 400|bad NDI|ECONNRESET|socket hang up/);

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'tools', 'ndi-sidecar.js'), '--mock', '--app', B,
    '--id', 'side-bars', '--name', 'SIDE BARS', '--file', BARS, '--fps', '50',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let sideErr = ''; child.stderr.on('data', (d) => { sideErr += d; }); child.stdout.on('data', () => {});
  t.after(() => { try { child.kill('SIGTERM'); } catch { /* */ } });
  await until(async () => {
    const j = await (await fetch(`${B}/api/scopes/ndi`)).json();
    return j.sources.some((s) => s.key === 'ndi:side-bars' && s.via === 'sidecar' && s.ok);
  }, 5000);
  const live = await wsConnect(`${B}/api/scopes/ws?src=ndi:side-bars`); t.after(() => live.close());
  await until(() => live.msgs.filter(Buffer.isBuffer).length >= 3, 5000);
  const liveCfg = live.msgs.find((m) => m && m.type === 'config');
  assert.equal(liveCfg.kind, 'ndi'); assert.match(liveCfg.label, /SIDE BARS/);
  assert.equal(sideErr, '');
});
