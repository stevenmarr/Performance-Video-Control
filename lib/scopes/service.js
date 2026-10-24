'use strict';
// 0.12.0 scopes service: settings, source list, the stream relay's WebSocket endpoint and, in --mock, a mock RTSP camera.
// Mounted onto the app's HTTP server by attachScopes() without touching lib/server.js:
//   GET  /api/scopes/sources    {sources:[{key,label,kind,detail,ok,note}], settings (passwords never returned), mock}
//   POST /api/scopes/settings   {testDir?, custom?, customUser?, customPassword?, cameras?: {<camId>: {stream, path, port, user, password}}}
//   GET  /api/scopes/status     relay statistics per running source
//   WS   /api/scopes/ws?src=<key>   the H.264 relay (lib/stream-relay.js protocol)
// Source keys: builtin:<file> (test/fixtures/scopes), test:<file> (the test folder), cam:<id> (a PTZ camera's RTSP
// stream), custom (a file path or rtsp:// URL from the settings: "plug in your own test video"),
// ndi:<id> (Mac sidecar H.264 ingest, or an in-process mock fixture when the app is in --mock).
// NDI is receive-only here: the process never opens an NDI source. See docs/ndi-ingest.md.
const fs = require('fs');
const path = require('path');
const { StreamRelay } = require('../stream-relay');
const { FileInput, RtspInput, FILE_EXT } = require('./sources');
const { NdiHub, NdiPushInput } = require('./ndi-ingest');
const { hostRole, ingestAllowed, isNdiId, cleanNdiName } = require('../ndi/host');
const ws = require('./ws');

// Panasonic factory default login; every camera's own login is a setting (scopes.json in the data folder)
const CAMERA_DEFAULTS = { stream: 1, path: '', port: 554, user: 'admin', password: '12345' };
const UE150_PATH = (n) => `/MediaInput/h264/stream_${n}`; // Panasonic Integrated Camera Interface spec 12.1 / get_rtsp

function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }

