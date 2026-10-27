'use strict';
// What a Stream Deck shows. Home picks one system.
// A wide deck keeps the live controls in one place: cameras across the top,
// the stick on the left, memories as a number pad, Take and Cut beside Home.
// A small deck is one job per page. The corner key is the name of the next
// page, not PREV or NEXT.
//
// Preset keys are memories, not macros. Recall loads the stored look onto
// preview, including whether a keyer was on or off. Take commits it.

const NAMES = { rs6: 'RS6', e2: 'E2', pixelhue: 'PIXELHUE', atem: 'ATEM', ptz: 'PTZ', pixera: 'PIXERA', millumin: 'MILLUMIN' };

const post = (path, body) => ({ method: 'POST', path, body: body || {} });

const PTZ_DIALS = [
  { widget: 'iris', label: 'IRIS' },
  { widget: 'masterPed', label: 'M.PED' },
  { widget: 'gainRb', label: 'GAIN' },
  { widget: 'pedRb', label: 'PED' },
  { widget: 'zoom', label: 'ZOOM' },
  { widget: 'focus', label: 'FOCUS' },
];

function nameOf(id) {
  return NAMES[id] || String(id || '').toUpperCase();
}

function memory(system, n) {
  if (system === 'rs6') return post(`/api/presets/${n}/recall`, {});
  return post(`/api/sys/${system}/presets/${n}/recall`, { target: 'preview' });
}

function mediaControls(system) {
  if (system === 'pixera') {
    return [
      { label: 'PLAY', caption: 'PIXERA', tone: 'go', action: post('/api/sys/pixera/cmd/transport', { mode: 'play' }) },
      { label: 'PAUSE', caption: 'PIXERA', tone: 'func', action: post('/api/sys/pixera/cmd/transport', { mode: 'pause' }) },
      { label: 'STOP', caption: 'PIXERA', tone: 'stop', action: post('/api/sys/pixera/cmd/transport', { mode: 'stop' }) },
      { label: 'NEXT', caption: 'CUE', tone: 'go', action: post('/api/sys/pixera/cmd/nextCue', {}) },
    ];
  }
  return [
    { label: 'PLAY', caption: 'MILLUMIN', tone: 'go', action: post('/api/sys/millumin/cmd/play', {}) },
    { label: 'PAUSE', caption: 'MILLUMIN', tone: 'func', action: post('/api/sys/millumin/cmd/pause', {}) },
    { label: 'COL 1', caption: 'COLUMN', tone: 'memory', action: post('/api/sys/millumin/cmd/column', { value: 1 }) },
    { label: 'COL 2', caption: 'COLUMN', tone: 'memory', action: post('/api/sys/millumin/cmd/column', { value: 2 }) },
  ];
}

function slots(surface) {
  const out = [];
  for (let row = 0; row < surface.rows; row++) {
    for (let col = 0; col < surface.cols; col++) out.push({ row, col });
  }
  return out;
}

function blank(slot) {
  return { row: slot.row, col: slot.col, label: '', caption: '', tone: 'blank', nav: null, action: null };
}

function homeKey() {
  return { label: 'HOME', caption: 'BACK', tone: 'home', nav: 'home', action: null };
}

function camKey(cam, selected) {
  const on = !!cam && cam.id === selected;
  return {
    label: String((cam && cam.name) || 'CAM').slice(0, 10),
    caption: on ? 'ON' : 'CAM',
    tone: 'go',
    on,
    ring: on,
    cam: cam && cam.id,
    action: cam && cam.id ? post('/api/sys/ptz/cmd/select', { cam: cam.id }) : null,
  };
}

function cameraList(desk) {
  const sys = desk && desk.byKey && desk.byKey.ptz;
  return { cameras: (sys && sys.cameras) || [], selected: sys && sys.selected };
}

function placeCameras(grid, surface, desk) {
  const { cameras, selected } = cameraList(desk);
  const room = Math.max(0, surface.cols - 1);
  cameras.slice(0, room).forEach((cam, i) => at(grid, surface, i + 1, 0, camKey(cam, selected)));
  return cameras.length;
}

function ptzPreset(n) {
  return { label: String(n), caption: 'PRESET', tone: 'memory', action: post('/api/sys/ptz/cmd/recall', { preset: n, guarded: true }) };
}

function move(label, pan, tilt) {
  return { label, caption: 'MOVE', tone: 'go', hold: 'pt', action: post('/api/sys/ptz/cmd/move', { pan, tilt }) };
}

function opKey(label, op) {
  const stepped = ['gain', 'shutterStep', 'ndFilter', 'wbMode', 'dExtender'].includes(op);
  return {
    label, caption: 'FUNC', tone: 'func', op,
    action: stepped ? post('/api/sys/ptz/cmd/step', { op, steps: 1 }) : post('/api/sys/ptz/cmd/op', { op }),
  };
}

