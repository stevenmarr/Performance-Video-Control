'use strict';
// 0.6.0 multi-system support. The app drives one of three switcher families, chosen on the SYSTEM tab:
//   rs6       Analog Way Aquilon RS6 (the original app: lib/engine.js, unchanged, with its own tabs)
//   e2        Barco Event Master E2 / S3-4K / Ex (JSON-RPC, lib/drivers/e2.js)
//   pixelhue  PixelHue P10 / P20 / P80 / Q8 (HTTP OpenAPI, lib/drivers/pixelhue.js)
// E2 and PixelHue share one UI (public/sys.js) through the common driver interface (lib/drivers/common.js).
// This manager keeps, per system: its connection, the destination selection (TAKE / CUT targets), the tile layout
// (MOVE / swap), and the app-tracked tally (which preset is on Preview / Program per destination). Saved in
// <dataDir>/systems.json. Nothing here ever talks to a device that is not the selected system.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { readJson, writeJsonAtomic } = require('./store');
const { E2Driver } = require('./drivers/e2');
const { PixelHueDriver } = require('./drivers/pixelhue');
const { RS6Driver } = require('./drivers/rs6');

const SYSTEMS = {
  rs6: { label: 'Analog Way Aquilon RS6', short: 'RS6' },
  e2: { label: 'Barco Event Master (E2 / S3)', short: 'E2' },
  pixelhue: { label: 'PixelHue (P10 / P20 / P80 / Q8)', short: 'PixelHue' },
};
// Next device families. The driver interface is the extension point: a new family is one driver file in
// lib/drivers/ plus an entry above. These are listed on the dashboard as planned; NO driver exists for them yet.
const PLANNED = [
  { key: 'atem', label: 'Blackmagic ATEM', short: 'ATEM', kind: 'Production switcher', note: 'Planned (stub): not built. Would need a driver for the ATEM network protocol.' },
  { key: 'ptz', label: 'PTZ cameras (VISCA over IP)', short: 'PTZ', kind: 'Cameras', note: 'Planned (stub): not built. Camera presets would map onto the same tile grid.' },
];
const CONN_DEFAULTS = {
  e2: { host: '', port: 9999, operatorId: '', transTime: '' },
  pixelhue: { host: '', port: 8088, prefix: '/pixelhue', swap: true, time: '' },
};
const CONN_TYPES = { host: 'string', port: 'number', operatorId: 'string', transTime: 'string', prefix: 'string', swap: 'boolean', time: 'string' };
const TILE_COUNTS = [24, 48, 72, 96];
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const emptySession = () => ({ selection: [], layout: {}, autoTake: false, tileCount: 48 });

function cleanConn(sys, c) {
  const out = { ...CONN_DEFAULTS[sys] };
  for (const [k, v] of Object.entries(c || {})) {
    if (!(k in out)) continue;
    const t = CONN_TYPES[k];
    if (t === 'number') { const n = Number(v); if (Number.isFinite(n) && n > 0 && n < 65536) out[k] = n; }
    else if (t === 'boolean') out[k] = !!v;
    else out[k] = String(v ?? '').trim().slice(0, 200);
  }
  if (sys === 'pixelhue' && out.prefix && !out.prefix.startsWith('/')) out.prefix = `/${out.prefix}`;
  return out;
}

