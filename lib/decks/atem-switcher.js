'use strict';
// Steven's ATEM switcher page. Native size is Stream Deck + XL: 9 columns,
// 4 rows, 6 encoders. Other models keep that key order, with HOME at the
// top left and PAGE in the corner.

const map = require('./atem-map');

const post = (path, body) => ({ method: 'POST', path, body: body || {} });

function homeKey() {
  return { label: 'HOME', caption: 'BACK', tone: 'os', nav: 'home', action: null };
}

function blankKey() {
  return { label: '', caption: '', tone: 'blank', nav: null, action: null };
}

function viewOf(desk, system) {
  const key = system && desk && desk.byKey && desk.byKey[system] ? system : 'atem';
  const raw = desk && desk.byKey && desk.byKey[key];
  return {
    view: (raw && raw.view) || { mes: [], bus: [], outputs: [], auxSources: [] },
    buttonMap: raw && raw.buttonMap,
    host: (raw && raw.host) || '',
    port: raw && raw.port,
    label: (raw && (raw.label || raw.short)) || 'ATEM',
  };
}

function uiOf(session) {
  const ui = (session && session.atemUi) || {};
  return {
    me: Math.max(1, Number(ui.me) || 1),
    flexBank: ui.flexBank ? 1 : 0,
    shift: ui.shift ? 1 : 0,
    pending: ui.pending || null,
  };
}

function meState(view, meNumber) {
  const mes = view.mes || [];
  const idx = Math.max(0, Math.min(Math.max(mes.length, 1) - 1, meNumber - 1));
  return { index: idx, me: mes[idx] || { bus: view.bus || [], program: null, preview: null, style: 'MIX', mixRate: 30, handle: 0, wipe: 0 } };
}

function short(text, n) {
  return String(text || '').slice(0, n);
}

function navKey(label, caption, goto, on) {
  return { label, caption, tone: 'nav', nav: 'page', goto, on: !!on, action: null };
}

function navRow(current) {
  return [
    homeKey(),
    { label: 'INFO', caption: 'ATEM', tone: 'nav', nav: 'page', goto: 'atem-info', atemHold: 'info', tapGoto: 'atem-info', holdGoto: 'atem-config', action: null },
    blankKey(),
    blankKey(),
    navKey('SWITCHER', 'PAGE', 'atem-switcher', current === 'atem-switcher'),
    navKey('ROUTER', 'AUX', 'atem-router', current === 'atem-router'),
    navKey('AUDIO', 'MIX', 'atem-audio', current === 'atem-audio'),
    navKey('KEYS', 'SS', 'atem-keys', current === 'atem-keys'),
    navKey('MV', 'VIEWER', 'atem-mv', current === 'atem-mv'),
  ];
}

function tallyTone(slot, me) {
  if (!slot) return 'func';
  if (me.program === slot.id) return 'stop';
  if (me.preview === slot.id) return 'pvw';
  return 'func';
}