function recallKey(system, n) {
  return { label: String(n), caption: 'MEMORY', tone: 'memory', absolute: true, action: memory(system, n) };
}

function takeKey(system) {
  return { label: 'TAKE', caption: 'PGM', tone: 'stop', action: system === 'rs6' ? post('/api/take', {}) : post(`/api/sys/${system}/take`, {}) };
}

function cutKey(system) {
  return { label: 'CUT', caption: 'PGM', tone: 'stop', action: system === 'rs6' ? post('/api/cut', {}) : post(`/api/sys/${system}/cut`, {}) };
}

function at(grid, surface, col, row, ctrl) {
  if (col < 0 || row < 0 || col >= surface.cols || row >= surface.rows) return;
  grid[row * surface.cols + col] = { row, col, nav: null, action: null, tone: 'func', caption: '', ...ctrl };
}

function blankGrid(surface) {
  return slots(surface).map(blank);
}

function pageKey(slot, label, page) {
  return { row: slot.row, col: slot.col, label, caption: 'PAGE', tone: 'nav', nav: 'page', page, action: null };
}

// Wide decks: cameras across the top, stick on the left, presets on the right.
// FUNC is always the bottom-right key. LIVE brings that page back.
function ptzLive(surface, desk) {
  const grid = blankGrid(surface);
  const cols = surface.cols;
  at(grid, surface, 0, 0, homeKey());
  placeCameras(grid, surface, desk);
  const stick = 1;
  at(grid, surface, stick, 1, move('UP', 0, 1));
  at(grid, surface, stick - 1, 2, move('LEFT', -1, 0));
  at(grid, surface, stick, 2, { label: 'STOP', caption: 'PTZ', tone: 'stop', action: post('/api/sys/ptz/cmd/stopAll', {}) });
  at(grid, surface, stick + 1, 2, move('RIGHT', 1, 0));
  at(grid, surface, stick, 3, move('DOWN', 0, -1));
  const zoom = cols >= 9 ? 4 : 3;
  at(grid, surface, zoom, 1, { label: 'TELE', caption: 'ZOOM', tone: 'go', hold: 'zoom', action: post('/api/sys/ptz/cmd/zoom', { dir: 1 }) });
  at(grid, surface, zoom + 1, 1, { label: 'WIDE', caption: 'ZOOM', tone: 'go', hold: 'zoom', action: post('/api/sys/ptz/cmd/zoom', { dir: -1 }) });
  at(grid, surface, zoom, 2, { label: 'FAR', caption: 'FOCUS', tone: 'go', hold: 'focus', action: post('/api/sys/ptz/cmd/focus', { dir: 1 }) });
  at(grid, surface, zoom + 1, 2, { label: 'NEAR', caption: 'FOCUS', tone: 'go', hold: 'focus', action: post('/api/sys/ptz/cmd/focus', { dir: -1 }) });
  at(grid, surface, zoom, 3, opKey('IRIS', 'irisMode'));
  at(grid, surface, zoom + 1, 3, opKey('AF', 'oneTouchAF'));
  at(grid, surface, cols >= 9 ? 3 : 2, 3, opKey('AWB', 'awb'));
  const pad = cols - 3;
  const presets = cols >= 9 ? 8 : 6;
  for (let n = 1; n <= presets; n++) {
    const i = n - 1;
    at(grid, surface, pad + (i % 3), 1 + Math.floor(i / 3), ptzPreset(n));
  }
  at(grid, surface, cols - 1, surface.rows - 1, { label: 'FUNC', caption: 'PAGE', tone: 'nav', nav: 'page', page: 1 });
  return grid;
}

function ptzFunc(surface, desk) {
  const grid = blankGrid(surface);
  const funcs = [
    opKey('GAIN', 'gain'), opKey('SHUTR', 'shutterStep'), opKey('ND', 'ndFilter'), opKey('WB', 'wbMode'),
    opKey('DETAIL', 'detail'), opKey('BARS', 'colorBars'), opKey('TALLY', 'tallyRed'), opKey('POWER', 'power'),
    opKey('OIS', 'ois'), opKey('NIGHT', 'dayNight'), opKey('D.EXT', 'dExtender'), opKey('ABB', 'abb'),
  ];
  if (surface.cols < 9) funcs.unshift(opKey('AWB', 'awb'));
  const start = surface.cols >= 9 ? 9 : 7;
  const extra = [];
  for (let n = start; n <= 12; n++) extra.push(ptzPreset(n));
  const { cameras } = cameraList(desk);
  const wide = surface.cols >= 8 && surface.rows >= 4 && cameras.length;
  if (wide) placeCameras(grid, surface, desk);
  const free = slots(surface).filter((s) => {
    if (s.col === 0 && s.row === 0) return false;
    if (s.col === surface.cols - 1 && s.row === surface.rows - 1) return false;
    if (wide && s.row === 0) return false;
    return true;
  });
  at(grid, surface, 0, 0, homeKey());
  [...funcs, ...extra].slice(0, free.length).forEach((item, i) => {
    const slot = free[i];
    grid[slot.row * surface.cols + slot.col] = { ...item, row: slot.row, col: slot.col };
  });
  at(grid, surface, surface.cols - 1, surface.rows - 1, { label: 'LIVE', caption: 'PAGE', tone: 'nav', nav: 'page', page: 0 });
  return grid;
}

