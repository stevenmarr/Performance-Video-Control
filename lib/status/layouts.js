'use strict';
// Named status layouts, saved in the data folder (status-layouts.json).
// A layout is a grid of tiles. Each tile says what to show and where the
// number comes from. Saving a layout never talks to a switcher or a camera.

const path = require('path');
const { readJson, writeJsonAtomic } = require('../store');
const { clampTile, clampInt } = require('../../public/status-grid');
const { resolveZone } = require('./time');

const TYPES = ['clock', 'countdown', 'timer', 'text', 'tally', 'online', 'preset'];
const KINDS = ['clock', 'countdown', 'system', 'companion', 'companion-link'];
const FILE = 'status-layouts.json';

const fail = (message) => Object.assign(new Error(message), { status: 400 });

function cleanColor(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^#[0-9a-fA-F]{3}$/.test(s) || /^#[0-9a-fA-F]{6}$/.test(s) || /^#[0-9a-fA-F]{8}$/.test(s)) return s.toLowerCase();
  return '';
}

function cleanWarn(raw) {
  const amber = Number(raw && raw.amberSec);
  const red = Number(raw && raw.redSec);
  const amberSec = Number.isFinite(amber) ? Math.max(0, Math.min(24 * 3600, amber)) : 30;
  const redSec = Number.isFinite(red) ? Math.max(0, Math.min(24 * 3600, red)) : 10;
  if (amberSec > 0 && redSec >= amberSec) throw fail('The red warning has to be a shorter time than the amber warning.');
  return { amberSec, redSec };
}

function cleanSource(raw, type) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let kind = String(src.kind || '').trim();
  if (!KINDS.includes(kind)) kind = type === 'clock' ? 'clock' : type === 'countdown' ? 'countdown' : 'system';
  const system = String(src.system || '').trim().slice(0, 80);
  const variable = String(src.variable || '').trim().slice(0, 64);
  if (variable && !/^[A-Za-z0-9_.-]+$/.test(variable)) throw fail('A Companion variable name can use letters, numbers, dots, dashes and underscores.');
  const at = String(src.at || '').trim().slice(0, 80);
  return { kind, system, variable, at };
}

function cleanId(value, fallback) {
  const s = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{1,40}$/.test(s)) return s;
  return fallback;
}

function slug(value) {
  const s = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return s || 'layout';
}

function cleanTile(raw, index) {
  if (!raw || typeof raw !== 'object') throw fail(`Tile ${index + 1} is missing.`);
  const type = String(raw.type || '').trim();
  if (!TYPES.includes(type)) throw fail(`Tile ${index + 1} has a type this screen does not know${type ? `: ${type}` : ''}.`);
  const box = clampTile(raw);
  const fontSize = clampInt(raw.fontSize, 12, 200, defaultSize(type));
  return {
    id: cleanId(raw.id, `t${index + 1}`),
    type,
    label: String(raw.label == null ? '' : raw.label).trim().slice(0, 60),
    ...box,
    fontSize,
    color: cleanColor(raw.color),
    background: cleanColor(raw.background),
    warn: cleanWarn(raw.warn),
    source: cleanSource(raw.source, type),
    countMode: raw.countMode === 'remaining' ? 'remaining' : 'until',
    timeZone: raw.timeZone ? String(raw.timeZone).trim().slice(0, 80) : '',
    hour12: raw.hour12 === true ? true : raw.hour12 === false ? false : null,
  };
}

function defaultSize(type) {
  if (type === 'clock') return 96;
  if (type === 'countdown' || type === 'timer') return 84;
  if (type === 'online') return 56;
  if (type === 'preset') return 42;
  if (type === 'text') return 48;
  return 28;
}

function cleanLayout(raw, { soft = false } = {}) {
  try {
    if (!raw || typeof raw !== 'object') throw fail('A layout needs a name.');
    const name = String(raw.name || '').trim().slice(0, 40);
    if (!name) throw fail('A layout needs a name.');
    const zone = resolveZone(raw.timeZone || 'America/Chicago');
    if (zone.fallback && String(raw.timeZone || '').trim()) throw fail('That time zone is not one this computer knows. Try America/Chicago.');
    const tilesIn = Array.isArray(raw.tiles) ? raw.tiles.slice(0, 48) : [];
    const tiles = tilesIn.map((tile, i) => cleanTile(tile, i));
    const ids = new Set();
    for (const tile of tiles) {
      let id = tile.id;
      while (ids.has(id)) id = `${id}-2`.slice(0, 40);
      tile.id = id;
      ids.add(id);
    }
    return {
      id: cleanId(raw.id, slug(name)),
      name,
      timeZone: zone.timeZone,
      hour12: raw.hour12 === false ? false : true,
      notes: raw.notes === false ? false : true,
      editLink: raw.editLink === false ? false : true,
      tiles,
    };
  } catch (e) {
    if (soft) return null;
    throw e;
  }
}

