'use strict';
// 0.20 Path C: the Stream Deck face of Control Center.
// The official plugin (streamdeck/, UUID com.performancevideo.control) calls only the HTTP
// routes this module describes. Control Center talks to the Panasonic AW-UE150. The deck
// never opens a camera connection, and Companion is not on this path.
//
// Labels and value formats match public/ptz.js (SHORT / FMT) so a knob on the + XL reads
// the same as the paint pane. R gain, B gain, R pedestal and B pedestal are dials. They
// are not keys.

const PLUGIN_UUID = 'com.performancevideo.control';
const DECK_PATH = '/api/deck/ptz';
const LAYOUT_PATH = '/api/deck/ptz/layout';

// Control Dark. Red is PGM / LIVE only. A feature that is on uses the app accent.
const THEME = Object.freeze({
  bg: '#101012',
  panel: '#222226',
  text: '#E6E6E8',
  dim: '#9A9AA2',
  pgm: '#C42020',
  accent: '#3B8CFF',
  knob: '#7c8cff',
  track: '#262e39',
  centre: '#5f6b7a',
  active: '#ffd35c',
  dangerBg: '#3A0D10',
  dangerText: '#FFB3B6',
  r: '#ff8a8f',
  b: '#8fb8ff',
  line: '#2a313b',
});

// Paint values that stay on the strip. A key must not send one of these.
const KEY_BAN = new Set(['rGain', 'bGain', 'rPed', 'bPed', 'gPed', 'masterPed', 'iris', 'chromaLevel', 'gamma', 'kneePoint', 'masterDetail', 'zoomPos', 'focusPos']);

const SHORT = {
  iris: 'IRIS', irisMode: 'IRIS', masterPed: 'M.PED', rGain: 'R GAIN', bGain: 'B GAIN', rPed: 'R PED', bPed: 'B PED',
  zoomPos: 'ZOOM', focusPos: 'FOCUS', focusMode: 'FOCUS', oneTouchAF: 'PUSH AF', masterDetail: 'M.DTL', detail: 'DETAIL',
  gamma: 'GAMMA', gammaMode: 'GAMMA', chromaLevel: 'CHROMA', kneePoint: 'K.POINT', kneeMode: 'KNEE',
  gain: 'GAIN', shutterStep: 'SHUTTER', shutter: 'SHUTTER', ndFilter: 'ND FILTER', wbMode: 'WHITE BAL', awb: 'AWB', abb: 'ABB',
  power: 'POWER', tallyRed: 'TALLY', ois: 'O.I.S.', colorBars: 'BARS', dExtender: 'D.EXT', freezePreset: 'FREEZE',
  dayNight: 'NIGHT', drs: 'DRS', presetSpeed: 'SPEED', matrixType: 'MATRIX', digitalZoom: 'D.ZOOM', scene: 'SCENE',
  home: 'HOME',
};

const FMT = {
  gamma: (v) => (Number(v) / 100).toFixed(2),
  kneePoint: (v) => `${Number(v).toFixed(2)}%`,
  chromaLevel: (v) => (Number(v) <= -100 ? 'OFF' : `${Number(v) > 0 ? '+' : ''}${v}%`),
  iris: (v) => String(Math.round(Number(v))),
  zoomPos: (v) => `${Number(v).toFixed(1)}%`,
  focusPos: (v) => `${Number(v).toFixed(1)}%`,
};

const COARSE = 5;
const PAIR_STEPS = [
  { axis: 0, coarse: false, label: 'R · FINE' },
  { axis: 0, coarse: true, label: 'R · COARSE' },
  { axis: 1, coarse: false, label: 'B · FINE' },
  { axis: 1, coarse: true, label: 'B · COARSE' },
];

