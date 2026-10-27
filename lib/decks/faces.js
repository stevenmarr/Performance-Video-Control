'use strict';
// What a Stream Deck shows. Home picks one system. That system's pages then fill
// the deck. A smaller deck gets more pages; a + XL gets fewer, fuller pages.
// Every system page has Home in the top left.
//
// Preset keys are memories, not macros. A Ross memory replaces the ME with the
// stored state (keys on or off as stored). A custom control only runs a sequence
// and can leave a key the wrong way. Recall here loads the stored look onto
// preview. Take commits it.

const NAMES = { rs6: 'RS6', e2: 'E2', pixelhue: 'PIXELHUE', atem: 'ATEM', ptz: 'PTZ', pixera: 'PIXERA', millumin: 'MILLUMIN' };

const post = (path, body) => ({ method: 'POST', path, body: body || {} });

const PTZ_DIALS = [
  { op: 'iris', kind: 'step', label: 'IRIS' },
  { op: 'masterPed', kind: 'step', label: 'PED' },
  { op: 'gain', kind: 'step', label: 'GAIN' },
  { op: 'shutterStep', kind: 'step', label: 'SHUT' },
  { op: 'zoom', kind: 'zoom', label: 'ZOOM' },
  { op: 'focus', kind: 'focus', label: 'FOCUS' },
];

function nameOf(id) {
  return NAMES[id] || String(id || '').toUpperCase();
}

function ptzControls() {
  const controls = [];
  for (let n = 1; n <= 8; n++) controls.push({ label: `CAM ${n}`, caption: 'SELECT', tone: 'go', action: post('/api/sys/ptz/cmd/select', { slot: n }) });
  for (let n = 1; n <= 12; n++) controls.push({ label: String(n), caption: 'PRESET', tone: 'memory', action: post('/api/sys/ptz/cmd/recall', { preset: n, guarded: true }) });
  const move = [
    ['UP', { pan: 0, tilt: 1 }], ['LEFT', { pan: -1, tilt: 0 }], ['DOWN', { pan: 0, tilt: -1 }], ['RIGHT', { pan: 1, tilt: 0 }],
  ];
  for (const [label, body] of move) controls.push({ label, caption: 'MOVE', tone: 'go', action: post('/api/sys/ptz/cmd/move', body) });
  controls.push({ label: 'TELE', caption: 'ZOOM', tone: 'go', action: post('/api/sys/ptz/cmd/zoom', { dir: 1 }) });
  controls.push({ label: 'WIDE', caption: 'ZOOM', tone: 'go', action: post('/api/sys/ptz/cmd/zoom', { dir: -1 }) });
  controls.push({ label: 'FAR', caption: 'FOCUS', tone: 'go', action: post('/api/sys/ptz/cmd/focus', { dir: 1 }) });
  controls.push({ label: 'NEAR', caption: 'FOCUS', tone: 'go', action: post('/api/sys/ptz/cmd/focus', { dir: -1 }) });
  controls.push({ label: 'STOP', caption: 'PTZ', tone: 'stop', action: post('/api/sys/ptz/cmd/stopAll', {}) });
  const ops = [
    ['IRIS', 'irisMode'], ['AWB', 'awb'], ['ABB', 'abb'], ['AF', 'oneTouchAF'],
    ['GAIN', 'gain'], ['SHUTR', 'shutterStep'], ['ND', 'ndFilter'], ['WB', 'wbMode'],
    ['DETAIL', 'detail'], ['BARS', 'colorBars'], ['TALLY', 'tallyRed'], ['POWER', 'power'],
    ['OIS', 'ois'], ['NIGHT', 'dayNight'], ['D.EXT', 'dExtender'], ['GUARD', 'guard'],
  ];
  for (const [label, op] of ops) {
    const stepped = ['gain', 'shutterStep', 'ndFilter', 'wbMode', 'dExtender'].includes(op);
    controls.push({
      label, caption: 'FUNC', tone: 'func',
      action: stepped ? post('/api/sys/ptz/cmd/step', { op, steps: 1 }) : post('/api/sys/ptz/cmd/op', { op }),
    });
  }
  return controls;
}

