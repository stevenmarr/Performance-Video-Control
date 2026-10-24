'use strict';
// 0.12.0 scopes, server side: H.264 parsing (NAL / SPS / access units / avcC / MP4), RTP (de)packetizing, the RTSP client
// against the mock UE150 RTSP camera (Digest auth), the relay's fan-out / GOP cache / slow-viewer rules, the WebSocket
// endpoint and the scopes settings API. No network beyond 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const H = require('../lib/scopes/h264');
const { H264Depacketizer, packetize, parseRtp } = require('../lib/scopes/rtp');
const { RtspClient, parseUrl, parseSdp } = require('../lib/scopes/rtsp-client');
const { MockRtspCamera } = require('../lib/mocks/rtsp-camera');
const { StreamRelay, HDR } = require('../lib/stream-relay');
const { loadFile, FileInput, RtspInput } = require('../lib/scopes/sources');
const { attachScopes } = require('../lib/scopes/service');
const SM = require('../public/scopes-gl.js');

const FX = path.join(__dirname, 'fixtures', 'scopes');
const BARS = path.join(FX, 'bars.h264');
const nal = (type, ...bytes) => Buffer.from([0x60 | type, ...bytes]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(20); } throw new Error('timeout'); };

test('splitAnnexB: 3- and 4-byte start codes, trailing zero bytes, emulation prevention removal', () => {
  const b = Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 0, 1, 0x65, 4, 5, 0, 0]);
  const n = H.splitAnnexB(b);
  assert.deepEqual(n.map((x) => [...x]), [[0x67, 1, 2], [0x68, 3], [0x65, 4, 5]]);
  assert.deepEqual([...H.unescapeRbsp(Buffer.from([0x67, 0, 0, 3, 1, 0, 0, 3, 0, 9]))], [0x67, 0, 0, 1, 0, 0, 0, 9]);
});

test('parseSps: size + cropping, profile / level, VUI range, colour description, frame rate', () => {
  const sps = (f) => H.splitAnnexB(fs.readFileSync(f)).find((x) => H.nalType(x) === H.NAL.SPS);
  const a = H.parseSps(sps(BARS));
  assert.equal(a.profileIdc, 100); assert.equal(a.levelIdc, 31); assert.equal(a.width, 1280); assert.equal(a.height, 720);
  assert.equal(a.fullRange, false); assert.deepEqual(a.colour, { primaries: 1, transfer: 1, matrix: 1 }); assert.equal(a.fps, 30);
  assert.equal(H.codecString(sps(BARS)), 'avc1.64001f');
  const m = H.parseSps(sps(path.join(FX, 'moving-360.h264'))); // 23 macroblock rows = 368, cropped to 360
  assert.equal(m.codedHeight, 368); assert.equal(m.height, 360); assert.equal(m.width, 640);
  // a full-range SPS (x264 range=pc) with an emulation-prevention byte inside
  const full = Buffer.from('6764001facb402802dd370101014000003000400000300f23c60ca80', 'hex');
  const f = H.parseSps(full); assert.equal(f.fullRange, true); assert.equal(f.width, 1280); assert.equal(f.fps, 30);
  assert.throws(() => H.parseSps(nal(8, 1)), /not an SPS/);
});

test('access units: one picture per AU with multi-slice pictures, key frames, AUD / SPS / SEI start a new AU', () => {
  const aus = H.splitAccessUnits(H.splitAnnexB(fs.readFileSync(BARS)));
  assert.equal(aus.length, 180); assert.equal(aus.filter((a) => a.key).length, 6); // 6 s at 30 p, 1 s GOP
  assert.ok(aus[0].key && aus[0].sps && aus[0].pps, 'first AU: IDR with SPS / PPS in band');
  assert.ok(aus.every((a) => a.nals.filter((n) => H.isVcl(H.nalType(n))).length === 8), 'x264 sliced threads: 8 slices, all in one AU');
  // synthetic: [AUD SPS PPS IDR(first_mb=0) IDR(first_mb≠0)] [AUD P] [SEI P] [P(first_mb=0)]
  const s = [nal(9, 0x10), nal(7, 0x64, 0, 0x1f), nal(8, 0xee), Buffer.from([0x65, 0x88]), Buffer.from([0x65, 0x40]), nal(9, 0x30), Buffer.from([0x41, 0x9a]), nal(6, 5), Buffer.from([0x41, 0x9b]), Buffer.from([0x41, 0x9c])];
  const out = H.splitAccessUnits(s);
  assert.deepEqual(out.map((a) => a.nals.length), [5, 2, 2, 1]);
  assert.deepEqual(out.map((a) => a.key), [true, false, false, false]);
});