// Tap is what a strip touch runs. Push cycles the step (fine / coarse, and R / B on a pair).
const WIDGETS = {
  iris: { kind: 'single', op: 'iris', label: 'IRIS', tap: { type: 'toggle', op: 'irisMode' }, tapLabel: 'A/M' },
  masterPed: { kind: 'single', op: 'masterPed', label: 'M.PED', tap: { type: 'centre', op: 'masterPed' }, tapLabel: 'RESET' },
  gainRb: { kind: 'pair', ops: ['rGain', 'bGain'], labels: ['R', 'B'], tints: ['r', 'b'], caption: 'GAIN', tap: { type: 'button', op: 'awb' }, tapLabel: 'AWB' },
  pedRb: { kind: 'pair', ops: ['rPed', 'bPed'], labels: ['R', 'B'], tints: ['r', 'b'], caption: 'PED', tap: { type: 'button', op: 'abb' }, tapLabel: 'ABB' },
  zoom: { kind: 'single', op: 'zoomPos', label: 'ZOOM', tap: { type: 'stop', axes: ['z'] }, tapLabel: 'STOP' },
  focus: { kind: 'single', op: 'focusPos', label: 'FOCUS', tap: { type: 'button', op: 'oneTouchAF' }, tapLabel: 'PUSH AF' },
  masterDetail: { kind: 'single', op: 'masterDetail', label: 'M.DTL', tap: { type: 'toggle', op: 'detail' }, tapLabel: 'ON' },
  gamma: { kind: 'single', op: 'gamma', label: 'GAMMA', tap: { type: 'set', op: 'gammaMode', value: '0' }, tapLabel: 'HD' },
  chroma: { kind: 'single', op: 'chromaLevel', label: 'CHROMA', tap: { type: 'centre', op: 'chromaLevel' }, tapLabel: 'RESET' },
  kneePoint: { kind: 'single', op: 'kneePoint', label: 'K.POINT', tap: { type: 'centre', op: 'kneePoint' }, tapLabel: 'RESET' },
  gain: { kind: 'single', op: 'gain', label: 'GAIN', tap: null, tapLabel: '' },
  shutter: { kind: 'single', op: 'shutterStep', label: 'SHUTTER', tap: null, tapLabel: '' },
  ptSpeed: { kind: 'speed', axis: 'pt', label: 'PT SPD', tap: { type: 'speeds', axis: 'pt', value: 25 }, tapLabel: 'RESET' },
  zfSpeed: { kind: 'speed', axis: 'zf', label: 'ZF SPD', tap: { type: 'speeds', axis: 'zf', value: 25 }, tapLabel: 'RESET' },
};

const DIRS = {
  up: { pan: 0, tilt: 1 }, down: { pan: 0, tilt: -1 }, left: { pan: -1, tilt: 0 }, right: { pan: 1, tilt: 0 },
  upLeft: { pan: -1, tilt: 1 }, upRight: { pan: 1, tilt: 1 }, downLeft: { pan: -1, tilt: -1 }, downRight: { pan: 1, tilt: -1 },
};

