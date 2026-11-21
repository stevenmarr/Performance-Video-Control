'use strict';
// 0.32.0: Control Center deck pages for Companion. The deck pages a USB Stream Deck
// shows (HOME, the PTZ pages with their paint knobs, the ATEM switcher page, the
// console) are built by lib/decks/faces.js for a session; they were never in the
// BUTTONS / PAGES library that GET /api/companion/buttons serves. This file turns a
// stamped face into what a Companion button can draw: text and colors per key, and
// for a Stream Deck + / + XL one touch-strip readout and one knob per dial
// (label plus live value, e.g. "R GAIN +12"). Pure functions only.

const crypto = require('crypto');
const { keyModel } = require('../decks/look');
const { THEME, WIDGETS, dialFace, SHORT } = require('../deck');
const { ART_SIZES } = require('./deck-art');

const COMPANION_LAYOUT = { mk2: 'streamdeck', xl: 'streamdeck-xl', plus: 'streamdeck-plus', plusxl: 'streamdeck-plus-xl' };
// Surfaces Companion pages are offered for. Mini and Neo have no page layout on the fork.
const DECK_SURFACES = ['plusxl', 'plus', 'xl', 'mk2'];
const TINT = { r: THEME.r, b: THEME.b, knob: THEME.knob };

const clean = (s, n = 24) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function pressable(key) {
  return !!(key && (key.action || key.nav || key.pick || key.map || key.atemHold || key.atemToggle || key.atemMes || key.goto || key.next));
}

// art (0.35.0, lib/companion/deck-art.js): when given, each slot also gets "img", the id of
// the PNG Control Center draws for it (GET /api/companion/deck/art/<id>.png).
function keySlot(key, art) {
  const m = keyModel(key);
  let lines = [m.title, m.value, m.caption].map((t) => clean(t)).filter(Boolean);
  if (!lines.length) lines = [key.caption, key.label].map((t) => clean(t)).filter(Boolean);
  if (!lines.length && (m.house || key.nav === 'home')) lines = ['HOME'];
  const out = { row: key.row, col: key.col, lines, color: m.ink || THEME.text, bgcolor: m.fill || THEME.panel, pressable: pressable(key) };
  if (m.border) out.border = m.border;
  if (art) out.img = art.key(key);
  return out;
}

// One dial as a strip readout and a knob label. Widget dials (PTZ paint) read the
// camera through dialFace; ATEM dials carry their own readout / strip text.
function dialSlot(dial, snap, art) {
  if (!dial) return null;
  let out;
  if (dial.atem || dial.readout != null || dial.strip) {
    const label = clean(dial.label, 12);
    const value = clean((dial.strip && dial.strip.text) || dial.readout || '', 16);
    const on = !!(dial.strip && dial.strip.on);
    out = { kind: 'atem', widget: dial.atem || null, label, value, lines: [label, value].filter(Boolean), knob: [label], color: on ? '#FFFFFF' : THEME.text, bgcolor: on ? THEME.accent : THEME.bg, tap: !!(dial.strip && dial.strip.touch) };
  } else {
    let face;
    try { face = dialFace(dial.widget, snap || {}, dial.stepIndex || 0); } catch { return null; }
    out = widgetSlot(dial.widget, face);
  }
  if (art) {
    const img = art.dial(dial, snap);
    if (img) out.img = img;
    out.knobImg = art.encoder(out.knob[0] || out.label);
  }
  return out;
}

function widgetSlot(widget, face) {
  const parts = face.parts || [];
  const active = parts.find((p) => p.active) || parts[0] || { tint: 'knob' };
  let lines;
  if (face.kind === 'pair') lines = parts.map((p) => `${p.active ? '>' : ' '}${clean(p.label, 8)} ${clean(p.text, 8)}`);
  else lines = [clean(face.caption || active.label, 10) + (face.badge ? ` ${face.badge}` : ''), clean(active.text, 10)];
  if (face.tap) lines.push(clean(face.tap, 10));
  const pgm = face.tally === 'pgm';
  return {
    kind: face.kind === 'pair' ? 'pair' : 'single',
    widget,
    label: clean(face.caption || active.label, 10),
    value: clean(active.text, 10),
    lines,
    knob: face.kind === 'pair' ? [clean(face.caption, 10), clean(face.step, 10)].filter(Boolean) : [clean(face.caption || active.label, 10)],
    color: TINT[active.tint] || THEME.text,
    bgcolor: pgm ? THEME.dangerBg : THEME.bg,
    tap: !!face.tap,
    op: face.activeOp || null,
  };
}