test('avcC + AVCC framing (what WebCodecs / MSE get)', () => {
  const sps = Buffer.from('6764001facb402802dd370101014000003000400000300f23c60ca80', 'hex'); const pps = Buffer.from([0x68, 0xee, 0x3c, 0xb0]);
  const c = H.avcC(sps, pps);
  assert.deepEqual([...c.subarray(0, 6)], [1, 0x64, 0x00, 0x1f, 0xff, 0xe1]);
  assert.equal(c.readUInt16BE(6), sps.length); assert.ok(c.subarray(8, 8 + sps.length).equals(sps));
  assert.equal(c[8 + sps.length], 1); assert.equal(c.readUInt16BE(9 + sps.length), pps.length);
  assert.deepEqual([...c.subarray(c.length - 4)], [0xfd, 0xf8, 0xf8, 0], 'High profile: chroma 4:2:0, 8-bit');
  const a = H.toAvcc([Buffer.from([0x65, 1, 2]), Buffer.from([0x06, 9])]);
  assert.deepEqual([...a], [0, 0, 0, 3, 0x65, 1, 2, 0, 0, 0, 2, 0x06, 9]);
});

test('MP4 demux (non-fragmented, avc1) matches the Annex-B stream', () => {
  const m = H.demuxMp4(fs.readFileSync(path.join(FX, 'bars.mp4')));
  assert.equal(m.aus.length, 180); assert.equal(m.fps, 30); assert.equal(m.aus.filter((a) => a.key).length, 6);
  const raw = H.splitAccessUnits(H.splitAnnexB(fs.readFileSync(BARS)));
  const vcl = (a) => Buffer.concat(a.nals.filter((n) => H.isVcl(H.nalType(n))));
  assert.ok(vcl(m.aus[37]).equals(vcl(raw[37])), 'same slice data');
  const f = loadFile(path.join(FX, 'bars.mp4')); assert.equal(f.info.width, 1280); assert.ok(f.aus[0].key && f.aus[0].sps);
  assert.throws(() => H.demuxMp4(Buffer.from('0000000866726565', 'hex')), /no moov/);
});

test('RTP: packetize (single NAL + FU-A) -> depacketize round trip; STAP-A; loss marks the AU broken; 32-bit timestamp wrap', () => {
  const aus = H.splitAccessUnits(H.splitAnnexB(fs.readFileSync(BARS))).slice(0, 40);
  const got = []; const d = new H264Depacketizer((a) => got.push(a)); let seq = 65530; let ts = 0xffffff00;
  let fu = 0;
  for (const a of aus) { const p = packetize(a.nals, { seq, ts, mtu: 300 }); seq = p.seq; ts = (ts + 3000) >>> 0; for (const x of p.packets) { if ((x[12] & 0x1f) === 28) fu++; d.push(x); } }
  assert.ok(fu > 0, 'large slices went out as FU-A');
  assert.equal(got.length, aus.length);
  got.forEach((a, i) => assert.ok(Buffer.concat(a.nals).equals(Buffer.concat(aus[i].nals)), `AU ${i}`));
  assert.equal(got[39].pts, Math.round((39 * 3000 * 1e6) / 90000), 'pts unwraps across 2^32');
  assert.equal(got.filter((a) => a.key).length, 2);
  // STAP-A with SPS + PPS, then a single-NAL IDR with the marker
  const out = []; const d2 = new H264Depacketizer((a) => out.push(a));
  const rtp = (seqn, marker, payload) => { const h = Buffer.alloc(12); h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | 96; h.writeUInt16BE(seqn, 2); h.writeUInt32BE(1000, 4); return Buffer.concat([h, payload]); };
  const sps = nal(7, 0x64, 0, 0x1f); const pps = nal(8, 0xee);
  d2.push(rtp(1, false, Buffer.concat([Buffer.from([24, 0, sps.length]), sps, Buffer.from([0, pps.length]), pps])));
  d2.push(rtp(2, true, Buffer.from([0x65, 0x88, 1, 2])));
  assert.equal(out.length, 1); assert.deepEqual(out[0].nals.map(H.nalType), [7, 8, 5]); assert.ok(out[0].key && !out[0].broken);
  // a lost packet in the middle of a FU-A: that AU is flagged broken (the relay then waits for the next IDR)
  const big = Buffer.alloc(4000, 7); big[0] = 0x65; big[1] = 0x88; const p = packetize([big], { seq: 10, ts: 5 }).packets;
  const out3 = []; const d3 = new H264Depacketizer((a) => out3.push(a)); d3.push(p[0]); d3.push(p[2]);
  d3.push(packetize([Buffer.from([0x41, 0x9a, 1])], { seq: 13, ts: 3005 }).packets[0]);
  assert.equal(d3.lost, 1); assert.equal(out3.length, 1); assert.equal(out3[0].broken, true, 'the next AU is flagged');
  assert.equal(parseRtp(Buffer.from([0x40, 0])), null, 'not RTP v2');
});