function memory(system, n) {
  if (system === 'rs6') return post(`/api/presets/${n}/recall`, {});
  return post(`/api/sys/${system}/presets/${n}/recall`, { target: 'preview' });
}

function presetControls(system) {
  const controls = [
    { label: 'TAKE', caption: 'PGM', tone: 'stop', action: system === 'rs6' ? post('/api/take', {}) : post(`/api/sys/${system}/take`, {}) },
    { label: 'CUT', caption: 'PGM', tone: 'stop', action: system === 'rs6' ? post('/api/cut', {}) : post(`/api/sys/${system}/cut`, {}) },
  ];
  for (let n = 1; n <= 16; n++) controls.push({ label: String(n), caption: 'MEMORY', tone: 'memory', absolute: true, action: memory(system, n) });
  return controls;
}

function atemControls() {
  const controls = [
    { label: 'CUT', caption: 'PGM', tone: 'stop', action: post('/api/sys/atem/cmd/cut', {}) },
    { label: 'AUTO', caption: 'PGM', tone: 'stop', action: post('/api/sys/atem/cmd/auto', {}) },
  ];
  for (let n = 1; n <= 12; n++) controls.push({ label: String(n), caption: 'PGM', tone: 'go', action: post('/api/sys/atem/cmd/program', { source: n }) });
  return controls;
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

function controlsFor(system) {
  if (system === 'ptz') return ptzControls();
  if (system === 'rs6' || system === 'e2' || system === 'pixelhue') return presetControls(system);
  if (system === 'atem') return atemControls();
  if (system === 'pixera' || system === 'millumin') return mediaControls(system);
  return [];
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

function pack(surface, controls) {
  const cells = slots(surface);
  const home = cells[0];
  const rest = cells.slice(1);
  const one = controls.length <= rest.length;
  const room = one ? rest.length : Math.max(1, rest.length - 2);
  const pageCount = Math.max(1, Math.ceil(controls.length / room) || 1);
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const by = new Map();
    by.set('0,0', { row: 0, col: 0, label: 'HOME', caption: 'BACK', tone: 'home', nav: 'home', action: null });
    const slice = controls.slice(p * room, (p + 1) * room);
    slice.forEach((ctrl, i) => {
      const slot = rest[i];
      by.set(`${slot.col},${slot.row}`, { row: slot.row, col: slot.col, nav: null, ...ctrl });
    });
    if (!one) {
      const prev = rest[rest.length - 2];
      const next = rest[rest.length - 1];
      by.set(`${prev.col},${prev.row}`, { row: prev.row, col: prev.col, label: 'PREV', caption: `${p + 1}/${pageCount}`, tone: 'nav', nav: 'page', page: (p - 1 + pageCount) % pageCount, action: null });
      by.set(`${next.col},${next.row}`, { row: next.row, col: next.col, label: 'NEXT', caption: `${p + 1}/${pageCount}`, tone: 'nav', nav: 'page', page: (p + 1) % pageCount, action: null });
    }
    pages.push(cells.map((slot) => by.get(`${slot.col},${slot.row}`) || blank(slot)));
  }
  return pages;
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
      by.set(`${next.col},${next.row}`, { row: next.row, col: next.col, label: 'NEXT', caption: 'HOME', tone: 'nav', nav: 'page', page: (p + 1) % pageCount, action: null });
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
    return { id: 'home', title: 'HOME', system: null, page, pages: pages.length, dials: [], keys: pages[page] };
  }
  const packed = pack(surface, controlsFor(system));
  const page = Math.max(0, Math.min(packed.length - 1, Number(session.page) || 0));
  const dials = system === 'ptz' ? PTZ_DIALS.slice(0, (surface.knobCols || []).length) : [];
  return { id: system, title: nameOf(system), system, page, pages: packed.length, dials, keys: packed[page] };
}

module.exports = { show, controlsFor, pack, nameOf, NAMES, PTZ_DIALS };