function attachScopes(server, { systems = null, dataDir, appDir = path.join(__dirname, '..', '..'), mock = false, log = () => {}, testDir, tls = null } = {}) {
  const file = dataDir ? path.join(dataDir, 'scopes.json') : null;
  const cfg = { testDir: '', custom: '', customUser: '', customPassword: '', cameras: {}, ...(file ? readJson(file, {}) : {}) };
  const save = () => { if (!file) return; const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2)); fs.renameSync(tmp, file); };
  const builtinDir = path.join(appDir, 'test', 'fixtures', 'scopes'); // small committed clips (bars, ramps, moving)
  const defaultTestDir = testDir || process.env.RS6_SCOPES_TEST_DIR || path.join(appDir, '..', 'scopes-test');
  const testFolder = () => cfg.testDir || defaultTestDir;
  const relay = new StreamRelay({ log });
  const hub = new NdiHub();
  const allowLan = !!(process.env.RS6_NDI_INGEST_LAN === '1');
  const role = hostRole();
  const mockCam = { server: null, port: 0, ready: null };
  const MOCK_NDI = [
    { id: 'mock-bars', file: 'bars.h264', label: 'NDI · MOCK BARS' },
    { id: 'mock-ramps', file: 'ramps.h264', label: 'NDI · MOCK RAMPS' },
  ];
  const mockNdi = () => {
    if (!mock) return [];
    const out = [];
    for (const d of MOCK_NDI) {
      const f = [builtinDir, testFolder()].map((dir) => path.join(dir, d.file)).find((p) => fs.existsSync(p));
      if (f) out.push({ id: d.id, label: d.label, file: f });
    }
    return out;
  };
  const ndiStatus = () => ({
    receive: 'sidecar', inProcess: false, pi: role.pi, platform: role.platform,
    ndiReceiveAllowed: role.ndiReceiveAllowed, ingest: allowLan ? 'lan' : 'loopback',
    sidecar: hub.list().filter((s) => s.connected).length,
  });
  const overrides = {}; // camId -> {host, port} (mock mode: the mock RTSP camera)

  if (mock) {
    const { MockRtspCamera } = require('../mocks/rtsp-camera');
    const pick = (names) => { for (const n of names) for (const d of [testFolder(), builtinDir]) { const f = path.join(d, n); if (fs.existsSync(f)) return f; } return null; };
    const s1 = pick(['moving.h264', 'moving-360.h264']); const s2 = pick(['bars.h264']);
    const streams = {}; if (s1) streams[UE150_PATH(1)] = s1; if (s2) streams[UE150_PATH(2)] = s2;
    const m = new MockRtspCamera({ streams });
    mockCam.server = m;
    mockCam.ready = m.start(0).then((port) => { mockCam.port = port; log('info', `MOCK RTSP camera rtsp://127.0.0.1:${port}${UE150_PATH(1)} (admin / 12345)`); return port; });
  }

  const listDir = (d) => { try { return fs.readdirSync(d).filter((f) => FILE_EXT.test(f)).sort(); } catch { return []; } };
  const ptzCams = () => {
    const d = systems && systems.drivers && systems.drivers.ptz; if (!d || !d.cams) return [];
    let P = null; try { P = require('../drivers/ptz-commands'); } catch { /* */ }
    return [...d.cams.entries()].map(([id, c]) => ({ id, name: c.conf.name || id, host: c.conf.host, model: (c.st.data && c.st.data.model) || c.conf.model || '', series: c.st.series,
      rtsp: P ? P.SPEC_SERIES.has(c.st.series) : true }));
  };
  // login (0.12.0 merge): the camera's own UE150 login from the CAMERAS tab (conf.user / conf.pass, 0.11.1) wins where
  // it exists, so CGI control and the RTSP stream use the same account; else the scopes setting; else the Panasonic
  // factory default. Stream / path / port always come from the scopes settings.
  const camConf = (id) => {
    const d = systems && systems.drivers && systems.drivers.ptz; const c = d && d.cams && d.cams.get(id); const conf = (c && c.conf) || {};
    const o = cfg.cameras[id] || {};
    const own = !!conf.user || typeof conf.pass === 'string';
    const out = { ...CAMERA_DEFAULTS, ...o, loginFrom: o.user || typeof o.password === 'string' ? 'scopes' : 'factory' };
    if (own) { out.user = conf.user || CAMERA_DEFAULTS.user; out.password = typeof conf.pass === 'string' ? conf.pass : CAMERA_DEFAULTS.password; out.loginFrom = 'camera'; }
    return out;
  };
  const camUrl = (cam) => {
    const k = camConf(cam.id); const o = overrides[cam.id] || (mock && mockCam.port && cam.host === '127.0.0.1' ? { host: '127.0.0.1', port: mockCam.port } : null);
    const host = o ? o.host : cam.host; const port = o ? o.port : Number(k.port) || 554;
    return `rtsp://${host}${port === 554 ? '' : `:${port}`}${k.path || UE150_PATH(Number(k.stream) || 1)}`;
  };
  function sources() {
    const out = [];
    for (const d of mockNdi()) out.push({ key: `ndi:${d.id}`, label: d.label, kind: 'ndi', via: 'mock', detail: 'mock frame source (no NDI hardware)', ok: true });
    for (const s of hub.list()) {
      if (s.id.startsWith('mock-')) continue;
      out.push({ key: `ndi:${s.id}`, label: `NDI · ${s.name}`, kind: 'ndi', via: 'sidecar', detail: s.connected ? 'Mac sidecar is sending H.264' : 'sidecar disconnected', ok: !!s.connected });
    }
    for (const f of listDir(builtinDir)) out.push({ key: `builtin:${f}`, label: `Test: ${f}`, kind: 'file', detail: 'built in (test/fixtures/scopes)', ok: true });
    for (const f of listDir(testFolder())) out.push({ key: `test:${f}`, label: `Test folder: ${f}`, kind: 'file', detail: path.join(testFolder(), f), ok: true });
    for (const c of ptzCams()) out.push({ key: `cam:${c.id}`, label: `${c.name}${c.model ? ` (${c.model})` : ''}`, kind: 'camera', detail: camUrl(c), ok: c.rtsp, camId: c.id,
      note: c.rtsp ? '' : `${c.series} series: no RTSP H.264 per the spec table (UE150-class only); JPEG snapshot only` });
    if (cfg.custom) out.push({ key: 'custom', label: `Custom: ${path.basename(cfg.custom.replace(/^rtsp:\/\/[^@/]*@/i, 'rtsp://'))}`, kind: /^rtsp:/i.test(cfg.custom) ? 'rtsp' : 'file', detail: cfg.custom.replace(/\/\/[^@/]*@/, '//***@'), ok: true });
    return out;
  }
  const cameraUri = async (id, n) => {
    const d = systems && systems.drivers && systems.drivers.ptz; if (!d || typeof d.streamInfo !== 'function') return null;
    const info = await Promise.race([d.streamInfo(id), new Promise((r) => setTimeout(() => r(null), 2500))]);
    const st = info && (info.streams || []).find((x) => x.name === `H264 STREAM ${n}`); if (!st) return null;
    try { const u = new URL(st.url.replace(/^rtsp:/i, 'http:')); return u.pathname + u.search; } catch { return null; }
  };
  const safeFile = (dir, name) => { if (!FILE_EXT.test(name) || name !== path.basename(name)) throw Object.assign(new Error('bad file name'), { status: 400 }); const f = path.join(dir, name); if (!fs.existsSync(f)) throw Object.assign(new Error(`${name}: not found`), { status: 404 }); return f; };
  function resolve(key) {
    let m;
    if ((m = /^ndi:([a-z0-9][a-z0-9-]{0,40})$/.exec(key))) {
      const fix = mockNdi().find((d) => d.id === m[1]);
      if (fix) return { make: () => new FileInput(fix.file), meta: { label: fix.label, kind: 'ndi', via: 'mock' } };
      if (!hub.has(m[1])) throw Object.assign(new Error(`no NDI source ${m[1]}`), { status: 404 });
      const info = hub.get(m[1]);
      return { make: () => new NdiPushInput(hub, m[1]), meta: { label: `NDI · ${info.name}`, kind: 'ndi', via: 'sidecar' } };
    }
    if ((m = /^builtin:(.+)$/.exec(key))) { const f = safeFile(builtinDir, m[1]); return { make: () => new FileInput(f), meta: { label: `Test: ${m[1]}`, kind: 'file' } }; }
    if ((m = /^test:(.+)$/.exec(key))) { const f = safeFile(testFolder(), m[1]); return { make: () => new FileInput(f), meta: { label: m[1], kind: 'file' } }; }
    if ((m = /^cam:([\w-]+)$/.exec(key))) {
      const cam = ptzCams().find((c) => c.id === m[1]); if (!cam) throw Object.assign(new Error(`no camera ${m[1]}`), { status: 404 });
      const k = camConf(cam.id); const url = camUrl(cam);
      // unless a path is set, use the request URI the camera reports for that stream (/cgi-bin/get_rtsp,
      // h264_rtsp_req_uriN; the spec 12.1 default is /mediainput/h264/stream_N), keeping our host / port
      const n = Number(k.stream) || 1;
      const resolveUrl = k.path ? null : () => cameraUri(cam.id, n).then((p) => (p ? url.replace(/^(rtsp:\/\/[^/]+).*$/, `$1${p}`) : url));
      // the login is read on every (re)connect, so a login changed on the CAMERAS tab is picked up on the next retry
      const login = () => { const x = camConf(cam.id); return { user: x.user, pass: x.password }; };
      return { make: () => new RtspInput(url, { user: k.user, pass: k.password, login, resolveUrl }), meta: { label: cam.name, kind: 'camera' } };
    }
    if (key === 'custom' && cfg.custom) {
      if (/^rtsp:\/\//i.test(cfg.custom)) return { make: () => new RtspInput(cfg.custom, { user: cfg.customUser || undefined, pass: cfg.customPassword || undefined }), meta: { label: 'Custom RTSP', kind: 'rtsp' } };
      if (!FILE_EXT.test(cfg.custom)) throw Object.assign(new Error('custom input: an rtsp:// URL or a .h264 / .264 / .mp4 / .mov / .m4v file'), { status: 400 });
      return { make: () => new FileInput(cfg.custom), meta: { label: path.basename(cfg.custom), kind: 'file' } };
    }
    throw Object.assign(new Error(`unknown source ${key}`), { status: 404 });
  }
  const publicSettings = () => ({ testDir: testFolder(), custom: cfg.custom.replace(/\/\/[^@/]*@/, '//***@'), customUser: cfg.customUser, customHasPassword: !!cfg.customPassword,
    cameraDefaults: { stream: CAMERA_DEFAULTS.stream, port: CAMERA_DEFAULTS.port, user: CAMERA_DEFAULTS.user, path: UE150_PATH('<n>') },
    cameras: Object.fromEntries(ptzCams().map((c) => { const k = camConf(c.id); return [c.id, { stream: k.stream, path: k.path, port: k.port, user: k.user, hasPassword: !!k.password, loginFrom: k.loginFrom, url: camUrl(c) }]; })) });
  function updateSettings(b) {
    if (typeof b.testDir === 'string') cfg.testDir = b.testDir.trim();
    if (typeof b.custom === 'string') { const v = b.custom.trim(); if (v && !/^rtsp:\/\//i.test(v) && !FILE_EXT.test(v)) throw Object.assign(new Error('custom input: an rtsp:// URL or a .h264 / .264 / .mp4 / .mov / .m4v file path'), { status: 400 }); cfg.custom = v; }
    if (typeof b.customUser === 'string') cfg.customUser = b.customUser;
    if (typeof b.customPassword === 'string') cfg.customPassword = b.customPassword;
    if (b.cameras && typeof b.cameras === 'object') for (const [id, v] of Object.entries(b.cameras)) {
      if (!/^[\w-]+$/.test(id) || !v || typeof v !== 'object') continue;
      const cur = cfg.cameras[id] || {};
      if (v.stream !== undefined) { const n = Number(v.stream); if (![1, 2, 3, 4].includes(n)) throw Object.assign(new Error('stream: 1-4'), { status: 400 }); cur.stream = n; }
      if (typeof v.path === 'string') { if (v.path && !/^\/[\w./?=&%-]*$/.test(v.path)) throw Object.assign(new Error('path must start with /'), { status: 400 }); cur.path = v.path; }
      if (v.port !== undefined) cur.port = Number(v.port) || 554;
      if (typeof v.user === 'string') cur.user = v.user;
      if (typeof v.password === 'string') cur.password = v.password;
      cfg.cameras[id] = cur;
    }
    save();
    // running relays pick up the change at once (a new login / stream / file)
    for (const k of [...relay.sources.keys()]) {
      const hit = (b.cameras && k.startsWith('cam:') && b.cameras[k.slice(4)]) || (k === 'custom' && (b.custom !== undefined || b.customUser !== undefined || b.customPassword !== undefined)) || (k.startsWith('test:') && b.testDir !== undefined);
      if (hit) { try { relay.reopen(k, resolve(k).make); } catch (e) { log('warn', `Scopes: ${k}: ${e.message}`); } }
    }
    return publicSettings();
  }

  const sendJson = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  function handle(req, res) {
    const url = new URL(req.url, 'http://x'); if (!url.pathname.startsWith('/api/scopes/')) return false;
    const done = (fn) => { try { const v = fn(); sendJson(res, 200, v); } catch (e) { sendJson(res, e.status || 400, { error: e.message }); } };
    if (req.method === 'GET' && url.pathname === '/api/scopes/sources') { done(() => ({ sources: sources(), settings: publicSettings(), mock, ndi: ndiStatus() })); return true; }
    if (req.method === 'GET' && url.pathname === '/api/scopes/ndi') { done(() => ({ ...ndiStatus(), sources: sources().filter((s) => s.kind === 'ndi') })); return true; }
    if (req.method === 'GET' && url.pathname === '/api/scopes/status') { done(() => ({ relays: relay.stats() })); return true; }
    if (req.method === 'POST' && url.pathname === '/api/scopes/settings') {
      let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => done(() => { let b; try { b = JSON.parse(raw || '{}'); } catch { throw new Error('Invalid JSON body'); } return updateSettings(b); }));
      return true;
    }
    sendJson(res, 404, { error: `No route ${req.method} ${url.pathname}` }); return true;
  }
  function ingestUpgrade(req, socket, head, url) {
    if (!ingestAllowed(req.socket.remoteAddress, { allowLan })) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNDI ingest accepts loopback only. Set RS6_NDI_INGEST_LAN=1 to allow a Mac sidecar on another machine.\r\n');
      return true;
    }
    const id = String(url.searchParams.get('id') || '');
    const name = cleanNdiName(url.searchParams.get('name') || id, id);
    const fps = Number(url.searchParams.get('fps'));
    if (!isNdiId(id) || id.startsWith('mock-')) {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nbad NDI source id\r\n');
      return true;
    }
    const conn = ws.accept(req, socket, head); if (!conn) return true;
    hub.attachSocket(id, { name, fps: fps >= 1 && fps <= 120 ? fps : 0, conn });
    log('info', `NDI ingest: ${name} (${id}) connected`);
    return true;
  }
  async function upgrade(req, socket, head) {
    let url; try { url = new URL(req.url, 'http://x'); } catch { return false; }
    if (url.pathname === '/api/scopes/ndi/ingest') return ingestUpgrade(req, socket, head, url);
    if (url.pathname !== '/api/scopes/ws') return false;
    if (mockCam.ready) await mockCam.ready;
    let r; try { r = resolve(url.searchParams.get('src') || ''); } catch (e) { socket.end(`HTTP/1.1 ${e.status || 400} Bad Request\r\nContent-Type: text/plain\r\n\r\n${e.message}`); return true; }
    const conn = ws.accept(req, socket, head); if (!conn) return true;
    relay.attach(url.searchParams.get('src'), r.make, conn, r.meta);
    return true;
  }
  // mount: our routes first, then the app's handler; WebSocket upgrades for /api/scopes/ws
  const prev = server.listeners('request'); server.removeAllListeners('request');
  server.on('request', (req, res) => { if (handle(req, res)) return; for (const l of prev) l.call(server, req, res); });
  server.on('upgrade', (req, socket, head) => { upgrade(req, socket, head).then((ok) => { if (!ok) socket.destroy(); }).catch(() => socket.destroy()); });
  // Optional HTTPS mirror of the whole app (same handlers) so tablets / laptops on the LAN get a secure context:
  // WebCodecs (exact Y′ path) is only exposed on https:// or localhost. RS6_TLS_CERT / RS6_TLS_KEY (PEM files),
  // RS6_TLS_PORT (default 8443). Without them nothing changes (plain-http pages use the MSE fallback).
  let tlsServer = null;
  const tlsCert = tls && tls.cert !== undefined ? tls.cert : process.env.RS6_TLS_CERT; const tlsKey = tls && tls.key !== undefined ? tls.key : process.env.RS6_TLS_KEY;
  if (tlsCert && tlsKey) {
    try {
      const https = require('https');
      tlsServer = https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) });
      for (const l of server.listeners('request')) tlsServer.on('request', l);
      for (const l of server.listeners('upgrade')) tlsServer.on('upgrade', l);
      const port = Number((tls && tls.port) || process.env.RS6_TLS_PORT || 8443);
      tlsServer.listen(port, (tls && tls.host) || process.env.HOST || '0.0.0.0', () => { log('info', `HTTPS (scopes / WebCodecs secure context): https://<this-host>:${tlsServer.address().port}`); });
      tlsServer.on('error', (e) => log('warn', `HTTPS listener: ${e.message}`));
    } catch (e) { log('warn', `HTTPS listener not started: ${e.message}`); tlsServer = null; }
  }
  const close = async () => { relay.closeAll(); hub.close(); if (mockCam.server) await mockCam.server.stop(); if (tlsServer) tlsServer.close(); };
  return { relay, close, sources, resolve, settings: publicSettings, updateSettings, mockCamera: mockCam, get tlsServer() { return tlsServer; } };
}

module.exports = { attachScopes, CAMERA_DEFAULTS, UE150_PATH };