function faceSlots(face, surface, art) {
  const keys = (face && face.keys || []).filter(Boolean).map((k) => keySlot(k, art));
  const knobCols = surface.knobCols || [];
  const dials = [];
  (face && face.dials || []).slice(0, knobCols.length).forEach((dial, index) => {
    const slot = dialSlot(dial, face.snap, art);
    if (slot) dials.push({ index, col: knobCols[index], ...slot });
  });
  return { keys, dials };
}

// Every PTZ dial widget as a standalone strip display (R / B gain, iris, detail ...).
function widgetSlots(snap, stepOf, art) {
  const out = {};
  for (const widget of Object.keys(WIDGETS)) {
    if (WIDGETS[widget].kind === 'track') continue;
    let face;
    const step = stepOf ? stepOf(widget) : 0;
    try { face = dialFace(widget, snap || {}, step); } catch { continue; }
    out[widget] = widgetSlot(widget, face);
    if (art) {
      const img = art.widget(widget, snap, step);
      if (img) out[widget].img = img;
      out[widget].knobImg = art.encoder(out[widget].knob[0] || out[widget].label);
    }
  }
  return out;
}

function widgetNames() {
  return Object.keys(WIDGETS).filter((w) => WIDGETS[w].kind !== 'track').map((w) => {
    const d = WIDGETS[w];
    const name = d.kind === 'pair' ? d.labels.join(' / ') : (d.label || SHORT[d.op] || w);
    return { id: w, name, pair: d.kind === 'pair', tap: d.tapLabel || '' };
  });
}

function hash(v) {
  return crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
}

// faces: DeckService.companionFaces(surfaceId) for each surface.
function deckModel(facesList, { snap, stepOf, art } = {}) {
  const surfaces = [];
  for (const f of facesList.filter(Boolean)) {
    const s = f.surface;
    const knobs = (s.knobCols || []).length > 0;
    surfaces.push({
      id: s.id,
      label: s.label,
      cols: s.cols,
      rows: s.rows,
      knobCols: (s.knobCols || []).slice(),
      touchRow: knobs ? s.rows : null,
      encoderRow: knobs ? s.rows + 1 : null,
      companionLayout: COMPANION_LAYOUT[s.id] || null,
      device: f.device.id,
      at: f.session,
      live: faceSlots(f.live, s, art),
      pages: f.pages.map((p) => ({ id: `${p.system}.${p.page}`, system: p.system, page: p.page, title: clean(p.title, 40), ...faceSlots(p.face, s, art) })),
    });
  }
  const widgets = widgetSlots(snap, stepOf, art);
  // layoutRev changes only when the set of presets would change (not on a new value).
  const layoutRev = hash({
    s: surfaces.map((s) => [s.id, s.pages.map((p) => [p.id, p.title, p.keys.filter((k) => k.pressable).map((k) => `${k.row}/${k.col}`), p.dials.map((d) => d.col)]), s.live.dials.map((d) => d.col)]),
    w: Object.keys(widgets),
  });
  const body = { surfaces, widgets, widgetList: widgetNames(), layoutRev };
  // 0.35.0: where the slot pictures are, their pixel sizes, and the picture of an empty key
  if (art) body.art = { url: '/api/companion/deck/art/', ext: '.png', sizes: ART_SIZES, blank: art.blank() };
  return { rev: hash(body), ...body };
}

module.exports = { deckModel, faceSlots, keySlot, dialSlot, widgetSlot, widgetSlots, widgetNames, DECK_SURFACES, COMPANION_LAYOUT, pressable };