test('RTSP URL / SDP parsing (UE150-style SDP, sprop-parameter-sets, relative control)', () => {
  assert.deepEqual(parseUrl('rtsp://admin:12345@10.0.0.9/MediaInput/h264/stream_1'), { user: 'admin', pass: '12345', host: '10.0.0.9', port: 554, path: '/MediaInput/h264/stream_1', clean: 'rtsp://10.0.0.9/MediaInput/h264/stream_1' });
  assert.equal(parseUrl('rtsp://cam:8554/x').port, 8554);
  const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=64001f;sprop-parameter-sets=Z2QAH6w=,aO48sA==\r\na=control:trackID=1\r\n';
  const s = parseSdp(sdp, 'rtsp://cam/MediaInput/h264/stream_1/');
  assert.equal(s.controlUrl, 'rtsp://cam/MediaInput/h264/stream_1/trackID=1'); assert.equal(s.packetizationMode, 1);
  assert.deepEqual([...s.sps], [0x67, 0x64, 0, 0x1f, 0xac]); assert.deepEqual([...s.pps], [0x68, 0xee, 0x3c, 0xb0]);
  assert.match(parseSdp('m=video 0 RTP/AVP 97\r\na=rtpmap:97 H265/90000\r\n', 'rtsp://x/').codecError, /H\.265/);
});

test('RTSP client <-> mock UE150 camera: Digest login, interleaved RTP, access units; wrong password and wrong path fail cleanly', async (t) => {
  const cam = new MockRtspCamera({ streams: { '/MediaInput/h264/stream_1': BARS } }); const port = await cam.start(0); t.after(() => cam.stop());
  const url = `rtsp://127.0.0.1:${port}/MediaInput/h264/stream_1`;
  const aus = []; let sdp = null; const c = new RtspClient(url, { user: 'admin', pass: '12345' });
  const dep = new H264Depacketizer((a) => aus.push(a));
  c.on('sdp', (s) => { sdp = s; }); c.on('rtp', (p) => dep.push(p)); c.on('error', () => {});
  c.start(); t.after(() => c.stop());
  await until(() => aus.filter((a) => a.key).length >= 1 && aus.length >= 10, 6000);
  assert.ok(sdp.sps && sdp.pps); assert.equal(H.parseSps(sdp.sps).width, 1280);
  assert.ok(cam.history.some((h) => h.method === 'DESCRIBE') && cam.history.some((h) => h.method === 'PLAY'));
  assert.ok(aus.every((a) => !a.broken)); assert.equal(dep.lost, 0);
  const pts = aus.map((a) => a.pts); assert.ok(pts.every((v, i) => !i || v > pts[i - 1]), 'monotonic pts');
  const fail = (u, o) => new Promise((res) => { const x = new RtspClient(u, o); x.on('error', (e) => { x.stop(); res(e); }); x.start(); });
  const e1 = await fail(url, { user: 'admin', pass: 'wrong' }); assert.match(e1.message, /401/); assert.equal(e1.auth, true);
  const e2 = await fail(`rtsp://127.0.0.1:${port}/MediaInput/h264/stream_4`, { user: 'admin', pass: '12345' }); assert.match(e2.message, /404/);
  const e3 = await fail(url, {}); assert.match(e3.message, /user name and password/);
});