// One job per page. The corner key names the next job.
function groupPages(surface, groups) {
  const free = slots(surface).filter((s) => !(s.col === 0 && s.row === 0));
  const room = Math.max(1, free.length - 1);
  const body = free.slice(0, room);
  const corner = free[free.length - 1];
  const chunks = [];
  for (const group of groups) {
    for (let i = 0; i < group.items.length; i += room) chunks.push({ name: group.name, items: group.items.slice(i, i + room) });
  }
  if (!chunks.length) chunks.push({ name: 'LIVE', items: [] });
  return chunks.map((part, p) => {
    const grid = blankGrid(surface);
    grid[0] = { ...homeKey(), row: 0, col: 0 };
    part.items.forEach((item, i) => {
      const slot = body[i];
      if (!slot) return;
      grid[slot.row * surface.cols + slot.col] = { ...item, row: slot.row, col: slot.col };
    });
    if (chunks.length > 1) {
      const next = chunks[(p + 1) % chunks.length];
      const label = next.name === part.name && next.items[0] ? next.items[0].label : next.name;
      grid[corner.row * surface.cols + corner.col] = pageKey(corner, label, (p + 1) % chunks.length);
    }
    return grid;
  });
}

function ptzPages(surface, desk) {
  const cams = cameraList(desk).cameras;
  const camItems = cams.length ? cams.map((cam) => camKey(cam, cameraList(desk).selected)) : [{ label: 'NONE', caption: 'NO CAM', tone: 'func' }];
  if (surface.cols >= 8 && surface.rows >= 4) return [ptzLive(surface, desk), ptzFunc(surface, desk)];
  return groupPages(surface, [
    { name: 'CAMS', items: camItems },
    { name: 'MOVE', items: [move('UP', 0, 1), move('LEFT', -1, 0), move('DOWN', 0, -1), move('RIGHT', 1, 0), { label: 'STOP', caption: 'PTZ', tone: 'stop', action: post('/api/sys/ptz/cmd/stopAll', {}) }] },
    { name: 'PRESET', items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(ptzPreset) },
    { name: 'FUNC', items: [opKey('IRIS', 'irisMode'), opKey('AF', 'oneTouchAF'), opKey('AWB', 'awb'), opKey('GAIN', 'gain'), opKey('SHUTR', 'shutterStep'), opKey('BARS', 'colorBars')] },
  ]);
}

function fillPinned(surface, pinned, items) {
  const taken = new Set(pinned.map((p) => `${p.col},${p.row}`));
  const free = slots(surface).filter((s) => !taken.has(`${s.col},${s.row}`));
  const multi = items.length > free.length;
  const body = multi ? free.slice(0, -1) : free;
  const corner = multi ? free[free.length - 1] : null;
  const pageCount = Math.max(1, Math.ceil(items.length / Math.max(1, body.length)));
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const grid = blankGrid(surface);
    for (const pin of pinned) at(grid, surface, pin.col, pin.row, pin);
    const slice = items.slice(p * body.length, (p + 1) * body.length);
    slice.forEach((item, i) => {
      const slot = body[i];
      grid[slot.row * surface.cols + slot.col] = { ...item, row: slot.row, col: slot.col };
    });
    if (corner) {
      const np = (p + 1) % pageCount;
      const ahead = items.slice(np * body.length, (np + 1) * body.length);
      const label = ahead.length > 1 ? `${ahead[0].label}–${ahead[ahead.length - 1].label}` : (ahead[0] ? ahead[0].label : 'PAGE');
      grid[corner.row * surface.cols + corner.col] = pageKey(corner, label, np);
    }
    pages.push(grid);
  }
  return pages;
}

function switcherPages(surface, system) {
  const pinned = [{ ...homeKey(), col: 0, row: 0 }];
  if (surface.cols >= 3) {
    pinned.push({ ...takeKey(system), col: 1, row: 0 });
    pinned.push({ ...cutKey(system), col: 2, row: 0 });
  }
  const memories = [];
  for (let n = 1; n <= 16; n++) memories.push(recallKey(system, n));
  const items = surface.cols >= 3 ? memories : [takeKey(system), cutKey(system), ...memories];
  return fillPinned(surface, pinned, items);
}

