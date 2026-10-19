'use strict';
// E2-style preset engine: destination selection, preset CRUD, recall-to-preview, take/cut, app-side tally.
const path = require('path');
const { EventEmitter } = require('events');
const { Device, parseDest } = require('./device');
const { readJson, writeJsonAtomic, DEFAULT_SETTINGS, NUMERIC_SETTINGS } = require('./store');
const { Live } = require('./live');
const { restToAwj } = require('./paths');

const MAX_LOG = 400;

class Engine extends EventEmitter {
  constructor({ dataDir, settingsOverride = {}, deviceFactory } = {}) {
    super();
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.presetsFile = path.join(dataDir, 'presets.json');
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}), ...settingsOverride };
    const saved = readJson(this.presetsFile, { presets: [] });
    this.presets = Array.isArray(saved) ? saved : (saved.presets || []);
    this.destinations = []; this.selection = new Set();
    this.pvw = {}; this.pgm = {}; this.lastRecalled = null;
    this.logs = []; this.connected = false; this.system = null; this.lastError = null;
    this.deviceFactory = deviceFactory || ((s, log) => new Device(s, log));
    this.device = this.deviceFactory(this.settings, (lvl, msg) => this.log(lvl, msg));
    this._chain = Promise.resolve();
    this.rev = 0;
    this.live = new Live({ device: this.device, settings: this.settings, log: (lvl, msg) => this.log(lvl, msg) });
    this.live.on('change', () => this.changed());
    this.liveReady = Promise.resolve();
  }

  // ---------- infra ----------
  log(level, msg) {
    const e = { t: new Date().toISOString(), level, msg };
    this.logs.push(e); if (this.logs.length > MAX_LOG) this.logs.shift();
    this.emit('log', e);
    if (process.env.RS6_QUIET !== '1') console.log(`[${e.t}] ${level.toUpperCase()} ${msg}`);
  }
  changed() { this.rev++; this.emit('state'); }
  close() { this.live.stop(); this.device.close(); }
  exclusive(fn) { const p = this._chain.then(fn, fn); this._chain = p.catch(() => {}); return p; }
  savePresets() { writeJsonAtomic(this.presetsFile, { version: 1, presets: this.presets }); }
  saveSettings() { writeJsonAtomic(this.settingsFile, this.settings); }
  getPreset(number) { return this.presets.find((p) => p.number === Number(number)); }
  nextFreeNumber(from = 1) { let n = Math.max(1, Number(from) || 1); while (this.getPreset(n)) n++; return n; }
  destLabel(key) { const d = this.destinations.find((x) => x.key === key); return d ? d.label : key; }

  publicSettings() { const { password, ...rest } = this.settings; return { ...rest, passwordSet: !!password }; }

  updateSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      if (k === 'password' && patch.password === undefined) continue;
      this.settings[k] = patch[k];
    }
    for (const k of NUMERIC_SETTINGS) this.settings[k] = Number(this.settings[k]);
    if (!['rest', 'awj'].includes(this.settings.protocol)) this.settings.protocol = 'rest';
    this.saveSettings();
    this.live.stop();
    this.device.configure(this.settings);
    this.connected = false;
    this.log('info', `Settings saved: ${this.settings.host} REST:${this.settings.restPort} AWJ:${this.settings.awjPort} protocol=${this.settings.protocol}`);
    this.changed();
  }

  // ---------- connection ----------
  connect() {
    return this.exclusive(async () => {
      try {
        this.system = await this.device.getSystem();
        const v = this.system && this.system.version;
        const ver = v && typeof v === 'object' ? `${v.major}.${v.minor}.${v.patch}` : v;
        this.log('info', `Connected: ${this.system.type || '?'} "${this.system.label || ''}" fw ${ver || '?'}`);
        this.destinations = await this.device.listDestinations({ maxScreens: this.settings.maxScreens, maxAux: this.settings.maxAux });
        this.log('info', `Destinations: ${this.destinations.map((d) => `${d.key} ${d.label}`).join(', ') || 'none found'}`);
        for (const k of [...this.selection]) if (!this.destinations.find((d) => d.key === k)) this.selection.delete(k);
        this.connected = true; this.lastError = null;
        this.liveReady = this.live.start(this.destinations);
      } catch (e) {
        this.connected = false; this.lastError = e.message;
        this.log('error', `Connect failed: ${e.message}`);
      }
      this.changed();
      return this.connected;
    });
  }

  // ---------- selection ----------
  toggleDest(key) {
    const k = parseDest(key).key;
    if (this.selection.has(k)) this.selection.delete(k); else this.selection.add(k);
    this.changed(); return [...this.selection];
  }
  setSelection(keys) { this.selection = new Set((keys || []).map((k) => parseDest(k).key)); this.changed(); return [...this.selection]; }

  // ---------- capture ----------
  async capture(dests, known = {}) {
    const memories = {}; const sources = {}; const warnings = [];
    for (const d of dests) {
      if (this.settings.awjReadback && !known[d]) {
        try {
          const id = await this.device.readPreviewMemoryId(d);
          if (id) memories[d] = id; else warnings.push(`${d}: no Screen memory reported on Preview`);
        } catch (e) { warnings.push(`${d}: AWJ readback unavailable (${e.message})`); }
      }
      try { sources[d] = await this.device.readSources(d, 'preview', this.settings.maxLayers); }
      catch (e) { warnings.push(`${d}: source snapshot failed (${e.message})`); }
    }
    return { memories, sources, warnings };
  }

  _applyCapture(preset, cap, explicitMemories) {
    preset.memories = {}; preset.sources = {};
    for (const d of preset.destinations) {
      const explicit = explicitMemories && explicitMemories[d];
      if (explicit) preset.memories[d] = Number(explicit);
      else if (cap.memories[d]) preset.memories[d] = cap.memories[d];
      if (cap.sources[d]) preset.sources[d] = cap.sources[d];
    }
    for (const w of cap.warnings) this.log('warn', `Preset ${preset.number}: ${w}`);
    const missing = preset.destinations.filter((d) => !preset.memories[d] && !(preset.sources[d] && preset.sources[d].layers.length));
    if (missing.length) this.log('warn', `Preset ${preset.number}: nothing recallable for ${missing.join(', ')}. Enter a Screen memory slot in Edit.`);
  }

  // ---------- CRUD ----------
  savePreset({ number, name, destinations, memories } = {}) {
    return this.exclusive(async () => {
      const dests = (destinations && destinations.length ? destinations : [...this.selection]).map((k) => parseDest(k).key);
      if (!dests.length) throw new Error('Select at least one destination before saving');
      const n = number ? Number(number) : this.nextFreeNumber();
      if (!(n >= 1 && n <= 9999)) throw new Error('Preset number must be 1-9999');
      const existing = this.getPreset(n);
      const preset = existing || { number: n, createdAt: new Date().toISOString() };
      preset.name = (name || (existing && existing.name) || `Preset ${n}`).slice(0, 64);
      preset.destinations = dests;
      preset.updatedAt = new Date().toISOString();
      const cap = await this.capture(dests, memories || {});
      this._applyCapture(preset, cap, memories);
      if (!existing) this.presets.push(preset);
      this.presets.sort((a, b) => a.number - b.number);
      this.savePresets();
      this.log('info', `${existing ? 'Overwrote' : 'Saved'} preset ${n} "${preset.name}" -> ${dests.map((d) => `${d}${preset.memories[d] ? `=mem ${preset.memories[d]}` : '=sources'}`).join(', ')}`);
      this.changed();
      return preset;
    });
  }

  // Update: re-capture the preset's own destinations (or the current selection when useSelection is true).
  updatePreset(number, { useSelection = false } = {}) {
    const p = this.getPreset(number); if (!p) return Promise.reject(new Error(`No preset ${number}`));
    const dests = useSelection ? [...this.selection] : p.destinations;
    return this.savePreset({ number: p.number, name: p.name, destinations: dests });
  }

  editPreset(number, { name, newNumber, memories, destinations, color } = {}) {
    const p = this.getPreset(number); if (!p) throw new Error(`No preset ${number}`);
    if (newNumber !== undefined && Number(newNumber) !== p.number) {
      const nn = Number(newNumber);
      if (!(nn >= 1 && nn <= 9999)) throw new Error('Preset number must be 1-9999');
      if (this.getPreset(nn)) throw new Error(`Preset ${nn} already exists`);
      for (const map of [this.pvw, this.pgm]) for (const k of Object.keys(map)) if (map[k] === p.number) map[k] = nn;
      if (this.lastRecalled === p.number) this.lastRecalled = nn;
      p.number = nn;
    }
    if (typeof name === 'string' && name.trim()) p.name = name.trim().slice(0, 64);
    if (Array.isArray(destinations) && destinations.length) p.destinations = destinations.map((k) => parseDest(k).key);
    if (memories && typeof memories === 'object') {
      p.memories = {};
      for (const [k, v] of Object.entries(memories)) {
        const key = parseDest(k).key; const slot = Number(v);
        if (slot >= 1 && slot <= 1000 && p.destinations.includes(key)) p.memories[key] = slot;
      }
    }
    if (typeof color === 'string') p.color = color;
    p.updatedAt = new Date().toISOString();
    this.presets.sort((a, b) => a.number - b.number);
    this.savePresets(); this.log('info', `Edited preset ${p.number} "${p.name}"`); this.changed();
    return p;
  }

  deletePreset(number) {
    const i = this.presets.findIndex((p) => p.number === Number(number));
    if (i < 0) throw new Error(`No preset ${number}`);
    const [p] = this.presets.splice(i, 1);
    for (const map of [this.pvw, this.pgm]) for (const k of Object.keys(map)) if (map[k] === p.number) delete map[k];
    if (this.lastRecalled === p.number) this.lastRecalled = null;
    this.savePresets(); this.log('info', `Deleted preset ${p.number} "${p.name}"`); this.changed();
  }

  duplicatePreset(number, toNumber) {
    const p = this.getPreset(number); if (!p) throw new Error(`No preset ${number}`);
    const n = toNumber ? Number(toNumber) : this.nextFreeNumber(p.number + 1);
    if (this.getPreset(n)) throw new Error(`Preset ${n} already exists`);
    const copy = JSON.parse(JSON.stringify(p));
    Object.assign(copy, { number: n, name: `${p.name} copy`.slice(0, 64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    this.presets.push(copy); this.presets.sort((a, b) => a.number - b.number);
    this.savePresets(); this.log('info', `Duplicated preset ${p.number} -> ${n}`); this.changed();
    return copy;
  }

  // ---------- show control ----------
  recall(number) {
    return this.exclusive(async () => {
      const p = this.getPreset(number); if (!p) throw new Error(`No preset ${number}`);
      this.selection = new Set(p.destinations); // E2 behaviour: selection follows the recalled preset
      const done = []; const failed = [];
      for (const d of p.destinations) {
        try {
          if (p.memories && p.memories[d]) { await this.device.loadMemory(d, p.memories[d], 'preview'); }
          else if (p.sources && p.sources[d] && p.sources[d].layers.length) { await this.device.writeSources(d, p.sources[d], 'preview'); }
          else throw new Error('no Screen memory slot or source snapshot stored');
          this.pvw[d] = p.number; done.push(d);
        } catch (e) { failed.push(d); this.log('error', `Recall ${p.number} on ${d} failed: ${e.message}`); }
      }
      this.lastRecalled = p.number;
      this.log(failed.length ? 'warn' : 'info', `Recalled preset ${p.number} "${p.name}" to PVW on ${done.join(', ') || 'nothing'}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
      this.changed();
      if (this.settings.autoTake && done.length) await this._take();
      return { done, failed };
    });
  }

  take() { return this.exclusive(() => this._take()); }

  async _take() {
    const dests = [...this.selection];
    if (!dests.length) { this.log('warn', 'TAKE ignored: no destinations selected'); return { done: [] }; }
    try { await this.device.take(dests); }
    catch (e) { this.log('error', `TAKE failed: ${e.message}`); this.changed(); throw e; }
    this._afterTransition(dests);
    this.log('info', `TAKE on ${dests.join(', ')}`);
    this.changed();
    return { done: dests };
  }

  // Take Cut is not documented in the AWJ/REST guides. CUT = load the same Screen memory (or source snapshot)
  // that is on Preview straight to Program (REST p.12 target "program" / AWJ p.9 PROGRAM), which has no transition.
  cut() {
    return this.exclusive(async () => {
      const dests = [...this.selection];
      if (!dests.length) { this.log('warn', 'CUT ignored: no destinations selected'); return { done: [] }; }
      const done = []; const skipped = [];
      const eff = this.effectiveMaps();
      for (const d of dests) {
        const p = this.getPreset(eff.pvw[d] ?? this.pvw[d]);
        if (!p) { skipped.push(d); continue; }
        try {
          if (p.memories && p.memories[d]) await this.device.loadMemory(d, p.memories[d], 'program');
          else if (p.sources && p.sources[d]) await this.device.writeSources(d, p.sources[d], 'program');
          else { skipped.push(d); continue; }
          done.push(d);
        } catch (e) { skipped.push(d); this.log('error', `CUT on ${d} failed: ${e.message}`); }
      }
      if (skipped.length) this.log('warn', `CUT skipped ${skipped.join(', ')}: no app preset known on Preview (use TAKE)`);
      this._afterTransition(done);
      this.log('info', `CUT on ${done.join(', ') || 'nothing'}`);
      this.changed();
      return { done, skipped };
    });
  }

  _afterTransition(dests) {
    for (const d of dests) {
      const prevPgm = this.pgm[d];
      if (this.pvw[d] !== undefined) this.pgm[d] = this.pvw[d]; else delete this.pgm[d];
      if (this.settings.presetToggle) { if (prevPgm !== undefined) this.pvw[d] = prevPgm; else delete this.pvw[d]; }
    }
  }

  setAutoTake(v) {
    this.settings.autoTake = v === undefined ? !this.settings.autoTake : !!v;
    this.saveSettings(); this.log('info', `Auto take on recall: ${this.settings.autoTake ? 'ON' : 'OFF'}`); this.changed();
    return this.settings.autoTake;
  }

  // ---------- real tally from live device state ----------
  // dest -> app preset number on PVW / PGM. With AWJ the device's "last Screen memory loaded" per side
  // (§3.11) is matched against each preset's slot; destinations without a slot (and REST polling, which
  // has no memory read) are matched on the stored layer-source snapshot. Without live data the app's
  // own record of recalls/takes is used.
  effectiveMaps() {
    const L = this.live;
    if (!L || L.mode === 'off' || !this.connected) return { pvw: { ...this.pvw }, pgm: { ...this.pgm }, source: 'app' };
    const out = { pvw: {}, pgm: {}, source: L.hasMemoryInfo ? 'device-memory' : 'device-sources' };
    for (const d of L.dests) {
      const v = L.destView(d); if (!v || !v.transition) continue;
      for (const [which, key, internal] of [['preview', 'pvw', this.pvw], ['program', 'pgm', this.pgm]]) {
        const side = v[which]; const memId = side.memory && side.memory.id;
        const cands = this.presets.filter((p) => p.destinations.includes(d) && (
          (p.memories && p.memories[d]) ? (L.hasMemoryInfo ? p.memories[d] === memId : this._sourcesMatch(p, d, side)) : this._sourcesMatch(p, d, side)));
        if (!cands.length) continue;
        const pick = cands.find((p) => p.number === internal[d]) || cands.find((p) => p.number === this.lastRecalled) || cands[0];
        out[key][d] = pick.number;
      }
    }
    return out;
  }

  _sourcesMatch(p, d, side) {
    const snap = p.sources && p.sources[d];
    if (!snap || !snap.layers || !snap.layers.length) return false;
    for (const l of snap.layers) if ((side.layers[l.layer] || 'NONE') !== restToAwj(l.sourceType, l.sourceId)) return false;
    if (snap.background && d[0] === 'S' && side.background !== restToAwj(snap.background.sourceType, snap.background.sourceId)) return false;
    return true;
  }

  // ---------- state ----------
  presetTally(p, eff = this.effectiveMaps()) {
    const on = (map) => {
      const n = p.destinations.filter((d) => map[d] === p.number).length;
      return n === 0 ? 'none' : n === p.destinations.length ? 'full' : 'partial';
    };
    return { pvw: on(eff.pvw), pgm: on(eff.pgm) };
  }

  getState() {
    const last = this.lastRecalled ? this.getPreset(this.lastRecalled) : null;
    const eff = this.effectiveMaps();
    const pgmPresets = this.presets.filter((p) => this.presetTally(p, eff).pgm === 'full').map((p) => p.number);
    const live = this.live.snapshot();
    return {
      app: 'rs6-presets', version: 2, rev: this.rev,
      mock: !!this.settings.mock, connected: this.connected, lastError: this.lastError, system: this.system,
      settings: this.publicSettings(),
      autoTake: !!this.settings.autoTake,
      destinations: this.destinations.map((d) => {
        const lv = live.destinations[d.key];
        return { ...d, selected: this.selection.has(d.key), pvwPreset: eff.pvw[d.key] ?? null, pgmPreset: eff.pgm[d.key] ?? null,
          programMemory: lv ? lv.program.memory : null, previewMemory: lv ? lv.preview.memory : null,
          programLayer1: lv ? lv.program.layer1Label : '', transition: lv ? lv.transition : null };
      }),
      selection: [...this.selection],
      lastRecalled: last ? { number: last.number, name: last.name } : null,
      programPresets: pgmPresets,
      presets: this.presets.map((p) => {
        const t = this.presetTally(p, eff);
        return { number: p.number, name: p.name, color: p.color || null, destinations: p.destinations, memories: p.memories || {},
          hasSources: Object.fromEntries(p.destinations.map((d) => [d, !!(p.sources && p.sources[d] && p.sources[d].layers.length)])),
          tally: t, onPreview: t.pvw === 'full', onProgram: t.pgm === 'full', lastRecalled: this.lastRecalled === p.number,
          updatedAt: p.updatedAt };
      }),
      tally: { preview: { ...eff.pvw }, program: { ...eff.pgm }, source: eff.source },
      live,
    };
  }
}

module.exports = { Engine };
