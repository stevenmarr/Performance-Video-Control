'use strict';
// 0.3.3: preset names. A preset's stored `name` is what the user typed. Empty, or a generic "Preset <n>"
// (what 0.1-0.3.2 wrote when no name was typed), means "automatic": the displayed name is derived from the
// device memory names the preset holds, so it follows renames on the device.
const MAX = 64;
const GENERIC = /^\s*(preset\s*#?\s*\d*)?\s*$/i;

function isGenericName(name) { return name == null || GENERIC.test(String(name)); }
function customName(p) { return p && !isGenericName(p.name) ? String(p.name).trim().slice(0, MAX) : ''; }

const order = (k) => { const m = /^([A-Z]+)(\d+)$/.exec(k) || [, k, 0]; return [m[1] === 'S' ? 0 : m[1] === 'A' ? 1 : 2, Number(m[2])]; };
const sortKeys = (ks) => [...ks].sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1] - y[1]; });

// labels: { screen: {slot: label}, master: {...}, multiviewer: {...} } (device memory names, AWJ §3.7)
function derivedName(p, labels = {}) {
  if (!p) return '';
  const L = (kind, slot) => String(((labels[kind] || {})[slot]) || '').trim();
  const parts = [];
  const add = (s) => { if (s && !parts.includes(s)) parts.push(s); };
  if (p.master && p.master.slot) add(L('master', p.master.slot) || `Master ${p.master.slot}`);
  const mem = p.memories || {};
  for (const d of sortKeys(Object.keys(mem))) add(L('screen', mem[d]) || `${d}:M${mem[d]}`);
  for (const d of sortKeys(p.destinations || [])) if (!mem[d] && p.sources && p.sources[d] && (p.sources[d].layers || []).length) add(`${d} snapshot`);
  const mv = p.mvMemories || {};
  for (const k of sortKeys(Object.keys(mv))) add(L('multiviewer', mv[k]) || `MV${String(k).replace(/^M/, '')}:M${mv[k]}`);
  let s = parts.join(' + ');
  if (s.length > MAX) { const head = []; for (const x of parts) { if ([...head, x, '…'].join(' + ').length > MAX) break; head.push(x); } s = head.length ? `${head.join(' + ')} + …` : s.slice(0, MAX - 1) + '…'; }
  return s;
}

function displayName(p, labels) { return customName(p) || derivedName(p, labels) || `Preset ${p.number}`; }

// What to store for a name the user submitted (or didn't). `proposed` is the preset content after the save.
// Returns '' (automatic) when the name is blank, generic, or the derived default left unchanged.
function nameToStore(submitted, existing, proposed, labels) {
  if (submitted === undefined || submitted === null) return customName(existing);
  const t = String(submitted).trim().slice(0, MAX);
  if (!t || isGenericName(t)) return '';
  if (t === derivedName(proposed, labels)) return '';
  return t;
}

module.exports = { isGenericName, customName, derivedName, displayName, nameToStore, MAX };