class FakeWs { constructor() { this.out = []; this.buffered = 0; this.h = {}; } send(d) { this.out.push(Array.isArray(d) ? Buffer.concat(d) : d); return true; } on(e, f) { this.h[e] = f; } close() { if (this.h.close) this.h.close(); } }
const binaries = (ws) => ws.out.filter((x) => Buffer.isBuffer(x));
const texts = (ws) => ws.out.filter((x) => typeof x === 'string').map((x) => JSON.parse(x));

test('relay: config before pictures, starts at an IDR, GOP replay for a late viewer, slow viewer skips to the next IDR, stops without viewers', async () => {
  const { EventEmitter } = require('events');
  const input = new EventEmitter(); input.start = () => {}; let stopped = false; input.stop = () => { stopped = true; };
  const relay = new StreamRelay({ lingerMs: 30, maxBuffered: 1000 });
  const a = new FakeWs(); relay.attach('k', () => input, a, { label: 'test' });
  const aus = H.splitAccessUnits(H.splitAnnexB(fs.readFileSync(BARS)));
  input.emit('au', { ...aus[5], pts: 1 }); // before SPS/PPS: dropped
  assert.equal(binaries(a).length, 0);
  input.emit('params', { sps: aus[0].sps, pps: aus[0].pps });
  const cfg = texts(a).find((m) => m.type === 'config'); assert.equal(cfg.codec, 'avc1.64001f'); assert.equal(cfg.width, 1280); assert.equal(cfg.fullRange, false);
  assert.ok(H.avcC(aus[0].sps, aus[0].pps).equals(Buffer.from(cfg.description, 'base64')));
  for (let i = 1; i < 30; i++) input.emit('au', { ...aus[i], pts: i * 33333 }); // mid-GOP: nothing until an IDR
  assert.equal(binaries(a).length, 0);
  for (let i = 30; i < 40; i++) input.emit('au', { ...aus[i], pts: i * 33333 });
  const bin = binaries(a); assert.equal(bin.length, 10); assert.equal(bin[0][0], 1); assert.equal(bin[0][1] & 1, 1, 'first sent AU is the IDR');
  assert.equal(bin[1][1] & 1, 0); assert.equal(bin[3].readDoubleLE(12), 33 * 33333);
  // payload = AVCC without SPS / PPS / AUD
  const pl = bin[0].subarray(HDR); let o = 0; const types = []; while (o < pl.length) { const l = pl.readUInt32BE(o); types.push(pl[o + 4] & 0x1f); o += 4 + l; }
  assert.ok(!types.includes(7) && !types.includes(8) && types.includes(5));
  // a late viewer gets config + the GOP so far at once (catch-up flags on all but the last)
  const b = new FakeWs(); relay.attach('k', () => input, b, {});
  const rb = binaries(b); assert.equal(rb.length, 10); assert.ok(rb.every((x) => x[1] & 4), 'replayed'); assert.ok(rb.slice(0, -1).every((x) => x[1] & 2) && !(rb[9][1] & 2));
  // slow viewer: its socket backlog is over the limit -> skipped until the next IDR
  b.buffered = 5000; input.emit('au', { ...aus[40], pts: 1 }); b.buffered = 0; input.emit('au', { ...aus[41], pts: 2 });
  assert.equal(binaries(b).length, 10, 'nothing more until an IDR');
  for (let i = 42; i < 61; i++) input.emit('au', { ...aus[i], pts: i });
  assert.equal(binaries(b)[10][1] & 1, 1, 'resumed on the IDR at frame 60');
  // a broken AU (lost packets): everyone waits for the next IDR
  const before = binaries(a).length; input.emit('au', { ...aus[61], broken: true }); input.emit('au', { ...aus[62] });
  assert.equal(binaries(a).length, before);
  assert.equal(relay.stats()[0].viewers, 2);
  a.close(); b.close(); await wait(60); assert.ok(stopped, 'input stopped after the last viewer left'); assert.equal(relay.stats().length, 0);
});

