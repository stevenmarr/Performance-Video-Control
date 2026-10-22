'use strict';
// 0.5.0 show files (.rs6show, plain JSON). A show is everything the app keeps for one production: the presets at
// their tile positions, the tile count, the TAKE selection and board staging, and the app settings. Optionally the
// device connection (host / ports / protocol), and the Web RCS password only when asked for explicitly.
// Opening a show changes the app's configuration only; nothing is sent to the RS6.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_SETTINGS } = require('./store');

const SHOW_FORMAT = 'rs6-presets-show';
// 2 (0.6.0): adds `system` (rs6 | e2 | pixelhue, the system the show is for) and `systems` (E2 / PixelHue tile
// layout, TAKE selection, tile count and, opt-in, connection). Version 1 files load as RS6 shows.
const SHOW_VERSION = 2;
const SHOW_SYSTEMS = ['rs6', 'e2', 'pixelhue'];
const SHOW_EXT = '.rs6show';
const TILE_COUNTS = [24, 48, 72, 96];
const MAX_PRESET = 9999;
const CONNECTION_KEYS = ['host', 'restPort', 'awjPort', 'https', 'protocol'];
// never part of a show's settings: the connection (separate, opt-in), the password (opt-in), mock-mode internals
const NOT_SHOW_SETTINGS = new Set([...CONNECTION_KEYS, 'password', 'mock', 'tileCount']);
const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });

const showSettingsOf = (settings) => Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter((k) => !NOT_SHOW_SETTINGS.has(k) && settings[k] !== undefined).map((k) => [k, settings[k]]));
const connectionOf = (settings) => Object.fromEntries(CONNECTION_KEYS.map((k) => [k, settings[k]]));
const tileCountFor = (n) => { const v = Number(n); return TILE_COUNTS.includes(v) ? v : null; };
const tilesNeeded = (presets) => { const max = Math.max(0, ...presets.map((p) => p.number)); return TILE_COUNTS.find((c) => c >= max) || 96; };

// Content that makes a show "different" (drives the unsaved-changes dot). Metadata (name, savedAt) excluded.
function showHash(show) {
  // timestamps are not content: swapping two tiles and swapping them back is "no change"
  const presets = (show.presets || []).map(({ updatedAt, createdAt, ...p }) => (void updatedAt, void createdAt, p));
  const body = { presets, tileCount: show.tileCount, settings: show.settings, selection: show.selection, staging: show.staging };
  if (show.system && show.system !== 'rs6') body.system = show.system;
  if (show.systems) body.systems = show.systems;
  return crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
}