// Keys are toggles, cycles, execs, camera select, presets, pages and (on MOVE) hold-to-run.
// None of them is an R/B gain or pedestal pair.
const KEY_ROLES = {
  irisMode: { type: 'toggle', op: 'irisMode', label: 'IRIS', on: 'AUTO', off: 'MANUAL' },
  oneTouchAF: { type: 'button', op: 'oneTouchAF', label: 'FOCUS', text: 'PUSH AF' },
  awb: { type: 'button', op: 'awb', label: 'WHITE BAL', text: 'AWB' },
  abb: { type: 'button', op: 'abb', label: 'WHITE BAL', text: 'ABB' },
  guard: { type: 'guard', label: 'LIVE GUARD' },
  allStop: { type: 'stopAll', label: 'ALL STOP' },
  detail: { type: 'toggle', op: 'detail', label: 'DETAIL' },
  power: { type: 'toggle', op: 'power', label: 'POWER', on: 'ON', off: 'STBY' },
  tallyRed: { type: 'toggle', op: 'tallyRed', label: 'TALLY' },
  focusMode: { type: 'toggle', op: 'focusMode', label: 'FOCUS', on: 'AF', off: 'MF' },
  ois: { type: 'toggle', op: 'ois', label: 'O.I.S.' },
  colorBars: { type: 'toggle', op: 'colorBars', label: 'BARS' },
  freezePreset: { type: 'toggle', op: 'freezePreset', label: 'FREEZE' },
  dayNight: { type: 'toggle', op: 'dayNight', label: 'NIGHT' },
  dExtender: { type: 'cycle', op: 'dExtender', label: 'D.EXT' },
  drs: { type: 'cycle', op: 'drs', label: 'DRS' },
  ndFilter: { type: 'cycle', op: 'ndFilter', label: 'ND FILTER' },
  wbMode: { type: 'cycle', op: 'wbMode', label: 'WHITE BAL' },
  gammaMode: { type: 'cycle', op: 'gammaMode', label: 'GAMMA' },
  kneeMode: { type: 'cycle', op: 'kneeMode', label: 'KNEE' },
  gain: { type: 'cycle', op: 'gain', label: 'GAIN' },
  shutter: { type: 'cycle', op: 'shutterStep', label: 'SHUTTER' },
  presetSpeed: { type: 'cycle', op: 'presetSpeed', label: 'SPEED' },
  matrixType: { type: 'cycle', op: 'matrixType', label: 'MATRIX' },
  digitalZoom: { type: 'toggle', op: 'digitalZoom', label: 'D.ZOOM' },
  scene: { type: 'cycle', op: 'scene', label: 'SCENE' },
  ptzHome: { type: 'button', op: 'home', label: 'CAM', text: 'HOME' },
  moveUp: { type: 'move', dir: 'up', label: 'TILT', text: 'UP' },
  moveDown: { type: 'move', dir: 'down', label: 'TILT', text: 'DOWN' },
  moveLeft: { type: 'move', dir: 'left', label: 'PAN', text: 'LEFT' },
  moveRight: { type: 'move', dir: 'right', label: 'PAN', text: 'RIGHT' },
  moveUpLeft: { type: 'move', dir: 'upLeft', label: 'PAN', text: 'UP L' },
  moveUpRight: { type: 'move', dir: 'upRight', label: 'PAN', text: 'UP R' },
  moveDownLeft: { type: 'move', dir: 'downLeft', label: 'PAN', text: 'DN L' },
  moveDownRight: { type: 'move', dir: 'downRight', label: 'PAN', text: 'DN R' },
  zoomTele: { type: 'zoom', dir: 1, label: 'ZOOM', text: 'TELE' },
  zoomWide: { type: 'zoom', dir: -1, label: 'ZOOM', text: 'WIDE' },
  focusFar: { type: 'focus', dir: 1, label: 'FOCUS', text: 'FAR' },
  focusNear: { type: 'focus', dir: -1, label: 'FOCUS', text: 'NEAR' },
};

const PROFILES = { live: 'PTZ Live', paint: 'PTZ Paint', func: 'PTZ Functions', move: 'PTZ Move' };
const PAGES = ['live', 'paint', 'func', 'move'];
const PAGE_LABEL = { live: 'LIVE', paint: 'PAINT', func: 'FUNC', move: 'MOVE' };
const KNOB_COLS = [0, 2, 3, 5, 6, 8];

const cameraRow = () => [{ role: 'home' }].concat([1, 2, 3, 4, 5, 6, 7, 8].map((slot) => ({ role: 'camera', slot })));
const tabs = () => PAGES.map((page) => ({ role: 'page', page }));
const role = (id) => ({ role: id });