function switcherKeys(ctx) {
  const { view, buttonMap, system, ui } = ctx;
  const me = meState(view, ui.me);
  const stored = map.cleanMap(buttonMap);
  const slots = map.slotList(stored, view, me.index);
  const start = ui.shift ? 8 : 0;
  const bank = stored.flex[ui.flexBank];
  const id = system || 'atem';
  const keys = navRow('atem-switcher');
  for (let i = 0; i < 7; i++) {
    const item = bank[i];
    const macro = (view.macros || []).find((m) => m.index === item.id);
    const label = item.kind === 'macro' ? short(macro && macro.name ? macro.name : `M${item.id + 1}`, 8) : `MEM ${item.id}`;
    const pending = ui.pending && ui.pending.bus === 'flex' && ui.pending.slot === i;
    keys.push({
      label: pending ? short(ui.pending.name, 8) : label,
      caption: pending ? 'MAP' : (ui.flexBank ? 'BANK 2' : 'FLEX'),
      tone: pending ? 'nav' : 'func',
      map: { bus: 'flex', slot: i, bank: ui.flexBank },
      action: item.kind === 'macro'
        ? post(`/api/sys/${id}/cmd/macroRun`, { macro: item.id, me: ui.me })
        : post(`/api/sys/${id}/cmd/layoutRecall`, { preset: String(item.id), me: ui.me, target: 'preview' }),
    });
  }
  keys.push({
    label: ui.flexBank ? 'BANK 2' : 'MACRO',
    caption: 'SHIFT',
    tone: 'nav',
    atemToggle: 'flexBank',
    action: null,
  });
  keys.push({ label: 'CUT', caption: `ME${ui.me}`, tone: 'go', action: post(`/api/sys/${id}/cmd/cut`, { me: ui.me }) });
  for (let i = 0; i < 8; i++) {
    const slot = slots[start + i];
    const pending = ui.pending && ui.pending.bus === 'pgm' && ui.pending.slot === start + i;
    keys.push({
      label: pending ? short(ui.pending.name, 8) : short(slot ? slot.name : '—', 8),
      caption: pending ? 'MAP' : (slot && me.me.program === slot.id ? 'PGM' : String(start + i + 1)),
      tone: pending ? 'nav' : tallyTone(slot, me.me),
      map: { bus: 'pgm', slot: start + i },
      action: slot ? post(`/api/sys/${id}/cmd/program`, { source: slot.id, me: ui.me }) : null,
    });
  }
  keys.push({ label: 'TRANS', caption: 'AUTO', tone: 'go', action: post(`/api/sys/${id}/cmd/auto`, { me: ui.me }) });
  for (let i = 0; i < 8; i++) {
    const slot = slots[start + i];
    const pending = ui.pending && ui.pending.bus === 'pvw' && ui.pending.slot === start + i;
    keys.push({
      label: pending ? short(ui.pending.name, 8) : short(slot ? slot.name : '—', 8),
      caption: pending ? 'MAP' : (slot && me.me.preview === slot.id ? 'PVW' : String(start + i + 1)),
      tone: pending ? 'nav' : (slot && me.me.preview === slot.id ? 'pvw' : 'func'),
      map: { bus: 'pvw', slot: start + i },
      action: slot ? post(`/api/sys/${id}/cmd/preview`, { source: slot.id, me: ui.me }) : null,
    });
  }
  keys.push({
    label: 'SHIFT',
    caption: ui.shift ? '9–16' : '1–8',
    tone: ui.shift ? 'nav' : 'func',
    on: !!ui.shift,
    atemToggle: 'shift',
    action: null,
  });
  return keys;
}

function dialsFor(ctx, count) {
  if (!count) return [];
  const { view, ui } = ctx;
  const me = meState(view, ui.me);
  const style = String(me.me.style || me.me.nextStyle || 'MIX').toUpperCase();
  const effect = map.EFFECTS.includes(style) ? style : 'MIX';
  const wipe = Number(me.me.wipe) || 0;
  const rate = Number(me.me.mixRate) || 30;
  const handle = Math.max(0, Math.min(9999, Number(me.me.handle) || 0));
  const pending = ui.pending;
  const all = [
    { atem: 'me', label: 'ME', readout: `ME ${ui.me}`, fraction: ui.me / Math.max(2, (view.mes || []).length || 2) },
    { atem: 'effect', label: 'EFFECT', readout: effect, fraction: map.EFFECTS.indexOf(effect) / 2 },
    { atem: 'wipe', label: 'WIPE', readout: map.WIPES[wipe] || String(wipe), fraction: wipe / Math.max(1, map.WIPES.length - 1) },
    { atem: 'time', label: 'AUTO', readout: `${rate}f`, fraction: rate / 250 },
    { atem: 'tbar', label: 'T-BAR', readout: `${Math.round(handle / 100)}%`, fraction: handle / 9999 },
    { atem: 'map', label: 'MAP', readout: pending ? short(pending.name, 10) : 'HOLD', fraction: pending ? 1 : 0 },
  ];
  if (count >= 6) return all;
  if (count === 4) return [all[0], all[1], all[3], all[5]];
  return all.slice(0, count);
}

