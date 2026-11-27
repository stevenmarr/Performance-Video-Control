'use strict';
// Remember the camera's scene-file values so a long-press reset can restore
// that look, per knob, instead of a hard-coded centre. The cameras have no
// "read stored scene value without recalling" command (COMMANDS.md §5).
// Values are cached from update notifications after a scene recall, or from
// a camdata / catalog read taken right after the recall.

function createSceneBaseline() {
  const byCam = new Map();

  function bucket(camId) {
    const id = String(camId || '');
    if (!byCam.has(id)) byCam.set(id, { scene: null, at: 0, values: Object.create(null), source: null });
    return byCam.get(id);
  }

  function remember(camId, values, meta = {}) {
    if (!camId || !values || typeof values !== 'object') return bucket(camId);
    const b = bucket(camId);
    if (meta.scene !== undefined && meta.scene !== null && meta.scene !== '') b.scene = String(meta.scene);
    b.at = meta.at || Date.now();
    b.source = meta.source || b.source || 'poll';
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      b.values[k] = v;
    }
    return b;
  }

  function sceneValue(camId, opId) {
    const b = byCam.get(String(camId || ''));
    if (!b) return undefined;
    const id = String(opId || '');
    if (!Object.prototype.hasOwnProperty.call(b.values, id)) return undefined;
    return b.values[id];
  }

  function snapshot(camId) {
    const b = byCam.get(String(camId || ''));
    if (!b) return null;
    return { scene: b.scene, at: b.at, source: b.source, values: { ...b.values } };
  }

  function clear(camId) {
    if (camId == null) { byCam.clear(); return; }
    byCam.delete(String(camId));
  }

  return { remember, sceneValue, snapshot, clear, _byCam: byCam };
}

// Parse one camera update-notification line, e.g. "OSA:30:80" or "OSA:30:0x80".
// Returns { key, data } or null.
function parseNotifyLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const m = s.match(/^(O[A-Z]{2}:[0-9A-F]{2}|O[A-Z]{2}|O[A-Z]{1,3}):\s*([0-9A-Fxh]+)\b/i);
  if (!m) return null;
  return { key: m[1].toUpperCase(), data: m[2].replace(/^0x/i, '').replace(/h$/i, '') };
}

module.exports = { createSceneBaseline, parseNotifyLine };
