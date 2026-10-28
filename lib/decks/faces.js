'use strict';
// What a Stream Deck shows. Home is a row of systems.
// A wide deck is a console, not a list:
//   left  — Home and the stick
//   middle — the lens
//   right — a number pad
//   top-right — the other page, by name
// A small deck is one job per page. The corner key is the name of the next job.
//
// Preset keys are memories, not macros. Recall loads the stored look onto
// preview. Take commits it.

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

function placeCameras(grid, surface, desk, startCol, endCol) {
  const { cameras, selected } = cameraList(desk);
  const end = endCol == null ? surface.cols : endCol;
  let n = 0;
  for (const cam of cameras) {
    const col = startCol + n;
    if (col >= end) break;
    at(grid, surface, col, 0, camKey(cam, selected));
    n += 1;
  }
  return n;
}

function ptzPreset(n) {
  return { label: String(n), caption: 'PRESET', tone: 'memory', action: post('/api/sys/ptz/cmd/recall', { preset: n, guarded: true }) };
}

function move(label, pan, tilt) {
  return { label, caption: 'MOVE', tone: 'go', hold: 'pt', action: post('/api/sys/ptz/cmd/move', { pan, tilt }) };
}

function lens(label, caption, dir, hold) {
  const path = hold === 'focus' ? '/api/sys/ptz/cmd/focus' : '/api/sys/ptz/cmd/zoom';
  return { label, caption, tone: 'go', hold, action: post(path, { dir }) };
}

function opKey(label, op, caption) {
  const stepped = ['gain', 'shutterStep', 'ndFilter', 'wbMode', 'dExtender'].includes(op);
  return {
    label, caption: caption || 'FUNC', tone: 'func', op,
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

function rangeLabel(items) {
  if (!items.length) return 'PAGE';
  if (items.length === 1) return items[0].label;
  return `${items[0].label}–${items[items.length - 1].label}`;
}

// Wide live page. The stick is a cross on the left, the lens is beside it,
// and presets are a block on the right. FUNC is the top-right key.
function ptzLive(surface, desk) {
  const grid = blankGrid(surface);
  const cols = surface.cols;
  const pad = 5;
  at(grid, surface, 0, 0, homeKey());
  at(grid, surface, 2, 0, opKey('AWB', 'awb', 'COLOR'));
  placeCameras(grid, surface, desk, 3, cols - 1);
  at(grid, surface, 1, 1, move('UP', 0, 1));
  at(grid, surface, 0, 2, move('LEFT', -1, 0));
  at(grid, surface, 1, 2, { label: 'STOP', caption: 'PTZ', tone: 'stop', action: post('/api/sys/ptz/cmd/stopAll', {}) });
  at(grid, surface, 2, 2, move('RIGHT', 1, 0));
  at(grid, surface, 1, 3, move('DOWN', 0, -1));
  at(grid, surface, 3, 1, lens('TELE', 'ZOOM', 1, 'zoom'));
  at(grid, surface, 4, 1, lens('WIDE', 'ZOOM', -1, 'zoom'));
  at(grid, surface, 3, 2, lens('FAR', 'FOCUS', 1, 'focus'));
  at(grid, surface, 4, 2, lens('NEAR', 'FOCUS', -1, 'focus'));
  at(grid, surface, 3, 3, opKey('IRIS', 'irisMode', 'LENS'));
  at(grid, surface, 4, 3, opKey('AF', 'oneTouchAF', 'LENS'));
  const presets = (cols - pad) * 3;
  for (let n = 1; n <= presets; n++) {
    const i = n - 1;
    at(grid, surface, pad + (i % (cols - pad)), 1 + Math.floor(i / (cols - pad)), ptzPreset(n));
  }
  at(grid, surface, cols - 1, 0, { label: 'FUNC', caption: 'PAGE', tone: 'nav', nav: 'page', page: 1 });
  return grid;
}

// Banks, not a wrap. Cameras stay on the top row so the camera does not change page.
function ptzFunc(surface, desk) {
  const grid = blankGrid(surface);
  at(grid, surface, 0, 0, homeKey());
  placeCameras(grid, surface, desk, 1, surface.cols - 1);
  const banks = [
    [opKey('GAIN', 'gain', 'EXPOSURE'), opKey('SHUTR', 'shutterStep', 'EXPOSURE'), opKey('ND', 'ndFilter', 'EXPOSURE'), opKey('IRIS', 'irisMode', 'EXPOSURE')],
    [opKey('WB', 'wbMode', 'COLOR'), opKey('AWB', 'awb', 'COLOR'), opKey('ABB', 'abb', 'COLOR'), opKey('BARS', 'colorBars', 'COLOR')],
    [opKey('DETAIL', 'detail', 'IMAGE'), opKey('OIS', 'ois', 'IMAGE'), opKey('NIGHT', 'dayNight', 'IMAGE'), opKey('D.EXT', 'dExtender', 'IMAGE'), opKey('TALLY', 'tallyRed', 'IMAGE'), opKey('POWER', 'power', 'IMAGE')],
  ];
  banks.forEach((row, r) => {
    row.forEach((item, c) => at(grid, surface, c, r + 1, item));
  });
  at(grid, surface, surface.cols - 1, 0, { label: 'LIVE', caption: 'PAGE', tone: 'nav', nav: 'page', page: 0 });
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
      const label = next.name === part.name ? rangeLabel(next.items) : next.name;
      grid[corner.row * surface.cols + corner.col] = pageKey(corner, label, (p + 1) % chunks.length);
    }
    return grid;
  });
}

