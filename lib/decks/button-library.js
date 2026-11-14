'use strict';
// Button library and named surface pages. A button is a key-class definition with
// no page coordinates. A page is placements: a surface slot points at a library id.
// Files live next to decks.json: button-library.json and surface-pages.json.

const path = require('path');
const { readJson, writeJsonAtomic } = require('../store');
const { surfaceById } = require('./surfaces');

const PUBLIC_ROLES = ['program', 'preview', 'hot', 'shift', 'memory', 'macro', 'nav', 'tab', 'info', 'toggle'];
const ELEMENTS = ['button', 'encoder', 'touch-segment'];
const EVENTS = {
  button: ['press', 'release', 'hold'],
  encoder: ['turn', 'push'],
  'touch-segment': ['touch'],
};
const LEGACY_ROLES = { 'flex-macro': 'macro', 'flex-memory': 'memory' };

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const freshId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.replace(/[^\w-]/g, '').slice(0, 40);
const clone = (v) => JSON.parse(JSON.stringify(v));

function idOf(v, prefix) {
  const id = String(v || '').replace(/[^\w-]/g, '').slice(0, 40);
  return id || freshId(prefix);
}

function normalizeRole(role) {
  const raw = String(role || '').trim();
  if (raw === 'flex' || raw === 'blank') throw fail(400, 'New buttons do not use flex or blank. Choose memory or macro for an assignable key.');
  const mapped = LEGACY_ROLES[raw] || raw;
  if (!PUBLIC_ROLES.includes(mapped)) throw fail(400, `Unknown role "${raw}"`);
  return mapped;
}

function cleanName(v, fallback) {
  const name = String(v == null ? '' : v).trim().slice(0, 60);
  if (!name) {
    if (fallback) return fallback;
    throw fail(400, 'A name is required');
  }
  return name;
}

function cleanStyle(s) {
  if (!s || typeof s !== 'object') return {};
  const out = {};
  for (const key of ['bgcolor', 'color', 'border']) {
    if (typeof s[key] === 'string' && s[key]) out[key] = s[key].slice(0, 32);
  }
  if (s.bar === null) out.bar = null;
  else if (typeof s.bar === 'string' && s.bar) out.bar = s.bar.slice(0, 32);
  return out;
}

function cleanTarget(t) {
  if (!t || t === 'follow' || t.mode === 'follow' || t.follows === true) return { mode: 'follow', system: '', instance: '' };
  return {
    mode: 'fixed',
    system: String(t.system || '').slice(0, 40),
    instance: String(t.instance || '').slice(0, 80),
  };
}

function cleanOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[\w.-]{1,40}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 4000);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanAction(a) {
  if (!a || typeof a !== 'object' || !a.action) return null;
  const action = String(a.action).slice(0, 80);
  if (!/^[\w.:-]+$/.test(action)) throw fail(400, `Bad action id "${action}"`);
  const row = { action };
  if (a.instance != null && String(a.instance) !== '') row.instance = String(a.instance).slice(0, 80);
  const options = cleanOptions(a.options);
  if (options) row.options = options;
  if (a.delayMs != null && a.delayMs !== '') {
    const delay = Math.round(Number(a.delayMs));
    if (Number.isFinite(delay) && delay > 0) row.delayMs = Math.max(0, Math.min(60000, delay));
  }
  return row;
}

function cleanActions(element, raw) {
  const allow = EVENTS[element];
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const ev of Object.keys(src)) {
    if (!allow.includes(ev)) throw fail(400, `${element} has no ${ev} event`);
    const list = Array.isArray(src[ev]) ? src[ev] : [];
    out[ev] = list.slice(0, 16).map(cleanAction).filter(Boolean);
  }
  return out;
}

function cleanFeedbacks(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 24).filter((f) => f && typeof f === 'object').map((f) => {
    const row = { when: String(f.when || '').slice(0, 40), style: cleanStyle(f.style) };
    if (f.variable) row.variable = String(f.variable).slice(0, 80);
    if (f.op) row.op = String(f.op).slice(0, 12);
    if (f.value != null) row.value = String(f.value).slice(0, 80);
    return row;
  });
}