const PLUSXL = {
  id: 'plusxl',
  label: 'Stream Deck + XL',
  cols: 9,
  rows: 4,
  knobCols: KNOB_COLS.slice(),
  stripRow: 4,
  knobRow: 5,
  home: { row: 0, col: 0, mark: 'm4' },
  pages: [
    {
      id: 'live',
      profile: PROFILES.live,
      keys: [
        cameraRow(),
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ role: 'preset', preset: n })),
        [10, 11, 12, 13, 14, 15, 16, 17, 18].map((n) => ({ role: 'preset', preset: n })),
        tabs().concat([role('irisMode'), role('oneTouchAF'), role('awb'), role('guard'), role('allStop')]),
      ],
      dials: ['iris', 'masterPed', 'gainRb', 'pedRb', 'zoom', 'focus'],
    },
    {
      id: 'paint',
      profile: PROFILES.paint,
      keys: [
        cameraRow(),
        ['irisMode', 'gain', 'shutter', 'ndFilter', 'wbMode', 'awb', 'abb', 'detail', 'gammaMode'].map(role),
        ['kneeMode', 'drs', 'dayNight', 'colorBars', 'dExtender', 'ois', 'focusMode', 'power', 'tallyRed'].map(role),
        tabs().concat([role('freezePreset'), role('presetSpeed'), role('matrixType'), role('digitalZoom'), role('allStop')]),
      ],
      dials: ['gainRb', 'pedRb', 'masterDetail', 'gamma', 'chroma', 'kneePoint'],
    },
    {
      id: 'func',
      profile: PROFILES.func,
      keys: [
        cameraRow(),
        ['tallyRed', 'power', 'focusMode', 'oneTouchAF', 'ois', 'colorBars', 'dExtender', 'freezePreset', 'presetSpeed'].map(role),
        ['irisMode', 'drs', 'dayNight', 'guard', 'gain', 'shutter', 'ndFilter', 'wbMode', 'awb'].map(role),
        tabs().concat([role('abb'), role('detail'), role('gammaMode'), role('kneeMode'), role('allStop')]),
      ],
      dials: ['zoom', 'focus', 'iris', 'masterPed', 'gain', 'shutter'],
    },
    {
      id: 'move',
      profile: PROFILES.move,
      keys: [
        cameraRow(),
        ['moveUpLeft', 'moveUp', 'moveUpRight', 'zoomWide', 'zoomTele', 'focusNear', 'focusFar', 'oneTouchAF', 'ptzHome'].map(role),
        ['moveLeft', 'moveDownLeft', 'moveDown', 'moveDownRight', 'moveRight', 'guard', 'awb', 'abb', 'scene'].map(role),
        tabs().concat([role('irisMode'), role('focusMode'), role('power'), role('tallyRed'), role('allStop')]),
      ],
      dials: ['zoom', 'focus', 'iris', 'masterPed', 'ptSpeed', 'zfSpeed'],
    },
  ],
};

const err = (message, status = 400) => Object.assign(new Error(message), { status });

function controlCenterBase(settings = {}) {
  const host = String(settings.host == null || settings.host === '' ? '127.0.0.1' : settings.host).trim();
  const port = Number(settings.port == null || settings.port === '' ? 8080 : settings.port);
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host) || host.includes('..')) throw err('Invalid Control Center host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw err('Invalid Control Center port');
  return `http://${host}:${port}`;
}

function formatValue(id, value, op) {
  if (value === undefined || value === null || value === '' || (typeof value === 'number' && Number.isNaN(value))) return '—';
  if (FMT[id]) return FMT[id](value);
  if (op && op.type === 'list') {
    const hit = (op.options || []).find(([k]) => k === String(value));
    return hit ? String(hit[1]) : String(value);
  }
  if (op && op.type === 'toggle') return value === true || value === 1 || value === '1' ? 'ON' : 'OFF';
  if (op && op.range && op.range.min < 0 && Number(value) > 0) return `+${value}`;
  return String(value);
}

function fractionOf(op, value) {
  if (!op) return 0;
  if (op.type === 'range' && op.range && op.range.max !== op.range.min && value !== undefined && value !== null && value !== '') {
    return Math.max(0, Math.min(1, (Number(value) - op.range.min) / (op.range.max - op.range.min)));
  }
  if (op.type === 'list' && op.options && op.options.length > 1) {
    const i = op.options.findIndex(([k]) => k === String(value));
    return (i < 0 ? 0 : i) / (op.options.length - 1);
  }
  return 0;
}

function readoutFor(op, value) {
  const on = op.type === 'toggle' ? (value === true || value === 1 || value === '1') : undefined;
  return {
    id: op.id,
    label: SHORT[op.id] || String(op.label || op.id).toUpperCase(),
    text: formatValue(op.id, value, op),
    value: value === undefined ? null : value,
    fraction: fractionOf(op, value),
    type: op.type,
    on,
    centre: op.range && op.range.centre !== undefined ? op.range.centre : null,
    range: op.range ? { min: op.range.min, max: op.range.max, step: op.range.step } : null,
  };
}

function presetName(names, n) {
  if (!names) return `Preset ${n}`;
  const v = names[n] !== undefined ? names[n] : names[String(n)];
  return v ? String(v) : `Preset ${n}`;
}