function smallPtz(surface, desk) {
  const { cameras, selected } = cameraList(desk);
  const camItems = cameras.length ? cameras.map((cam) => camKey(cam, selected)) : [{ label: 'NONE', caption: 'NO CAM', tone: 'func' }];
  return groupPages(surface, [
    { name: 'CAMS', items: camItems },
    {
      name: 'MOVE',
      items: [
        move('UP', 0, 1),
        lens('WIDE', 'ZOOM', -1, 'zoom'),
        lens('TELE', 'ZOOM', 1, 'zoom'),
        move('LEFT', -1, 0),
        move('DOWN', 0, -1),
        move('RIGHT', 1, 0),
      ],
    },
    { name: 'PRESET', items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(ptzPreset) },
    {
      name: 'FUNC',
      items: [
        opKey('IRIS', 'irisMode', 'LENS'), opKey('AF', 'oneTouchAF', 'LENS'), opKey('AWB', 'awb', 'COLOR'),
        opKey('GAIN', 'gain', 'EXPOSURE'), opKey('SHUTR', 'shutterStep', 'EXPOSURE'), opKey('BARS', 'colorBars', 'COLOR'),
      ],
    },
  ]);
}

function ptzPages(surface, desk) {
  if (surface.cols >= 8 && surface.rows >= 4) return [ptzLive(surface, desk), ptzFunc(surface, desk)];
  return smallPtz(surface, desk);
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
      grid[corner.row * surface.cols + corner.col] = pageKey(corner, rangeLabel(ahead), np);
    }
    pages.push(grid);
  }
  return pages;
}

// Left rail stays put. The number pad is only the columns to its right,
// so memory 1 is never underneath Home.
function railPages(surface, rail, items) {
  if (surface.cols < 6) {
    return fillPinned(surface, rail.map((item, i) => ({ ...item, col: i, row: 0 })), items);
  }
  const railW = Math.min(3, rail.length, surface.cols - 2);
  const padW = surface.cols - railW;
  const per = padW * surface.rows;
  const pageCount = Math.max(1, Math.ceil(items.length / per));
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const grid = blankGrid(surface);
    rail.forEach((item, i) => { if (i < railW) at(grid, surface, i, 0, item); });
    const slice = items.slice(p * per, (p + 1) * per);
    slice.forEach((item, i) => at(grid, surface, railW + (i % padW), Math.floor(i / padW), item));
    if (pageCount > 1) {
      const np = (p + 1) % pageCount;
      const ahead = items.slice(np * per, (np + 1) * per);
      const slot = { col: 0, row: surface.rows - 1 };
      grid[slot.row * surface.cols] = pageKey(slot, rangeLabel(ahead), np);
    }
    pages.push(grid);
  }
  return pages;
}