function routerKeys(ctx) {
  const { view, system, session } = ctx;
  const id = system || 'atem';
  const outputs = (view.outputs || []).filter((o) => !o.accepts || o.accepts === 'aux' || o.routable);
  const keys = navRow('atem-router');
  if (session && session.out) {
    keys.push({ label: 'OUTPUTS', caption: 'BACK', tone: 'nav', nav: 'page', goto: 'atem-router', clearOut: true, action: null });
    const pool = (view.auxSources && view.auxSources.length) ? view.auxSources : map.busSources(view).map((s) => ({ id: s.id, long: s.long, short: s.name }));
    const picked = outputs.find((o) => o.key === session.out);
    for (const src of pool) {
      const on = picked && src.id === picked.source;
      keys.push({
        label: short(src.long || src.short || src.name || src.id, 16),
        caption: on ? 'ON' : '',
        tone: on ? 'pvw' : 'func',
        action: post(`/api/sys/${id}/cmd/route`, { output: session.out, source: src.id }),
      });
    }
    return keys;
  }
  for (const output of outputs) {
    keys.push({
      label: short(output.sourceName || 'NONE', 16),
      caption: short(output.label || output.key, 10),
      tone: 'func',
      pick: output.key,
      goto: 'atem-router',
      action: null,
    });
  }
  if (outputs.length === 0) keys.push({ label: 'NO AUX', caption: 'ROUTER', tone: 'func', action: null });
  return keys;
}

function audioKeys(ctx) {
  const inputs = (ctx.view.audio && ctx.view.audio.inputs) || [];
  const keys = navRow('atem-audio');
  const id = ctx.system || 'atem';
  if (!inputs.length) {
    keys.push({ label: 'NO AUDIO', caption: 'MIX', tone: 'func', action: null });
    return keys;
  }
  inputs.slice(0, 18).forEach((input) => {
    keys.push({
      label: short(input.name || input.id, 8),
      caption: input.muted ? 'MUTE' : 'ON',
      tone: input.muted ? 'func' : 'nav',
      action: post(`/api/sys/${id}/cmd/audioMute`, { input: input.id, mute: 'toggle' }),
    });
  });
  return keys;
}

function keyKeys(ctx) {
  const me = meState(ctx.view, ctx.ui.me);
  const keys = navRow('atem-keys');
  const id = ctx.system || 'atem';
  const keyers = me.me.keyers || [];
  keyers.forEach((keyer, i) => {
    keys.push({
      label: `KEY ${i + 1}`,
      caption: keyer.onAir ? 'ON AIR' : 'OFF',
      tone: keyer.onAir ? 'stop' : 'func',
      action: post(`/api/sys/${id}/cmd/uskOnAir`, { key: keyer.index == null ? i : keyer.index, on: !keyer.onAir, me: ctx.ui.me }),
    });
  });
  keys.push({ label: 'SS', caption: 'LOOK', tone: 'func', action: post(`/api/sys/${id}/cmd/ssLayoutRecall`, { layout: 'default', me: ctx.ui.me }) });
  return keys;
}

function mvKeys(ctx) {
  const keys = navRow('atem-mv');
  const windows = (ctx.view.outputs || []).filter((o) => o.accepts === 'mv' || String(o.key || '').startsWith('mv:'));
  if (!windows.length) {
    keys.push({ label: 'NO MV', caption: 'VIEW', tone: 'func', action: null });
    return keys;
  }
  windows.slice(0, 18).forEach((win) => {
    keys.push({ label: short(win.sourceName || 'NONE', 8), caption: short(win.label || 'MV', 10), tone: 'func', action: null });
  });
  return keys;
}

function infoKeys(ctx, config) {
  const keys = navRow(config ? 'atem-config' : 'atem-info');
  const view = ctx.view;
  keys.push({ label: short(ctx.label, 8), caption: 'NAME', tone: 'os', action: null });
  keys.push({ label: short(view.model || view.product || 'ATEM', 8), caption: 'MODEL', tone: 'func', action: null });
  keys.push({ label: short(ctx.host || '—', 10), caption: 'HOST', tone: 'func', action: null });
  keys.push({ label: ctx.port == null ? '—' : String(ctx.port), caption: 'PORT', tone: 'func', action: null });
  keys.push({ label: `ME ${ctx.ui.me}`, caption: config ? 'CONFIG' : 'INFO', tone: 'nav', action: null });
  if (!config) keys.push({ label: 'MORE', caption: 'PAGES', tone: 'nav', nav: 'page', goto: 'atem-companion', action: null });
  return keys;
}

