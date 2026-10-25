'use strict';
// Page templates for the systems on the desk. A template is a grid of keys for one
// surface size. Pushing a page stamps the live connection (camera id and IP, switcher host)
// into each key. Keys that jump to another page are how the warning list is built.

const { SURFACES } = require('./surfaces');
const { PLUSXL } = require('../deck');

const post = (path, body) => ({ method: 'POST', path, body: body || {} });

function pack(surface, cells, jumps) {
  const keys = [];
  const jumpRow = jumps.length && surface.rows > 1 ? surface.rows - 1 : -1;
  const slots = [];
  for (let r = 0; r < surface.rows; r++) {
    if (r === jumpRow) continue;
    for (let c = 0; c < surface.cols; c++) slots.push([r, c]);
  }
  cells.slice(0, slots.length).forEach((cell, i) => {
    keys.push({ row: slots[i][0], col: slots[i][1], label: cell.label, value: cell.value || '', caption: cell.caption || '', action: cell.action || null, jump: cell.jump || null, role: cell.role || '' });
  });
  if (jumpRow >= 0) {
    jumps.slice(0, surface.cols).forEach((j, i) => {
      keys.push({ row: jumpRow, col: i, label: j.label, value: '', caption: 'PAGE', action: null, jump: j.id, role: 'jump' });
    });
  }
  return keys;
}

function page(spec, surface, cells, jumps) {
  const keys = pack(surface, cells, jumps);
  return {
    id: spec.id,
    system: spec.system,
    title: spec.title,
    profile: spec.profile || null,
    surface: surface.id,
    keys,
    jumps: [...new Set(keys.map((k) => k.jump).filter(Boolean))],
  };
}

function ptzPages(surface) {
  const jump = [
    { id: 'ptz-live', label: 'LIVE' },
    { id: 'ptz-paint', label: 'PAINT' },
    { id: 'ptz-func', label: 'FUNC' },
    { id: 'ptz-move', label: 'MOVE' },
  ];
  const others = (id) => jump.filter((j) => j.id !== id);
  const recall = (n) => ({ label: String(n), value: 'PRESET', action: post('/api/sys/ptz/cmd/recall', { preset: n, guarded: true }), role: 'preset' });
  const op = (label, name, body) => ({ label, action: post(`/api/sys/ptz/cmd/${name}`, body || {}), role: name });
  return [
    page({ id: 'ptz-live', system: 'ptz', title: 'PTZ LIVE', profile: 'PTZ Live' }, surface, [
      op('CAM', 'select', {}),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(recall),
      op('IRIS', 'op', { op: 'irisMode' }),
      op('AWB', 'op', { op: 'awb' }),
      op('AF', 'op', { op: 'oneTouchAF' }),
      op('STOP', 'stopAll', {}),
    ], others('ptz-live')),
    page({ id: 'ptz-paint', system: 'ptz', title: 'PTZ PAINT', profile: 'PTZ Paint' }, surface, [
      op('GAIN', 'step', { op: 'gain', steps: 1 }),
      op('SHUTTER', 'step', { op: 'shutterStep', steps: 1 }),
      op('WB', 'step', { op: 'wbMode', steps: 1 }),
      op('AWB', 'op', { op: 'awb' }),
      op('ABB', 'op', { op: 'abb' }),
      op('DETAIL', 'op', { op: 'detail' }),
      op('BARS', 'op', { op: 'colorBars' }),
      op('ND', 'step', { op: 'ndFilter', steps: 1 }),
    ], others('ptz-paint')),
    page({ id: 'ptz-func', system: 'ptz', title: 'PTZ FUNC', profile: 'PTZ Functions' }, surface, [
      op('TALLY', 'op', { op: 'tallyRed' }),
      op('POWER', 'op', { op: 'power' }),
      op('OIS', 'op', { op: 'ois' }),
      op('NIGHT', 'op', { op: 'dayNight' }),
      op('D.EXT', 'step', { op: 'dExtender', steps: 1 }),
      op('GUARD', 'guard', { mode: 'cycle' }),
      op('STOP', 'stopAll', {}),
    ], others('ptz-func')),
    page({ id: 'ptz-move', system: 'ptz', title: 'PTZ MOVE', profile: 'PTZ Move' }, surface, [
      op('UP', 'move', { pan: 0, tilt: 1 }),
      op('LEFT', 'move', { pan: -1, tilt: 0 }),
      op('DOWN', 'move', { pan: 0, tilt: -1 }),
      op('RIGHT', 'move', { pan: 1, tilt: 0 }),
      op('TELE', 'zoom', { dir: 1 }),
      op('WIDE', 'zoom', { dir: -1 }),
      op('HOME', 'home', {}),
      op('STOP', 'stopAll', {}),
    ], others('ptz-move')),
  ];
}