function atemPages(surface) {
  const pinned = [
    { ...homeKey(), col: 0, row: 0 },
    { col: Math.min(1, surface.cols - 1), row: 0, label: 'CUT', caption: 'PGM', tone: 'stop', action: post('/api/sys/atem/cmd/cut', {}) },
  ];
  if (surface.cols >= 3) pinned.push({ col: 2, row: 0, label: 'AUTO', caption: 'PGM', tone: 'stop', action: post('/api/sys/atem/cmd/auto', {}) });
  const sources = [];
  for (let n = 1; n <= 12; n++) sources.push({ label: String(n), caption: 'PGM', tone: 'go', action: post('/api/sys/atem/cmd/program', { source: n }) });
  return fillPinned(surface, pinned, sources);
}

function pagesFor(surface, system, desk) {
  if (system === 'ptz') return ptzPages(surface, desk);
  if (system === 'rs6' || system === 'e2' || system === 'pixelhue') return switcherPages(surface, system);
  if (system === 'atem') return atemPages(surface);
  return fillPinned(surface, [{ ...homeKey(), col: 0, row: 0 }], mediaControls(system));
}

function dialsFor(surface) {
  const n = (surface.knobCols || []).length;
  if (!n) return [];
  if (n >= 6) return PTZ_DIALS.slice(0, 6);
  return [
    { widget: 'iris', label: 'IRIS' },
    { widget: 'zoom', label: 'ZOOM' },
    { widget: 'focus', label: 'FOCUS' },
    { widget: 'masterPed', label: 'M.PED' },
  ].slice(0, n);
}

function homePage(surface, armed) {
  const cells = slots(surface);
  const one = armed.length <= cells.length;
  const room = one ? cells.length : Math.max(1, cells.length - 1);
  const pageCount = Math.max(1, Math.ceil(armed.length / room) || 1);
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const by = new Map();
    armed.slice(p * room, (p + 1) * room).forEach((id, i) => {
      const slot = cells[i];
      by.set(`${slot.col},${slot.row}`, {
        row: slot.row, col: slot.col, label: nameOf(id), caption: 'DEVICE', tone: 'home', nav: 'system', system: id, action: null,
      });
    });
    if (!one) {
      const next = cells[cells.length - 1];
      const ahead = armed.slice(((p + 1) % pageCount) * room, ((p + 1) % pageCount) * room + room);
      by.set(`${next.col},${next.row}`, pageKey(next, nameOf(ahead[0]), (p + 1) % pageCount));
    }
    pages.push(cells.map((slot) => by.get(`${slot.col},${slot.row}`) || blank(slot)));
  }
  return pages;
}

function show(surface, desk = {}, session = {}) {
  const armed = (desk.armed || []).filter((id) => NAMES[id]);
  const system = session.system && armed.includes(session.system) ? session.system : null;
  if (!system) {
    const pages = homePage(surface, armed);
    const page = Math.max(0, Math.min(pages.length - 1, Number(session.page) || 0));
    return { id: 'home', title: 'HOME', system: null, page, pages: pages.length, dials: [], keys: pages[page] || [] };
  }
  const packed = pagesFor(surface, system, desk);
  const page = Math.max(0, Math.min(packed.length - 1, Number(session.page) || 0));
  const dials = system === 'ptz' ? dialsFor(surface) : [];
  return { id: system, title: nameOf(system), system, page, pages: packed.length, dials, keys: packed[page] || [] };
}

function applyReadouts(keys, snap) {
  const readouts = (snap && snap.readouts) || {};
  const cams = (snap && snap.cameras) || [];
  const selected = (snap && snap.selected) || (cams.find((c) => c.selected) || {}).id || null;
  return (keys || []).map((key) => {
    if (!key) return key;
    if (key.cam) {
      const cam = cams.find((c) => c.id === key.cam);
      const on = key.cam === selected;
      const live = !!(cam && cam.tally);
      return { ...key, on: on && !live, ring: on || live, caption: live ? 'PGM' : (on ? 'ON' : 'CAM'), tone: live ? 'stop' : key.tone };
    }
    if (!key.op) return key;
    const ro = readouts[key.op];
    if (!ro) return key;
    if (ro.on === true || ro.on === false) return { ...key, on: !!ro.on, caption: ro.on ? 'ON' : 'OFF' };
    if (ro.text && ro.text !== '—') return { ...key, caption: String(ro.text).slice(0, 10) };
    return key;
  });
}

module.exports = { show, nameOf, NAMES, PTZ_DIALS, applyReadouts };
