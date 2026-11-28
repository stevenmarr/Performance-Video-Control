'use strict';
// Resolve a TourBox control + held modifiers + event (turn / press / long) to a
// Control Center action. Profiles are data. The driver never hard-codes "this is PTZ".
const fs = require('fs');
const path = require('path');
const P = require('./protocol');

const PROFILE_DIR = path.join(__dirname, 'profiles');
const BUILTIN_IDS = ['ptz-rcp', 'ptz-msu'];

function loadBuiltin(id) {
  const file = path.join(PROFILE_DIR, `${id}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadBuiltins() {
  return Object.fromEntries(BUILTIN_IDS.map((id) => [id, loadBuiltin(id)]));
}

function normHeld(held) {
  const list = held == null ? [] : Array.isArray(held) ? held : [...held];
  const set = new Set(list.map((h) => String(h).toLowerCase()).filter((h) => P.MODIFIERS.includes(h)));
  return P.MODIFIERS.filter((m) => set.has(m));
}

function heldKey(held) {
  return normHeld(held).join('+');
}

function indexProfile(profile) {
  const map = new Map();
  for (const row of (profile && profile.bindings) || []) {
    const control = String(row.control || '').toLowerCase();
    if (!P.CONTROLS.includes(control)) continue;
    map.set(`${control}|${heldKey(row.held)}`, row);
  }
  return map;
}

// Longest matching modifier set wins. A binding with no modifiers is the home layer.
function resolve(profile, control, event, held) {
  const id = String(control || '').toLowerCase();
  const ev = event === 'long' || event === 'reset' ? 'long' : (event === 'turn' ? 'turn' : 'press');
  const index = profile && profile._index ? profile._index : indexProfile(profile);
  const want = new Set(normHeld(held).filter((h) => h !== id));
  let best = null;
  let bestN = -1;
  for (const [key, row] of index) {
    if (!key.startsWith(`${id}|`)) continue;
    const need = normHeld(row.held);
    if (need.some((m) => !want.has(m))) continue;
    if (need.length > bestN) { best = row; bestN = need.length; }
  }
  if (!best) return null;
  const binding = ev === 'turn' ? best.turn : (ev === 'long' ? best.long : best.press);
  if (!binding || binding.action === 'none' || binding.action === '') return null;
  return { control: id, event: ev, held: normHeld(best.held), binding, row: best };
}

function withIndex(profile) {
  const copy = { ...profile, bindings: (profile.bindings || []).map((b) => ({ ...b })) };
  copy._index = indexProfile(copy);
  return copy;
}

function factoryId(id) {
  return BUILTIN_IDS.includes(id) ? id : 'ptz-rcp';
}

const ACTION_CATALOG = Object.freeze([
  { id: 'none', label: '— none —', events: ['turn', 'press', 'long'] },
  { id: 'ptz.step', label: 'PTZ step', events: ['turn'], fields: ['op', 'target', 'velocity'] },
  { id: 'ptz.toggle', label: 'PTZ toggle', events: ['press', 'long'], fields: ['op', 'target'] },
  { id: 'ptz.reset', label: 'PTZ reset', events: ['press', 'long'], fields: ['op', 'target'] },
  { id: 'ptz.rate', label: 'PTZ zoom / focus rate', events: ['turn'], fields: ['axis', 'target'] },
  { id: 'ptz.dialPair', label: 'PTZ swap dial pair', events: ['press'], fields: ['target'] },
  { id: 'ptz.resetActiveDial', label: 'PTZ reset active dial', events: ['long', 'press'], fields: ['target'] },
  { id: 'ptz.oneTouchAF', label: 'PTZ one-touch AF', events: ['press'], fields: ['target'] },
  { id: 'ptz.presetStep', label: 'PTZ next / prev preset', events: ['press'], fields: ['dir', 'target'] },
  { id: 'ptz.sceneStep', label: 'PTZ next / prev scene', events: ['press'], fields: ['dir', 'target'] },
  { id: 'ptz.stop', label: 'PTZ stop', events: ['press', 'long'], fields: ['target'] },
  { id: 'ptz.stopAll', label: 'PTZ stop all', events: ['press', 'long'], fields: [] },
  { id: 'ptz.copyPaint', label: 'PTZ copy paint', events: ['press'], fields: ['target'] },
  { id: 'ptz.compare', label: 'PTZ compare (reserved)', events: ['press'], fields: [] },
  { id: 'tourbox.profile', label: 'Switch TourBox profile', events: ['press', 'long'], fields: ['profile'] },
  { id: 'tourbox.bank', label: 'TourBox paint bank', events: ['press'], fields: ['bank'] },
  { id: 'tourbox.msuPair', label: 'MSU pair step', events: ['press'], fields: ['dir'] },
  { id: 'tourbox.gangToggle', label: 'MSU gang toggle', events: ['press'], fields: [] },
]);

const TARGETS = Object.freeze(['selected', 'msu-a', 'msu-b', 'pair', 'gang', 'all']);
const OPS = Object.freeze([
  'iris', 'irisMode', 'gain', 'shutterStep', 'ndFilter', 'masterPed', 'pictureLevel',
  'rGain', 'bGain', 'rPed', 'bPed', 'gPed', 'chromaLevel', 'gamma', 'kneePoint', 'kneeMode',
  'masterDetail', 'detail', 'focusMode',
]);
const BANKS = Object.freeze(['white', 'black', 'tone']);
const AXES = Object.freeze(['zoom', 'focus']);

function cleanAction(raw, event) {
  if (!raw || raw.action === 'none' || raw.action === '' || raw.action == null) return null;
  const action = String(raw.action);
  const spec = ACTION_CATALOG.find((a) => a.id === action);
  if (!spec || (spec.events && !spec.events.includes(event))) return null;
  const out = { action };
  for (const f of spec.fields || []) {
    if (raw[f] === undefined || raw[f] === null || raw[f] === '') continue;
    out[f] = raw[f];
  }
  if (raw.velocity === false) out.velocity = false;
  if (raw.velocity === true) out.velocity = true;
  if (raw.clamp) out.clamp = true;
  if (raw.auto) out.auto = true;
  if (raw.guarded) out.guarded = true;
  if (raw.liveGuard) out.liveGuard = raw.liveGuard;
  if (Array.isArray(raw.ops)) out.ops = raw.ops.map(String);
  if (Array.isArray(raw.axes)) out.axes = raw.axes.map(String);
  if (raw.dir != null && Number.isFinite(Number(raw.dir))) out.dir = Number(raw.dir) < 0 ? -1 : 1;
  if (out.target && !TARGETS.includes(String(out.target))) out.target = 'selected';
  if (out.op) out.op = String(out.op);
  if (out.profile) out.profile = factoryId(out.profile);
  if (out.bank && !BANKS.includes(String(out.bank))) delete out.bank;
  if (out.axis && !AXES.includes(String(out.axis))) out.axis = 'zoom';
  return out;
}

function cleanBinding(raw = {}) {
  const control = String(raw.control || '').toLowerCase();
  if (!P.CONTROLS.includes(control)) return null;
  const held = normHeld(raw.held);
  const row = { control, held };
  const turn = cleanAction(raw.turn, 'turn');
  const press = cleanAction(raw.press, 'press');
  const long = cleanAction(raw.long, 'long');
  if (turn) row.turn = turn;
  if (press) row.press = press;
  if (long) row.long = long;
  return row;
}

function cleanBindings(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const row = cleanBinding(raw);
    if (!row) continue;
    const key = `${row.control}|${heldKey(row.held)}`;
    if (seen.has(key)) {
      const i = out.findIndex((b) => `${b.control}|${heldKey(b.held)}` === key);
      if (i >= 0) out[i] = row;
    } else {
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function setBinding(profile, patch) {
  const row = cleanBinding(patch);
  if (!row) return profile;
  const bindings = cleanBindings(profile && profile.bindings);
  const key = `${row.control}|${heldKey(row.held)}`;
  const i = bindings.findIndex((b) => `${b.control}|${heldKey(b.held)}` === key);
  if (i >= 0) bindings[i] = row;
  else bindings.push(row);
  return withIndex({ ...(profile || {}), bindings });
}

function serializeProfile(profile) {
  return {
    id: profile && profile.id,
    name: profile && profile.name,
    system: profile && profile.system,
    bindings: cleanBindings(profile && profile.bindings),
  };
}

function catalog() {
  return { actions: ACTION_CATALOG, targets: TARGETS, ops: OPS, banks: BANKS, axes: AXES, controls: P.CONTROLS, modifiers: P.MODIFIERS };
}

module.exports = {
  PROFILE_DIR, BUILTIN_IDS, loadBuiltin, loadBuiltins, normHeld, heldKey, indexProfile, resolve, withIndex, factoryId,
  ACTION_CATALOG, TARGETS, OPS, BANKS, AXES, cleanAction, cleanBinding, cleanBindings, setBinding, serializeProfile, catalog,
};