test('FileInput paces at the stream frame rate and loops; RtspInput reconnects after the camera goes away', async (t) => {
  const f = new FileInput(BARS); const got = []; f.on('au', (a) => got.push(a)); let params = null; f.on('params', (p) => { params = p; });
  f.start(); await wait(520); f.stop();
  assert.ok(params && params.sps); assert.ok(got.length >= 13 && got.length <= 18, `~30 fps (${got.length} in 0.5 s)`); assert.ok(got[0].key);
  const cam = new MockRtspCamera({ streams: { '/MediaInput/h264/stream_2': BARS } }); const port = await cam.start(0);
  const r = new RtspInput(`rtsp://127.0.0.1:${port}/MediaInput/h264/stream_2`, { user: 'admin', pass: '12345', retryMs: 100 });
  const st = []; let n = 0; r.on('status', (s) => st.push(s.state)); r.on('au', () => n++); r.start(); t.after(() => r.stop());
  await until(() => n > 5);
  for (const s of cam.sessions) s.sock.destroy(); await cam.stop();
  await until(() => st.includes('error'));
  const cam2 = new MockRtspCamera({ streams: { '/MediaInput/h264/stream_2': BARS } }); await cam2.start(port); t.after(() => cam2.stop());
  const n0 = n; await until(() => n > n0 + 5, 8000);
  assert.ok(st.filter((s) => s === 'playing').length >= 2, 'reconnected');
});

// minimal WebSocket client (masked frames) for the endpoint test
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.get(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    req.on('response', (res) => reject(new Error(`HTTP ${res.statusCode}`)));
    req.on('upgrade', (res, sock, head) => {
      const acc = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (res.headers['sec-websocket-accept'] !== acc) return reject(new Error('bad accept'));
      const msgs = []; let buf = head;
      sock.on('data', (d) => { buf = Buffer.concat([buf, d]); for (;;) { if (buf.length < 2) break; let len = buf[1] & 0x7f; let o = 2; if (len === 126) { len = buf.readUInt16BE(2); o = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); o = 10; } if (buf.length < o + len) break; const op = buf[0] & 15; const p = buf.subarray(o, o + len); buf = buf.subarray(o + len); msgs.push(op === 1 ? JSON.parse(p.toString()) : Buffer.from(p)); } });
      const send = (obj) => { const p = Buffer.from(JSON.stringify(obj)); const m = crypto.randomBytes(4); const x = Buffer.from(p); for (let i = 0; i < x.length; i++) x[i] ^= m[i & 3]; sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | x.length]), m, x])); };
      resolve({ msgs, send, close: () => sock.destroy() });
    });
    req.on('error', reject);
  });
}

