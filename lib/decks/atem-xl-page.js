'use strict';
// Bind the ATEM switcher JSON page to one Stream Deck + XL.

const fs = require('fs');
const path = require('path');
const { resolveKey, faceFromKey } = require('./key-class');
const maps = require('./atem-map');

const PAGE = JSON.parse(fs.readFileSync(path.join(__dirname, 'pages', 'atem-switcher.page.json'), 'utf8'));

const post = (pathName, body) => ({ method: 'POST', path: pathName, body: body || {} });

function expand(keys) {
  const out = [];
  for (const key of keys) {
    if (key.repeat) {
      for (let i = 0; i < key.repeat; i++) out.push({ ...key, repeat: undefined, slot: (key.slotFrom || 1) + i - (key.id === 'flex' ? 0 : 0), index: i });
    } else out.push(key);
  }
  return out;
}

function uiOf(session) {
  const ui = (session && session.atemUi) || {};
  const mes = Array.isArray(ui.mes) && ui.mes.length ? ui.mes.map(Number) : [Math.max(1, Number(ui.me) || 1)];
  return {
    me: Math.max(1, Number(ui.me) || mes[0] || 1),
    flexBank: Math.max(0, Math.min(3, Number(ui.flexBank) || 0)),
    shift: ui.shift ? 1 : 0,
    pending: ui.pending || null,
    mes,
    transHold: !!ui.transHold,
    next: ui.next || { bkgd: true, keys: [], dsk: [] },
  };
}

function context(desk, system) {
  const raw = desk && desk.byKey && desk.byKey[system || 'atem'];
  return {
    view: (raw && raw.view) || { mes: [], bus: [] },
    buttonMap: raw && raw.buttonMap,
    host: (raw && raw.host) || '',
    label: (raw && (raw.label || raw.short)) || 'ATEM',
  };
}

function meOf(view, meNumber) {
  const mes = view.mes || [];
  const idx = Math.max(0, Math.min(Math.max(mes.length, 1) - 1, meNumber - 1));
  const me = mes[idx] || { bus: view.bus || [], program: null, preview: null, style: 'MIX', mixRate: 30, handle: 0, wipe: 0, keyers: [] };
  return { index: idx, me };
}

function armedText(ui, view) {
  const me = meOf(view, ui.me).me;
  const parts = [];
  if (!ui.next || ui.next.bkgd !== false) parts.push('BKGD');
  const keyers = me.keyers || [];
  keyers.forEach((keyer, i) => { if (ui.next && ui.next.keys && ui.next.keys[i]) parts.push(`K${i + 1}`); });
  if (ui.mes.includes(1)) (ui.next.dsk || []).forEach((on, i) => { if (on) parts.push(`D${i + 1}`); });
  return parts.join(' ') || 'NONE';
}

function runtimeKey(spec, live) {
  const flags = live.flags || {};
  const resolved = resolveKey({
    ...spec,
    text: live.text != null ? live.text : spec.text,
    title: live.title != null ? live.title : spec.title,
    caption: live.caption != null ? live.caption : spec.caption,
    role: live.role || spec.role,
    feedbacks: [...(spec.feedbacks || []), ...(live.feedbacks || [])],
  }, flags, live.vars || {});
  const face = faceFromKey(resolved);
  const key = {
    label: (resolved.text || '').split('\n')[0],
    caption: resolved.caption || '',
    tone: live.tone || 'func',
    nav: live.nav || null,
    goto: live.goto || null,
    on: !!live.on,
    action: live.action || null,
    faceStyle: face,
    map: live.map || null,
    atemToggle: live.atemToggle || null,
    atemCycle: live.atemCycle || null,
    atemHold: live.atemHold || null,
    tapGoto: live.tapGoto || null,
    holdGoto: live.holdGoto || null,
    atemFire: live.atemFire || null,
  };
  if (resolved.text && resolved.text.includes('\n')) {
    key.faceStyle = { ...key.faceStyle, value: resolved.text };
    key.label = resolved.text.replace(/\n/g, ' ');
  }
  return key;
}

