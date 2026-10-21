'use strict';
// E2-style preset engine: destination selection, preset CRUD, recall-to-preview, take/cut, app-side tally,
// and (0.3.0) combined presets built from imported device memories: per destination a Screen memory,
// optionally a Master memory, and per Multiviewer output a Multiviewer memory.
const naming = require('./naming');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Device, parseDest } = require('./device');
const { readJson, writeJsonAtomic, DEFAULT_SETTINGS, NUMERIC_SETTINGS } = require('./store');
const { Live } = require('./live');
const { restToAwj } = require('./paths');
const APP_VERSION = require('../package.json').version;
const shows = require('./shows');
// 0.5.0: HTTP API version for clients (the Companion module warns when it differs). Bump on any change a client
// could notice. 3 = 0.3.x, 4 = 0.4.0 (swap, Layer removed, backup groups), 5 = 0.5.0 (tileCount, shows, /api/version).
const API_VERSION = 5;
const API_FEATURES = ['presets', 'longpoll', 'swap', 'tileCount', 'shows', 'backupGroups', 'memories', 'live'];

const MAX_LOG = 400;
const PRESET_FILE_VERSION = 2; // 1 = v0.1/v0.2 (destinations/memories/sources), 2 = + master, mvMemories
const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });
const destOrder = (k) => (k[0] === 'S' ? 0 : k[0] === 'A' ? 1000 : 2000) + Number(k.slice(1));
const sortKeys = (keys) => [...new Set(keys)].sort((a, b) => destOrder(a) - destOrder(b));

// Fill the v2 fields on a stored preset without touching anything that was there (v1 -> v2 migration).
function normalizePreset(p) {
  if (!Array.isArray(p.destinations)) p.destinations = [];
  if (!p.memories || typeof p.memories !== 'object') p.memories = {};
  if (!p.sources || typeof p.sources !== 'object') p.sources = {};
  if (p.master === undefined || (p.master && !(Number(p.master.slot) >= 1))) p.master = null;
  if (p.master && !Array.isArray(p.master.dests)) p.master.dests = [];
  if (!p.mvMemories || typeof p.mvMemories !== 'object') p.mvMemories = {};
  return p;
}
const emptyStage = () => ({ memories: {}, master: null, mvMemories: {}, editing: null });

