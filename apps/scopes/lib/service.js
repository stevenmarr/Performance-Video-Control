'use strict';
// 0.12.0 scopes service: settings, source list, the stream relay's WebSocket endpoint and, in --mock, a mock RTSP camera.
// Mounted onto the app's HTTP server by attachScopes() without touching lib/server.js:
//   GET  /api/scopes/sources    {sources:[{key,label,kind,detail,ok,note}], settings (passwords never returned), mock}
//   POST /api/scopes/settings   {testDir?, custom?, customUser?, customPassword?, cameras?: {<camId>: {stream, path, port, user, password}}}
//   GET  /api/scopes/status     relay statistics per running source
//   WS   /api/scopes/ws?src=<key>   the H.264 relay (lib/stream-relay.js protocol)
// Source keys: builtin:<file> (test/fixtures/scopes), test:<file> (the test folder), cam:<id> (a PTZ camera's RTSP
// stream), custom (a file path or rtsp:// URL from the settings: "plug in your own test video"),
// ndi:<id> (Desktop Video or a legacy NDI sidecar pushing H.264). There are no in-process NDI fixtures.
// The process never opens DeckLink or NDI. See docs/decklink-ingest.md and docs/ndi-ingest.md.
const fs = require('fs');
const path = require('path');
const { StreamRelay } = require('./stream-relay');
const { FileInput, RtspInput, FILE_EXT } = require('./sources');
const { NdiHub, NdiPushInput } = require('./ndi-ingest');
const { DeckLinkPool } = require('./decklink-devices');
const { hostRole, ingestAllowed, isNdiId, cleanNdiName, cleanField } = require('./ndi/host');
const ws = require('./ws');
const Cameras = require('./cameras');
const CameraHttp = require('./camera-http');

// Panasonic factory default login; every camera's own login is a setting (scopes.json in the data folder)
const CAMERA_DEFAULTS = { stream: 1, path: '', port: 554, user: 'admin', password: '12345' };
const UE150_PATH = (n) => `/MediaInput/h264/stream_${n}`; // Panasonic Integrated Camera Interface spec 12.1 / get_rtsp

function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }

function attachScopes(server, { dataDir, appDir = path.join(__dirname, '..'), mock = false, log = () => {}, testDir, tls = null, decklinkList = null } = {}) {
  const file = dataDir ? path.join(dataDir, 'scopes.json') : null;
  const cfg = { testDir: '', custom: '', customUser: '', customPassword: '', controlCenterUrl: '', cameras: {}, ...(file ? readJson(file, {}) : {}) };
  const save = () => { if (!file) return; const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2)); fs.renameSync(tmp, file); };
  const builtinDir = path.join(appDir, 'test', 'fixtures', 'scopes'); // small committed clips (bars, ramps, moving)
  const defaultTestDir = testDir || process.env.SCOPES_SCOPES_TEST_DIR || process.env.RS6_SCOPES_TEST_DIR || path.join(appDir, '..', '..', '..', 'scopes-test');
  const testFolder = () => cfg.testDir || defaultTestDir;
  const relay = new StreamRelay({ log });
  const hub = new NdiHub();
  const deck = new DeckLinkPool({ hub, log, ...(decklinkList ? { listDevices: decklinkList } : {}) });
  const allowLan = process.env.SCOPES_NDI_INGEST_LAN === '1' || process.env.RS6_NDI_INGEST_LAN === '1';
  const role = hostRole();
  const mockCam = { server: null, port: 0, ready: null };
  const ndiStatus = () => ({
    receive: 'sidecar', inProcess: false, pi: role.pi, platform: role.platform,
    ndiReceiveAllowed: role.ndiReceiveAllowed, decklinkReceiveAllowed: role.decklinkReceiveAllowed,
    ingest: allowLan ? 'lan' : 'loopback',
    sidecar: hub.list().filter((s) => s.connected).length, mock: !!mock,
  });
  const liveRow = (s) => {
    const index = s.kind === 'decklink' && /^\d+$/.test(String(s.device || '')) ? Number(s.device) : null;
    const decklink = s.kind === 'decklink';
    return {
      key: index === null ? `ndi:${s.id}` : `decklink:${index}`,
      deviceIndex: index,
      label: decklink ? (s.width && s.height ? `${s.name || `DeckLink ${index}`} · ${s.width}×${s.height}${s.fps ? ` ${Number(s.fps).toFixed(2)}${s.scan || 'p'}` : ''}` : (s.name || `DeckLink ${index}`)) : `NDI · ${s.name}`,
      kind: 'ndi',
      via: decklink ? 'decklink' : 'sidecar',
      detail: decklink
        ? (s.connected ? `Desktop Video input${s.mode ? ` (${s.mode})` : ''}` : 'Desktop Video input, not capturing')
        : (s.connected ? 'Mac sidecar is sending H.264' : 'sidecar disconnected'),
      ok: !!s.connected,
      device: index,
    };
  };
  const overrides = {}; // camId -> {host, port} (mock mode: the mock RTSP camera)

  if (mock) {
    const { MockRtspCamera } = require('./mocks/rtsp-camera');
    const pick = (names) => { for (const n of names) for (const d of [testFolder(), builtinDir]) { const f = path.join(d, n); if (fs.existsSync(f)) return f; } return null; };
    const s1 = pick(['moving.h264', 'moving-360.h264']); const s2 = pick(['bars.h264']);
    const streams = {}; if (s1) streams[UE150_PATH(1)] = s1; if (s2) streams[UE150_PATH(2)] = s2;
    const m = new MockRtspCamera({ streams });
    mockCam.server = m;
    mockCam.ready = m.start(0).then((port) => { mockCam.port = port; log('info', `MOCK RTSP camera rtsp://127.0.0.1:${port}${UE150_PATH(1)} (admin / 12345)`); return port; });
  }

  const listDir = (d) => { try { return fs.readdirSync(d).filter((f) => FILE_EXT.test(f)).sort(); } catch { return []; } };
  const camOverride = (cam) => overrides[cam.id] || (mock && mockCam.port && cam.host === '127.0.0.1' ? { host: '127.0.0.1', port: mockCam.port } : null);
  const camUrl = (cam) => Cameras.rtspUrl(cam, camOverride(cam));
  function sources() {
    const out = [];
    const live = hub.list().filter((s) => s.id && !s.id.startsWith('mock-'));
    const seen = new Set();
    for (const s of live.filter((s) => s.kind === 'decklink')) {
      const row = liveRow(s);
      out.push(row);
      if (row.device != null) seen.add(row.device);
    }
    for (const d of deck.devices()) {
      if (seen.has(d.index)) continue;
      out.push({
        key: `decklink:${d.index}`,
        deviceIndex: d.index,
        label: d.name,
        kind: 'ndi',
        via: 'decklink',
        detail: d.connections ? `Desktop Video · ${d.connections}` : 'Desktop Video input',
        ok: true,
        device: d.index,
      });
    }
    for (const s of live.filter((s) => s.kind !== 'decklink')) out.push(liveRow(s));
    for (const f of listDir(builtinDir)) out.push({ key: `builtin:${f}`, label: `Test: ${f}`, kind: 'file', detail: 'built in (test/fixtures/scopes)', ok: true });
    for (const f of listDir(testFolder())) out.push({ key: `test:${f}`, label: `Test folder: ${f}`, kind: 'file', detail: path.join(testFolder(), f), ok: true });
    for (const c of Cameras.list(cfg)) {
      const series = Cameras.seriesOf(c.model);
      const rtsp = Cameras.rtspOk(c.model);
      out.push({ key: `cam:${c.id}`, label: `${c.name}${c.model ? ` (${c.model})` : ''}`, kind: 'camera', detail: camUrl(c), ok: rtsp, camId: c.id,
        note: rtsp ? '' : `${series} series: no RTSP H.264 per the spec table (UE150-class only); JPEG snapshot only` });
    }
    if (cfg.custom) out.push({ key: 'custom', label: `Custom: ${path.basename(cfg.custom.replace(/^rtsp:\/\/[^@/]*@/i, 'rtsp://'))}`, kind: /^rtsp:/i.test(cfg.custom) ? 'rtsp' : 'file', detail: cfg.custom.replace(/\/\/[^@/]*@/, '//***@'), ok: true });
    return out;
  }
  const safeFile = (dir, name) => { if (!FILE_EXT.test(name) || name !== path.basename(name)) throw Object.assign(new Error('bad file name'), { status: 400 }); const f = path.join(dir, name); if (!fs.existsSync(f)) throw Object.assign(new Error(`${name}: not found`), { status: 404 }); return f; };
  function resolve(key) {
    let m;
    if ((m = /^ndi:([a-z0-9][a-z0-9-]{0,40})$/.exec(key))) {
      if (m[1].startsWith('mock-') || !hub.has(m[1])) throw Object.assign(new Error(`no NDI source ${m[1]}`), { status: 404 });
      const info = hub.get(m[1]);
      const deck = info.kind === 'decklink';
      return { make: () => new NdiPushInput(hub, m[1]), meta: { label: deck ? `Desktop Video · ${info.name}` : `NDI · ${info.name}`, kind: 'ndi', via: deck ? 'decklink' : 'sidecar' } };
    }
    if ((m = /^builtin:(.+)$/.exec(key))) { const f = safeFile(builtinDir, m[1]); return { make: () => new FileInput(f), meta: { label: `Test: ${m[1]}`, kind: 'file' } }; }
    if ((m = /^test:(.+)$/.exec(key))) { const f = safeFile(testFolder(), m[1]); return { make: () => new FileInput(f), meta: { label: m[1], kind: 'file' } }; }
    if ((m = /^cam:([\w-]+)$/.exec(key))) {
      const cam = Cameras.get(cfg, m[1]); if (!cam) throw Object.assign(new Error(`no camera ${m[1]}`), { status: 404 });
      const k = Cameras.loginOf(cam); const url = camUrl(cam);
      const n = Number(cam.stream) || 1;
      const resolveUrl = cam.path ? null : () => CameraHttp.getRtspPath(Cameras.get(cfg, cam.id) || cam, n).then((p) => (p ? url.replace(/^(rtsp:\/\/[^/]+).*$/, `$1${p}`) : url));
      const login = () => { const live = Cameras.get(cfg, cam.id) || cam; const x = Cameras.loginOf(live); return { user: x.user, pass: x.password }; };
      return { make: () => new RtspInput(url, { user: k.user, pass: k.password, login, resolveUrl }), meta: { label: cam.name, kind: 'camera' } };
    }
    if (key === 'custom' && cfg.custom) {
      if (/^rtsp:\/\//i.test(cfg.custom)) return { make: () => new RtspInput(cfg.custom, { user: cfg.customUser || undefined, pass: cfg.customPassword || undefined }), meta: { label: 'Custom RTSP', kind: 'rtsp' } };
      if (!FILE_EXT.test(cfg.custom)) throw Object.assign(new Error('custom input: an rtsp:// URL or a .h264 / .264 / .mp4 / .mov / .m4v file'), { status: 400 });
      return { make: () => new FileInput(cfg.custom), meta: { label: path.basename(cfg.custom), kind: 'file' } };
    }
    throw Object.assign(new Error(`unknown source ${key}`), { status: 404 });
  }
  async function prepare(key) {
    const picked = /^decklink:(\d+)$/.exec(String(key || ''));
    if (!picked) return resolve(key);
    const id = await deck.ensure(Number(picked[1]));
    const info = hub.get(id);
    return { make: () => new NdiPushInput(hub, id), meta: { label: (info && info.name) || `DeckLink ${picked[1]}`, kind: 'ndi', via: 'decklink' } };
  }
  const publicSettings = () => ({ testDir: testFolder(), custom: cfg.custom.replace(/\/\/[^@/]*@/, '//***@'), customUser: cfg.customUser, customHasPassword: !!cfg.customPassword,
    controlCenterUrl: cfg.controlCenterUrl || '',
    cameraDefaults: { stream: Cameras.CAMERA_DEFAULTS.stream, port: Cameras.CAMERA_DEFAULTS.port, user: Cameras.CAMERA_DEFAULTS.user, path: Cameras.UE150_PATH('<n>') },
    cameras: Object.fromEntries(Cameras.list(cfg).map((c) => [c.id, Cameras.publicOne(c, camUrl(c))])) });
  function updateSettings(b) {
    if (typeof b.testDir === 'string') cfg.testDir = b.testDir.trim();
    if (typeof b.custom === 'string') { const v = b.custom.trim(); if (v && !/^rtsp:\/\//i.test(v) && !FILE_EXT.test(v)) throw Object.assign(new Error('custom input: an rtsp:// URL or a .h264 / .264 / .mp4 / .mov / .m4v file path'), { status: 400 }); cfg.custom = v; }
    if (typeof b.customUser === 'string') cfg.customUser = b.customUser;
    if (typeof b.customPassword === 'string') cfg.customPassword = b.customPassword;
    if (typeof b.controlCenterUrl === 'string') cfg.controlCenterUrl = b.controlCenterUrl.trim().slice(0, 300);
    if (Array.isArray(b.removeCameras)) for (const id of b.removeCameras) Cameras.remove(cfg, id);
    if (b.cameras && typeof b.cameras === 'object') for (const [id, v] of Object.entries(b.cameras)) {
      if (v == null) { Cameras.remove(cfg, id); continue; }
      Cameras.apply(cfg, id, v);
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
    if (req.method === 'GET' && url.pathname === '/api/scopes/sources') {
      deck.refresh().then(() => sendJson(res, 200, { sources: sources(), settings: publicSettings(), mock, ndi: ndiStatus(), decklinkError: deck.error() })).catch((e) => sendJson(res, 500, { error: e.message }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/scopes/ndi') {
      deck.refresh().then(() => sendJson(res, 200, { ...ndiStatus(), sources: sources().filter((s) => s.kind === 'ndi'), decklinkError: deck.error() })).catch((e) => sendJson(res, 500, { error: e.message }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/scopes/status') { done(() => ({ relays: relay.stats() })); return true; }

    const snap = url.pathname.match(/^\/api\/scopes\/cameras\/([\w-]+)\/snapshot$/);
    if (req.method === 'GET' && snap) {
      const cam = Cameras.get(cfg, snap[1]);
      if (!cam) { sendJson(res, 404, { error: `no camera ${snap[1]}` }); return true; }
      CameraHttp.snapshot(cam).then((img) => {
        res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'no-store', 'Content-Length': img.body.length });
        res.end(img.body);
      }).catch((e) => sendJson(res, e.status || 502, { error: e.message }));
      return true;
    }
    const camDel = url.pathname.match(/^\/api\/scopes\/cameras\/([\w-]+)$/);
    if (req.method === 'DELETE' && camDel && url.pathname.endsWith('/snapshot') === false) {
      done(() => { Cameras.remove(cfg, camDel[1]); save(); return publicSettings(); }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/scopes/cameras/import') {
      let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => {
        Promise.resolve().then(async () => {
          let b; try { b = JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
          const urlStr = (b && b.url) || cfg.controlCenterUrl;
          const n = await Cameras.importViews(cfg, urlStr);
          if (b && typeof b.url === 'string') cfg.controlCenterUrl = b.url.trim();
          save();
          return { imported: n, settings: publicSettings() };
        }).then((v) => sendJson(res, 200, v)).catch((e) => sendJson(res, e.status || 502, { error: e.message }));
      });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/scopes/cameras') {
      let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => done(() => {
        let b; try { b = JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
        const id = b.id || `cam${Object.keys(cfg.cameras || {}).length + 1}`;
        Cameras.apply(cfg, id, b); save(); return publicSettings();
      }));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/scopes/settings') {
      let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => done(() => { let b; try { b = JSON.parse(raw || '{}'); } catch { throw new Error('Invalid JSON body'); } return updateSettings(b); }));
      return true;
    }
    sendJson(res, 404, { error: `No route ${req.method} ${url.pathname}` }); return true;
  }
  function ingestUpgrade(req, socket, head, url) {
    if (!ingestAllowed(req.socket.remoteAddress, { allowLan })) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNDI ingest accepts loopback only. Set SCOPES_NDI_INGEST_LAN=1 (or RS6_NDI_INGEST_LAN=1) to allow a sidecar on another machine.\r\n');
      return true;
    }
    const id = String(url.searchParams.get('id') || '');
    const name = cleanNdiName(url.searchParams.get('name') || id, id);
    const fps = Number(url.searchParams.get('fps'));
    const kind = String(url.searchParams.get('kind') || '').toLowerCase() === 'decklink' ? 'decklink' : '';
    const device = cleanField(url.searchParams.get('device'));
    const mode = cleanField(url.searchParams.get('mode'), 32);
    if (!isNdiId(id) || id.startsWith('mock-')) {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nbad NDI source id\r\n');
      return true;
    }
    const conn = ws.accept(req, socket, head); if (!conn) return true;
    hub.attachSocket(id, { name, fps: fps >= 1 && fps <= 120 ? fps : 0, conn, kind, device, mode });
    log('info', `${kind === 'decklink' ? 'Desktop Video' : 'NDI'} ingest: ${name} (${id}) connected`);
    return true;
  }
  async function upgrade(req, socket, head) {
    let url; try { url = new URL(req.url, 'http://x'); } catch { return false; }
    if (url.pathname === '/api/scopes/ndi/ingest') return ingestUpgrade(req, socket, head, url);
    if (url.pathname !== '/api/scopes/ws') return false;
    if (mockCam.ready) await mockCam.ready;
    let r; try { r = await prepare(url.searchParams.get('src') || ''); } catch (e) { socket.end(`HTTP/1.1 ${e.status || 400} Bad Request\r\nContent-Type: text/plain\r\n\r\n${e.message}`); return true; }
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
  const tlsCert = tls && tls.cert !== undefined ? tls.cert : (process.env.SCOPES_TLS_CERT || process.env.RS6_TLS_CERT); const tlsKey = tls && tls.key !== undefined ? tls.key : (process.env.SCOPES_TLS_KEY || process.env.RS6_TLS_KEY);
  if (tlsCert && tlsKey) {
    try {
      const https = require('https');
      tlsServer = https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) });
      for (const l of server.listeners('request')) tlsServer.on('request', l);
      for (const l of server.listeners('upgrade')) tlsServer.on('upgrade', l);
      const port = Number((tls && tls.port) || process.env.SCOPES_TLS_PORT || process.env.RS6_TLS_PORT || 8443);
      tlsServer.listen(port, (tls && tls.host) || process.env.HOST || '0.0.0.0', () => { log('info', `HTTPS (scopes / WebCodecs secure context): https://<this-host>:${tlsServer.address().port}`); });
      tlsServer.on('error', (e) => log('warn', `HTTPS listener: ${e.message}`));
    } catch (e) { log('warn', `HTTPS listener not started: ${e.message}`); tlsServer = null; }
  }
  const close = async () => { deck.close(); relay.closeAll(); hub.close(); if (mockCam.server) await mockCam.server.stop(); if (tlsServer) tlsServer.close(); };
  return { relay, close, sources, resolve, settings: publicSettings, updateSettings, mockCamera: mockCam, get tlsServer() { return tlsServer; } };
}

module.exports = { attachScopes, CAMERA_DEFAULTS: Cameras.CAMERA_DEFAULTS, UE150_PATH: Cameras.UE150_PATH };