// view is systems.ptzView(). catalogFor(series) is the camera catalog (lib/drivers/ptz-commands).
function snapshot(view = {}, catalogFor, meta = {}) {
  const cams = (view.cameras || []).map((c, i) => ({
    slot: i + 1,
    id: c.id,
    name: c.name || `CAM ${i + 1}`,
    connected: !!c.connected,
    tally: !!c.tally,
    tallyGreen: !!c.tallyGreen,
    power: c.power || null,
    model: c.model || null,
    series: c.series || null,
    selected: c.id === view.selected,
    locked: !!c.locked,
  }));
  const sel = cams.find((c) => c.selected) || null;
  const raw = (view.cameras || []).find((c) => sel && c.id === sel.id) || null;
  const series = (raw && raw.series) || 'UE150';
  let ops = [];
  if (typeof catalogFor === 'function') {
    try { ops = (catalogFor(series) || {}).ops || []; } catch { ops = []; }
  }
  const values = raw && raw.values ? raw.values : {};
  const readouts = {};
  for (const op of ops) {
    if (!op || !op.id || op.type === 'button') {
      if (op && op.id) readouts[op.id] = { id: op.id, label: SHORT[op.id] || op.label, text: '', value: null, fraction: 0, type: op.type || 'button', on: null, centre: null, range: null };
      continue;
    }
    readouts[op.id] = readoutFor(op, values[op.id]);
  }
  const names = raw ? raw.presetNames || {} : {};
  const presets = [];
  for (let n = 1; n <= 18; n++) presets.push({ n, name: presetName(names, n) });
  return {
    path: 'C',
    plugin: PLUGIN_UUID,
    direct: false,
    companion: false,
    rev: meta.rev == null ? (view.rev == null ? 0 : view.rev) : meta.rev,
    selected: sel ? sel.id : null,
    liveGuard: view.liveGuard || { mode: 'hold', holdMs: 600 },
    speeds: { pt: 25, zoom: 25, focus: 15, ...(view.speeds || {}) },
    cameras: cams,
    presets,
    values,
    readouts,
    layout: { surface: 'plusxl', pages: PAGES.slice(), profiles: { ...PROFILES } },
  };
}

function nextValue(op, current, steps) {
  if (!op) throw err('Unknown control', 404);
  const n = Number(steps);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 500) throw err('steps must be a non-zero integer from -500 to 500');
  if (op.type === 'range' && op.range) {
    const step = op.range.step || 1;
    const base = current === undefined || current === null || current === '' || Number.isNaN(Number(current))
      ? (op.range.centre !== undefined ? op.range.centre : op.range.min)
      : Number(current);
    let v = base + n * step;
    const dec = (String(step).split('.')[1] || '').length;
    v = Number(v.toFixed(dec));
    if (v < op.range.min) v = op.range.min;
    if (v > op.range.max) v = op.range.max;
    return v;
  }
  if (op.type === 'list' && op.options && op.options.length) {
    let i = op.options.findIndex(([k]) => k === String(current));
    if (i < 0) i = n > 0 ? -1 : 0;
    i = Math.max(0, Math.min(op.options.length - 1, i + n));
    return op.options[i][0];
  }
  throw err(`${op.label || op.id}: not a stepped control`);
}

function cameraForSlot(snap, slot) {
  const cams = (snap && snap.cameras) || [];
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 1) throw err('Camera slot must be 1..8');
  if (n === 8 && cams.length > 8) {
    const i = cams.findIndex((c) => c.selected);
    return cams[(Math.max(0, i) + 1) % cams.length];
  }
  const cam = cams[n - 1];
  if (!cam) throw err(`No camera in slot ${n}`, 404);
  return cam;
}

function selectedCam(snap) {
  if (!snap || !snap.selected) throw err('No camera selected', 409);
  return snap.selected;
}

function stepOf(widget, stepIndex) {
  const w = WIDGETS[widget];
  if (!w) throw err(`Unknown dial "${widget}"`, 404);
  const i = Math.abs(Math.trunc(Number(stepIndex) || 0));
  if (w.kind === 'pair') return PAIR_STEPS[i % PAIR_STEPS.length];
  return { axis: 0, coarse: i % 2 === 1, label: i % 2 === 1 ? 'COARSE' : 'FINE' };
}

