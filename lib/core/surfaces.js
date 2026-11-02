'use strict';
// Which Stream Deck, and which keys on it, belong to Control Center or to Companion.
// A whole deck owned by Companion is released (Companion opens the USB device).
// A region owned by Companion stays on our USB device; those keys are reserved
// and are not native actions. Drawing Companion's own pictures on those keys
// is phase 2 (a satellite). Feedback Companion posts is stored on the connection.

function inRegion(region, col, row) {
  if (!region) return true;
  if (Array.isArray(region.keys) && region.keys.length) {
    return region.keys.some((k) => k.col === col && k.row === row);
  }
  const rowOk = !region.row || (row >= region.row[0] && row <= region.row[1]);
  const colOk = !region.col || (col >= region.col[0] && col <= region.col[1]);
  return rowOk && colOk;
}

function createSurfaces(store, onChange) {
  function profile() {
    const id = store.activeProfile && store.profiles[store.activeProfile] ? store.activeProfile : 'show';
    return store.profiles[id];
  }
  function bindingsFor(surfaceId) {
    return profile().bindings.filter((b) => b.surfaceId === surfaceId);
  }
  const api = {
    snapshot() {
      const p = profile();
      return {
        active: p.id,
        name: p.name,
        profiles: Object.values(store.profiles).map((x) => ({ id: x.id, name: x.name, bindings: x.bindings.length })),
        bindings: p.bindings.map((b) => ({ ...b })),
        focus: { ...p.focus },
      };
    },
    profile: () => profile(),
    list: () => Object.values(store.profiles).map((p) => ({ id: p.id, name: p.name })),
    activate(id) {
      if (!store.profiles[id]) { const e = new Error(`No console profile "${id}"`); e.status = 404; throw e; }
      store.activeProfile = id;
      onChange();
      return api.snapshot();
    },
    saveAs(id, name) {
      const cur = profile();
      const nextId = String(id || '').replace(/[^\w:-]/g, '').slice(0, 80);
      if (!nextId) { const e = new Error('Profile id is required'); e.status = 400; throw e; }
      store.profiles[nextId] = {
        id: nextId,
        name: String(name || cur.name || 'Show').slice(0, 40),
        bindings: JSON.parse(JSON.stringify(cur.bindings)),
        focus: { ...cur.focus },
      };
      store.activeProfile = nextId;
      onChange();
      return api.snapshot();
    },
    useShow(showId) {
      const key = showId ? `show:${String(showId).replace(/[^\w:-]/g, '').slice(0, 60)}` : 'show';
      if (!store.profiles[key]) {
        store.profiles[key] = { id: key, name: showId ? `Show ${showId}` : 'Show', bindings: [], focus: {} };
      }
      store.activeProfile = key;
      onChange();
      return api.snapshot();
    },
    bind(input) {
      const { cleanBinding } = require('./persist');
      const row = cleanBinding({ ...input, id: input.id });
      if (!row) { const e = new Error('A binding needs a surfaceId'); e.status = 400; throw e; }
      const p = profile();
      const same = p.bindings.findIndex((b) => b.surfaceId === row.surfaceId && JSON.stringify(b.region) === JSON.stringify(row.region));
      if (same >= 0) p.bindings[same] = { ...p.bindings[same], ...row, id: p.bindings[same].id };
      else p.bindings.push(row);
      onChange();
      return row;
    },
    loadFromShow(raw) {
      const { cleanProfile } = require('./persist');
      const id = String((raw && raw.id) || 'show').replace(/[^\w:-]/g, '').slice(0, 80) || 'show';
      store.profiles[id] = cleanProfile(raw, id);
      store.activeProfile = id;
      onChange();
      return api.snapshot();
    },
    unbind(id) {
      const p = profile();
      const before = p.bindings.length;
      p.bindings = p.bindings.filter((b) => b.id !== id);
      if (p.bindings.length === before) { const e = new Error(`No binding "${id}"`); e.status = 404; throw e; }
      onChange();
      return { ok: true };
    },
    setFocus(surfaceId, instanceId) {
      const p = profile();
      if (!surfaceId) return p.focus;
      if (!instanceId) delete p.focus[surfaceId];
      else p.focus[String(surfaceId).slice(0, 200)] = String(instanceId).slice(0, 80);
      onChange();
      return { ...p.focus };
    },
    // 'companion' = the whole deck. 'shared' = some keys. 'native' = ours.
    deckOwner(surfaceId) {
      const list = bindingsFor(String(surfaceId || ''));
      const whole = list.find((b) => !b.region);
      const regions = list.filter((b) => b.region);
      if (whole && whole.owner === 'companion' && !regions.length) return 'companion';
      if ((whole && whole.owner === 'companion') || regions.some((b) => b.owner === 'companion')) return 'shared';
      return 'native';
    },
    keyOwner(surfaceId, col, row) {
      const list = bindingsFor(String(surfaceId || ''));
      let hit = null;
      for (const b of list) {
        if (!b.region) { if (!hit) hit = b; continue; }
        if (inRegion(b.region, Number(col), Number(row))) hit = b;
      }
      return hit ? hit.owner : 'native';
    },
  };
  return api;
}

module.exports = { createSurfaces, inRegion };
