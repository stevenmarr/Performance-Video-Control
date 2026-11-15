'use strict';
// Standalone camera list for Scopes. Stored in scopes.json. No Control Center process.
const CAMERA_DEFAULTS = { stream: 1, path: '', port: 554, httpPort: 80, user: 'admin', password: '12345' };
const UE150_PATH = (n) => `/MediaInput/h264/stream_${n}`;
// UE150-class CGI (aw_ptz / aw_cam / RTSP H.264). Longer ids are listed first so
// AW-UE150A is not swallowed by AW-UE150, and AW-UE40 is not AW-UE4.
const UE150_MODELS = ['AW-UE163', 'AW-UE160', 'AW-UE155', 'AW-UE150A', 'AW-UE150', 'AW-UE100', 'AW-HE145', 'AW-UN145'];

function modelMatches(reported, id) {
  const m = String(reported || '').toUpperCase();
  const t = String(id || '').toUpperCase();
  if (!t || !m.startsWith(t)) return false;
  const next = m[t.length];
  return !next || /[^0-9]/.test(next);
}
function seriesOf(model) {
  const m = String(model || '').toUpperCase();
  if (!m.trim()) return 'UE150';
  let best = null;
  for (const id of UE150_MODELS) if (modelMatches(m, id) && (!best || id.length > best.length)) best = id;
  return best ? 'UE150' : 'Other';
}
function rtspOk(model) { return seriesOf(model) === 'UE150'; }
function isId(id) { return /^[\w-]{1,40}$/.test(String(id || '')); }

function loginOf(cam) {
  const storedUser = cam && typeof cam.user === 'string' && cam.user !== '';
  const storedPass = cam && typeof cam.password === 'string' && cam.password !== '';
  if (storedUser || storedPass) {
    return { user: storedUser ? cam.user : CAMERA_DEFAULTS.user, password: storedPass ? cam.password : CAMERA_DEFAULTS.password, loginFrom: 'scopes' };
  }
  return { user: CAMERA_DEFAULTS.user, password: CAMERA_DEFAULTS.password, loginFrom: 'factory' };
}

function normalize(id, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const stream = Number(src.stream);
  const port = Number(src.port != null ? src.port : src.rtspPort);
  const httpPort = Number(src.httpPort);
  return {
    id,
    name: String(src.name || id).trim().slice(0, 40) || id,
    host: String(src.host || '').trim().slice(0, 200),
    httpPort: Number.isInteger(httpPort) && httpPort > 0 && httpPort < 65536 ? httpPort : 80,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 554,
    stream: [1, 2, 3, 4].includes(stream) ? stream : 1,
    path: typeof src.path === 'string' ? src.path : '',
    user: typeof src.user === 'string' ? src.user : '',
    password: typeof src.password === 'string' ? src.password : '',
    model: typeof src.model === 'string' ? src.model.slice(0, 64) : '',
  };
}

function mapOf(cfg) {
  if (!cfg.cameras || typeof cfg.cameras !== 'object' || Array.isArray(cfg.cameras)) cfg.cameras = {};
  return cfg.cameras;
}

function list(cfg) {
  const raw = mapOf(cfg);
  return Object.keys(raw).filter(isId).map((id) => normalize(id, raw[id])).filter((c) => c.host);
}

function get(cfg, id) {
  const raw = mapOf(cfg)[id];
  if (!raw) return null;
  const cam = normalize(id, raw);
  return cam.host ? cam : null;
}

function apply(cfg, id, v) {
  if (!isId(id) || !v || typeof v !== 'object') return null;
  const raw = mapOf(cfg);
  const cur = raw[id] ? { ...normalize(id, raw[id]) } : normalize(id, {});
  if (typeof v.name === 'string') cur.name = v.name.trim().slice(0, 40) || id;
  if (typeof v.host === 'string') cur.host = v.host.trim().slice(0, 200);
  if (v.httpPort !== undefined && v.httpPort !== '') { const n = Number(v.httpPort); if (Number.isInteger(n) && n > 0 && n < 65536) cur.httpPort = n; }
  if (v.stream !== undefined && v.stream !== '') {
    const n = Number(v.stream);
    if (![1, 2, 3, 4].includes(n)) throw Object.assign(new Error('stream: 1-4'), { status: 400 });
    cur.stream = n;
  }
  if (typeof v.path === 'string') {
    if (v.path && !/^\/[\w./?=&%-]*$/.test(v.path)) throw Object.assign(new Error('path must start with /'), { status: 400 });
    cur.path = v.path;
  }
  if (v.port !== undefined && v.port !== '') cur.port = Number(v.port) || 554;
  if (v.rtspPort !== undefined && v.rtspPort !== '') cur.port = Number(v.rtspPort) || 554;
  if (typeof v.user === 'string') cur.user = v.user;
  if (typeof v.password === 'string') cur.password = v.password;
  if (typeof v.model === 'string') cur.model = v.model.slice(0, 64);
  if (typeof v.series === 'string' && !cur.model) cur.model = v.series;
  if (!cur.host) throw Object.assign(new Error('a camera needs a host'), { status: 400 });
  raw[id] = {
    name: cur.name, host: cur.host, httpPort: cur.httpPort, port: cur.port, stream: cur.stream,
    path: cur.path, user: cur.user, password: cur.password, model: cur.model,
  };
  return normalize(id, raw[id]);
}

