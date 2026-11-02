'use strict';
// Console file: profiles, module enable flags, panel pin, Companion connections.
// Lives next to systems.json. It is not inside the show file (that would change
// show hashes). The active profile follows the open show id when one exists.
const { readJson, writeJsonAtomic } = require('../store');

const OWNERS = ['native', 'companion'];

function cleanRegion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (Array.isArray(raw.row) && raw.row.length === 2) {
    const a = Math.round(Number(raw.row[0])); const b = Math.round(Number(raw.row[1]));
    if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a && b <= 31) out.row = [a, b];
  }
  if (Array.isArray(raw.col) && raw.col.length === 2) {
    const a = Math.round(Number(raw.col[0])); const b = Math.round(Number(raw.col[1]));
    if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a && b <= 31) out.col = [a, b];
  }
  if (Array.isArray(raw.keys)) {
    out.keys = raw.keys.slice(0, 64).map((k) => ({
      col: Math.max(0, Math.min(31, Math.round(Number(k && k.col) || 0))),
      row: Math.max(0, Math.min(31, Math.round(Number(k && k.row) || 0))),
    }));
  }
  return Object.keys(out).length ? out : null;
}

function cleanBinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const surfaceId = String(raw.surfaceId || '').trim().slice(0, 200);
  if (!surfaceId) return null;
  const owner = OWNERS.includes(raw.owner) ? raw.owner : 'native';
  return {
    id: String(raw.id || `b${Date.now().toString(36)}`).replace(/[^\w-]/g, '').slice(0, 40) || `b${Date.now().toString(36)}`,
    surfaceId,
    region: cleanRegion(raw.region),
    owner,
    instanceId: raw.instanceId ? String(raw.instanceId).slice(0, 80) : null,
    companionId: raw.companionId ? String(raw.companionId).slice(0, 80) : null,
  };
}

function cleanProfile(raw, id) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const bindings = [];
  for (const b of Array.isArray(src.bindings) ? src.bindings : []) {
    const c = cleanBinding(b);
    if (c) bindings.push(c);
    if (bindings.length >= 64) break;
  }
  const focus = {};
  if (src.focus && typeof src.focus === 'object') {
    for (const [k, v] of Object.entries(src.focus)) {
      if (bindings.length > 80) break;
      const idOk = String(k).slice(0, 200);
      if (idOk && v) focus[idOk] = String(v).slice(0, 80);
    }
  }
  return { id, name: String(src.name || 'Show').trim().slice(0, 40) || 'Show', bindings, focus };
}

function cleanConnection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const moduleId = String(raw.moduleId || '').trim().slice(0, 80);
  if (!moduleId) return null;
  return {
    id: String(raw.id || `c${Date.now().toString(36)}`).replace(/[^\w-]/g, '').slice(0, 40),
    moduleId,
    label: String(raw.label || moduleId).trim().slice(0, 40) || moduleId,
    host: String(raw.host || '').trim().slice(0, 200),
    port: Number(raw.port) > 0 && Number(raw.port) < 65536 ? Math.round(Number(raw.port)) : 0,
    note: String(raw.note || '').slice(0, 200),
  };
}

function defaults() {
  return {
    version: 1,
    activeProfile: 'show',
    profiles: { show: { id: 'show', name: 'Show', bindings: [], focus: {} } },
    modules: {},
    panel: { locked: false, safe: false, pin: '' },
    services: {
      speakerTimer: { enabled: true },
      smb: { enabled: true },
      companion: { enabled: true },
    },
    companion: { connections: [] },
  };
}

function load(file) {
  const raw = readJson(file, null);
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  const profiles = {};
  const src = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
  for (const [id, p] of Object.entries(src)) {
    const cleanId = String(id).replace(/[^\w:-]/g, '').slice(0, 80);
    if (!cleanId) continue;
    profiles[cleanId] = cleanProfile(p, cleanId);
    if (Object.keys(profiles).length >= 32) break;
  }
  if (!profiles.show) profiles.show = cleanProfile(null, 'show');
  const modules = {};
  if (raw.modules && typeof raw.modules === 'object') {
    for (const [id, on] of Object.entries(raw.modules)) {
      if (on === false) modules[String(id).slice(0, 80)] = false;
    }
  }
  const connections = [];
  const list = raw.companion && Array.isArray(raw.companion.connections) ? raw.companion.connections : [];
  for (const c of list) {
    const row = cleanConnection(c);
    if (row) connections.push(row);
    if (connections.length >= 32) break;
  }
  const panel = raw.panel && typeof raw.panel === 'object' ? raw.panel : {};
  return {
    version: 1,
    activeProfile: profiles[raw.activeProfile] ? String(raw.activeProfile) : 'show',
    profiles,
    modules,
    panel: { locked: false, safe: !!panel.safe, pin: typeof panel.pin === 'string' ? panel.pin.slice(0, 32) : '' },
    services: {
      speakerTimer: { enabled: !(raw.services && raw.services.speakerTimer && raw.services.speakerTimer.enabled === false) },
      smb: { enabled: !(raw.services && raw.services.smb && raw.services.smb.enabled === false) },
      companion: { enabled: !(raw.services && raw.services.companion && raw.services.companion.enabled === false) },
    },
    companion: { connections },
  };
}

function save(file, data) {
  const copy = JSON.parse(JSON.stringify(data));
  copy.panel = { ...copy.panel, locked: false };
  writeJsonAtomic(file, copy);
}

module.exports = { load, save, defaults, cleanBinding, cleanRegion, cleanConnection, cleanProfile, OWNERS };
