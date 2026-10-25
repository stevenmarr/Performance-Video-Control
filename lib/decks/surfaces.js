'use strict';
// Stream Deck surface sizes. The same ids Companion pages use, plus Mini.
// A connected device is matched by the model name the Path C plugin reports.

const SURFACES = {
  mini: { id: 'mini', label: 'Stream Deck Mini', cols: 3, rows: 2, knobCols: [] },
  mk2: { id: 'mk2', label: 'Stream Deck MK.2', cols: 5, rows: 3, knobCols: [] },
  xl: { id: 'xl', label: 'Stream Deck XL', cols: 8, rows: 4, knobCols: [] },
  neo: { id: 'neo', label: 'Stream Deck Neo', cols: 4, rows: 2, knobCols: [] },
  plus: { id: 'plus', label: 'Stream Deck +', cols: 4, rows: 2, knobCols: [0, 1, 2, 3] },
  plusxl: { id: 'plusxl', label: 'Stream Deck + XL', cols: 9, rows: 4, knobCols: [0, 2, 3, 5, 6, 8] },
};

const ORDER = ['mini', 'mk2', 'neo', 'xl', 'plus', 'plusxl'];

// Elgato device type numbers (SDK) and the names the plugin sends.
const TYPE_SURFACE = {
  0: 'mk2', 1: 'mini', 2: 'xl', 7: 'plus', 9: 'neo', 11: 'plusxl',
};

function surfaceById(id) {
  return SURFACES[id] || null;
}

function surfaceFor(device = {}) {
  const model = String(device.model || '').toLowerCase();
  const type = device.type;
  const plus = model.includes('plus') || model.includes('+');
  const xl = model.includes('xl');
  if (plus && xl) return SURFACES.plusxl;
  if (model.includes('mini')) return SURFACES.mini;
  if (model.includes('neo')) return SURFACES.neo;
  if (xl && !plus) return SURFACES.xl;
  // "Stream Deck +" is also what some + XL units report; the type number breaks the tie.
  if (plus && TYPE_SURFACE[type] === 'plusxl') return SURFACES.plusxl;
  if (plus) return SURFACES.plus;
  if (TYPE_SURFACE[type]) return SURFACES[TYPE_SURFACE[type]];
  const cols = Number(device.columns);
  const rows = Number(device.rows);
  if (cols && rows) {
    const hit = ORDER.map((id) => SURFACES[id]).find((s) => s.cols === cols && s.rows === rows && !(s.knobCols || []).length);
    if (hit) return hit;
  }
  return SURFACES.mk2;
}

module.exports = { SURFACES, ORDER, TYPE_SURFACE, surfaceById, surfaceFor };
