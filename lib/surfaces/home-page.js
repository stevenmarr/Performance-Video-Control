'use strict';
// Stream Deck + XL HOME page (designer Phase D, Q10). Follows the four-zone
// grammar. Other deck sizes keep the packed HOME in lib/decks/faces.js.

const NAMES = {
  rs6: 'RS6', e2: 'E2', pixelhue: 'PIXELHUE', atem: 'ATEM', ptz: 'PTZ',
  pixera: 'PIXERA', millumin: 'MILLUMIN', videohub: 'VIDEOHUB',
  hyperdeck: 'HYPERDECK', mitti: 'MITTI',
};
const TYPES = {
  rs6: 'hi-res', e2: 'hi-res', pixelhue: 'hi-res', atem: 'switcher', ptz: 'cameras',
  pixera: 'media', millumin: 'media', videohub: 'router', hyperdeck: 'deck', mitti: 'media',
};

function family(id) {
  const s = String(id || '');
  if (NAMES[s]) return s;
  const head = s.split('-')[0];
  return NAMES[head] ? head : '';
}

function nameOf(id, desk) {
  if (NAMES[id]) return NAMES[id];
  const info = desk && desk.byKey && desk.byKey[id];
  const raw = (info && (info.short || info.label)) || id;
  return String(raw || '').slice(0, 11).toUpperCase();
}

function typeOf(id, desk) {
  const kind = family(id);
  if (TYPES[kind]) return TYPES[kind];
  const info = desk && desk.byKey && desk.byKey[id];
  return String((info && info.family) || kind || '').slice(0, 11).toLowerCase();
}

function isLive(id, desk) {
  const info = desk && desk.byKey && desk.byKey[id];
  if (info && (info.onProgram || info.tally === 'pgm' || info.live)) return true;
  const cams = (info && info.cameras) || [];
  return cams.some((c) => c && (c.tally || c.tallyRed || c.onProgram));
}

function blank(row, col) {
  return { row, col, label: '', caption: '', tone: 'blank', nav: null, action: null };
}

function put(grid, row, col, key) {
  const i = grid.findIndex((k) => k.row === row && k.col === col);
  if (i >= 0) grid[i] = { ...grid[i], ...key, row, col };
}

function navColumn() {
  return [
    { row: 0, col: 0, label: 'HOME', caption: 'THIS PAGE', tone: 'os', nav: null, action: null, on: true, role: 'home' },
    { row: 1, col: 0, label: 'SYSTEM', caption: 'HOLD=HELP', tone: 'os', nav: 'chooser', action: null, role: 'system-menu', hold: 'helpMode' },
    { row: 2, col: 0, label: '◀ PAGE', caption: '', tone: 'os', nav: 'page', action: null, role: 'page-prev' },
    { row: 3, col: 0, label: 'PAGE ▶', caption: '', tone: 'os', nav: 'page', action: null, role: 'page-next' },
  ];
}

function statusColumn(desk, alerts) {
  const live = !!(desk && (desk.onProgram || (Array.isArray(desk.armed) && desk.armed.some((id) => isLive(id, desk)))));
  const n = Number(alerts) || (desk && Number(desk.alerts)) || 0;
  return [
    { row: 0, col: 8, label: 'ON AIR', caption: live ? 'LIVE' : 'off', tone: live ? 'stop' : 'os', nav: null, action: null, role: 'onair' },
    { row: 1, col: 8, label: 'LOCK', caption: (desk && desk.locked) ? 'ON' : 'off', tone: 'os', nav: null, action: null, role: 'lock' },
    { row: 2, col: 8, label: 'LINK', caption: (desk && desk.link === 'bad') ? 'ERR' : 'OK', tone: 'os', nav: null, action: null, role: 'link' },
    { row: 3, col: 8, label: 'ALERTS', caption: n ? String(n) : 'none', tone: 'os', nav: 'selftest', action: null, role: 'alerts' },
  ];
}

function functionKeys() {
  return [
    { row: 1, col: 1, label: 'CUES', caption: 'STACK', tone: 'go', nav: 'cues', action: null, role: 'cues' },
    { row: 1, col: 2, label: 'PRESETS', caption: 'HI-RES', tone: 'memory', nav: 'looks', action: null, role: 'looks' },
    { row: 1, col: 3, label: 'CONSOLE', caption: 'OS', tone: 'os', nav: 'console', system: 'console', action: null, role: 'console' },
    { row: 1, col: 4, label: 'SELF-TEST', caption: '', tone: 'os', nav: 'selftest', action: null, role: 'selftest' },
  ];
}

// TARGET row holds up to 7 systems (cols 1–7). Overflow goes to the next HOME page.
const TARGET_SLOTS = 7;

function homePages(surface, armed, desk = {}) {
  const cols = surface && surface.cols;
  const rows = surface && surface.rows;
  if (surface.id !== 'plusxl' && !(cols === 9 && rows === 4)) {
    throw Object.assign(new Error('HOME drawing is for the Stream Deck + XL only'), { status: 400 });
  }
  const list = (armed || []).filter((id) => id && id !== 'console');
  const pageCount = Math.max(1, Math.ceil(Math.max(list.length, 1) / TARGET_SLOTS));
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const grid = [];
    for (let row = 0; row < 4; row++) for (let col = 0; col < 9; col++) grid.push(blank(row, col));
    navColumn().forEach((k) => {
      const key = { ...k };
      if (k.role === 'page-prev') key.page = (p + pageCount - 1) % pageCount;
      if (k.role === 'page-next') key.page = (p + 1) % pageCount;
      put(grid, k.row, k.col, key);
    });
    statusColumn(desk).forEach((k) => put(grid, k.row, k.col, k));
    functionKeys().forEach((k) => put(grid, k.row, k.col, k));
    list.slice(p * TARGET_SLOTS, (p + 1) * TARGET_SLOTS).forEach((id, i) => {
      const col = 1 + i;
      const live = isLive(id, desk);
      put(grid, 0, col, {
        label: nameOf(id, desk),
        caption: typeOf(id, desk),
        tone: live ? 'stop' : 'home',
        nav: 'system',
        system: id,
        action: null,
        role: 'target',
        live,
      });
    });
    pages.push({
      id: 'home',
      title: 'HOME',
      designId: 'core-home',
      system: null,
      page: p,
      pages: pageCount,
      dials: [],
      keys: grid,
    });
  }
  return pages;
}

function homeFace(surface, armed, desk, session) {
  const pages = homePages(surface, armed, desk);
  const page = Math.max(0, Math.min(pages.length - 1, Number(session && session.page) || 0));
  return pages[page];
}

module.exports = { homePages, homeFace, TARGET_SLOTS, NAMES, family, nameOf, isLive };

// Page Builder hook (Phase B). core.home is the dynamic four-zone HOME for the + XL.
// auto-generate fills TARGET from the desk in order; function and status keys stay put.
const CORE_HOME = {
  id: 'core.home',
  title: 'HOME',
  surface: 'plusxl',
  generate: homePages,
};
module.exports.CORE_HOME = CORE_HOME;