function tile(partial) {
  return cleanTile({
    fontSize: defaultSize(partial.type),
    warn: { amberSec: 30, redSec: 10 },
    source: { kind: 'system', system: '', variable: '', at: '' },
    ...partial,
  }, 0);
}

function defaultLayouts() {
  const show = { kind: 'countdown', at: '19:00', system: '', variable: '' };
  const doors = { kind: 'countdown', at: '18:30', system: '', variable: '' };
  return [
    cleanLayout({
      id: 'foh', name: 'FOH', timeZone: 'America/Chicago', hour12: true,
      tiles: [
        tile({ id: 'clock', type: 'clock', label: 'House clock', col: 0, row: 0, w: 6, h: 2, fontSize: 108, source: { kind: 'clock' } }),
        tile({ id: 'show', type: 'countdown', label: 'Show', col: 6, row: 0, w: 3, h: 2, source: show }),
        tile({ id: 'showname', type: 'text', label: 'Show name', col: 9, row: 0, w: 3, h: 2, fontSize: 42, source: { kind: 'companion', variable: 'show_name' } }),
        tile({ id: 'play', type: 'timer', label: 'Playback', col: 0, row: 2, w: 6, h: 2, source: { kind: 'system', system: 'pixera' } }),
        tile({ id: 'atem', type: 'preset', label: 'ATEM', col: 6, row: 2, w: 6, h: 2, source: { kind: 'system', system: 'atem' } }),
        tile({ id: 'cams', type: 'tally', label: 'Cameras', col: 0, row: 4, w: 4, h: 2, source: { kind: 'system', system: 'ptz' } }),
        tile({ id: 'rs6', type: 'preset', label: 'RS6', col: 4, row: 4, w: 4, h: 2, source: { kind: 'system', system: 'rs6' } }),
        tile({ id: 'desk', type: 'online', label: 'Systems', col: 8, row: 4, w: 4, h: 2, fontSize: 36, source: { kind: 'system', system: 'desk' } }),
      ],
    }),
    cleanLayout({
      id: 'green-room', name: 'Green room', timeZone: 'America/Chicago', hour12: true,
      tiles: [
        tile({ id: 'clock', type: 'clock', label: 'House clock', col: 0, row: 0, w: 12, h: 2, fontSize: 120, source: { kind: 'clock' } }),
        tile({ id: 'show', type: 'countdown', label: 'Show', col: 0, row: 2, w: 6, h: 2, source: show }),
        tile({ id: 'doors', type: 'countdown', label: 'Doors', col: 6, row: 2, w: 6, h: 2, source: doors }),
        tile({ id: 'atem', type: 'preset', label: 'On program', col: 0, row: 4, w: 6, h: 2, source: { kind: 'system', system: 'atem' } }),
        tile({ id: 'cams', type: 'tally', label: 'Cameras', col: 6, row: 4, w: 6, h: 2, source: { kind: 'system', system: 'ptz' } }),
      ],
    }),
    cleanLayout({
      id: 'client', name: 'Client', timeZone: 'America/Chicago', hour12: true, notes: false, editLink: false,
      tiles: [
        tile({ id: 'clock', type: 'clock', label: '', col: 0, row: 0, w: 12, h: 2, fontSize: 140, source: { kind: 'clock' } }),
        tile({ id: 'show', type: 'countdown', label: 'Show starts in', col: 0, row: 2, w: 12, h: 2, fontSize: 120, source: show }),
        tile({ id: 'now', type: 'text', label: 'Now on program', col: 0, row: 4, w: 12, h: 2, fontSize: 72, source: { kind: 'system', system: 'atem' } }),
      ],
    }),
  ];
}