function dialFace(widget, snap, stepIndex) {
  const w = WIDGETS[widget];
  if (!w) throw err(`Unknown dial "${widget}"`, 404);
  const step = stepOf(widget, stepIndex);
  const ro = (id) => (snap && snap.readouts && snap.readouts[id]) || { text: '—', fraction: 0, value: null, centre: null, on: null };
  const tap = w.tapLabel || '';
  if (w.kind === 'pair') {
    const parts = w.ops.map((id, i) => {
      const r = ro(id);
      return { label: w.labels[i], text: r.text, fraction: r.fraction, tint: w.tints[i], active: step.axis === i, muted: r.centre !== null && r.value === r.centre };
    });
    return { widget, kind: 'pair', caption: w.caption, parts, step: step.label, stepLine: tap ? `${step.label} · ${tap}` : step.label, tap };
  }
  if (w.kind === 'speed') {
    const speeds = (snap && snap.speeds) || {};
    const value = w.axis === 'pt' ? Number(speeds.pt) || 1 : Number(speeds.zoom) || 1;
    const text = String(value);
    return {
      widget, kind: 'speed', caption: w.label, tap,
      parts: [{ label: w.label, text, fraction: Math.max(0, Math.min(1, (value - 1) / 48)), tint: 'knob', active: true, muted: false }],
      step: step.label, stepLine: tap ? `${step.label} · ${tap}` : step.label,
    };
  }
  const r = ro(w.op);
  let badge = null;
  if (widget === 'iris') badge = ro('irisMode').on ? 'AUTO' : null;
  if (widget === 'focus') badge = ro('focusMode').on ? 'AF' : (ro('focusMode').value === false ? 'MF' : null);
  if (widget === 'masterDetail') badge = ro('detail').on ? 'ON' : (ro('detail').value === false ? 'OFF' : null);
  return {
    widget, kind: 'single', caption: w.label, badge, tap,
    parts: [{ label: w.label, text: r.text, fraction: r.fraction, tint: 'knob', active: true, muted: r.centre !== null && r.value === r.centre }],
    step: step.label, stepLine: tap ? `${step.label} · ${tap}` : step.label,
  };
}

function req(path, body) {
  return { method: 'POST', path, body };
}

function resetBody(snap, opId) {
  const ro = snap && snap.readouts && snap.readouts[opId];
  if (ro && ro.centre !== null && ro.centre !== undefined) return ro.centre;
  if (ro && ro.range) {
    const mid = (ro.range.min + ro.range.max) / 2;
    const step = ro.range.step || 1;
    const dec = (String(step).split('.')[1] || '').length;
    return Number((Math.round((mid - ro.range.min) / step) * step + ro.range.min).toFixed(dec));
  }
  return 0;
}

function speedValue(snap, axis, steps, absolute) {
  if (absolute !== undefined && absolute !== null) return Math.max(1, Math.min(49, Math.round(Number(absolute))));
  const speeds = (snap && snap.speeds) || {};
  const base = axis === 'pt' ? Number(speeds.pt) || 1 : Number(speeds.zoom) || 1;
  return Math.max(1, Math.min(49, Math.round(base + steps)));
}

