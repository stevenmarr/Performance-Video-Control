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
      for (let i = 0; i < key.repeat; i++) out.push({ ...key, repeat: undefined, slot: (key.slotFrom || 1) + i, index: i });
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
    next: ui.next || null,
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

function dskList(view) {
  if (Array.isArray(view && view.dsk)) return view.dsk;
  const n = (view && view.topology && view.topology.downstreamKeyers) || 0;
  return Array.from({ length: Number(n) || 0 }, () => ({}));
}

function hardwareNext(me, view) {
  const ns = Number(me && me.nextSelection);
  const known = Number.isFinite(ns);
  const keyers = (me && me.keyers) || [];
  return {
    bkgd: known ? !!(ns & 1) : true,
    keys: keyers.map((keyer, i) => (known ? !!(ns & (1 << (i + 1))) : !!(keyer && keyer.tie))),
    dsk: dskList(view).map((dsk) => !!(dsk && dsk.tie)),
  };
}

function layerState(ui, view) {
  const me = meOf(view, ui.me).me;
  const stored = ui.transHold && ui.next ? ui.next : null;
  const next = stored ? {
    bkgd: stored.bkgd !== false,
    keys: (me.keyers || []).map((_, i) => !!(stored.keys && stored.keys[i])),
    dsk: dskList(view).map((_, i) => !!(stored.dsk && stored.dsk[i])),
  } : hardwareNext(me, view);
  const layers = [{
    id: 'BKGD',
    icon: 'BKGD',
    next: next.bkgd !== false,
    air: !(me.ftb && me.ftb.black),
  }];
  (me.keyers || []).forEach((keyer, i) => {
    layers.push({ id: `K${i + 1}`, icon: `K${i + 1}`, next: !!next.keys[i], air: !!(keyer && keyer.onAir) });
  });
  if ((ui.mes || []).map(Number).includes(1)) {
    dskList(view).forEach((dsk, i) => {
      layers.push({ id: `D${i + 1}`, icon: `D${i + 1}`, next: !!next.dsk[i], air: !!(dsk && dsk.onAir) });
    });
  }
  const crowded = layers.length > 4;
  const drawn = layers.map((layer) => ({
    ...layer,
    icon: crowded && layer.id === 'BKGD' ? 'BG' : layer.icon,
  }));
  const names = (want) => drawn.filter((layer) => layer[want]).map((layer) => layer.id).join(' ') || 'NONE';
  return { next, layers: drawn, nextText: names('next'), airText: names('air') };
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
    atemMes: live.atemMes || null,
    atemHold: live.atemHold || null,
    tapGoto: live.tapGoto || null,
    holdGoto: live.holdGoto || null,
    atemFire: live.atemFire || null,
  };
  if (resolved.text && resolved.text.includes('\n')) {
    key.faceStyle = { ...key.faceStyle, value: resolved.text };
    key.label = resolved.text.replace(/\n/g, ' ');
  }
  if (live.house) key.faceStyle = { ...key.faceStyle, house: true, value: '', title: '', caption: '' };
  if (live.layers) {
    key.faceStyle = { ...key.faceStyle, layers: live.layers, title: '', caption: '' };
    key.caption = live.legend || key.caption;
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
    text, role, title: '', caption: pending ? 'MAP' : '', tone: 'func',
    action, map: { bus: 'flex', slot: spec.index, bank: ui.flexBank },
    flags: { held: !!pending },
    feedbacks: [{ when: 'held', style: { border: '#E0B030' } }],
  };
}

