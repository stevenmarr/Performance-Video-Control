'use strict';
// Device facade: every call here maps to a command printed in the AW guides.
// Page refs: AWJ = AWJ Programmer's Guide v6.2 (printed page numbers), REST = REST Programmer's Guide v4.01.
const { RestClient, API } = require('./rest');
const { AwjClient } = require('./awj');

function parseDest(key) {
  const m = /^([SA])(\d+)$/.exec(String(key || '').toUpperCase());
  if (!m) throw new Error(`Bad destination key "${key}" (expected S<n> or A<n>)`);
  return { key: `${m[1]}${Number(m[2])}`, kind: m[1] === 'S' ? 'screen' : 'aux', id: Number(m[2]) };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

class Device {
  constructor(settings, log) {
    this.log = log || (() => {});
    this.configure(settings);
  }

  configure(s) {
    this.s = { ...s };
    if (this.awj) this.awj.close();
    this.rest = new RestClient({ host: s.host, port: s.restPort, https: s.https, password: s.password, log: this.log });
    this.awj = new AwjClient({ host: s.host, port: s.awjPort, log: this.log });
  }

  close() { if (this.awj) this.awj.close(); }

  get useAwj() { return this.s.protocol === 'awj'; }

  // ---------- identity ----------
  async getSystem() {
    try {
      return await this.rest.get(`${API}/system`); // REST p.7
    } catch (e) {
      if (!this.useAwj) throw e;
      const dev = await this.awj.get('DeviceObject/system/$device/@items/1/@props/dev'); // AWJ p.6
      const ver = await this.awj.get('DeviceObject/system/$device/@items/1/version/@props/updater'); // AWJ p.7
      return { type: dev, version: ver };
    }
  }

  // ---------- destinations ----------
  async listDestinations({ maxScreens = 24, maxAux = 20 } = {}) {
    const keys = [];
    for (let i = 1; i <= maxScreens; i++) keys.push(`S${i}`);
    for (let i = 1; i <= maxAux; i++) keys.push(`A${i}`);
    let restWorked = false; let lastErr = null;
    const rows = await pool(keys, 8, async (key) => {
      const d = parseDest(key);
      const path = d.kind === 'screen' ? `${API}/screens/${d.id}` : `${API}/auxiliary-screens/${d.id}`; // REST p.11 / p.21
      try {
        const r = await this.rest.get(path);
        restWorked = true;
        const enabled = r && (r.isEnabled ?? r.IsEnabled);
        if (!enabled) return null;
        return { key: d.key, kind: d.kind, id: d.id, label: (r.label || '').trim() || `${d.kind === 'screen' ? 'Screen' : 'Aux'} ${d.id}` };
      } catch (e) {
        if (e.status && e.status !== 401) restWorked = true; // 404 for unknown index is expected
        lastErr = e; return null;
      }
    });
    if (!restWorked) {
      if (!this.useAwj) throw lastErr || new Error('REST unreachable');
      return this._listDestinationsAwj(maxScreens, maxAux);
    }
    return rows.filter(Boolean);
  }

  async _listDestinationsAwj(maxScreens, maxAux) {
    const out = [];
    for (let i = 1; i <= maxScreens; i++) {
      try {
        const mode = await this.awj.get(`DeviceObject/preconfig/resources/new/$screen/@items/S${i}/control/@props/mode`); // AWJ p.8
        if (mode === 'DISABLED') continue;
        const label = await this.awj.get(`DeviceObject/$screen/@items/S${i}/control/@props/label`); // AWJ p.8
        out.push({ key: `S${i}`, kind: 'screen', id: i, label: label || `Screen ${i}` });
      } catch { /* not present */ }
    }
    for (let i = 1; i <= maxAux; i++) {
      try {
        // AWJ p.8 documents the aux label only; aux enable state is not documented over AWJ.
        const label = await this.awj.get(`DeviceObject/$auxiliary/@items/A${i}/control/@props/label`);
        out.push({ key: `A${i}`, kind: 'aux', id: i, label: label || `Aux ${i}` });
      } catch { /* not present */ }
    }
    return out;
  }

  // ---------- memory recall ----------
  async loadMemory(destKey, memoryId, target = 'preview') {
    const d = parseDest(destKey); const slot = Number(memoryId);
    if (!(slot >= 1 && slot <= 1000)) throw new Error(`Screen memory slot ${memoryId} out of range 1-1000 (REST p.12)`);
    if (this.useAwj) {
      const coll = d.kind === 'screen' ? '$screen' : '$auxiliary';
      const pv = target === 'program' ? 'PROGRAM' : 'PREVIEW';
      // AWJ p.9 (screen and aux examples)
      return this.awj.replace(`DeviceObject/presetBank/control/load/$slot/@items/${slot}/${coll}/@items/${d.key}/$preset/@items/${pv}/@props/xRequest`, true);
    }
    const path = d.kind === 'screen' ? `${API}/screens/${d.id}/load-memory` : `${API}/auxiliary-screens/${d.id}/load-memory`; // REST p.12 / p.22
    return this.rest.post(path, { memoryId: slot, target: target === 'program' ? 'program' : 'preview' });
  }

  // ---------- transitions ----------
  async take(destKeys) {
    const ds = destKeys.map(parseDest);
    if (!ds.length) return;
    if (this.useAwj) {
      for (const d of ds) {
        // AWJ p.9 documents S1. The A<n> item under $screenAuxGroup is inferred from the same collection name (UNVERIFIED for aux).
        await this.awj.replace(`DeviceObject/$screenAuxGroup/@items/${d.key}/control/@props/xTake`, true);
      }
      return;
    }
    const screenIds = ds.filter((d) => d.kind === 'screen').map((d) => d.id);
    const auxIds = ds.filter((d) => d.kind === 'aux').map((d) => d.id);
    try {
      // REST p.20. Key spelled as in the parameter table and C# sample; the raw-TCP sample has a stray trailing space.
      return await this.rest.post(`${API}/take`, { screenIds, auxiliaryScreenIds: auxIds });
    } catch (e) {
      this.log('warn', `Global TAKE failed (${e.message}); falling back to per-destination TAKE`);
      for (const d of ds) {
        const path = d.kind === 'screen' ? `${API}/screens/${d.id}/take` : `${API}/auxiliary-screens/${d.id}/take`; // REST p.19 / p.26
        await this.rest.post(path);
      }
    }
  }

  // ---------- readback ----------
  // Which side (A/B) is Preview for this destination. AWJ p.13: AT_DOWN -> PGM=A, PVW=B; AT_UP -> PGM=B, PVW=A.
  async previewSide(destKey) {
    const d = parseDest(destKey);
    const t = await this.awj.get(`DeviceObject/$screenAuxGroup/@items/${d.key}/status/@props/transition`); // AWJ p.13 (S1 example)
    return t === 'AT_UP' ? 'A' : 'B';
  }

  // Last Screen memory recalled to this destination's Preview (AWJ p.16). Needs AWJ enabled.
  async readPreviewMemoryId(destKey) {
    const d = parseDest(destKey);
    const side = await this.previewSide(destKey);
    const coll = d.kind === 'screen' ? '$screen' : '$auxiliary';
    const id = await this.awj.get(`DeviceObject/presetBank/status/presetId/${coll}/@items/${d.key}/$preset/@items/${side}/@props/id`);
    const n = Number(id);
    return n >= 1 ? n : null;
  }

  // Layer sources + background on a destination (REST p.15, p.17; aux p.24). Position/size/opacity are NOT documented.
  async readSources(destKey, target = 'preview', maxLayers = 8) {
    const d = parseDest(destKey);
    const layers = [];
    const layerIds = Array.from({ length: d.kind === 'aux' ? Math.min(maxLayers, 8) : maxLayers }, (_, i) => i + 1);
    await pool(layerIds, 4, async (L) => {
      const path = d.kind === 'screen'
        ? `${API}/screens/${d.id}/layers/${L}/presets/${target}`
        : `${API}/auxiliary-screens/${d.id}/layers/${L}/presets/${target}/source`;
      try {
        const r = await this.rest.get(path);
        if (r && r.sourceType) layers.push({ layer: L, sourceType: r.sourceType, sourceId: r.sourceId ?? null, status: r.status });
      } catch (e) { if (e.status === 401) throw e; /* layer not allocated */ }
    });
    layers.sort((a, b) => a.layer - b.layer);
    let background = null;
    if (d.kind === 'screen') {
      try {
        const r = await this.rest.get(`${API}/screens/${d.id}/background-layer/presets/${target}`);
        if (r && r.sourceType) background = { sourceType: r.sourceType, sourceId: r.sourceId ?? null };
      } catch (e) { if (e.status === 401) throw e; }
    }
    return { layers, background };
  }

  // Write a source snapshot to a destination (REST p.16, p.18; aux p.24-25), then nothing else is required for REST.
  async writeSources(destKey, snap, target = 'preview') {
    const d = parseDest(destKey);
    for (const l of snap.layers || []) {
      const body = { sourceType: l.sourceType };
      if (l.sourceType !== 'none' && l.sourceId != null) body.sourceId = l.sourceId;
      const path = d.kind === 'screen'
        ? `${API}/screens/${d.id}/layers/${l.layer}/presets/${target}/source`
        : `${API}/auxiliary-screens/${d.id}/layers/${l.layer}/presets/${target}/source`;
      await this.rest.post(path, body);
    }
    if (d.kind === 'screen' && snap.background) {
      const body = { sourceType: snap.background.sourceType };
      if (snap.background.sourceType !== 'none' && snap.background.sourceId != null) body.sourceId = snap.background.sourceId;
      await this.rest.post(`${API}/screens/${d.id}/background-layer/presets/${target}/source`, body);
    }
  }
}

module.exports = { Device, parseDest };