function libraryFor(desk, surface) {
  const armed = new Set(desk.armed || []);
  const pages = [];
  const has = (k) => armed.has(k);
  if (has('rs6')) {
    const presets = [];
    for (let n = 1; n <= 12; n++) presets.push({ label: String(n), value: 'RECALL', action: post(`/api/presets/${n}/recall`, {}) });
    pages.push(page({ id: 'rs6-presets', system: 'rs6', title: 'RS6 PRESETS' }, surface, [
      { label: 'TAKE', value: 'PGM', action: post('/api/take', {}) },
      { label: 'CUT', value: 'PGM', action: post('/api/cut', {}) },
      ...presets,
    ], []));
  }
  if (has('e2')) {
    pages.push(page({ id: 'e2-presets', system: 'e2', title: 'E2' }, surface, [
      { label: 'TAKE', action: post('/api/sys/e2/take', {}) },
      { label: 'CUT', action: post('/api/sys/e2/cut', {}) },
      { label: 'REFRESH', action: post('/api/sys/e2/refresh', {}) },
    ], []));
  }
  if (has('pixelhue')) {
    pages.push(page({ id: 'pixelhue-presets', system: 'pixelhue', title: 'PIXELHUE' }, surface, [
      { label: 'TAKE', action: post('/api/sys/pixelhue/take', {}) },
      { label: 'CUT', action: post('/api/sys/pixelhue/cut', {}) },
      { label: 'REFRESH', action: post('/api/sys/pixelhue/refresh', {}) },
    ], []));
  }
  if (has('atem')) {
    const inputs = [];
    for (let n = 1; n <= 8; n++) inputs.push({ label: String(n), value: 'PGM', action: post('/api/sys/atem/cmd/program', { source: n }) });
    pages.push(page({ id: 'atem-switcher', system: 'atem', title: 'ATEM SWITCHER' }, surface, [
      { label: 'CUT', value: 'PGM', action: post('/api/sys/atem/cmd/cut', {}) },
      { label: 'AUTO', value: 'PGM', action: post('/api/sys/atem/cmd/auto', {}) },
      ...inputs,
    ], [{ id: 'atem-macros', label: 'MACROS' }]));
    const macros = [];
    for (let n = 0; n < 8; n++) macros.push({ label: `M${n + 1}`, value: 'RUN', action: post('/api/sys/atem/cmd/macroRun', { macro: n }) });
    pages.push(page({ id: 'atem-macros', system: 'atem', title: 'ATEM MACROS' }, surface, macros, [{ id: 'atem-switcher', label: 'SWITCHER' }]));
  }
  if (has('ptz')) pages.push(...ptzPages(surface));
  if (has('pixera')) {
    pages.push(page({ id: 'pixera-play', system: 'pixera', title: 'PIXERA' }, surface, [
      { label: 'PLAY', action: post('/api/sys/pixera/cmd/transport', { mode: 'play' }) },
      { label: 'PAUSE', action: post('/api/sys/pixera/cmd/transport', { mode: 'pause' }) },
      { label: 'STOP', action: post('/api/sys/pixera/cmd/transport', { mode: 'stop' }) },
      { label: 'NEXT', action: post('/api/sys/pixera/cmd/nextCue', {}) },
    ], []));
  }
  if (has('millumin')) {
    pages.push(page({ id: 'millumin-show', system: 'millumin', title: 'MILLUMIN' }, surface, [
      { label: 'PLAY', action: post('/api/sys/millumin/cmd/play', {}) },
      { label: 'PAUSE', action: post('/api/sys/millumin/cmd/pause', {}) },
      { label: 'COL 1', action: post('/api/sys/millumin/cmd/column', { value: 1 }) },
      { label: 'COL 2', action: post('/api/sys/millumin/cmd/column', { value: 2 }) },
    ], []));
  }
  return pages;
}