function cleanButton(body, prev) {
  const element = String((body && body.element) || (prev && prev.element) || 'button');
  if (!ELEMENTS.includes(element)) throw fail(400, `Unknown element "${element}"`);
  const role = normalizeRole((body && body.role) || (prev && prev.role) || 'program');
  const button = {
    id: idOf(body && body.id, 'b'),
    name: cleanName(body && body.name, prev && prev.name),
    element,
    role,
    text: String((body && body.text != null ? body.text : (prev && prev.text) || '')).slice(0, 80),
    title: String((body && body.title != null ? body.title : (prev && prev.title) || '')).slice(0, 40),
    caption: String((body && body.caption != null ? body.caption : (prev && prev.caption) || '')).slice(0, 40),
    style: body && body.style !== undefined ? cleanStyle(body.style) : ((prev && prev.style) || {}),
    target: body && body.target !== undefined ? cleanTarget(body.target) : ((prev && prev.target) || { mode: 'follow', system: '', instance: '' }),
    actions: body && body.actions !== undefined ? cleanActions(element, body.actions) : ((prev && prev.actions) || {}),
    feedbacks: body && body.feedbacks !== undefined ? cleanFeedbacks(body.feedbacks) : ((prev && prev.feedbacks) || []),
    template: body && body.template !== undefined ? (body.template ? String(body.template).slice(0, 40) : null) : ((prev && prev.template) || null),
    confirm: body && body.confirm !== undefined ? !!body.confirm : !!(prev && prev.confirm),
    theme: (body && body.theme !== undefined ? body.theme : (prev && prev.theme)) === 'light' ? 'light' : '',
    createdAt: (prev && prev.createdAt) || now(),
    updatedAt: now(),
  };
  if (body && body.actions === undefined && prev && element !== prev.element) button.actions = cleanActions(element, prev.actions);
  return button;
}

function surfaceOf(id) {
  const surface = surfaceById(id);
  if (!surface) throw fail(400, `Unknown surface "${id}"`);
  return surface;
}

function placement(buttonId, target) {
  const row = { buttonId };
  if (target) row.target = cleanTarget(target);
  return row;
}

function cleanSlots(surface, body, byId) {
  const keys = [];
  const encoders = [];
  const touch = [];
  const seenK = new Set();
  const seenE = new Set();
  const seenT = new Set();
  const take = (slot) => {
    if (!slot || slot.buttonId == null || slot.buttonId === '') return null;
    const id = String(slot.buttonId).replace(/[^\w-]/g, '').slice(0, 40);
    const button = byId.get(id);
    if (!button) throw fail(400, `No button ${id}`);
    return { button, id };
  };
  for (const slot of (body && body.keys) || []) {
    const hit = take(slot);
    if (!hit) continue;
    if (hit.button.element !== 'button') throw fail(400, `${hit.button.name} is a ${hit.button.element}, not a key`);
    const row = Number(slot.row);
    const col = Number(slot.col);
    if (!Number.isInteger(row) || row < 0 || row >= surface.rows) throw fail(400, 'Key row is off this surface');
    if (!Number.isInteger(col) || col < 0 || col >= surface.cols) throw fail(400, 'Key column is off this surface');
    const at = `${row},${col}`;
    if (seenK.has(at)) throw fail(400, `Two buttons on key ${at}`);
    seenK.add(at);
    keys.push({ row, col, ...placement(hit.id, slot.target) });
  }
  const knob = (slot, list, seen, element) => {
    const hit = take(slot);
    if (!hit) return;
    if (hit.button.element !== element) throw fail(400, `${hit.button.name} is a ${hit.button.element}, not a ${element}`);
    const col = Number(slot.col);
    if (!Number.isInteger(col) || !(surface.knobCols || []).includes(col)) throw fail(400, `Column ${slot.col} has no encoder on ${surface.id}`);
    if (seen.has(col)) throw fail(400, `Two buttons on column ${col}`);
    seen.add(col);
    list.push({ col, ...placement(hit.id, slot.target) });
  };
  for (const slot of (body && body.encoders) || []) knob(slot, encoders, seenE, 'encoder');
  for (const slot of (body && body.touch) || []) knob(slot, touch, seenT, 'touch-segment');
  return { keys, encoders, touch };
}

class ButtonLibrary {
  constructor({ dataDir } = {}) {
    this.dir = dataDir;
    this.buttonFile = dataDir ? path.join(dataDir, 'button-library.json') : null;
    this.pageFile = dataDir ? path.join(dataDir, 'surface-pages.json') : null;
    this.buttons = [];
    this.pages = [];
    this._load();
  }

  _load() {
    const rawB = this.buttonFile ? readJson(this.buttonFile, { buttons: [] }) : { buttons: [] };
    const rawP = this.pageFile ? readJson(this.pageFile, { pages: [] }) : { pages: [] };
    let dirtyB = false;
    this.buttons = [];
    for (const row of rawB.buttons || []) {
      if (!row || typeof row !== 'object') continue;
      try {
        const mapped = normalizeRole(row.role);
        if (mapped !== row.role) dirtyB = true;
        const button = cleanButton({ ...row, role: mapped, id: row.id }, null);
        button.createdAt = row.createdAt || button.createdAt;
        if (mapped === row.role && row.updatedAt) button.updatedAt = row.updatedAt;
        this.buttons.push(button);
      } catch { dirtyB = true; }
    }
    const ids = new Set(this.buttons.map((b) => b.id));
    let dirtyP = false;
    this.pages = [];
    for (const row of rawP.pages || []) {
      if (!row || typeof row !== 'object') continue;
      let surface;
      try { surface = surfaceOf(row.surface); } catch { dirtyP = true; continue; }
      const keep = (list) => (list || []).filter((s) => s && ids.has(s.buttonId));
      const keys = keep(row.keys);
      const encoders = keep(row.encoders);
      const touch = keep(row.touch);
      if (keys.length !== (row.keys || []).length || encoders.length !== (row.encoders || []).length || touch.length !== (row.touch || []).length) dirtyP = true;
      try {
        const slots = cleanSlots(surface, { keys, encoders, touch }, new Map(this.buttons.map((b) => [b.id, b])));
        this.pages.push({
          id: idOf(row.id, 'p'),
          name: cleanName(row.name, 'Page'),
          surface: surface.id,
          ...slots,
          createdAt: row.createdAt || now(),
          updatedAt: row.updatedAt || now(),
        });
      } catch { dirtyP = true; }
    }
    if (dirtyB) this._writeButtons();
    if (dirtyP) this._writePages();
  }