// One gesture from the plugin, as Control Center HTTP calls. Paths are app routes only.
function plan(g = {}) {
  const snap = g.snapshot || {};
  const gesture = g.gesture;
  if (gesture === 'home') return { requests: [], open: '/' };
  if (gesture === 'page') {
    const page = String(g.page || '');
    if (!PROFILES[page]) throw err(`Unknown page "${page}"`);
    return { requests: [], profile: PROFILES[page], page };
  }
  if (gesture === 'select') {
    const cam = cameraForSlot(snap, g.slot);
    return { requests: [req('/api/sys/ptz/cmd/select', { cam: cam.id })] };
  }
  if (gesture === 'recall') {
    const n = Number(g.preset);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw err('Preset must be 1..100');
    return { requests: [req('/api/sys/ptz/cmd/recall', { cam: selectedCam(snap), preset: n, guarded: true, confirmed: !!g.confirmed })] };
  }
  if (gesture === 'key' || gesture === 'hold') {
    const spec = KEY_ROLES[g.role];
    if (!spec) throw err(`Unknown key "${g.role}"`, 404);
    if (KEY_BAN.has(g.role) || KEY_BAN.has(spec.op)) throw err('R/B gain and pedestal are dials, not keys');
    const cam = spec.type === 'guard' || spec.type === 'stopAll' ? null : selectedCam(snap);
    if (spec.type === 'stopAll') return { requests: [req('/api/sys/ptz/cmd/stopAll', {})] };
    if (spec.type === 'guard') return { requests: [req('/api/sys/ptz/cmd/guard', { mode: 'cycle' })] };
    if (spec.type === 'button') return { requests: [req('/api/sys/ptz/cmd/op', { cam, op: spec.op })] };
    if (spec.type === 'toggle') {
      const cur = snap.values ? snap.values[spec.op] : false;
      const on = cur === true || cur === 1 || cur === '1';
      return { requests: [req('/api/sys/ptz/cmd/op', { cam, op: spec.op, value: !on })] };
    }
    if (spec.type === 'cycle') return { requests: [req('/api/sys/ptz/cmd/step', { cam, op: spec.op, steps: 1 })] };
    const phase = g.phase || 'move';
    const factor = Math.max(0, Math.min(1, Number(g.factor == null ? 1 : g.factor)));
    if (spec.type === 'move') {
      const d = DIRS[spec.dir];
      if (phase === 'stop') return { requests: [req('/api/sys/ptz/cmd/stop', { cam, axes: ['pt'] })] };
      if (phase === 'keepalive') return { requests: [req('/api/sys/ptz/cmd/keepalive', { cam })] };
      return { requests: [req('/api/sys/ptz/cmd/move', { cam, pan: d.pan * factor, tilt: d.tilt * factor })] };
    }
    if (spec.type === 'zoom' || spec.type === 'focus') {
      const axis = spec.type === 'zoom' ? 'z' : 'f';
      const cmd = spec.type === 'zoom' ? 'zoom' : 'focus';
      if (phase === 'stop') return { requests: [req('/api/sys/ptz/cmd/stop', { cam, axes: [axis] })] };
      if (phase === 'keepalive') return { requests: [req('/api/sys/ptz/cmd/keepalive', { cam })] };
      return { requests: [req(`/api/sys/ptz/cmd/${cmd}`, { cam, dir: spec.dir * factor })] };
    }
    throw err(`Key "${g.role}" has no action`);
  }
  if (gesture === 'dial') {
    const w = WIDGETS[g.widget];
    if (!w) throw err(`Unknown dial "${g.widget}"`, 404);
    const event = g.event;
    if (event === 'push') {
      const count = w.kind === 'pair' ? PAIR_STEPS.length : 2;
      const stepIndex = (Math.abs(Math.trunc(Number(g.stepIndex) || 0)) + 1) % count;
      return { requests: [], stepIndex };
    }
    const step = stepOf(g.widget, g.stepIndex);
    const size = step.coarse ? COARSE : 1;
    if (event === 'rotate') {
      const ticks = Number(g.ticks);
      if (!Number.isInteger(ticks) || ticks === 0) throw err('Dial ticks must be a non-zero integer');
      const steps = ticks * size;
      if (w.kind === 'speed') {
        const n = speedValue(snap, w.axis, steps);
        const body = w.axis === 'pt' ? { pt: n } : { zoom: n, focus: n };
        return { requests: [req('/api/sys/ptz/cmd/speeds', body)] };
      }
      const op = w.kind === 'pair' ? w.ops[step.axis] : w.op;
      if (KEY_BAN.has(op) && g.asKey) throw err('R/B gain and pedestal are dials, not keys');
      return { requests: [req('/api/sys/ptz/cmd/step', { cam: selectedCam(snap), op, steps })] };
    }
    if (event === 'tap') {
      const tap = w.tap;
      if (!tap) return { requests: [] };
      const cam = tap.type === 'speeds' ? null : selectedCam(snap);
      if (tap.type === 'toggle') {
        const cur = snap.values ? snap.values[tap.op] : false;
        const on = cur === true || cur === 1 || cur === '1';
        return { requests: [req('/api/sys/ptz/cmd/op', { cam, op: tap.op, value: !on })] };
      }
      if (tap.type === 'button') return { requests: [req('/api/sys/ptz/cmd/op', { cam, op: tap.op })] };
      if (tap.type === 'set') return { requests: [req('/api/sys/ptz/cmd/op', { cam, op: tap.op, value: tap.value })] };
      if (tap.type === 'centre') return { requests: [req('/api/sys/ptz/cmd/op', { cam, op: tap.op, value: resetBody(snap, tap.op) })] };
      if (tap.type === 'stop') return { requests: [req('/api/sys/ptz/cmd/stop', { cam, axes: tap.axes })] };
      if (tap.type === 'speeds') {
        const n = speedValue(snap, tap.axis, 0, tap.value);
        const body = tap.axis === 'pt' ? { pt: n } : { zoom: n, focus: n };
        return { requests: [req('/api/sys/ptz/cmd/speeds', body)] };
      }
      return { requests: [] };
    }
    throw err(`Unknown dial event "${event}"`);
  }
  throw err(`Unknown gesture "${gesture}"`, 404);
}

