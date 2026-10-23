'use strict';
// Multi-system manager (0.6.0, extended in 0.7.0, desk in 0.9.1). Several systems can be online at once: `armed`
// is the desk (tab groups that stay visible). `active` is which of those the open tab is driving. Every
// configured system is still watched for live status. Families (`kind`):
//   rs6       Analog Way Aquilon RS6: the original app (lib/engine.js, unchanged, with its own tabs)
//   preset    Barco Event Master E2 / S3 (lib/drivers/e2.js) and PixelHue (lib/drivers/pixelhue.js): presets
//             recalled to Preview on destinations, then TAKE / CUT; shared UI in public/sys.js
//   atem      Blackmagic ATEM (lib/drivers/atem.js, native UDP 9910): program / preview bus, keys, aux, macros
//   ptz       Panasonic PTZ cameras (lib/drivers/ptz.js, HTTP CGI): many cameras under one system card
//   pixera    AV Stumpfl Pixera (lib/drivers/pixera.js, JSON-RPC over TCP, default port 1400): timelines,
//             transport, next / previous cue, apply a cue by name
//   millumin  Millumin (lib/drivers/millumin.js, OSC over UDP, default port 5000): columns, transport, the
//             selected layer
// Kept per system in <dataDir>/systems.json: its connection, and its session (E2 / PixelHue: destination
// selection, tile layout, auto take; PTZ: speeds, selected camera, camera preset names). Nothing here talks to a
// system that has no address configured.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { readJson, writeJsonAtomic } = require('./store');
const { E2Driver } = require('./drivers/e2');
const { PixelHueDriver } = require('./drivers/pixelhue');
const { RS6Driver } = require('./drivers/rs6');
const { AtemDriver } = require('./drivers/atem');
const { PTZDriver, GAINS, SHUTTERS, WB, PRESET_COUNT } = require('./drivers/ptz');
const { PixeraDriver } = require('./drivers/pixera');
const { MilluminDriver } = require('./drivers/millumin');
const { MockE2 } = require('./mocks/e2');
const { MockPixelHue } = require('./mocks/pixelhue');
const { MockAtem } = require('./mocks/atem');
const ATEM_MODELS = require('./drivers/atem-models');
const { MockPTZ } = require('./mocks/ptz');
const { MockPixera } = require('./mocks/pixera');
const { MockMillumin } = require('./mocks/millumin');
const PTZC = require('./drivers/ptz-commands');

const SYSTEMS = {
  rs6: { label: 'Analog Way Aquilon RS6', short: 'RS6', kind: 'rs6', group: 'Presentation switchers' },
  e2: { label: 'Barco Event Master (E2 / S3)', short: 'E2', kind: 'preset', group: 'Presentation switchers' },
  pixelhue: { label: 'PixelHue (P10 / P20 / P80 / Q8)', short: 'PixelHue', kind: 'preset', group: 'Presentation switchers' },
  atem: { label: 'Blackmagic ATEM', short: 'ATEM', kind: 'atem', group: 'Production switchers' },
  ptz: { label: 'Panasonic PTZ cameras (AW-UE / AW-HE)', short: 'PTZ', kind: 'ptz', group: 'Cameras' },
  pixera: { label: 'AV Stumpfl Pixera', short: 'Pixera', kind: 'pixera', group: 'Media servers' },
  millumin: { label: 'Millumin', short: 'Millumin', kind: 'millumin', group: 'Media servers' },
};
const PRESET_SYS = ['e2', 'pixelhue'];
const MEDIA_SYS = ['pixera', 'millumin'];
const NET_SYS = ['e2', 'pixelhue', 'atem', 'ptz', 'pixera', 'millumin'];
const SYS_ORDER = Object.keys(SYSTEMS); // desk order: RS6, E2, PixelHue, ATEM, PTZ, Pixera, Millumin
// Next device families: a new family is one driver file in lib/drivers/ plus an entry above. Listed on the
// dashboard as planned; none right now.
const PLANNED = [];
const CONN_DEFAULTS = {
  e2: { host: '', port: 9999, operatorId: '', transTime: '' },
  pixelhue: { host: '', port: 8088, prefix: '/pixelhue', swap: true, time: '' },
  atem: { host: '', port: 9910, me: 1 },
  ptz: { cameras: [] },
  pixera: { host: '', port: 1400 },
  millumin: { host: '', port: 5000 },
};
const CONN_TYPES = { host: 'string', port: 'number', operatorId: 'string', transTime: 'string', prefix: 'string', swap: 'boolean', time: 'string', me: 'number' };
const MAX_CAMERAS = 32;
const TILE_COUNTS = [24, 48, 72, 96];
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
// 0.11.0 per-install UI preferences (ATEM audio monitor channels, PTZ dashboard panel order, …): small JSON values
// under short keys, kept in systems.json — not in show files, and saving one does not mark the show changed.
const UI_KEY = /^[A-Za-z][\w.:-]{0,63}$/; const UI_MAX_KEYS = 64; const UI_MAX_BYTES = 8192;
function cleanUiPrefs(raw) {
  const out = {}; if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) { if (Object.keys(out).length >= UI_MAX_KEYS) break; if (UI_KEY.test(k) && v !== undefined && JSON.stringify(v).length <= UI_MAX_BYTES) out[k] = v; }
  return out;
}
const emptySession = () => ({ selection: [], layout: {}, autoTake: false, tileCount: 48 });
// 0.10.0 ATEM SuperSource layouts: built-ins plus the ones saved on this install (systems.json, not in show files).
// Box units are the switcher's own: x / y x100 (-4800..4800 / -2700..2700; the screen edge is +-1600 / +-900), size x1000.
const SS_BOX_FIELDS = ['enabled', 'x', 'y', 'size', 'cropped', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'source'];
const ssb = (enabled, x, y, size, crop = {}) => ({ enabled, x, y, size, cropped: !!Object.keys(crop).length, cropTop: crop.t || 0, cropBottom: crop.b || 0, cropLeft: crop.l || 0, cropRight: crop.r || 0 });
const OFF = ssb(false, 0, 0, 500);
const SS_BUILTIN = [
  { id: 'quad', name: 'Quad', boxes: [ssb(true, -800, 450, 500), ssb(true, 800, 450, 500), ssb(true, -800, -450, 500), ssb(true, 800, -450, 500)] },
  { id: 'side-by-side', name: 'Side by side', boxes: [ssb(true, -800, 0, 500), ssb(true, 800, 0, 500), OFF, OFF] },
  { id: 'side-by-side-crop', name: 'Side by side (cropped)', boxes: [ssb(true, -800, 0, 1000, { l: 8000, r: 8000 }), ssb(true, 800, 0, 1000, { l: 8000, r: 8000 }), OFF, OFF] },
  { id: 'pip', name: 'Single + PIP', boxes: [ssb(true, 0, 0, 1000), ssb(true, 1100, -580, 280), OFF, OFF] },
  { id: 'three-up', name: 'Three up', boxes: [ssb(true, -1070, 0, 330), ssb(true, 0, 0, 330), ssb(true, 1070, 0, 330), OFF] },
  { id: 'one-plus-two', name: 'One big + two', boxes: [ssb(true, -480, 0, 700), ssb(true, 1120, 400, 300), ssb(true, 1120, -400, 300), OFF] },
].map((l) => ({ ...l, builtIn: true, boxes: l.boxes.map((b, i) => ({ box: i, ...b })) }));
function cleanSsBox(b, i) {
  const o = { box: Number.isInteger(Number(b && b.box)) ? Number(b.box) : i };
  for (const k of SS_BOX_FIELDS) { if (!b || b[k] === undefined || b[k] === null) continue; o[k] = k === 'enabled' || k === 'cropped' ? !!b[k] : Math.round(Number(b[k]) || 0); }
  return o;
}
function cleanSsLayouts(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((l) => l && typeof l.name === 'string' && Array.isArray(l.boxes)).slice(0, 100)
    .map((l) => ({ id: String(l.id || '').replace(/[^\w-]/g, '').slice(0, 40) || `u${Date.now().toString(36)}`, name: l.name.slice(0, 40), boxes: l.boxes.slice(0, 8).map(cleanSsBox), at: Number(l.at) || 0 }));
}
const emptyPtzSession = () => ({ selected: null, speeds: { pt: 25, zoom: 25, focus: 15 }, presetNames: {}, last: {}, notes: {}, locks: {}, paintMem: {} });
// Desk: systems whose tabs stay available. `active` is only which group's open tab is driving.
// A systems.json from before 0.9.2 has no `armed`. Those installs get every system that already
// has an address (RS6 always, plus ATEM / E2 / PixelHue / PTZ when configured), so the operator
// does not have to pick one on the SYSTEMS page. A file that already saved `armed` is left as-is.
function cleanArmed(list, active) {
  const focus = SYSTEMS[active] ? active : 'rs6';
  if (!Array.isArray(list)) return [focus];
  const out = [];
  for (const k of SYS_ORDER) if (list.includes(k) && !out.includes(k)) out.push(k);
  return out.length ? out : [focus];
}
function addressed(sys, conn) {
  if (sys === 'ptz') return Array.isArray(conn.cameras) && conn.cameras.some((c) => String(c.host || '').trim());
  return !!String(conn.host || '').trim();
}
// 0.9.8: the paint lock covers these command groups (shading / colour); exposure, lens, motion and presets stay live
const PAINT_GROUPS = new Set(['wb', 'paint', 'detail', 'gamma', 'knee', 'matrix', 'chroma', 'scene']);
const PAINT_MEM_SLOTS = 4;
const PTZ_SOURCES = {
  module: 'bitfocus/companion-module-panasonic-ptz v2.6.1 (src/actions.js, src/models.js)',
  spec: 'Panasonic AW-UE150 / AW-HE145 Interface Specifications v2.94 (+ Supplement for Web Control)',
};
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i;

