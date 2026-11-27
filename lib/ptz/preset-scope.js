'use strict';
// Each PTZ preset remembers the recall scope that was in force when it was
// stored (A = PTZ + iris + WB/colour, B = PTZ + iris, C = PTZ only). A later
// recall sends that preset's own scope (OSE:71) before #R. There is no
// house-wide default scope (Steven).

const SCOPES = Object.freeze({
  '0': 'A',
  '1': 'B',
  '2': 'C',
});

function labelOf(code) {
  const k = String(code);
  return SCOPES[k] || null;
}

function createPresetScopes() {
  const byCam = new Map();

  function store(camId, preset, scope) {
    const n = Number(preset);
    if (!camId || !Number.isInteger(n) || n < 1) return null;
    const code = scope === undefined || scope === null || scope === '' ? null : String(scope);
    if (!byCam.has(camId)) byCam.set(camId, Object.create(null));
    const row = byCam.get(camId);
    if (code == null) delete row[n];
    else row[n] = code;
    return row[n] || null;
  }

  function scopeOf(camId, preset) {
    const row = byCam.get(camId);
    if (!row) return undefined;
    const n = Number(preset);
    if (!Object.prototype.hasOwnProperty.call(row, n)) return undefined;
    return row[n];
  }

  function badge(camId, preset) {
    const code = scopeOf(camId, preset);
    return labelOf(code);
  }

  function serialize() {
    const out = {};
    for (const [cam, row] of byCam) out[cam] = { ...row };
    return out;
  }

  function load(raw) {
    byCam.clear();
    if (!raw || typeof raw !== 'object') return;
    for (const [cam, row] of Object.entries(raw)) {
      if (!row || typeof row !== 'object') continue;
      for (const [n, code] of Object.entries(row)) store(cam, Number(n), code);
    }
  }

  return { store, scopeOf, badge, serialize, load, labelOf };
}

module.exports = { SCOPES, labelOf, createPresetScopes };