  _writeButtons() {
    if (this.buttonFile) writeJsonAtomic(this.buttonFile, { buttons: this.buttons });
  }

  _writePages() {
    if (this.pageFile) writeJsonAtomic(this.pageFile, { pages: this.pages });
  }

  byId() { return new Map(this.buttons.map((b) => [b.id, b])); }

  view() {
    return { roles: PUBLIC_ROLES.slice(), elements: ELEMENTS.slice(), buttons: this.buttons.map(clone) };
  }

  button(id) {
    const row = this.buttons.find((b) => b.id === id);
    if (!row) throw fail(404, `No button ${id}`);
    return clone(row);
  }

  createButton(body = {}) {
    const row = cleanButton({ ...body, id: body.id || freshId('b') }, null);
    if (this.buttons.some((b) => b.id === row.id)) throw fail(400, `Button ${row.id} already exists`);
    this.buttons.push(row);
    this._writeButtons();
    return clone(row);
  }

  updateButton(id, body = {}) {
    const i = this.buttons.findIndex((b) => b.id === id);
    if (i < 0) throw fail(404, `No button ${id}`);
    const row = cleanButton({ ...body, id }, this.buttons[i]);
    this.buttons[i] = row;
    this._writeButtons();
    return clone(row);
  }

  duplicateButton(id) {
    const src = this.buttons.find((b) => b.id === id);
    if (!src) throw fail(404, `No button ${id}`);
    const taken = new Set(this.buttons.map((b) => b.name));
    let name = `${src.name} copy`.slice(0, 60);
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(`${src.name} copy ${n}`) && n < 100) n += 1;
      name = `${src.name} copy ${n}`.slice(0, 60);
    }
    const copy = cleanButton({ ...clone(src), id: freshId('b'), name }, null);
    copy.createdAt = now();
    this.buttons.push(copy);
    this._writeButtons();
    return clone(copy);
  }

  deleteButton(id) {
    const before = this.buttons.length;
    this.buttons = this.buttons.filter((b) => b.id !== id);
    if (this.buttons.length === before) throw fail(404, `No button ${id}`);
    for (const page of this.pages) {
      page.keys = page.keys.filter((s) => s.buttonId !== id);
      page.encoders = page.encoders.filter((s) => s.buttonId !== id);
      page.touch = page.touch.filter((s) => s.buttonId !== id);
      page.updatedAt = now();
    }
    this._writeButtons();
    this._writePages();
    return { ok: true, id };
  }

  viewPages() { return { pages: this.pages.map(clone) }; }

  page(id) {
    const row = this.pages.find((p) => p.id === id);
    if (!row) throw fail(404, `No page ${id}`);
    return clone(row);
  }

  createPage(body = {}) {
    const surface = surfaceOf(body.surface);
    const slots = cleanSlots(surface, body, this.byId());
    const row = {
      id: idOf(body.id, 'p'),
      name: cleanName(body.name),
      surface: surface.id,
      ...slots,
      createdAt: now(),
      updatedAt: now(),
    };
    if (this.pages.some((p) => p.id === row.id)) throw fail(400, `Page ${row.id} already exists`);
    this.pages.push(row);
    this._writePages();
    return clone(row);
  }

  updatePage(id, body = {}) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i < 0) throw fail(404, `No page ${id}`);
    const prev = this.pages[i];
    const surface = surfaceOf(body.surface != null ? body.surface : prev.surface);
    const slots = cleanSlots(surface, {
      keys: body.keys !== undefined ? body.keys : prev.keys,
      encoders: body.encoders !== undefined ? body.encoders : prev.encoders,
      touch: body.touch !== undefined ? body.touch : prev.touch,
    }, this.byId());
    const row = {
      ...prev,
      name: body.name != null ? cleanName(body.name) : prev.name,
      surface: surface.id,
      ...slots,
      updatedAt: now(),
    };
    this.pages[i] = row;
    this._writePages();
    return clone(row);
  }

  renamePage(id, name) {
    return this.updatePage(id, { name });
  }

  deletePage(id) {
    const before = this.pages.length;
    this.pages = this.pages.filter((p) => p.id !== id);
    if (this.pages.length === before) throw fail(404, `No page ${id}`);
    this._writePages();
    return { ok: true, id };
  }
}

module.exports = { ButtonLibrary, PUBLIC_ROLES, ELEMENTS, normalizeRole };