function layoutIssues(layout = PLUSXL) {
  const issues = [];
  for (const page of layout.pages || []) {
    const keys = page.keys || [];
    if (!keys[0] || !keys[0][0] || keys[0][0].role !== 'home') issues.push(`${page.id}: (0,0) must be HOME`);
    if (!keys[3] || !keys[3][8] || keys[3][8].role !== 'allStop') issues.push(`${page.id}: bottom right must be ALL STOP`);
    if ((page.dials || []).length !== 6) issues.push(`${page.id}: the strip has six knobs`);
    (page.dials || []).forEach((id, i) => { if (!WIDGETS[id]) issues.push(`${page.id}: unknown dial ${id}`); if (KNOB_COLS[i] == null) issues.push(`${page.id}: dial column`); });
    keys.forEach((row) => (row || []).forEach((cell) => {
      if (!cell) return;
      if (cell.role === 'home' || cell.role === 'camera' || cell.role === 'preset' || cell.role === 'page') return;
      const spec = KEY_ROLES[cell.role];
      if (!spec) issues.push(`${page.id}: unknown key ${cell.role}`);
      else if (KEY_BAN.has(cell.role) || KEY_BAN.has(spec.op)) issues.push(`${page.id}: ${cell.role} is a dial, not a key`);
    }));
    if ((page.dials || []).includes('gainRb') === false && page.id === 'live') issues.push('live strip must include the R/B gain knob');
  }
  for (const id of Object.keys(KEY_ROLES)) {
    const spec = KEY_ROLES[id];
    if (KEY_BAN.has(id) || KEY_BAN.has(spec.op)) issues.push(`key role ${id} is banned`);
  }
  return issues;
}

function layout() {
  return {
    surface: PLUSXL.id,
    plugin: PLUGIN_UUID,
    theme: THEME,
    knobCols: PLUSXL.knobCols,
    pages: PLUSXL.pages.map((p) => ({
      id: p.id,
      profile: p.profile,
      dials: p.dials.map((id, i) => ({ col: KNOB_COLS[i], widget: id, ...(WIDGETS[id].kind === 'pair' ? { pair: true } : {}) })),
      keys: p.keys.map((row, r) => row.map((cell, c) => cell ? { row: r, col: c, ...cell } : null)),
    })),
    bannedOnKeys: [...KEY_BAN],
  };
}

module.exports = {
  PLUGIN_UUID, DECK_PATH, LAYOUT_PATH, THEME, KEY_BAN, KEY_ROLES, WIDGETS, PLUSXL, PROFILES, PAGES, PAGE_LABEL, KNOB_COLS, PAIR_STEPS, COARSE, SHORT, FMT, DIRS,
  controlCenterBase, formatValue, fractionOf, readoutFor, snapshot, nextValue, plan, dialFace, stepOf, layout, layoutIssues, cameraForSlot,
};
