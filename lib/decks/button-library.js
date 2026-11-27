'use strict';
// Button library and named surface pages. A button is a key-class definition with
// no page coordinates. A page is placements: a surface slot points at a library id.
// Files live next to decks.json: button-library.json and surface-pages.json.
// Both files carry `version: 2` since 0.31.0. Loading an older file migrates it:
// a bare list becomes { pages } / { buttons }, a surface id from Companion or
// Steven's fork (streamdeck-plus-xl, streamdeck-xl, ...) becomes the Control
// Center id, a legacy `order` number sorts the pages and is dropped, and a
// duplicate page id is renamed. The page order is the order in the file.

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../store');
const { surfaceById } = require('./surfaces');
const { SharedButtonLibrary, migrateLegacyButton } = require('../surfaces/button-core');

const FILE_VERSION = 2;
const RESERVED_PAGE_IDS = new Set(['order']);

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

// Slots of `page` that still exist on `surface`. Used when a page is copied to
// another surface type: what does not fit is dropped and counted.
function fitSlots(page, surface) {
  const keys = (page.keys || []).filter((s) => s.row < surface.rows && s.col < surface.cols);
  const knobs = new Set(surface.knobCols || []);
  const encoders = (page.encoders || []).filter((s) => knobs.has(s.col));
  const touch = (page.touch || []).filter((s) => knobs.has(s.col));
  const dropped = (page.keys || []).length - keys.length + (page.encoders || []).length - encoders.length + (page.touch || []).length - touch.length;
  return { keys: clone(keys), encoders: clone(encoders), touch: clone(touch), dropped };
}

function listOf(raw, key) {
  if (Array.isArray(raw)) return { list: raw, migrated: true };
  const list = raw && Array.isArray(raw[key]) ? raw[key] : [];
  return { list, migrated: !raw || raw.version !== FILE_VERSION };
}

function toLegacy(v1) {
  if (!v1 || typeof v1 !== 'object') return null;
  const kindToElement = { key: 'button', dial: 'encoder', strip: 'touch-segment', tourbox: 'tourbox' };
  const element = kindToElement[v1.kind] || 'button';
  let role = 'toggle';
  if (v1.template && PUBLIC_ROLES.includes(v1.template)) role = v1.template;
  else {
    const ROLE_CATEGORY = { program: 'bus', preview: 'bus', hot: 'take', shift: 'mode', memory: 'recall', macro: 'recall', nav: 'nav', tab: 'nav', info: 'status', toggle: 'mode' };
    for (const [r, c] of Object.entries(ROLE_CATEGORY)) {
      if (c === v1.category) { role = r; break; }
    }
  }
  const actions = {};
  const d = v1.do || {};
  if (d.press && d.press.cap) actions.press = [{ action: d.press.cap }];
  if (d.hold && d.hold.cap) actions.hold = [{ action: d.hold.cap }];
  if (d.turn && d.turn.cap) actions.turn = [{ action: d.turn.cap }];
  if (d.touch && d.touch.cap) actions.touch = [{ action: d.touch.cap }];
  const display = v1.display || {};
  return {
    id: v1.id,
    name: v1.name,
    element,
    role,
    text: typeof display.value === 'string' ? display.value : (display.value || ''),
    title: typeof display.title === 'string' ? display.title : '',
    caption: typeof display.caption === 'string' ? display.caption : '',
    style: v1.styleOverride || {},
    target: v1.target || { mode: 'follow' },
    actions,
    feedbacks: Array.isArray(v1.feedback) ? v1.feedback : [],
    template: v1.template,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
  };
}

class ButtonLibrary {
  constructor({ dataDir } = {}) {
    this.dir = dataDir;
    this.buttonFile = dataDir ? path.join(dataDir, 'button-library.json') : null;
    this.shared = new SharedButtonLibrary({ dataDir });
    this.pageFile = dataDir ? path.join(dataDir, 'surface-pages.json') : null;
    this.buttons = [];
    this.pages = [];
    this._load();
  }

