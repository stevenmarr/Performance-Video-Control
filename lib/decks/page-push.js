'use strict';
// Turn a named surface page into the page shape Path C already deploys.
// The plugin paints label / value / caption and POSTs action.path. It does not
// read key-class actions. Encoder and touch placements ride along as knobs and
// strip. dials stays a string per column so the current plugin does not treat
// a library encoder as a paint widget. The last key row is left alone: the
// built-in jump row is only for template pages.

const { resolveKey } = require('./key-class');

const post = (path, body) => ({ method: 'POST', path, body: body || {} });

const ATEM = new Set(['cut', 'auto', 'program', 'preview', 'macroRun', 'macroStop']);
const PTZ = new Set(['move', 'zoom', 'focus', 'recall', 'gain', 'iris']);
const SYSTEMS = new Set(['rs6', 'e2', 'pixelhue', 'atem', 'ptz', 'pixera', 'millumin', 'videohub', 'hyperdeck', 'mitti', 'console']);

function hasSlots(page) {
  if (!page) return false;
  return !!((page.keys && page.keys.length) || (page.encoders && page.encoders.length) || (page.touch && page.touch.length));
}

function fillGrid(keys, surface, device) {
  const by = new Map();
  for (const key of keys) by.set(`${key.col},${key.row}`, key);
  const out = [];
  for (let row = 0; row < surface.rows; row++) {
    for (let col = 0; col < surface.cols; col++) {
      const hit = by.get(`${col},${row}`);
      out.push(hit || { row, col, label: ' ', value: '', caption: '', action: null, jump: null, role: '', device: device || null });
    }
  }
  return out;
}

function moduleOf(actionId) {
  const mod = String(actionId || '').split('.')[0];
  return SYSTEMS.has(mod) ? mod : '';
}

function concrete(value) {
  const text = value == null ? '' : String(value);
  if (!text || text.startsWith('$(')) return '';
  return text;
}

// One library action becomes the { method, path, body } the plugin already runs.
// Page-only ids (nav.home, atem.shift, and the rest with no route) return null.
// nav.page is a jump, not an HTTP call.
function actionToRequest(row) {
  if (!row || !row.action) return null;
  const id = String(row.action);
  const [mod, ...rest] = id.split('.');
  const name = rest.join('.');
  const options = { ...(row.options || {}) };
  const instance = concrete(row.instance);
  if (instance && options.instance == null) options.instance = instance;
  if (id === 'nav.page') {
    const page = concrete(options.page);
    return page ? { jump: page } : null;
  }
  if (id === 'nav.home' || !name) return null;
  if (mod === 'rs6' && name === 'take') return post('/api/take', {});
  if (mod === 'rs6' && name === 'cut') return post('/api/cut', {});
  if (mod === 'rs6' && name === 'recall') {
    const n = options.preset || options.number || options.n;
    return n == null || n === '' ? null : post(`/api/presets/${n}/recall`, {});
  }
  if ((mod === 'e2' || mod === 'pixelhue') && (name === 'take' || name === 'cut')) return post(`/api/sys/${mod}/${name}`, options);
  if ((mod === 'e2' || mod === 'pixelhue') && name === 'recall') {
    const preset = options.id || options.preset;
    return preset == null || preset === '' ? null : post(`/api/sys/${mod}/presets/${preset}/recall`, { target: options.target === 'program' ? 'program' : 'preview' });
  }
  if (mod === 'atem' && ATEM.has(name)) return post(`/api/sys/atem/cmd/${name}`, options);
  if (mod === 'ptz' && PTZ.has(name)) return post(`/api/sys/ptz/cmd/${name}`, options);
  if (mod === 'pixera' && (name === 'play' || name === 'pause' || name === 'stop')) return post('/api/sys/pixera/cmd/transport', { ...options, mode: name });
  if (mod === 'millumin' && (name === 'play' || name === 'pause')) return post(`/api/sys/millumin/cmd/${name}`, options);
  if (mod === 'videohub' && name === 'crosspoint') return post('/api/sys/videohub/cmd/crosspoint', options);
  if (mod === 'hyperdeck' && (name === 'play' || name === 'stop' || name === 'record')) return post(`/api/sys/hyperdeck/cmd/${name}`, options);
  if (mod === 'mitti' && name === 'play') return post('/api/sys/mitti/cmd/play', options);
  if (mod === 'mitti' && name === 'cue') return post('/api/sys/mitti/cmd/cue', options);
  if (mod === 'console') return post(`/api/core/cmd/${name}`, options);
  return null;
}

