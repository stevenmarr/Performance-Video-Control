'use strict';
// 0.9.0 Stream Deck surface profiles for generated Companion pages.
// `layout` is the page surface layout id of Steven's Companion fork (shared-lib/lib/PageSurfaceLayout.ts);
// the cell coordinates below are the ones that layout uses, so a page drawn for a profile lines up with the device.
//   keys      rows 0..rows-1, cols 0..cols-1
//   strip     the LCD touch strip, one cell per knob (row stripRow, the knob columns)
//   knobs     the encoders (row knobRow, the knob columns)

const PROFILES = {
  xl: { id: 'xl', label: 'Stream Deck XL', short: 'XL', layout: 'streamdeck-xl', cols: 8, rows: 4, knobCols: [], stripRow: null, knobRow: null },
  mk2: { id: 'mk2', label: 'Stream Deck MK.2 / original (15 keys)', short: 'MK2', layout: 'streamdeck', cols: 5, rows: 3, knobCols: [], stripRow: null, knobRow: null },
  plus: { id: 'plus', label: 'Stream Deck +', short: 'SD+', layout: 'streamdeck-plus', cols: 4, rows: 2, knobCols: [0, 1, 2, 3], stripRow: 2, knobRow: 3 },
  plusxl: { id: 'plusxl', label: 'Stream Deck + XL', short: 'SD+XL', layout: 'streamdeck-plus-xl', cols: 9, rows: 4, knobCols: [0, 2, 3, 5, 6, 8], stripRow: 4, knobRow: 5 },
};
const ORDER = ['xl', 'mk2', 'plus', 'plusxl'];

const hasKnobs = (p) => p.knobCols.length > 0;
// the Companion grid a page needs for this surface (inclusive bounds, like a page's gridSize)
function gridSize(p) {
  const rows = hasKnobs(p) ? p.knobRow + 1 : p.rows;
  return { minColumn: 0, maxColumn: p.cols - 1, minRow: 0, maxRow: rows - 1 };
}

// Accepts 'xl,mk2', ['plus'], 'all', aliases ('+', 'plus-xl', 'streamdeck-xl' …). Unknown names throw.
const ALIASES = { xl: 'xl', 'streamdeck-xl': 'xl', mk2: 'mk2', 'mk.2': 'mk2', mk: 'mk2', original: 'mk2', streamdeck: 'mk2', '15': 'mk2',
  plus: 'plus', '+': 'plus', 'streamdeck-plus': 'plus', sdplus: 'plus', plusxl: 'plusxl', 'plus-xl': 'plusxl', '+xl': 'plusxl', 'streamdeck-plus-xl': 'plusxl' };
function parseSurfaces(v) {
  if (v === undefined || v === null || v === '' || v === 'all') return [...ORDER];
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const s of list) {
    if (s === 'all') { for (const k of ORDER) if (!out.includes(k)) out.push(k); continue; }
    const k = ALIASES[s];
    if (!k) { const e = new Error(`Unknown surface "${s}" (use ${ORDER.join(', ')})`); e.status = 400; throw e; }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

module.exports = { PROFILES, ORDER, gridSize, hasKnobs, parseSurfaces };