function switcherPages(surface, system) {
  const rail = [homeKey(), takeKey(system), cutKey(system)];
  const memories = [];
  for (let n = 1; n <= 24; n++) memories.push(recallKey(system, n));
  if (surface.cols < 3) return fillPinned(surface, [{ ...homeKey(), col: 0, row: 0 }], [takeKey(system), cutKey(system), ...memories]);
  return railPages(surface, rail, memories);
}

function fallbackAtem() {
  const bus = [];
  for (let n = 1; n <= 8; n++) bus.push({ id: n, long: `Input ${n}`, short: String(n), pgm: false, pvw: false });
  bus.push({ id: 0, long: 'Black', short: 'Blk', pgm: false, pvw: false });
  bus.push({ id: 1000, long: 'Color Bars', short: 'Bars', pgm: false, pvw: false });
  bus.push({ id: 6000, long: 'Super Source', short: 'SSrc', pgm: false, pvw: false });
  return {
    mes: [{ index: 0, program: null, preview: null, bus }],
    outputs: [0, 1, 2, 3].map((i) => ({ key: `aux:${i}`, label: `Aux ${i + 1}`, source: null, sourceName: '', accepts: 'aux' })),
    auxSources: bus.map((s) => ({ id: s.id, long: s.long, short: s.short })),
  };
}

function atemViewOf(desk) {
  const raw = desk && desk.byKey && desk.byKey.atem && desk.byKey.atem.view;
  if (!raw || !raw.mes || !raw.mes.length) return fallbackAtem();
  return raw;
}

function withSuperSource(bus, me, view) {
  const have = new Set((bus || []).map((s) => s.id));
  const out = (bus || []).slice();
  const extras = (view.sources || []).filter((s) => s.id >= 6000 && s.id < 7000 && !have.has(s.id));
  if (!extras.length && !out.some((s) => s.id >= 6000 && s.id < 7000)) {
    out.push({ id: 6000, long: 'Super Source', short: 'SSrc', pgm: me && me.program === 6000, pvw: me && me.preview === 6000 });
  }
  for (const s of extras) out.push({ id: s.id, long: s.long || 'Super Source', short: s.short || 'SSrc', pgm: !!(me && me.program === s.id), pvw: !!(me && me.preview === s.id) });
  return out;
}

function sourceKey(src, meNumber, output) {
  const pgm = !!src.pgm;
  const pvw = !!src.pvw;
  const name = src.long || src.short || String(src.id);
  if (output) {
    const on = src.id === output.source;
    return {
      label: name,
      caption: on ? 'ON' : '',
      tone: on ? 'pvw' : 'func',
      action: post('/api/sys/atem/cmd/route', { output: output.key, source: src.id }),
    };
  }
  return {
    label: name,
    caption: pgm ? 'PGM' : (pvw ? 'PVW' : ''),
    tone: pgm ? 'stop' : (pvw ? 'pvw' : 'func'),
    ring: pgm && pvw,
    action: post('/api/sys/atem/cmd/preview', { source: src.id, me: meNumber }),
  };
}

function chooseNav(items, room) {
  if (items.length <= room) return items;
  const home = items[0];
  const rest = items.slice(1);
  const active = rest.find((item) => item.on) || rest[0];
  const picked = new Set([home, active]);
  for (const item of rest) {
    if (picked.size >= room) break;
    picked.add(item);
  }
  if (room < 2) return [active];
  return items.filter((item) => picked.has(item)).slice(0, room);
}