function cleanCamera(c, i = 0) {
  const port = Number(c && c.port);
  // series: '' = detect from the camera's model (camdata OID), or a series id from the Companion module's table
  const series = c && c.series && PTZC.DATA.series[c.series] ? String(c.series) : '';
  return { id: /^[\w-]{1,40}$/.test(String(c && c.id)) ? String(c.id) : `cam${i + 1}`, name: String((c && c.name) || `Camera ${i + 1}`).trim().slice(0, 40) || `Camera ${i + 1}`,
    host: String((c && c.host) || '').trim().slice(0, 200), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 80, ...(series ? { series } : {}) };
}
function cleanConn(sys, c) {
  if (sys === 'ptz') {
    const seen = new Set(); const cams = [];
    for (const [i, x] of (Array.isArray(c && c.cameras) ? c.cameras : []).slice(0, MAX_CAMERAS).entries()) { const cam = cleanCamera(x, i); if (seen.has(cam.id)) continue; seen.add(cam.id); cams.push(cam); }
    return { cameras: cams };
  }
  const out = { ...CONN_DEFAULTS[sys] };
  for (const [k, v] of Object.entries(c || {})) {
    if (!(k in out)) continue;
    const t = CONN_TYPES[k];
    if (t === 'number') { const n = Number(v); if (Number.isFinite(n) && n > 0 && n < 65536) out[k] = n; }
    else if (t === 'boolean') out[k] = !!v;
    else out[k] = String(v ?? '').trim().slice(0, 200);
  }
  if (sys === 'pixelhue' && out.prefix && !out.prefix.startsWith('/')) out.prefix = `/${out.prefix}`;
  if (sys === 'atem') out.me = Math.max(1, Math.min(4, Math.round(Number(out.me) || 1)));
  return out;
}

class SystemManager extends EventEmitter {
  constructor({ dataDir, engine, overrides = {}, pollMs = 3000, refreshMs = 15000, autoStart = true } = {}) {
    super();
    this.engine = engine; this.dataDir = dataDir; this.overrides = overrides; this.pollMs = pollMs; this.refreshMs = refreshMs;
    // Session simulators (ADD TO DESK AS SIMULATOR). Created before the first save so a restart never
    // remembers one. The saved address stays in cfg.connections; the fixture address lives only here.
    this.sim = {};
    this.file = path.join(dataDir, 'systems.json');
    const had = fs.existsSync(this.file);
    const raw = readJson(this.file, {});
    const active = SYSTEMS[raw.active] ? raw.active : 'rs6';
    const hadArmed = Array.isArray(raw.armed);
    this.cfg = {
      version: 1,
      active,
      armed: hadArmed ? cleanArmed(raw.armed, active) : [active],
      connections: Object.fromEntries(NET_SYS.map((k) => [k, cleanConn(k, raw.connections && raw.connections[k])])),
      sessions: { e2: { ...emptySession(), ...(raw.sessions && raw.sessions.e2) }, pixelhue: { ...emptySession(), ...(raw.sessions && raw.sessions.pixelhue) },
        ptz: { ...emptyPtzSession(), ...(raw.sessions && raw.sessions.ptz) },
        atem: { ssLayouts: cleanSsLayouts(raw.sessions && raw.sessions.atem && raw.sessions.atem.ssLayouts) } },
      ui: cleanUiPrefs(raw.ui),
    };
    if (had && !hadArmed) {
      const keys = ['rs6', active];
      for (const k of NET_SYS) if (addressed(k, this.cfg.connections[k])) keys.push(k);
      this.cfg.armed = cleanArmed(keys, active);
    }
    // Mock mode (--mock): PTZ cameras live in memory only. A session simulator sets mockCams itself;
    // the constructor only fills it from the startup override.
    this.mockCams = overrides.ptz ? cleanConn('ptz', overrides.ptz).cameras : null;
    // Migration (0.5.0 -> 0.6.0): an existing install has only settings.json. Its RS6 connection stays where it
    // is (the Engine owns it); the new file records that RS6 is the selected system so nothing changes for it.
    this.migrated = null;
    if (!had) {
      const s = engine ? engine.settings : {};
      this.migrated = { from: '0.5.0 settings.json', rs6: { host: s.host, restPort: s.restPort, awjPort: s.awjPort }, at: new Date().toISOString() };
      this.cfg.migrated = this.migrated;
      this.save();
    } else {
      this.migrated = raw.migrated || null;
      if (!hadArmed) this.save(); // remember the upgraded desk so REMOVE stays off
    }
    this.drivers = {
      rs6: engine ? new RS6Driver(engine) : null,
      e2: new E2Driver(this.conn('e2'), (l, m) => this.log(l, m)),
      pixelhue: new PixelHueDriver(this.conn('pixelhue'), (l, m) => this.log(l, m)),
      atem: new AtemDriver(this.conn('atem'), (l, m) => this.log(l, m), () => this.changed()),
      ptz: new PTZDriver(this.conn('ptz'), (l, m) => this.log(l, m)),
      pixera: new PixeraDriver(this.conn('pixera'), (l, m) => this.log(l, m), () => this.changed()),
      millumin: new MilluminDriver(this.conn('millumin'), (l, m) => this.log(l, m), () => this.changed()),
    };
    this.cache = { e2: this.emptyCache(), pixelhue: this.emptyCache() };
    this.tally = { e2: { pvw: {}, pgm: {}, last: null }, pixelhue: { pvw: {}, pgm: {}, last: null } };
    this.rev = 1; this._timers = [];
    this._chain = Promise.resolve();
    this._ready = true;
    if (engine) engine.showHooks = { build: (o) => this.showPart(o), apply: (show, o) => this.applyShowPart(show, o) };
    if (autoStart) this.start();
  }
  emptyCache() { return { destinations: [], presets: [], sources: [], cues: [], stills: [], backups: [], refreshedAt: 0, errors: {} }; }
  log(level, msg) { if (this.engine) this.engine.log(level, msg); }
  exclusive(fn) { const p = this._chain.then(fn, fn); this._chain = p.catch(() => {}); return p; }
  changed() { this.rev++; this.emit('state'); }
  // A simulator is session-only. systems.json and show files keep the real desk and the saved address.
  persistedCfg() {
    const sim = this.sim || {};
    if (!Object.keys(sim).length) return this.cfg;
    const armed = this.cfg.armed.filter((k) => !sim[k]);
    const desk = armed.length ? armed : ['rs6'];
    const active = sim[this.cfg.active] ? desk[0] : this.cfg.active;
    return { ...this.cfg, armed: desk, active };
  }
  uiPrefs() { return { ...this.cfg.ui }; }
  setUiPref(key, value) {
    const k = String(key); if (!UI_KEY.test(k)) throw err('A preference key is a letter then up to 63 letters, digits, _ . : -');
    if (value === null || value === undefined) delete this.cfg.ui[k];
    else {
      if (JSON.stringify(value).length > UI_MAX_BYTES) throw err(`A preference is at most ${UI_MAX_BYTES} bytes`);
      if (!(k in this.cfg.ui) && Object.keys(this.cfg.ui).length >= UI_MAX_KEYS) throw err(`At most ${UI_MAX_KEYS} preferences`);
      this.cfg.ui[k] = value;
    }
    writeJsonAtomic(this.file, this.persistedCfg()); this.emit('uiPrefs', k);
    return { key: k, value: this.cfg.ui[k] === undefined ? null : this.cfg.ui[k] };
  }
  save() { writeJsonAtomic(this.file, this.persistedCfg()); if (this.engine && this.engine.changed && this._ready) this.engine.changed(); } // engine.changed: the show dirty dot
  conn(sys) {
    if (sys === 'ptz') return { cameras: (this.mockCams || this.cfg.connections.ptz.cameras).map((c) => ({ ...c })) };
    return { ...this.cfg.connections[sys], ...(this.overrides[sys] || {}) };
  }
  configured(sys) { const c = this.conn(sys); return sys === 'ptz' ? c.cameras.length > 0 : !!c.host; }
  isMock(sys) { return !!this.overrides[sys]; }
  sess(sys) { this.check(sys, true); return this.cfg.sessions[sys]; }
  ptzSess() { return this.cfg.sessions.ptz; }
  // check(sys, true): a preset system (E2 / PixelHue); check(sys, 'atem' | 'ptz' | 'pixera' | 'millumin'): that family; check(sys): any
  check(sys, want = false) {
    if (!SYSTEMS[sys]) throw err(`Unknown system "${sys}"`, 404);
    if (want === true && SYSTEMS[sys].kind !== 'preset') throw err(sys === 'rs6' ? 'The RS6 uses its own tabs (/api/...)' : `The ${SYSTEMS[sys].short} has no presets / destinations API here`);
    if (typeof want === 'string' && SYSTEMS[sys].kind !== want) throw err(`Not available on the ${SYSTEMS[sys].short}`);
  }

