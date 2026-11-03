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
const FU = require('./followup');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { readJson, writeJsonAtomic } = require('./store');
const { E2Driver } = require('./drivers/e2');
const { PixelHueDriver } = require('./drivers/pixelhue');
const { RS6Driver, rs6Settings } = require('./drivers/rs6');
const { AtemDriver } = require('./drivers/atem');
const Layout = require('./atem-layout');
const { PTZDriver, GAINS, SHUTTERS, WB, PRESET_COUNT } = require('./drivers/ptz');
const { PixeraDriver } = require('./drivers/pixera');
const { MilluminDriver } = require('./drivers/millumin');
const { VideohubDriver } = require('./drivers/videohub');
const { HyperDeckDriver } = require('./drivers/hyperdeck');
const { MittiDriver } = require('./drivers/mitti');
const { MockE2 } = require('./mocks/e2');
const { MockPixelHue } = require('./mocks/pixelhue');
const { MockAtem } = require('./mocks/atem');
const ATEM_MODELS = require('./drivers/atem-models');
const { MockPTZ } = require('./mocks/ptz');
const { MockPixera } = require('./mocks/pixera');
const { MockMillumin } = require('./mocks/millumin');
const { MockVideohub } = require('./mocks/videohub');
const { MockHyperDeck } = require('./mocks/hyperdeck');
const { MockMitti } = require('./mocks/mitti');
const PTZC = require('./drivers/ptz-commands');
const deck = require('./deck');
const { createValueCoalescer } = require('./paint-coalesce');
const { COALESCE_MS } = require('./paint-accel');
const { TslService } = require('./tsl');
const { createControlCenter, step: stepConn, legacyLink, due: connDue } = require('./core');