function busLive(spec, ui, slots, me, id, bus) {
  const slotIndex = (ui.shift ? maps.FLEX : 0) + spec.index;
  const slot = slots[slotIndex];
  const pending = ui.pending && ui.pending.bus === bus && ui.pending.slot === slotIndex;
  const onPgm = !!(slot && me.program === slot.id);
  const onPvw = !!(slot && me.preview === slot.id);
  const text = pending ? (ui.pending.name || '—') : (slot ? (slot.long || slot.name) : '—');
  const caption = pending ? 'MAP' : (onPgm ? 'PGM' : (onPvw ? 'PVW' : String(slotIndex + 1)));
  return {
    text, caption, title: '', role: bus === 'pgm' ? 'program' : 'preview',
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
  const layers = layerState(ui, view);
  const vars = {
    'atem:name': ctx.label,
    'atem:ip': ctx.host || '—',
    'atem:armed': layers.nextText,
    'atem:bankLabel': ui.flexBank ? String(ui.flexBank + 1) : '',
    'atem:shiftLabel': ui.shift ? '8–14' : '1–7',
    'atem:mes': ui.mes.join(','),
  };
  const specs = expand(PAGE.keys);
  const keys = specs.map((spec, i) => {
    let live = { vars, flags: { transition: !!(me.me.inTransition), shift: !!ui.shift, bankOn: ui.flexBank > 0, transHold: ui.transHold, activeTab: spec.id === 'tab-switcher' } };
    if (spec.id === 'home') live = { ...live, nav: 'home', tone: 'os', title: '', caption: '', house: true };
    else if (spec.id === 'info') live = { ...live, text: `${ctx.label}\n${ctx.host || '—'}`, title: '', caption: '', atemHold: 'info', tapGoto: 'atem-info', holdGoto: 'atem-config', nav: 'page', goto: 'atem-info' };
    else if (spec.id === 'blank') live = { ...live, role: 'blank', text: '', title: '', caption: '', tone: 'blank' };
    else if (spec.role === 'tab') {
      live = { ...live, title: '', caption: '', goto: spec.target, nav: 'page', on: spec.id === 'tab-switcher', flags: { ...live.flags, activeTab: spec.id === 'tab-switcher' } };
    }
    else if (spec.id === 'trans-select') live = { ...live, text: 'SELECT', title: '', caption: '', layers: layers.layers, legend: layers.nextText, atemHold: 'trans' };
    else if (spec.id === 'flex') live = { ...live, ...flexLive(spec, ui, stored, view, id), vars };
    else if (spec.id === 'macro-shift') {
      const bank = ui.flexBank;
      live = {
        ...live,
        text: bank ? String(bank + 1) : 'SHIFT',
        title: '',
        caption: bank === 0 ? 'MACROS' : (bank === 1 ? 'MEMORY' : 'BANK'),
        atemToggle: 'flexBank',
        atemCycle: 4,
        on: bank > 0,
      };
    }
    else if (spec.id === 'cut') live = { ...live, title: '', caption: '', action: post(`/api/sys/${id}/cmd/cut`, { me: ui.me }), atemFire: 'cut' };
    else if (spec.id === 'pgm') live = { ...live, ...busLive(spec, ui, slots, me.me, id, 'pgm'), vars };
    else if (spec.id === 'mes') live = { ...live, text: `ME ${ui.mes.join('+')}`, title: '', caption: '', atemMes: true, flags: { ...live.flags, multi: ui.mes.length > 1 } };
    else if (spec.id === 'trans') live = { ...live, text: 'TRANS', title: '', caption: '', layers: layers.layers, legend: `${layers.nextText}|${layers.airText}`, action: post(`/api/sys/${id}/cmd/auto`, { me: ui.me }), atemFire: 'auto' };
    else if (spec.id === 'pvw') live = { ...live, ...busLive(spec, ui, slots, me.me, id, 'pvw'), vars };
    else if (spec.id === 'shift') live = { ...live, text: 'SHIFT', title: '', caption: vars['atem:shiftLabel'], atemToggle: 'shift', on: !!ui.shift };
    const key = runtimeKey(spec, live);
    if (live.flags && live.flags.activeTab && spec.role === 'tab') key.faceStyle = { ...key.faceStyle, fill: '#1A3F86' };
    if (spec.role === 'tab' && spec.id === 'tab-switcher') key.on = true;
    key.col = i % 9;
    key.row = Math.floor(i / 9);
    return key;
  });
  return { keys, dials: dials(ui, view, me), designId: 'atem-switcher', title: 'ATEM switcher' };
}

function dials(ui, view, meWrap) {
  const me = meWrap.me;
  const style = String(me.style || me.nextStyle || 'MIX').toUpperCase();
  const effect = maps.EFFECTS.includes(style) ? style : 'MIX';
  const wipe = Number(me.wipe) || 0;
  const rate = Number(me.mixRate) || 30;
  const handle = Math.max(0, Math.min(9999, Number(me.handle) || 0));
  if (ui.transHold) return selectorStrip(ui, view);
  return [
    { atem: 'me', label: 'ME', readout: `ME ${ui.me}`, strip: { kind: 'me', text: String(ui.me), count: Math.max(1, (view.mes || []).length) } },
    { atem: 'effect', label: 'EFFECT', readout: effect, strip: { kind: 'effect', text: effect, modes: maps.EFFECTS } },
    { atem: 'wipe', label: 'WIPE', readout: maps.WIPES[wipe] || String(wipe), strip: { kind: 'wipe', pattern: wipe, text: maps.WIPES[wipe] || '' } },
    { atem: 'time', label: 'AUTO', readout: `${rate}f`, strip: { kind: 'time', text: `${rate}f` } },
    { atem: 'tbar', label: 'T-BAR', readout: `${Math.round(handle / 100)}%`, strip: { kind: 'tbar', fraction: handle / 9999, text: `${Math.round(handle / 100)}%` } },
    { atem: 'map', label: 'MAP', readout: ui.pending ? ui.pending.name : '', strip: { kind: 'map', text: ui.pending ? ui.pending.name : '' } },
  ];
}

function selectorStrip(ui, view) {
  const { next } = layerState(ui, view);
  const me = meOf(view, ui.me).me;
  const cells = [pick('BKGD', 'BKGD', next.bkgd !== false, { type: 'bkgd' })];
  (me.keyers || []).slice(0, 4).forEach((keyer, i) => {
    cells.push(pick('KEY', `KEY ${i + 1}`, !!next.keys[i], { type: 'usk', index: i }));
  });
  if ((ui.mes || []).map(Number).includes(1)) {
    const room = 6 - cells.length;
    dskList(view).slice(0, room).forEach((dsk, i) => {
      cells.push(pick('DSK', `DSK ${i + 1}`, !!next.dsk[i], { type: 'dsk', index: i }));
    });
  }
  while (cells.length < 6) cells.push(pick('', '', false, null, false));
  return cells.slice(0, 6);
}

function pick(label, text, on, touch, frame = true) {
  return {
    atem: 'select',
    label,
    readout: `${text}:${on ? 1 : 0}`,
    strip: { kind: 'pick', text, on: !!on, touch, frame: frame && !!text },
  };
}

module.exports = { bindSwitcher, PAGE, hardwareNext, dskList, layerState };