// Validate and migrate anything we know how to read into a version-1 show. Throws a 400 with a plain message.
//   v1          {format:"rs6-presets-show", version:1, ...}
//   v0 legacy   presets.json ({version:1|2, presets:[...]}) or a bare array of presets: presets only
//   v0 export   {settings:{...}, presets:[...]}: presets + settings (+ connection)
function parseShow(input, { normalizePreset } = {}) {
  let raw = input;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    if (!raw.trim()) throw err400('The show file is empty');
    try { raw = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { throw err400(`Not a show file (invalid JSON: ${e.message})`); }
  }
  if (!raw || typeof raw !== 'object') throw err400('Not a show file');
  const warnings = [];
  let migratedFrom = null;
  let src = raw;
  if (Array.isArray(raw)) { src = { presets: raw }; migratedFrom = 'presets list'; }
  else if (raw.format === SHOW_FORMAT) {
    const v = Number(raw.version);
    if (!Number.isInteger(v) || v < 1) throw err400(`Unknown show file version "${raw.version}"`);
    if (v > SHOW_VERSION) throw err400(`This show was saved by a newer RS6 Presets (show file version ${v}; this app reads up to ${SHOW_VERSION}). Update the app to open it.`);
  } else if (raw.format) throw err400(`Not an RS6 Presets show (format "${raw.format}")`);
  else if (Array.isArray(raw.presets)) migratedFrom = raw.settings ? 'config export' : `presets.json (file version ${raw.version || 1})`;
  else throw err400('Not an RS6 Presets show: no "format" and no "presets" list');

  if (!Array.isArray(src.presets)) throw err400('The show has no "presets" list');
  const seen = new Set(); const presets = [];
  src.presets.forEach((p, i) => {
    const n = p && Number(p.number);
    if (!p || typeof p !== 'object' || !Number.isInteger(n) || n < 1 || n > MAX_PRESET) { warnings.push(`Skipped preset #${i + 1}: bad number "${p && p.number}"`); return; }
    if (seen.has(n)) { warnings.push(`Skipped a second preset ${n}`); return; }
    seen.add(n);
    const q = JSON.parse(JSON.stringify(p)); q.number = n;
    presets.push(normalizePreset ? normalizePreset(q) : q);
  });
  presets.sort((a, b) => a.number - b.number);

  const settings = {};
  const inSettings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  for (const [k, v] of Object.entries(inSettings)) {
    if (!(k in DEFAULT_SETTINGS) || NOT_SHOW_SETTINGS.has(k)) continue;
    if (typeof v !== typeof DEFAULT_SETTINGS[k]) { warnings.push(`Ignored setting ${k} (wrong type)`); continue; }
    settings[k] = v;
  }
  let connection = null;
  const conSrc = src.connection || (migratedFrom === 'config export' ? inSettings : null);
  if (conSrc && typeof conSrc === 'object' && conSrc.host) {
    connection = {};
    for (const k of CONNECTION_KEYS) if (conSrc[k] !== undefined && typeof conSrc[k] === typeof DEFAULT_SETTINGS[k]) connection[k] = conSrc[k];
    if (typeof conSrc.password === 'string' && conSrc.password && (src.connection ? src.connection.password : false)) connection.password = conSrc.password;
  }
  let tileCount = tileCountFor(src.tileCount != null ? src.tileCount : inSettings.tileCount);
  const need = tilesNeeded(presets);
  if (!tileCount) tileCount = Math.max(48, need);
  if (tileCount < need) { warnings.push(`Tile count raised to ${need} to show preset ${Math.max(...presets.map((p) => p.number))}`); tileCount = need; }
  const selection = Array.isArray(src.selection) ? src.selection.map(String).filter((k) => /^[SA]\d+$/.test(k)) : [];
  const staging = src.staging && typeof src.staging === 'object' ? {
    memories: src.staging.memories && typeof src.staging.memories === 'object' ? src.staging.memories : {},
    master: src.staging.master || null,
    mvMemories: src.staging.mvMemories && typeof src.staging.mvMemories === 'object' ? src.staging.mvMemories : {},
    editing: null,
  } : null;
  // 0.6.0: which system the show is for, and the per-system sessions of E2 / PixelHue
  const system = SHOW_SYSTEMS.includes(src.system) ? src.system : 'rs6';
  let systems = null;
  if (src.systems && typeof src.systems === 'object') {
    systems = {};
    for (const k of ['e2', 'pixelhue']) {
      const x = src.systems[k]; if (!x || typeof x !== 'object') continue;
      const layout = {}; for (const [key, v] of Object.entries(x.layout && typeof x.layout === 'object' ? x.layout : {})) if (Number.isInteger(v) && v >= 1 && v <= MAX_PRESET) layout[String(key)] = v;
      systems[k] = { selection: Array.isArray(x.selection) ? x.selection.map(String).filter((d) => /^[SA]\d+$/.test(d)) : [], layout, tileCount: tileCountFor(x.tileCount) || 48, autoTake: !!x.autoTake };
      if (x.connection && typeof x.connection === 'object' && x.connection.host) systems[k].connection = { ...x.connection };
    }
  }
  const show = {
    format: SHOW_FORMAT, version: SHOW_VERSION, system, systems,
    name: String(src.name || '').trim().slice(0, 80) || 'Untitled show',
    savedAt: src.savedAt || null, appVersion: src.appVersion || null,
    tileCount, presets, settings, selection, staging, connection,
  };
  return { show, warnings, migratedFrom };
}