function flexLive(spec, ui, stored, view, id) {
  const item = stored.flex[ui.flexBank][spec.index] || { kind: 'none', id: 0 };
  const pending = ui.pending && ui.pending.bus === 'flex' && ui.pending.slot === spec.index;
  const macro = (view.macros || []).find((m) => m.index === item.id);
  let text = '—';
  let role = 'flex';
  if (item.kind === 'macro') { text = (macro && macro.name) || `M${item.id + 1}`; role = 'flex-macro'; }
  if (item.kind === 'memory') { text = `MEM ${item.id}`; role = 'flex-memory'; }
  if (pending) text = ui.pending.name || text;
  const action = item.kind === 'macro'
    ? post(`/api/sys/${id}/cmd/macroRun`, { macro: item.id })
    : item.kind === 'memory'
      ? post(`/api/sys/${id}/cmd/layoutRecall`, { preset: String(item.id), target: 'preview' })
      : null;
  return {
    text, role, caption: pending ? 'MAP' : 'FLEX', tone: 'func',
    action, map: { bus: 'flex', slot: spec.index, bank: ui.flexBank },
    flags: { held: !!pending },
    feedbacks: [{ when: 'held', style: { border: '#E0B030' } }],
  };
}

function busLive(spec, ui, slots, me, id, bus) {
  const slotIndex = (ui.shift ? 8 : 0) + spec.index;
  const slot = slots[slotIndex];
  const pending = ui.pending && ui.pending.bus === bus && ui.pending.slot === slotIndex;
  const onPgm = !!(slot && me.program === slot.id);
  const onPvw = !!(slot && me.preview === slot.id);
  const text = pending ? (ui.pending.name || '—') : (slot ? (slot.long || slot.name) : '—');
  const caption = pending ? 'MAP' : (onPgm ? 'PGM' : (onPvw ? 'PVW' : String(slotIndex + 1)));
  return {
    text, caption, role: bus === 'pgm' ? 'program' : 'preview',
    tone: onPgm ? 'stop' : (onPvw ? 'pvw' : 'func'),
    action: slot ? post(`/api/sys/${id}/cmd/${bus === 'pgm' ? 'program' : 'preview'}`, { source: slot.id, me: ui.me }) : null,
    map: { bus, slot: slotIndex },
    flags: { onProgram: onPgm && bus === 'pgm', onPreview: onPvw && bus === 'pvw', held: !!pending },
    feedbacks: [
      { when: 'onProgram', style: { bgcolor: '#ff2d2d', color: '#ffffff' } },
      { when: 'onPreview', style: { bgcolor: '#3DDC84', color: '#06210f' } },
      { when: 'held', style: { border: '#E0B030' } },
    ],
  };
}

function bindSwitcher(desk, session, system) {
  const ctx = context(desk, system);
  const ui = uiOf(session);
  const { view } = ctx;
  const stored = maps.cleanMap(ctx.buttonMap);
  const me = meOf(view, ui.me);
  const slots = maps.slotList(stored, view, me.index).map((slot) => slot ? { ...slot, long: slot.long || slot.name } : null);
  const id = system || 'atem';
  const vars = {
    'atem:name': ctx.label,
    'atem:ip': ctx.host || '—',
    'atem:armed': armedText(ui, view),
    'atem:bankLabel': ui.flexBank ? String(ui.flexBank + 1) : '',
    'atem:shiftLabel': ui.shift ? '9–16' : '1–8',
    'atem:mes': ui.mes.join(','),
  };
  const specs = expand(PAGE.keys);
  const keys = specs.map((spec, i) => {
    let live = { vars, flags: { transition: !!(me.me.inTransition), shift: !!ui.shift, bankOn: ui.flexBank > 0, transHold: ui.transHold, activeTab: spec.id === 'tab-switcher' } };
    if (spec.id === 'home') live = { ...live, nav: 'home', tone: 'os' };
    else if (spec.id === 'info') live = { ...live, text: `${ctx.label}\n${ctx.host || '—'}`, atemHold: 'info', tapGoto: 'atem-info', holdGoto: 'atem-config', nav: 'page', goto: 'atem-info' };
    else if (spec.id === 'blank') live = { ...live, role: 'blank', text: '', tone: 'blank' };
    else if (spec.role === 'tab') {
      live = { ...live, goto: spec.target, nav: 'page', on: spec.id === 'tab-switcher', flags: { ...live.flags, activeTab: spec.id === 'tab-switcher' } };
      if (spec.id === 'tab-switcher') live.flags.activeTab = true;
    }
    else if (spec.id === 'trans-select') live = { ...live, caption: vars['atem:armed'], atemHold: 'trans' };
    else if (spec.id === 'flex') live = { ...live, ...flexLive(spec, ui, stored, view, id), vars };
    else if (spec.id === 'macro-shift') live = { ...live, text: ui.flexBank ? String(ui.flexBank + 1) : 'MACRO', caption: ui.flexBank ? 'BANK' : 'SHIFT', atemToggle: 'flexBank', atemCycle: 4 };
    else if (spec.id === 'cut') live = { ...live, action: post(`/api/sys/${id}/cmd/cut`, { me: ui.me }), atemFire: 'cut' };
    else if (spec.id === 'pgm') live = { ...live, ...busLive(spec, ui, slots, me.me, id, 'pgm'), vars };
    else if (spec.id === 'trans') live = { ...live, action: post(`/api/sys/${id}/cmd/auto`, { me: ui.me }), atemFire: 'auto' };
    else if (spec.id === 'pvw') live = { ...live, ...busLive(spec, ui, slots, me.me, id, 'pvw'), vars };
    else if (spec.id === 'shift') live = { ...live, atemToggle: 'shift', on: !!ui.shift };
    const key = runtimeKey(spec, live);
    if (spec.role === 'tab' && spec.id === 'tab-switcher') key.on = true;
    if (live.flags && live.flags.activeTab && spec.role === 'tab') key.faceStyle = { ...key.faceStyle, fill: '#1A3F86' };
    key.col = i % 9;
    key.row = Math.floor(i / 9);
    return key;
  });
  return { keys, dials: dials(ui, view, me), designId: 'atem-switcher', title: 'ATEM switcher' };
}