function varsFrom(desk) {
  const atem = desk && desk.byKey && desk.byKey.atem;
  const name = (atem && (atem.short || atem.label || atem.host)) || '';
  return { 'atem:name': name };
}

function deviceFor(system, desk, instanceId) {
  const sys = desk && desk.byKey && desk.byKey[system];
  if (system === 'ptz') {
    const cams = (sys && sys.cameras) || [];
    const cam = (instanceId && cams.find((c) => c.id === instanceId)) || (sys && cams.find((c) => c.id === sys.selected)) || cams[0] || null;
    if (!cam) return instanceId ? { cam: instanceId, name: instanceId, host: '', port: 80 } : null;
    return { cam: cam.id, name: cam.name || cam.id, host: cam.host || '', port: cam.port == null ? 80 : cam.port };
  }
  if (!sys) return instanceId ? { name: instanceId, host: '', port: null, instance: instanceId } : null;
  return {
    host: sys.host || '',
    port: sys.port == null ? null : sys.port,
    name: sys.short || sys.label || system,
    instance: instanceId || system,
  };
}

function firstAction(button) {
  const actions = button && button.actions;
  if (!actions) return null;
  for (const ev of ['press', 'release', 'hold', 'turn', 'push', 'touch']) {
    if (actions[ev] && actions[ev][0]) return actions[ev][0];
  }
  return null;
}

function controlFrom(button, slot, desk) {
  const row = firstAction(button);
  const request = actionToRequest(row);
  const target = slot && slot.target && slot.target.mode ? slot.target : (button.target || { mode: 'follow' });
  const fixed = target.mode === 'fixed';
  const system = (fixed && target.system) || (row && moduleOf(row.action)) || '';
  const instance = fixed ? concrete(target.instance) : concrete(row && row.instance);
  const device = system ? deviceFor(system, desk, instance) : null;
  const face = resolveKey(button, {}, varsFrom(desk));
  let action = request && request.path ? { method: request.method, path: request.path, body: { ...(request.body || {}) } } : null;
  if (action && device && device.cam) action.body = { ...action.body, cam: device.cam };
  else if (action && fixed && instance && system !== 'ptz') action.body = { ...action.body, instance };
  const caption = face.caption || (device && device.cam ? device.name : '') || '';
  return {
    system,
    jump: request && request.jump ? request.jump : null,
    key: {
      label: face.text || button.name || ' ',
      value: face.title || '',
      caption,
      action,
      jump: request && request.jump ? request.jump : null,
      role: button.role || '',
      device,
    },
  };
}

function compileUserPage(record, byId, surface, desk) {
  const keys = [];
  const jumps = [];
  let system = '';
  let device = null;
  for (const slot of record.keys || []) {
    const button = byId.get(slot.buttonId);
    if (!button || button.element !== 'button') continue;
    const built = controlFrom(button, slot, desk);
    if (!system && built.system) { system = built.system; device = built.key.device; }
    if (built.jump) jumps.push(built.jump);
    keys.push({ row: slot.row, col: slot.col, ...built.key });
  }
  const knobs = [];
  const strip = [];
  const dials = [];
  for (let col = 0; col < surface.cols; col++) dials.push('off');
  for (const slot of record.encoders || []) {
    const button = byId.get(slot.buttonId);
    if (!button || button.element !== 'encoder') continue;
    const built = controlFrom(button, slot, desk);
    if (!system && built.system) { system = built.system; device = built.key.device; }
    knobs.push({ col: slot.col, ...built.key });
  }
  for (const slot of record.touch || []) {
    const button = byId.get(slot.buttonId);
    if (!button || button.element !== 'touch-segment') continue;
    const built = controlFrom(button, slot, desk);
    strip.push({ col: slot.col, ...built.key });
  }
  return {
    id: record.id,
    system: system || 'page',
    title: record.name,
    profile: null,
    surface: record.surface,
    user: true,
    keys: fillGrid(keys, surface, device),
    jumps: [...new Set(jumps)],
    device,
    dials,
    knobs,
    strip,
  };
}

module.exports = { actionToRequest, compileUserPage, hasSlots, fillGrid };
