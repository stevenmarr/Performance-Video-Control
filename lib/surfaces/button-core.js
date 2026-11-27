'use strict';
// Generic button core (designer Phase A). One record type for every system.
// Colour comes from a category (the job), the same on every system. The
// shared library lives at <dataDir>/surfaces/buttons.json and is never
// packed into a .rs6show.

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../store');

const SCHEMA_VERSION = 1;
const KINDS = ['key', 'dial', 'strip', 'tourbox'];
const TARGET_MODES = ['follow', 'fixed'];

// Signed off Q1: colour means the job, the same on every system.
const CATEGORIES = Object.freeze({
  nav:    { fill: '#243044', bar: '#5B7C99', os: true,  border: '#5B7C99', ink: '#F4F7FB', dim: '#8EA0B5' },
  target: { fill: '#1d1a2b', bar: '#8B5CF6', ink: '#F4F7FB', dim: '#C4B5FD' },
  take:   { fill: '#C42020', bar: '#E0B030', ink: '#FFFFFF', dim: '#FFD5D6' },
  bus:    { fill: '#5c2428', bar: '#C42020', ink: '#F4F7FB', dim: '#FFD5D6' },
  recall: { fill: '#A03A8C', bar: '#A03A8C', ink: '#FFFFFF', dim: '#F3D0EC' },
  paint:  { fill: '#222226', bar: '#7c8cff', ink: '#F4F7FB', dim: '#9A9AA2' },
  motion: { fill: '#222226', bar: '#14B8A6', ink: '#F4F7FB', dim: '#9A9AA2' },
  route:  { fill: '#222226', bar: '#22D3EE', ink: '#F4F7FB', dim: '#9A9AA2' },
  mode:   { fill: '#2a2a2e', bar: '#E0B030', ink: '#F4F7FB', dim: '#9A9AA2' },
  status: { fill: '#1f1c12', bar: '#E0B030', ink: '#F4F7FB', dim: '#E8D9A6' },
  danger: { fill: '#2a1a10', bar: '#F97316', border: '#F97316', guard: true, ink: '#F4F7FB', dim: '#FDBA74' },
});

// Today's ATEM-centric roles become a category (and a template name).
const ROLE_CATEGORY = Object.freeze({
  program: 'bus', preview: 'bus', hot: 'take', shift: 'mode',
  memory: 'recall', macro: 'recall', nav: 'nav', tab: 'nav',
  info: 'status', toggle: 'mode',
});

const ELEMENT_KIND = Object.freeze({
  button: 'key', encoder: 'dial', 'touch-segment': 'strip', tourbox: 'tourbox',
});

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const freshId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.replace(/[^\w-]/g, '').slice(0, 40);

function idOf(v, prefix) {
  const id = String(v || '').replace(/[^\w-]/g, '').slice(0, 40);
  return id || freshId(prefix);
}

function categoryStyle(category, overrides) {
  const base = CATEGORIES[category];
  if (!base) throw fail(400, `Unknown category "${category}"`);
  const out = { ...base };
  if (overrides && typeof overrides === 'object') {
    for (const key of ['fill', 'bar', 'border', 'ink', 'dim']) {
      if (typeof overrides[key] === 'string' && overrides[key]) out[key] = overrides[key].slice(0, 32);
    }
    if (overrides.bar === null) out.bar = null;
    if (overrides.custom) out.custom = true;
  }
  return out;
}

function cleanTarget(t) {
  if (!t || t === 'follow' || t.mode === 'follow' || t.follows === true) return { mode: 'follow' };
  return {
    mode: 'fixed',
    system: String(t.system || t.instance && String(t.instance).split('-')[0] || '').slice(0, 40),
    instance: String(t.instance || '').slice(0, 80),
    camera: String(t.camera || t.cam || '').slice(0, 80),
  };
}

