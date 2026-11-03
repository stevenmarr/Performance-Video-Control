'use strict';
// Control Center OS. One registry, one connection machine per device, one
// action path, one snapshot. The desk (SystemManager) still owns drivers and
// the HTTP routes you already have. This object is what they sit on.
const path = require('path');
const { EventEmitter } = require('events');
const { createConnection, step, legacyLink, due } = require('./connection');
const { createTransport, send: sendTransport } = require('./transport');
const { createMacro, send: sendMacro, mirror: mirrorMacro, eventForAtem } = require('./macro');
const { createLog } = require('./log');
const { createDispatch } = require('./dispatch');
const { createSupervisor } = require('./supervisor');
const { load, save, cleanConnection } = require('./persist');
const { createSurfaces } = require('./surfaces');
const { createAlerts } = require('./alerts');
const { createServices } = require('./services');
const { createPanel } = require('./panel');
const { createHost } = require('./host');
const { createCatalog, adaptDriver } = require('./sdk');
const { sdNotify } = require('./notify');
const cue = require('../cue-machine');

const VERSION_FALLBACK = '0.29.3';

const META = {
  'panel.unlock': { locked: true },
  'panel.lock': { locked: true },
  'health.ack': { locked: true },
  'health.status': { locked: true },
  'connection.status': { locked: true },
  'service.refresh': { locked: true },
  'host.cancel': { locked: true },
  'host.shutdown': { danger: true },
  'host.reboot': { danger: true },
  'show.load': { danger: true },
};

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function makeToken() {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 6).toUpperCase() || 'CONFIRM';
}