  _load() {
    const hasB = !!(this.buttonFile && fs.existsSync(this.buttonFile));
    const hasP = !!(this.pageFile && fs.existsSync(this.pageFile));
    const rawB = hasB ? readJson(this.buttonFile, { buttons: [] }) : { version: FILE_VERSION, buttons: [] };
    const rawP = hasP ? readJson(this.pageFile, { pages: [] }) : { version: FILE_VERSION, pages: [] };
    const fileB = listOf(rawB, 'buttons');
    const fileP = listOf(rawP, 'pages');
    // Buttons come from the shared library (surfaces/buttons.json). The old
    // button-library.json is only read for migration by SharedButtonLibrary.
    this.buttons = (this.shared.list() || []).map(toLegacy).filter(Boolean);
    let dirtyB = false; // shared handles its own migration and save
    const ids = new Set(this.buttons.map((b) => b.id));
    let dirtyP = hasP && fileP.migrated;
    this.pages = [];
    const rows = fileP.list.filter((row) => row && typeof row === 'object');
    if (rows.some((row) => row.order != null)) {
      dirtyP = true;
      rows.sort((a, b) => (Number.isFinite(Number(a.order)) ? Number(a.order) : Infinity) - (Number.isFinite(Number(b.order)) ? Number(b.order) : Infinity));
    }
    const seenIds = new Set();
    for (const row of rows) {
      let surface;
      try { surface = surfaceOf(row.surface); } catch { dirtyP = true; continue; }
      if (surface.id !== row.surface) dirtyP = true;
      let pid = idOf(row.id, 'p');
      if (seenIds.has(pid) || RESERVED_PAGE_IDS.has(pid)) { pid = freshId('p'); dirtyP = true; }
      seenIds.add(pid);
      const keep = (list) => (list || []).filter((s) => s && ids.has(s.buttonId));
      const keys = keep(row.keys);
      const encoders = keep(row.encoders);
      const touch = keep(row.touch);
      if (keys.length !== (row.keys || []).length || encoders.length !== (row.encoders || []).length || touch.length !== (row.touch || []).length) dirtyP = true;
      try {
        const slots = cleanSlots(surface, { keys, encoders, touch }, new Map(this.buttons.map((b) => [b.id, b])));
        this.pages.push({
          id: pid,
          name: cleanName(row.name, 'Page'),
          surface: surface.id,
          ...slots,
          createdAt: row.createdAt || now(),
          updatedAt: row.updatedAt || now(),
        });
      } catch { dirtyP = true; }
    }
    if (dirtyP) this._writePages();
  }

  _writeButtons() {
    // Persist through the shared library. Rebuild its list from the legacy view.
    const current = this.shared.list().slice();
    for (const b of current) {
      try { this.shared.remove(b.id); } catch {}
    }
    for (const b of this.buttons) {
      const migrated = migrateLegacyButton(b);
      if (migrated) this.shared.save(migrated);
    }
  }

  _writePages() {
    if (this.pageFile) writeJsonAtomic(this.pageFile, { version: FILE_VERSION, pages: this.pages });
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

  viewPages() { return { version: FILE_VERSION, pages: this.pages.map(clone) }; }

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
    if (RESERVED_PAGE_IDS.has(row.id)) throw fail(400, `"${row.id}" is not a page id`);
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

  // Copy a page, optionally onto another surface type. Placements that do not
  // exist on the target surface are dropped and counted in `dropped`.
  copyPage(id, body = {}) {
    const src = this.pages.find((p) => p.id === id);
    if (!src) throw fail(404, `No page ${id}`);
    const surface = surfaceOf(body.surface != null && body.surface !== '' ? body.surface : src.surface);
    const taken = new Set(this.pages.map((p) => p.name));
    let name = body.name != null && String(body.name).trim() ? cleanName(body.name) : `${src.name} copy`.slice(0, 60);
    if (body.name == null && taken.has(name)) {
      let n = 2;
      while (taken.has(`${src.name} copy ${n}`) && n < 100) n += 1;
      name = `${src.name} copy ${n}`.slice(0, 60);
    }
    const fit = fitSlots(src, surface);
    const row = {
      id: freshId('p'),
      name,
      surface: surface.id,
      ...cleanSlots(surface, fit, this.byId()),
      createdAt: now(),
      updatedAt: now(),
    };
    const at = this.pages.findIndex((p) => p.id === id);
    this.pages.splice(at + 1, 0, row);
    this._writePages();
    return { ...clone(row), copiedFrom: id, dropped: fit.dropped };
  }

  // Reorder pages. `ids` may be every page or a subset (for example the pages of
  // one surface type): the listed pages are put back into the positions they
  // already occupy, in the given order. Pages not listed do not move.
  reorderPages(ids) {
    if (!Array.isArray(ids) || !ids.length) throw fail(400, 'ids required');
    const list = ids.map((v) => String(v || ''));
    if (new Set(list).size !== list.length) throw fail(400, 'A page is listed twice');
    const at = list.map((pid) => this.pages.findIndex((p) => p.id === pid));
    const missing = list.find((pid, i) => at[i] < 0);
    if (missing) throw fail(404, `No page ${missing}`);
    const slots = at.slice().sort((a, b) => a - b);
    const rows = list.map((pid) => this.pages.find((p) => p.id === pid));
    const next = this.pages.slice();
    slots.forEach((pos, i) => { next[pos] = rows[i]; });
    this.pages = next;
    this._writePages();
    return this.viewPages();
  }

  deletePage(id) {
    const before = this.pages.length;
    this.pages = this.pages.filter((p) => p.id !== id);
    if (this.pages.length === before) throw fail(404, `No page ${id}`);
    this._writePages();
    return { ok: true, id };
  }
}

module.exports = { ButtonLibrary, PUBLIC_ROLES, ELEMENTS, FILE_VERSION, normalizeRole, fitSlots };