function cleanDo(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const ev of ['press', 'hold', 'turn', 'touch', 'release']) {
    const row = raw[ev];
    if (!row || typeof row !== 'object') continue;
    const verb = String(row.verb || '').slice(0, 40);
    if (!verb) continue;
    const step = { verb };
    if (row.cap) step.cap = String(row.cap).slice(0, 80);
    if (row.accel) step.accel = String(row.accel).slice(0, 20);
    if (row.to) step.to = String(row.to).slice(0, 20);
    if (row.id) step.id = String(row.id).slice(0, 80);
    out[ev] = step;
  }
  return out;
}

function cleanDisplay(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of ['title', 'value', 'caption', 'badge', 'meter', 'icon']) {
    if (raw[key] == null) continue;
    if (typeof raw[key] === 'string') out[key] = raw[key].slice(0, 200);
    else if (typeof raw[key] === 'object') {
      const row = {};
      if (raw[key].bind) row.bind = String(raw[key].bind).slice(0, 80);
      if (raw[key].format) row.format = String(raw[key].format).slice(0, 20);
      if (raw[key].style) row.style = String(raw[key].style).slice(0, 20);
      if (Object.keys(row).length) out[key] = row;
    }
  }
  return out;
}

function cleanButton(body, prev) {
  const src = body && typeof body === 'object' ? body : {};
  const kind = String(src.kind || (prev && prev.kind) || ELEMENT_KIND[src.element] || 'key');
  if (!KINDS.includes(kind)) throw fail(400, `Unknown kind "${kind}"`);
  let category = String(src.category || (prev && prev.category) || ROLE_CATEGORY[src.role] || 'mode');
  if (!CATEGORIES[category]) throw fail(400, `Unknown category "${category}"`);
  const button = {
    schemaVersion: SCHEMA_VERSION,
    id: idOf(src.id || (prev && prev.id), 'btn_'),
    name: String(src.name || (prev && prev.name) || '').trim().slice(0, 60),
    kind,
    category,
    system: String(src.system || (prev && prev.system) || '').slice(0, 40),
    target: src.target !== undefined ? cleanTarget(src.target) : ((prev && prev.target) || { mode: 'follow' }),
    do: src.do !== undefined ? cleanDo(src.do) : ((prev && prev.do) || {}),
    display: src.display !== undefined ? cleanDisplay(src.display) : ((prev && prev.display) || {}),
    feedback: Array.isArray(src.feedback) ? src.feedback.slice(0, 24) : ((prev && prev.feedback) || []),
    guards: Array.isArray(src.guards) ? src.guards.map((g) => String(g).slice(0, 40)).slice(0, 12) : ((prev && prev.guards) || []),
    fallback: src.fallback && typeof src.fallback === 'object' ? src.fallback : ((prev && prev.fallback) || {}),
    styleOverride: src.styleOverride && typeof src.styleOverride === 'object' ? src.styleOverride : ((prev && prev.styleOverride) || null),
    template: src.template ? String(src.template).slice(0, 40) : ((prev && prev.template) || null),
    createdAt: (prev && prev.createdAt) || now(),
    updatedAt: now(),
  };
  if (!button.name) throw fail(400, 'A name is required');
  return button;
}

// Migrate a v0 / v2 library button (ATEM roles, element, actions) into schema v1.
function migrateLegacyButton(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.schemaVersion === SCHEMA_VERSION && row.kind && row.category) {
    try { return cleanButton(row); } catch { return null; }
  }
  const kind = ELEMENT_KIND[row.element] || (KINDS.includes(row.kind) ? row.kind : 'key');
  const role = String(row.role || '');
  const category = ROLE_CATEGORY[role === 'flex-macro' ? 'macro' : role === 'flex-memory' ? 'memory' : role] || 'mode';
  const display = {};
  if (row.title) display.title = row.title;
  if (row.text) display.value = row.text;
  if (row.caption) display.caption = row.caption;
  const doMap = {};
  const actions = row.actions || {};
  const first = (ev) => Array.isArray(actions[ev]) && actions[ev][0] && actions[ev][0].action;
  if (first('press')) doMap.press = { verb: 'trigger', cap: first('press') };
  if (first('hold')) doMap.hold = { verb: 'trigger', cap: first('hold') };
  if (first('turn')) doMap.turn = { verb: 'step', cap: first('turn') };
  if (first('touch')) doMap.touch = { verb: 'trigger', cap: first('touch') };
  if (first('push')) doMap.press = doMap.press || { verb: 'pair.toggle', cap: first('push') };
  try {
    return cleanButton({
      id: row.id,
      name: row.name || row.text || role || 'Button',
      kind,
      category,
      system: (row.target && row.target.system) || '',
      target: row.target,
      do: doMap,
      display,
      template: row.template || role || null,
    });
  } catch {
    return null;
  }
}