test('scopes service: sources, settings (passwords never returned), WebSocket relay from a test file and from the mock camera', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6scopes-')); t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const { EventEmitter } = require('events');
  const systems = { drivers: { ptz: { cams: new Map([['cam1', { conf: { name: 'Cam 1', host: '127.0.0.1' }, st: { series: 'UE150', data: { model: 'AW-UE150' } } }], ['cam3', { conf: { name: 'Lectern', host: '10.255.255.1' }, st: { series: 'AW-HE130', data: {} } }]]),
    // the camera's own request URIs (/cgi-bin/get_rtsp) win over the default path
    asked: [], async streamInfo(id) { this.asked.push(id); return { streams: [{ name: 'H264 STREAM 2', url: 'rtsp://127.0.0.1/MEDIAINPUT/H264/STREAM_2' }] }; } } } };
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('app'); });
  const sc = attachScopes(srv, { systems, dataDir: data, mock: true, testDir: FX, log: () => {} }); t.after(() => sc.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const B = `http://127.0.0.1:${srv.address().port}`;
  assert.equal(await (await fetch(`${B}/other`)).text(), 'app', 'the app handler still answers');
  await sc.mockCamera.ready;
  const s = await (await fetch(`${B}/api/scopes/sources`)).json();
  assert.ok(s.sources.some((x) => x.key === 'builtin:bars.h264')); assert.ok(s.sources.some((x) => x.key === 'test:ramps.h264'));
  const c1 = s.sources.find((x) => x.key === 'cam:cam1'); assert.ok(c1.ok); assert.match(c1.detail, /^rtsp:\/\/127\.0\.0\.1:\d+\/MediaInput\/h264\/stream_1$/);
  assert.equal(s.sources.find((x) => x.key === 'cam:cam3').ok, false, 'HE130: no RTSP');
  assert.equal(s.settings.cameraDefaults.user, 'admin'); assert.ok(!JSON.stringify(s).includes('12345'), 'no password in the API');
  // settings: stream 2, a password (write-only), custom input validation
  let r = await (await fetch(`${B}/api/scopes/settings`, { method: 'POST', body: JSON.stringify({ cameras: { cam1: { stream: 2, password: 'secret-x' } }, custom: '/tmp/a.h264' }) })).json();
  assert.equal(r.cameras.cam1.stream, 2); assert.equal(r.cameras.cam1.hasPassword, true); assert.ok(!JSON.stringify(r).includes('secret-x'));
  assert.match(r.cameras.cam1.url, /stream_2$/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(data, 'scopes.json'), 'utf8')).cameras.cam1.password === 'secret-x', 'kept in the data folder only');
  r = await (await fetch(`${B}/api/scopes/settings`, { method: 'POST', body: JSON.stringify({ custom: '/etc/passwd' }) })); assert.equal(r.status, 400);
  // WS from a test file
  const w = await wsConnect(`${B}/api/scopes/ws?src=builtin:bars.h264`); t.after(() => w.close());
  await until(() => w.msgs.filter(Buffer.isBuffer).length >= 5);
  const cfg = w.msgs.find((m) => m.type === 'config'); assert.equal(cfg.codec, 'avc1.64001f'); assert.equal(cfg.kind, 'file');
  const firstBin = w.msgs.find(Buffer.isBuffer); assert.equal(firstBin[1] & 1, 1, 'first picture is an IDR');
  w.send({ type: 'ping', t: 123 }); await until(() => w.msgs.some((m) => m.type === 'pong')); assert.equal(w.msgs.find((m) => m.type === 'pong').t, 123);
  // WS from the mock camera: stream 2 needs the factory login -> wrong password set above -> error, then fix it
  const w2 = await wsConnect(`${B}/api/scopes/ws?src=cam:cam1`); t.after(() => w2.close());
  await until(() => w2.msgs.some((m) => m.type === 'status' && m.state === 'error'));
  assert.ok(w2.msgs.find((m) => m.state === 'error').auth, 'reported as a login problem');
  // fixing the login restarts the running relay: the open viewer gets pictures without reconnecting
  await fetch(`${B}/api/scopes/settings`, { method: 'POST', body: JSON.stringify({ cameras: { cam1: { password: '12345' } } }) });
  await until(() => w2.msgs.filter(Buffer.isBuffer).length >= 5, 8000);
  assert.equal(w2.msgs.find((m) => m.type === 'config').width, 1280);
  assert.ok(systems.drivers.ptz.asked.includes('cam1')); assert.ok(w2.msgs.some((m) => m.type === 'status' && /\/MEDIAINPUT\/H264\/STREAM_2$/.test(m.url || '')), 'connects to the URI the camera reports');
  const w3 = await wsConnect(`${B}/api/scopes/ws?src=cam:cam1`); t.after(() => w3.close());
  await until(() => w3.msgs.filter(Buffer.isBuffer).length >= 5, 8000);
  assert.equal(w3.msgs.find((m) => m.type === 'config').width, 1280);
  const st = await (await fetch(`${B}/api/scopes/status`)).json(); assert.ok(st.relays.some((x) => x.key === 'cam:cam1' && x.viewers === 2));
  // unknown source: plain HTTP error, no upgrade
  await assert.rejects(wsConnect(`${B}/api/scopes/ws?src=nope`), /HTTP 404|socket hang up|ECONNRESET/);
});

test('scope maths: false-colour bands, BT.709 levels, vectorscope targets', () => {
  const band = (p) => (SM.falseColorOf(p) || { name: 'GREY' }).name;
  assert.deepEqual([0, 1, 3.2, 10, 40, 50, 54, 70, 98, 100, 109].map(band), ['PURPLE', 'PURPLE', 'BLUE', 'GREY', 'GREEN', 'GREY', 'PINK', 'GREY', 'YELLOW', 'RED', 'RED']);
  assert.equal(SM.levelOf(16, false), 0); assert.equal(SM.levelOf(235, false), 100); assert.equal(SM.levelOf(255, true), 100);
  const g = SM.ycbcrOf(0, 0.75, 0, false); assert.ok(Math.abs(SM.levelOf(g[0], false) - 53.64) < 0.01, '75 % green = 53.6 % (pink band)');
  const t = SM.targets(); const r100 = t.find((x) => x.name === 'R' && x.amp === 1);
  assert.ok(Math.abs(r100.pr - 0.5) < 1e-9 && Math.abs(r100.pb + 0.1146) < 1e-3);
  const ang = (Math.atan2(r100.pr, r100.pb) * 180) / Math.PI; assert.ok(ang > 100 && ang < SM.SKIN_ANGLE, 'skin line sits between R and YL');
});