function createControlCenter(opts = {}) {
  const file = path.join(opts.dataDir || '.', 'console.json');
  const store = load(file);
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const log = createLog();
  const dispatch = createDispatch(log);
  const supervisor = createSupervisor(log);
  const catalog = createCatalog();
  const alerts = createAlerts(bus);
  let persistTimer = null;
  const os = {
    bus, log, dispatch, supervisor, catalog, alerts, store,
    version: opts.version || VERSION_FALLBACK,
    systems: null,
    engine: null,
    decks: null,
    cameras: new Map(),
    transports: new Map(),
    macros: new Map(),
    feedbackLive: new Map(),
    staged: null,
    pending: new Map(),
    watch: { beat: Date.now(), started: true, timer: null },
  };

  function persist() {
    try { save(file, store); } catch (e) { log.write({ level: 'error', kind: 'persist', msg: e.message }); }
  }
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 200);
    if (persistTimer.unref) persistTimer.unref();
  }
  os.persist = persist;

  function touch() {
    persistSoon();
    if (os.systems) os.systems.changed();
  }
  os.surfaces = createSurfaces(store, touch);
  os.panel = createPanel(store, touch);
  os.host = createHost(log);
  os.services = createServices(store, opts.services || {});

  os.record = (entry) => log.write(entry || {});
  os.moduleEnabled = (id) => store.modules[id] !== false;
  os.cameraState = (instanceId, camId) => {
    const m = os.cameras.get(`${instanceId}:${camId}`);
    return m ? m.state : 'disconnected';
  };
  os.adapterFor = (slot) => adaptDriver(catalog.get(slot.type), () => slot.driver);

  os.attach = (slot) => {
    if (!slot.conn) slot.conn = createConnection({ baseMs: opts.pollMs || 1000 });
    return slot;
  };
  os.detach = (id) => {
    for (const key of [...os.cameras.keys()]) if (key.startsWith(`${id}:`)) os.cameras.delete(key);
    for (const key of [...os.transports.keys()]) if (key.startsWith(`${id}:`)) os.transports.delete(key);
    os.macros.delete(id);
  };

  os.noteCameras = (instanceId, list) => {
    const seen = new Set();
    for (const cam of list || []) {
      const key = `${instanceId}:${cam.id}`;
      seen.add(key);
      let machine = os.cameras.get(key) || createConnection({ baseMs: opts.pollMs || 1000 });
      if (cam.connected) {
        if (machine.state === 'disconnected' || machine.state === 'failed') machine = step(machine, { type: 'start' }).machine;
        else if (machine.state === 'reconnecting') machine = step(machine, { type: 'retry' }).machine;
        machine = step(machine, { type: 'up' }).machine;
      } else if (machine.state === 'connected' || machine.state === 'degraded' || machine.state === 'connecting') {
        machine = step(machine, { type: 'down', error: cam.error || 'no answer' }).machine;
      } else if (machine.state === 'disconnected') {
        machine = step(machine, { type: 'start' }).machine;
        machine = step(machine, { type: 'down', error: cam.error || 'no answer' }).machine;
      }
      os.cameras.set(key, machine);
    }
    for (const key of [...os.cameras.keys()]) if (key.startsWith(`${instanceId}:`) && !seen.has(key)) os.cameras.delete(key);
  };

  os.noteTransport = (instanceId, handle, mode) => {
    const key = `${instanceId}:${handle}`;
    const type = mode === 'toggle' ? 'toggle' : mode;
    const result = sendTransport(os.transports.get(key), type);
    os.transports.set(key, result.machine);
    return result.machine.state;
  };
  os.noteMacro = (instanceId, command) => {
    const type = eventForAtem(command);
    if (!type) return null;
    const result = mirrorMacro(os.macros.get(instanceId), type);
    os.macros.set(instanceId, result.machine);
    return result.machine.state;
  };

  os.showStatus = () => {
    const engine = os.engine;
    if (!engine || typeof engine.showStatus !== 'function') return { id: null, name: '', dirty: false };
    try { return engine.showStatus(); } catch { return { id: null, name: '', dirty: false }; }
  };

  os.companionFresh = () => {
    const cutoff = Date.now() - 30000;
    for (const row of os.feedbackLive.values()) if (row.at >= cutoff) return true;
    return false;
  };
  os.companionSnapshot = () => ({
    connections: (store.companion.connections || []).map((c) => ({
      id: c.id, moduleId: c.moduleId, label: c.label, host: c.host, port: c.port, note: c.note,
      feedback: os.feedbackLive.get(c.id) || null,
    })),
  });

  os.feedbacks = () => {
    const flat = {};
    const connection = {};
    const systems = os.systems;
    if (systems && systems.cfg) {
      flat['focus.instance'] = systems.cfg.active || '';
      try { flat['focus.name'] = systems.labelOf(systems.cfg.active); } catch { flat['focus.name'] = systems.cfg.active || ''; }
      const active = systems.pool && systems.pool.get(systems.cfg.active);
      if (active && systems.reportedFsm) flat['focus.fsm'] = systems.reportedFsm(active);
      if (systems.pool) {
        for (const slot of systems.pool.values()) {
          let show = true;
          try { show = systems._materialized(slot); } catch { show = true; }
          if (!show) continue;
          const fsm = systems.reportedFsm ? systems.reportedFsm(slot) : (slot.conn && slot.conn.state);
          const link = systems.linkOf ? systems.linkOf(slot) : legacyLink(slot.conn);
          const connected = !!(slot.driver && slot.driver.status && slot.driver.status().connected);
          connection[slot.id] = { fsm, link, connected, enabled: os.moduleEnabled(slot.id), attempt: slot.conn && slot.conn.context ? slot.conn.context.attempt : 0 };
          flat[`connection.${slot.id}.fsm`] = fsm;
          flat[`module.${slot.id}.enabled`] = os.moduleEnabled(slot.id);
        }
      }
    }
    const show = os.showStatus();
    const services = os.services.snapshot();
    const pending = os.host.pending();
    Object.assign(flat, {
      'profile.id': os.surfaces.profile().id,
      'profile.name': os.surfaces.profile().name,
      'show.id': show.id || '',
      'show.name': show.name || '',
      'show.dirty': !!show.dirty,
      'show.staged': os.staged ? (os.staged.name || os.staged.id) : '',
      'health.ok': true,
      'health.alert': alerts.unacked(),
      'service.speakerTimer': services.speakerTimer.state,
      'service.smb': services.smb.state,
      'service.companion': services.companion.state,
      'panel.locked': os.panel.locked,
      'panel.safe': os.panel.safe,
      'host.pending': pending ? pending.cmd : '',
      'host.powerArmed': os.host.powerArmed(),
    });
    if (services.speakerTimer.output) flat['service.speakerTimer.output'] = services.speakerTimer.output;
    return {
      flat, connection, alerts: alerts.list(), service: services, panel: os.panel.snapshot(),
      host: { pending, powerArmed: os.host.powerArmed() },
    };
  };

  os.health = () => {
    const age = Date.now() - os.watch.beat;
    const stalled = !!(os.watch.started && age > 20000);
    if (stalled) alerts.raise('watchdog', { level: 'failed', source: 'core', message: 'core tick stalled' });
    const instances = [];
    if (os.systems && os.systems.pool) {
      for (const slot of os.systems.pool.values()) {
        let show = true;
        try { show = os.systems._materialized(slot); } catch { show = false; }
        if (!show) continue;
        instances.push({
          id: slot.id, type: slot.type, name: safeName(slot),
          fsm: os.systems.reportedFsm(slot), link: os.systems.linkOf(slot),
          enabled: os.moduleEnabled(slot.id),
        });
      }
    }
    const bad = instances.some((i) => i.fsm === 'failed' || i.fsm === 'degraded');
    return {
      ok: !stalled,
      status: stalled ? 'stalled' : bad ? 'degraded' : 'ok',
      version: os.version,
      uptimeSec: Math.round(process.uptime()),
      now: new Date().toISOString(),
      watchdog: { lastBeat: os.watch.beat, ageMs: age, stalled },
      instances,
      alerts: alerts.unacked(),
      panel: os.panel.snapshot(),
      services: os.services.snapshot(),
    };
  };

  function safeName(slot) {
    try { return os.systems.labelOf(slot.id); } catch { return slot.id; }
  }

  os.snapshot = () => {
    let instances = [];
    try { instances = os.systems && os.systems.listInstances ? os.systems.listInstances() : []; } catch { instances = []; }
    const fb = os.feedbacks();
    fb.flat['health.ok'] = os.health().ok;
    return {
      rev: os.systems ? os.systems.rev : 0,
      modules: catalog.list().map((m) => ({ id: m.id, label: m.label, kind: m.kind, status: m.status, actions: m.actions.map((a) => a.id), feedbacks: m.feedbacks.map((f) => f.id) })),
      instances: instances.map((i) => ({
        id: i.id, type: i.type, name: i.name, primary: i.primary,
        fsm: i.status && i.status.fsm, link: i.status && i.status.link, connected: !!(i.status && i.status.connected),
        enabled: os.moduleEnabled(i.id),
        cameras: (i.cameras || []).map((c) => ({ id: c.id, name: c.name, connected: c.connected, fsm: os.cameraState(i.id, c.id) })),
      })),
      console: fb.flat,
      feedbacks: fb,
      companion: os.companionSnapshot(),
      surfaces: os.surfaces.snapshot(),
      transitions: log.transitions(30),
      actions: dispatch.recent().slice(-15),
      transport: Object.fromEntries([...os.transports.entries()].map(([k, m]) => [k, m.state])),
      macros: Object.fromEntries([...os.macros.entries()].map(([k, m]) => [k, m.state])),
    };
  };

  os.publish = () => {
    try { bus.emit('change', os.snapshot()); } catch (e) { log.write({ level: 'error', kind: 'snapshot', msg: e.message }); }
  };

  os.guard = (key, input, word, extra) => {
    const now = Date.now();
    const cur = os.pending.get(key);
    const confirm = input && input.confirm;
    if (cur && now <= cur.until) {
      const wordOk = confirm === word || confirm === cur.token || confirm === true;
      const same = !cur.extra || !extra || !cur.extra.id || !extra.id || cur.extra.id === extra.id;
      const bare = same && (confirm == null || confirm === '') && (now - cur.at >= 250);
      if (same && (wordOk || bare)) {
        os.pending.delete(key);
        return { armed: true, pending: false, extra: cur.extra };
      }
    }
    const row = { token: makeToken(), at: now, until: now + 8000, extra: extra || null };
    os.pending.set(key, row);
    return { armed: false, pending: true, confirm: row.token, word, until: row.until };
  };

  function needSystems() {
    if (!os.systems) throw fail(503, 'Desk is not running');
    return os.systems;
  }
  function instanceId(input, fallback) {
    const systems = needSystems();
    const id = (input && input.instance) || fallback || systems.cfg.active;
    systems.bag(id);
    return id;
  }

  async function reconnectTo(id) {
    const systems = needSystems();
    if (!os.moduleEnabled(id)) throw fail(409, `${systems.labelOf(id)} is disabled`);
    const slot = systems.bag(id);
    if (slot.type === 'rs6' && slot.primary) {
      if (!systems.engine || typeof systems.engine.connect !== 'function') throw fail(409, 'The original RS6 connects through its settings');
      await systems.engine.connect();
      return { ok: true, id, fsm: systems.reportedFsm(slot) };
    }
    await systems.connect(id);
    return { ok: true, id, fsm: systems.reportedFsm(systems.bag(id)) };
  }

  async function perform(action, input) {
    const body = input || {};
    const systems = os.systems;
    switch (action) {
      case 'focus': {
        const id = instanceId(body);
        await systems.setActive(id);
        if (body.surfaceId) os.surfaces.setFocus(body.surfaceId, id);
        return { ok: true, instance: systems.cfg.active, name: systems.labelOf(systems.cfg.active) };
      }
      case 'focus.next': {
        const systems = needSystems();
        const armed = (systems.cfg.armed || []).filter((id) => systems.typeOf(id));
        if (!armed.length) throw fail(409, 'Nothing is on the desk');
        const i = Math.max(0, armed.indexOf(systems.cfg.active));
        const id = armed[(i + 1) % armed.length];
        await systems.setActive(id);
        return { ok: true, instance: id, name: systems.labelOf(id) };
      }
      case 'profile.load':
        return os.surfaces.activate(String(body.id || ''));
      case 'profile.save':
        return os.surfaces.saveAs(body.id || `p${Date.now().toString(36)}`, body.name || os.surfaces.profile().name);
      case 'show.save': {
        if (!os.engine || typeof os.engine.saveShow !== 'function') throw fail(503, 'No show engine');
        return os.engine.saveShow({ name: body.name, asNew: !!body.asNew });
      }
      case 'show.stage': {
        if (!os.engine || typeof os.engine.listShows !== 'function') throw fail(503, 'No show library');
        const list = os.engine.listShows().shows || [];
        if (!list.length) throw fail(409, 'No show in the library');
        if (body.id) os.staged = list.find((s) => s.id === body.id) || { id: String(body.id), name: String(body.id) };
        else {
          const idx = os.staged ? list.findIndex((s) => s.id === os.staged.id) : -1;
          os.staged = list[(idx + 1) % list.length];
        }
        return { id: os.staged.id, name: os.staged.name || os.staged.id };
      }
      case 'show.load': {
        if (os.panel.safe) throw fail(409, 'Safe mode will not load a show');
        if (!os.engine || typeof os.engine.openShow !== 'function') throw fail(503, 'No show engine');
        const id = body.id || (os.staged && os.staged.id);
        if (!id) throw fail(400, 'Stage a show, or send { id }');
        const gate = os.guard('show.load', body, 'LOAD', { id: String(id) });
        if (!gate.armed) return gate;
        await os.engine.openShow({ id: String(id) }, { applyConnection: false });
        const showId = os.engine.currentShow && os.engine.currentShow.id;
        if (showId) os.surfaces.useShow(showId);
        return { ok: true, id: String(id), name: os.engine.currentShow && os.engine.currentShow.name };
      }
      case 'connection.status': {
        const id = instanceId(body);
        const slot = systems.bag(id);
        return { id, fsm: systems.reportedFsm(slot), link: systems.linkOf(slot), enabled: os.moduleEnabled(id), status: slot.driver ? slot.driver.status() : null };
      }
      case 'connection.reconnect':
        return reconnectTo(instanceId(body));
      case 'connection.disconnect': {
        const id = instanceId(body);
        return systems.disconnectInstance(id);
      }
      case 'module.enable': {
        const id = instanceId(body);
        const on = body.on !== false && body.on !== 0;
        if (os.panel.safe && !on) throw fail(409, 'Safe mode will not disable a module');
        if (on) delete store.modules[id]; else store.modules[id] = false;
        persist();
        const slot = systems.bag(id);
        if (!on) {
          systems._apply(slot, { type: 'stop' });
          try { if (slot.driver && slot.driver.close) slot.driver.close(); } catch { /* already closed */ }
          systems.changed();
        } else {
          slot.hold = false;
          await systems.connect(id).catch(() => {});
        }
        return { ok: true, id, enabled: os.moduleEnabled(id), fsm: systems.reportedFsm(slot) };
      }
      case 'module.restart': {
        const id = instanceId(body);
        if (!os.moduleEnabled(id)) throw fail(409, `${needSystems().labelOf(id)} is disabled`);
        const slot = needSystems().bag(id);
        try { if (slot.driver && slot.driver.close) slot.driver.close(); } catch { /* already closed */ }
        const row = await reconnectTo(id);
        log.write({ level: 'warn', kind: 'restart', msg: `${needSystems().labelOf(id)}: module restart`, instance: id });
        return row;
      }
      case 'health.ack':
        return alerts.ack(body.id || 'all');
      case 'health.status':
        return os.health();
      case 'service.refresh': {
        const snap = await os.services.refresh({
          companionFresh: os.companionFresh(),
          companionConfigured: (store.companion.connections || []).length > 0,
        });
        return snap;
      }
      case 'service.enable': {
        const id = String(body.id || '');
        const cur = os.services.snapshot()[id];
        const on = body.on === undefined ? !(cur && cur.enabled) : body.on !== false && body.on !== 0;
        const row = await os.services.setEnabled(id, on);
        persist();
        return row;
      }
      case 'host.cancel':
        return os.host.cancel();
      case 'host.shutdown':
      case 'host.reboot': {
        if (os.panel.locked) throw fail(423, 'Panel is locked');
        if (os.panel.safe) throw fail(409, 'Safe mode blocks power');
        const kind = action === 'host.reboot' ? 'reboot' : 'shutdown';
        const gate = os.host.request(kind, body);
        if (gate.pending) return gate;
        await gate.run();
        return { ok: true, kind };
      }
      case 'panel.lock':
        return os.panel.lock();
      case 'panel.unlock':
        return os.panel.unlock(body.pin);
      case 'panel.safe':
        return os.panel.setSafe(body.on);
      case 'panel.pin':
        return os.panel.setPin(body.pin, body.next);
      default:
        throw fail(404, `Unknown core action "${action}"`);
    }
  }

  os.command = (action, input) => {
    const name = String(action || '');
    const meta = META[name] || {};
    if (os.panel.locked && !meta.locked) return Promise.reject(fail(423, 'Panel is locked'));
    return dispatch.run({
      module: 'console',
      instance: input && input.instance || null,
      action: name,
      timeoutMs: name.startsWith('host.') ? 8000 : 10000,
      run: () => perform(name, input || {}),
    });
  };

  os.satKeys = new Map();
  os.setSatellite = (input) => {
    const url = String((input && input.url) || '').trim().slice(0, 300);
    if (url && !/^https?:\/\//i.test(url)) throw fail(400, 'Satellite URL must be http or https');
    store.companion.satelliteUrl = url;
    persist();
    return { url };
  };
  os.satelliteKey = (surfaceId, col, row) => os.satKeys.get(`${surfaceId}:${col}:${row}`) || null;
  os.satelliteKeys = (input) => {
    const surfaceId = String((input && input.surfaceId) || '').slice(0, 200);
    if (!surfaceId) throw fail(400, 'surfaceId is required');
    const list = Array.isArray(input.keys) ? input.keys.slice(0, 80) : [];
    for (const key of list) {
      const col = Number(key && key.col);
      const row = Number(key && key.row);
      if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
      os.satKeys.set(`${surfaceId}:${col}:${row}`, {
        label: String((key && key.label) || 'COMPANION').slice(0, 12),
        caption: String((key && key.caption) || '').slice(0, 12),
        tone: String((key && key.tone) || 'nav').slice(0, 16),
        at: Date.now(),
      });
    }
    if (os.systems) os.systems.changed();
    return { ok: true, surfaceId, keys: list.length };
  };
  os.satellitePress = async (surfaceId, col, row) => {
    const url = store.companion.satelliteUrl;
    if (!url) throw fail(409, 'That key is owned by Companion. No satellite URL is set.');
    const http = url.startsWith('https:') ? require('https') : require('http');
    const body = JSON.stringify({ surfaceId, col, row, event: 'down' });
    await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 1500 }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('timeout', () => { req.destroy(); reject(fail(504, 'Companion satellite did not answer')); });
      req.on('error', (e) => reject(fail(502, `Companion satellite: ${e.message}`)));
      req.write(body);
      req.end();
    });
    return { ok: true, owner: 'companion', surfaceId, col, row };
  };

  os.addCompanion = (input) => {
    const row = cleanConnection({ ...input, id: input.id || `c${Date.now().toString(36)}` });
    if (!row) throw fail(400, 'A Companion connection needs a moduleId');
    store.companion.connections.push(row);
    persist();
    return row;
  };
  os.removeCompanion = (id) => {
    const before = store.companion.connections.length;
    store.companion.connections = store.companion.connections.filter((c) => c.id !== id);
    os.feedbackLive.delete(id);
    if (store.companion.connections.length === before) throw fail(404, `No Companion connection "${id}"`);
    persist();
    return { ok: true };
  };
  os.companionFeedback = (input) => {
    const id = String((input && input.id) || '');
    const row = (store.companion.connections || []).find((c) => c.id === id);
    if (!row) throw fail(404, `No Companion connection "${id}"`);
    const variables = input.variables && typeof input.variables === 'object' ? input.variables : {};
    const buttons = Array.isArray(input.buttons) ? input.buttons.slice(0, 64) : [];
    const packed = JSON.stringify({ variables, buttons });
    if (packed.length > 32000) throw fail(413, 'Feedback is too large');
    const live = { at: Date.now(), status: input.status ? String(input.status).slice(0, 40) : 'ok', variables, buttons };
    os.feedbackLive.set(id, live);
    return { ok: true, id, at: live.at };
  };

  os.ready = () => { os.watch.beat = Date.now(); sdNotify('READY=1', { sync: true }); };
  os.watch.timer = setInterval(() => {
    os.watch.beat = Date.now();
    sdNotify('WATCHDOG=1');
    os.services.refresh({
      companionFresh: os.companionFresh(),
      companionConfigured: (store.companion.connections || []).length > 0,
    }).catch(() => {});
  }, 5000);
  if (os.watch.timer.unref) os.watch.timer.unref();

  os.close = () => {
    if (os.watch.timer) clearInterval(os.watch.timer);
    os.watch.timer = null;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    try { persist(); } catch { /* ignore */ }
  };

  os.bindDesk = (systems) => {
    os.systems = systems;
    os.engine = systems && systems.engine;
    if (opts.showId) os.showId = opts.showId;
  };

  return os;
}

module.exports = {
  createControlCenter,
  createConnection,
  step,
  legacyLink,
  due,
  createTransport,
  sendTransport,
  createMacro,
  sendMacro,
  mirrorMacro,
  cue,
  META,
};
