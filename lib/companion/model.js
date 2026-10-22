'use strict';
// 0.9.0 Companion export objects (file version 12, the format Companion's importer upgrades from).
// Only what generated pages need: linked module presets ("preset-reference"), navigation buttons with
// internal page actions, pages with the fork's surface layout, and the full export that carries them.
const crypto = require('crypto');
const BG = require('./styles');

const FILE_VERSION = 12;
const MODULE_ID = 'rs6-presets';
const TEXT_SIZE = '14'; // the module's one text size
const rgb = (r, g, b) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
const COLORS = { white: rgb(255, 255, 255), black: rgb(0, 0, 0), grey: rgb(40, 40, 40), red: rgb(200, 0, 0), darkred: rgb(70, 0, 0), amber: rgb(230, 150, 0), blue: rgb(30, 90, 200) };

// ids are random like Companion's own; `ids` lets tests make them repeatable
function idMaker(seed) {
  if (seed === undefined) return () => crypto.randomBytes(10).toString('hex');
  let n = 0; const s = String(seed);
  return () => crypto.createHash('sha1').update(`${s}:${n++}`).digest('hex').slice(0, 20);
}

const ev = (value) => ({ isExpression: false, value });
const opts = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, ev(v)]));

function action(ids, connectionId, definitionId, options) {
  return { type: 'action', id: ids(), definitionId, connectionId, options: opts(options), upgradeIndex: undefined };
}
function feedback(ids, connectionId, definitionId, options, style, extra = {}) {
  const f = { type: 'feedback', id: ids(), definitionId, connectionId, options: opts(options), isInverted: false, upgradeIndex: undefined, ...extra };
  if (style) f.style = style;
  return f;
}
const steps = (down = [], up = [], rotary) => ({ 0: { action_sets: { down, up, ...(rotary ? { rotate_left: rotary.left || [], rotate_right: rotary.right || [] } : {}) }, options: { runWhileHeld: [] } } });

// the module's look: its family background, one text size, no top bar
const look = (fam, text, color = COLORS.white, bgcolor = COLORS.grey) =>
  ({ text, textExpression: false, size: TEXT_SIZE, color, bgcolor, png64: BG[fam] || null, pngalignment: 'center:center', alignment: 'center:center', show_topbar: false });

// A live link to a module preset. The cache is left empty: Companion fills it from the module's preset when the
// module publishes its presets, and the cc_pages_refresh feedback (module 0.7.0+) makes it publish them right after an import.
function presetRef(ids, connectionId, presetId, rotary = false) {
  return {
    type: 'preset-reference',
    options: { rotaryActions: !!rotary, stepProgression: 'auto', canModifyStyleInApis: false },
    style: { layers: [] },
    feedbacks: [feedback(ids, connectionId, 'cc_pages_refresh', {})],
    steps: steps([], [], rotary ? {} : undefined),
    localVariables: [],
    presetRef: { connectionId, moduleId: MODULE_ID, presetId, variableValues: null },
    checksum: null,
  };
}

// A plain (copied) button in the legacy v12 shape; Companion converts it to its layered look on import.
function button(style, down = [], up = [], feedbacks = [], rotary) {
  return {
    type: 'button',
    style,
    options: { rotaryActions: !!rotary, stepAutoProgress: true, relativeDelta: false },
    feedbacks,
    steps: steps(down, up, rotary),
    localVariables: [],
  };
}

// a jump to another generated page, red with "NO PAGE" when that page has gone
const setPage = (ids, pageId) => action(ids, 'internal', 'set_page', { surfaceId: 'self', page: pageId });
function navButton(ids, pageId, text, fam = 'utility', extraDown = []) {
  return button({ ...look(fam, text), size: 'auto' }, [setPage(ids, pageId), ...extraDown], [],
    [feedback(ids, 'internal', 'page_missing', { page: pageId }, { color: COLORS.white, bgcolor: COLORS.red, text: `${text}\\nNO PAGE`, png64: null })]);
}
// a knob that pages through `ring` (page ids) and jumps to `home` when pushed
function pageKnob(ids, prevId, nextId, homeId, text = 'PAGE\\n◀ ▶\\npush: HOME') {
  return button({ ...look('utility', text), size: 'auto' }, homeId ? [setPage(ids, homeId)] : [], [], [],
    { left: prevId ? [setPage(ids, prevId)] : [], right: nextId ? [setPage(ids, nextId)] : [] });
}
const label = (text, fam = 'status') => button(look(fam, text, COLORS.white, COLORS.black));

// rows[r][c] -> controls{r:{c:..}}
function page(pageId, name, cells, layout, gridSize) {
  const controls = {};
  for (const [key, ctl] of cells) {
    const [r, c] = key.split('/').map(Number);
    (controls[r] = controls[r] || {})[c] = ctl;
  }
  return { id: pageId, name, controls, gridSize, surfaceLayout: layout };
}

// the rs6-presets connection the buttons refer to, for a full import that also brings the connection
function connection(cfg) {
  return {
    label: cfg.label, moduleId: MODULE_ID, moduleVersionId: null, updatePolicy: 'stable', enabled: true, sortOrder: 0, isFirstInit: false, lastUpgradeIndex: -1,
    config: { host: cfg.host, port: cfg.port, updates: 'longpoll', poll: 300, systems: 'on', max_hold: 20000 },
  };
}

function fullExport(pages, conn, meta = {}) {
  const out = {
    version: FILE_VERSION, type: 'full', companionBuild: meta.build || 'pv-control-center', // shown by Companion on import
    pages: {}, triggers: {}, custom_variables: {}, instances: { [conn.id]: connection(conn) }, connectionCollections: [], triggerCollections: [], customVariablesCollections: [],
  };
  pages.forEach((p, i) => { out.pages[i + 1] = p; });
  return out;
}

module.exports = { FILE_VERSION, MODULE_ID, COLORS, idMaker, action, feedback, look, presetRef, button, navButton, pageKnob, label, setPage, page, connection, fullExport };