// ---------- library: <dataDir>/shows/<id>.rs6show, automatic backups in <dataDir>/shows/backups ----------
function slug(name) {
  const s = String(name || '').normalize('NFKD').replace(/[^\w .()-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || 'Show';
}
function safeId(id) {
  const s = String(id || '');
  if (!s || s.length > 120 || /[/\\]|\.\./.test(s) || s.startsWith('.')) throw err400(`Bad show id "${s}"`);
  return s;
}
class ShowLibrary {
  constructor(dataDir) { this.dir = path.join(dataDir, 'shows'); this.backupDir = path.join(this.dir, 'backups'); }
  file(id, backup = false) { return path.join(backup ? this.backupDir : this.dir, safeId(id) + SHOW_EXT); }
  exists(id, backup = false) { try { return fs.existsSync(this.file(id, backup)); } catch { return false; } }
  freeId(name) { const base = slug(name); let id = base; let i = 2; while (this.exists(id)) id = `${base} (${i++})`; return id; }
  write(id, show, backup = false) {
    const f = this.file(id, backup); fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(show, null, 2)); fs.renameSync(tmp, f);
    return id;
  }
  read(id, backup = false) {
    const f = this.file(id, backup);
    if (!fs.existsSync(f)) throw Object.assign(new Error(`No show "${id}"`), { status: 404 });
    return fs.readFileSync(f, 'utf8');
  }
  list(backup = false) {
    const dir = backup ? this.backupDir : this.dir;
    let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith(SHOW_EXT)); } catch { return []; }
    return names.map((n) => {
      const id = n.slice(0, -SHOW_EXT.length); const f = path.join(dir, n); const st = fs.statSync(f);
      let meta = {}; try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); meta = { name: j.name, savedAt: j.savedAt, presets: Array.isArray(j.presets) ? j.presets.length : null, tileCount: j.tileCount, hasConnection: !!(j.connection && j.connection.host), host: j.connection && j.connection.host, hasPassword: !!(j.connection && j.connection.password) }; } catch { meta = { error: 'unreadable' }; }
      return { id, file: f, size: st.size, modified: st.mtime.toISOString(), backup, ...meta };
    }).sort((a, b) => (backup ? b.modified.localeCompare(a.modified) : String(a.name || a.id).localeCompare(String(b.name || b.id))));
  }
  remove(id, backup = false) { const f = this.file(id, backup); if (!fs.existsSync(f)) throw Object.assign(new Error(`No show "${id}"`), { status: 404 }); fs.unlinkSync(f); }
  rename(id, newName) {
    const text = this.read(id); const j = JSON.parse(text); j.name = String(newName || '').trim().slice(0, 80) || j.name;
    const newId = slug(j.name) === id ? id : this.freeId(j.name);
    this.write(newId, j); if (newId !== id) fs.unlinkSync(this.file(id));
    return { id: newId, name: j.name };
  }
  duplicate(id, newName) {
    const j = JSON.parse(this.read(id)); j.name = String(newName || '').trim().slice(0, 80) || `${j.name || id} copy`;
    const newId = this.freeId(j.name); this.write(newId, j); return { id: newId, name: j.name };
  }
  // automatic backup before a show replaces the current state; the newest `keep` are kept
  backup(show, keep = 30) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const id = `${ts} ${slug(show.name)}`;
    this.write(id, show, true);
    const old = this.list(true).slice(keep); for (const o of old) { try { fs.unlinkSync(o.file); } catch { /* gone */ } }
    return id;
  }
}

module.exports = { SHOW_FORMAT, SHOW_VERSION, SHOW_SYSTEMS, SHOW_EXT, TILE_COUNTS, CONNECTION_KEYS, parseShow, showHash, showSettingsOf, connectionOf, tilesNeeded, tileCountFor, ShowLibrary, slug };
