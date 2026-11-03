'use strict';
// Button mappings for the ATEM switcher page. A slot points at a source,
// a macro, or a Control Center memory. The same map is used on every M/E
// unless the ATEM view says bus mapping is per M/E.

const FLEX = 7;
const SLOTS = 16;
const EFFECTS = ['MIX', 'DIP', 'WIPE', 'DVE', 'STING'];
const EFFECT_STYLE = { MIX: 'MIX', DIP: 'DIP', WIPE: 'WIPE', DVE: 'DVE', STING: 'STING' };
const WIPES = ['L-R', 'R-L', 'T-B', 'B-T', 'TL', 'TR', 'BL', 'BR', 'CIRCLE', 'BOX', 'DIAMOND', 'CROSS', 'BARS', 'DIAG', 'CLOCK', 'IRIS', 'SQUARE', 'CORNER'];

function emptyFlex() {
  return [
    Array.from({ length: FLEX }, (_, i) => ({ kind: 'macro', id: i })),
    Array.from({ length: FLEX }, (_, i) => ({ kind: 'memory', id: i + 1 })),
    Array.from({ length: FLEX }, () => ({ kind: 'none', id: 0 })),
    Array.from({ length: FLEX }, () => ({ kind: 'none', id: 0 })),
  ];
}

function cleanSlotList(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (let i = 0; i < SLOTS; i++) {
    const n = Number(raw[i]);
    out.push(Number.isInteger(n) ? n : null);
  }
  return out;
}

function cleanFlexItem(raw, fallback) {
  if (raw && raw.kind === 'none') return { kind: 'none', id: 0 };
  if (!raw || (raw.kind !== 'macro' && raw.kind !== 'memory')) return fallback;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id < 0 || id > 99) return fallback;
  return { kind: raw.kind, id };
}

function cleanMap(raw) {
  const base = { flex: emptyFlex(), slots: null, perMe: {} };
  if (!raw || typeof raw !== 'object') return base;
  if (Array.isArray(raw.flex)) {
    raw.flex.slice(0, 4).forEach((bank, b) => {
      if (!Array.isArray(bank)) return;
      bank.slice(0, FLEX).forEach((item, i) => { base.flex[b][i] = cleanFlexItem(item, base.flex[b][i]); });
    });
  }
  base.slots = cleanSlotList(raw.slots);
  if (raw.perMe && typeof raw.perMe === 'object') {
    for (const [k, v] of Object.entries(raw.perMe)) {
      const list = cleanSlotList(v);
      if (list) base.perMe[String(k)] = list;
    }
  }
  return base;
}

function busSources(view) {
  const mes = (view && view.mes) || [];
  const bus = (mes[0] && mes[0].bus) || (view && view.bus) || [];
  return bus.map((src) => ({
    id: src.id,
    name: String(src.short || src.long || src.id),
    long: String(src.long || src.short || src.id),
  }));
}

function perMe(view) {
  return !!(view && (view.busMap || view.perMeButtonMap));
}

function slotList(map, view, meIndex) {
  const srcs = busSources(view);
  const stored = perMe(view) && map.perMe[String(meIndex)] ? map.perMe[String(meIndex)] : map.slots;
  const slots = [];
  for (let i = 0; i < SLOTS; i++) {
    const id = stored && stored[i] != null ? stored[i] : (srcs[i] ? srcs[i].id : null);
    const hit = srcs.find((s) => s.id === id);
    slots.push(hit || (id == null ? null : { id, name: String(id), long: String(id) }));
  }
  return slots;
}

function assignSlot(map, view, meIndex, slot, sourceId) {
  const next = cleanMap(map);
  const id = sourceId == null ? null : Number(sourceId);
  if (perMe(view)) {
    const list = (next.perMe[String(meIndex)] || slotList(next, view, meIndex).map((s) => (s ? s.id : null))).slice();
    list[slot] = Number.isInteger(id) ? id : null;
    next.perMe[String(meIndex)] = list;
  } else {
    const list = (next.slots || slotList(next, view, meIndex).map((s) => (s ? s.id : null))).slice();
    list[slot] = Number.isInteger(id) ? id : null;
    next.slots = list;
  }
  return next;
}

function assignFlex(map, bank, index, item) {
  const next = cleanMap(map);
  next.flex[bank][index] = cleanFlexItem(item, next.flex[bank][index]);
  return next;
}

function cycle(list, index, delta) {
  if (!list.length) return 0;
  const i = ((index + delta) % list.length + list.length) % list.length;
  return i;
}

function cycleMes(current, count) {
  const n = Math.max(1, Number(count) || 1);
  const patterns = [];
  for (let i = 1; i <= n; i++) patterns.push([i]);
  if (n > 1) patterns.push(Array.from({ length: n }, (_, i) => i + 1));
  const cur = (Array.isArray(current) && current.length ? current : [1]).join(',');
  const idx = patterns.findIndex((p) => p.join(',') === cur);
  return patterns[(idx + 1) % patterns.length];
}

module.exports = {
  FLEX, SLOTS, EFFECTS, EFFECT_STYLE, WIPES,
  emptyFlex, cleanMap, busSources, perMe, slotList, assignSlot, assignFlex, cycle, cycleMes,
};
