'use strict';
// Grid math for the status wall. The editor and the server both use this so a
// saved tile lands on the same cells the operator dragged it to.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StatusGrid = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const COLS = 12;
  const MAX_ROW = 24;

  function clampInt(n, lo, hi, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(v)));
  }

  function clampTile(raw) {
    const w = clampInt(raw && raw.w, 1, COLS, 4);
    const h = clampInt(raw && raw.h, 1, 8, 2);
    const col = clampInt(raw && raw.col, 0, COLS - w, 0);
    const row = clampInt(raw && raw.row, 0, MAX_ROW, 0);
    return { col, row, w, h };
  }

  function cells(tile) {
    const out = [];
    for (let y = tile.row; y < tile.row + tile.h; y++) {
      for (let x = tile.col; x < tile.col + tile.w; x++) out.push(x + ',' + y);
    }
    return out;
  }

  function overlaps(tiles) {
    const seen = new Set();
    for (const tile of tiles || []) {
      for (const cell of cells(clampTile(tile))) {
        if (seen.has(cell)) return true;
        seen.add(cell);
      }
    }
    return false;
  }

  // First open rectangle for a new tile. Starts at 4 by 2, then smaller.
  function firstGap(tiles) {
    const occ = new Set();
    for (const tile of tiles || []) for (const cell of cells(clampTile(tile))) occ.add(cell);
    const shapes = [[4, 2], [3, 2], [2, 2], [4, 1], [2, 1]];
    for (const [w, h] of shapes) {
      for (let y = 0; y <= MAX_ROW - h; y++) {
        for (let x = 0; x <= COLS - w; x++) {
          let free = true;
          for (let dy = 0; dy < h && free; dy++) for (let dx = 0; dx < w; dx++) if (occ.has((x + dx) + ',' + (y + dy))) free = false;
          if (free) return { col: x, row: y, w, h };
        }
      }
    }
    return { col: 0, row: 0, w: 4, h: 2 };
  }

  return { COLS, MAX_ROW, clampInt, clampTile, overlaps, firstGap };
});