const SYSTEMS = {
  rs6: { label: 'Analog Way Aquilon RS6', short: 'RS6', kind: 'rs6', group: 'Presentation switchers' },
  e2: { label: 'Barco Event Master (E2 / S3)', short: 'E2', kind: 'preset', group: 'Presentation switchers' },
  pixelhue: { label: 'PixelHue (P10 / P20 / P80 / Q8)', short: 'PixelHue', kind: 'preset', group: 'Presentation switchers' },
  atem: { label: 'Blackmagic ATEM', short: 'ATEM', kind: 'atem', group: 'Production switchers' },
  ptz: { label: 'Panasonic PTZ cameras (AW-UE / AW-HE)', short: 'PTZ', kind: 'ptz', group: 'Cameras' },
  pixera: { label: 'AV Stumpfl Pixera', short: 'Pixera', kind: 'pixera', group: 'Media servers' },
  millumin: { label: 'Millumin', short: 'Millumin', kind: 'millumin', group: 'Media servers' },
  videohub: { label: 'Blackmagic Videohub', short: 'Videohub', kind: 'router', group: 'Routers' },
  hyperdeck: { label: 'Blackmagic HyperDeck', short: 'HyperDeck', kind: 'hyperdeck', group: 'Recorders' },
  mitti: { label: 'Mitti', short: 'Mitti', kind: 'mitti', group: 'Media servers' },
};
const PRESET_SYS = ['e2', 'pixelhue'];
const MEDIA_SYS = ['pixera', 'millumin'];
const NET_SYS = ['e2', 'pixelhue', 'atem', 'ptz', 'pixera', 'millumin', 'videohub', 'hyperdeck', 'mitti'];
const DISPATCH_SLOW = new Set(['rs6', 'e2', 'pixelhue']);
const SYS_ORDER = Object.keys(SYSTEMS); // desk order: RS6, E2, PixelHue, ATEM, PTZ, Pixera, Millumin
// Next device families: a new family is one driver file in lib/drivers/ plus an entry above. Listed on the
// dashboard as planned; none right now.
const PLANNED = [];
const CONN_DEFAULTS = {
  rs6: { host: '', restPort: 80, awjPort: 10606, protocol: 'rest' },
  e2: { host: '', port: 9999, operatorId: '', transTime: '' },
  pixelhue: { host: '', port: 8088, prefix: '/pixelhue', swap: true, time: '' },
  atem: { host: '', port: 9910, me: 1 },
  ptz: { cameras: [] },
  pixera: { host: '', port: 1400 },
  millumin: { host: '', port: 5000 },
  videohub: { host: '', port: 9990 },
  hyperdeck: { host: '', port: 9993 },
  mitti: { host: '', port: 51000 },
};
const CONN_TYPES = { host: 'string', port: 'number', restPort: 'number', awjPort: 'number', operatorId: 'string', transTime: 'string', prefix: 'string', swap: 'boolean', time: 'string', me: 'number', protocol: 'string' };
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
const emptySession = () => ({ selection: [], layout: {}, autoTake: false, tileCount: 48, followUps: {}, followUpGroups: [], followUpEnabled: true, followUpDefault: 0, followUpDelayMs: 1000 });
// 0.11.0 auto recall / bail-out on E2 / PixelHue (lib/followup.js): followUps {presetKey: {enabled?, target?}},
// followUpGroups, the universal switch, the desk-wide default key (0 = none) and the wait
const cleanFollowUps = (x) => { const o = {}; for (const [k, v] of Object.entries(x && typeof x === 'object' ? x : {})) { const c = FU.cleanOwn(v, false); if (String(k).length <= 80 && c) o[String(k)] = c; } return o; };
const followSession = (x) => ({ followUps: cleanFollowUps(x.followUps), followUpGroups: FU.cleanGroups(x.followUpGroups, false), followUpEnabled: x.followUpEnabled !== false, followUpDefault: FU.cleanId(x.followUpDefault, false), followUpDelayMs: FU.cleanDelay(x.followUpDelayMs) });
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
function cleanLayoutPresets(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((l) => l && typeof l.name === 'string' && l.layout).slice(0, 100).map((l) => ({
    id: String(l.id || '').replace(/[^\w-]/g, '').slice(0, 40) || `u${Date.now().toString(36)}`,
    name: l.name.slice(0, 40),
    at: Number(l.at) || 0,
    target: l.target === 'program' ? 'program' : 'preview',
    layout: Layout.normalize(l.layout),
  }));
}
function cleanMvSalvos(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((l) => l && typeof l.name === 'string' && l.multiviews).slice(0, 100).map((l) => ({
    id: String(l.id || '').replace(/[^\w-]/g, '').slice(0, 40) || `u${Date.now().toString(36)}`,
    name: l.name.slice(0, 40),
    at: Number(l.at) || 0,
    multiviews: Layout.normalizeMv(l.multiviews),
  }));
}
const emptyPtzSession = () => ({ selected: null, speeds: { pt: 25, zoom: 25, focus: 15 }, presetNames: {}, last: {}, notes: {}, locks: {}, paintMem: {}, liveGuard: { ...LIVE_GUARD_DEFAULT } });
// 0.12.0 live recall guard for Stream Deck recalls ({guarded: true}) on a camera whose red tally is on:
//   off  recall at once;  hold  only with {confirmed: true} (the deck sends it after the key was held holdMs);  lock  refused
const LIVE_GUARD_DEFAULT = Object.freeze({ mode: 'hold', holdMs: 600 });
const LIVE_GUARD_MODES = ['off', 'hold', 'lock'];
const cleanGuard = (g) => ({ mode: LIVE_GUARD_MODES.includes(g && g.mode) ? g.mode : LIVE_GUARD_DEFAULT.mode, holdMs: Math.max(200, Math.min(3000, Math.round(Number(g && g.holdMs) || LIVE_GUARD_DEFAULT.holdMs))) });
// A saved `armed` list is the desk. An empty list is an empty desk. RS6 is not added
// unless it is in that list. A missing list is not the same thing: the caller decides.
// Extra ids (`atem-k3f2a1`) are further instances of a family. The first of each family keeps
// the family key (`atem`) so older shows, cues and /api/sys/atem routes stay pointed at it.
const INST_RE = /^(rs6|e2|pixelhue|atem|ptz|pixera|millumin|videohub|hyperdeck|mitti)-[a-z0-9]{4,12}$/;
function cleanArmed(list, extraIds) {
  if (!Array.isArray(list)) return [];
  const allow = new Set(extraIds || []);
  const out = [];
  for (const k of SYS_ORDER) if (list.includes(k) && !out.includes(k)) out.push(k);
  for (const id of list) if (allow.has(id) && INST_RE.test(id) && !out.includes(id)) out.push(id);
  return out;
}
function cleanName(name, fallback = '') {
  const n = String(name == null ? '' : name).trim().slice(0, 40);
  return n || fallback;
}
function cleanNames(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!SYSTEMS[k]) continue;
    const n = cleanName(v, '');
    if (n) out[k] = n;
  }
  return out;
}
function cleanInstanceList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(); const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type || '');
    if (!SYSTEMS[type]) continue;
    const id = String(raw.id || '');
    if (!INST_RE.test(id) || !id.startsWith(`${type}-`) || seen.has(id)) continue;
    seen.add(id);
    const rec = { id, type, name: cleanName(raw.name, SYSTEMS[type].short), connection: cleanConn(type, raw.connection || {}) };
    if (raw.session && typeof raw.session === 'object') rec.session = raw.session;
    if (raw.simulator) rec.simulator = true;
    if (typeof raw.simulatorModel === 'string' && raw.simulatorModel) rec.simulatorModel = raw.simulatorModel.slice(0, 40);
    out.push(rec);
    if (out.length >= 32) break;
  }
  return out;
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
    host: String((c && c.host) || '').trim().slice(0, 200), port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 80, ...(series ? { series } : {}), ...(c && c.sim ? { sim: true } : {}), ...cleanLogin(c) };
}
// 0.11.1 camera login (HTTP Basic / Digest, sent only when the camera asks): kept only when set, so an unset login is
// the UE150 factory admin / 12345 (lib/drivers/http-auth.js). The password stays in systems.json: never in a show file,
// an API answer or the log.
function cleanLogin(c) {
  const out = {}; if (!c) return out;
  if (typeof c.user === 'string' && c.user.trim()) out.user = c.user.trim().slice(0, 64);
  if (typeof c.pass === 'string') out.pass = c.pass.slice(0, 128);
  return out;
}
const noPass = ({ pass, ...c }) => ({ ...c, passSet: typeof pass === 'string' });
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
  if (sys === 'rs6') return rs6Settings(out);
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
    const hadArmed = Array.isArray(raw.armed);
    const instances = cleanInstanceList(raw.instances);
    const activeOk = SYSTEMS[raw.active] || instances.some((i) => i.id === raw.active);
    const active = activeOk ? raw.active : 'rs6';
    this.cfg = {
      version: 1,
      active,
      armed: hadArmed ? cleanArmed(raw.armed, instances.map((i) => i.id)) : [],
      simulators: Array.isArray(raw.simulators) ? [...new Set(raw.simulators.filter((k) => SYSTEMS[k] && k !== 'rs6'))] : [],
      simulatorModels: raw.simulatorModels && typeof raw.simulatorModels === 'object'
        ? Object.fromEntries(Object.entries(raw.simulatorModels).filter(([k, v]) => SYSTEMS[k] && typeof v === 'string'))
        : {},
      connections: Object.fromEntries(NET_SYS.map((k) => [k, cleanConn(k, raw.connections && raw.connections[k])])),
      sessions: { e2: { ...emptySession(), ...(raw.sessions && raw.sessions.e2), ...followSession((raw.sessions && raw.sessions.e2) || {}) }, pixelhue: { ...emptySession(), ...(raw.sessions && raw.sessions.pixelhue), ...followSession((raw.sessions && raw.sessions.pixelhue) || {}) },
        ptz: { ...emptyPtzSession(), ...(raw.sessions && raw.sessions.ptz) },
        atem: {
          ssLayouts: cleanSsLayouts(raw.sessions && raw.sessions.atem && raw.sessions.atem.ssLayouts),
          layoutPresets: cleanLayoutPresets(raw.sessions && raw.sessions.atem && raw.sessions.atem.layoutPresets),
          mvSalvos: cleanMvSalvos(raw.sessions && raw.sessions.atem && raw.sessions.atem.mvSalvos),
        } },
      ui: cleanUiPrefs(raw.ui),
      names: cleanNames(raw.names),
      instances,
      instanceMigration: raw.instanceMigration && typeof raw.instanceMigration === 'object' ? raw.instanceMigration : null,
    };
    if (!Array.isArray(raw.instances)) {
      const ids = {};
      if (this.engine && this.engine.settings && String(this.engine.settings.host || '').trim()) ids.rs6 = 'rs6';
      if (String(this.cfg.connections.atem.host || '').trim()) ids.atem = 'atem';
      for (const k of NET_SYS) if (k !== 'atem' && addressed(k, this.cfg.connections[k])) ids[k] = k;
      if (hadArmed) for (const k of raw.armed) if (SYSTEMS[k]) ids[k] = k;
      if (Object.keys(ids).length) {
        this.cfg.instanceMigration = { at: new Date().toISOString(), from: 'single-system', ids };
        for (const k of Object.keys(ids)) if (!this.cfg.names[k]) this.cfg.names[k] = SYSTEMS[k].short;
      }
    }
    if (had && !hadArmed) {
      const keys = ['rs6', active];
      for (const k of NET_SYS) if (addressed(k, this.cfg.connections[k])) keys.push(k);
      this.cfg.armed = cleanArmed(keys);
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
      if (!hadArmed || !Array.isArray(raw.instances)) this.save(); // remember the upgraded desk, and the instance ids, so REMOVE stays off
    }
    this.drivers = {
      rs6: engine ? new RS6Driver(engine) : null,
      e2: new E2Driver(this.conn('e2'), (l, m) => this.log(l, m)),
      pixelhue: new PixelHueDriver(this.conn('pixelhue'), (l, m) => this.log(l, m)),
      atem: new AtemDriver(this.conn('atem'), (l, m) => this.log(l, m), () => this.changed()),
      ptz: new PTZDriver(this.conn('ptz'), (l, m) => this.log(l, m)),
      pixera: new PixeraDriver(this.conn('pixera'), (l, m) => this.log(l, m), () => this.changed()),
      millumin: new MilluminDriver(this.conn('millumin'), (l, m) => this.log(l, m), () => this.changed()),
      videohub: new VideohubDriver(this.conn('videohub'), (l, m) => this.log(l, m), () => this.changed()),
      hyperdeck: new HyperDeckDriver(this.conn('hyperdeck'), (l, m) => this.log(l, m), () => this.changed()),
      mitti: new MittiDriver(this.conn('mitti'), (l, m) => this.log(l, m), () => this.changed()),
    };
    this.cache = { e2: this.emptyCache(), pixelhue: this.emptyCache() };
    this.tally = { e2: { pvw: {}, pgm: {}, last: null }, pixelhue: { pvw: {}, pgm: {}, last: null } };
    this.pool = new Map();
    for (const type of Object.keys(SYSTEMS)) {
      this.pool.set(type, {
        id: type, type, primary: true, rec: null, driver: this.drivers[type],
        cache: this.cache[type] || null, tally: this.tally[type] || null,
        link: 'idle', hold: false, override: null, sim: null,
      });
    }
    for (const rec of this.cfg.instances) this._mountExtra(rec);
    this.rev = 1; this._timers = [];
    this._chain = Promise.resolve();
    this._ready = true;
    if (engine) engine.showHooks = { build: (o) => this.showPart(o), apply: (show, o) => this.applyShowPart(show, o) };
    // 0.13.0-dev TSL 5.0 tally map + mock/loopback sender (docs/tsl-tally.md)
    this.tsl = new TslService({ dataDir, systems: this, forceMock: !!Object.keys(overrides || {}).length || !!(engine && engine.settings && engine.settings.mock) });
    this._tslTimer = null;
    this.on('state', () => {
      if (!this.tsl) return;
      clearTimeout(this._tslTimer);
      this._tslTimer = setTimeout(() => { this.tsl.tick().catch(() => {}); }, 40);
    });
    // Control Center OS: connection machines, the action path, the console profile.
    // The pool above is still the desk. The core watches it.
    this.os = createControlCenter({
      dataDir,
      pollMs: this.pollMs,
      version: require('../package.json').version,
      showId: () => this.engine && this.engine.currentShow && this.engine.currentShow.id,
    });
    this.os.bindDesk(this);
    for (const slot of this.pool.values()) this.os.attach(slot);
    this.os.supervisor.onRestart = (id) => this._supervisedRestart(id);
    if (autoStart) this.start();
  }
  emptyCache() { return { destinations: [], presets: [], sources: [], cues: [], stills: [], backups: [], refreshedAt: 0, errors: {} }; }
  log(level, msg, extra) {
    if (this.engine && typeof this.engine.log === 'function') this.engine.log(level, msg);
    if (this.os && !(extra && extra.skipCore)) this.os.record({ level, msg, ...(extra || {}) });
  }
  exclusive(fn) { const p = this._chain.then(fn, fn); this._chain = p.catch(() => {}); return p; }
  changed() { this.rev++; this.emit('state'); if (this.os) this.os.publish(); }
  // A simulator is session-only. systems.json and show files keep the real desk and the saved address.
  persistedCfg() {
    const sim = this.sim || {};
    const keys = Object.keys(sim);
    if (!keys.length) return this.cfg;
    // A system that was already on the desk stays on the desk in the file.
    // A simulator that was the only reason it was armed is session-only.
    const sessionOnly = new Set(keys.filter((k) => sim[k] && !sim[k].wasArmed));
    if (!sessionOnly.size) return this.cfg;
    const armed = this.cfg.armed.filter((k) => !sessionOnly.has(k));
    const active = sessionOnly.has(this.cfg.active) ? (armed[0] || 'rs6') : this.cfg.active;
    return { ...this.cfg, armed, active };
  }
  // 0.11.0 SAVE (switcher pages): save the current show to the library (same as SHOW → SAVE: the show holds every
  // desk's presets, layouts and settings) and, on an ATEM, ask the switcher to save its startup state (SRsv — the
  // encoding follows atem-connection 3.10.3; unverified on hardware). The show is saved even if the ATEM part fails.
  async saveDesk(sys, b = {}) {
    this.check(sys);
    const show = this.engine.saveShow({});
    let startup = false; let startupError = null;
    if (this.typeOf(sys) === 'atem' && b.startup !== false) {
      const d = this.driver(sys);
      if (!d.status().connected) startupError = 'ATEM not connected — show saved, startup state not saved';
      else { try { await d.saveStartup(); startup = true; this.log('info', 'ATEM: startup state saved (SRsv)'); } catch (e) { startupError = e.message; } }
    }
    return { ok: true, show, startup, startupError, unverified: this.typeOf(sys) === 'atem' ? ['SRsv'] : [] };
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
  conn(id) {
    const slot = this.pool && this.pool.get(String(id));
    if (slot && !slot.primary) {
      if (slot.type === 'ptz') {
        const cams = (slot.override && slot.override.cameras) || (slot.rec.connection && slot.rec.connection.cameras) || [];
        return { cameras: cams.map((c) => ({ ...c })) };
      }
      return { ...slot.rec.connection, ...(slot.override || {}) };
    }
    const sys = slot ? slot.type : id;
    if (sys === 'ptz') return { cameras: (this.mockCams || this.cfg.connections.ptz.cameras).map((c) => ({ ...c })) };
    return { ...this.cfg.connections[sys], ...(this.overrides[sys] || {}) };
  }
  // A camera marked sim keeps its saved address. The driver talks to that camera's mock instead.
  driverCameras(inst = 'ptz') {
    return this.conn(inst).cameras.map((c) => {
      const mock = c.sim && this._camSim && this._camSim.get(`${inst}:${c.id}`);
      const port = mock && mock.server && mock.server.address() && mock.server.address().port;
      return port ? { ...c, host: '127.0.0.1', port } : c;
    });
  }
  configured(id) {
    const slot = this.pool && this.pool.get(String(id));
    if (slot && slot.type === 'rs6' && slot.primary) return !!(this.engine && this.engine.settings && String(this.engine.settings.host || '').trim());
    const c = this.conn(id); const type = this.typeOf(id);
    return type === 'ptz' ? c.cameras.length > 0 : !!String(c.host || '').trim();
  }
  isMock(id) {
    const slot = this.pool && this.pool.get(String(id));
    if (slot && !slot.primary) return !!(slot.override || slot.sim);
    const sys = slot ? slot.type : id;
    return !!this.overrides[sys];
  }
  sess(id) {
    const slot = this.bag(id);
    this.check(slot.type, true);
    if (slot.primary) return this.cfg.sessions[slot.type];
    if (!slot.rec.session || !Array.isArray(slot.rec.session.selection)) slot.rec.session = { ...emptySession(), ...(slot.rec.session || {}), ...followSession(slot.rec.session || {}) };
    return slot.rec.session;
  }
  ptzSess(id = 'ptz') {
    const slot = this.bag(id);
    if (slot.primary) return this.cfg.sessions.ptz;
    const cur = slot.rec.session && slot.rec.session.speeds ? slot.rec.session : null;
    slot.rec.session = { ...emptyPtzSession(), ...(cur || slot.rec.session || {}) };
    return slot.rec.session;
  }
  // check(sys, true): a preset system (E2 / PixelHue); check(sys, 'atem' | 'ptz' | 'pixera' | 'millumin'): that family; check(sys): any
  // `sys` may be a family key or an instance id.
  check(sys, want = false) {
    const type = this.typeOf(sys);
    if (!SYSTEMS[type]) throw err(`Unknown system "${sys}"`, 404);
    if (want === true && SYSTEMS[type].kind !== 'preset') throw err(type === 'rs6' ? 'The RS6 uses its own tabs (/api/...)' : `The ${SYSTEMS[type].short} has no presets / destinations API here`);
    if (typeof want === 'string' && SYSTEMS[type].kind !== want) throw err(`Not available on the ${SYSTEMS[type].short}`);
  }
  typeOf(id) {
    const slot = this.pool && this.pool.get(String(id));
    if (slot) return slot.type;
    return SYSTEMS[id] ? id : '';
  }
  _arm(list) { return cleanArmed(list, (this.cfg.instances || []).map((i) => i.id)); }
  bag(id) {
    const slot = this.pool && this.pool.get(String(id));
    if (!slot) throw err(`Unknown system "${id}"`, 404);
    return slot;
  }
  driver(id) { return this.bag(id).driver; }
  meta(id) {
    const type = this.typeOf(id);
    return SYSTEMS[type] || { label: String(id), short: String(id), kind: '', group: '' };
  }
  labelOf(id) {
    const slot = this.pool && this.pool.get(String(id));
    if (!slot) return SYSTEMS[id] ? SYSTEMS[id].short : String(id);
    if (slot.primary) return (this.cfg.names && this.cfg.names[id]) || SYSTEMS[slot.type].short;
    return (slot.rec && slot.rec.name) || SYSTEMS[slot.type].short;
  }
  cacheOf(id) {
    const slot = this.bag(id);
    if (!slot.cache) slot.cache = this.emptyCache();
    if (slot.primary && (slot.type === 'e2' || slot.type === 'pixelhue')) this.cache[slot.type] = slot.cache;
    return slot.cache;
  }
  resetCache(id) {
    const slot = this.bag(id);
    if (slot.type !== 'e2' && slot.type !== 'pixelhue') return;
    slot.cache = this.emptyCache();
    if (slot.primary) this.cache[slot.type] = slot.cache;
  }
  tallyOf(id) {
    const slot = this.bag(id);
    if (!slot.tally) slot.tally = { pvw: {}, pgm: {}, last: null };
    if (slot.primary && (slot.type === 'e2' || slot.type === 'pixelhue')) this.tally[slot.type] = slot.tally;
    return slot.tally;
  }
  resetTally(id) {
    const slot = this.bag(id);
    slot.tally = { pvw: {}, pgm: {}, last: null };
    if (slot.primary && (slot.type === 'e2' || slot.type === 'pixelhue')) this.tally[slot.type] = slot.tally;
  }
  linkOf(slot) {
    if (!slot) return 'idle';
    if (slot.hold) return 'offline';
    if (this.os && !this.os.moduleEnabled(slot.id)) return 'offline';
    if (!this.configured(slot.id)) return 'idle';
    const fsm = slot.conn && slot.conn.state;
    if (fsm && fsm !== 'disconnected') return legacyLink(slot.conn);
    if (slot.link === 'connecting' || slot.link === 'reconnecting') return slot.link;
    if (slot.driver && slot.driver.status().connected) return 'ok';
    return slot.link === 'ok' ? 'reconnecting' : 'offline';
  }
  // What the console and the card should say. The original RS6 is still the
  // Engine; its machine stays disconnected, and the driver status is the truth.
  reportedFsm(slot) {
    if (!slot) return 'disconnected';
    if (slot.hold) return 'disconnected';
    if (this.os && !this.os.moduleEnabled(slot.id)) return 'disconnected';
    const fsm = slot.conn && slot.conn.state;
    if (fsm && fsm !== 'disconnected') return fsm;
    if (slot.driver && slot.driver.status().connected) return 'connected';
    return 'disconnected';
  }
  statusOf(slot) {
    const d = slot && slot.driver;
    const st = d ? d.status() : { connected: false, info: null, error: null, lastSeen: 0 };
    const ctx = (slot && slot.conn && slot.conn.context) || {};
    return {
      ...st,
      link: this.linkOf(slot),
      fsm: this.reportedFsm(slot),
      attempt: ctx.attempt || 0,
      nextAttemptAt: ctx.nextAt || 0,
      backoffMs: ctx.backoffMs || 0,
      fsmReason: ctx.reason || ctx.lastError || null,
      moduleEnabled: this.os ? this.os.moduleEnabled(slot.id) : true,
    };
  }
  _apply(slot, event) {
    if (!slot || !slot.conn) return null;
    const r = stepConn(slot.conn, event, Date.now());
    slot.conn = r.machine;
    slot.link = this.linkOf(slot);
    if (r.changed) {
      const why = r.machine.context.reason || r.machine.context.lastError;
      const level = (r.to === 'failed' || r.to === 'reconnecting') ? 'warn' : 'info';
      this.log(level, `${this.labelOf(slot.id)}: ${r.from} → ${r.to}${why ? ` (${why})` : ''}`, { instance: slot.id, from: r.from, to: r.to, event: r.event, kind: 'transition' });
      if (this.os) this.os.alerts.onConnection(slot.id, r.to, why);
    }
    return r;
  }
  _armConnect(slot) {
    if (!slot.conn) return;
    const st = slot.conn.state;
    if (st === 'disconnected' || st === 'failed') this._apply(slot, { type: 'start' });
    else if (st === 'reconnecting') this._apply(slot, { type: 'retry' });
    else if (st === 'connected' || st === 'degraded') {
      this._apply(slot, { type: 'drop', error: 'reconnect' });
      if (slot.conn.state === 'failed') this._apply(slot, { type: 'start' });
      else this._apply(slot, { type: 'retry' });
    }
  }
  _partial(slot) {
    if (!slot || !slot.driver || typeof slot.driver.status !== 'function') return null;
    if (slot.type === 'ptz') {
      const s = slot.driver.status();
      if (s.connected && s.total > 0 && s.online < s.total) return `${s.online}/${s.total} cameras answering`;
    }
    if (slot.type === 'atem' && slot.driver.st && slot.driver.st.connected && slot.driver.st.lastSeen) {
      const age = Date.now() - slot.driver.st.lastSeen;
      const limit = slot.driver.silenceMs || 5000;
      if (age > limit * 0.6) return 'switcher slow to answer';
    }
    return null;
  }
  _noteHealth(slot) {
    if (slot.type === 'ptz' && slot.driver && this.os) this.os.noteCameras(slot.id, slot.driver.cameraList());
    if (!slot.driver.status().connected) {
      this._apply(slot, { type: 'down', error: slot.driver.status().error || 'not connected' });
      return;
    }
    const partial = this._partial(slot);
    if (partial) this._apply(slot, { type: 'degrade', reason: partial });
    else this._apply(slot, { type: 'up' });
  }
  _poll(slot) {
    const d = slot.driver;
    if (d && typeof d.heartbeat === 'function') return d.heartbeat();
    const st = d.status();
    if (!st.connected) throw new Error(st.error || 'not connected');
    return st;
  }
  _supervisedRestart(id) {
    const slot = this.pool && this.pool.get(id);
    if (!slot) return;
    try { if (slot.driver && slot.driver.close) slot.driver.close(); } catch (e) { this.log('error', `${id} close on restart: ${e.message}`); }
    this.log('warn', `${this.labelOf(id)}: supervised restart`);
  }
  async _act(module, instance, action, run, timeoutMs) {
    if (!this.os) return run();
    const ms = timeoutMs || (DISPATCH_SLOW.has(module) ? 15000 : 8000);
    return this.os.dispatch.run({ module, instance, action, timeoutMs: ms, run });
  }
  _makeDriver(type, conn) {
    const log = (l, m) => this.log(l, m);
    const changed = () => this.changed();
    if (type === 'rs6') return new RS6Driver(conn, log);
    if (type === 'e2') return new E2Driver(conn, log);
    if (type === 'pixelhue') return new PixelHueDriver(conn, log);
    if (type === 'atem') return new AtemDriver(conn, log, changed);
    if (type === 'ptz') return new PTZDriver(conn, log);
    if (type === 'pixera') return new PixeraDriver(conn, log, changed);
    if (type === 'millumin') return new MilluminDriver(conn, log, changed);
    if (type === 'videohub') return new VideohubDriver(conn, log, changed);
    if (type === 'hyperdeck') return new HyperDeckDriver(conn, log, changed);
    if (type === 'mitti') return new MittiDriver(conn, log, changed);
    return null;
  }
  _mountExtra(rec) {
    if (rec.type === 'atem') rec.session = this._cleanAtemSession(rec.session);
    else if (rec.type === 'ptz') rec.session = { ...emptyPtzSession(), ...(rec.session || {}) };
    else if (rec.type === 'e2' || rec.type === 'pixelhue') rec.session = { ...emptySession(), ...(rec.session || {}), ...followSession(rec.session || {}) };
    const slot = {
      id: rec.id, type: rec.type, primary: false, rec, driver: this._makeDriver(rec.type, this._bootConn(rec)),
      cache: (rec.type === 'e2' || rec.type === 'pixelhue') ? this.emptyCache() : null,
      tally: (rec.type === 'e2' || rec.type === 'pixelhue') ? { pvw: {}, pgm: {}, last: null } : null,
      link: 'idle', hold: false, override: null, sim: null,
    };
    this.pool.set(rec.id, slot);
    if (this.os) this.os.attach(slot);
    return slot;
  }
  _bootConn(rec) {
    if (rec.type === 'ptz') return { cameras: (rec.connection.cameras || []).map((c) => ({ ...c })) };
    return { ...rec.connection };
  }
  _cleanAtemSession(raw) {
    const x = raw && typeof raw === 'object' ? raw : {};
    return { ssLayouts: cleanSsLayouts(x.ssLayouts), layoutPresets: cleanLayoutPresets(x.layoutPresets), mvSalvos: cleanMvSalvos(x.mvSalvos) };
  }
  atemSession(id = 'atem') {
    const slot = this.bag(id);
    if (slot.type !== 'atem') throw err('Not an ATEM');
    if (slot.primary) return this.cfg.sessions.atem;
    slot.rec.session = this._cleanAtemSession(slot.rec.session);
    return slot.rec.session;
  }
  _atemInst(b) {
    const id = b && b.instance ? String(b.instance) : 'atem';
    const slot = this.bag(id);
    if (slot.type !== 'atem') throw err(`"${id}" is not an ATEM`, 404);
    return id;
  }
  _freshId(type) {
    for (let n = 0; n < 12; n++) {
      const tail = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 8);
      const id = `${type}-${tail}`;
      if (INST_RE.test(id) && !this.pool.has(id)) return id;
    }
    return `${type}-${Date.now().toString(36).slice(-8)}`;
  }
  _nextName(type) {
    const used = new Set();
    for (const slot of this.pool.values()) if (slot.type === type && (slot.primary ? this._materialized(slot) : true)) used.add(this.labelOf(slot.id));
    const base = SYSTEMS[type].short;
    if (!used.has(base)) return base;
    for (let n = 2; n < 100; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
    return `${base} ${used.size + 1}`;
  }
  _materialized(slot) {
    if (!slot.primary) return true;
    if (this.cfg.armed.includes(slot.id)) return true;
    if (this.configured(slot.id)) return true;
    if (this.cfg.names && this.cfg.names[slot.id]) return true;
    return false;
  }
  endpointsOf(id) {
    const slot = this.bag(id);
    const key = (host, port) => {
      const h = String(host || '').trim();
      if (!h) return '';
      const p = Number(port) || 0;
      return `${h.toLowerCase()}:${p}`;
    };
    if (slot.type === 'ptz') {
      const c = this.conn(id);
      return (c.cameras || []).map((cam) => key(cam.host, cam.port || 80)).filter(Boolean);
    }
    if (slot.type === 'rs6' && slot.primary) {
      const s = this.engine && this.engine.settings;
      return s ? [key(s.host, s.restPort)].filter(Boolean) : [];
    }
    const c = this.conn(id);
    const port = slot.type === 'rs6' ? c.restPort : c.port;
    const one = key(c.host, port);
    return one ? [one] : [];
  }
  duplicateIds() {
    const by = new Map();
    for (const slot of this.pool.values()) {
      if (!this.cfg.armed.includes(slot.id)) continue;
      for (const host of this.endpointsOf(slot.id)) {
        const k = host;
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(slot.id);
      }
    }
    const bad = new Set();
    for (const ids of by.values()) if (new Set(ids).size > 1) for (const id of ids) bad.add(id);
    return bad;
  }

  instancePublic(id) {
    const slot = this.bag(id);
    const m = SYSTEMS[slot.type];
    const d = slot.driver;
    const st = d ? d.status() : { connected: false, info: null, error: null, lastSeen: 0 };
    return {
      id, key: id, type: slot.type, name: this.labelOf(id), primary: slot.primary,
      label: m.label, short: m.short, kind: m.kind, group: m.group,
      armed: this.cfg.armed.includes(id),
      status: this.statusOf(slot),
      counts: this.counts(id),
      capabilities: d ? d.capabilities : null,
      configured: slot.type === 'rs6' && slot.primary ? !!(this.engine && this.engine.settings.host) : this.configured(id),
      ...(slot.type === 'ptz' && slot.driver ? { cameras: slot.driver.cameraList().map((c) => ({ id: c.id, name: c.name, connected: c.connected, tally: !!c.tally, tallyGreen: !!c.tallyGreen, power: c.power || null, model: c.model || null, fsm: this.os ? this.os.cameraState(slot.id, c.id) : 'disconnected' })) } : {}),
      connection: slot.type === 'rs6' && slot.primary
        ? this._rs6Conn()
        : this.publicConn(id),
      duplicateIp: this.duplicateIds().has(id),
      held: !!slot.hold,
    };
  }
  listInstances() {
    return [...this.pool.values()].filter((s) => this._materialized(s)).map((s) => this.instancePublic(s.id));
  }
  async addInstance(type, opts = {}) {
    if (!SYSTEMS[type]) throw err(`Unknown system "${type}"`, 404);
    const force = !!(opts && opts.forceNew);
    const already = this.cfg.armed.includes(type) || this.cfg.instances.some((i) => i.type === type);
    if (!force && !already) {
      if (opts && opts.name) this.cfg.names[type] = cleanName(opts.name, SYSTEMS[type].short);
      if (opts && opts.connection && type !== 'rs6' && type !== 'ptz') this.updateConnection(type, opts.connection);
      const st = await this.setActive(type);
      st.created = type;
      return st;
    }
    const id = this._freshId(type);
    const rec = { id, type, name: cleanName(opts && opts.name, this._nextName(type)), connection: cleanConn(type, { ...(CONN_DEFAULTS[type] || {}), ...((opts && opts.connection) || {}) }) };
    this.cfg.instances.push(rec);
    const slot = this._mountExtra(rec);
    this.cfg.armed = this._arm([...this.cfg.armed, id]);
    if (!opts || opts.focus !== false) this.cfg.active = id;
    this.save();
    this.log('info', `Desk: ${rec.name} added`);
    if (opts && opts.simulate) return this._simulateExtra(slot, opts);
    if (this.configured(id)) this.connect(id, { quiet: true }).catch(() => {});
    this.changed();
    const st = this.getState(); st.created = id; return st;
  }
  renameInstance(id, name) {
    const slot = this.bag(id);
    const n = cleanName(name, '');
    if (!n) throw err('A system needs a name');
    if (slot.primary) this.cfg.names[id] = n; else slot.rec.name = n;
    this.save(); this.changed();
    this.log('info', `${SYSTEMS[slot.type].short}: renamed to ${n}`);
    return this.instancePublic(id);
  }
  duplicateInstance(id) {
    const slot = this.bag(id);
    const saved = slot.primary
      ? (slot.type === 'rs6' && this.engine ? { host: this.engine.settings.host, restPort: this.engine.settings.restPort, awjPort: this.engine.settings.awjPort, protocol: this.engine.settings.protocol } : { ...(slot.type === 'ptz' ? this.cfg.connections.ptz : this.cfg.connections[slot.type]) })
      : JSON.parse(JSON.stringify(slot.rec.connection || {}));
    return this.addInstance(slot.type, { name: this._nextName(slot.type), connection: saved, forceNew: true });
  }
  disconnectInstance(id) {
    const slot = this.bag(id);
    if (slot.type === 'rs6' && slot.primary) throw err('The original RS6 connects through its own settings');
    slot.hold = true;
    this._apply(slot, { type: 'stop' });
    slot.link = 'offline';
    if (slot.driver) slot.driver.close();
    this.changed();
    this.log('info', `${this.labelOf(id)}: disconnected`);
    return this.instancePublic(id);
  }
  async deleteInstance(id) {
    const slot = this.bag(id);
    if (!slot.primary && slot.sim) await this._stopSlotSim(slot);
    if (slot.primary && slot.sim) await this.stopSim(slot.type);
    if (slot.primary) {
      if (slot.type !== 'rs6' && slot.type !== 'ptz' && !this.isMock(slot.type)) this.cfg.connections[slot.type] = cleanConn(slot.type, {});
      if (slot.type === 'ptz' && !this.mockCams && !this.isMock('ptz')) this.cfg.connections.ptz = { cameras: [] };
      delete this.cfg.names[id];
      slot.hold = false;
      this._apply(slot, { type: 'stop' });
      slot.link = 'idle';
      if (slot.driver && slot.type !== 'rs6') { slot.driver.close(); slot.driver.configure(this.conn(id)); }
      if (slot.cache) this.resetCache(id);
    } else {
      if (slot.driver) slot.driver.close();
      if (this.os) this.os.detach(id);
      this.pool.delete(id);
      this.cfg.instances = this.cfg.instances.filter((i) => i.id !== id);
    }
    this.cfg.armed = this.cfg.armed.filter((k) => k !== id);
    if (this.cfg.active === id) this.cfg.active = this.cfg.armed[0] || 'rs6';
    this.save(); this.changed();
    this.log('info', `${slot.primary ? SYSTEMS[slot.type].short : slot.rec.name} deleted from the desk`);
    return this.getState();
  }
  async _simulateExtra(slot, opts = {}) {
    const model = slot.type === 'atem' ? String((opts && opts.model) || slot.rec.simulatorModel || ATEM_MODELS.DEFAULT) : null;
    if (model && slot.type === 'atem' && !ATEM_MODELS.profile(model)) throw err(`Unknown ATEM model "${model}"`);
    const explicit = opts && Object.prototype.hasOwnProperty.call(opts, 'on');
    const wantOn = explicit ? !!opts.on : null;
    const modelSwap = !!(slot.type === 'atem' && opts && opts.model && slot.sim && slot.sim.model !== opts.model);
    if (wantOn === false || (wantOn === null && slot.sim && !modelSwap)) {
      await this._stopSlotSim(slot);
      this.connect(slot.id, { quiet: true }).catch(() => {});
      this.changed();
      return this.getState();
    }
    if (slot.sim && !modelSwap) {
      this.cfg.active = slot.id; this.save(); this.changed(); return this.getState();
    }
    if (slot.sim) await this._stopSlotSim(slot);
    const fix = await this.startFixture(slot.type, { model, name: this.labelOf(slot.id) });
    slot.sim = fix; slot.override = fix.conn; slot.rec.simulator = true;
    if (model) slot.rec.simulatorModel = model;
    slot.driver.close(); slot.driver.configure(this.conn(slot.id));
    if (slot.cache) this.resetCache(slot.id);
    if (!this.cfg.armed.includes(slot.id)) this.cfg.armed = this._arm([...this.cfg.armed, slot.id]);
    this.cfg.active = slot.id;
    this.save();
    this.log('info', `${this.labelOf(slot.id)}: simulator on 127.0.0.1 (the saved address is unchanged)`);
    this.connect(slot.id, { quiet: true }).catch(() => {});
    this.changed();
    const st = this.getState(); st.created = slot.id; return st;
  }
  async _stopSlotSim(slot) {
    const sim = slot.sim; if (!sim) return;
    slot.sim = null; slot.override = null;
    if (slot.rec) { delete slot.rec.simulator; delete slot.rec.simulatorModel; }
    if (slot.driver) { slot.driver.close(); slot.driver.configure(this.conn(slot.id)); }
    if (slot.cache) this.resetCache(slot.id);
    try { await sim.stop(); } catch { /* already stopped */ }
  }

  // ---------- lifecycle ----------
  _watchIds() { return [...this.pool.keys()].filter((id) => !(this.typeOf(id) === 'rs6' && this.bag(id).primary)); }
  start() {
    this.stop();
    // Live status for the dashboard: every instance that has a connection configured is watched (heartbeat only;
    // a system with no IP is never contacted). Armed preset systems also get their lists refreshed.
    const tick = () => Promise.all(this._watchIds().map((sys) => this._tick(sys)));
    const refresh = async () => {
      for (const sys of this._watchIds()) {
        if (!PRESET_SYS.includes(this.typeOf(sys))) continue;
        const d = this.driver(sys); const cache = this.cacheOf(sys);
        if (d.status().connected && (this.armed(sys) || Date.now() - cache.refreshedAt > 60000)) await this.refresh(sys).catch(() => {});
      }
    };
    this._timers.push(setInterval(tick, this.pollMs), setInterval(refresh, this.refreshMs));
    for (const t of this._timers) if (t.unref) t.unref();
    this.restoreSims();
    this.restoreExtraSims();
    this.restoreCameraSims();
    for (const sys of this._watchIds()) {
      if (this.os && !this.os.moduleEnabled(sys)) continue;
      if (this.configured(sys) && !this.bag(sys).hold) this.connect(sys, { quiet: sys !== this.cfg.active }).catch(() => {});
    }
  }
  // A simulator is remembered by name, not by its temporary port. A restart builds the fixture again.
  async restoreSims() {
    const keys = Array.isArray(this.cfg.simulators) ? this.cfg.simulators.slice() : [];
    for (const sys of keys) {
      if (!SYSTEMS[sys] || sys === 'rs6' || this.sim[sys] || this.isMock(sys)) continue;
      try {
        const model = this.cfg.simulatorModels && this.cfg.simulatorModels[sys];
        const fix = await this.startFixture(sys, { model, name: this.labelOf(sys) });
        fix.wasArmed = this.cfg.armed.includes(sys);
        this.sim[sys] = fix;
        this.overrides[sys] = fix.conn;
        if (sys === 'ptz') this.mockCams = cleanConn('ptz', fix.conn).cameras;
        const d = this.driver(sys);
        if (d) { d.close(); d.configure(this.conn(sys)); }
        if (!this.cfg.armed.includes(sys)) this.cfg.armed = this._arm([...this.cfg.armed, sys]);
        this.log('info', `${this.meta(sys).short}: simulator restored`);
        this.connect(sys, { quiet: true }).catch(() => {});
        this.changed();
      } catch (e) {
        this.log('warn', `${this.meta(sys).short}: simulator did not restart (${e.message})`);
      }
    }
  }
  async restoreExtraSims() {
    for (const rec of this.cfg.instances || []) {
      if (!rec.simulator) continue;
      const slot = this.pool.get(rec.id);
      if (!slot || slot.sim) continue;
      try { await this._simulateExtra(slot, { model: rec.simulatorModel }); }
      catch (e) { this.log('warn', `${this.labelOf(rec.id)}: simulator did not restart (${e.message})`); }
    }
  }
  async _tick(sys) {
    this._busy = this._busy || {};
    const slot = this.pool && this.pool.get(sys);
    if (!slot || slot.hold || (slot.type === 'rs6' && slot.primary)) return;
    if (this.os && !this.os.moduleEnabled(sys)) return;
    if (this._busy[sys]) return; // a slow / unreachable device: never stack attempts
    this._busy[sys] = true;
    try {
      const d = slot.driver; if (!d || !this.configured(sys)) return;
      const fsm = slot.conn && slot.conn.state;
      if ((fsm === 'reconnecting' || fsm === 'failed') && !connDue(slot.conn)) return;
      const was = d.status().connected;
      const snap = slot.type === 'ptz' ? this._ptzSnap(sys) : null;
      try {
        if (fsm === 'connected' || fsm === 'degraded') {
          await this.os.supervisor.run(sys, 'poll', () => this._poll(slot));
          this._noteHealth(slot);
        } else await this.connect(sys, { quiet: true });
      } catch (e) {
        if (fsm === 'connected' || fsm === 'degraded') this._apply(slot, { type: 'down', error: e.message || String(e) });
      }
      if (slot.type === 'ptz' && was && snap !== this._ptzSnap(sys)) this.changed(); // a camera came / went, power, tally
      if (was !== d.status().connected) { this.log(d.status().connected ? 'info' : 'warn', `${this.labelOf(sys)}: ${d.status().connected ? 'connected' : `connection lost (${d.status().error})`}`); this.changed(); }
    } catch (e) {
      this.log('error', `${sys} tick: ${e.message}`);
    } finally { this._busy[sys] = false; }
  }
  _ptzSnap(id = 'ptz') { return JSON.stringify(this.driver(id).cameraList().map(({ lastSeen, ...c }) => c)); }
  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }
  close() { if (this.os) this.os.close(); clearTimeout(this._tslTimer); if (this.tsl) this.tsl.close(); for (const k of Object.keys(this._fu || {})) this._cancelFollowUp(k);
    this.stop();
    const stops = [];
    for (const k of Object.keys(this.sim)) {
      const s = this.sim[k];
      delete this.sim[k];
      delete this.overrides[k];
      stops.push(Promise.resolve().then(() => s.stop()).catch(() => {}));
    }
    if (!this.overrides.ptz) this.mockCams = null;
    for (const slot of this.pool ? this.pool.values() : []) {
      if (!slot.primary && slot.sim) stops.push(Promise.resolve().then(() => slot.sim.stop()).catch(() => {}));
      if (!slot.primary && slot.driver) slot.driver.close();
    }
    for (const d of Object.values(this.drivers)) if (d) d.close();
    const camStops = [];
    if (this._camSim) for (const m of this._camSim.values()) camStops.push(m.stop().catch(() => {}));
    this._camSim = new Map();
    return Promise.all(stops.concat(camStops));
  }

  async setActive(sys) {
    this.check(sys);
    const added = !this.cfg.armed.includes(sys);
    if (this.cfg.active !== sys || added) {
      this.cfg.active = sys;
      if (added) this.cfg.armed = this._arm([...this.cfg.armed, sys]);
      this.save();
      this.log('info', added ? `Desk: ${this.labelOf(sys)} online` : `System: ${this.labelOf(sys)}`);
      this.changed();
    }
    if (this.typeOf(sys) !== 'rs6' && this.configured(sys) && !this.driver(sys).status().connected) await this.connect(sys).catch(() => {});
    else if (PRESET_SYS.includes(this.typeOf(sys)) && this.driver(sys).status().connected) await this.refresh(sys).catch(() => {});
    return this.getState();
  }
  armed(sys) { return this.cfg.armed.includes(sys); }
  // A system that just got an address joins the desk. It does not take focus and it does not drop the others.
  noteConfigured(sys) {
    if (!this.typeOf(sys) || this.cfg.armed.includes(sys) || !this.configured(sys)) return false;
    this.cfg.armed = this._arm([...this.cfg.armed, sys]);
    this.log('info', `Desk: ${this.labelOf(sys)} online`);
    return true;
  }
  // Turn a system on or off the desk. On focuses it. Off leaves the others, and the desk
  // may end empty. RS6 is not put back. A simulator stops when it leaves.
  async setArmed(sys, on) {
    this.check(sys);
    const want = !!on;
    if (want) return this.setActive(sys);
    if (!this.cfg.armed.includes(sys)) return this.getState();
    const slotOff = this.bag(sys);
    if (slotOff.sim && !slotOff.primary) await this._stopSlotSim(slotOff);
    else if (this.sim && this.sim[sys]) await this.stopSim(sys);
    this.cfg.armed = this.cfg.armed.filter((k) => k !== sys);
    if (!this.cfg.armed.includes(this.cfg.active)) {
      this.cfg.active = this.cfg.armed[0] || this.cfg.active;
    }
    this.save();
    this.log('info', `Desk: ${this.labelOf(sys)} offline`);
    this.changed();
    const focus = this.cfg.active;
    if (this.typeOf(focus) !== 'rs6' && this.configured(focus) && !this.driver(focus).status().connected) await this.connect(focus).catch(() => {});
    else if (PRESET_SYS.includes(this.typeOf(focus)) && this.driver(focus).status().connected) await this.refresh(focus).catch(() => {});
    return this.getState();
  }
  updateConnection(sys, patch) {
    this.check(sys);
    const slot = this.bag(sys);
    if (slot.type === 'rs6' && slot.primary) throw err('The original RS6 connection is saved through /api/settings');
    if (slot.type === 'ptz') {
      const had = this.conn(sys).cameras;
      const list = ((patch && patch.cameras) || []).map((x) => { const o = x && had.find((h) => h.id === x.id && h.host === String(x.host || '').trim()); return o && x.pass === undefined && typeof o.pass === 'string' ? { ...x, pass: o.pass, ...(x.user === undefined && o.user ? { user: o.user } : {}) } : x; });
      if (!slot.primary) {
        slot.rec.connection = cleanConn('ptz', { cameras: list });
        slot.hold = false;
        this.noteConfigured(sys);
        this.save();
        slot.driver.configure(this.conn(sys));
        this.changed();
        return this.publicConn(sys);
      }
      return this.setCameras(list);
    }
    if (this.isMock(sys)) throw err(`Mock mode: the ${this.labelOf(sys)} connection is fixed to the built-in mock`, 409);
    const next = cleanConn(slot.type, { ...(slot.primary ? this.cfg.connections[slot.type] : slot.rec.connection), ...patch });
    if (slot.primary) this.cfg.connections[slot.type] = next; else slot.rec.connection = next;
    slot.hold = false;
    this.noteConfigured(sys);
    this.save();
    slot.driver.close(); slot.driver.configure(this.conn(sys));
    if (slot.cache) this.resetCache(sys);
    const c = slot.primary ? this.cfg.connections[slot.type] : slot.rec.connection;
    const shownPort = slot.type === 'rs6' ? c.restPort : c.port;
    this.log('info', `${this.labelOf(sys)} connection saved: ${c.host || '(no IP)'}${shownPort ? `:${shownPort}` : ''}`);
    this.changed();
    return this.publicConn(sys);
  }
  _savedConn(id) {
    const slot = this.pool && this.pool.get(String(id));
    const type = slot ? slot.type : id;
    if (type === 'rs6' && (!slot || slot.primary)) {
      const s = this.engine && this.engine.settings;
      return s ? { host: s.host, restPort: s.restPort, awjPort: s.awjPort, protocol: s.protocol } : {};
    }
    if (type === 'ptz') {
      const cams = slot && !slot.primary
        ? ((slot.rec.connection && slot.rec.connection.cameras) || [])
        : ((this.cfg.connections.ptz && this.cfg.connections.ptz.cameras) || []);
      return { cameras: cams.map((cam) => noPass(cam)) };
    }
    const raw = slot && !slot.primary ? (slot.rec.connection || {}) : (this.cfg.connections[type] || {});
    return { ...raw };
  }
  publicConn(sys) {
    const slot = this.pool && this.pool.get(String(sys));
    const type = slot ? slot.type : sys;
    const sim = slot && !slot.primary ? slot.sim : (this.sim && this.sim[type]);
    const c = this.conn(sys);
    if (type === 'ptz') c.cameras = c.cameras.map((cam) => ({ ...noPass(cam), simulator: !!cam.sim }));
    return { ...c, mock: this.isMock(sys), simulator: !!sim, ...(sim && sim.model ? { simulatorModel: sim.model } : {}), ...(sim ? { saved: this._savedConn(sys) } : {}) };
  }
  _rs6Conn() {
    const e = this.engine;
    if (!e) return null;
    const saved = this._savedConn('rs6');
    const sim = this.sim && this.sim.rs6;
    const live = sim ? { ...saved, ...(sim.conn || {}) } : saved;
    return { ...live, mock: !!e.settings.mock, simulator: !!sim, ...(sim ? { saved } : {}) };
  }

  // REAL / SIM on a desk card. The fixture listens on 127.0.0.1. The saved address is not
  // replaced. { on: false } goes back to that address. A second call with no `on` does the same
  // when a simulator is already running. A system already on the desk stays on the desk.
  async simulate(sys, opts = {}) {
    const slot = this.pool && this.pool.get(String(sys));
    if (slot && !slot.primary) return this._simulateExtra(slot, opts);
    this.check(sys);
    const explicit = opts && Object.prototype.hasOwnProperty.call(opts, 'on');
    const wantOn = explicit ? !!opts.on : null;
    const model = sys === 'atem' ? String((opts && opts.model) || (this.sim.atem && this.sim.atem.model) || ATEM_MODELS.DEFAULT) : null;
    if (sys === 'atem' && model && !ATEM_MODELS.profile(model)) throw err(`Unknown ATEM model "${model}" (GET /api/sys/atem/models)`);
    const running = !!this.sim[sys];
    const modelSwap = !!(sys === 'atem' && opts && opts.model && running && this.sim.atem.model !== String(opts.model));
    if (wantOn === false || (wantOn === null && running && !modelSwap)) {
      if (running) await this.stopSim(sys);
      await this._reconnectAfterSim(sys);
      this.changed();
      return this.getState();
    }
    if (running && !modelSwap) return this.setActive(sys);
    if (sys === 'rs6' && this.engine && this.engine.settings && this.engine.settings.mock) {
      throw err('Mock mode: the original RS6 is already the built-in mock. Add another RS6, then ADD AS SIMULATOR.', 409);
    }
    let swap = false; let restore = null;
    if (modelSwap) { restore = this.sim.atem.restore || null; await this.stopSim('atem'); swap = true; }
    if (!swap && sys === 'atem' && opts && opts.model && this.isMock('atem') && !this.sim.atem) { restore = this.overrides.atem; swap = true; }
    if (!swap && sys !== 'rs6' && this.isMock(sys)) throw err(`Mock mode: the ${this.meta(sys).short} connection is already the built-in mock`, 409);
    const wasArmed = this.cfg.armed.includes(sys);
    const fix = await this.startFixture(sys, { model: sys === 'atem' ? model : undefined, name: this.labelOf(sys) });
    fix.restore = restore;
    fix.wasArmed = wasArmed;
    try {
      this.sim[sys] = fix;
      if (sys === 'rs6') {
        if (this.engine && typeof this.engine.useFixture === 'function') this.engine.useFixture(fix.conn);
      } else {
        this.overrides[sys] = fix.conn;
        if (sys === 'ptz') this.mockCams = cleanConn('ptz', fix.conn).cameras;
        const d = this.driver(sys);
        if (d) { d.close(); d.configure(this.conn(sys)); }
        this.resetCache(sys);
      }
      this.cfg.simulators = [...new Set([...(this.cfg.simulators || []), sys])];
      if (sys === 'atem' && model) this.cfg.simulatorModels = { ...(this.cfg.simulatorModels || {}), atem: model };
      if (!this.cfg.armed.includes(sys)) this.cfg.armed = this._arm([...this.cfg.armed, sys]);
      this.cfg.active = sys;
      this.save();
      this.log('info', `${this.meta(sys).short}: simulator${sys === 'atem' && model ? ` (${ATEM_MODELS.profile(model).name})` : ''} on 127.0.0.1 (saved address unchanged)`);
      await this._reconnectAfterSim(sys);
      this.changed();
      return this.getState();
    } catch (e) {
      await this.stopSim(sys);
      throw e;
    }
  }
  _reconnectAfterSim(sys) {
    if (sys === 'rs6') {
      if (this.engine && typeof this.engine.connect === 'function') return this.engine.connect().catch(() => {});
      return Promise.resolve();
    }
    return this.connect(sys, { quiet: true }).catch(() => {});
  }
  async stopSim(sys) {
    const s = this.sim[sys];
    if (!s) return;
    delete this.sim[sys];
    this.cfg.simulators = (this.cfg.simulators || []).filter((k) => k !== sys);
    if (this.cfg.simulatorModels) delete this.cfg.simulatorModels[sys];
    if (sys === 'rs6') {
      if (this.engine && typeof this.engine.useSaved === 'function') this.engine.useSaved();
    } else {
      if (s.restore) this.overrides[sys] = s.restore; else delete this.overrides[sys];
      if (sys === 'ptz') this.mockCams = this.overrides.ptz ? cleanConn('ptz', this.overrides.ptz).cameras : null;
      const d = this.driver(sys);
      if (d) { d.close(); d.configure(this.conn(sys)); }
      this.resetCache(sys);
    }
    this.changed();
    try { await s.stop(); } catch { /* already stopped */ }
  }
  async startFixture(sys, { model, name } = {}) {
    const stopAll = async (list) => { for (const m of list) { try { await m.stop(); } catch { /* already stopped */ } } };
    const one = async (make, conn) => {
      const m = make();
      try {
        const port = await m.start(0, '127.0.0.1');
        return { conn: conn(port), stop: () => m.stop(), model: m.model };
      } catch (e) { await stopAll([m]); throw e; }
    };
    if (sys === 'rs6') {
      const { MockAquilon } = require('./mock');
      const m = new MockAquilon();
      try {
        const restPort = await m.startRest(0, '127.0.0.1');
        const awjPort = await m.startAwj(0, '127.0.0.1');
        return { conn: { host: '127.0.0.1', restPort, awjPort, protocol: 'rest' }, stop: () => m.stop(), model: 'RS6' };
      } catch (e) { try { await m.stop(); } catch { /* already stopped */ } throw e; }
    }
    if (sys === 'e2') return one(() => new MockE2(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'pixelhue') return one(() => new MockPixelHue(), (port) => ({ host: '127.0.0.1', port, prefix: '/pixelhue' }));
    if (sys === 'atem') return one(() => new MockAtem({ model: model || ATEM_MODELS.DEFAULT }), (port) => ({ host: '127.0.0.1', port, me: 1 }));
    if (sys === 'pixera') return one(() => new MockPixera(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'millumin') return one(() => new MockMillumin(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'videohub') return one(() => new MockVideohub(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'hyperdeck') return one(() => new MockHyperDeck(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'mitti') return one(() => new MockMitti(), (port) => ({ host: '127.0.0.1', port }));
    if (sys === 'ptz') {
      // One desk card is one camera. Three PTZ cards set to SIM are three cameras.
      const camName = String(name || 'PTZ').slice(0, 40);
      return one(
        () => new MockPTZ({ model: 'AW-UE150', title: camName.toUpperCase().replace(/\s+/g, '-'), auth: 'digest' }),
        (port) => ({ cameras: [{ id: 'cam1', name: camName, host: '127.0.0.1', port }] }),
      );
    }
    throw err(`The ${this.meta(sys).short} has no simulator`);
  }

  // ---------- PTZ cameras (many under one system) ----------
  setCameras(list, inst = 'ptz') {
    const slot = this.bag(inst);
    const clean = cleanConn('ptz', { cameras: list }).cameras;
    if (slot.primary) {
      if (this.mockCams) {
        const bad = clean.find((c) => c.host && !LOOPBACK.test(c.host));
        if (bad) throw err(`Mock mode: cameras must be local mocks (127.0.0.1), not ${bad.host}`, 409);
        this.mockCams = clean;
      } else { this.cfg.connections.ptz = { cameras: clean }; }
    } else slot.rec.connection = { cameras: clean };
    const s = this.ptzSess(inst); const ids = new Set(clean.map((c) => c.id));
    if (s.selected && !ids.has(s.selected)) s.selected = clean.length ? clean[0].id : null;
    if (!s.selected && clean.length) s.selected = clean[0].id;
    this.noteConfigured(inst);
    this.save();
    this.driver(inst).configure({ cameras: this.driverCameras(inst) });
    this.changed();
    return this.publicConn(inst);
  }
  addCamera(c, inst = 'ptz') {
    const cams = this.conn(inst).cameras;
    if (cams.length >= MAX_CAMERAS) throw err(`At most ${MAX_CAMERAS} cameras`);
    if (!c || !String(c.host || '').trim()) throw err('Camera IP address is required');
    let n = cams.length + 1; while (cams.some((x) => x.id === `cam${n}`)) n++;
    const cam = cleanCamera({ ...c, id: `cam${n}`, name: c.name || `Camera ${n}` }, n - 1);
    this.setCameras([...cams, cam], inst);
    this.log('info', `${this.labelOf(inst)}: added ${cam.name} (${cam.host}:${cam.port})`);
    this.driver(inst).poll(cam.id).then(() => this.changed(), () => this.changed());
    return noPass(cam);
  }
  updateCamera(id, patch, inst = 'ptz') {
    const cams = this.conn(inst).cameras; const i = cams.findIndex((x) => x.id === id);
    if (i < 0) throw err(`No camera "${id}"`, 404);
    // login: user '' / null = factory user; pass undefined = keep, null = back to the factory default, string = set
    const p = { ...(patch || {}) }; const cur = { ...cams[i] };
    if (p.user === null || p.user === '') { delete cur.user; delete p.user; }
    if (p.pass === null) { delete cur.pass; delete p.pass; } else if (p.pass !== undefined && typeof p.pass !== 'string') delete p.pass;
    if (p.user !== undefined || p.pass !== undefined || patch.pass === null || patch.user === null || patch.user === '') this.log('info', `PTZ: login for ${cur.name} ${p.pass !== undefined ? 'changed' : patch.pass === null ? 'reset to the factory default' : 'user changed'}`);
    cams[i] = cleanCamera({ ...cur, ...p, id }, i); this.setCameras(cams, inst);
    this.driver(inst).poll(id).then(() => this.changed(), () => this.changed());
    return noPass(cams[i]);
  }
  removeCamera(id, inst = 'ptz') {
    const cams = this.conn(inst).cameras; const c = cams.find((x) => x.id === id);
    if (!c) throw err(`No camera "${id}"`, 404);
    this.driver(inst).stop(id).catch(() => {});
    const simKey = `${inst}:${id}`;
    const sim = this._camSim && this._camSim.get(simKey);
    if (sim) { this._camSim.delete(simKey); sim.stop().catch(() => {}); }
    this.setCameras(cams.filter((x) => x.id !== id), inst);
    const z = this.ptzSess(inst); for (const k of ['presetNames', 'last', 'notes', 'locks', 'paintMem']) if (z[k]) delete z[k][id]; this.save();
    this.log('info', `PTZ: removed ${c.name}`);
    return { ok: true };
  }
  restoreCameraSims() { return this.syncCameraSims(); }
  // Start a mock for every camera marked sim, and stop one whose mark was cleared (a show apply).
  // The saved address stays on the camera. The driver is pointed at the mock only while it is up.
  syncCameraSims() {
    if (this.mockCams) return Promise.resolve();
    this._camSim = this._camSim || new Map();
    const slots = [...this.pool.values()].filter((s) => s.type === 'ptz' && !(s.primary && this.mockCams));
    const want = new Set();
    const missing = [];
    for (const slot of slots) {
      for (const cam of this.conn(slot.id).cameras) {
        if (!cam.sim) continue;
        const key = `${slot.id}:${cam.id}`;
        want.add(key);
        if (!this._camSim.has(key)) missing.push({ key, cam });
      }
    }
    const extra = [...this._camSim.keys()].filter((key) => !want.has(key));
    if (!extra.length && !missing.length) return Promise.resolve();
    const stops = extra.map((key) => { const m = this._camSim.get(key); this._camSim.delete(key); return m.stop().catch(() => {}); });
    return Promise.all(stops).then(() => Promise.all(missing.map(async ({ key, cam }) => {
      const m = new MockPTZ({ model: 'AW-UE150', title: String(cam.name || cam.id).toUpperCase().replace(/\s+/g, '-') });
      await m.start(0, '127.0.0.1');
      this._camSim.set(key, m);
    }))).then(() => {
      for (const slot of slots) if (slot.driver) slot.driver.configure({ cameras: this.driverCameras(slot.id) });
      this.changed();
    }).catch((e) => this.log('warn', `PTZ camera simulator did not start (${e.message})`));
  }
  async setCameraSim(id, on, inst = 'ptz') {
    const slot = this.bag(inst);
    if (slot.type !== 'ptz') throw err('Not a PTZ', 404);
    if (slot.primary && this.mockCams) throw err('The whole PTZ system is already a simulator. REMOVE FROM DESK before assigning one camera.', 409);
    if (!slot.primary && slot.sim) throw err('This PTZ is already a simulator. REMOVE FROM DESK before assigning one camera.', 409);
    const cams = this.conn(inst).cameras.map((c) => ({ ...c }));
    const i = cams.findIndex((c) => c.id === id);
    if (i < 0) throw err(`No camera "${id}"`, 404);
    const key = `${inst}:${id}`;
    this._camSim = this._camSim || new Map();
    if (on) {
      if (!this._camSim.has(key)) {
        const m = new MockPTZ({ model: 'AW-UE150', title: String(cams[i].name || id).toUpperCase().replace(/\s+/g, '-') });
        await m.start(0, '127.0.0.1');
        this._camSim.set(key, m);
      }
      cams[i].sim = true;
    } else {
      const m = this._camSim.get(key);
      if (m) { this._camSim.delete(key); await m.stop().catch(() => {}); }
      delete cams[i].sim;
    }
    this.setCameras(cams, inst);
    this.log('info', `${this.labelOf(inst)}: ${cams[i].name} ${on ? 'assigned as a simulator' : 'using its saved address'}`);
    return noPass(this.conn(inst).cameras.find((c) => c.id === id));
  }

  async connect(sys, opts = {}) {
    const slot = this.bag(sys);
    if (slot._connecting) return slot._connecting;
    slot._connecting = this._connect(sys, opts).finally(() => { slot._connecting = null; });
    return slot._connecting;
  }
  async _connect(sys, { quiet = false } = {}) {
    const slot = this.bag(sys);
    this.check(sys);
    if (slot.type === 'rs6' && slot.primary) throw err('The original RS6 connects through /api/settings');
    if (this.os && !this.os.moduleEnabled(sys)) throw err(`${this.labelOf(sys)} is disabled`, 409);
    const d = slot.driver;
    slot.hold = false;
    this._armConnect(slot);
    try {
      const info = await (this.os ? this.os.supervisor.run(slot.id, 'connect', () => d.connect(), { recover: false }) : d.connect());
      this._noteHealth(slot);
      if (!quiet) this.log('info', `${this.labelOf(sys)} connected: ${(info && info.model) || ''} ${(info && info.version) || ''}${slot.type === 'ptz' ? '' : ` at ${this.conn(sys).host}`}`);
      if (PRESET_SYS.includes(slot.type)) await this.refresh(sys);
      else if (slot.type === 'pixera') await d.load();
    } catch (e) {
      if (!d.status().connected) this._apply(slot, { type: 'down', error: e.message || String(e) });
      else slot.link = this.linkOf(slot);
      if (!quiet) this.log('error', `${this.labelOf(sys)} connect failed: ${e.message}`);
      this.changed(); throw e;
    }
    this.changed();
    return { ...d.status(), link: slot.link, fsm: this.reportedFsm(slot) };
  }
  async refresh(sys) {
    const type = this.typeOf(sys);
    if (type === 'ptz') { await this.driver(sys).heartbeat().catch(() => {}); this.changed(); return {}; }
    if (type === 'videohub' || type === 'hyperdeck' || type === 'mitti') {
      const gear = this.driver(sys);
      await gear.heartbeat().catch(() => {});
      this.changed();
      return gear.view();
    }
    if (type === 'atem' || type === 'millumin') { this.changed(); return {}; } // ATEM pushes its state; Millumin only answers when feedback is on
    if (type === 'pixera') { const d = this.driver(sys); await d.refresh(); this.changed(); return d.view(); }
    this.check(sys, true);
    const d = this.driver(sys); const c = this.cacheOf(sys); const caps = d.capabilities;
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
    for (const [n, m] of Object.entries(errors)) this.log('warn', `${this.meta(sys).short}: could not read ${n} (${m})`);
    this.changed();
    return c;
  }

  // ---------- selection, recall, take, cut ----------
  allKeys(sys) { return this.cacheOf(sys).destinations.map((x) => x.key); }
  async setSelection(sys, keys) {
    const s = this.sess(sys); const valid = new Set(this.allKeys(sys));
    s.selection = [...new Set((keys || []).map((k) => String(k).toUpperCase()))].filter((k) => !valid.size || valid.has(k));
    this.save(); this.changed();
    if (this.driver(sys).capabilities.armDestinations && this.driver(sys).status().connected) {
      try { await this.driver(sys).select(s.selection, this.allKeys(sys)); } catch (e) { this.log('warn', `${this.meta(sys).short}: arm destinations failed (${e.message})`); }
    }
    return s.selection;
  }
  toggleDest(sys, key) { const s = this.sess(sys); const k = String(key).toUpperCase(); return this.setSelection(sys, s.selection.includes(k) ? s.selection.filter((x) => x !== k) : [...s.selection, k]); }
  preset(sys, key) {
    const p = this.cacheOf(sys).presets.find((x) => x.key === key || String(x.tile) === String(key));
    if (p) return p;
    const v = this.view(sys).presets.find((x) => x.key === key || String(x.tile) === String(key));
    if (!v) throw err(`No preset "${key}" on the ${this.meta(sys).short}`, 404);
    return this.cacheOf(sys).presets.find((x) => x.key === v.key);
  }
  async recall(sys, key, opts = {}) {
    if (this.typeOf(sys) === 'rs6') return this._rs6Act(sys, 'recall', key);
    const target = opts.target || 'preview';
    if (!this.cacheOf(sys).presets.length && this.conn(sys).host) { if (this.driver(sys).status().connected) await this.refresh(sys); else await this.connect(sys); } // not polled yet
    return this.exclusive(async () => {
      this._cancelFollowUp(sys, 'a preset was recalled'); // the operator's recall wins over a pending auto recall
      const { p, dests } = await this._recallOne(sys, key, target, '');
      if (target === 'program') this._scheduleFollowUp(sys, dests); // straight to Program: its follow-up goes to Preview
      if (target === 'preview' && opts.autoTake !== false && this.sess(sys).autoTake) await this._transition(sys, 'take');
      return { ok: true, preset: p.key, dests };
    });
  }
  async _recallOne(sys, key, target, why) {
    const p = this.preset(sys, key); const d = this.driver(sys); const t = this.tallyOf(sys);
    await this._act(this.typeOf(sys), sys, 'recall', () => d.recall(p, { target }));
    const dests = p.dests || this.sess(sys).selection;
    for (const k of dests) { if (target === 'program') t.pgm[k] = p.key; else t.pvw[k] = p.key; }
    t.last = p.key;
    this.log('info', `${this.meta(sys).short}: ${why ? 'auto recall:' : 'recalled'} preset ${p.sno || p.number} "${p.name}" to ${target === 'program' ? 'PGM' : 'PVW'}${p.dests ? ` on ${p.dests.join(', ') || 'no destinations'}` : ''}${why}`);
    this.changed();
    return { p, dests };
  }
  // ---------- 0.11.0 auto recall (follow-up presets) on E2 / PixelHue ----------
  followUpCfg(sys) { const s = this.sess(sys); return { enabled: s.followUpEnabled !== false, default: s.followUpDefault || 0, delayMs: s.followUpDelayMs, groups: s.followUpGroups || [] }; }
  followUpInfo(sys, p, cfg = this.followUpCfg(sys)) {
    const keys = new Set(this.cacheOf(sys).presets.map((x) => x.key));
    return FU.resolve(cfg, { id: p.key, dests: p.dests || [] }, this.sess(sys).followUps[p.key], (k) => keys.has(k));
  }
  followUpOf(sys, key) { const p = this.cacheOf(sys).presets.find((x) => x.key === key); return p ? this.followUpInfo(sys, p).target : 0; }
  _cancelFollowUp(sys, why) {
    this._fu = this._fu || {}; const fu = this._fu[sys]; if (!fu) return;
    clearTimeout(fu.timer); this._fu[sys] = null;
    if (why) this.log('info', `${this.meta(sys).short}: auto recall cancelled (${why})`);
  }
  _scheduleFollowUp(sys, dests) {
    this._cancelFollowUp(sys); const t = this.tallyOf(sys); const s = this.sess(sys); const c = this.conn(sys);
    const from = [...new Set(dests.map((k) => t.pgm[k]).filter(Boolean))];
    let cueKey = null;
    try {
      if (typeof this.cueBail === 'function') {
        const b = this.cueBail(sys);
        if (b && b.preset) cueKey = String(b.preset);
      }
    } catch { cueKey = null; }
    if (cueKey) {
      const wait = s.followUpDelayMs;
      const fu = { from: from.length ? from : ['cue'], to: [cueKey], at: Date.now() + wait, timer: null, cue: true };
      fu.timer = setTimeout(() => {
        if (!this._fu || this._fu[sys] !== fu) return; this._fu[sys] = null;
        this.exclusive(async () => { await this._recallOne(sys, cueKey, 'preview', ' (cue bail)'); })
          .catch((e) => this.log('error', `${this.meta(sys).short}: cue bail failed: ${e.message}`));
      }, wait);
      if (fu.timer.unref) fu.timer.unref();
      this._fu = this._fu || {};
      this._fu[sys] = fu;
      return;
    }
    const to = [...new Set(from.map((k) => this.followUpOf(sys, k)).filter(Boolean))];
    if (!to.length) return;
    // wait = the desk's auto recall wait; on PixelHue at least the configured transition time (ms)
    const wait = Math.max(s.followUpDelayMs, this.typeOf(sys) === 'pixelhue' && Number(c.time) > 0 ? Number(c.time) : 0);
    const fu = { from, to, at: Date.now() + wait, timer: null };
    fu.timer = setTimeout(() => {
      if (this._fu[sys] !== fu) return; this._fu[sys] = null;
      this.exclusive(async () => { for (const k of fu.to) await this._recallOne(sys, k, 'preview', ` (after ${from.map((x) => { const q = this.cacheOf(sys).presets.find((y) => y.key === x); return q ? q.name : x; }).join(', ')})`); })
        .catch((e) => this.log('error', `${this.meta(sys).short}: auto recall failed: ${e.message}`));
    }, wait);
    if (fu.timer.unref) fu.timer.unref();
    this._fu[sys] = fu;
  }
  // followUp: null (inherit) | {enabled: true | false | null, target: key / tile | null}
  setFollowUp(sys, key, followUp) {
    this.check(sys, true); const p = this.preset(sys, key); const s = this.sess(sys);
    s.followUps = { ...s.followUps };
    if (followUp === null || followUp === undefined || followUp === 'inherit' || followUp === 'default') delete s.followUps[p.key];
    else {
      const raw = typeof followUp === 'object' ? { ...followUp } : followUp === 0 || followUp === false ? { enabled: false } : { target: followUp };
      if (raw.target !== undefined && raw.target !== null && raw.target !== 0 && raw.target !== '') { const f = this.preset(sys, String(raw.target)); if (f.key === p.key) throw err('A preset cannot follow itself'); raw.target = f.key; } else delete raw.target;
      const o = FU.cleanOwn(raw, false); if (o) s.followUps[p.key] = o; else delete s.followUps[p.key];
    }
    const r = this.followUpInfo(sys, p);
    this.save(); this.log('info', `${this.meta(sys).short}: preset "${p.name}" auto recall ${s.followUps[p.key] ? JSON.stringify(s.followUps[p.key]) : 'inherit'} (now: ${r.target ? `"${this.preset(sys, r.target).name}" from ${r.source}` : r.reason})`); this.changed();
    return { key: p.key, followUp: s.followUps[p.key] || null, bail: r, resolved: r.target || null };
  }
  // {enabled, default (key / tile | 0), delayMs, groups: [{name, enabled, target, presets: [key / tile], dests}]}
  setFollowUpDefaults(sys, { enabled, default: def, delayMs, groups } = {}) {
    this.check(sys, true); const s = this.sess(sys);
    if (enabled !== undefined) s.followUpEnabled = !!enabled;
    if (def !== undefined) s.followUpDefault = !def || def === 'none' ? 0 : this.preset(sys, String(def)).key;
    if (delayMs !== undefined) { const d = Number(delayMs); if (!Number.isFinite(d) || d < 0 || d > 60000) throw err('delayMs is 0..60000'); s.followUpDelayMs = Math.round(d); }
    if (groups !== undefined) {
      if (!Array.isArray(groups)) throw err('groups is a list');
      const key = (v) => (v === undefined || v === null || v === 0 || v === '' ? 0 : this.preset(sys, String(v)).key);
      s.followUpGroups = FU.cleanGroups(groups.map((g) => ({ ...g, target: key(g && g.target), presets: (g && Array.isArray(g.presets) ? g.presets : []).map(key).filter(Boolean) })), false);
    }
    if (enabled === false) this._cancelFollowUp(sys, 'auto recall switched off');
    this.save(); this.changed();
    return { enabled: s.followUpEnabled, default: s.followUpDefault || null, delayMs: s.followUpDelayMs, groups: s.followUpGroups };
  }
  take(sys) { if (this.typeOf(sys) === 'rs6') return this._rs6Act(sys, 'take'); return this.exclusive(() => this._transition(sys, 'take')); }
  cut(sys) { if (this.typeOf(sys) === 'rs6') return this._rs6Act(sys, 'cut'); return this.exclusive(() => this._transition(sys, 'cut')); }
  async _rs6Act(id, name, key) {
    const slot = this.bag(id);
    const d = slot.driver;
    if (!d || (slot.primary ? !(this.engine && this.engine.connected) : !d.status().connected)) {
      if (name !== 'recall' || !slot.primary) throw err(`${this.labelOf(id)} is not connected`, 409);
    }
    if (slot.primary) {
      if (name === 'recall') return this.engine.recall(Number(String(key).replace(/^rs6:/, '')), { autoTake: false });
      if (name === 'take') return this.engine.take();
      if (name === 'cut') return this.engine.cut();
    }
    if (name === 'recall') {
      const n = Number(String(key).replace(/^rs6:/, ''));
      const p = this.engine && this.engine.getPreset(n);
      if (!p) throw err(`No preset ${n}`, 404);
      const r = await this._act('rs6', id, 'recall', () => d.recallShowPreset(p));
      this.log('info', `${this.labelOf(id)}: recalled preset ${n}`);
      return r;
    }
    if (name === 'take') { const r = await this._act('rs6', id, 'take', () => d.take()); this.log('info', `${this.labelOf(id)}: TAKE`); return r; }
    if (name === 'cut') { const r = await this._act('rs6', id, 'cut', () => d.cut()); this.log('info', `${this.labelOf(id)}: CUT`); return r; }
    throw err(`Unknown RS6 command "${name}"`, 404);
  }
  async _transition(sys, kind) {
    const s = this.sess(sys); const d = this.driver(sys); const c = this.conn(sys);
    if (!s.selection.length) throw err(`${kind.toUpperCase()}: no destinations selected`, 409);
    const opts = { allKeys: this.allKeys(sys) };
    if (this.typeOf(sys) === 'e2' && kind === 'take') opts.transTime = c.transTime;
    if (this.typeOf(sys) === 'pixelhue' && kind === 'take') opts.time = c.time;
    await this._act(this.typeOf(sys), sys, kind, () => d[kind](s.selection, opts));
    const t = this.tallyOf(sys); const swap = this.typeOf(sys) === 'pixelhue' && c.swap;
    for (const k of s.selection) {
      const pv = t.pvw[k]; const pg = t.pgm[k];
      if (pv !== undefined) t.pgm[k] = pv;
      if (swap) { if (pg !== undefined) t.pvw[k] = pg; else delete t.pvw[k]; }
    }
    this.log('info', `${this.meta(sys).short}: ${kind.toUpperCase()} on ${s.selection.join(', ')}`);
    this._scheduleFollowUp(sys, s.selection);
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
    this.save(); this.log('info', `${this.meta(sys).short}: ${pb ? `swapped tiles ${a} and ${b}` : `moved tile ${a} to ${b}`}`); this.changed();
    return { a: Number(a), b: Number(b), swapped: !!pb };
  }
  resetLayout(sys) { this.sess(sys).layout = {}; this.save(); this.changed(); }

  // ---------- extras ----------
  async cue(sys, id, action) { const d = this.driver(sys); if (!d.capabilities.cues) throw err('This system has no cues in its API', 409); await this._act(this.typeOf(sys), sys, 'cue', () => d.activateCue(id, action)); this.log('info', `${this.meta(sys).short}: cue ${id} ${action}`); return { ok: true }; }
  async freeze(sys, kind, id, on) { const d = this.driver(sys); if (!d.capabilities.freeze) throw err('Freeze is not in this system\'s API', 409); await this._act(this.typeOf(sys), sys, 'freeze', () => d.freeze(kind, id, on)); this.log('info', `${this.meta(sys).short}: ${on ? 'freeze' : 'unfreeze'} ${kind} ${id}`); await this.refresh(sys).catch(() => {}); return { ok: true }; }
  async routeAux(sys, aux, source, target) { const d = this.driver(sys); if (!d.capabilities.auxRoute) throw err('Aux routing is not in this system\'s API', 409); await this._act(this.typeOf(sys), sys, 'aux', () => d.routeAux(aux, source, target)); this.log('info', `${this.meta(sys).short}: source ${source} -> ${aux} ${target === 'program' ? 'PGM' : 'PVW'}`); return { ok: true }; }
  async backup(sys, input, slot) { const d = this.driver(sys); if (!d.capabilities.backups) throw err('Backups are not in this system\'s API', 409); await this._act(this.typeOf(sys), sys, 'backup', () => d.selectBackup(input, slot)); this.log('info', `${this.meta(sys).short}: input ${input} -> ${Number(slot) < 0 ? 'primary' : `backup ${Number(slot) + 1}`}`); await this.refresh(sys).catch(() => {}); return { ok: true }; }
  async takeStill(sys, input, file) { const d = this.driver(sys); if (!d.capabilities.stills) throw err('Stills are not in this system\'s API', 409); await this._act(this.typeOf(sys), sys, 'still', () => d.takeStill(input, file)); this.log('info', `${this.meta(sys).short}: captured still ${Number(file) + 1} from input ${input}`); await this.refresh(sys).catch(() => {}); return { ok: true }; }
  async deleteStill(sys, id) { const d = this.driver(sys); if (!d.capabilities.stills) throw err('Stills are not in this system\'s API', 409); await this._act(this.typeOf(sys), sys, 'deleteStill', () => d.deleteStill(id)); this.log('info', `${this.meta(sys).short}: deleted still ${id}`); await this.refresh(sys).catch(() => {}); return { ok: true }; }

  // ---------- ATEM ----------
  // Every ATEM operation the UI / API may run, with the log line it writes (null = not logged: bus selections are
  // frequent and the switcher's own state shows them).
  async atem(name, b = {}) {
    const inst = this._atemInst(b);
    const d = this.driver(inst); const v = () => d.view();
    const nm = (id) => { const i = v().inputs.find((x) => x.id === Number(id)); return i ? i.long || i.short : `source ${id}`; };
    const on = b.on === undefined ? undefined : !!b.on;
    const me = b.me === undefined || b.me === null || b.me === '' ? undefined : Number(b.me) - 1;
    const usk = () => `${v().mixEffects.length > 1 ? `M/E ${(me === undefined ? d.me : me) + 1} ` : ''}USK ${Number(b.key) + 1}`;
    const ssI = () => (b.ss === undefined ? 0 : Number(b.ss));
    const IDS = new Set(['me', 'key', 'ss', 'box', 'mv', 'window', 'instance']);
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
      macroRecord: [() => d.macroRecord(b.macro), () => `macro ${Number(b.macro) + 1} record`],
      macroStopRecord: [() => d.macroStopRecord(), () => 'macro stop record'],
      macroUserWait: [() => d.macroUserWait(), () => 'macro user wait'],
      macroContinue: [() => d.macroContinue(), () => 'macro continue'],
      // 0.10.0. `me` is 1-based like the connection's M/E (default: that one); key / dsk / aux / mv / window / ss / box are 0-based like key and aux above.
      route: [() => d.route(b.output, b.source), () => `${outName(b.output)} ← ${nm(b.source)}`],
      mvSource: [() => d.mvSource(b.mv, b.window, b.source), () => `MV ${Number(b.mv) + 1} window ${Number(b.window) + 1} ← ${nm(b.source)}`],
      mvProps: [() => d.mvProps(b.mv, b), () => `MV ${Number(b.mv) + 1} layout ${b.layout !== undefined ? b.layout : ''}${b.swapped ? ' swapped' : ''}`],
      mvVu: [() => d.mvVu(b.mv, b.window, b.vu === undefined ? b.on : b.vu), null],
      mvSafe: [() => d.mvSafe(b.mv, b.window, b.safeArea === undefined ? b.on : b.safeArea), null],
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
      ssLayoutRecall: [() => { const l = this.ssLayout(b.layout, inst); return d.ssLayout(ssI(), l.boxes, !!b.withSources); }, () => `SuperSource ${ssI() + 1} layout "${this.ssLayout(b.layout, inst).name}"${b.withSources ? ' (with sources)' : ''}`],
      layoutApply: [() => this._layoutSend(b), () => 'layout apply'],
      mvApply: [() => this.mvSalvoSend(b), () => 'multiview apply'],
      mvSalvoRecall: [() => this.mvSalvoSend({ ...b, instance: inst, salvo: b.salvo || b.id || b.preset }), () => `multiview salvo "${this.mvSalvo(b.salvo || b.id || b.preset, inst).name}"`],
      layoutRecall: [() => { const p = this.layoutPreset(b.preset || b.id || b.layout, inst); return this._layoutSend({ ...b, instance: inst, layout: p.layout, target: b.target || p.target || 'preview' }); }, () => `layout "${this.layoutPreset(b.preset || b.id || b.layout, inst).name}" → ${(b.target || this.layoutPreset(b.preset || b.id || b.layout, inst).target || 'preview').toUpperCase()}`],
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
    const r = await this._act('atem', inst, name, () => op[0]());
    if (this.os) this.os.noteMacro(inst, name);
    if (op[1]) { const line = op[1](); if (line) this.log('info', `ATEM: ${line}`); }
    return r && Object.getPrototypeOf(r) === Object.prototype ? { ok: true, ...r } : { ok: true };
  }
  // 0.10.0 ATEM model list (the simulator picker) and SuperSource layouts
  atemModels() { return { default: ATEM_MODELS.DEFAULT, models: ATEM_MODELS.PROFILES.map((p) => ATEM_MODELS.summary(p)), simulator: this.sim.atem ? this.sim.atem.model : null }; }
  ssLayouts(inst = 'atem') { return [...SS_BUILTIN, ...this.atemSession(inst).ssLayouts]; }
  ssLayout(id, inst = 'atem') { const l = this.ssLayouts(inst).find((x) => x.id === String(id) || x.name === String(id)); if (!l) throw err(`No SuperSource layout "${id}"`, 404); return l; }
  saveSsLayout(b = {}) {
    const inst = this._atemInst(b);
    const name = String(b.name || '').trim().slice(0, 40); if (!name) throw err('A layout needs a name');
    let boxes = b.boxes;
    if (!Array.isArray(boxes)) { // capture the current SuperSource
      const d = this.driver(inst); if (!d.status().connected) throw err('ATEM not connected', 409);
      const ss = d.view().superSources[Number(b.ss) || 0]; if (!ss) throw err(`No SuperSource ${(Number(b.ss) || 0) + 1}`);
      boxes = ss.boxes.map((x) => ({ box: x.index, enabled: x.enabled, x: x.x, y: x.y, size: x.size, cropped: x.cropped, cropTop: x.cropTop, cropBottom: x.cropBottom, cropLeft: x.cropLeft, cropRight: x.cropRight, source: x.source }));
    }
    const list = this.atemSession(inst).ssLayouts;
    if (SS_BUILTIN.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw err(`"${name}" is a built-in layout name`, 409);
    const old = list.find((l) => l.name.toLowerCase() === name.toLowerCase());
    const entry = cleanSsLayouts([{ id: old ? old.id : `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, name, boxes, at: Date.now() }])[0];
    if (old) Object.assign(old, entry); else list.push(entry);
    writeJsonAtomic(this.file, this.persistedCfg()); this.changed();
    this.log('info', `ATEM: SuperSource layout "${name}" saved`);
    return entry;
  }
  deleteSsLayout(id, inst = 'atem') {
    const list = this.atemSession(inst).ssLayouts; const i = list.findIndex((l) => l.id === String(id));
    if (i < 0) throw err(SS_BUILTIN.some((l) => l.id === String(id)) ? 'Built-in layouts cannot be deleted' : `No SuperSource layout "${id}"`, SS_BUILTIN.some((l) => l.id === String(id)) ? 409 : 404);
    const [x] = list.splice(i, 1); writeJsonAtomic(this.file, this.persistedCfg()); this.changed();
    this.log('info', `ATEM: SuperSource layout "${x.name}" deleted`);
    return { ok: true };
  }
  layoutPresets(inst = 'atem') { return this.atemSession(inst).layoutPresets || []; }
  mvSalvos(inst = 'atem') { return this.atemSession(inst).mvSalvos || []; }
  layoutPreset(id, inst = 'atem') {
    const l = this.layoutPresets(inst).find((x) => x.id === String(id) || x.name === String(id));
    if (!l) throw err(`No layout preset "${id}"`, 404);
    return l;
  }
  saveLayoutPreset(b = {}) {
    const inst = this._atemInst(b);
    const name = String(b.name || '').trim().slice(0, 40); if (!name) throw err('A layout needs a name');
    let layout = b.layout;
    if (!layout) {
      const d = this.driver(inst); if (!d.status().connected) throw err('ATEM not connected', 409);
      layout = Layout.fromView(d.view(), { me: Math.max(0, (Number(b.me) || 1) - 1), ss: Number(b.ss) || 0 });
    }
    const list = this.atemSession(inst).layoutPresets;
    const old = list.find((l) => l.name.toLowerCase() === name.toLowerCase());
    const entry = cleanLayoutPresets([{ id: old ? old.id : `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, name, target: b.target, layout, at: Date.now() }])[0];
    if (old) Object.assign(old, entry); else list.push(entry);
    writeJsonAtomic(this.file, this.persistedCfg()); this.changed();
    this.log('info', `ATEM: layout "${name}" saved`);
    return entry;
  }
  deleteLayoutPreset(id, inst = 'atem') {
    const list = this.atemSession(inst).layoutPresets;
    const i = list.findIndex((l) => l.id === String(id));
    if (i < 0) throw err(`No layout preset "${id}"`, 404);
    const [x] = list.splice(i, 1); writeJsonAtomic(this.file, this.persistedCfg()); this.changed();
    this.log('info', `ATEM: layout "${x.name}" deleted`);
    return { ok: true };
  }
  mvSalvo(id, inst = 'atem') {
    const l = this.mvSalvos(inst).find((x) => x.id === String(id) || x.name === String(id));
    if (!l) throw err(`No multiview salvo "${id}"`, 404);
    return l;
  }
  saveMvSalvo(b = {}) {
    const inst = this._atemInst(b);
    const name = String(b.name || '').trim().slice(0, 40); if (!name) throw err('A salvo needs a name');
    let multiviews = b.multiviews;
    if (!multiviews) {
      const d = this.driver(inst); if (!d.status().connected) throw err('ATEM not connected', 409);
      multiviews = d.view().multiviewers || [];
    }
    const list = this.atemSession(inst).mvSalvos;
    const old = list.find((l) => l.name.toLowerCase() === name.toLowerCase());
    const entry = cleanMvSalvos([{ id: old ? old.id : `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, name, multiviews, at: Date.now() }])[0];
    if (old) Object.assign(old, entry); else list.push(entry);
    writeJsonAtomic(this.file, this.persistedCfg()); this.changed();
    this.log('info', `ATEM: multiview salvo "${name}" saved`);
    return entry;
  }
  deleteMvSalvo(id, inst = 'atem') {
    const list = this.atemSession(inst).mvSalvos || [];
    const i = list.findIndex((l) => l.id === String(id));
    if (i < 0) throw err(`No multiview salvo "${id}"`, 404);
    const [x] = list.splice(i, 1); writeJsonAtomic(this.file, this.persistedCfg()); this.changed();
    this.log('info', `ATEM: multiview salvo "${x.name}" deleted`);
    return { ok: true };
  }
  async mvSalvoSend(b = {}) {
    const inst = this._atemInst(b);
    const d = this.driver(inst);
    const multiviews = b.multiviews || (b.salvo || b.id ? this.mvSalvo(b.salvo || b.id, inst).multiviews : null);
    if (!multiviews) throw err('A multiview salvo needs the switcher, or a salvo body', 409);
    const built = Layout.buildMultiview(multiviews);
    for (const step of built.steps) await this._layoutStep(d, step);
    return { steps: built.steps.length, note: built.note };
  }
  mvSalvoMacro(b = {}) {
    const inst = this._atemInst(b);
    const multiviews = b.multiviews || (b.salvo || b.id ? this.mvSalvo(b.salvo || b.id, inst).multiviews : null);
    if (!multiviews) throw err('A multiview salvo needs a body', 409);
    const built = Layout.buildMultiview(multiviews);
    const index = b.index === undefined || b.index === null || b.index === '' ? 0 : Number(b.index);
    if (!(index >= 0 && index <= 99)) throw err('Macro slot is 0–99');
    const name = String(b.name || 'Multiview').slice(0, 40);
    return { index, name, description: built.note, steps: built.steps, note: built.note, xml: Layout.toXml(built.ops, { name, description: built.note, index }) };
  }
  layoutMacro(b = {}) {
    const inst = this._atemInst(b);
    const d = this.driver(inst);
    const view = d.status().connected ? d.view() : null;
    const caps = view ? Layout.capsFromView(view) : null;
    const layout = b.layout || (view ? Layout.fromView(view, { me: Math.max(0, (Number(b.me) || 1) - 1), ss: Number(b.ss) || 0 }) : null);
    if (!layout) throw err('A layout needs the switcher, or a layout body', 409);
    let flyFrom = b.flyFrom || null;
    if (!flyFrom && b.flyFromPreset) flyFrom = this.layoutPreset(b.flyFromPreset, inst).layout;
    const index = b.index === undefined || b.index === null || b.index === '' ? 0 : Number(b.index);
    if (!(index >= 0 && index <= 99)) throw err('Macro slot is 0–99');
    const built = Layout.build(layout, caps, { store: b.store || null, flyFrom });
    const name = String(b.name || 'Layout').slice(0, 40);
    const description = String(b.description || built.note).slice(0, 120);
    return { index, name, description, steps: built.steps, skipped: built.skipped, note: built.note, xml: Layout.toXml(built.ops, { name, description, index }) };
  }
  async _layoutSend(b = {}) {
    const inst = this._atemInst(b);
    const d = this.driver(inst);
    const view = d.view();
    const layout = b.layout || Layout.fromView(view, { me: Math.max(0, (Number(b.me) || 1) - 1), ss: Number(b.ss) || 0 });
    let flyFrom = b.flyFrom || null;
    if (!flyFrom && b.flyFromPreset) flyFrom = this.layoutPreset(b.flyFromPreset, inst).layout;
    const built = Layout.build(layout, Layout.capsFromView(view), { store: b.store || null, flyFrom, target: b.target || null });
    for (const step of built.steps) await this._layoutStep(d, step);
    return { steps: built.steps.length, skipped: built.skipped, note: built.note };
  }
  async _layoutStep(d, step) {
    const a = step.args || {};
    const me = (Number(a.me) || 1) - 1;
    const keep = (keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
    switch (step.op) {
      case 'ssBox': return d.ssBox(a.ss || 0, a.box, keep(Layout.FIELDS.ssBox));
      case 'ssProps': return d.ssProps(a.ss || 0, keep(Layout.FIELDS.ssProps));
      case 'ssBorder': return d.ssBorder(a.ss || 0, keep(Layout.FIELDS.ssBorder));
      case 'uskType': return d.uskType(me, a.key, a.type, a.flyEnabled);
      case 'uskSources': return d.uskSources(me, a.key, { fill: a.fill, cut: a.cut });
      case 'uskLuma': return d.uskLuma(me, a.key, keep(Layout.FIELDS.uskLuma));
      case 'uskChroma': return d.uskChroma(me, a.key, keep(Layout.FIELDS.uskChroma));
      case 'uskPattern': return d.uskPattern(me, a.key, keep(Layout.FIELDS.uskPattern));
      case 'uskMask': return d.uskMask(me, a.key, keep(Layout.FIELDS.uskMask));
      case 'uskDve': return d.uskDve(me, a.key, keep(Layout.FIELDS.uskDve));
      case 'uskOnAir': return d.uskOnAir(a.key, !!a.on, me);
      case 'uskFlyStore': return d.uskFlyStore(me, a.key, a.frame);
      case 'preview': return d.preview(a.source, me);
      case 'program': return d.program(a.source, me);
      case 'nextSelection': return d.nextSelection(a.selection, me);
      case 'dskSources': return d.dskSources(a.key, { fill: a.fill, cut: a.cut });
      case 'dskGeneral': return d.dskGeneral(a.key, keep(Layout.FIELDS.dskGeneral));
      case 'dskMask': return d.dskMask(a.key, keep(Layout.FIELDS.dskMask));
      case 'dskRate': return d.dskRate(a.key, a.rate);
      case 'dskOnAir': return d.dskOnAir(a.key, !!a.on);
      case 'dskTie': return d.dskTie(a.key, !!a.tie);
      case 'mvSource': return d.mvSource(a.mv, a.window, a.source);
      case 'mvProps': return d.mvProps(a.mv, { layout: a.layout, swapped: a.swapped });
      case 'mvVu': return d.mvVu(a.mv, a.window, a.vu);
      case 'mvSafe': return d.mvSafe(a.mv, a.window, a.safeArea);
      default: throw err(`Unknown layout step ${step.op}`);
    }
  }

  // ---------- Pixera (JSON-RPC over TCP; lib/drivers/pixera.js) ----------
  async pixera(name, b = {}) {
    const d = this.driver((b && b.instance) || 'pixera');
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
    const pix = (b && b.instance) || 'pixera';
    const r = await this._act('pixera', pix, name, () => op[0]());
    if (name === 'transport' && this.os) this.os.noteTransport((b && b.instance) || 'pixera', r && r.handle != null ? r.handle : (b.handle == null ? 0 : b.handle), (r && r.mode) || b.mode);
    if (op[1]) this.log('info', `Pixera: ${op[1]()}`);
    this.changed();
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  }

  // ---------- Millumin (OSC over UDP; lib/drivers/millumin.js) ----------
  async millumin(name, b = {}) {
    const d = this.driver((b && b.instance) || 'millumin');
    if (!d.status().connected) throw err('Millumin not connected', 409);
    const value = b.value !== undefined ? b.value : b.column !== undefined ? b.column : b.name;
    const inst = (b && b.instance) || 'millumin';
    const r = await this._act('millumin', inst, name, () => d.send(name, value));
    if (name !== 'opacity') { const shown = value === undefined || value === null || value === '' ? '' : ` ${value}`; this.log('info', `Millumin: ${name}${shown}`); }
    return { ok: true, ...r };
  }

  // ---------- Videohub, HyperDeck, Mitti ----------
  async videohub(name, b = {}) {
    const id = (b && b.instance) || 'videohub';
    const d = this.driver(id);
    if (this.typeOf(id) !== 'videohub') throw err('Not a Videohub', 404);
    if (!d.status().connected) throw err('Videohub not connected', 409);
    if (name !== 'crosspoint') throw err(`Unknown Videohub command "${name}"`, 404);
    const r = await this._act('videohub', id, name, () => d.crosspoint(b.output, b.input));
    this.log('info', `Videohub: output ${r.output + 1} ← input ${r.input + 1}`);
    this.changed();
    return { ok: true, ...r };
  }
  async hyperdeck(name, b = {}) {
    const id = (b && b.instance) || 'hyperdeck';
    const d = this.driver(id);
    if (this.typeOf(id) !== 'hyperdeck') throw err('Not a HyperDeck', 404);
    if (!d.status().connected) throw err('HyperDeck not connected', 409);
    const r = await this._act('hyperdeck', id, name, () => d.transportCmd(name));
    if (this.os && (name === 'record' || name === 'play' || name === 'stop')) this.os.noteTransport(id, 0, name);
    this.log('info', `HyperDeck: ${name}`);
    this.changed();
    return { ok: true, ...r };
  }
  async mitti(name, b = {}) {
    const id = (b && b.instance) || 'mitti';
    const d = this.driver(id);
    if (this.typeOf(id) !== 'mitti') throw err('Not a Mitti', 404);
    if (!d.status().connected) throw err('Mitti not connected', 409);
    const r = await this._act('mitti', id, name, () => d.send(name, b.value != null ? b.value : b.cue));
    if (this.os && ['play', 'pause', 'stop', 'toggle'].includes(name)) this.os.noteTransport(id, 0, name === 'toggle' ? 'toggle' : name);
    this.log('info', `Mitti: ${name}`);
    this.changed();
    return { ok: true, ...r };
  }

  // ---------- PTZ ----------
  async ptz(name, b = {}) {
    const inst = (b && b.instance) || 'ptz';
    const d = this.driver(inst); const s = this.ptzSess(inst);
    const first = this.conn(inst).cameras[0];
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
      // One detent, or a velocity-scaled burst from a Stream Deck dial. The step count is already
      // in camera steps. This reads the optimistic value (the last command, until a newer poll),
      // so two decks share one number, then coalesces the HTTP write.
      step: async () => {
        const opId = String(b.op || '');
        const o0 = PTZC.BY_ID.get(opId);
        if (!o0) throw err(`Unknown camera command "${opId}"`, 404);
        if (PAINT_GROUPS.has(o0.group) && locked()) throw err(`PTZ ${label()}: paint is locked (unlock it on CAMERA CONTROL to change ${o0.label.toLowerCase()})`, 423);
        const cat = d.catalog(id).ops.find((o) => o.id === opId);
        if (!cat) throw err(`${o0.label}: not supported on the ${d.series(id)} series`, 409);
        const camObj = d.cam(id);
        const value = deck.nextValue(cat, d.values(camObj)[opId], b.steps);
        camObj.st.opt[opId] = { v: value, at: Date.now() };
        this.changed();
        return this._paintCoalescer(inst).submit(id, opId, value);
      },
      // Long-press on a paint dial. Stored paint memory wins, then the catalog centre / list default.
      reset: async () => {
        const opId = String(b.op || '');
        const o0 = PTZC.BY_ID.get(opId);
        if (!o0) throw err(`Unknown camera command "${opId}"`, 404);
        if (PAINT_GROUPS.has(o0.group) && locked()) throw err(`PTZ ${label()}: paint is locked (unlock it on CAMERA CONTROL to change ${o0.label.toLowerCase()})`, 423);
        const cat = d.catalog(id).ops.find((o) => o.id === opId);
        if (!cat) throw err(`${o0.label}: not supported on the ${d.series(id)} series`, 409);
        const stored = this._storedPaint(id, opId, inst);
        const value = stored !== undefined ? stored : deck.defaultValue(cat);
        if (value === undefined) throw err(`${o0.label} has no default to reset to`, 409);
        const camObj = d.cam(id);
        camObj.st.opt[opId] = { v: value, at: Date.now() };
        this.changed();
        const r = await this._paintCoalescer(inst).submit(id, opId, value);
        this.log('info', `PTZ ${label()}: ${o0.label} reset to ${value}${stored !== undefined ? ' (stored paint)' : ''}`);
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
      recall: async () => {
        if (b.guarded) {
          const g = cleanGuard(s.liveGuard); const live = !!(d.cam(id).st.data && d.cam(id).st.data.tally);
          if (live && g.mode === 'lock') throw err(`PTZ ${label()} is live (red tally): preset recall from the deck is locked (live guard LOCK)`, 423);
          if (live && g.mode === 'hold' && !b.confirmed) throw err(`PTZ ${label()} is live (red tally): hold the preset key ${g.holdMs} ms to recall (live guard HOLD)`, 423);
        }
        if (b.speed !== undefined && b.speed !== null && b.speed !== '') await d.op(id, 'presetSpeed', String(b.speed)); await d.recall(id, b.preset); s.last[id] = Number(b.preset); this.save(); this.log('info', `PTZ ${label()}: recall preset ${b.preset}${(s.presetNames[id] || {})[b.preset] ? ` "${s.presetNames[id][b.preset]}"` : ''}`); },
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
      // 0.12.0: the live recall guard for deck recalls (mode off / hold / lock / cycle, holdMs 200..3000)
      guard: async () => {
        const g = cleanGuard(s.liveGuard); let mode = b.mode === undefined ? g.mode : String(b.mode);
        if (mode === 'cycle') mode = LIVE_GUARD_MODES[(LIVE_GUARD_MODES.indexOf(g.mode) + 1) % LIVE_GUARD_MODES.length];
        if (!LIVE_GUARD_MODES.includes(mode)) throw err(`Live guard mode must be one of ${LIVE_GUARD_MODES.join(', ')} or cycle`);
        s.liveGuard = cleanGuard({ mode, holdMs: b.holdMs === undefined ? g.holdMs : b.holdMs }); this.save();
        this.log('info', `PTZ: live recall guard ${s.liveGuard.mode.toUpperCase()}${s.liveGuard.mode === 'hold' ? ` (${s.liveGuard.holdMs} ms)` : ''}`);
        return { liveGuard: { ...s.liveGuard } };
      },
      speeds: async () => { for (const k of ['pt', 'zoom', 'focus']) if (b[k] !== undefined) s.speeds[k] = Math.max(1, Math.min(49, Math.round(Number(b[k]) || 1))); this.save(); },
      refresh: async () => d.poll(id),
    };
    const op = ops[name]; if (!op) throw err(`Unknown PTZ command "${name}"`, 404);
    if (!['stopAll', 'speeds', 'guard'].includes(name)) cam();
    const r = await this._act('ptz', inst, name, () => op(), 6000);
    if (!['move', 'zoom', 'focus', 'keepalive'].includes(name)) this.changed(); // motion and keep-alives do not redraw everything
    return { ok: true, ...(r && typeof r === 'object' && !Array.isArray(r) ? r : {}) };
  }
  // the fast readout for the camera being driven (rate-limited: one camdata.html read per 250 ms per camera)
  async ptzStatus(id, inst = 'ptz') {
    const d = this.driver(inst); const c = d.cam(id);
    if (Date.now() - (c.st.polledAt || 0) > 250) await d.poll(id).catch(() => {});
    return this.ptzView(inst).cameras.find((x) => x.id === id);
  }
  ptzCatalog(id, inst = 'ptz') { const d = this.driver(inst); return { camera: id, instance: inst, model: d.cam(id).st.data.model || null, ...d.catalog(id), sources: PTZ_SOURCES }; }
  _paintCoalescer(inst = 'ptz') {
    if (!this._paintSend || typeof this._paintSend.get !== 'function') this._paintSend = new Map();
    if (!this._paintSend.has(inst)) {
      this._paintSend.set(inst, createValueCoalescer({
        intervalMs: COALESCE_MS,
        send: (cam, op, value) => this.driver(inst).op(cam, op, value),
      }));
    }
    return this._paintSend.get(inst);
  }
  // Newest paint-memory slot that stored this parameter, if any.
  _storedPaint(id, opId, inst = 'ptz') {
    const mem = (this.ptzSess(inst).paintMem || {})[id] || {};
    let best = null;
    for (const slot of Object.values(mem)) {
      if (!slot || !slot.values || slot.values[opId] === undefined) continue;
      if (!best || String(slot.at || '') > String(best.at || '')) best = slot;
    }
    return best ? best.values[opId] : undefined;
  }
  // TSL / ATEM map for the camera being painted. Lamps on the camera are separate and already on the view.
  _busTally(camId) {
    if (!camId || !this.tsl || typeof this.tsl.compute !== 'function') return null;
    let program = false;
    let preview = false;
    try {
      for (const row of this.tsl.compute()) {
        if (!(row.sources || []).some((s) => s.system === 'ptz' && s.cameraId === camId)) continue;
        if (row.onPgm) program = true;
        if (row.onPvw) preview = true;
      }
    } catch { return null; }
    if (!program && !preview) return null;
    return { program, preview, source: 'tsl' };
  }
  // 0.20 Path C: one read for the Stream Deck plugin (cameras, paint readouts, presets, the + XL layout ids).
  deckSnapshot() {
    const view = this.ptzView();
    return deck.snapshot(view, (series) => PTZC.catalogFor(series), { rev: this.rev, busTally: this._busTally(view.selected) });
  }
  async ptzThumbnail(id, n, inst = 'ptz') { return this.driver(inst).thumbnail(id, n); }
  async ptzSnapshot(id, inst = 'ptz') { return this.driver(inst).snapshot(id); }
  async ptzInfo(id, inst = 'ptz') { return this.driver(inst).streamInfo(id); }
  // ATEM / PTZ / E2 / PixelHue views for every configured system at once (the Companion module, /api/sys?views=all)
  allViews() {
    const out = {};
    for (const slot of this.pool.values()) {
      if (slot.type === 'rs6' && slot.primary) continue;
      if (!this.configured(slot.id)) continue;
      const view = this.view(slot.id);
      if (view) out[slot.id] = view;
    }
    return out;
  }

  // ---------- views ----------
  view(sys) {
    const type = this.typeOf(sys);
    if (type === 'rs6') {
      const slot = this.bag(sys);
      if (slot.primary) {
        const e = this.engine;
        return { ...this.base(sys), destinations: e ? e.destinations.map((d) => ({ ...d })) : [], presetCount: e ? e.presets.length : 0 };
      }
      return { ...this.base(sys), ...(slot.driver.view() || {}) };
    }
    if (type === 'atem') return this.atemView(sys);
    if (type === 'ptz') return this.ptzView(sys);
    if (type === 'pixera') return this.pixeraView(sys);
    if (type === 'millumin') return this.milluminView(sys);
    if (type === 'videohub' || type === 'hyperdeck' || type === 'mitti') {
      const d = this.driver(sys);
      return { ...this.base(sys), ...(d && d.status().connected ? d.view() : {}) };
    }
    this.check(sys, true);
    const c = this.cacheOf(sys); const s = this.sess(sys); const t = this.tallyOf(sys); const d = this.driver(sys);
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
    const fuCfg = this.followUpCfg(sys);
    const presets = sorted.map((p) => ({ ...p, tile: tileOf[p.key], tally: { pvw: level(t.pvw, p), pgm: level(t.pgm, p) }, lastRecalled: t.last === p.key,
      followUp: s.followUps[p.key] || null, bail: this.followUpInfo(sys, p, fuCfg), followUpResolved: this.followUpInfo(sys, p, fuCfg).target || null,
      dim: !!(sel.size && p.dests && !p.dests.some((k) => sel.has(k))) }));
    const byKey = new Map(presets.map((p) => [p.key, p]));
    const ref = (k) => { const p = byKey.get(k); return p ? { key: p.key, tile: p.tile, number: p.sno && !/\.00$/.test(p.sno) ? p.sno : p.number, name: p.name } : null; };
    return {
      system: sys, type: this.typeOf(sys), instance: sys, label: this.labelOf(sys), short: this.labelOf(sys), kind: this.meta(sys).kind, capabilities: d.capabilities, status: this.statusOf(this.bag(sys)), connection: this.publicConn(sys),
      destinations: c.destinations.map((x) => ({ ...x, selected: sel.has(x.key), pvwPreset: ref(t.pvw[x.key]), pgmPreset: ref(t.pgm[x.key]) })),
      presets, sources: c.sources, cues: c.cues, stills: c.stills, backups: c.backups, errors: c.errors, refreshedAt: c.refreshedAt,
      selection: [...s.selection], autoTake: !!s.autoTake, tileCount: s.tileCount || 48, lastRecalled: ref(t.last),
      followUp: { enabled: s.followUpEnabled !== false, default: s.followUpDefault || null, defaultRef: s.followUpDefault ? ref(s.followUpDefault) : null, delayMs: s.followUpDelayMs, groups: s.followUpGroups || [], pending: this._fu && this._fu[sys] ? { from: this._fu[sys].from.map(ref), to: this._fu[sys].to.map(ref), at: this._fu[sys].at } : null },
    };
  }
  base(sys) {
    const slot = this.bag(sys); const d = slot.driver; const name = this.labelOf(sys);
    return { system: sys, type: slot.type, instance: sys, label: name, short: name, kind: SYSTEMS[slot.type].kind, capabilities: d ? d.capabilities : null, status: this.statusOf(slot), connection: slot.type === 'rs6' && slot.primary ? null : this.publicConn(sys) };
  }
  atemView(id = 'atem') { const d = this.driver(id); return { ...this.base(id), ssLayouts: this.ssLayouts(id), layoutPresets: this.layoutPresets(id), mvSalvos: this.mvSalvos(id), ...(d.status().connected ? d.view() : { bus: [], inputs: [], keyers: [], dsk: [], aux: [], macros: [], multiviewers: [], tally: { program: [], preview: [] }, styles: ['MIX', 'DIP', 'WIPE', 'DVE', 'STING'],
    profile: null, sources: [], outputs: [], mixEffects: [], multiviewers: [], superSources: [], audio: null, dves: { count: 0, inUse: 0 } }) }; }
  pixeraView(id = 'pixera') { const d = this.driver(id); return { ...this.base(id), ...(d.status().connected ? d.view() : { timelines: [], selected: null, modes: ['play', 'pause', 'stop', 'toggle'] }) }; }
  milluminView(id = 'millumin') { const d = this.driver(id); return { ...this.base(id), ...(d.status().connected ? d.view() : { board: null, column: null, columnName: null, running: false, layer: null, media: null, opacity: null, fullscreen: false, testCard: false, lastCommand: null, commands: [] }) }; }
  ptzView(id = 'ptz') {
    const d = this.driver(id); const s = this.ptzSess(id);
    const mem = (camId) => Object.fromEntries(Object.entries((s.paintMem || {})[camId] || {}).map(([n, m]) => [n, { at: m.at, name: m.name, count: Object.keys(m.values || {}).length }]));
    const cams = d.cameraList().map((c) => ({ ...c, presetNames: s.presetNames[c.id] || {}, lastPreset: s.last[c.id] || null, notes: (s.notes || {})[c.id] || '', locked: !!(s.locks || {})[c.id], paintMem: mem(c.id) }));
    return { ...this.base(id), cameras: cams, selected: cams.some((c) => c.id === s.selected) ? s.selected : (cams[0] ? cams[0].id : null), speeds: { ...s.speeds }, liveGuard: cleanGuard(s.liveGuard),
      presetCount: PRESET_COUNT, gains: GAINS, shutters: SHUTTERS, whiteBalances: WB, series: [...new Set(cams.map((c) => c.series))], seriesList: Object.keys(PTZC.DATA.series), moving: d.moving };
  }
  counts(k) {
    const e = this.engine;
    const type = this.typeOf(k) || k;
    if (type === 'rs6') {
      const slot = this.bag(k);
      if (!slot.primary) return { presets: e ? e.presets.length : 0, destinations: (slot.driver.destinations || []).length, sources: 0 };
      return e ? { presets: e.presets.length, destinations: e.destinations.length, sources: Object.keys((e.live && e.live.inputs) || {}).length } : null;
    }
    if (type === 'atem') { const d = this.driver(k); if (!d.status().connected) return { sources: null, macros: null, keyers: null, aux: null }; const v = d.view(); return { sources: v.bus.length, macros: v.macros.length, keyers: v.keyers.length + v.dsk.length, aux: v.aux.length, program: (v.inputs.find((i) => i.id === v.program) || {}).long, preview: (v.inputs.find((i) => i.id === v.preview) || {}).long }; }
    if (type === 'ptz') { const l = this.driver(k).cameraList(); return { cameras: l.length, online: l.filter((c) => c.connected).length, tally: l.filter((c) => c.tally).length, presets: Object.values(this.ptzSess(k).presetNames).reduce((n, m) => n + Object.keys(m).length, 0) }; }
    if (type === 'pixera') { const d = this.driver(k); if (!d.status().connected) return { timelines: null, cues: null }; const v = d.view(); const sel = v.timelines.find((t) => t.selected); return { timelines: v.timelines.length, playing: v.timelines.filter((t) => t.transport === 'play').length, timeline: sel ? sel.name : null, cue: sel ? sel.cue : null }; }
    if (type === 'millumin') { const d = this.driver(k); if (!d.status().connected) return { column: null, layer: null }; const v = d.view(); return { column: v.columnName || v.column || null, layer: v.layer, running: v.running ? 1 : 0, opacity: v.opacity }; }
    if (type === 'videohub') { const d = this.driver(k); const v = d.view(); return { outputs: (v.outputs || []).length, inputs: (v.inputs || []).length }; }
    if (type === 'hyperdeck') { const d = this.driver(k); const v = d.view(); return { transport: v.transport && v.transport.status, timecode: v.transport && v.transport.timecode }; }
    if (type === 'mitti') { const d = this.driver(k); const v = d.view(); return { mode: v.mode, cue: v.cue }; }
    const c = this.cacheOf(k);
    return { presets: c.presets.length, destinations: c.destinations.length, sources: c.sources.length, cues: c.cues.length, refreshedAt: c.refreshedAt };
  }
  getState() {
    const systems = {};
    for (const [k, v] of Object.entries(SYSTEMS)) {
      const d = this.driver(k);
      const e = this.engine;
      const counts = this.counts(k);
      systems[k] = { key: k, ...v, status: d ? this.statusOf(this.bag(k)) : null, counts, capabilities: d ? d.capabilities : null, configured: k === 'rs6' ? !!(e && e.settings.host) : this.configured(k),
        connection: k === 'rs6' ? this._rs6Conn() : this.publicConn(k) };
    }
    systems.ptz.cameras = this.drivers.ptz.cameraList().map((c) => ({ id: c.id, name: c.name, connected: c.connected, tally: !!c.tally, tallyGreen: !!c.tallyGreen, power: c.power || null, model: c.model || null, fsm: this.os ? this.os.cameraState('ptz', c.id) : 'disconnected' }));
    const groups = [...new Set(Object.values(SYSTEMS).map((x) => x.group))].map((g) => ({ name: g, systems: Object.keys(SYSTEMS).filter((k) => SYSTEMS[k].group === g) }));
    const activeType = this.typeOf(this.cfg.active);
    const primaryRs6 = activeType === 'rs6' && this.bag(this.cfg.active).primary;
    return { rev: this.rev, active: this.cfg.active, armed: [...this.cfg.armed], systems, instances: this.listInstances(), groups, planned: PLANNED, migrated: this.migrated, instanceMigration: this.cfg.instanceMigration || null, view: !activeType || primaryRs6 ? null : this.view(this.cfg.active) };
  }

  // ---------- show files (0.6.0, show format 2) ----------
  showPart({ includeConnection = false } = {}) {
    const systems = {};
    for (const k of ['e2', 'pixelhue']) {
      const s = this.cfg.sessions[k];
      systems[k] = { selection: [...s.selection], layout: { ...s.layout }, tileCount: s.tileCount, autoTake: !!s.autoTake };
      // 0.11.0 auto recall (only when used, so older shows hash the same)
      if (Object.keys(s.followUps || {}).length) systems[k].followUps = JSON.parse(JSON.stringify(s.followUps));
      if ((s.followUpGroups || []).length) systems[k].followUpGroups = JSON.parse(JSON.stringify(s.followUpGroups));
      if (s.followUpEnabled === false) systems[k].followUpEnabled = false;
      if (s.followUpDefault) systems[k].followUpDefault = s.followUpDefault;
      if (s.followUpDelayMs !== undefined && s.followUpDelayMs !== 1000) systems[k].followUpDelayMs = s.followUpDelayMs;
      if (includeConnection) systems[k].connection = { ...this.cfg.connections[k] };
    }
    const z = this.ptzSess();
    systems.ptz = { presetNames: JSON.parse(JSON.stringify(z.presetNames)), speeds: { ...z.speeds }, selected: z.selected, notes: { ...(z.notes || {}) }, locks: { ...(z.locks || {}) }, paintMem: JSON.parse(JSON.stringify(z.paintMem || {})) };
    // 0.12.0 deck live recall guard (only when changed, so older shows hash the same)
    { const g = cleanGuard(z.liveGuard); if (g.mode !== LIVE_GUARD_DEFAULT.mode || g.holdMs !== LIVE_GUARD_DEFAULT.holdMs) systems.ptz.liveGuard = g; }
    if (includeConnection) {
      const cams = this.sim.ptz ? this.cfg.connections.ptz.cameras : this.conn('ptz').cameras;
      systems.ptz.cameras = cams.map(({ pass, ...c }) => ({ ...c })); // a camera password is never written into a show
      if (this.cfg.connections.atem.host) systems.atem = { connection: { ...this.cfg.connections.atem } };
    }
    for (const k of MEDIA_SYS) if (includeConnection && this.cfg.connections[k].host) systems[k] = { ...(systems[k] || {}), connection: { ...this.cfg.connections[k] } };
    const desk = this.persistedCfg();
    const out = { system: desk.active, armed: [...desk.armed], systems };
    const consoleProfile = this._consoleForShow();
    if (consoleProfile) out.console = consoleProfile;
    const tsl = this.tsl && this.tsl.showPart();
    if (tsl) out.tsl = tsl;
    return out;
  }
  _consoleForShow() {
    if (!this.os) return null;
    const p = this.os.surfaces.profile();
    const useful = (p.bindings && p.bindings.length) || (p.focus && Object.keys(p.focus).length) || (p.id && p.id !== 'show') || (p.name && p.name !== 'Show');
    if (!useful) return null;
    return { id: p.id, name: p.name, bindings: p.bindings, focus: p.focus };
  }
  applyShowPart(show, { applyConnection = false } = {}) {
    if (show.tsl && this.tsl) { try { this.tsl.applyShowPart(show.tsl); } catch (e) { this.log('warn', `TSL map from show: ${e.message}`); } }
    if (show.console && this.os) { try { this.os.surfaces.loadFromShow(show.console); } catch (e) { this.log('warn', `Console profile from show: ${e.message}`); } }
    if (show.system && (SYSTEMS[show.system] || (this.pool && this.pool.has(show.system)))) this.cfg.active = show.system;
    // A show that names a desk restores it and keeps the focused system on it. Older shows (no armed) only
    // change the focus — they do not kick the other systems off the desk. Instance ids stay when that instance exists here.
    if (Array.isArray(show.armed)) this.cfg.armed = this._arm(show.armed);
    else if (show.system && SYSTEMS[show.system] && !this.cfg.armed.includes(show.system)) this.cfg.armed = this._arm([...this.cfg.armed, show.system]);
    if (this.cfg.armed.length && !this.cfg.armed.includes(this.cfg.active)) this.cfg.active = this.cfg.armed[0];
    // A show never records a simulator. If this one is no longer on the desk, stop the fixture
    // before any connection in the show is applied (stopSim clears the override synchronously).
    for (const k of Object.keys(this.sim)) if (!this.cfg.armed.includes(k)) this.stopSim(k);
    for (const k of ['e2', 'pixelhue']) {
      const x = show.systems && show.systems[k]; if (!x) continue;
      this.cfg.sessions[k] = { ...emptySession(), selection: x.selection || [], layout: x.layout || {}, tileCount: TILE_COUNTS.includes(x.tileCount) ? x.tileCount : 48, autoTake: !!x.autoTake, ...followSession(x) };
      this._cancelFollowUp(k);
      if (applyConnection && x.connection && !this.isMock(k)) { this.cfg.connections[k] = cleanConn(k, x.connection); this.driver(k).configure(this.conn(k)); this.resetCache(k); }
      this.resetTally(k);
    }
    const z = show.systems && show.systems.ptz;
    if (z) {
      this.cfg.sessions.ptz = { ...emptyPtzSession(), presetNames: z.presetNames || {}, speeds: { ...emptyPtzSession().speeds, ...(z.speeds || {}) }, selected: z.selected || null, last: {}, notes: z.notes || {}, locks: z.locks || {}, paintMem: z.paintMem || {}, liveGuard: cleanGuard(z.liveGuard) };
      if (applyConnection && Array.isArray(z.cameras) && !this.mockCams) {
        // shows carry no camera password: keep this install's login for the same camera (id + address)
        const had = this.cfg.connections.ptz.cameras;
        const cams = z.cameras.map((x) => { const { pass, ...y } = x || {}; const o = had.find((h) => h.id === y.id && h.host === y.host); return o ? { ...y, ...(o.user && !y.user ? { user: o.user } : {}), ...(typeof o.pass === 'string' ? { pass: o.pass } : {}) } : y; });
        this.cfg.connections.ptz = cleanConn('ptz', { cameras: cams }); this.drivers.ptz.configure({ cameras: this.driverCameras() }); this.syncCameraSims();
      }
    }
    const a = show.systems && show.systems.atem;
    if (a && applyConnection && a.connection && !this.isMock('atem')) { this.cfg.connections.atem = cleanConn('atem', a.connection); this.drivers.atem.configure(this.conn('atem')); }
    for (const k of MEDIA_SYS) {
      const x = show.systems && show.systems[k];
      if (x && applyConnection && x.connection && !this.isMock(k)) { this.cfg.connections[k] = cleanConn(k, x.connection); this.driver(k).configure(this.conn(k)); }
    }
    this.save(); this.changed();
  }
}

module.exports = { SystemManager, SYSTEMS, PLANNED, PRESET_SYS, MEDIA_SYS, NET_SYS, CONN_DEFAULTS, cleanConn };