function fit(native, cols, rows, surface, spec) {
  const dials = spec.dials || [];
  if (surface.cols === cols && surface.rows === rows) {
    const keys = native.map((key, i) => ({ ...key, col: i % cols, row: Math.floor(i / cols) }));
    if (!keys[0] || keys[0].nav !== 'home') keys[0] = { ...homeKey(), col: 0, row: 0 };
    return [{ ...spec, keys, dials }];
  }
  const home = native.find((key) => key && key.nav === 'home') || homeKey();
  const body = native.filter((key) => key !== home);
  const free = [];
  for (let row = 0; row < surface.rows; row++) {
    for (let col = 0; col < surface.cols; col++) {
      if (row === 0 && col === 0) continue;
      if (row === surface.rows - 1 && col === surface.cols - 1) continue;
      free.push({ row, col });
    }
  }
  const per = Math.max(1, free.length);
  const count = Math.max(1, Math.ceil(body.length / per));
  const parts = [];
  for (let p = 0; p < count; p++) {
    const keys = [];
    for (let row = 0; row < surface.rows; row++) {
      for (let col = 0; col < surface.cols; col++) keys.push({ ...blankKey(), row, col });
    }
    const put = (col, row, key) => { keys[row * surface.cols + col] = { ...keys[row * surface.cols + col], ...key, row, col }; };
    put(0, 0, home);
    body.slice(p * per, (p + 1) * per).forEach((key, i) => put(free[i].col, free[i].row, key));
    put(surface.cols - 1, surface.rows - 1, { label: 'PAGE', caption: 'NEXT', tone: 'nav', nav: 'page', next: true, action: null });
    parts.push({ ...spec, part: p, keys, dials: p === 0 ? dials : [] });
  }
  return parts;
}

function atemDeck(surface, desk, session, system) {
  const info = viewOf(desk, system);
  const ui = uiOf(session);
  const ctx = { ...info, system, session, ui };
  const knobs = (surface.knobCols || []).length;
  const pages = [];
  const push = (id, title, keys, cols, rows, dials) => {
    fit(keys, cols, rows, surface, { designId: id, title, dials: dials || [] }).forEach((part) => pages.push(part));
  };
  push('atem-switcher', 'ATEM switcher', switcherKeys(ctx), 9, 4, dialsFor(ctx, knobs));
  push('atem-info', 'ATEM info', infoKeys(ctx, false), 9, 4, []);
  push('atem-config', 'ATEM config', infoKeys(ctx, true), 9, 4, []);
  push('atem-router', 'ATEM router', routerKeys(ctx), 9, 4, []);
  push('atem-audio', 'ATEM audio', audioKeys(ctx), 9, 4, []);
  push('atem-keys', 'ATEM keys', keyKeys(ctx), 9, 4, []);
  push('atem-mv', 'ATEM multiviewer', mvKeys(ctx), 9, 4, []);
  return pages;
}

function choicesFor(held, view, buttonMap, meIndex) {
  const stored = map.cleanMap(buttonMap);
  if (!held) return [];
  if (held.bus === 'flex') {
    const macros = (view.macros || []).filter((m) => m.isUsed !== false).map((m) => ({ kind: 'macro', id: m.index, name: m.name || `M${m.index + 1}` }));
    const memories = Array.from({ length: 16 }, (_, i) => ({ kind: 'memory', id: i + 1, name: `MEM ${i + 1}` }));
    const list = macros.length ? macros.concat(memories) : Array.from({ length: 16 }, (_, i) => ({ kind: 'macro', id: i, name: `M${i + 1}` })).concat(memories);
    return list;
  }
  return map.slotList(stored, view, meIndex).filter(Boolean).concat(map.busSources(view)).filter((src, i, all) => all.findIndex((s) => s.id === src.id) === i);
}

module.exports = { atemDeck, switcherKeys, dialsFor, choicesFor, navRow };
