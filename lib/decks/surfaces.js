'use strict';
// Stream Deck surface sizes. The same ids Companion pages use, plus Mini.
// A connected device is matched by the model name the Path C plugin reports.
//
// Physical stack, top to bottom (Elgato Stream Deck + and + XL): the LCD keys,
// then the touch strip, then the encoders (dials). The strip and the dials are
// BELOW the keys. Coordinates follow the layout model on Steven's Companion fork
// (shared-lib/lib/PageSurfaceLayout.ts, feat/lcars-gui): keys fill rows
// 0..rows-1, the touch strip is row `rows`, and the encoders are row `rows + 1`.
// On the + XL the strip and the six dials sit on key columns 0, 2, 3, 5, 6, 8,
// so a knob is not under every key.

const SURFACES = {
  mini: { id: 'mini', label: 'Stream Deck Mini', cols: 3, rows: 2, knobCols: [], stack: ['keys'], note: '' },
  mk2: { id: 'mk2', label: 'Stream Deck MK.2', cols: 5, rows: 3, knobCols: [], stack: ['keys'], note: '' },
  xl: { id: 'xl', label: 'Stream Deck XL', cols: 8, rows: 4, knobCols: [], stack: ['keys'], note: '' },
  neo: { id: 'neo', label: 'Stream Deck Neo', cols: 4, rows: 2, knobCols: [], stack: ['keys'], note: '' },
  plus: {
    id: 'plus',
    label: 'Stream Deck +',
    cols: 4,
    rows: 2,
    knobCols: [0, 1, 2, 3],
    stack: ['keys', 'touch', 'encoders'],
    note: 'Keys are the top two rows. The touch strip is under the keys, and a knob sits under each column below the strip.',
  },
  plusxl: {
    id: 'plusxl',
    label: 'Stream Deck + XL',
    cols: 9,
    rows: 4,
    knobCols: [0, 2, 3, 5, 6, 8],
    stack: ['keys', 'touch', 'encoders'],
    note: 'Keys fill the top four rows. The touch strip and the six knobs are below the keys, on the same columns as each other, with a gap under the 2nd, 5th, and 8th keys.',
  },
};

const ORDER = ['mini', 'mk2', 'neo', 'xl', 'plus', 'plusxl'];

// Surface ids used elsewhere (Steven's Companion fork PageSurfaceLayout ids and
// a few spellings seen in older saved pages). A saved page with one of these
// is migrated to the Control Center id on load.
const ALIASES = {
  streamdeck: 'mk2',
  'streamdeck-mk2': 'mk2',
  'stream-deck': 'mk2',
  original: 'mk2',
  'streamdeck-mini': 'mini',
  'streamdeck-neo': 'neo',
  'streamdeck-xl': 'xl',
  'streamdeck-plus': 'plus',
  'streamdeck-plus-xl': 'plusxl',
  'plus-xl': 'plusxl',
  'plus_xl': 'plusxl',
  'sd-plus-xl': 'plusxl',
};

// Elgato device type numbers (SDK) and the names the plugin sends.
const TYPE_SURFACE = {
  0: 'mk2', 1: 'mini', 2: 'xl', 7: 'plus', 9: 'neo', 11: 'plusxl',
};

function canonicalSurfaceId(id) {
  const raw = String(id == null ? '' : id).trim();
  if (SURFACES[raw]) return raw;
  const lower = raw.toLowerCase();
  if (SURFACES[lower]) return lower;
  return ALIASES[lower] || null;
}

function surfaceById(id) {
  const key = canonicalSurfaceId(id);
  return key ? SURFACES[key] : null;
}

// Every control on the surface as { row, col, kind }, keys first, then the
// touch strip row, then the encoder row. Holes are simply missing cells.
function cellsOf(surface) {
  if (!surface) return [];
  const cells = [];
  for (let row = 0; row < surface.rows; row++) {
    for (let col = 0; col < surface.cols; col++) cells.push({ row, col, kind: 'key' });
  }
  const knobs = surface.knobCols || [];
  if (knobs.length) {
    for (const col of knobs) cells.push({ row: surface.rows, col, kind: 'touch' });
    for (const col of knobs) cells.push({ row: surface.rows + 1, col, kind: 'encoder' });
  }
  return cells;
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

module.exports = { SURFACES, ORDER, TYPE_SURFACE, ALIASES, canonicalSurfaceId, surfaceById, surfaceFor, cellsOf };