function remove(cfg, id) {
  if (!isId(id)) return false;
  const raw = mapOf(cfg);
  if (!raw[id]) return false;
  delete raw[id];
  return true;
}

function rtspUrl(cam, override) {
  const host = override ? override.host : cam.host;
  const port = override ? override.port : (Number(cam.port) || 554);
  const path = cam.path || UE150_PATH(Number(cam.stream) || 1);
  return `rtsp://${host}${Number(port) === 554 ? '' : `:${port}`}${path}`;
}

function publicOne(cam, url) {
  const login = loginOf(cam);
  const series = seriesOf(cam.model);
  return {
    name: cam.name, host: cam.host, model: cam.model, series,
    stream: cam.stream, path: cam.path, port: cam.port, httpPort: cam.httpPort,
    user: login.user, hasPassword: !!(cam.password || login.loginFrom === 'factory'),
    loginFrom: login.loginFrom, url,
  };
}

function fillFromSystems(cfg, systems) {
  if (!systems || typeof systems !== 'object') return 0;
  const found = [];
  const conns = systems.connections || {};
  if (conns.ptz && Array.isArray(conns.ptz.cameras)) found.push(...conns.ptz.cameras);
  for (const inst of systems.instances || []) {
    if (inst && inst.type === 'ptz' && inst.connection && Array.isArray(inst.connection.cameras)) found.push(...inst.connection.cameras);
  }
  let n = 0;
  const raw = mapOf(cfg);
  for (const c of found) {
    if (!c || !isId(c.id)) continue;
    const cur = raw[c.id] && typeof raw[c.id] === 'object' ? raw[c.id] : {};
    const hostMissing = !String(cur.host || '').trim();
    const nameMissing = !String(cur.name || '').trim();
    if (!hostMissing && !nameMissing) continue;
    if (hostMissing && c.host) cur.host = String(c.host).trim().slice(0, 200);
    if (nameMissing && c.name) cur.name = String(c.name).trim().slice(0, 40);
    if (cur.httpPort == null && c.port) cur.httpPort = Number(c.port) || 80;
    if (!cur.model && c.model) cur.model = String(c.model).slice(0, 64);
    if (!cur.user && c.user) cur.user = String(c.user);
    raw[c.id] = cur;
    n += 1;
  }
  return n;
}

async function importViews(cfg, baseUrl, fetchImpl = global.fetch) {
  const root = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(root)) throw Object.assign(new Error('controlCenterUrl must be an http(s) URL'), { status: 400 });
  let res;
  try { res = await fetchImpl(`${root}/api/sys/views`); }
  catch (e) { throw Object.assign(new Error(`Control Center is not reachable (${e.message})`), { status: 502 }); }
  if (!res.ok) throw Object.assign(new Error(`Control Center returned ${res.status}`), { status: 502 });
  const body = await res.json();
  const views = body && body.views && typeof body.views === 'object' ? body.views : {};
  let n = 0;
  for (const view of Object.values(views)) {
    const cams = view && Array.isArray(view.cameras) ? view.cameras : [];
    for (const c of cams) {
      if (!c || !isId(c.id) || !c.host) continue;
      const prev = mapOf(cfg)[c.id] || {};
      apply(cfg, c.id, {
        name: c.name || prev.name || c.id,
        host: c.host,
        httpPort: c.port || prev.httpPort || 80,
        model: c.model || prev.model || '',
        user: c.user || prev.user || '',
        stream: prev.stream || 1,
        path: prev.path || '',
        port: prev.port || 554,
        password: prev.password || '',
      });
      n += 1;
    }
  }
  return n;
}

module.exports = {
  CAMERA_DEFAULTS, UE150_PATH, UE150_MODELS, seriesOf, rtspOk, isId, loginOf, list, get, apply, remove,
  rtspUrl, publicOne, fillFromSystems, importViews, normalize,
};
