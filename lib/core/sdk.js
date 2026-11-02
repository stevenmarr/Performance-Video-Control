'use strict';
// Module contract. A new device is a manifest plus a driver. The desk does not
// grow a special case for it. Planned gear (Videohub, HyperDeck, Mitti) is
// listed so the contract is visible before a driver exists. They are not on
// the SYSTEMS palette until a driver lands.

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

const REQUIRED = ['id', 'label', 'kind'];

function defineModule(raw) {
  if (!raw || typeof raw !== 'object') throw fail('A module manifest is an object');
  for (const k of REQUIRED) if (!raw[k] || typeof raw[k] !== 'string') throw fail(`Module manifest needs ${k}`);
  const id = String(raw.id).slice(0, 40);
  if (!/^[a-z][\w.-]{0,39}$/.test(id)) throw fail(`Bad module id "${id}"`);
  const actions = Array.isArray(raw.actions) ? raw.actions.map(cleanAction) : [];
  const feedbacks = Array.isArray(raw.feedbacks) ? raw.feedbacks.map(cleanFeedback) : [];
  return Object.freeze({
    id,
    label: String(raw.label).slice(0, 80),
    kind: String(raw.kind).slice(0, 40),
    status: raw.status === 'planned' ? 'planned' : 'ready',
    summary: String(raw.summary || '').slice(0, 240),
    connection: raw.connection || null,
    state: raw.state || null,
    actions,
    feedbacks,
    surfaces: raw.surfaces || null,
    regions: Array.isArray(raw.regions) ? raw.regions.map((r) => String(r).slice(0, 40)) : [],
    plain: Array.isArray(raw.plain) ? raw.plain.map((r) => String(r)) : [],
  });
}

function cleanAction(a) {
  if (typeof a === 'string') return { id: a, timeoutMs: 8000 };
  return { id: String(a.id), timeoutMs: Number(a.timeoutMs) || 8000, guard: a.guard || null, description: a.description ? String(a.description).slice(0, 160) : '' };
}
function cleanFeedback(f) {
  if (typeof f === 'string') return { id: f };
  return { id: String(f.id), description: f.description ? String(f.description).slice(0, 160) : '' };
}

function adaptDriver(manifest, getDriver) {
  return {
    manifest,
    connect: () => getDriver().connect(),
    poll: () => {
      const driver = getDriver();
      if (driver && typeof driver.heartbeat === 'function') return driver.heartbeat();
      const st = driver.status();
      if (!st.connected) throw new Error(st.error || 'not connected');
      return st;
    },
    close: () => { const driver = getDriver(); if (driver && driver.close) driver.close(); },
    status: () => getDriver().status(),
  };
}