function dials(ui, view, meWrap) {
  const me = meWrap.me;
  const style = String(me.style || 'MIX').toUpperCase();
  const effect = maps.EFFECTS.includes(style) ? style : 'MIX';
  const wipe = Number(me.wipe) || 0;
  const rate = Number(me.mixRate) || 30;
  const handle = Math.max(0, Math.min(9999, Number(me.handle) || 0));
  if (ui.transHold) return selectorStrip(ui, view);
  return [
    { atem: 'me', label: 'ME', readout: `ME ${ui.me}`, strip: { kind: 'me', text: String(ui.me), count: Math.max(1, (view.mes || []).length) } },
    { atem: 'effect', label: 'EFFECT', readout: effect, strip: { kind: 'effect', text: effect } },
    { atem: 'wipe', label: 'WIPE', readout: maps.WIPES[wipe] || String(wipe), strip: { kind: 'wipe', pattern: wipe, text: maps.WIPES[wipe] || '' } },
    { atem: 'time', label: 'AUTO', readout: `${rate}f`, strip: { kind: 'time', text: `${rate}f` } },
    { atem: 'tbar', label: 'T-BAR', readout: `${Math.round(handle / 100)}%`, strip: { kind: 'tbar', fraction: handle / 9999, text: `${Math.round(handle / 100)}%` } },
    { atem: 'map', label: 'MAP', readout: ui.pending ? ui.pending.name : '', strip: { kind: 'map', text: ui.pending ? ui.pending.name : '' } },
  ];
}

function selectorStrip(ui, view) {
  const me = meOf(view, ui.me).me;
  const cells = [{ atem: 'select', label: 'NEXT', readout: 'BKGD', strip: { kind: 'pick', text: 'BKGD', on: ui.next.bkgd !== false, touch: { type: 'bkgd' }, frame: true } }];
  (me.keyers || []).forEach((keyer, i) => {
    cells.push({ atem: 'select', label: 'KEY', readout: `K${i + 1}`, strip: { kind: 'pick', text: `KEY ${i + 1}`, on: !!(ui.next.keys && ui.next.keys[i]), touch: { type: 'usk', index: i }, frame: true } });
  });
  if (ui.mes.includes(1)) {
    const dsks = (view.dsk || view.downstreamKeyers || []).length || ((view.topology && view.topology.downstreamKeyers) || 0);
    const n = Array.isArray(view.dsk) ? view.dsk.length : dsks;
    for (let i = 0; i < n; i++) {
      cells.push({ atem: 'select', label: 'DSK', readout: `D${i + 1}`, strip: { kind: 'pick', text: `DSK ${i + 1}`, on: !!(ui.next.dsk && ui.next.dsk[i]), touch: { type: 'dsk', index: i }, frame: true } });
    }
  }
  const meCount = Math.max(1, (view.mes || []).length || 1);
  for (let i = 1; i <= meCount; i++) {
    cells.push({ atem: 'select', label: 'ME', readout: `ME ${i}`, strip: { kind: 'pick', text: `ME ${i}`, on: ui.mes.includes(i), touch: { type: 'me', index: i }, frame: true } });
  }
  const picked = [];
  const meCells = cells.filter((c) => c.strip.touch.type === 'me');
  const rest = cells.filter((c) => c.strip.touch.type !== 'me');
  const room = Math.max(0, 6 - meCells.length);
  picked.push(...rest.slice(0, room), ...meCells);
  while (picked.length < 6) picked.push({ atem: 'select', label: '', readout: '', strip: { kind: 'pick', text: '', on: false, frame: true } });
  return picked.slice(0, 6);
}

module.exports = { bindSwitcher, PAGE };