class LayoutStore {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, FILE) : null;
    this.data = this._load();
  }

  _load() {
    const raw = this.file ? readJson(this.file, null) : null;
    const list = raw && Array.isArray(raw.layouts) ? raw.layouts.map((row) => cleanLayout(row, { soft: true })).filter(Boolean) : [];
    if (!list.length) return { version: 1, layouts: defaultLayouts() };
    return { version: 1, layouts: uniqueIds(list) };
  }

  _save() {
    if (!this.file) return;
    writeJsonAtomic(this.file, { version: 1, layouts: this.data.layouts });
  }

  list() {
    return this.data.layouts.map((layout) => ({ ...layout, tiles: layout.tiles.map((tile) => ({ ...tile, warn: { ...tile.warn }, source: { ...tile.source } })) }));
  }

  names() {
    return this.data.layouts.map((layout) => layout.name);
  }

  find(query) {
    const layouts = this.data.layouts;
    if (query == null || String(query).trim() === '') return layouts[0] || null;
    const q = String(query).trim().toLowerCase();
    return layouts.find((layout) => layout.name.toLowerCase() === q || layout.id.toLowerCase() === q) || null;
  }

  create(body = {}) {
    const copy = body.copyFrom ? this.find(body.copyFrom) : null;
    if (body.copyFrom && !copy) throw fail('No layout with that name to copy.');
    const name = uniqueName(this.data.layouts, String(body.name || (copy ? `${copy.name} copy` : 'New layout')).trim() || 'New layout');
    const layout = cleanLayout(copy
      ? { ...copy, id: '', name, tiles: copy.tiles }
      : { name, timeZone: body.timeZone, hour12: body.hour12, tiles: body.tiles || [] });
    layout.id = uniqueLayoutId(this.data.layouts, slug(name));
    this.data.layouts.push(layout);
    this._save();
    return layout;
  }

  update(id, body) {
    const i = this.data.layouts.findIndex((layout) => layout.id === id);
    if (i < 0) throw Object.assign(new Error('No layout with that id.'), { status: 404 });
    const next = cleanLayout({ ...body, id });
    const clash = this.data.layouts.find((layout) => layout.id !== id && layout.name.toLowerCase() === next.name.toLowerCase());
    if (clash) throw fail(`There is already a layout named ${next.name}.`);
    this.data.layouts[i] = next;
    this._save();
    return next;
  }

  remove(id) {
    if (this.data.layouts.length < 2) throw fail('Keep at least one layout.');
    const i = this.data.layouts.findIndex((layout) => layout.id === id);
    if (i < 0) throw Object.assign(new Error('No layout with that id.'), { status: 404 });
    const [gone] = this.data.layouts.splice(i, 1);
    this._save();
    return { ok: true, name: gone.name };
  }

  importBody(body = {}) {
    const replace = body.replace === true;
    const list = Array.isArray(body.layouts) ? body.layouts : body.layout ? [body.layout] : (body.name && body.tiles ? [body] : null);
    if (!list) throw fail('That file is not a status layout. It needs a name and a list of tiles.');
    if (body.format && !['cc-status-layout', 'cc-status-layouts'].includes(body.format)) throw fail('That file is not a status layout.');
    const cleaned = list.map((row) => cleanLayout(row));
    if (!cleaned.length) throw fail('That file has no layouts.');
    if (replace) {
      this.data.layouts = uniqueIds(cleaned);
    } else {
      for (const layout of cleaned) {
        const i = this.data.layouts.findIndex((have) => have.id === layout.id || have.name.toLowerCase() === layout.name.toLowerCase());
        if (i >= 0) this.data.layouts[i] = { ...layout, id: this.data.layouts[i].id };
        else this.data.layouts.push({ ...layout, id: uniqueLayoutId(this.data.layouts, layout.id) });
      }
    }
    this._save();
    return this.list();
  }

  exportOne(id) {
    const layout = this.data.layouts.find((row) => row.id === id) || this.find(id);
    if (!layout) throw Object.assign(new Error('No layout with that name.'), { status: 404 });
    return { format: 'cc-status-layout', version: 1, layout };
  }

  exportAll() {
    return { format: 'cc-status-layouts', version: 1, layouts: this.list() };
  }
}

function uniqueName(layouts, name) {
  const base = name.slice(0, 40) || 'New layout';
  let n = base;
  let i = 2;
  while (layouts.some((layout) => layout.name.toLowerCase() === n.toLowerCase())) {
    const suffix = ` ${i++}`;
    n = base.slice(0, 40 - suffix.length) + suffix;
  }
  return n;
}

function uniqueLayoutId(layouts, id) {
  let n = id || 'layout';
  let i = 2;
  while (layouts.some((layout) => layout.id === n)) n = `${id}-${i++}`.slice(0, 40);
  return n;
}

function uniqueIds(list) {
  const out = [];
  for (const layout of list) out.push({ ...layout, id: uniqueLayoutId(out, layout.id) });
  return out;
}

function companionNames(layouts) {
  const names = new Set();
  const list = Array.isArray(layouts) ? layouts : [layouts];
  for (const layout of list) {
    if (!layout || !Array.isArray(layout.tiles)) continue;
    for (const t of layout.tiles) {
      if (t.source && t.source.kind === 'companion' && t.source.variable) names.add(t.source.variable);
    }
  }
  return [...names];
}

module.exports = {
  TYPES, KINDS, LayoutStore, cleanLayout, cleanTile, defaultLayouts, companionNames, slug, defaultSize,
};