class SystemManager extends EventEmitter {
  constructor({ dataDir, engine, overrides = {}, pollMs = 3000, refreshMs = 15000, autoStart = true } = {}) {
    super();
    this.engine = engine; this.dataDir = dataDir; this.overrides = overrides; this.pollMs = pollMs; this.refreshMs = refreshMs;
    this.file = path.join(dataDir, 'systems.json');
    const had = fs.existsSync(this.file);
    const raw = readJson(this.file, {});
    this.cfg = {
      version: 1,
      active: SYSTEMS[raw.active] ? raw.active : 'rs6',
      connections: { e2: cleanConn('e2', raw.connections && raw.connections.e2), pixelhue: cleanConn('pixelhue', raw.connections && raw.connections.pixelhue) },
      sessions: { e2: { ...emptySession(), ...(raw.sessions && raw.sessions.e2) }, pixelhue: { ...emptySession(), ...(raw.sessions && raw.sessions.pixelhue) } },
    };
    // Migration (0.5.0 -> 0.6.0): an existing install has only settings.json. Its RS6 connection stays where it
    // is (the Engine owns it); the new file records that RS6 is the selected system so nothing changes for it.
    this.migrated = null;
    if (!had) {
      const s = engine ? engine.settings : {};
      this.migrated = { from: '0.5.0 settings.json', rs6: { host: s.host, restPort: s.restPort, awjPort: s.awjPort }, at: new Date().toISOString() };
      this.cfg.migrated = this.migrated;
      this.save();
    } else this.migrated = raw.migrated || null;
    this.drivers = {
      rs6: engine ? new RS6Driver(engine) : null,
      e2: new E2Driver(this.conn('e2'), (l, m) => this.log(l, m)),
      pixelhue: new PixelHueDriver(this.conn('pixelhue'), (l, m) => this.log(l, m)),
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
  save() { writeJsonAtomic(this.file, this.cfg); if (this.engine && this.engine.changed && this._ready) this.engine.changed(); } // engine.changed: the show dirty dot
  conn(sys) { return { ...this.cfg.connections[sys], ...(this.overrides[sys] || {}) }; }
  isMock(sys) { return !!this.overrides[sys]; }
  sess(sys) { this.check(sys, true); return this.cfg.sessions[sys]; }
  check(sys, generic = false) {
    if (!SYSTEMS[sys]) throw err(`Unknown system "${sys}"`, 404);
    if (generic && sys === 'rs6') throw err('The RS6 uses its own tabs (/api/...)');
  }

  // ---------- lifecycle ----------
  start() {
    this.stop();
    // Live status for the dashboard: every system that has a connection configured is watched (heartbeat only;
    // a system with no IP is never contacted). The active one also gets its lists refreshed.
    const tick = () => Promise.all(['e2', 'pixelhue'].map((sys) => this._tick(sys)));
    const refresh = async () => { for (const sys of ['e2', 'pixelhue']) if (this.drivers[sys].status().connected && (sys === this.cfg.active || Date.now() - this.cache[sys].refreshedAt > 60000)) await this.refresh(sys).catch(() => {}); };
    this._timers.push(setInterval(tick, this.pollMs), setInterval(refresh, this.refreshMs));
    for (const t of this._timers) if (t.unref) t.unref();
    for (const sys of ['e2', 'pixelhue']) if (this.conn(sys).host) this.connect(sys, { quiet: sys !== this.cfg.active }).catch(() => {});
  }
  async _tick(sys) {
    this._busy = this._busy || {};
    if (this._busy[sys]) return; // a slow / unreachable device: never stack attempts
    this._busy[sys] = true;
    try {
      const d = this.drivers[sys]; if (!this.conn(sys).host) return;
      const was = d.status().connected;
      try {
        if (!was) await this.connect(sys, { quiet: true });
        else await d.heartbeat();
      } catch { /* status carries the error */ }
      if (was !== d.status().connected) { this.log(d.status().connected ? 'info' : 'warn', `${SYSTEMS[sys].short}: ${d.status().connected ? 'connected' : `connection lost (${d.status().error})`}`); this.changed(); }
    } finally { this._busy[sys] = false; }
  }
  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }
  close() { this.stop(); for (const d of Object.values(this.drivers)) if (d) d.close(); }

  async setActive(sys) {
    this.check(sys);
    if (this.cfg.active !== sys) {
      this.cfg.active = sys;
      this.save();
      this.log('info', `System: ${SYSTEMS[sys].label}`);
      this.changed();
    }
    if (sys !== 'rs6' && this.conn(sys).host) await this.connect(sys).catch(() => {});
    return this.getState();
  }
  updateConnection(sys, patch) {
    this.check(sys, true);
    if (this.isMock(sys)) throw err(`Mock mode: the ${SYSTEMS[sys].short} connection is fixed to the built-in mock`, 409);
    this.cfg.connections[sys] = cleanConn(sys, { ...this.cfg.connections[sys], ...patch });
    this.save();
    this.drivers[sys].close(); this.drivers[sys].configure(this.conn(sys));
    this.cache[sys] = this.emptyCache();
    const c = this.cfg.connections[sys];
    this.log('info', `${SYSTEMS[sys].short} connection saved: ${c.host || '(no IP)'}:${c.port}`);
    this.changed();
    return this.publicConn(sys);
  }
  publicConn(sys) { return { ...this.conn(sys), mock: this.isMock(sys) }; }

  async connect(sys, { quiet = false } = {}) {
    this.check(sys, true);
    const d = this.drivers[sys];
    try {
      const info = await d.connect();
      if (!quiet) this.log('info', `${SYSTEMS[sys].short} connected: ${info.model || ''} ${info.version || ''} at ${this.conn(sys).host}`);
      await this.refresh(sys);
    } catch (e) {
      if (!quiet) this.log('error', `${SYSTEMS[sys].short} connect failed: ${e.message}`);
      this.changed(); throw e;
    }
    this.changed();
    return d.status();
  }
  async refresh(sys) {
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

  // ---------- views ----------
  view(sys) {
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
      system: sys, label: SYSTEMS[sys].label, short: SYSTEMS[sys].short, capabilities: d.capabilities, status: d.status(), connection: this.publicConn(sys),
      destinations: c.destinations.map((x) => ({ ...x, selected: sel.has(x.key), pvwPreset: ref(t.pvw[x.key]), pgmPreset: ref(t.pgm[x.key]) })),
      presets, sources: c.sources, cues: c.cues, stills: c.stills, backups: c.backups, errors: c.errors, refreshedAt: c.refreshedAt,
      selection: [...s.selection], autoTake: !!s.autoTake, tileCount: s.tileCount || 48, lastRecalled: ref(t.last),
    };
  }
  getState() {
    const systems = {};
    for (const [k, v] of Object.entries(SYSTEMS)) {
      const d = this.drivers[k];
      const e = this.engine; const c = this.cache[k];
      const counts = k === 'rs6' ? (e ? { presets: e.presets.length, destinations: e.destinations.length, sources: Object.keys((e.live && e.live.inputs) || {}).length } : null)
        : { presets: c.presets.length, destinations: c.destinations.length, sources: c.sources.length, cues: c.cues.length, refreshedAt: c.refreshedAt };
      systems[k] = { key: k, ...v, status: d ? d.status() : null, counts, capabilities: d ? d.capabilities : null,
        connection: k === 'rs6' ? (e ? { host: e.settings.host, restPort: e.settings.restPort, awjPort: e.settings.awjPort, protocol: e.settings.protocol, mock: !!e.settings.mock } : null) : this.publicConn(k) };
    }
    return { rev: this.rev, active: this.cfg.active, systems, planned: PLANNED, migrated: this.migrated, view: this.cfg.active === 'rs6' ? null : this.view(this.cfg.active) };
  }

  // ---------- show files (0.6.0, show format 2) ----------
  showPart({ includeConnection = false } = {}) {
    const systems = {};
    for (const k of ['e2', 'pixelhue']) {
      const s = this.cfg.sessions[k];
      systems[k] = { selection: [...s.selection], layout: { ...s.layout }, tileCount: s.tileCount, autoTake: !!s.autoTake };
      if (includeConnection) systems[k].connection = { ...this.cfg.connections[k] };
    }
    return { system: this.cfg.active, systems };
  }
  applyShowPart(show, { applyConnection = false } = {}) {
    if (show.system && SYSTEMS[show.system]) this.cfg.active = show.system;
    for (const k of ['e2', 'pixelhue']) {
      const x = show.systems && show.systems[k]; if (!x) continue;
      this.cfg.sessions[k] = { ...emptySession(), selection: x.selection || [], layout: x.layout || {}, tileCount: TILE_COUNTS.includes(x.tileCount) ? x.tileCount : 48, autoTake: !!x.autoTake };
      if (applyConnection && x.connection && !this.isMock(k)) { this.cfg.connections[k] = cleanConn(k, x.connection); this.drivers[k].configure(this.conn(k)); this.cache[k] = this.emptyCache(); }
      this.tally[k] = { pvw: {}, pgm: {}, last: null };
    }
    this.save(); this.changed();
  }
}

module.exports = { SystemManager, SYSTEMS, PLANNED, CONN_DEFAULTS, cleanConn };
