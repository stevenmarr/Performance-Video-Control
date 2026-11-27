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

module.exports = { PROFILE_DIR, BUILTIN_IDS, loadBuiltin, loadBuiltins, normHeld, heldKey, indexProfile, resolve, withIndex, factoryId };