function atemPages(surface, desk, session) {
  const view = atemViewOf(desk);
  const cols = surface.cols;
  const rows = surface.rows;
  const meCount = Math.max(1, view.mes.length);
  const sections = [];
  for (let i = 0; i < meCount; i++) sections.push({ id: `me${i}`, label: `ME${i + 1}`, kind: 'me', me: i });
  sections.push({ id: 'route', label: 'ROUTE', kind: 'route' });
  const navRoom = Math.max(1, cols - 2);
  const reserved = new Set();
  for (let col = 0; col < navRoom; col++) reserved.add(`${col},0`);
  reserved.add(`${cols - 2},0`);
  reserved.add(`${cols - 1},0`);
  const body = slots(surface).filter((slot) => !reserved.has(`${slot.col},${slot.row}`));
  const size = Math.max(1, body.length);
  const outputs = (view.outputs || []).filter((o) => !o.accepts || o.accepts === 'aux' || o.routable);
  const routeOut = outputs.length ? outputs : fallbackAtem().outputs;
  const outKey = session && session.out;
  const picked = outKey ? routeOut.find((o) => o.key === outKey) : null;
  const chunks = [];
  for (const sec of sections) {
    let items = [];
    if (sec.kind === 'me') {
      const me = view.mes[sec.me] || { bus: [] };
      items = withSuperSource(me.bus, me, view).map((src) => sourceKey(src, sec.me + 1));
    } else if (picked) {
      const pool = (view.auxSources && view.auxSources.length) ? view.auxSources : withSuperSource((view.mes[0] || {}).bus, view.mes[0], view);
      items = [{ label: 'OUTPUTS', caption: 'BACK', tone: 'nav', nav: 'page', page: -1, clearOut: true }];
      items.push(...pool.map((src) => sourceKey({ ...src, id: src.id, long: src.long || src.short }, 1, picked)));
    } else {
      items = routeOut.map((o) => ({ label: o.sourceName || 'NONE', caption: o.label || o.key, tone: 'func', pick: o.key, page: -2 }));
    }
    const pages = Math.max(1, Math.ceil(items.length / size));
    for (let p = 0; p < pages; p++) chunks.push({ sec, items: items.slice(p * size, (p + 1) * size) });
  }
  const firstOf = (id) => chunks.findIndex((c) => c.sec.id === id);
  return chunks.map((chunk, index) => {
    const grid = blankGrid(surface);
    const meNumber = chunk.sec.kind === 'me' ? chunk.sec.me + 1 : 1;
    const nav = chooseNav([
      homeKey(),
      ...sections.map((sec) => ({
        label: sec.label,
        caption: sec.kind === 'route' && picked ? (picked.label || 'OUT') : 'PAGE',
        tone: 'nav',
        on: sec.id === chunk.sec.id,
        nav: 'page',
        page: firstOf(sec.id),
        clearOut: true,
      })),
    ], navRoom);
    nav.forEach((item, i) => at(grid, surface, i, 0, item));
    at(grid, surface, cols - 2, 0, { label: 'CUT', caption: `ME${meNumber}`, tone: 'stop', action: post('/api/sys/atem/cmd/cut', { me: meNumber }) });
    at(grid, surface, cols - 1, 0, { label: 'AUTO', caption: `ME${meNumber}`, tone: 'stop', action: post('/api/sys/atem/cmd/auto', { me: meNumber }) });
    chunk.items.forEach((item, i) => {
      const slot = body[i];
      const page = item.page === -1 ? index : item.page === -2 ? firstOf('route') : item.page;
      grid[slot.row * cols + slot.col] = { ...item, page, row: slot.row, col: slot.col };
    });
    return grid;
  });
}

function pagesFor(surface, system, desk, session) {
  if (system === 'ptz') return ptzPages(surface, desk);
  if (system === 'rs6' || system === 'e2' || system === 'pixelhue') return switcherPages(surface, system);
  if (system === 'atem') return atemPages(surface, desk, session);
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
        row: slot.row, col: slot.col, label: nameOf(id), caption: 'OPEN', tone: 'home', nav: 'system', system: id, action: null,
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
  const packed = pagesFor(surface, system, desk, session);
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