const BUILTIN = [
  defineModule({
    id: 'rs6', label: 'Analog Way Aquilon RS6', kind: 'rs6', summary: 'Presets, take, cut. The original id uses the Engine.',
    regions: ['presets', 'inputs', 'backup', 'audio'],
    actions: ['recall', 'take', 'cut'], feedbacks: ['connected', 'preset'],
    plain: ['selection'],
  }),
  defineModule({
    id: 'e2', label: 'Barco Event Master', kind: 'preset', summary: 'Presets to preview, then take or cut.',
    regions: ['presets', 'destinations'], actions: ['recall', 'take', 'cut'], feedbacks: ['connected', 'tally'],
  }),
  defineModule({
    id: 'pixelhue', label: 'PixelHue', kind: 'preset', summary: 'Presets to preview, then take or cut.',
    regions: ['presets', 'destinations'], actions: ['recall', 'take', 'cut'], feedbacks: ['connected', 'tally'],
  }),
  defineModule({
    id: 'atem', label: 'Blackmagic ATEM', kind: 'atem', summary: 'Switcher, router, audio, macros. Connection and macro run use state machines. Bus sources and fader levels stay plain values.',
    regions: ['switcher', 'router', 'audio', 'macros', 'layout'],
    actions: ['cut', 'auto', 'program', 'preview', 'macroRun', 'macroStop'],
    feedbacks: ['connected', 'program', 'preview', 'macro'],
    plain: ['program', 'preview', 'gain', 'crosspoint'],
    surfaces: { templates: ['atem-switcher', 'atem-macros'] },
  }),
  defineModule({
    id: 'ptz', label: 'Panasonic PTZ', kind: 'ptz', summary: 'One system, many cameras. Each camera has its own connection machine. Iris and gain are plain values.',
    regions: ['cameras', 'presets', 'paint', 'move'],
    actions: ['move', 'zoom', 'focus', 'recall', 'gain', 'iris'],
    feedbacks: ['connected', 'tally', 'power'],
    plain: ['gain', 'iris', 'shutter', 'whiteBalance'],
    surfaces: { templates: ['ptz-live', 'ptz-paint', 'ptz-func', 'ptz-move'] },
  }),
  defineModule({
    id: 'pixera', label: 'Pixera', kind: 'pixera', summary: 'Timeline transport uses the transport state machine.',
    regions: ['transport', 'cues'], actions: ['play', 'pause', 'stop'], feedbacks: ['transport', 'cue'],
  }),
  defineModule({
    id: 'millumin', label: 'Millumin', kind: 'millumin', summary: 'Columns and transport.',
    regions: ['transport', 'columns'], actions: ['play', 'pause'], feedbacks: ['column'],
  }),
  defineModule({
    id: 'tsl', label: 'TSL tally', kind: 'tally', summary: 'UDP tally out. Not a desk system.',
    actions: [], feedbacks: ['lastSend'], regions: ['tally'],
  }),
  defineModule({
    id: 'console', label: 'Control Center console', kind: 'core',
    summary: 'Focus, shows, profiles, connection, health, services, guarded power, panel lock.',
    regions: ['console'],
    surfaces: { templates: ['console', 'console-power'] },
    actions: [
      { id: 'focus', description: 'Focus a system instance' },
      { id: 'focus.next', description: 'Focus the next system on the desk' },
      { id: 'profile.load', description: 'Load a console profile' },
      { id: 'profile.save', description: 'Save the console profile' },
      { id: 'show.save', description: 'Save the show file' },
      { id: 'show.stage', description: 'Pick the next show file' },
      { id: 'show.load', description: 'Load the staged show. Two presses.', guard: 'LOAD' },
      { id: 'connection.reconnect', description: 'Reconnect the focused instance, or the one you name' },
      { id: 'connection.disconnect', description: 'Hold the link down' },
      { id: 'module.enable', description: 'Enable or disable one instance' },
      { id: 'module.restart', description: 'Close and connect one instance' },
      { id: 'health.ack', description: 'Acknowledge health alerts' },
      { id: 'service.refresh', description: 'Read speaker timer, SMB, and Companion' },
      { id: 'service.enable', description: 'Remember a service as on or off' },
      { id: 'host.shutdown', description: 'Guarded Pi shutdown. Two presses. CC_HOST_POWER=1.', guard: 'SHUTDOWN' },
      { id: 'host.reboot', description: 'Guarded Pi reboot. Two presses. CC_HOST_POWER=1.', guard: 'REBOOT' },
      { id: 'host.cancel', description: 'Cancel a pending shutdown or reboot' },
      { id: 'panel.lock', description: 'Lock the Stream Deck panel' },
      { id: 'panel.unlock', description: 'Unlock the panel' },
      { id: 'panel.safe', description: 'Safe mode: no power, no show load, no module off' },
      { id: 'panel.pin', description: 'Set the unlock PIN' },
    ],
    feedbacks: [
      'focus.instance', 'focus.name', 'focus.fsm',
      'profile.id', 'profile.name',
      'show.id', 'show.name', 'show.dirty', 'show.staged',
      'health.ok', 'health.alert',
      'service.speakerTimer', 'service.smb', 'service.companion',
      'panel.locked', 'panel.safe',
      'host.pending', 'host.powerArmed',
    ],
  }),
  defineModule({
    id: 'videohub', label: 'Blackmagic Videohub', kind: 'router', status: 'planned',
    summary: 'Phase 2 driver. Crosspoints are plain state. Connection uses the shared machine.',
    regions: ['router'], actions: ['crosspoint'], feedbacks: ['connected', 'crosspoint'], plain: ['crosspoint'],
  }),
  defineModule({
    id: 'hyperdeck', label: 'Blackmagic HyperDeck', kind: 'transport', status: 'planned',
    summary: 'Phase 2 driver. Record and play use the transport machine.',
    regions: ['transport'], actions: ['play', 'stop', 'record'], feedbacks: ['transport'],
  }),
  defineModule({
    id: 'mitti', label: 'Mitti', kind: 'media', status: 'planned',
    summary: 'Phase 2 driver. Cues and transport.',
    regions: ['transport', 'cues'], actions: ['play', 'cue'], feedbacks: ['cue'],
  }),
];

function createCatalog() {
  const modules = new Map(BUILTIN.map((m) => [m.id, m]));
  return {
    get: (id) => modules.get(id) || null,
    list: () => [...modules.values()],
    register(raw) {
      const m = raw.status || raw.actions ? (raw.id && raw.label && Object.isFrozen(raw) ? raw : defineModule(raw)) : defineModule(raw);
      if (modules.has(m.id) && modules.get(m.id).status !== 'planned') throw fail(`Module "${m.id}" is already registered`);
      modules.set(m.id, m);
      return m;
    },
  };
}

module.exports = { defineModule, adaptDriver, createCatalog, BUILTIN };