class Engine extends EventEmitter {
  constructor({ dataDir, settingsOverride = {}, deviceFactory, dataInfo = {} } = {}) {
    super();
    this.dataDir = dataDir;
    this.dataInfo = { dir: dataDir, source: dataInfo.source || 'custom', migration: dataInfo.migration || null };
    this.workingFile = path.join(dataDir, 'working.json');
    this.library = new shows.ShowLibrary(dataDir);
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.presetsFile = path.join(dataDir, 'presets.json');
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}), ...settingsOverride };
    delete this.settings.layerMemories; // 0.4.0: the 0.3.4 inferred Layer memory feature was removed
    this.logs = []; this.connected = false; this.system = null; this.lastError = null;
    this._loadPresets();
    this.destinations = []; this.multiviewers = []; this.selection = new Set();
    this.pvw = {}; this.pgm = {}; this.lastRecalled = null;
    this.masterApp = { preview: null, program: null }; // app-side record of Master loads (used when live state is off)
    this.staging = emptyStage();
    this.settings.tileCount = shows.tileCountFor(this.settings.tileCount) || DEFAULT_SETTINGS.tileCount;
    // 0.5.0: the working state is autosaved, so a restart (or a new version) reopens where it was
    const w = readJson(this.workingFile, {});
    this.currentShow = { name: 'Untitled show', id: null, savedHash: null, savedAt: null, ...(w.show || {}) };
    if (Array.isArray(w.selection)) this.selection = new Set(w.selection.filter((k) => /^[SA]\d+$/.test(k)));
    if (w.staging && typeof w.staging === 'object') this.staging = { ...emptyStage(), ...w.staging, editing: null };
    this.memoriesReady = Promise.resolve();
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
  changed() { this.rev++; this._saveWorkingSoon(); this.emit('state'); }
  _saveWorkingSoon() {
    if (this._wt) return;
    this._wt = setTimeout(() => { this._wt = null; this.saveWorking(); }, 250);
    if (this._wt.unref) this._wt.unref();
  }
  saveWorking() {
    const { editing, ...stage } = this.staging; void editing;
    try { writeJsonAtomic(this.workingFile, { selection: [...this.selection], staging: stage, show: this.currentShow }); } catch (e) { if (!this._wErr) { this._wErr = true; this.log('warn', `Could not save the working state: ${e.message}`); } }
  }
  close() { if (this._wt) { clearTimeout(this._wt); this._wt = null; this.saveWorking(); } this.live.stop(); this.device.close(); }
  exclusive(fn) { const p = this._chain.then(fn, fn); this._chain = p.catch(() => {}); return p; }
  savePresets() { writeJsonAtomic(this.presetsFile, { version: PRESET_FILE_VERSION, presets: this.presets }); }

  // Same file, same {version, presets} envelope. Older files are copied to presets.v<N>.bak.json once,
  // then rewritten as version 2 with every original field kept.
  _loadPresets() {
    const saved = readJson(this.presetsFile, { presets: [] });
    const list = Array.isArray(saved) ? saved : (saved.presets || []);
    this.presets = list.filter((p) => p && Number(p.number) >= 1).map(normalizePreset);
    const ver = Array.isArray(saved) ? 0 : Number(saved.version || 1);
    if (ver < PRESET_FILE_VERSION && this.presets.length) {
      const bak = path.join(this.dataDir, `presets.v${ver}.bak.json`);
      try { if (!fs.existsSync(bak)) fs.copyFileSync(this.presetsFile, bak); } catch (e) { this.log('warn', `Could not back up ${this.presetsFile}: ${e.message}`); }
      this.savePresets();
      this.log('info', `Migrated ${this.presets.length} presets from file version ${ver} to ${PRESET_FILE_VERSION} (backup: ${path.basename(bak)})`);
    }
  }
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
    this.settings.tileCount = shows.tileCountFor(this.settings.tileCount) || DEFAULT_SETTINGS.tileCount;
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
        try { this.multiviewers = await this.device.listMultiviewers(this.settings.maxMultiviewers); }
        catch (e) { this.multiviewers = []; this.log('warn', `Multiviewer list failed: ${e.message}`); }
        if (this.multiviewers.length) this.log('info', `Multiviewers: ${this.multiviewers.map((d) => `${d.key} ${d.label}`).join(', ')}`);
        this.liveReady = this.live.start(this.destinations);
        // Memory import: with live state on, the first full AWJ read includes every bank; otherwise read now.
        this.memoriesReady = this.settings.liveEnabled === false
          ? this.live.refreshMemories().then((c) => { this._logImport(c); this.changed(); }, (e) => this.log('warn', e.message))
          : this.liveReady.then(() => { if (this.live.memImport.at) this._logImport(this.live.memoryCatalog()); });
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

  // ---------- imported memories ----------
  _logImport(c) {
    const n = Object.entries(c.items).map(([t, l]) => `${l.length} ${t}`).join(', ');
    this.log('info', `Imported memories from the device: ${n}${c.probe ? ' (isValid probe on)' : ' (labels only)'}`);
  }
  async refreshMemories() {
    try { const c = await this.live.refreshMemories(); this._logImport(c); this.changed(); return c; }
    catch (e) { this.log('error', e.message); throw Object.assign(e, { status: 409 }); }
  }
  memoryCatalog(opts) { return this.live.memoryCatalog(opts); }

  // Load one memory right now (palette double-tap, Companion). Screen memory -> only that destination.
  loadMemoryNow({ type = 'screen', slot, dest, target = 'preview' } = {}) {
    return this.exclusive(async () => {
      const tgt = target === 'program' ? 'program' : 'preview';
      if (type === 'master') { await this.device.loadMaster(slot, tgt); this.masterApp[tgt] = Number(slot); this.live.noteMasterLoad(tgt, slot, null); }
      else if (type === 'multiviewer') { await this.device.loadMvMemory(this._mvKey(dest), slot); }
      else if (type === 'screen') { const d = this._destKey(dest); await this.device.loadMemory(d, slot, tgt); this.live.noteLoad(d, tgt, slot); delete (tgt === 'program' ? this.pgm : this.pvw)[d]; }
      else throw err400(`Unknown memory type "${type}"`);
      this.log('info', `Loaded ${type} memory ${slot}${type === 'master' ? '' : ` to ${dest}`}${type === 'multiviewer' ? '' : ` (${tgt})`}`);
      this.changed();
      return { ok: true };
    });
  }

  // ---------- combined presets: assignment (drag-assign API) ----------
  _destKey(k) {
    let d; try { d = parseDest(k); } catch (e) { throw err400(e.message); }
    if (this.destinations.length && !this.destinations.find((x) => x.key === d.key)) throw err400(`Unknown destination ${d.key}`);
    return d.key;
  }
  _mvKey(k) {
    const m = /^M(\d+)$/i.exec(String(k || '')); if (!m) throw err400(`Bad Multiviewer key "${k}" (expected M<n>)`);
    const key = `M${Number(m[1])}`;
    if (this.multiviewers.length && !this.multiviewers.find((x) => x.key === key)) throw err400(`Unknown Multiviewer output ${key}`);
    return key;
  }
  defaultMasterDests() { return this.destinations.map((d) => d.key); }

  // Apply one {target, type, slot} to a composition (a preset or the staging board). slot null/0 removes.
  // target: S<n>/A<n> (type screen), M<n> (type multiviewer) or "master" (type master).
  _assign(c, { target, type, slot, dests } = {}) {
    const t = String(target || '').trim();
    const n = slot === null || slot === undefined || slot === '' || Number(slot) === 0 ? null : Number(slot);
    const need = (want) => { if (type && type !== want) throw err400(`A ${type} memory cannot go on ${t} (needs a ${want} memory)`); };
    const range = (max) => { if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= max)) throw err400(`Slot ${slot} out of range 1-${max}`); };
    if (/^master$/i.test(t)) {
      need('master'); range(500);
      if (n === null) { c.master = null; return 'master'; }
      const ds = Array.isArray(dests) ? sortKeys(dests.map((k) => this._destKey(k))) : (c.master && c.master.dests) || this.defaultMasterDests();
      c.master = { slot: n, dests: ds };
      return 'master';
    }
    if (/^M\d+$/i.test(t)) {
      need('multiviewer'); range(50); const k = this._mvKey(t);
      if (n === null) delete c.mvMemories[k]; else c.mvMemories[k] = n;
      return k;
    }
    need('screen'); range(1000); const d = this._destKey(t);
    if (n === null) { delete c.memories[d]; if (c.sources) delete c.sources[d]; if (c.destinations) c.destinations = c.destinations.filter((x) => x !== d); }
    else { c.memories[d] = n; if (c.sources) delete c.sources[d]; if (c.destinations) c.destinations = sortKeys([...c.destinations, d]); }
    return d;
  }

  _describe(c) {
    const parts = [];
    if (c.master) parts.push(`Master ${c.master.slot}`);
    for (const d of sortKeys(Object.keys(c.memories || {}))) parts.push(`${d}=mem ${c.memories[d]}`);
    for (const k of sortKeys(Object.keys(c.mvMemories || {}))) parts.push(`${k}=MV mem ${c.mvMemories[k]}`);
    return parts.join(', ') || 'nothing';
  }

  assignToPreset(number, body = {}) {
    const n = Number(number);
    if (!(n >= 1 && n <= 9999)) throw err400('Preset number must be 1-9999');
    let p = this.getPreset(n); const created = !p;
    if (!p) p = normalizePreset({ number: n, name: '', createdAt: new Date().toISOString() });
    const where = this._assign(p, body);
    if (body.name !== undefined) p.name = naming.nameToStore(body.name, p, p, this.memLabels());
    p.updatedAt = new Date().toISOString();
    if (created) { this.presets.push(p); this.presets.sort((a, b) => a.number - b.number); }
    this.savePresets();
    this.log('info', `Preset ${n} "${this.presetName(p)}": ${body.slot ? `${body.type || 'screen'} memory ${body.slot} -> ${where}` : `cleared ${where}`}${created ? ' (new preset)' : ''}`);
    this.changed();
    return p;
  }

  // ---------- staging board ----------
  stage(body) { const where = this._assign(this.staging, body); this.changed(); return { ...this.staging, last: where }; }
  clearStage() { this.staging = emptyStage(); this.changed(); return this.staging; }
  stageFromPreset(number) {
    const p = this.getPreset(number); if (!p) throw err400(`No preset ${number}`);
    this.staging = { memories: { ...p.memories }, master: p.master ? { slot: p.master.slot, dests: [...p.master.dests] } : null, mvMemories: { ...p.mvMemories }, editing: p.number };
    this.changed(); return this.staging;
  }
  saveStage({ number, name } = {}) {
    const c = this.staging;
    const n = Number(number || c.editing || this.nextFreeNumber());
    if (!(n >= 1 && n <= 9999)) throw err400('Preset number must be 1-9999');
    if (!c.master && !Object.keys(c.memories).length && !Object.keys(c.mvMemories).length) throw err400('The board is empty: drag at least one memory onto a screen, aux, multiviewer or the Master slot');
    const existing = this.getPreset(n);
    const p = existing || normalizePreset({ number: n, createdAt: new Date().toISOString() });
    p.memories = { ...c.memories }; p.destinations = sortKeys(Object.keys(c.memories)); p.sources = {};
    p.master = c.master ? { slot: c.master.slot, dests: [...c.master.dests] } : null;
    p.mvMemories = { ...c.mvMemories };
    p.name = naming.nameToStore(name, existing, p, this.memLabels());
    p.updatedAt = new Date().toISOString();
    if (!existing) { this.presets.push(p); this.presets.sort((a, b) => a.number - b.number); }
    this.savePresets(); this.staging.editing = n;
    this.log('info', `${existing ? 'Overwrote' : 'Saved'} preset ${n} "${this.presetName(p)}" from the board: ${this._describe(p)}`);
    this.changed();
    return p;
  }
  loadStage({ target = 'preview' } = {}) {
    return this.exclusive(async () => {
      const r = await this._loadComposition(this.staging, target === 'program' ? 'program' : 'preview', null);
      this.log(r.failed.length ? 'warn' : 'info', `Loaded board to ${target === 'program' ? 'PGM' : 'PVW'}: ${r.done.join(', ') || 'nothing'}${r.failed.length ? ` (failed: ${r.failed.join(', ')})` : ''}`);
      this.changed();
      return r;
    });
  }

  targetsOf(c) {
    const t = [...(c.destinations || Object.keys(c.memories || {}))];
    if (c.master) t.push(...(c.master.dests || []));
    return sortKeys(t.filter((k) => /^[SA]\d+$/.test(k)));
  }

  // Load a composition. Order: Master first (it may touch several screens), then each Screen memory to
  // ONLY its own destination (per-destination load, AWJ §3.3 / REST §3.2 §4.2 - never the RC400T-style
  // "load to all selected screens"), then Multiviewer memories per output. preset = app preset number or null.
  async _loadComposition(c, target, preset) {
    const done = []; const failed = []; const map = target === 'program' ? this.pgm : this.pvw;
    this.selection = new Set(this.targetsOf(c)); // E2 behaviour: selection follows the recalled look
    if (c.master) {
      try {
        await this.device.loadMaster(c.master.slot, target); this.masterApp[target] = c.master.slot; done.push('master');
        this.live.noteMasterLoad(target, c.master.slot, c.master.dests);
        for (const d of c.master.dests || []) { if (preset) map[d] = preset; else delete map[d]; }
      } catch (e) { failed.push('master'); this.log('error', `Master memory ${c.master.slot} load failed: ${e.message}`); }
    }
    const dests = c.destinations || sortKeys(Object.keys(c.memories || {}));
    for (const d of dests) {
      try {
        if (c.memories && c.memories[d]) { await this.device.loadMemory(d, c.memories[d], target); this.live.noteLoad(d, target, c.memories[d]); }
        else if (c.sources && c.sources[d] && c.sources[d].layers && c.sources[d].layers.length) await this.device.writeSources(d, c.sources[d], target);
        else throw new Error('no Screen memory slot or source snapshot stored');
        if (preset) map[d] = preset; else delete map[d];
        done.push(d);
      } catch (e) { failed.push(d); this.log('error', `${preset ? `Recall ${preset}` : 'Board load'} on ${d} failed: ${e.message}`); }
    }
    for (const k of sortKeys(Object.keys(c.mvMemories || {}))) {
      try { await this.device.loadMvMemory(k, c.mvMemories[k]); done.push(k); }
      catch (e) { failed.push(k); this.log('error', `Multiviewer memory ${c.mvMemories[k]} on ${k} failed: ${e.message}`); }
    }
    return { done, failed };
  }

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
      const preset = existing || normalizePreset({ number: n, createdAt: new Date().toISOString() });
      preset.destinations = dests;
      preset.updatedAt = new Date().toISOString();
      const cap = await this.capture(dests, memories || {});
      this._applyCapture(preset, cap, memories);
      preset.name = naming.nameToStore(name, existing, preset, this.memLabels());
      if (!existing) this.presets.push(preset);
      this.presets.sort((a, b) => a.number - b.number);
      this.savePresets();
      this.log('info', `${existing ? 'Overwrote' : 'Saved'} preset ${n} "${this.presetName(preset)}" -> ${dests.map((d) => `${d}${preset.memories[d] ? `=mem ${preset.memories[d]}` : '=sources'}`).join(', ')}`);
      this.changed();
      return preset;
    });
  }

  // Update: re-capture the preset's own destinations (or the current selection when useSelection is true).
  updatePreset(number, { useSelection = false } = {}) {
    const p = this.getPreset(number); if (!p) return Promise.reject(new Error(`No preset ${number}`));
    const dests = useSelection ? [...this.selection] : p.destinations;
    return this.savePreset({ number: p.number, destinations: dests }); // keeps the stored (typed or automatic) name
  }

  editPreset(number, { name, newNumber, memories, destinations, color, master, mvMemories } = {}) {
    const p = this.getPreset(number); if (!p) throw new Error(`No preset ${number}`);
    if (newNumber !== undefined && Number(newNumber) !== p.number) {
      const nn = Number(newNumber);
      if (!(nn >= 1 && nn <= 9999)) throw new Error('Preset number must be 1-9999');
      if (this.getPreset(nn)) throw new Error(`Preset ${nn} already exists`);
      for (const map of [this.pvw, this.pgm]) for (const k of Object.keys(map)) if (map[k] === p.number) map[k] = nn;
      if (this.lastRecalled === p.number) this.lastRecalled = nn;
      p.number = nn;
    }
    if (Array.isArray(destinations) && destinations.length) p.destinations = destinations.map((k) => parseDest(k).key);
    if (memories && typeof memories === 'object') {
      p.memories = {};
      for (const [k, v] of Object.entries(memories)) {
        const key = parseDest(k).key; const slot = Number(v);
        if (slot >= 1 && slot <= 1000 && p.destinations.includes(key)) p.memories[key] = slot;
      }
    }
    if (master !== undefined) {
      if (!master || !master.slot) p.master = null;
      else this._assign(p, { target: 'master', type: 'master', slot: master.slot, dests: master.dests });
    }
    if (mvMemories && typeof mvMemories === 'object') {
      p.mvMemories = {};
      for (const [k, v] of Object.entries(mvMemories)) if (v) this._assign(p, { target: k, type: 'multiviewer', slot: v });
    }
    if (typeof color === 'string') p.color = color;
    // 0.3.3: a blank, generic or unchanged-default name makes the name automatic (derived from memory names)
    if (typeof name === 'string') p.name = naming.nameToStore(name, p, p, this.memLabels());
    p.updatedAt = new Date().toISOString();
    this.presets.sort((a, b) => a.number - b.number);
    this.savePresets(); this.log('info', `Edited preset ${p.number} "${this.presetName(p)}"`); this.changed();
    return p;
  }

  deletePreset(number) {
    const i = this.presets.findIndex((p) => p.number === Number(number));
    if (i < 0) throw new Error(`No preset ${number}`);
    const [p] = this.presets.splice(i, 1);
    for (const map of [this.pvw, this.pgm]) for (const k of Object.keys(map)) if (map[k] === p.number) delete map[k];
    if (this.lastRecalled === p.number) this.lastRecalled = null;
    this.savePresets(); this.log('info', `Deleted preset ${p.number} "${this.presetName(p)}"`); this.changed();
  }

  // 0.4.0: rearrange tiles. Both slots used -> the two presets trade numbers; target empty -> the preset moves
  // there. A preset number IS its tile position, so anything that addresses presets by number (the HTTP API,
  // Companion buttons "Recall preset N" with $(rs6:preset_N_name), tally feedbacks) follows the SLOT: after a
  // swap, the button for 3 recalls, names and tallies whatever is now in tile 3.
  swapPresets(a, b) {
    const na = Number(a); const nb = Number(b);
    for (const n of [na, nb]) if (!(Number.isInteger(n) && n >= 1 && n <= 9999)) throw err400('Preset numbers must be 1-9999');
    if (na === nb) throw err400('Pick two different tiles');
    const pa = this.getPreset(na); const pb = this.getPreset(nb);
    if (!pa && !pb) throw err400(`Tiles ${na} and ${nb} are both empty`);
    const map = (n) => (n === na ? nb : n === nb ? na : n);
    if (pa) pa.number = nb;
    if (pb) pb.number = na;
    for (const m of [this.pvw, this.pgm]) for (const k of Object.keys(m)) m[k] = map(m[k]);
    if (this.lastRecalled != null) this.lastRecalled = map(this.lastRecalled);
    if (this.staging.editing) this.staging.editing = map(this.staging.editing);
    const now = new Date().toISOString(); for (const p of [pa, pb]) if (p) p.updatedAt = now;
    this.presets.sort((x, y) => x.number - y.number);
    this.savePresets();
    const nm = (p) => `"${this.presetName(p)}"`;
    this.log('info', pa && pb ? `Swapped presets ${na} ${nm(pa)} <-> ${nb} ${nm(pb)}` : `Moved preset ${pa ? na : nb} ${nm(pa || pb)} to ${pa ? nb : na}`);
    this.changed();
    return { swapped: !!(pa && pb), moved: !(pa && pb), presets: [pa, pb].filter(Boolean).map((p) => this.presetView(p)) };
  }

  // 0.4.0 Web RCS pane: where the device's own web UI lives, and whether its headers allow framing.
  webRcsUrl() {
    const st = this.settings; const proto = st.https ? 'https' : 'http'; const port = Number(st.restPort);
    const dflt = (proto === 'http' && port === 80) || (proto === 'https' && port === 443) || !port;
    return `${proto}://${st.host}${dflt ? '' : ':' + port}/`;
  }
  // One read-only GET of the device root; only the headers are looked at (X-Frame-Options, CSP frame-ancestors).
  checkWebRcs() {
    const url = this.webRcsUrl();
    const lib = url.startsWith('https') ? require('https') : require('http');
    return new Promise((resolve) => {
      const req = lib.get(url, { timeout: 4000, rejectUnauthorized: false, headers: { Accept: 'text/html' } }, (res) => {
        res.resume();
        resolve({ url, ...framingVerdict(res.statusCode, res.headers) });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ url, reachable: false, framable: null, error: e.message }));
    });
  }

  duplicatePreset(number, toNumber) {
    const p = this.getPreset(number); if (!p) throw new Error(`No preset ${number}`);
    const n = toNumber ? Number(toNumber) : this.nextFreeNumber(p.number + 1);
    if (this.getPreset(n)) throw new Error(`Preset ${n} already exists`);
    const copy = JSON.parse(JSON.stringify(p));
    Object.assign(copy, { number: n, name: naming.customName(p) ? `${naming.customName(p)} copy`.slice(0, 64) : '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    this.presets.push(copy); this.presets.sort((a, b) => a.number - b.number);
    this.savePresets(); this.log('info', `Duplicated preset ${p.number} -> ${n}`); this.changed();
    return copy;
  }

  // ---------- show control ----------
  recall(number) {
    return this.exclusive(async () => {
      const p = this.getPreset(number); if (!p) throw new Error(`No preset ${number}`);
      const { done, failed } = await this._loadComposition(p, 'preview', p.number);
      this.lastRecalled = p.number;
      this.log(failed.length ? 'warn' : 'info', `Recalled preset ${p.number} "${this.presetName(p)}" to PVW on ${done.join(', ') || 'nothing'}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
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
      const eff = this.effectiveMaps(); const masters = new Set();
      for (const d of dests) {
        const p = this.getPreset(eff.pvw[d] ?? this.pvw[d]);
        if (!p) { skipped.push(d); continue; }
        try {
          const viaMaster = p.master && (p.master.dests || []).includes(d);
          if (viaMaster && !masters.has(p.number)) { await this.device.loadMaster(p.master.slot, 'program'); this.masterApp.program = p.master.slot; this.live.noteMasterLoad('program', p.master.slot, p.master.dests); masters.add(p.number); }
          if (p.memories && p.memories[d]) { await this.device.loadMemory(d, p.memories[d], 'program'); this.live.noteLoad(d, 'program', p.memories[d]); }
          else if (viaMaster) { /* the Master memory covered it */ }
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
    if (dests.length && this.masterApp.preview != null) {
      const prev = this.masterApp.program; this.masterApp.program = this.masterApp.preview;
      if (this.settings.presetToggle) this.masterApp.preview = prev;
    }
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
  // Last Master memory per side: from the device (§3.12) when live memory info exists, else the app's record.
  masterOn() {
    const L = this.live;
    if (L && L.mode !== 'off' && this.connected && L.hasMemoryInfo) return { preview: L.masterEff.preview, program: L.masterEff.program };
    return { ...this.masterApp };
  }

  // A preset is 'full' on a side when every component is there: each destination's Screen memory (or
  // source snapshot) plus its Master memory. Multiviewer memories have no readback, so they are not counted.
  presetTally(p, eff = this.effectiveMaps(), mo = this.masterOn()) {
    const comps = p.destinations.map((d) => ({ pvw: eff.pvw[d] === p.number, pgm: eff.pgm[d] === p.number }));
    if (p.master) comps.push({ pvw: mo.preview === p.master.slot, pgm: mo.program === p.master.slot });
    const on = (k) => { const n = comps.filter((c) => c[k]).length; return n === 0 ? 'none' : n === comps.length ? 'full' : 'partial'; };
    return { pvw: on('pvw'), pgm: on('pgm') };
  }

  // ---------- 0.3.3 names ----------
  memLabels() { return (this.live && this.live.memLabels) || {}; }
  presetName(p) { return naming.displayName(p, this.memLabels()); }
  // API view of a stored preset: `name` is what to show; `customName` is what the user typed ('' = automatic).
  presetView(p) { return p ? { ...p, name: this.presetName(p), customName: naming.customName(p), autoName: !naming.customName(p), derivedName: naming.derivedName(p, this.memLabels()) } : p; }
  // Default name for content that is about to be saved (board, or a selection with memory slots).
  suggestName(c) {
    const p = normalizePreset({ ...c });
    // a destination saved without a memory slot keeps a source snapshot (see savePreset)
    p.sources = Object.fromEntries((p.destinations || []).filter((d) => !p.memories[d]).map((d) => [d, { layers: [{}] }]));
    return naming.derivedName(p, this.memLabels());
  }

  // ---------- 0.5.0 version + show files ----------
  versionInfo() { return { app: 'rs6-presets', appVersion: APP_VERSION, apiVersion: API_VERSION, features: API_FEATURES, showVersion: shows.SHOW_VERSION, tileCounts: shows.TILE_COUNTS }; }

  // The current state as a show. Connection only with includeConnection; the password only with includePassword.
  buildShow({ name, includeConnection = false, includePassword = false } = {}) {
    const { editing, ...stage } = this.staging; void editing;
    const show = {
      format: shows.SHOW_FORMAT, version: shows.SHOW_VERSION,
      name: String(name || this.currentShow.name || 'Untitled show').trim().slice(0, 80) || 'Untitled show',
      savedAt: new Date().toISOString(), appVersion: APP_VERSION,
      tileCount: this.settings.tileCount,
      presets: JSON.parse(JSON.stringify(this.presets)),
      settings: shows.showSettingsOf(this.settings),
      selection: [...this.selection],
      staging: JSON.parse(JSON.stringify(stage)),
      connection: null,
    };
    if (includeConnection) {
      show.connection = shows.connectionOf(this.settings);
      if (includePassword && this.settings.password) show.connection.password = this.settings.password;
    }
    return show;
  }
  showStatus() {
    const hash = shows.showHash(this.buildShow());
    return { name: this.currentShow.name, id: this.currentShow.id, savedAt: this.currentShow.savedAt, dirty: hash !== this.currentShow.savedHash, inLibrary: !!(this.currentShow.id && this.library.exists(this.currentShow.id)) };
  }
  listShows() {
    return { current: this.showStatus(), shows: this.library.list(false).map(({ file, ...x }) => x), backups: this.library.list(true).map(({ file, ...x }) => x), dir: this.library.dir };
  }
  // Save (to the current id) or Save as (asNew / a new name). Returns the library entry.
  saveShow({ name, asNew = false, includeConnection = false, includePassword = false } = {}) {
    const nm = String(name || this.currentShow.name || 'Untitled show').trim().slice(0, 80) || 'Untitled show';
    let id = !asNew && this.currentShow.id && this.library.exists(this.currentShow.id) ? this.currentShow.id : null;
    if (id && name && nm !== this.currentShow.name) id = null; // a new name = save as
    if (!id) id = this.library.freeId(nm);
    const show = this.buildShow({ name: nm, includeConnection, includePassword });
    this.library.write(id, show);
    this.currentShow = { name: nm, id, savedHash: shows.showHash(show), savedAt: show.savedAt };
    this.log('info', `Saved show "${nm}" (${show.presets.length} presets${show.connection ? ', with the device connection' : ''}${show.connection && show.connection.password ? ' and the Web RCS password' : ''})`);
    this.changed();
    return { id, name: nm, savedAt: show.savedAt };
  }
  _readShow(ref) {
    if (ref && ref.content !== undefined) return { text: ref.content, id: null };
    const id = ref && ref.id; const backup = !!(ref && ref.backup);
    return { text: this.library.read(id, backup), id: backup ? null : id };
  }
  // What a show holds, and whether its connection differs from the current one (the UI asks before switching).
  previewShow(ref) {
    const { text } = this._readShow(ref);
    const { show, warnings, migratedFrom } = shows.parseShow(text, { normalizePreset });
    const cur = shows.connectionOf(this.settings);
    const con = show.connection;
    return {
      name: show.name, savedAt: show.savedAt, appVersion: show.appVersion, presets: show.presets.length, tileCount: show.tileCount,
      connection: con ? { host: con.host, restPort: con.restPort, awjPort: con.awjPort, https: con.https, protocol: con.protocol, hasPassword: !!con.password } : null,
      connectionDiffers: !!(con && ['host', 'restPort', 'awjPort', 'https', 'protocol'].some((k) => con[k] !== undefined && con[k] !== cur[k])),
      current: { host: cur.host, restPort: cur.restPort },
      warnings, migratedFrom,
    };
  }
  // Replace the app's configuration with a show. Never talks to the device: only the app's presets, settings,
  // selection and staging change. applyConnection switches host/ports (the caller then decides to reconnect).
  openShow(ref, { applyConnection = false } = {}) {
    if (this.settings.mock && applyConnection) applyConnection = false; // mock mode keeps the mock device
    const { text, id } = this._readShow(ref);
    const { show, warnings, migratedFrom } = shows.parseShow(text, { normalizePreset });
    const backupId = this.library.backup({ ...this.buildShow({ includeConnection: true }), name: `before opening ${show.name} (was ${this.currentShow.name})` });
    this.presets = show.presets;
    this.savePresets();
    Object.assign(this.settings, show.settings);
    this.settings.tileCount = show.tileCount;
    let connectionChanged = false;
    if (applyConnection && show.connection) {
      for (const k of shows.CONNECTION_KEYS) if (show.connection[k] !== undefined && this.settings[k] !== show.connection[k]) { this.settings[k] = show.connection[k]; connectionChanged = true; }
      if (show.connection.password) { this.settings.password = show.connection.password; connectionChanged = true; }
    }
    for (const k of NUMERIC_SETTINGS) this.settings[k] = Number(this.settings[k]);
    this.saveSettings();
    if (connectionChanged) { this.live.stop(); this.device.configure(this.settings); this.connected = false; }
    this.selection = new Set(show.selection);
    this.staging = show.staging ? { ...emptyStage(), ...show.staging, editing: null } : emptyStage();
    this.pvw = {}; this.pgm = {}; this.lastRecalled = null; this.masterApp = { preview: null, program: null };
    this.currentShow = { name: show.name, id, savedHash: null, savedAt: show.savedAt };
    this.currentShow.savedHash = id ? shows.showHash(this.buildShow()) : null; // an uploaded file is unsaved until saved here
    this.log('info', `Opened show "${show.name}" (${show.presets.length} presets, ${show.tileCount} tiles${migratedFrom ? `, migrated from ${migratedFrom}` : ''}). Nothing was sent to the device. Backup of the previous state: ${backupId}`);
    for (const w of warnings) this.log('warn', `Show "${show.name}": ${w}`);
    this.changed();
    return { name: show.name, id, backupId, connectionChanged, warnings, migratedFrom, presets: show.presets.length };
  }
  // Upload into the library (does not open it).
  importShow(content, name) {
    const { show, warnings, migratedFrom } = shows.parseShow(content, { normalizePreset });
    if (name) show.name = String(name).trim().slice(0, 80) || show.name;
    const id = this.library.freeId(show.name);
    this.library.write(id, show);
    this.log('info', `Added show "${show.name}" to the library${migratedFrom ? ` (migrated from ${migratedFrom})` : ''}`);
    return { id, name: show.name, warnings, migratedFrom };
  }
  renameShow(id, name) {
    const r = this.library.rename(id, name);
    if (this.currentShow.id === id) { this.currentShow = { ...this.currentShow, id: r.id, name: r.name }; this.currentShow.savedHash = null; this.changed(); }
    return r;
  }
  duplicateShow(id, name) { return this.library.duplicate(id, name); }
  deleteShow(id, backup = false) {
    this.library.remove(id, backup);
    if (!backup && this.currentShow.id === id) { this.currentShow = { ...this.currentShow, id: null, savedHash: null }; this.changed(); }
    this.log('info', `Deleted ${backup ? 'backup' : 'show'} "${id}" from the library`);
  }
  newShow(name) {
    const backupId = this.library.backup({ ...this.buildShow({ includeConnection: true }), name: `before new show (was ${this.currentShow.name})` });
    this.presets = []; this.savePresets();
    this.selection = new Set(); this.staging = emptyStage(); this.pvw = {}; this.pgm = {}; this.lastRecalled = null;
    this.currentShow = { name: String(name || 'Untitled show').trim().slice(0, 80) || 'Untitled show', id: null, savedHash: null, savedAt: null };
    this.log('info', `New show "${this.currentShow.name}" (previous state backed up: ${backupId})`);
    this.changed();
    return { name: this.currentShow.name, backupId };
  }

  getState() {
    const last = this.lastRecalled ? this.getPreset(this.lastRecalled) : null;
    const eff = this.effectiveMaps();
    const mo = this.masterOn();
    const pgmPresets = this.presets.filter((p) => this.presetTally(p, eff, mo).pgm === 'full').map((p) => p.number);
    const live = this.live.snapshot();
    return {
      app: 'rs6-presets', version: 3, appVersion: APP_VERSION, apiVersion: API_VERSION, rev: this.rev,
      tileCount: this.settings.tileCount,
      show: this.showStatus(),
      dataDir: this.dataInfo.dir, dataMigration: this.dataInfo.migration,
      mock: !!this.settings.mock, connected: this.connected, lastError: this.lastError, system: this.system,
      settings: this.publicSettings(),
      autoTake: !!this.settings.autoTake,
      destinations: this.destinations.map((d) => {
        const lv = live.destinations[d.key];
        return { ...d, selected: this.selection.has(d.key), willTransition: this.selection.has(d.key), pvwPreset: eff.pvw[d.key] ?? null, pgmPreset: eff.pgm[d.key] ?? null,
          programMemory: lv ? lv.program.memory : null, previewMemory: lv ? lv.preview.memory : null,
          programLayer1: lv ? lv.program.layer1Label : '', transition: lv ? lv.transition : null };
      }),
      multiviewers: this.multiviewers.map((m) => ({ ...m })),
      selection: [...this.selection],
      // TAKE and CUT act on exactly these (the app's selection, in destination order).
      transitionTargets: this.destinations.map((d) => d.key).filter((k) => this.selection.has(k)),
      staging: { ...this.staging, targets: this.targetsOf(this.staging), suggestedName: this.suggestName(this.staging) },
      memories: this.live.memoryCatalog(),
      master: mo,
      lastRecalled: last ? { number: last.number, name: this.presetName(last) } : null,
      programPresets: pgmPresets,
      presets: this.presets.map((p) => {
        const t = this.presetTally(p, eff, mo);
        return { number: p.number, name: this.presetName(p), customName: naming.customName(p), autoName: !naming.customName(p), derivedName: naming.derivedName(p, this.memLabels()), color: p.color || null, destinations: p.destinations, memories: p.memories || {},
          master: p.master, mvMemories: p.mvMemories || {}, targets: this.targetsOf(p),
          hasSources: Object.fromEntries(p.destinations.map((d) => [d, !!(p.sources && p.sources[d] && p.sources[d].layers.length)])),
          tally: t, onPreview: t.pvw === 'full', onProgram: t.pgm === 'full', lastRecalled: this.lastRecalled === p.number,
          updatedAt: p.updatedAt };
      }),
      tally: { preview: { ...eff.pvw }, program: { ...eff.pgm }, source: eff.source },
      live,
    };
  }
}

// X-Frame-Options DENY/SAMEORIGIN or a CSP frame-ancestors that doesn't allow other origins blocks an <iframe>.
function framingVerdict(status, headers = {}) {
  const xfo = headers['x-frame-options'] ? String(headers['x-frame-options']) : null;
  const csp = headers['content-security-policy'] ? String(headers['content-security-policy']) : null;
  const fa = csp && /frame-ancestors([^;]*)/i.exec(csp);
  const faVal = fa ? fa[1].trim() : null;
  const blockedBy = [];
  if (xfo && /deny|sameorigin/i.test(xfo)) blockedBy.push(`X-Frame-Options: ${xfo}`);
  if (faVal !== null && !/(^|\s)\*(\s|$)/.test(faVal)) blockedBy.push(`CSP frame-ancestors ${faVal || "(empty)"}`);
  return { reachable: true, status, xFrameOptions: xfo, frameAncestors: faVal, framable: blockedBy.length === 0, blockedBy };
}

module.exports = { Engine, normalizePreset, PRESET_FILE_VERSION, framingVerdict, API_VERSION };