function jumpLabel(page) {
  const title = String(page.title || page.id || 'PAGE');
  if (/^PTZ\s+/i.test(title)) return title.replace(/^PTZ\s+/i, '').slice(0, 8);
  if (page.id === 'atem-macros') return 'MACROS';
  if (page.id === 'atem-switcher') return 'ATEM';
  return title.split(/\s+/)[0].slice(0, 8);
}

function dialsFor(page) {
  if (!page || page.system !== 'ptz') return [];
  const name = String(page.id || '').replace(/^ptz-/, '');
  const hit = PLUSXL.pages.find((p) => p.id === name);
  return hit ? hit.dials.slice() : [];
}

function fillGrid(keys, surface, device) {
  const by = new Map();
  for (const key of keys) by.set(`${key.col},${key.row}`, key);
  const out = [];
  for (let row = 0; row < surface.rows; row++) {
    for (let col = 0; col < surface.cols; col++) {
      const hit = by.get(`${col},${row}`);
      out.push(hit || { row, col, label: ' ', value: '', caption: '', action: null, jump: null, role: '', device: device || null });
    }
  }
  return out;
}

// The last row of every page moves to the other pages. Unused keys are blank so a
// push replaces whatever command used to be there.
function linkPages(pages, surface) {
  if (!surface || !pages.length) return pages;
  const row = surface.rows > 1 ? surface.rows - 1 : -1;
  return pages.map((page) => {
    const keys = row < 0 ? page.keys.slice() : page.keys.filter((k) => k.row !== row);
    if (row >= 0) {
      pages.filter((p) => p.id !== page.id).slice(0, surface.cols).forEach((target, col) => {
        keys.push({
          row, col, label: jumpLabel(target), value: '', caption: 'PAGE', action: null, jump: target.id, role: 'jump', device: page.device || null,
        });
      });
    }
    return { ...page, keys: fillGrid(keys, surface, page.device), dials: dialsFor(page) };
  });
}

function catalogIds(desk) {
  return libraryFor(desk, SURFACES.xl).map((p) => p.id);
}

function selectedCamera(sys) {
  const cams = (sys && sys.cameras) || [];
  return cams.find((c) => c.id === sys.selected) || cams[0] || null;
}

function stampPage(src, desk) {
  const page = JSON.parse(JSON.stringify(src));
  const sys = desk.byKey && desk.byKey[page.system];
  const cam = page.system === 'ptz' ? selectedCamera(sys) : null;
  const device = !sys ? null : cam
    ? { cam: cam.id, name: cam.name || cam.id, host: cam.host || '', port: cam.port == null ? 80 : cam.port }
    : { host: sys.host || '', port: sys.port == null ? null : sys.port, name: sys.short || sys.label || page.system };
  page.device = device;
  for (const key of page.keys) {
    key.device = device;
    if (key.action && cam) {
      key.action.body = { ...(key.action.body || {}), cam: cam.id };
      key.caption = cam.name || cam.id;
    }
  }
  return page;
}

function stackWarnings(pageIds, pages) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const have = new Set(pageIds);
  const warnings = [];
  for (const id of pageIds) {
    const page = byId.get(id);
    if (!page) {
      warnings.push({ pageId: id, jump: null, message: `Unknown page "${id}"` });
      continue;
    }
    for (const target of page.jumps || []) {
      if (!have.has(target)) {
        const name = (byId.get(target) && byId.get(target).title) || target;
        warnings.push({ pageId: id, jump: target, message: `${page.title} jumps to ${name}, which is not on this deck` });
      }
    }
  }
  return warnings;
}

function moveItem(list, from, to) {
  const next = list.slice();
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

module.exports = { libraryFor, catalogIds, stampPage, stackWarnings, moveItem, pack, linkPages };
