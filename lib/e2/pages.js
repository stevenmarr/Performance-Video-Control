'use strict';
// Stream Deck + XL pages for Event Master programming.
// The grid is built from the discovered model: destination names, layer names,
// which layers are free, and only the encoder banks that layer actually has.
// Nothing here is a fixed E2 layout.
//
// Colour is the job. Program is a red frame with a LIVE corner. Preview is
// green. The thing you are editing is blue. CUT and AUTO are red because they
// go to Program. CLEAR is amber because it needs a confirm.

const { SURFACES } = require('../decks/surfaces');
const { formatValue, fraction } = require('./encoders');

const post = (system, body) => ({
  method: 'POST',
  path: `/api/sys/${system}/program`,
  body: body || {},
});

function blank(col, row) {
  return { col, row, label: '', caption: '', tone: 'blank', action: null, nav: null };
}

function put(grid, cols, col, row, spec) {
  if (col < 0 || row < 0) return;
  const i = row * cols + col;
  if (i < 0 || i >= grid.length) return;
  grid[i] = { ...blank(col, row), ...spec, col, row };
}

function gridFor(surface) {
  const cols = surface.cols;
  const rows = surface.rows;
  const grid = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) grid.push(blank(c, r));
  }
  return grid;
}

function short(s, n) {
  const t = String(s || '').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function liveKey(base, onProgram) {
  if (!onProgram) return base;
  return { ...base, tone: 'stop', liveCorner: true };
}

function knobFor(enc, activeIndex) {
  const pair = enc.pair || [];
  const parts = pair.map((p, i) => ({
    label: p.label,
    text: formatValue(p.value),
    fraction: fraction(p.value, p.min, p.max),
    active: i === activeIndex,
  }));
  return {
    kind: pair.length > 1 ? 'pair' : 'single',
    tally: 'pvw',
    parts,
    stepLine: pair.length > 1 ? 'TAP SWAPS' : 'PVW',
  };
}

function dialsFor(view, system, knobCount) {
  const encoders = (view && view.encoders) || [];
  const dials = [];
  for (let i = 0; i < knobCount; i++) {
    const enc = encoders[i];
    if (!enc) {
      dials.push({ label: '', e2: false, knob: { kind: 'single', parts: [{ label: '', text: '', fraction: 0, active: false }], stepLine: '' } });
      continue;
    }
    dials.push({
      label: enc.label,
      e2: true,
      action: post(system, { op: 'turn', encoder: i }),
      knob: knobFor(enc, enc.active || 0),
    });
  }
  return dials;
}

const PAGES = [
  { id: 'dest', title: 'E2 destinations' },
  { id: 'layer', title: 'E2 layers' },
  { id: 'adjust', title: 'E2 adjust' },
  { id: 'source', title: 'E2 sources' },
  { id: 'preset', title: 'E2 presets' },
];

function nav(active, cols) {
  // Page order: dest, layer, adjust, source, preset.
  const items = [
    { label: 'HOME', caption: 'DECK', tone: 'os', nav: 'home', id: 'home' },
    { label: 'DEST', caption: 'SCREEN', tone: 'nav', progPage: 0, nav: 'page', id: 'dest' },
    { label: 'LAYER', caption: 'PICK', tone: 'nav', progPage: 1, nav: 'page', id: 'layer' },
    { label: 'ADJUST', caption: 'DIALS', tone: 'nav', progPage: 2, nav: 'page', id: 'adjust' },
    { label: 'SRC', caption: 'INPUT', tone: 'nav', progPage: 3, nav: 'page', id: 'source' },
    { label: 'PRESET', caption: 'RECALL', tone: 'nav', progPage: 4, nav: 'page', id: 'preset' },
  ];
  items.forEach((item) => { if (item.id === active) item.on = true; });
  return items.slice(0, Math.max(1, cols - 2));
}

function transport(system) {
  return [
    { label: 'CUT', caption: 'PGM', tone: 'stop', action: post(system, { op: 'cut' }) },
    { label: 'AUTO', caption: 'PGM', tone: 'stop', action: post(system, { op: 'take' }) },
  ];
}

function fillNav(grid, surface, system, active) {
  const cols = surface.cols;
  const items = nav(active, cols);
  items.forEach((item, i) => put(grid, cols, i, 0, item));
  const tr = transport(system);
  put(grid, cols, cols - 2, 0, tr[0]);
  put(grid, cols, cols - 1, 0, tr[1]);
}

function bodySlots(surface) {
  const slots = [];
  for (let r = 1; r < surface.rows; r++) {
    for (let c = 0; c < surface.cols; c++) slots.push([c, r]);
  }
  return slots;
}

function pageShell(surface, system, id, title) {
  const grid = gridFor(surface);
  fillNav(grid, surface, system, id);
  return {
    designId: `e2-program-${id}`,
    title,
    keys: grid,
    dials: [],
  };
}

function destPage(surface, view, system) {
  const page = pageShell(surface, system, 'dest', 'E2 destinations');
  const slots = bodySlots(surface);
  const rows = view.destinations || [];
  const room = Math.max(1, slots.length - 1);
  const pageNo = view.pager && view.pager.dest || 0;
  const slice = rows.slice(pageNo * room, (pageNo + 1) * room);
  slice.forEach((d, i) => {
    const [c, r] = slots[i];
    const live = !!d.live;
    put(page.keys, surface.cols, c, r, liveKey({
      label: short(d.name, 12),
      caption: d.kind === 'aux' ? 'AUX' : (live ? 'LIVE' : (d.preview ? 'PVW' : d.key)),
      tone: d.selected ? 'go' : (d.preview && !live ? 'pvw' : 'func'),
      on: !!d.selected,
      ring: !!d.selected,
      action: post(system, { op: 'selectDest', dest: d.key }),
      thenProg: 1,
    }, live));
  });
  if (rows.length > room) {
    const [c, r] = slots[slots.length - 1];
    put(page.keys, surface.cols, c, r, {
      label: 'MORE', caption: 'DEST', tone: 'nav', action: post(system, { op: 'pager', which: 'dest' }),
    });
  }
  return page;
}

function layerCaption(layer) {
  const bits = [];
  if (layer.role === 'mix') bits.push('MIX');
  else if (layer.role === 'split') bits.push('SPLIT');
  else if (layer.role === 'background') bits.push('BG');
  else bits.push('PIP');
  if (layer.live) bits.push('LIVE');
  else if (layer.pvw) bits.push('PVW');
  else if (layer.free) bits.push('FREE');
  else bits.push('IN USE');
  return bits.join(' ');
}

function layerPage(surface, view, system) {
  const page = pageShell(surface, system, 'layer', 'E2 layers');
  const slots = bodySlots(surface);
  if (view.note) {
    put(page.keys, surface.cols, 0, 1, {
      label: 'AUX', caption: 'NO LAYER', tone: 'nav', action: post(system, {}), thenProg: 3,
    });
    put(page.keys, surface.cols, 1, 1, {
      label: 'SOURCE', caption: 'PICK', tone: 'nav', progPage: 3, nav: 'page',
    });
    return page;
  }
  const rows = view.layers || [];
  const room = Math.max(1, slots.length - 1);
  const pageNo = view.pager && view.pager.layer || 0;
  const slice = rows.slice(pageNo * room, (pageNo + 1) * room);
  slice.forEach((layer, i) => {
    const [c, r] = slots[i];
    const live = !!layer.live;
    put(page.keys, surface.cols, c, r, liveKey({
      label: short(layer.name, 12),
      caption: layerCaption(layer),
      tone: live ? 'stop' : (layer.pvw ? 'pvw' : (layer.free ? 'func' : 'memory')),
      on: !!layer.selected,
      ring: !!layer.selected,
      action: post(system, { op: 'selectLayer', layer: layer.id }),
      thenProg: 2,
    }, live));
  });
  if (!rows.length) {
    put(page.keys, surface.cols, 0, 1, { label: 'NONE', caption: 'NO LAYERS', tone: 'func' });
  }
  if (rows.length > room) {
    const [c, r] = slots[slots.length - 1];
    put(page.keys, surface.cols, c, r, {
      label: 'MORE', caption: 'LAYER', tone: 'nav', action: post(system, { op: 'pager', which: 'layer' }),
    });
  }
  return page;
}

function adjustPage(surface, view, system) {
  const page = pageShell(surface, system, 'adjust', 'E2 adjust');
  const cols = surface.cols;
  const banks = view.banks || [];
  banks.forEach((b, i) => {
    put(page.keys, cols, i, 1, {
      label: b.label,
      caption: 'BANK',
      tone: 'nav',
      on: view.selected && view.selected.bank === b.id,
      action: post(system, { op: 'selectBank', bank: b.id }),
    });
  });
  const sc = view.shortcuts || {};
  const tools = [];
  if (sc.aspect) tools.push({ label: view.selected && view.selected.aspectLock ? 'LOCK' : 'LOCK', caption: view.selected && view.selected.aspectLock ? 'ON' : 'ASPECT', tone: view.selected && view.selected.aspectLock ? 'go' : 'func', on: !!(view.selected && view.selected.aspectLock), action: post(system, { op: 'aspect', mode: 'lock' }) });
  if (sc.center) tools.push({ label: 'CENTER', caption: 'PLACE', tone: 'func', action: post(system, { op: 'aspect', mode: 'center' }) });
  if (sc.fit) tools.push({ label: 'FIT', caption: 'INSIDE', tone: 'func', action: post(system, { op: 'aspect', mode: 'fit' }) });
  if (sc.fill) tools.push({ label: 'FILL', caption: 'COVER', tone: 'func', action: post(system, { op: 'aspect', mode: 'fill' }) });
  if (sc.freeze) tools.push({ label: 'FRZ', caption: view.layerFrozen ? 'ON' : 'LAYER', tone: view.layerFrozen ? 'go' : 'func', on: !!view.layerFrozen, action: post(system, { op: 'freeze' }) });
  if (sc.invert) tools.push({ label: 'INVERT', caption: 'KEY', tone: 'func', action: post(system, { op: 'invert' }) });
  if (sc.z) {
    tools.push({ label: 'FRONT', caption: 'Z', tone: 'func', action: post(system, { op: 'z', dir: 1 }) });
    tools.push({ label: 'BACK', caption: 'Z', tone: 'func', action: post(system, { op: 'z', dir: -1 }) });
  }
  if (sc.clear) tools.push({ label: 'CLEAR', caption: 'HOLD', tone: 'guard', action: post(system, { op: 'clear', confirm: false }) });
  tools.forEach((tool, i) => {
    const col = i % cols;
    const row = 2 + Math.floor(i / cols);
    if (row >= surface.rows) return;
    put(page.keys, cols, col, row, tool);
  });
  const knobs = (surface.knobCols || []).length;
  page.dials = knobs ? dialsFor(view, system, knobs) : [];
  return page;
}

function sourcePage(surface, view, system) {
  const page = pageShell(surface, system, 'source', 'E2 sources');
  const slots = bodySlots(surface);
  const rows = view.sources || [];
  const room = Math.max(1, slots.length - 1);
  const pageNo = view.pager && view.pager.source || 0;
  const slice = rows.slice(pageNo * room, (pageNo + 1) * room);
  slice.forEach((s, i) => {
    const [c, r] = slots[i];
    const live = !!s.live;
    put(page.keys, surface.cols, c, r, liveKey({
      label: short(s.name, 12),
      caption: live ? 'LIVE' : (s.kind === 'still' ? 'STILL' : (s.selected ? 'PVW' : 'IN')),
      tone: live ? 'stop' : (s.selected ? 'pvw' : 'func'),
      on: !!s.selected && !live,
      action: post(system, { op: 'source', id: s.id }),
    }, live));
  });
  if (rows.length > room) {
    const [c, r] = slots[slots.length - 1];
    put(page.keys, surface.cols, c, r, {
      label: 'MORE', caption: 'SRC', tone: 'nav', action: post(system, { op: 'pager', which: 'source' }),
    });
  }
  return page;
}

function presetPage(surface, view, system) {
  const page = pageShell(surface, system, 'preset', 'E2 presets');
  const slots = bodySlots(surface);
  const rows = view.presets || [];
  const room = Math.max(1, slots.length - 2);
  const pageNo = view.pager && view.pager.preset || 0;
  const slice = rows.slice(pageNo * room, (pageNo + 1) * room);
  slice.forEach((p, i) => {
    const [c, r] = slots[i];
    const n = p.sno != null ? String(p.sno) : String((p.id || 0) + 1);
    put(page.keys, surface.cols, c, r, {
      label: short(p.name, 12),
      caption: n,
      tone: 'memory',
      absolute: true,
      action: post(system, { op: 'recall', id: p.id, target: 'preview' }),
    });
  });
  const saveSlot = slots[Math.min(slots.length - 2, slice.length)];
  if (saveSlot) {
    put(page.keys, surface.cols, saveSlot[0], saveSlot[1], {
      label: 'SAVE', caption: 'PVW', tone: 'guard', action: post(system, { op: 'save' }),
    });
  }
  if (rows.length > room) {
    const [c, r] = slots[slots.length - 1];
    put(page.keys, surface.cols, c, r, {
      label: 'MORE', caption: 'PRESET', tone: 'nav', action: post(system, { op: 'pager', which: 'preset' }),
    });
  }
  return page;
}

function buildProgramPages(surface, view, system) {
  const face = surface && surface.cols ? surface : SURFACES.plusxl;
  const id = system || 'e2';
  const v = view || { destinations: [], layers: [], sources: [], presets: [] };
  if (!v.ready && !(v.destinations || []).length) return [];
  return [
    destPage(face, v, id),
    layerPage(face, v, id),
    adjustPage(face, v, id),
    sourcePage(face, v, id),
    presetPage(face, v, id),
  ];
}

module.exports = { buildProgramPages, PAGES, dialsFor };