  // ---------- lifecycle ----------
  start() {
    this.stop();
    // Live status for the dashboard: every system that has a connection configured is watched (heartbeat only;
    // a system with no IP is never contacted). Armed preset systems also get their lists refreshed.
    const tick = () => Promise.all(NET_SYS.map((sys) => this._tick(sys)));
    const refresh = async () => { for (const sys of PRESET_SYS) if (this.drivers[sys].status().connected && (this.armed(sys) || Date.now() - this.cache[sys].refreshedAt > 60000)) await this.refresh(sys).catch(() => {}); };
    this._timers.push(setInterval(tick, this.pollMs), setInterval(refresh, this.refreshMs));
    for (const t of this._timers) if (t.unref) t.unref();
    for (const sys of NET_SYS) if (this.configured(sys)) this.connect(sys, { quiet: sys !== this.cfg.active }).catch(() => {});
  }
  async _tick(sys) {
    this._busy = this._busy || {};
    if (this._busy[sys]) return; // a slow / unreachable device: never stack attempts
    this._busy[sys] = true;
    try {
      const d = this.drivers[sys]; if (!this.configured(sys)) return;
      const was = d.status().connected;
      const snap = sys === 'ptz' ? this._ptzSnap() : null;
      try {
        if (!was) await this.connect(sys, { quiet: true });
        else await d.heartbeat();
      } catch { /* status carries the error */ }
      if (sys === 'ptz' && was && snap !== this._ptzSnap()) this.changed(); // a camera came / went, power, tally
      if (was !== d.status().connected) { this.log(d.status().connected ? 'info' : 'warn', `${SYSTEMS[sys].short}: ${d.status().connected ? 'connected' : `connection lost (${d.status().error})`}`); this.changed(); }
    } finally { this._busy[sys] = false; }
  }
  _ptzSnap() { return JSON.stringify(this.drivers.ptz.cameraList().map(({ lastSeen, ...c }) => c)); }
  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }
  close() {
    this.stop();
    const stops = [];
    for (const k of Object.keys(this.sim)) {
      const s = this.sim[k];
      delete this.sim[k];
      delete this.overrides[k];
      stops.push(Promise.resolve().then(() => s.stop()).catch(() => {}));
    }
    if (!this.overrides.ptz) this.mockCams = null;
    for (const d of Object.values(this.drivers)) if (d) d.close();
    return Promise.all(stops);
  }

  async setActive(sys) {
    this.check(sys);
    const added = !this.cfg.armed.includes(sys);
    if (this.cfg.active !== sys || added) {
      this.cfg.active = sys;
      if (added) this.cfg.armed = cleanArmed([...this.cfg.armed, sys], sys);
      this.save();
      this.log('info', added ? `Desk: ${SYSTEMS[sys].label} online` : `System: ${SYSTEMS[sys].label}`);
      this.changed();
    }
    if (sys !== 'rs6' && this.configured(sys) && !this.drivers[sys].status().connected) await this.connect(sys).catch(() => {});
    else if (PRESET_SYS.includes(sys) && this.drivers[sys].status().connected) await this.refresh(sys).catch(() => {});
    return this.getState();
  }
  armed(sys) { return this.cfg.armed.includes(sys); }
  // A system that just got an address joins the desk. It does not take focus and it does not drop the others.
  noteConfigured(sys) {
    if (!SYSTEMS[sys] || this.cfg.armed.includes(sys) || !this.configured(sys)) return false;
    this.cfg.armed = cleanArmed([...this.cfg.armed, sys], this.cfg.active);
    this.log('info', `Desk: ${SYSTEMS[sys].label} online`);
    return true;
  }
  // Turn a system on or off the desk without dropping the others. On focuses it. Off, if it was focused,
  // focuses the first system still on the desk (never an empty desk). A simulator may leave even when it
  // is the only one: the desk goes back to RS6 and the fixture stops.
  async setArmed(sys, on) {
    this.check(sys);
    const want = !!on;
    if (want) return this.setActive(sys);
    if (!this.cfg.armed.includes(sys)) return this.getState();
    const sim = !!(this.sim && this.sim[sys]);
    if (!sim && this.cfg.armed.length === 1) throw err(`The ${SYSTEMS[sys].short} is the only system on the desk`);
    if (sim) await this.stopSim(sys);
    this.cfg.armed = this.cfg.armed.filter((k) => k !== sys);
    if (!this.cfg.armed.length) {
      this.cfg.armed = ['rs6'];
      this.cfg.active = 'rs6';
    } else if (this.cfg.active === sys) {
      this.cfg.active = this.cfg.armed[0];
      this.log('info', `System: ${SYSTEMS[this.cfg.active].label}`);
    }
    this.save();
    this.log('info', `Desk: ${SYSTEMS[sys].label} offline`);
    this.changed();
    const focus = this.cfg.active;
    if (focus !== 'rs6' && this.configured(focus) && !this.drivers[focus].status().connected) await this.connect(focus).catch(() => {});
    else if (PRESET_SYS.includes(focus) && this.drivers[focus].status().connected) await this.refresh(focus).catch(() => {});
    return this.getState();
  }
  updateConnection(sys, patch) {
    this.check(sys);
    if (sys === 'rs6') throw err('The RS6 connection is saved through /api/settings');
    if (sys === 'ptz') return this.setCameras((patch && patch.cameras) || []);
    if (this.isMock(sys)) throw err(`Mock mode: the ${SYSTEMS[sys].short} connection is fixed to the built-in mock`, 409);
    this.cfg.connections[sys] = cleanConn(sys, { ...this.cfg.connections[sys], ...patch });
    this.noteConfigured(sys);
    this.save();
    this.drivers[sys].close(); this.drivers[sys].configure(this.conn(sys));
    if (this.cache[sys]) this.cache[sys] = this.emptyCache();
    const c = this.cfg.connections[sys];
    this.log('info', `${SYSTEMS[sys].short} connection saved: ${c.host || '(no IP)'}:${c.port}`);
    this.changed();
    return this.publicConn(sys);
  }
  publicConn(sys) { const sim = this.sim && this.sim[sys]; return { ...this.conn(sys), mock: this.isMock(sys), simulator: !!sim, ...(sim && sim.model ? { simulatorModel: sim.model } : {}) }; }

  // ADD TO DESK AS SIMULATOR. Starts that system's built-in loopback fixture, puts it on the desk and
  // focuses it. The fixture address is not written into systems.json or a show. RS6 is never replaced.
  // A system already on the desk (a live ATEM, for example) is left alone until it is removed.
  async simulate(sys, opts = {}) {
    this.check(sys);
    const model = sys === 'atem' ? String((opts && opts.model) || ATEM_MODELS.DEFAULT) : null;
    if (model && !ATEM_MODELS.profile(model)) throw err(`Unknown ATEM model "${model}" (GET /api/sys/atem/models)`);
    let swap = false; let restore = null;
    if (model && this.sim.atem && this.sim.atem.model !== model) { restore = this.sim.atem.restore || null; await this.stopSim('atem'); swap = true; } // switch the simulated model
    if (sys === 'rs6') throw err('The RS6 stays on its live connection. Simulators are for the other systems.');
    if (this.sim[sys]) return this.setActive(sys);
    // 0.10.0: in mock mode the ATEM model picker swaps the built-in mock for the chosen model (REMOVE / restart restores it)
    if (!swap && sys === 'atem' && opts && opts.model && this.isMock('atem')) { restore = this.overrides.atem; swap = true; }
    if (!swap && this.isMock(sys)) throw err(`Mock mode: the ${SYSTEMS[sys].short} connection is already the built-in mock`, 409);
    if (!swap && this.cfg.armed.includes(sys)) throw err(`The ${SYSTEMS[sys].short} is already on the desk. REMOVE FROM DESK before starting a simulator.`, 409);
    const fix = await this.startFixture(sys, { model });
    fix.restore = restore;
    try {
      this.sim[sys] = fix;
      this.overrides[sys] = fix.conn;
      if (sys === 'ptz') this.mockCams = cleanConn('ptz', fix.conn).cameras;
      const d = this.drivers[sys];
      d.close();
      d.configure(this.conn(sys));
      if (this.cache[sys]) this.cache[sys] = this.emptyCache();
      this.log('info', `${SYSTEMS[sys].short}: simulator${model ? ` (${ATEM_MODELS.profile(model).name})` : ''} on 127.0.0.1 (not saved)`);
      return await this.setActive(sys);
    } catch (e) {
      await this.stopSim(sys);
      throw e;
    }
  }
  async stopSim(sys) {
    const s = this.sim[sys];
    if (!s) return;
    delete this.sim[sys];
    if (s.restore) this.overrides[sys] = s.restore; else delete this.overrides[sys];
    if (sys === 'ptz') this.mockCams = this.overrides.ptz ? cleanConn('ptz', this.overrides.ptz).cameras : null;
    const d = this.drivers[sys];
    if (d) d.close();
    if (d) d.configure(this.conn(sys));
    if (this.cache[sys]) this.cache[sys] = this.emptyCache();
    this.changed();
    try { await s.stop(); } catch { /* already stopped */ }
  }
  async startFixture(sys, { model } = {}) {
    const stopAll = async (list) => { for (const m of list) { try { await m.stop(); } catch { /* already stopped */ } } };
    const one = async (make, conn) => {
      const m = make();
      try {
        const port = await m.start(0, '127.0.0.1');
        return { conn: conn(port), stop: () => m.stop(), model: m.model };
      } catch (e) { await stopAll([m]); throw e; }
    };
    if (sys === 'e2') return one(() => new MockE2(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'pixelhue') return one(() => new MockPixelHue(), (port) => ({ host: '127.0.0.1', port, prefix: '/pixelhue' }));
    if (sys === 'atem') return one(() => new MockAtem({ model: model || ATEM_MODELS.DEFAULT }), (port) => ({ host: '127.0.0.1', port, me: 1 }));
    if (sys === 'pixera') return one(() => new MockPixera(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'millumin') return one(() => new MockMillumin(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'ptz') {
      const cams = [['Cam 1 Wide', 'AW-UE150'], ['Cam 2 Stage', 'AW-UE100'], ['Cam 3 Lectern', 'AW-HE130']];
      const mocks = []; const cameras = [];
      try {
        for (const [i, [name, model]] of cams.entries()) {
          const m = new MockPTZ({ model, title: name.toUpperCase().replace(/\s+/g, '-') });
          mocks.push(m);
          cameras.push({ id: `cam${i + 1}`, name, host: '127.0.0.1', port: await m.start(0, '127.0.0.1') });
        }
        return { conn: { cameras }, stop: () => stopAll(mocks) };
      } catch (e) { await stopAll(mocks); throw e; }
    }
    throw err(`The ${SYSTEMS[sys].short} has no simulator`);
  }

  // ---------- PTZ cameras (many under one system) ----------
  setCameras(list) {
    const clean = cleanConn('ptz', { cameras: list }).cameras;
    if (this.mockCams) {
      const bad = clean.find((c) => c.host && !LOOPBACK.test(c.host));
      if (bad) throw err(`Mock mode: cameras must be local mocks (127.0.0.1), not ${bad.host}`, 409);
      this.mockCams = clean;
    } else { this.cfg.connections.ptz = { cameras: clean }; }
    const s = this.ptzSess(); const ids = new Set(clean.map((c) => c.id));
    if (s.selected && !ids.has(s.selected)) s.selected = clean.length ? clean[0].id : null;
    if (!s.selected && clean.length) s.selected = clean[0].id;
    this.noteConfigured('ptz');
    this.save();
    this.drivers.ptz.configure(this.conn('ptz'));
    this.changed();
    return this.publicConn('ptz');
  }
  addCamera(c) {
    const cams = this.conn('ptz').cameras;
    if (cams.length >= MAX_CAMERAS) throw err(`At most ${MAX_CAMERAS} cameras`);
    if (!c || !String(c.host || '').trim()) throw err('Camera IP address is required');
    let n = cams.length + 1; while (cams.some((x) => x.id === `cam${n}`)) n++;
    const cam = cleanCamera({ ...c, id: `cam${n}`, name: c.name || `Camera ${n}` }, n - 1);
    this.setCameras([...cams, cam]);
    this.log('info', `PTZ: added ${cam.name} (${cam.host}:${cam.port})`);
    this.drivers.ptz.poll(cam.id).then(() => this.changed(), () => this.changed());
    return cam;
  }
  updateCamera(id, patch) {
    const cams = this.conn('ptz').cameras; const i = cams.findIndex((x) => x.id === id);
    if (i < 0) throw err(`No camera "${id}"`, 404);
    cams[i] = cleanCamera({ ...cams[i], ...patch, id }, i); this.setCameras(cams);
    this.drivers.ptz.poll(id).then(() => this.changed(), () => this.changed());
    return cams[i];
  }
  removeCamera(id) {
    const cams = this.conn('ptz').cameras; const c = cams.find((x) => x.id === id);
    if (!c) throw err(`No camera "${id}"`, 404);
    this.drivers.ptz.stop(id).catch(() => {});
    this.setCameras(cams.filter((x) => x.id !== id));
    const z = this.ptzSess(); for (const k of ['presetNames', 'last', 'notes', 'locks', 'paintMem']) if (z[k]) delete z[k][id]; this.save();
    this.log('info', `PTZ: removed ${c.name}`);
    return { ok: true };
  }

  async connect(sys, { quiet = false } = {}) {
    this.check(sys);
    if (sys === 'rs6') throw err('The RS6 connects through /api/settings');
    const d = this.drivers[sys];
    try {
      const info = await d.connect();
      if (!quiet) this.log('info', `${SYSTEMS[sys].short} connected: ${(info && info.model) || ''} ${(info && info.version) || ''}${sys === 'ptz' ? '' : ` at ${this.conn(sys).host}`}`);
      if (PRESET_SYS.includes(sys)) await this.refresh(sys);
      else if (sys === 'pixera') await this.drivers.pixera.load();
    } catch (e) {
      if (!quiet) this.log('error', `${SYSTEMS[sys].short} connect failed: ${e.message}`);
      this.changed(); throw e;
    }
    this.changed();
    return d.status();
  }
  async refresh(sys) {
    if (sys === 'ptz') { await this.drivers.ptz.heartbeat().catch(() => {}); this.changed(); return {}; }
    if (sys === 'atem' || sys === 'millumin') { this.changed(); return {}; } // ATEM pushes its state; Millumin only answers when feedback is on
    if (sys === 'pixera') { await this.drivers.pixera.refresh(); this.changed(); return this.drivers.pixera.view(); }
    this.check(sys, true);
    const d = this.drivers[sys]; const c = this.cache[sys]; const caps = d.capabilities;
    const errors = {};
    const grab = async (name, fn) => { try { c[name] = await fn(); } catch (e) { errors[name] = e.message; } };
    await grab('destinations', () => d.listDestinations());
    await grab('presets', () => d.listPresets());
    if (caps.sources) await grab('sources', () => d.listSources());
    if (caps.cues) await grab('cues', () => d.listCues());
    if (caps.stills) await grab('stills', () => d.listStills());
    if (caps.backups) await grab('backups', () => d.listBackups());
    c.errors = errors; c.refreshedAt = Date.now();
    const keys = new Set(c.destinations.map((x) => x.key));
    const s = this.sess(sys); const before = s.selection.length; s.selection = s.selection.filter((k) => keys.has(k) || !c.destinations.length);
    if (before !== s.selection.length) this.save();
    for (const [n, m] of Object.entries(errors)) this.log('warn', `${SYSTEMS[sys].short}: could not read ${n} (${m})`);
    this.changed();
    return c;
  }

  // ---------- selection, recall, take, cut ----------
  allKeys(sys) { return this.cache[sys].destinations.map((x) => x.key); }
  async setSelection(sys, keys) {
    const s = this.sess(sys); const valid = new Set(this.allKeys(sys));
    s.selection = [...new Set((keys || []).map((k) => String(k).toUpperCase()))].filter((k) => !valid.size || valid.has(k));
    this.save(); this.changed();
    if (this.drivers[sys].capabilities.armDestinations && this.drivers[sys].status().connected) {
      try { await this.drivers[sys].select(s.selection, this.allKeys(sys)); } catch (e) { this.log('warn', `${SYSTEMS[sys].short}: arm destinations failed (${e.message})`); }
    }
    return s.selection;
  }
  toggleDest(sys, key) { const s = this.sess(sys); const k = String(key).toUpperCase(); return this.setSelection(sys, s.selection.includes(k) ? s.selection.filter((x) => x !== k) : [...s.selection, k]); }
  preset(sys, key) {
    const p = this.cache[sys].presets.find((x) => x.key === key || String(x.tile) === String(key));
    if (p) return p;
    const v = this.view(sys).presets.find((x) => x.key === key || String(x.tile) === String(key));
    if (!v) throw err(`No preset "${key}" on the ${SYSTEMS[sys].short}`, 404);
    return this.cache[sys].presets.find((x) => x.key === v.key);
  }
  async recall(sys, key, { target = 'preview' } = {}) {
    if (!this.cache[sys].presets.length && this.conn(sys).host) { if (this.drivers[sys].status().connected) await this.refresh(sys); else await this.connect(sys); } // not polled yet
    return this.exclusive(async () => {
      const p = this.preset(sys, key); const d = this.drivers[sys]; const t = this.tally[sys];
      await d.recall(p, { target });
      const dests = p.dests || this.sess(sys).selection;
      for (const k of dests) { if (target === 'program') t.pgm[k] = p.key; else t.pvw[k] = p.key; }
      t.last = p.key;
      this.log('info', `${SYSTEMS[sys].short}: recalled preset ${p.sno || p.number} "${p.name}" to ${target === 'program' ? 'PGM' : 'PVW'}${p.dests ? ` on ${p.dests.join(', ') || 'no destinations'}` : ''}`);
      this.changed();
      if (target === 'preview' && this.sess(sys).autoTake) await this._transition(sys, 'take');
      return { ok: true, preset: p.key, dests };
    });
  }
  take(sys) { return this.exclusive(() => this._transition(sys, 'take')); }
  cut(sys) { return this.exclusive(() => this._transition(sys, 'cut')); }
  async _transition(sys, kind) {
    const s = this.sess(sys); const d = this.drivers[sys]; const c = this.conn(sys);
    if (!s.selection.length) throw err(`${kind.toUpperCase()}: no destinations selected`, 409);
    const opts = { allKeys: this.allKeys(sys) };
    if (sys === 'e2' && kind === 'take') opts.transTime = c.transTime;
    if (sys === 'pixelhue' && kind === 'take') opts.time = c.time;
    await d[kind](s.selection, opts);
    const t = this.tally[sys]; const swap = sys === 'pixelhue' && c.swap;
    for (const k of s.selection) {
      const pv = t.pvw[k]; const pg = t.pgm[k];
      if (pv !== undefined) t.pgm[k] = pv;
      if (swap) { if (pg !== undefined) t.pvw[k] = pg; else delete t.pvw[k]; }
    }
    this.log('info', `${SYSTEMS[sys].short}: ${kind.toUpperCase()} on ${s.selection.join(', ')}`);
    this.changed();
    return { done: [...s.selection] };
  }
  setAutoTake(sys, v) { const s = this.sess(sys); s.autoTake = v === undefined ? !s.autoTake : !!v; this.save(); this.changed(); return s.autoTake; }
  setTileCount(sys, n) { const s = this.sess(sys); if (!TILE_COUNTS.includes(Number(n))) throw err('Tile count must be 24, 48, 72 or 96'); s.tileCount = Number(n); this.save(); this.changed(); return s.tileCount; }

  // MOVE / swap: tile positions are the app's own (the device numbering is never changed)
  swapTiles(sys, a, b) {
    const v = this.view(sys); const s = this.sess(sys);
    const pa = v.presets.find((p) => p.tile === Number(a)); const pb = v.presets.find((p) => p.tile === Number(b));
    if (!pa) throw err(`Tile ${a} is empty`);
    s.layout = { ...s.layout };
    for (const p of v.presets) s.layout[p.key] = p.tile; // freeze the current layout before changing it
    s.layout[pa.key] = Number(b); if (pb) s.layout[pb.key] = Number(a);
    this.save(); this.log('info', `${SYSTEMS[sys].short}: ${pb ? `swapped tiles ${a} and ${b}` : `moved tile ${a} to ${b}`}`); this.changed();
    return { a: Number(a), b: Number(b), swapped: !!pb };
  }
  resetLayout(sys) { this.sess(sys).layout = {}; this.save(); this.changed(); }

  // ---------- extras ----------
  async cue(sys, id, action) { const d = this.drivers[sys]; if (!d.capabilities.cues) throw err('This system has no cues in its API', 409); await d.activateCue(id, action); this.log('info', `${SYSTEMS[sys].short}: cue ${id} ${action}`); return { ok: true }; }
  async freeze(sys, kind, id, on) { const d = this.drivers[sys]; if (!d.capabilities.freeze) throw err('Freeze is not in this system\'s API', 409); await d.freeze(kind, id, on); this.log('info', `${SYSTEMS[sys].short}: ${on ? 'freeze' : 'unfreeze'} ${kind} ${id}`); await this.refresh(sys).catch(() => {}); return { ok: true }; }
  async routeAux(sys, aux, source, target) { const d = this.drivers[sys]; if (!d.capabilities.auxRoute) throw err('Aux routing is not in this system\'s API', 409); await d.routeAux(aux, source, target); this.log('info', `${SYSTEMS[sys].short}: source ${source} -> ${aux} ${target === 'program' ? 'PGM' : 'PVW'}`); return { ok: true }; }
  async backup(sys, input, slot) { const d = this.drivers[sys]; if (!d.capabilities.backups) throw err('Backups are not in this system\'s API', 409); await d.selectBackup(input, slot); this.log('info', `${SYSTEMS[sys].short}: input ${input} -> ${Number(slot) < 0 ? 'primary' : `backup ${Number(slot) + 1}`}`); await this.refresh(sys).catch(() => {}); return { ok: true }; }
  async takeStill(sys, input, file) { const d = this.drivers[sys]; if (!d.capabilities.stills) throw err('Stills are not in this system\'s API', 409); await d.takeStill(input, file); this.log('info', `${SYSTEMS[sys].short}: captured still ${Number(file) + 1} from input ${input}`); await this.refresh(sys).catch(() => {}); return { ok: true }; }
  async deleteStill(sys, id) { const d = this.drivers[sys]; if (!d.capabilities.stills) throw err('Stills are not in this system\'s API', 409); await d.deleteStill(id); this.log('info', `${SYSTEMS[sys].short}: deleted still ${id}`); await this.refresh(sys).catch(() => {}); return { ok: true }; }

  // ---------- ATEM ----------
  // Every ATEM operation the UI / API may run, with the log line it writes (null = not logged: bus selections are
  // frequent and the switcher's own state shows them).
  async atem(name, b = {}) {
    const d = this.drivers.atem; const v = () => d.view();
    const nm = (id) => { const i = v().inputs.find((x) => x.id === Number(id)); return i ? i.long || i.short : `source ${id}`; };
    const on = b.on === undefined ? undefined : !!b.on;
    const me = b.me === undefined || b.me === null || b.me === '' ? undefined : Number(b.me) - 1;
    const usk = () => `${v().mixEffects.length > 1 ? `M/E ${(me === undefined ? d.me : me) + 1} ` : ''}USK ${Number(b.key) + 1}`;
    const ssI = () => (b.ss === undefined ? 0 : Number(b.ss));
    const IDS = new Set(['me', 'key', 'ss', 'box', 'mv', 'window']);
    const vals = (x) => Object.fromEntries(Object.entries(x || {}).filter(([k]) => !IDS.has(k)));
    const outName = (k) => { const o = v().outputs.find((x) => x.key === String(k)); return o ? o.label : String(k); };
    const aName = (id) => { const a = v().audio; const x = a && a.inputs.find((i) => i.id === Number(id)); return x ? x.name : `input ${id}`; };
    const rName = (kind, id) => { const a = v().audio; const x = a && a.routing && a.routing[kind].find((i) => i.id === Number(id)); return x ? x.name : String(id); };
    // 0.11.0: every bus / transition op takes an optional 1-based `me` (default: the connection's M/E)
    const meL = () => { const n = v().mixEffects.length; return n > 1 ? `M/E ${(me === undefined ? d.me : me) + 1} ` : ''; };
    const mv = () => v().mes[me === undefined ? d.me : me] || {};
    const ops = {
      cut: [() => d.cut(me), () => `${meL()}CUT`],
      auto: [() => d.auto(me), () => `${meL()}AUTO (${mv().style} ${mv().mixRate} fr)`],
      program: [() => d.program(b.source, me), () => `${meL()}PGM ← ${nm(b.source)}`],
      preview: [() => d.preview(b.source, me), null],
      style: [() => d.style(b.style, me), () => `${meL()}transition style ${String(b.style).toUpperCase()}`],
      mixRate: [() => d.mixRate(b.rate, me), () => `${meL()}mix rate ${b.rate} frames`],
      ftb: [() => d.ftb(me), () => `${meL()}FADE TO BLACK`],
      ftbRate: [() => d.ftbRate(b.rate, me), () => `${meL()}FTB rate ${b.rate} frames`],
      nextSelection: [() => d.nextSelection(b.selection, me), null],
      uskTie: [() => d.uskTie(b.key, on, me), null],
      uskOnAir: [() => d.uskOnAir(b.key, on, me), () => `${usk()} ${on ? 'ON AIR' : 'off'}`],
      dskAuto: [() => d.dskAuto(b.key), () => `DSK ${Number(b.key) + 1} AUTO`],
      dskOnAir: [() => d.dskOnAir(b.key, on), () => `DSK ${Number(b.key) + 1} ${on ? 'ON AIR' : 'off'}`],
      dskTie: [() => d.dskTie(b.key, on), null],
      aux: [() => d.aux(b.aux, b.source), () => `AUX ${Number(b.aux) + 1} ← ${nm(b.source)}`],
      macroRun: [() => d.macroRun(b.macro), () => `macro ${Number(b.macro) + 1} "${(v().macros.find((m) => m.index === Number(b.macro)) || {}).name || ''}" run`],
      macroStop: [() => d.macroStop(), () => 'macro stop'],
      // 0.10.0. `me` is 1-based like the connection's M/E (default: that one); key / dsk / aux / mv / window / ss / box are 0-based like key and aux above.
      route: [() => d.route(b.output, b.source), () => `${outName(b.output)} ← ${nm(b.source)}`],
      mvSource: [() => d.mvSource(b.mv, b.window, b.source), () => `MV ${Number(b.mv) + 1} window ${Number(b.window) + 1} ← ${nm(b.source)}`],
      uskType: [() => d.uskType(me, b.key, b.type, b.flyEnabled), () => `${usk()} type ${b.type !== undefined ? String(b.type).toUpperCase() : ''}${b.flyEnabled !== undefined ? ` fly ${b.flyEnabled ? 'on' : 'off'}` : ''}`],
      uskSources: [() => d.uskSources(me, b.key, b), () => `${usk()} ${b.fill !== undefined ? `fill ← ${nm(b.fill)} ` : ''}${b.cut !== undefined ? `key ← ${nm(b.cut)}` : ''}`.trim()],
      uskLuma: [() => d.uskLuma(me, b.key, vals(b)), null], uskChroma: [() => d.uskChroma(me, b.key, vals(b)), null], uskPattern: [() => d.uskPattern(me, b.key, vals(b)), null],
      uskMask: [() => d.uskMask(me, b.key, vals(b)), null], uskDve: [() => d.uskDve(me, b.key, vals(b)), null],
      uskFlyStore: [() => d.uskFlyStore(me, b.key, b.frame), () => `${usk()} store key frame ${String(b.frame).toUpperCase()}`],
      uskFlyRun: [() => d.uskFlyRun(me, b.key, b.frame, b.direction), () => `${usk()} run to ${String(b.frame).toUpperCase()}`],
      dskSources: [() => d.dskSources(b.key, b), () => `DSK ${Number(b.key) + 1} ${b.fill !== undefined ? `fill ← ${nm(b.fill)} ` : ''}${b.cut !== undefined ? `key ← ${nm(b.cut)}` : ''}`.trim()],
      dskGeneral: [() => d.dskGeneral(b.key, vals(b)), null], dskMask: [() => d.dskMask(b.key, vals(b)), null],
      dskRate: [() => d.dskRate(b.key, b.rate), () => `DSK ${Number(b.key) + 1} rate ${b.rate} frames`],
      ssBox: [() => d.ssBox(ssI(), b.box, vals(b)), () => (b.source !== undefined ? `SuperSource ${ssI() + 1} box ${Number(b.box) + 1} ← ${nm(b.source)}` : null)],
      ssProps: [() => d.ssProps(ssI(), vals(b)), null], ssBorder: [() => d.ssBorder(ssI(), vals(b)), null],
      ssLayoutRecall: [() => { const l = this.ssLayout(b.layout); return d.ssLayout(ssI(), l.boxes, !!b.withSources); }, () => `SuperSource ${ssI() + 1} layout "${this.ssLayout(b.layout).name}"${b.withSources ? ' (with sources)' : ''}`],
      audioInput: [() => d.audioInput(b.input, b), null],
      audioMute: [() => d.audioMute(b.input, b.mute === undefined ? 'toggle' : b.mute === 'toggle' ? 'toggle' : !!b.mute), () => `audio ${aName(b.input)} ${b.mute === undefined || b.mute === 'toggle' ? 'mute toggled' : b.mute ? 'MUTED' : 'on'}`],
      audioNudge: [() => d.audioNudge(b.input, b.delta), null],
      audioMaster: [() => d.audioMaster(b), null], audioMasterNudge: [() => d.audioMasterNudge(b.delta), null],
      audioMonitor: [() => d.audioMonitor(b), null], audioHeadphones: [() => d.audioHeadphones(b), null],
      audioSolo: [() => d.audioSolo(b.input, b.on !== false), () => (b.on === false ? 'audio solo off' : `audio solo ${aName(b.input)}`)],
      // 0.11.0 MUTE ALL ({mute:false} un-mutes what MUTE ALL muted) and DESK ZERO (needs {confirm:true}: it resets every level)
      audioMuteAll: [() => d.audioMuteAll(b.mute !== false), () => (b.mute === false ? 'audio UN-MUTE ALL' : 'audio MUTE ALL')],
      audioDeskZero: [() => { if (b.confirm !== true) throw err('DESK ZERO resets every fader, gain, balance, EQ and dynamics — send {"confirm": true}', 400); return d.audioDeskZero(); }, () => 'audio DESK ZERO (faders, gains, balance, EQ and dynamics reset)'],
      audioRoute: [() => d.audioRoute(b.output, b.source), () => `audio route ${rName('outputs', b.output)} ← ${rName('sources', b.source)}`],
    };
    const op = ops[name]; if (!op) throw err(`Unknown ATEM command "${name}"`, 404);
    if (!d.status().connected) throw err('ATEM not connected', 409);
    const r = await op[0]();
    if (op[1]) { const line = op[1](); if (line) this.log('info', `ATEM: ${line}`); }
    return r && Object.getPrototypeOf(r) === Object.prototype ? { ok: true, ...r } : { ok: true };
  }
  // 0.10.0 ATEM model list (the simulator picker) and SuperSource layouts
  atemModels() { return { default: ATEM_MODELS.DEFAULT, models: ATEM_MODELS.PROFILES.map((p) => ATEM_MODELS.summary(p)), simulator: this.sim.atem ? this.sim.atem.model : null }; }
  ssLayouts() { return [...SS_BUILTIN, ...this.cfg.sessions.atem.ssLayouts]; }
  ssLayout(id) { const l = this.ssLayouts().find((x) => x.id === String(id) || x.name === String(id)); if (!l) throw err(`No SuperSource layout "${id}"`, 404); return l; }
  saveSsLayout(b = {}) {
    const name = String(b.name || '').trim().slice(0, 40); if (!name) throw err('A layout needs a name');
    let boxes = b.boxes;
    if (!Array.isArray(boxes)) { // capture the current SuperSource
      const d = this.drivers.atem; if (!d.status().connected) throw err('ATEM not connected', 409);
      const ss = d.view().superSources[Number(b.ss) || 0]; if (!ss) throw err(`No SuperSource ${(Number(b.ss) || 0) + 1}`);
      boxes = ss.boxes.map((x) => ({ box: x.index, enabled: x.enabled, x: x.x, y: x.y, size: x.size, cropped: x.cropped, cropTop: x.cropTop, cropBottom: x.cropBottom, cropLeft: x.cropLeft, cropRight: x.cropRight, source: x.source }));
    }
    const list = this.cfg.sessions.atem.ssLayouts;
    if (SS_BUILTIN.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw err(`"${name}" is a built-in layout name`, 409);
    const old = list.find((l) => l.name.toLowerCase() === name.toLowerCase());
    const entry = cleanSsLayouts([{ id: old ? old.id : `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, name, boxes, at: Date.now() }])[0];
    if (old) Object.assign(old, entry); else list.push(entry);
    writeJsonAtomic(this.file, this.persistedCfg()); this.changed();
    this.log('info', `ATEM: SuperSource layout "${name}" saved`);
    return entry;
  }
  deleteSsLayout(id) {
    const list = this.cfg.sessions.atem.ssLayouts; const i = list.findIndex((l) => l.id === String(id));
    if (i < 0) throw err(SS_BUILTIN.some((l) => l.id === String(id)) ? 'Built-in layouts cannot be deleted' : `No SuperSource layout "${id}"`, SS_BUILTIN.some((l) => l.id === String(id)) ? 409 : 404);
    const [x] = list.splice(i, 1); writeJsonAtomic(this.file, this.persistedCfg()); this.changed();
    this.log('info', `ATEM: SuperSource layout "${x.name}" deleted`);
    return { ok: true };
  }

  // ---------- Pixera (JSON-RPC over TCP; lib/drivers/pixera.js) ----------
  async pixera(name, b = {}) {
    const d = this.drivers.pixera;
    if (!d.status().connected) throw err('Pixera not connected', 409);
    const handle = b.handle === undefined || b.handle === null || b.handle === '' ? undefined : Number(b.handle);
    const tl = () => d.timeline(handle).name;
    const ops = {
      transport: [() => d.transport(b.mode, handle), () => `${tl()}: ${String(b.mode || '').toUpperCase()}`],
      nextCue: [() => d.cue('next', handle, { ignore: !!b.ignore }), () => `${tl()}: next cue${b.ignore ? ' (ignoring properties)' : ''}`],
      prevCue: [() => d.cue('prev', handle, { ignore: !!b.ignore }), () => `${tl()}: previous cue${b.ignore ? ' (ignoring properties)' : ''}`],
      applyCue: [() => d.applyCue({ timeline: b.timeline, cue: b.cue, index: !!b.index, blend: b.blend }), () => `apply cue ${b.index ? `#${b.cue} on timeline #${b.timeline}` : `"${b.cue}" on "${b.timeline}"`}`],
      select: [() => ({ handle: d.select(handle) }), null],
      refresh: [() => d.refresh(), null],
    };
    const op = ops[name]; if (!op) throw err(`Unknown Pixera command "${name}"`, 404);
    const r = await op[0]();
    if (op[1]) this.log('info', `Pixera: ${op[1]()}`);
    this.changed();
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  }

  // ---------- Millumin (OSC over UDP; lib/drivers/millumin.js) ----------
  async millumin(name, b = {}) {
    const d = this.drivers.millumin;
    if (!d.status().connected) throw err('Millumin not connected', 409);
    const value = b.value !== undefined ? b.value : b.column !== undefined ? b.column : b.name;
    const r = await d.send(name, value);
    if (name !== 'opacity') { const shown = value === undefined || value === null || value === '' ? '' : ` ${value}`; this.log('info', `Millumin: ${name}${shown}`); }
    return { ok: true, ...r };
  }

  // ---------- PTZ ----------
  async ptz(name, b = {}) {
    const d = this.drivers.ptz; const s = this.ptzSess();
    const first = this.conn('ptz').cameras[0];
    const id = String(b.cam || (s.selected && d.cams.has(s.selected) ? s.selected : first ? first.id : '')); const cam = () => d.cam(id);
    const label = () => cam().conf.name;
    const sp = s.speeds;
    const scale = (v, max) => Math.max(-49, Math.min(49, Math.round(Number(v) || 0) * (max || 1)));
    const AXES = { pt: 'pt', pantilt: 'pt', zoom: 'z', z: 'z', focus: 'f', f: 'f' };
    const locked = () => !!(s.locks && s.locks[id]);
    const paintSlot = () => { const n = Number(b.slot); if (!(Number.isInteger(n) && n >= 1 && n <= PAINT_MEM_SLOTS)) throw err(`Paint memory slot must be 1..${PAINT_MEM_SLOTS}`); cam(); return n; };
    const ops = {
      // hold-to-run: pan / tilt / zoom / focus take a direction (-1..1, fractions allowed) times the session speed,
      // or with {speed: true} an explicit signed speed -49..49 (the proportional joystick / rockers)
      move: async () => d.move(id, { pan: b.pan !== undefined ? scale(b.pan, b.speed ? 1 : sp.pt) : 0, tilt: b.tilt !== undefined ? scale(b.tilt, b.speed ? 1 : sp.pt) : 0 }),
      zoom: async () => d.zoom(id, { speed: scale(b.dir ?? b.value, b.speed ? 1 : sp.zoom) }),
      focus: async () => d.focus(id, { speed: scale(b.dir ?? b.value, b.speed ? 1 : sp.focus) }),
      // re-arms the dead-man while a control is held; sends nothing to the camera
      keepalive: async () => d.keepalive(id),
      stop: async () => d.stop(id, Array.isArray(b.axes) && b.axes.length ? [...new Set(b.axes.map((a) => AXES[String(a).toLowerCase()]).filter(Boolean))] : undefined),
      // any catalog command: {op, value} (lib/drivers/ptz-commands.js; GET /api/sys/ptz/cameras/:id/catalog)
      op: async () => {
        const o0 = PTZC.BY_ID.get(String(b.op)); if (o0 && PAINT_GROUPS.has(o0.group) && locked()) throw err(`PTZ ${label()}: paint is locked (unlock it on CAMERA CONTROL to change ${o0.label.toLowerCase()})`, 423);
        const r = await d.op(id, String(b.op || ''), b.value);
        const o = PTZC.BY_ID.get(String(b.op)); if (o && o.type !== 'range') this.log('info', `PTZ ${label()}: ${o.label}${o.type === 'button' ? '' : ` = ${o.type === 'toggle' ? (r.value ? 'ON' : 'OFF') : r.value}`}`);
        return r;
      },
      stopAll: async () => d.stopAll(),
      // 0.9.8: per-camera notes, paint lock, and paint memories (scene/user files kept by this app: a snapshot of the
      // camera's paint values, written back command by command; the camera's own XSF scene files are the 'scene' op)
      notes: async () => { cam(); s.notes = s.notes || {}; const t = String(b.text ?? b.notes ?? '').slice(0, 2000); if (t) s.notes[id] = t; else delete s.notes[id]; this.save(); return { notes: t }; },
      lock: async () => { cam(); s.locks = s.locks || {}; const on = b.on === undefined ? !s.locks[id] : !!b.on; if (on) s.locks[id] = true; else delete s.locks[id]; this.save(); this.log('info', `PTZ ${label()}: paint ${on ? 'LOCKED' : 'unlocked'}`); return { locked: on }; },
      paintSave: async () => {
        const n = paintSlot(); await d.poll(id).catch(() => {});
        const v = d.values(d.cam(id)); const ops = d.catalog(id).ops.filter((o) => PAINT_GROUPS.has(o.group) && o.type && o.type !== 'button' && v[o.id] !== undefined);
        if (!ops.length) throw err(`PTZ ${label()}: no paint values to save on the ${d.series(id)} series`, 409);
        s.paintMem = s.paintMem || {}; s.paintMem[id] = { ...(s.paintMem[id] || {}), [n]: { at: new Date().toISOString(), name: String(b.name || `Paint ${n}`).slice(0, 30), values: Object.fromEntries(ops.map((o) => [o.id, v[o.id]])) } };
        this.save(); this.log('info', `PTZ ${label()}: saved paint memory ${n} (${ops.length} values)`); return { slot: n, count: ops.length };
      },
      paintLoad: async () => {
        const n = paintSlot(); const m = ((s.paintMem || {})[id] || {})[n]; if (!m) throw err(`PTZ ${label()}: paint memory ${n} is empty`, 404);
        if (locked()) throw err(`PTZ ${label()}: paint is locked`, 423);
        // modes first (WB mode, gamma / knee mode, matrix type ...), then the levels that depend on them
        const ent = Object.entries(m.values).map(([k, v]) => [k, v, PTZC.BY_ID.get(k)]).filter(([, , o]) => o).sort((a, x) => (a[2].type === 'range') - (x[2].type === 'range'));
        let ok = 0; const failed = [];
        for (const [k, v] of ent) { try { await d.op(id, k, v); ok++; } catch (e) { failed.push(`${k}: ${e.message}`); } }
        this.log(failed.length ? 'warn' : 'info', `PTZ ${label()}: loaded paint memory ${n} (${ok} of ${ent.length} values${failed.length ? `; failed ${failed.length}` : ''})`);
        return { slot: n, applied: ok, failed };
      },
      paintClear: async () => { const n = paintSlot(); if (s.paintMem && s.paintMem[id]) delete s.paintMem[id][n]; this.save(); return { slot: n }; },
      home: async () => { await d.home(id); this.log('info', `PTZ ${label()}: home`); },
      recall: async () => { if (b.speed !== undefined && b.speed !== null && b.speed !== '') await d.op(id, 'presetSpeed', String(b.speed)); await d.recall(id, b.preset); s.last[id] = Number(b.preset); this.save(); this.log('info', `PTZ ${label()}: recall preset ${b.preset}${(s.presetNames[id] || {})[b.preset] ? ` "${s.presetNames[id][b.preset]}"` : ''}`); },
      store: async () => {
        await d.store(id, b.preset); const n = Number(b.preset);
        s.presetNames[id] = { ...(s.presetNames[id] || {}), [n]: String(b.name || (s.presetNames[id] || {})[n] || `Preset ${n}`).slice(0, 40) };
        s.last[id] = n; this.save(); this.log('info', `PTZ ${label()}: stored preset ${n} "${s.presetNames[id][n]}"`);
        await d.presetName(id, n, s.presetNames[id][n]).catch((e) => this.log('warn', `PTZ ${label()}: preset name not saved on the camera (${e.message})`));
      },
      rename: async () => {
        cam(); const n = Number(b.preset); if (!(n >= 1 && n <= PRESET_COUNT)) throw err('Preset must be 1..100');
        const m = { ...(s.presetNames[id] || {}) }; if (b.name) m[n] = String(b.name).slice(0, 40); else delete m[n]; s.presetNames[id] = m; this.save();
        if (b.name && d.cam(id).st.connected) await d.presetName(id, n, m[n]).catch((e) => this.log('warn', `PTZ ${label()}: preset name not saved on the camera (${e.message})`));
      },
      power: async () => { await d.power(id, !!b.on); this.log('info', `PTZ ${label()}: power ${b.on ? 'ON' : 'STANDBY'}`); },
      tally: async () => { await d.tally(id, !!b.on, b.color === 'green' ? 'green' : 'red'); },
      autoFocus: async () => d.autoFocus(id, !!b.on),
      oneTouchAF: async () => d.oneTouchAF(id),
      iris: async () => d.iris(id, b.value),
      autoIris: async () => d.autoIris(id, !!b.on),
      gain: async () => d.gain(id, b.value),
      shutter: async () => d.shutter(id, b.value),
      whiteBalance: async () => d.whiteBalance(id, b.value),
      select: async () => { cam(); s.selected = id; this.save(); },
      speeds: async () => { for (const k of ['pt', 'zoom', 'focus']) if (b[k] !== undefined) s.speeds[k] = Math.max(1, Math.min(49, Math.round(Number(b[k]) || 1))); this.save(); },
      refresh: async () => d.poll(id),
    };
    const op = ops[name]; if (!op) throw err(`Unknown PTZ command "${name}"`, 404);
    if (!['stopAll', 'speeds'].includes(name)) cam();
    const r = await op();
    if (!['move', 'zoom', 'focus', 'keepalive'].includes(name)) this.changed(); // motion and keep-alives do not redraw everything
    return { ok: true, ...(r && typeof r === 'object' && !Array.isArray(r) ? r : {}) };
  }
  // the fast readout for the camera being driven (rate-limited: one camdata.html read per 250 ms per camera)
  async ptzStatus(id) {
    const d = this.drivers.ptz; const c = d.cam(id);
    if (Date.now() - (c.st.polledAt || 0) > 250) await d.poll(id).catch(() => {});
    return this.ptzView().cameras.find((x) => x.id === id);
  }
  ptzCatalog(id) { const d = this.drivers.ptz; return { camera: id, model: d.cam(id).st.data.model || null, ...d.catalog(id), sources: PTZ_SOURCES }; }
  async ptzThumbnail(id, n) { return this.drivers.ptz.thumbnail(id, n); }
  async ptzSnapshot(id) { return this.drivers.ptz.snapshot(id); }
  async ptzInfo(id) { return this.drivers.ptz.streamInfo(id); }
  // ATEM / PTZ / E2 / PixelHue views for every configured system at once (the Companion module, /api/sys?views=all)
  allViews() {
    const out = {};
    for (const k of NET_SYS) if (this.configured(k)) out[k] = this.view(k);
    return out;
  }

  // ---------- views ----------
  view(sys) {
    if (sys === 'atem') return this.atemView();
    if (sys === 'ptz') return this.ptzView();
    if (sys === 'pixera') return this.pixeraView();
    if (sys === 'millumin') return this.milluminView();
    this.check(sys, true);
    const c = this.cache[sys]; const s = this.sess(sys); const t = this.tally[sys]; const d = this.drivers[sys];
    const sel = new Set(s.selection);
    // tiles: saved layout first, then whole preset numbers on their own tile, then the rest in order
    const taken = new Set(); const tileOf = {};
    const sorted = c.presets.slice().sort((a, b) => a.number - b.number || String(a.key).localeCompare(String(b.key)));
    for (const p of sorted) { const v = s.layout[p.key]; if (Number.isInteger(v) && v >= 1 && !taken.has(v)) { tileOf[p.key] = v; taken.add(v); } }
    for (const p of sorted) if (!tileOf[p.key] && Number.isInteger(p.number) && p.number >= 1 && !taken.has(p.number)) { tileOf[p.key] = p.number; taken.add(p.number); }
    let next = 1; for (const p of sorted) if (!tileOf[p.key]) { while (taken.has(next)) next++; tileOf[p.key] = next; taken.add(next); }
    const level = (map, p) => {
      const ds = p.dests && p.dests.length ? p.dests : null;
      if (!ds) return Object.values(map).includes(p.key) ? 'partial' : 'none';
      const n = ds.filter((k) => map[k] === p.key).length;
      return n === 0 ? 'none' : n === ds.length ? 'full' : 'partial';
    };
    const presets = sorted.map((p) => ({ ...p, tile: tileOf[p.key], tally: { pvw: level(t.pvw, p), pgm: level(t.pgm, p) }, lastRecalled: t.last === p.key,
      dim: !!(sel.size && p.dests && !p.dests.some((k) => sel.has(k))) }));
    const byKey = new Map(presets.map((p) => [p.key, p]));
    const ref = (k) => { const p = byKey.get(k); return p ? { key: p.key, tile: p.tile, number: p.sno && !/\.00$/.test(p.sno) ? p.sno : p.number, name: p.name } : null; };
    return {
      system: sys, label: SYSTEMS[sys].label, short: SYSTEMS[sys].short, kind: SYSTEMS[sys].kind, capabilities: d.capabilities, status: d.status(), connection: this.publicConn(sys),
      destinations: c.destinations.map((x) => ({ ...x, selected: sel.has(x.key), pvwPreset: ref(t.pvw[x.key]), pgmPreset: ref(t.pgm[x.key]) })),
      presets, sources: c.sources, cues: c.cues, stills: c.stills, backups: c.backups, errors: c.errors, refreshedAt: c.refreshedAt,
      selection: [...s.selection], autoTake: !!s.autoTake, tileCount: s.tileCount || 48, lastRecalled: ref(t.last),
    };
  }
  base(sys) { const d = this.drivers[sys]; return { system: sys, label: SYSTEMS[sys].label, short: SYSTEMS[sys].short, kind: SYSTEMS[sys].kind, capabilities: d.capabilities, status: d.status(), connection: this.publicConn(sys) }; }
  atemView() { const d = this.drivers.atem; return { ...this.base('atem'), ssLayouts: this.ssLayouts(), ...(d.status().connected ? d.view() : { bus: [], inputs: [], keyers: [], dsk: [], aux: [], macros: [], tally: { program: [], preview: [] }, styles: ['MIX', 'DIP', 'WIPE', 'DVE', 'STING'],
    profile: null, sources: [], outputs: [], mixEffects: [], multiviewers: [], superSources: [], audio: null, dves: { count: 0, inUse: 0 } }) }; }
  pixeraView() { const d = this.drivers.pixera; return { ...this.base('pixera'), ...(d.status().connected ? d.view() : { timelines: [], selected: null, modes: ['play', 'pause', 'stop', 'toggle'] }) }; }
  milluminView() { const d = this.drivers.millumin; return { ...this.base('millumin'), ...(d.status().connected ? d.view() : { board: null, column: null, columnName: null, running: false, layer: null, media: null, opacity: null, fullscreen: false, testCard: false, lastCommand: null, commands: [] }) }; }
  ptzView() {
    const s = this.ptzSess();
    const mem = (id) => Object.fromEntries(Object.entries((s.paintMem || {})[id] || {}).map(([n, m]) => [n, { at: m.at, name: m.name, count: Object.keys(m.values || {}).length }]));
    const cams = this.drivers.ptz.cameraList().map((c) => ({ ...c, presetNames: s.presetNames[c.id] || {}, lastPreset: s.last[c.id] || null, notes: (s.notes || {})[c.id] || '', locked: !!(s.locks || {})[c.id], paintMem: mem(c.id) }));
    return { ...this.base('ptz'), cameras: cams, selected: cams.some((c) => c.id === s.selected) ? s.selected : (cams[0] ? cams[0].id : null), speeds: { ...s.speeds },
      presetCount: PRESET_COUNT, gains: GAINS, shutters: SHUTTERS, whiteBalances: WB, series: [...new Set(cams.map((c) => c.series))], seriesList: Object.keys(PTZC.DATA.series), moving: this.drivers.ptz.moving };
  }
  counts(k) {
    const e = this.engine;
    if (k === 'rs6') return e ? { presets: e.presets.length, destinations: e.destinations.length, sources: Object.keys((e.live && e.live.inputs) || {}).length } : null;
    if (k === 'atem') { const d = this.drivers.atem; if (!d.status().connected) return { sources: null, macros: null, keyers: null, aux: null }; const v = d.view(); return { sources: v.bus.length, macros: v.macros.length, keyers: v.keyers.length + v.dsk.length, aux: v.aux.length, program: (v.inputs.find((i) => i.id === v.program) || {}).long, preview: (v.inputs.find((i) => i.id === v.preview) || {}).long }; }
    if (k === 'ptz') { const l = this.drivers.ptz.cameraList(); return { cameras: l.length, online: l.filter((c) => c.connected).length, tally: l.filter((c) => c.tally).length, presets: Object.values(this.ptzSess().presetNames).reduce((n, m) => n + Object.keys(m).length, 0) }; }
    if (k === 'pixera') { const d = this.drivers.pixera; if (!d.status().connected) return { timelines: null, cues: null }; const v = d.view(); const sel = v.timelines.find((t) => t.selected); return { timelines: v.timelines.length, playing: v.timelines.filter((t) => t.transport === 'play').length, timeline: sel ? sel.name : null, cue: sel ? sel.cue : null }; }
    if (k === 'millumin') { const d = this.drivers.millumin; if (!d.status().connected) return { column: null, layer: null }; const v = d.view(); return { column: v.columnName || v.column || null, layer: v.layer, running: v.running ? 1 : 0, opacity: v.opacity }; }
    const c = this.cache[k];
    return { presets: c.presets.length, destinations: c.destinations.length, sources: c.sources.length, cues: c.cues.length, refreshedAt: c.refreshedAt };
  }
  getState() {
    const systems = {};
    for (const [k, v] of Object.entries(SYSTEMS)) {
      const d = this.drivers[k];
      const e = this.engine;
      const counts = this.counts(k);
      systems[k] = { key: k, ...v, status: d ? d.status() : null, counts, capabilities: d ? d.capabilities : null, configured: k === 'rs6' ? !!(e && e.settings.host) : this.configured(k),
        connection: k === 'rs6' ? (e ? { host: e.settings.host, restPort: e.settings.restPort, awjPort: e.settings.awjPort, protocol: e.settings.protocol, mock: !!e.settings.mock } : null) : this.publicConn(k) };
    }
    systems.ptz.cameras = this.drivers.ptz.cameraList().map((c) => ({ id: c.id, name: c.name, connected: c.connected, tally: !!c.tally, tallyGreen: !!c.tallyGreen, power: c.power || null, model: c.model || null }));
    const groups = [...new Set(Object.values(SYSTEMS).map((x) => x.group))].map((g) => ({ name: g, systems: Object.keys(SYSTEMS).filter((k) => SYSTEMS[k].group === g) }));
    return { rev: this.rev, active: this.cfg.active, armed: [...this.cfg.armed], systems, groups, planned: PLANNED, migrated: this.migrated, view: this.cfg.active === 'rs6' ? null : this.view(this.cfg.active) };
  }

  // ---------- show files (0.6.0, show format 2) ----------
  showPart({ includeConnection = false } = {}) {
    const systems = {};
    for (const k of ['e2', 'pixelhue']) {
      const s = this.cfg.sessions[k];
      systems[k] = { selection: [...s.selection], layout: { ...s.layout }, tileCount: s.tileCount, autoTake: !!s.autoTake };
      if (includeConnection) systems[k].connection = { ...this.cfg.connections[k] };
    }
    const z = this.ptzSess();
    systems.ptz = { presetNames: JSON.parse(JSON.stringify(z.presetNames)), speeds: { ...z.speeds }, selected: z.selected, notes: { ...(z.notes || {}) }, locks: { ...(z.locks || {}) }, paintMem: JSON.parse(JSON.stringify(z.paintMem || {})) };
    if (includeConnection) {
      const cams = this.sim.ptz ? this.cfg.connections.ptz.cameras : this.conn('ptz').cameras;
      systems.ptz.cameras = cams.map((c) => ({ ...c }));
      if (this.cfg.connections.atem.host) systems.atem = { connection: { ...this.cfg.connections.atem } };
    }
    for (const k of MEDIA_SYS) if (includeConnection && this.cfg.connections[k].host) systems[k] = { ...(systems[k] || {}), connection: { ...this.cfg.connections[k] } };
    const desk = this.persistedCfg();
    return { system: desk.active, armed: [...desk.armed], systems };
  }
  applyShowPart(show, { applyConnection = false } = {}) {
    if (show.system && SYSTEMS[show.system]) this.cfg.active = show.system;
    // A show that names a desk restores it and keeps the focused system on it. Older shows (no armed) only
    // change the focus — they do not kick the other systems off the desk.
    if (Array.isArray(show.armed)) this.cfg.armed = cleanArmed(show.armed, this.cfg.active);
    if (!this.cfg.armed.includes(this.cfg.active)) this.cfg.armed = cleanArmed([...this.cfg.armed, this.cfg.active], this.cfg.active);
    // A show never records a simulator. If this one is no longer on the desk, stop the fixture
    // before any connection in the show is applied (stopSim clears the override synchronously).
    for (const k of Object.keys(this.sim)) if (!this.cfg.armed.includes(k)) this.stopSim(k);
    for (const k of ['e2', 'pixelhue']) {
      const x = show.systems && show.systems[k]; if (!x) continue;
      this.cfg.sessions[k] = { ...emptySession(), selection: x.selection || [], layout: x.layout || {}, tileCount: TILE_COUNTS.includes(x.tileCount) ? x.tileCount : 48, autoTake: !!x.autoTake };
      if (applyConnection && x.connection && !this.isMock(k)) { this.cfg.connections[k] = cleanConn(k, x.connection); this.drivers[k].configure(this.conn(k)); this.cache[k] = this.emptyCache(); }
      this.tally[k] = { pvw: {}, pgm: {}, last: null };
    }
    const z = show.systems && show.systems.ptz;
    if (z) {
      this.cfg.sessions.ptz = { ...emptyPtzSession(), presetNames: z.presetNames || {}, speeds: { ...emptyPtzSession().speeds, ...(z.speeds || {}) }, selected: z.selected || null, last: {}, notes: z.notes || {}, locks: z.locks || {}, paintMem: z.paintMem || {} };
      if (applyConnection && Array.isArray(z.cameras) && !this.mockCams) { this.cfg.connections.ptz = cleanConn('ptz', { cameras: z.cameras }); this.drivers.ptz.configure(this.conn('ptz')); }
    }
    const a = show.systems && show.systems.atem;
    if (a && applyConnection && a.connection && !this.isMock('atem')) { this.cfg.connections.atem = cleanConn('atem', a.connection); this.drivers.atem.configure(this.conn('atem')); }
    for (const k of MEDIA_SYS) {
      const x = show.systems && show.systems[k];
      if (x && applyConnection && x.connection && !this.isMock(k)) { this.cfg.connections[k] = cleanConn(k, x.connection); this.drivers[k].configure(this.conn(k)); }
    }
    this.save(); this.changed();
  }
}

module.exports = { SystemManager, SYSTEMS, PLANNED, PRESET_SYS, MEDIA_SYS, NET_SYS, CONN_DEFAULTS, cleanConn };
