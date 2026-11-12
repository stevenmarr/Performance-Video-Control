'use strict';
// Decks remembered in decks.json that are not on the live plugin or USB list.
// The mapping page shows these as offline. It does not invent a connected deck.
// "preview" is the USB layout stand-in, not a device that was ever stored on purpose.

function knownOffline({ stacks = {}, loaded = {}, sessions = {}, liveIds = [] } = {}) {
  const live = new Set((liveIds || []).filter(Boolean));
  const ids = new Set();
  const add = (id) => {
    const key = String(id || '');
    if (!key || key === 'preview' || key.startsWith('serial:')) return;
    ids.add(key);
  };
  for (const id of Object.keys(stacks || {})) add(id);
  for (const id of Object.keys(loaded || {})) add(id);
  for (const id of Object.keys(sessions || {})) add(id);
  return [...ids].filter((id) => !live.has(id)).sort().map((id) => ({
    id,
    name: id,
    model: null,
    surfaceId: null,
    online: false,
    source: 'stored',
  }));
}

// One encoder and one touch segment per knob column. Gaps stay empty so the
// strip lines up with the key grid (Stream Deck + and + XL).
function boardOf(surface) {
  if (!surface) return null;
  const cols = surface.cols;
  const rows = surface.rows;
  const knobCols = (surface.knobCols || []).slice();
  const keys = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) keys.push({ row, col, element: 'button' });
  }
  return {
    id: surface.id,
    label: surface.label,
    cols,
    rows,
    knobCols,
    encoders: knobCols.map((col) => ({ col, element: 'encoder' })),
    touch: knobCols.map((col) => ({ col, element: 'touch-segment' })),
    keys,
  };
}

module.exports = { knownOffline, boardOf };