function libraryPath(dataDir) {
  return path.join(dataDir, 'surfaces', 'buttons.json');
}
function legacyLibraryPath(dataDir) {
  return path.join(dataDir, 'button-library.json');
}

class SharedButtonLibrary {
  constructor({ dataDir } = {}) {
    this.dir = dataDir || null;
    this.file = dataDir ? libraryPath(dataDir) : null;
    this.legacyFile = dataDir ? legacyLibraryPath(dataDir) : null;
    this.buttons = [];
    this.migratedFrom = null;
    this._load();
  }

  // Signed off Q4: the library is never packed into a show file.
  packableInShow() { return false; }

  _load() {
    if (this.file && fs.existsSync(this.file)) {
      const raw = readJson(this.file, { schemaVersion: SCHEMA_VERSION, buttons: [] });
      this.buttons = (raw.buttons || []).map(migrateLegacyButton).filter(Boolean);
      return;
    }
    if (this.legacyFile && fs.existsSync(this.legacyFile)) {
      const raw = readJson(this.legacyFile, { buttons: [] });
      const list = Array.isArray(raw) ? raw : (raw.buttons || []);
      this.buttons = list.map(migrateLegacyButton).filter(Boolean);
      this.migratedFrom = this.legacyFile;
      this._save();
    }
  }

  _save() {
    if (!this.file) return;
    writeJsonAtomic(this.file, {
      schemaVersion: SCHEMA_VERSION,
      shared: true,
      packableInShow: false,
      buttons: this.buttons,
      updatedAt: now(),
    });
  }

  list() { return this.buttons.slice(); }
  get(id) { return this.buttons.find((b) => b.id === id) || null; }

  save(body) {
    const prev = body && body.id ? this.get(body.id) : null;
    const button = cleanButton(body, prev);
    const i = this.buttons.findIndex((b) => b.id === button.id);
    if (i >= 0) this.buttons[i] = button;
    else this.buttons.push(button);
    this._save();
    return button;
  }

  remove(id) {
    const before = this.buttons.length;
    this.buttons = this.buttons.filter((b) => b.id !== id);
    if (this.buttons.length === before) throw fail(404, `No button ${id}`);
    this._save();
    return { ok: true };
  }
}

// Signed off Q2: a live camera's *controls* keep their job colour and get a
// red frame plus a LIVE corner. Target keys (and ON AIR) still fill solid red.
function liveLook(model, { kind, tally } = {}) {
  const src = model && typeof model === 'object' ? model : {};
  if (tally === 'pvw') return { ...src, tally: 'pvw', border: '#3DDC84' };
  if (tally !== 'pgm' && tally !== 'live') return { ...src };
  if (kind === 'target' || kind === 'status') {
    return {
      ...src,
      fill: '#C42020',
      border: '#C42020',
      ink: '#FFFFFF',
      dim: '#FFD5D6',
      tally: 'pgm',
      live: false,
      liveCorner: false,
    };
  }
  return {
    ...src,
    border: '#E5262E',
    tally: 'pgm',
    live: true,
    liveCorner: true,
  };
}

module.exports = {
  SCHEMA_VERSION, KINDS, CATEGORIES, ROLE_CATEGORY, ELEMENT_KIND,
  categoryStyle, cleanButton, migrateLegacyButton, liveLook,
  libraryPath, legacyLibraryPath, SharedButtonLibrary,
};
