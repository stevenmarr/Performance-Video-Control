'use strict';
// Desk → Stream Deck stacks. Devices come from the Path C plugin HTTP API.
// This process does not invent a connected deck. Stacks are the only thing persisted.

const fs = require('fs');
const path = require('path');
const { SURFACES, ORDER, surfaceById, surfaceFor } = require('./surfaces');
const { knownOffline } = require('./known-devices');
const { libraryFor, catalogIds, stampPage, stackWarnings, moveItem, linkPages } = require('./pages');
const { compileUserPage, hasSlots, parseSysCmd, atemSwitcherDeploy } = require('./page-push');
const client = require('./plugin-client');
const { show, applyReadouts } = require('./faces');
const { plan, dialFace, LONG_PRESS_MS } = require('../deck');
const { velocityFor, HOLD } = require('../paint-accel');
const { choicesFor } = require('./atem-switcher');
const { EFFECTS, WIPES, cycle, toggleMes, fireMes } = require('./atem-map');
const { hardwareNext } = require('./atem-xl-page');
const { keySvg, knobSvg } = require('../deck-image');
const { keyModel, keyImage } = require('./look');
const { createDeckUsb, usbDisabled } = require('./usb-host');
const { stampConsole } = require('../core/console-deck');

const fail = (status, message) => Object.assign(new Error(message), { status });

function steppedKey(key) {
  const steps = key && key.action && key.action.body && key.action.body.steps;
  return Number.isInteger(Number(steps)) && Number(steps) !== 0 && key.action.body.op;
}

function slimKeys(keys) {
  return (keys || []).map((key) => {
    if (!key || !key.svg) return key;
    const copy = { ...key };
    delete copy.svg;
    return copy;
  });
}

function slimFace(face) {
  if (!face) return face;
  const dials = (face.dials || []).map((dial) => {
    if (!dial || !dial.svg) return dial;
    const copy = { ...dial };
    delete copy.svg;
    return copy;
  });
  return { ...face, keys: slimKeys(face.keys), dials };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

class DeckService {
  constructor({ dataDir, systems, engine, pluginUrl, usbEnv, buttons } = {}) {
    if (!dataDir) throw new Error('DeckService needs a data directory');
    this.dataDir = dataDir;
    this.systems = systems;
    this.engine = engine;
    this.buttons = buttons || null;
    this.file = path.join(dataDir, 'decks.json');
    const raw = readJson(this.file);
    this.pluginUrl = pluginUrl || raw.pluginUrl || client.DEFAULT_URL;
    this.stacks = raw.stacks && typeof raw.stacks === 'object' ? raw.stacks : {};
    this.loaded = raw.loaded && typeof raw.loaded === 'object' ? raw.loaded : {};
    this.sessions = new Map();
    if (raw.sessions && typeof raw.sessions === 'object') {
      for (const [id, saved] of Object.entries(raw.sessions)) {
        if (!saved || typeof saved !== 'object') continue;
        this.sessions.set(id, { system: saved.system || null, page: Number(saved.page) || 0, out: saved.out || null, atemUi: saved.atemUi || null });
      }
    }
    this.usb = createDeckUsb({ log: (level, msg) => this._logLine(level, msg), env: usbEnv });
    this._usbSeen = new Set();
    this._usbFailSeen = new Set();
    this._usbSkipSeen = new Set();
    this._usbFound = null;
    this._usbLoggedMissing = false;
    this._usbBusy = null;
    this._usbTimer = null;
    this._usbWatch = null;
    this._usbWatchTimer = null;
    this.usbDevices = [];
    this.devices = [];
    this.online = false;
    this.lastError = null;
    this.steps = new Map();
    this.dialDown = new Map();
    this.turnedAt = new Map();
    this._motions = new Map();
    this._stepsHeld = new Map();
    this._mapHolds = new Map();
    this._down = new Map();
    this._paintTimer = null;
    this._paintDue = 0;
    this._paintBusy = null;
    this._paintAgain = false;
    this.usb.onPress((id, at) => { this.press(id, at.col, at.row).catch(() => {}); });
    this.usb.onRelease((id, at) => { this.release(id, at.col, at.row).catch(() => {}); });
    this.usb.onTurn((id, at) => { this.turn(id, at.index, at.ticks, at.event).catch(() => {}); });
    if (systems && systems.on) {
      systems.on('state', () => { this.schedulePaint(48); });
    }
  }

  save() {
    const sessions = Object.fromEntries(this.sessions);
    const body = JSON.stringify({ pluginUrl: this.pluginUrl, stacks: this.stacks, loaded: this.loaded, sessions }, null, 2);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, this.file);
  }

  desk() {
    const st = this.systems && this.systems.getState ? this.systems.getState() : { armed: [], systems: {} };
    const armed = Array.isArray(st.armed) ? st.armed.slice() : [];
    const byKey = {};
    for (const key of armed) {
      const inst = (st.instances || []).find((i) => i.id === key);
      const sys = inst || (st.systems && st.systems[key]) || {};
      const type = inst ? inst.type : key;
      const conn = sys.connection || {};
      let cameras = [];
      let selected = null;
      if (type === 'ptz' && this.systems && this.systems.ptzView) {
        const view = this.systems.ptzView(key);
        cameras = (view.cameras || []).map((c) => ({ id: c.id, name: c.name, host: c.host || '', port: c.port == null ? 80 : c.port }));
        selected = view.selected || null;
      }
      const host = type === 'rs6'
        ? ((this.engine && this.engine.settings && this.engine.settings.host) || conn.host || '')
        : (conn.host || '');
      const port = type === 'rs6'
        ? ((this.engine && this.engine.settings && this.engine.settings.restPort) || conn.restPort || null)
        : (conn.port == null ? null : conn.port);
      let view = null;
      if (type === 'atem' && this.systems && this.systems.driver) {
        try { view = this.systems.driver(key).view(); } catch { view = null; }
      }
      let buttonMap = null;
      if (type === 'atem' && this.systems && this.systems.atemButtonMap) {
        try { buttonMap = this.systems.atemButtonMap(key); } catch { buttonMap = null; }
      }
      byKey[key] = { key, type, label: (inst && inst.name) || sys.label, short: (inst && inst.name) || sys.short, host, port, cameras, selected, view, buttonMap };
    }
    let cues = null;
    try { cues = this.cueStatus ? this.cueStatus() : null; } catch { cues = null; }
    return { armed, byKey, cues };
  }

  setPlugin(body = {}) {
    const url = String(body.url || '').trim().replace(/\/$/, '');
    if (!/^https?:\/\/[A-Za-z0-9._~:/\[\]%-]+$/.test(url)) throw fail(400, 'Plugin URL must be http(s)');
    this.pluginUrl = url;
    this.save();
    return { url: this.pluginUrl };
  }

  async hello(body = {}) {
    if (body && body.url) this.setPlugin(body);
    await this.refresh();
    return this.view({ refresh: false });
  }

  async refresh() {
    try {
      const data = await client.listDevices(this.pluginUrl, { timeout: 450 });
      const list = Array.isArray(data.devices) ? data.devices : [];
      this.devices = list.map((d) => this.normalize(d)).filter((d) => d.id);
      this.online = true;
      this.lastError = null;
    } catch (e) {
      this.devices = [];
      this.online = false;
      this.lastError = e.message || 'Path C plugin is not running';
    }
    await this.pollUsb();
    return { online: this.online, error: this.lastError, devices: this.devices.map((d) => ({ ...d })) };
  }

  // Open USB decks at process start, again when a hidraw node appears, and on
  // a short poll so a replug is picked up without a Scan click.
  startUsb({ intervalMs = 3000 } = {}) {
    if (this.usb && (this.usb.disabled || usbDisabled())) {
      this.pollUsb().catch(() => {});
      return this;
    }
    if (this._usbTimer) return this;
    const status = this.usb.status();
    if (!status.installed) this._logScan({ installed: false, error: status.error, found: 0, opened: [], failed: [], skipped: [] });
    const tick = () => { this.pollUsb().catch(() => {}); };
    tick();
    this._usbTimer = setInterval(tick, intervalMs);
    if (this._usbTimer.unref) this._usbTimer.unref();
    try {
      this._usbWatch = fs.watch('/dev', (_event, filename) => {
        if (!filename || !/^hidraw/i.test(String(filename))) return;
        if (this._usbWatchTimer) return;
        this._usbWatchTimer = setTimeout(() => {
          this._usbWatchTimer = null;
          this.pollUsb().catch(() => {});
        }, 400);
        if (this._usbWatchTimer.unref) this._usbWatchTimer.unref();
      });
      if (this._usbWatch.unref) this._usbWatch.unref();
      this._usbWatch.on('error', () => {});
    } catch { /* /dev is not watchable here */ }
    return this;
  }

  stopUsb() {
    if (this.usb && this.usb.stop) this.usb.stop();
    if (this._usbTimer) clearInterval(this._usbTimer);
    this._usbTimer = null;
    if (this._usbWatchTimer) clearTimeout(this._usbWatchTimer);
    this._usbWatchTimer = null;
    if (this._usbWatch) {
      try { this._usbWatch.close(); } catch { /* already closed */ }
      this._usbWatch = null;
    }
  }

  pollUsb() {
    if (this._usbBusy) return this._usbBusy;
    const job = this._pollUsb().finally(() => { this._usbBusy = null; });
    this._usbBusy = job;
    return job;
  }

  async _pollUsb() {
    if (this.usb && (this.usb.disabled || usbDisabled())) {
      if (!this._usbLoggedDisabled) {
        this._usbLoggedDisabled = true;
        this._logLine('info', 'USB decks are off (CC_DECK_USB=0). Control Center will not open Stream Decks.');
      }
      this.usbDevices = [];
      return;
    }
    let devices = [];
    try {
      devices = await this.usb.scan({
        claim: (info) => !(this.os && this.os.surfaces.deckOwner(info.path) === 'companion'),
      });
    } catch (e) {
      this._logLine('error', `USB Stream Deck scan failed: ${e.message || e}`);
      this.usbDevices = this.usbDevices || [];
      return;
    }
    this._logScan(this.usb.lastReport);
    if (this.os) {
      const kept = [];
      this.releasedUsb = [];
      for (const device of devices) {
        if (this.os.surfaces.deckOwner(device.id) === 'companion') {
          await this.usb.closeId(device.id);
          this.releasedUsb.push({ ...device, owner: 'companion', released: true });
        } else kept.push(device);
      }
      this.usbDevices = kept;
    } else {
      this.usbDevices = devices;
    }
    try { await this.paintUsb(); } catch { /* keep whatever is already on the keys */ }
    if (this.usb && !this.usb.isolated) {
      setTimeout(() => {
        for (const device of this.usbDevices) { try { this.warm(device); } catch { /* the art cache is optional */ } }
      }, 250);
    }
  }

  _logLine(level, msg) {
    if (this.engine && this.engine.log) {
      this.engine.log(level, msg);
      // engine.log writes stdout. Repeat a missing-library failure on stderr so
      // a quiet flag cannot hide the one line that says the HID package is gone.
      if (level === 'error' && /library is missing/.test(msg)) console.error(msg);
      return;
    }
    if (level === 'error') console.error(msg);
    else console.log(msg);
  }

  _logScan(report) {
    if (!report) return;
    if (!report.installed) {
      if (this._usbLoggedMissing) return;
      this._usbLoggedMissing = true;
      this._logLine('error', `USB Stream Deck library is missing. ${report.error || 'require(@elgato-stream-deck/node) failed'} Fix: npm ci --omit=dev in the app folder, then restart the service.`);
      return;
    }
    if (this._usbFound !== report.found) {
      this._usbFound = report.found;
      this._logLine('info', `found ${report.found} decks`);
    }
    for (const d of report.opened || []) this._logLine('info', `opened serial ${d.serial || d.path}`);
    const failing = new Set();
    for (const f of report.failed || []) {
      if (!f.message) continue;
      failing.add(f.message);
      if (this._usbFailSeen.has(f.message)) continue;
      this._usbFailSeen.add(f.message);
      this._logLine('error', f.message);
    }
    for (const line of this._usbFailSeen) {
      if (!failing.has(line)) this._usbFailSeen.delete(line);
    }
    for (const s of report.skipped || []) {
      const line = `left serial ${s.serial || s.path} with Companion (this deck is marked Companion-owned)`;
      if (this._usbSkipSeen.has(line)) continue;
      this._usbSkipSeen.add(line);
      this._logLine('info', line);
    }
  }

  sessionFor(device) {
    if (!device) return { system: null, page: 0 };
    if (device.serial && this.sessions.has(`serial:${device.serial}`)) return this.sessions.get(`serial:${device.serial}`);
    if (device.id && this.sessions.has(device.id)) return this.sessions.get(device.id);
    return { system: null, page: 0 };
  }

  remember(device, session) {
    const copy = {
      system: (session && session.system) || null,
      page: Number(session && session.page) || 0,
      out: (session && session.out) || null,
      atemUi: (session && session.atemUi) || null,
    };
    if (device && device.serial) this.sessions.set(`serial:${device.serial}`, copy);
    if (device && device.id) this.sessions.set(device.id, copy);
    this.save();
    return copy;
  }

  findDevice(id) {
    return this.usbDevices.find((d) => d.id === id) || (id === 'preview' ? this.previewDevice() : null);
  }

  warm(device) {
    if (this.usb && this.usb.isolated) return;
    const size = this.usb.buttonSize(device.id);
    if (!size) return;
    const surface = surfaceById(device.surfaceId) || surfaceFor(device);
    const session = this.sessionFor(device);
    const count = show(surface, this.desk(), session).pages || 1;
    for (let page = 0; page < count; page++) {
      const face = show(surface, this.desk(), { ...session, page });
      for (const key of face.keys || []) keyImage(key, size.width, size.height);
    }
  }

  stamp(device, face) {
    if (!face) return face;
    face.snap = this.ptzSnap();
    if (face.system === 'ptz') face.keys = applyReadouts(face.keys, face.snap);
    if (face.system === 'console' && this.os) face.keys = stampConsole(face.keys, this.os.feedbacks().flat);
    if (face.id === 'home' && this.os) {
      const n = this.os.alerts.unacked();
      if (n) face.keys = face.keys.map((k) => (k && k.nav === 'console' ? { ...k, caption: String(n), tone: 'stop' } : k));
    }
    if (device && device.id && this._down && this._down.size) {
      face.keys = (face.keys || []).map((k) => (k && this._down.has(`${device.id}:${k.col}:${k.row}`) ? { ...k, pressed: true } : k));
    }
    if (this.os && device && device.id) {
      const owner = this.os.surfaces.deckOwner(device.id);
      if (owner === 'companion') {
        face.owner = 'companion';
        face.keys = (face.keys || []).map((k) => ({ ...k, label: 'COMPANION', caption: 'DECK', action: null, nav: null, tone: 'idle' }));
      } else if (owner === 'shared') {
        face.keys = (face.keys || []).map((k) => {
          if (this.os.surfaces.keyOwner(device.id, k.col, k.row) !== 'companion') return k;
          const sat = this.os.satelliteKey(device.id, k.col, k.row);
          if (!sat) return { ...k, label: 'COMPANION', caption: 'KEY', action: null, nav: null, tone: 'idle' };
          return { ...k, label: sat.label, caption: sat.caption || 'COMPANION', tone: sat.tone || 'nav', action: null, nav: null };
        });
      }
    }
    face.dials = (face.dials || []).map((dial, i) => ({ ...dial, stepIndex: this.steps.get(`${device.id}:${i}`) || 0 }));
    return face;
  }

  bareFace(device) {
    const surface = surfaceById(device.surfaceId) || surfaceFor(device);
    return this.stamp(device, show(surface, this.desk(), this.sessionFor(device)));
  }

  faceFor(device) {
    return this.withArt(this.bareFace(device));
  }

  withArt(face) {
    if (!face) return face;
    const keys = (face.keys || []).map((key) => ({ ...key, svg: keySvg(keyModel(key)) }));
    const dials = (face.dials || []).map((dial) => {
      let svg = '';
      try { svg = knobSvg(dialFace(dial.widget, face.snap || {}, dial.stepIndex || 0)); } catch { svg = ''; }
      return { ...dial, svg };
    });
    return { ...face, keys, dials };
  }

  previewDevice() {
    return { id: 'preview', name: 'Layout preview', model: 'Stream Deck + XL', surfaceId: 'plusxl', columns: 9, rows: 4, online: false, transport: 'preview' };
  }

  async runAction(action) {
    if (!action || !action.path) return null;
    const path = String(action.path);
    const body = action.body || {};
    if (this.os && this.os.panel.locked && !/^\/api\/core\/cmd\/(panel\.unlock|health\.ack|health\.status|connection\.status|service\.refresh|host\.cancel)$/.test(path)) {
      throw fail(423, 'Panel is locked');
    }
    const core = path.match(/^\/api\/core\/cmd\/([a-z][\w.]*)$/);
    if (core) {
      if (!this.os) throw fail(503, 'Core is not running');
      return this.os.command(core[1], body);
    }
    if (path === '/api/take' && this.engine && this.engine.take) return this.engine.take();
    if (path === '/api/cut' && this.engine && this.engine.cut) return this.engine.cut();
    let m = path.match(/^\/api\/presets\/(\d+)\/recall$/);
    if (m && this.engine && this.engine.recall) return this.engine.recall(m[1]);
    m = path.match(/^\/api\/sys\/([a-z0-9]+)\/presets\/([^/]+)\/recall$/);
    if (m && this.systems && this.systems.recall) return this.systems.recall(m[1], decodeURIComponent(m[2]), { target: body.target === 'program' ? 'program' : 'preview' });
    m = path.match(/^\/api\/sys\/([a-z0-9]+)\/take$/);
    if (m && this.systems && this.systems.take) return this.systems.take(m[1]);
    m = path.match(/^\/api\/sys\/([a-z0-9]+)\/cut$/);
    if (m && this.systems && this.systems.cut) return this.systems.cut(m[1]);
    const sysCmd = parseSysCmd(path);
    if (sysCmd && this.systems && typeof this.systems[sysCmd.type] === 'function') {
      const instance = sysCmd.instance.includes('-') ? sysCmd.instance : (body.instance || sysCmd.instance);
      return this.systems[sysCmd.type](sysCmd.name, { ...body, instance });
    }
    return null;
  }

  async press(deviceId, col, row) {
    if (this.os && deviceId !== 'preview' && this.os.surfaces.deckOwner(deviceId) === 'companion') {
      throw fail(409, 'This deck is owned by Companion. Control Center released the USB device.');
    }
    if (this.os && this.os.surfaces.keyOwner(deviceId, col, row) === 'companion') {
      return this.os.satellitePress(deviceId, Number(col), Number(row));
    }
    const preview = deviceId === 'preview';
    const device = this.usbDevices.find((d) => d.id === deviceId) || (preview ? this.previewDevice() : null);
    if (!device) throw fail(404, 'That Stream Deck is not open over USB. Quit the Elgato app and scan again.');
    const face = this.bareFace(device);
    const key = (face.keys || []).find((k) => k.col === Number(col) && k.row === Number(row));
    const session = this.sessionFor(device);
    let pending = null;
    if (key && key.nav === 'home') {
      session.system = null;
      session.page = 0;
      session.out = null;
    } else if (key && key.nav === 'console') {
      session.system = 'console';
      session.page = 0;
      session.out = null;
    } else if (key && key.nav === 'system') {
      session.system = key.system;
      session.page = 0;
      session.out = null;
    } else if (key && (key.atemHold || key.map || key.atemToggle || key.atemMes)) {
      if (key.atemMes) {
        const ui = { me: 1, flexBank: 0, shift: 0, mes: [1], ...(session.atemUi || {}) };
        const view = ((this.desk().byKey || {})[session.system || 'atem'] || {}).view || {};
        const count = Math.max(1, (view.mes || []).length || 1);
        ui.mes = toggleMes(fireMes(ui), ui.me, count);
        session.atemUi = ui;
      } else if (key.atemToggle) {
        const ui = { me: 1, flexBank: 0, shift: 0, mes: [1], ...(session.atemUi || {}) };
        if (key.atemCycle) ui[key.atemToggle] = ((Number(ui[key.atemToggle]) || 0) + 1) % key.atemCycle;
        else ui[key.atemToggle] = ui[key.atemToggle] ? 0 : 1;
        session.atemUi = ui;
      } else if (key.atemHold) this.beginAtemHold(device, col, row, key);
      else this.beginMapHold(device, col, row, key);
    } else if (key && key.pick) {
      session.out = key.pick;
      if (key.page != null) session.page = Number(key.page) || 0;
    } else if (key && key.nav === 'page') {
      session.page = Number(key.page) || 0;
      if (key.clearOut) session.out = null;
    } else if (key && key.action) {
      // The command starts before any repaint. Paint is scheduled after this
      // call so a slow JPEG round-trip cannot sit in front of the camera.
      if (key.atemFire) {
        const ui = session.atemUi || {};
        const mes = fireMes(ui);
        pending = Promise.all(mes.map((me) => this.runAction({ ...key.action, body: { ...(key.action.body || {}), me } })));
      } else if (!preview && key.hold) this.beginMotion(device, col, row, key);
      else if (!preview && steppedKey(key)) pending = this.beginStep(device, col, row, key);
      else pending = this.runAction(key.action);
      if (!preview) this.markDown(device.id, col, row);
    }
    this.remember(device, session);
    if (!preview) this.schedulePaint(12);
    if (pending && typeof pending.then === 'function') await pending;
    return { ok: true, face: this.faceFor(device) };
  }

  async release(deviceId, col, row) {
    const slot = `${deviceId}:${Number(col)}:${Number(row)}`;
    const wasMotion = this._motions.has(slot);
    const mapped = this._mapHolds.get(slot);
    this.endMotion(slot);
    this.endStep(slot);
    this._down.delete(slot);
    if (mapped) {
      clearTimeout(mapped.timer);
      this._mapHolds.delete(slot);
      const deviceHeld = this.usbDevices.find((d) => d.id === deviceId);
      if (deviceHeld) {
        const session = this.sessionFor(deviceHeld);
        if (mapped.key && mapped.key.atemHold === 'trans' && session.atemUi) {
          session.atemUi = { ...session.atemUi, transHold: false };
          this.remember(deviceHeld, session);
        } else if (mapped.mapping && session.atemUi && session.atemUi.pending) {
          await this.commitMap(deviceHeld, session);
        } else if (mapped.key && mapped.key.action) {
          await this.runAction(mapped.key.action);
        } else if (mapped.long && mapped.key && mapped.key.holdPage != null) {
          session.page = mapped.key.holdPage;
          this.remember(deviceHeld, session);
        } else if (mapped.key && mapped.key.tapPage != null) {
          session.page = mapped.key.tapPage;
          if (mapped.key.clearOut) session.out = null;
          this.remember(deviceHeld, session);
        }
      }
    }
    const device = this.usbDevices.find((d) => d.id === deviceId);
    if (!device) return { ok: false };
    const face = this.bareFace(device);
    const key = (face.keys || []).find((k) => k.col === Number(col) && k.row === Number(row));
    let pending = null;
    if (wasMotion || (key && key.hold)) {
      const axes = key && key.hold === 'zoom' ? ['zoom'] : key && key.hold === 'focus' ? ['focus'] : ['pt'];
      pending = this.runAction({ method: 'POST', path: '/api/sys/ptz/cmd/stop', body: { axes } });
    }
    this.schedulePaint(12);
    if (pending) await pending;
    return { ok: true };
  }

  async assign(deviceId, system) {
    const device = this.findDevice(deviceId);
    if (!device) throw fail(404, 'That Stream Deck is not open over USB. Quit the Elgato app and scan again.');
    const wanted = system ? String(system) : null;
    const armed = this.desk().armed;
    if (wanted && wanted !== 'console' && !armed.includes(wanted)) throw fail(400, `${wanted} is not on the desk`);
    const session = { ...(this.sessionFor(device)), system: wanted, page: 0 };
    this.remember(device, session);
    if (this.os && wanted && wanted !== 'console') { try { this.os.surfaces.setFocus(device.id, wanted); } catch { /* the deck session is already stored */ } }
    const face = this.stamp(device, this.faceFor(device));
    if (device.transport === 'usb') {
      try { await this.usb.paint(device.id, face.keys, face); } catch (e) { device.paintError = e.message || String(e); }
    }
    return { ok: true, deviceId: device.id, system: wanted, face };
  }

  async turn(deviceId, index, ticks, event) {
    const device = this.usbDevices.find((d) => d.id === deviceId);
    if (!device) return { ok: false };
    const face = this.faceFor(device);
    const dial = (face.dials || [])[index];
    const name = event || (ticks ? 'rotate' : 'toggle');
    const session = this.sessionFor(device);
    if (session.atemUi && session.atemUi.transHold) {
      if (name === 'tap' || name === 'push') return this.atemStripTouch(device, index);
      if (name === 'rotate') return { ok: true };
    }
    if (dial && dial.atem && name === 'rotate') return this.atemDial(device, dial, ticks);
    if (!dial || !dial.widget) return { ok: false };
    const slot = `${deviceId}:${index}`;
    if (name === 'down') {
      const prev = this.dialDown.get(slot);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        const held = this.dialDown.get(slot);
        if (!held) return;
        held.long = true;
        this.finishDial(device, index, 'reset').catch(() => {});
      }, LONG_PRESS_MS);
      this.dialDown.set(slot, { timer, long: false });
      return { ok: true };
    }
    if (name === 'up') {
      const held = this.dialDown.get(slot);
      if (!held) return { ok: true };
      clearTimeout(held.timer);
      this.dialDown.delete(slot);
      if (held.long) return { ok: true };
      return this.finishDial(device, index, 'toggle');
    }
    if (name === 'push') return this.finishDial(device, index, 'toggle');
    let dtMs = null;
    if (name === 'rotate') {
      const now = Date.now();
      const prev = this.turnedAt.get(slot);
      dtMs = prev == null ? null : now - prev;
      this.turnedAt.set(slot, now);
    }
    return this.finishDial(device, index, name, ticks, dtMs);
  }

  async finishDial(device, index, event, ticks, dtMs) {
    const face = this.faceFor(device);
    const dial = (face.dials || [])[index];
    if (!dial || !dial.widget) return { ok: false };
    const slot = `${device.id}:${index}`;
    const stepIndex = this.steps.get(slot) || 0;
    let planned;
    try {
      planned = plan({ gesture: 'dial', widget: dial.widget, event, ticks, dtMs, stepIndex, snapshot: this.ptzSnap() });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (planned.stepIndex != null) this.steps.set(slot, planned.stepIndex);
    const send = Promise.all((planned.requests || []).map((req) => this.runAction(req)));
    if (event === 'rotate') send.catch(() => {});
    else await send;
    this.schedulePaint(event === 'rotate' ? 32 : 12);
    return { ok: true, stepIndex: planned.stepIndex };
  }

  ptzSnap() {
    try { return this.systems && this.systems.deckSnapshot ? this.systems.deckSnapshot() : {}; } catch { return {}; }
  }

  schedulePaint(delay = 32) {
    const wait = Math.max(0, Number(delay) || 0);
    const due = Date.now() + wait;
    if (this._paintTimer && this._paintDue && this._paintDue <= due) return;
    clearTimeout(this._paintTimer);
    this._paintDue = due;
    this._paintTimer = setTimeout(() => {
      this._paintTimer = null;
      this._paintDue = 0;
      this.flushPaint();
    }, wait);
  }

  flushPaint() {
    if (this._paintBusy) { this._paintAgain = true; return; }
    this._paintBusy = this.paintUsb().finally(() => {
      this._paintBusy = null;
      if (this._paintAgain) {
        this._paintAgain = false;
        this.schedulePaint(24);
      }
    });
  }

  markDown(deviceId, col, row) {
    const slot = `${deviceId}:${Number(col)}:${Number(row)}`;
    const stamp = Date.now();
    this._down.set(slot, stamp);
    setTimeout(() => {
      if (this._down.get(slot) !== stamp) return;
      this._down.delete(slot);
      this.schedulePaint(16);
    }, 180);
  }

  beginMotion(device, col, row, key) {
    const slot = `${device.id}:${Number(col)}:${Number(row)}`;
    this.endMotion(slot);
    const started = Date.now();
    const body0 = (key.action && key.action.body) || {};
    const send = () => {
      const speeds = (this.ptzSnap() && this.ptzSnap().speeds) || {};
      const held = Date.now() - started;
      const body = { ...body0, speed: true };
      if (body0.pan != null || body0.tilt != null) {
        const pt = speeds.pt || 25;
        body.pan = velocityFor(body0.pan || 0, pt, held);
        body.tilt = velocityFor(body0.tilt || 0, pt, held);
      } else if (body0.dir != null) {
        const axis = key.hold === 'focus' ? (speeds.focus || 15) : (speeds.zoom || 25);
        body.dir = velocityFor(body0.dir, axis, held);
      }
      this.runAction({ ...key.action, body }).catch(() => {});
    };
    send();
    const timer = setInterval(send, HOLD.tickMs);
    this._motions.set(slot, timer);
  }

  endMotion(slot) {
    const timer = this._motions.get(slot);
    if (!timer) return false;
    clearInterval(timer);
    this._motions.delete(slot);
    return true;
  }

  beginStep(device, col, row, key) {
    const slot = `${device.id}:${Number(col)}:${Number(row)}`;
    this.endStep(slot);
    const mag = Math.abs(Number(key.action.body.steps) || 1);
    const sent = (this._shift ? -1 : 1) * mag;
    const forward = this.runAction({ ...key.action, body: { ...key.action.body, steps: sent } });
    const timer = setTimeout(() => {
      const held = this._stepsHeld.get(slot);
      if (!held) return;
      held.reversed = true;
      this._stepsHeld.delete(slot);
      // Undo the tap and take one more step the other way.
      this.runAction({ ...key.action, body: { ...key.action.body, steps: -2 * sent } }).catch(() => {});
    }, LONG_PRESS_MS);
    this._stepsHeld.set(slot, { timer, reversed: false });
    return forward;
  }

  endStep(slot) {
    const held = this._stepsHeld.get(slot);
    if (!held) return;
    clearTimeout(held.timer);
    this._stepsHeld.delete(slot);
  }

  beginMapHold(device, col, row, key) {
    const slot = `${device.id}:${Number(col)}:${Number(row)}`;
    const prev = this._mapHolds.get(slot);
    if (prev) clearTimeout(prev.timer);
    const held = { timer: null, mapping: false, key };
    held.timer = setTimeout(() => {
      if (!this._mapHolds.get(slot)) return;
      held.mapping = true;
      const session = this.sessionFor(device);
      const ui = { me: 1, flexBank: 0, shift: 0, ...(session.atemUi || {}) };
      ui.pending = { bus: key.map.bus, slot: key.map.slot, bank: key.map.bank || 0, index: 0, name: key.label };
      session.atemUi = ui;
      this.remember(device, session);
      this.schedulePaint(12);
    }, LONG_PRESS_MS);
    this._mapHolds.set(slot, held);
  }

  beginAtemHold(device, col, row, key) {
    const slot = `${device.id}:${Number(col)}:${Number(row)}`;
    const held = { timer: null, mapping: false, long: false, key };
    held.timer = setTimeout(() => {
      held.long = true;
      if (key.atemHold === 'trans') {
        const session = this.sessionFor(device);
        const ui = { me: 1, flexBank: 0, shift: 0, mes: [1], ...(session.atemUi || {}) };
        const view = ((this.desk().byKey || {})[session.system || 'atem'] || {}).view || {};
        const mes = view.mes || [];
        const me = mes[Math.max(0, (Number(ui.me) || 1) - 1)] || {};
        ui.next = hardwareNext(me, view);
        ui.transHold = true;
        session.atemUi = ui;
        this.remember(device, session);
        this.schedulePaint(12);
      }
    }, LONG_PRESS_MS);
    this._mapHolds.set(slot, held);
  }

  async commitMap(device, session) {
    const pending = session.atemUi && session.atemUi.pending;
    if (!pending) return;
    const id = session.system || 'atem';
    if (this.systems && this.systems.setAtemButton) {
      try {
        await this.systems.setAtemButton(id, {
          bus: pending.bus, slot: pending.slot, bank: pending.bank, me: session.atemUi.me || 1,
          kind: pending.kind, ref: pending.ref, source: pending.source,
        });
      } catch { /* the strip keeps the previous map */ }
    }
    session.atemUi = { ...session.atemUi, pending: null };
    this.remember(device, session);
  }

  atemStripTouch(device, index) {
    const session = this.sessionFor(device);
    const face = this.bareFace(device);
    const dial = (face.dials || [])[index];
    const touch = dial && dial.strip && dial.strip.touch;
    if (!touch) return { ok: true };
    const ui = { me: 1, flexBank: 0, shift: 0, mes: [1], ...(session.atemUi || {}) };
    const prev = ui.next || { bkgd: true, keys: [], dsk: [] };
    ui.next = { bkgd: prev.bkgd !== false, keys: [...(prev.keys || [])], dsk: [...(prev.dsk || [])] };
    if (touch.type === 'bkgd') ui.next.bkgd = !ui.next.bkgd;
    else if (touch.type === 'usk') ui.next.keys[touch.index] = !ui.next.keys[touch.index];
    else if (touch.type === 'dsk') ui.next.dsk[touch.index] = !ui.next.dsk[touch.index];
    session.atemUi = ui;
    this.remember(device, session);
    const id = session.system || 'atem';
    if (touch.type === 'bkgd' || touch.type === 'usk') {
      let bits = ui.next.bkgd ? 1 : 0;
      (ui.next.keys || []).forEach((on, i) => { if (on) bits |= 1 << (i + 1); });
      if (!bits) bits = 1;
      fireMes(ui).forEach((me) => {
        this.runAction({ method: 'POST', path: `/api/sys/${id}/cmd/nextSelection`, body: { selection: bits, me } }).catch(() => {});
      });
    } else if (touch.type === 'dsk') {
      this.runAction({ method: 'POST', path: `/api/sys/${id}/cmd/dskTie`, body: { key: touch.index, on: !!ui.next.dsk[touch.index] } }).catch(() => {});
    }
    this.schedulePaint(12);
    return { ok: true };
  }

  atemDial(device, dial, ticks) {
    const session = this.sessionFor(device);
    const ui = { me: 1, flexBank: 0, shift: 0, ...(session.atemUi || {}) };
    if (ui.transHold) return { ok: true };
    const id = session.system || 'atem';
    const info = (this.desk().byKey || {})[id] || {};
    const view = info.view || {};
    const mes = view.mes || [];
    const me = mes[Math.max(0, ui.me - 1)] || {};
    const n = Math.trunc(Number(ticks) || 0);
    const send = (name, body) => this.runAction({ method: 'POST', path: `/api/sys/${id}/cmd/${name}`, body: { me: ui.me, ...body } });
    if (dial.atem === 'map') {
      if (!ui.pending) return { ok: true };
      const choices = choicesFor({ bus: ui.pending.bus, slot: ui.pending.slot }, view, info.buttonMap, ui.me - 1);
      if (!choices.length) return { ok: true };
      const index = cycle(choices, ui.pending.index || 0, n || 1);
      const pick = choices[index];
      ui.pending = { ...ui.pending, index, name: pick.name || pick.long || String(pick.id), kind: pick.kind, ref: pick.kind ? pick.id : undefined, source: pick.kind ? undefined : pick.id };
      session.atemUi = ui;
      this.remember(device, session);
      this.schedulePaint(12);
      return { ok: true };
    }
    if (dial.atem === 'me') {
      const count = Math.max(1, mes.length || 1);
      const all = fireMes(ui).length > 1;
      ui.me = ((ui.me - 1 + (n || 1)) % count + count) % count + 1;
      ui.mes = all ? Array.from({ length: count }, (_, i) => i + 1) : [ui.me];
      session.atemUi = ui;
      this.remember(device, session);
      this.schedulePaint(12);
      return { ok: true };
    }
    if (dial.atem === 'effect') {
      const cur = EFFECTS.indexOf(String(me.style || '').toUpperCase());
      const next = EFFECTS[cycle(EFFECTS, cur < 0 ? 0 : cur, n || 1)];
      send('style', { style: next }).catch(() => {});
      return { ok: true };
    }
    if (dial.atem === 'wipe') {
      const next = cycle(WIPES, Number(me.wipe) || 0, n || 1);
      send('wipePattern', { pattern: next }).catch(() => {});
      return { ok: true };
    }
    if (dial.atem === 'time') {
      const rate = Math.max(1, Math.min(250, (Number(me.mixRate) || 30) + (n || 1)));
      send('mixRate', { rate }).catch(() => {});
      return { ok: true };
    }
    if (dial.atem === 'tbar') {
      const handle = Math.max(0, Math.min(9999, (Number(me.handle) || 0) + (n || 1) * 500));
      send('transitionPosition', { handle }).catch(() => {});
      return { ok: true };
    }
    return { ok: false };
  }

  async paintUsb() {
    for (const device of this.usbDevices) {
      if (this.os && this.os.surfaces.deckOwner(device.id) === 'companion') continue;
      const face = this.bareFace(device);
      try {
        await this.usb.paint(device.id, slimKeys(face.keys), slimFace(face));
      } catch { /* the next scan retries */ }
    }
  }

  normalize(device = {}) {
    const surface = surfaceFor(device);
    return {
      id: String(device.id || ''),
      name: String(device.name || device.model || 'Stream Deck'),
      model: String(device.model || surface.label),
      type: device.type == null ? null : device.type,
      columns: Number(device.columns) || surface.cols,
      rows: Number(device.rows) || surface.rows,
      online: device.online !== false && device.isConnected !== false,
      surfaceId: surface.id,
    };
  }

  library(desk = this.desk()) {
    const out = {};
    for (const id of ORDER) out[id] = linkPages(libraryFor(desk, SURFACES[id]).map((p) => stampPage(p, desk)), SURFACES[id]);
    return out;
  }

  userPages() {
    return this.buttons && this.buttons.pages ? this.buttons.pages : [];
  }

  warningsFor(deviceId, desk = this.desk()) {
    const device = this.devices.find((d) => d.id === deviceId);
    const surface = surfaceById(device && device.surfaceId) || SURFACES.xl;
    try {
      return this.pagesFor({ id: deviceId, surfaceId: surface.id }, desk).warnings;
    } catch (e) {
      return [{ pageId: null, jump: null, message: e.message }];
    }
  }

  setStack(body = {}) {
    const id = String(body.deviceId || '');
    if (!id) throw fail(400, 'deviceId required');
    const known = new Set(catalogIds(this.desk()));
    for (const page of this.userPages()) known.add(page.id);
    const prev = new Set(this.stacks[id] || []);
    let pages;
    if (Array.isArray(body.pages)) {
      pages = body.pages.map((p) => String(p || '')).filter(Boolean);
      if (new Set(pages).size !== pages.length) throw fail(400, 'Duplicate page on this deck');
      for (const p of pages) {
        if (!known.has(p) && !prev.has(p)) throw fail(400, `Unknown page "${p}"`);
      }
    } else if (Number.isInteger(body.from) && Number.isInteger(body.to)) {
      pages = moveItem(this.stacks[id] || [], body.from, body.to);
    } else throw fail(400, 'pages required');
    this.stacks[id] = pages;
    this.save();
    return { deviceId: id, pages, warnings: this.warningsFor(id) };
  }

  pagesFor(device, desk, lead) {
    const surface = surfaceById(device.surfaceId) || surfaceFor(device);
    const lib = libraryFor(desk, surface);
    const templates = new Map(lib.map((p) => [p.id, p]));
    const users = new Map(this.userPages().map((p) => [p.id, p]));
    const buttons = this.buttons ? this.buttons.byId() : new Map();
    const ids = [];
    if (lead) ids.push(String(lead));
    for (const pid of this.stacks[device.id] || []) if (!ids.includes(pid)) ids.push(pid);
    const missing = ids.filter((pid) => !templates.has(pid) && !users.has(pid));
    if (missing.length) throw fail(400, `Unknown page "${missing[0]}"`);
    for (const pid of ids) {
      const raw = users.get(pid);
      if (!raw) continue;
      if (!hasSlots(raw)) throw fail(400, `${raw.name} has no buttons`);
      if (raw.surface !== surface.id) throw fail(400, `${raw.name} is a ${raw.surface} page, not a ${surface.id}`);
    }
    const rest = lib.map((p) => p.id).filter((pid) => !ids.includes(pid));
    const order = [...ids, ...rest];
    const compiled = new Map();
    for (const pid of ids) {
      if (users.has(pid)) compiled.set(pid, compileUserPage(users.get(pid), buttons, surface, desk));
    }
    const linked = linkPages(order.filter((pid) => templates.has(pid)).map((pid) => stampPage(templates.get(pid), desk)), surface);
    const linkedById = new Map(linked.map((p) => [p.id, p]));
    const pages = order.map((pid) => compiled.get(pid) || linkedById.get(pid)).filter(Boolean);
    if (surface.id === 'plusxl') {
      const atemIndex = pages.findIndex((page) => page.id === 'atem-switcher' && !page.user);
      if (atemIndex >= 0) pages[atemIndex] = atemSwitcherDeploy(desk, this.sessionFor(device), 'atem');
    }
    return {
      pages,
      warnings: stackWarnings(ids, [...lib, ...compiled.values()]),
    };
  }

  async deploy(body = {}) {
    const id = String(body.deviceId || '');
    if (!id) throw fail(400, 'deviceId required');
    await this.refresh();
    if (!this.online) throw fail(502, this.lastError || 'Path C plugin is not running');
    const device = this.devices.find((d) => d.id === id);
    if (!device) throw fail(404, `Stream Deck "${id}" is not connected`);
    if (!device.online) throw fail(409, `${device.name} is offline`);
    const pageId = body.pageId ? String(body.pageId) : '';
    const ids = this.stacks[id] || [];
    if (!pageId && !ids.length) throw fail(400, 'This deck has no pages to push');
    const built = this.pagesFor(device, this.desk(), pageId || null);
    const result = await client.deploy(this.pluginUrl, { deviceId: id, pages: built.pages }, { timeout: 8000 });
    if (pageId) this.stacks[id] = [pageId, ...ids.filter((pid) => pid !== pageId)];
    this.loaded[id] = (result.loaded || built.pages.map((p) => p.title)).slice();
    this.save();
    return { ok: true, deviceId: id, warnings: built.warnings, loaded: this.loaded[id], pages: built.pages, plugin: result };
  }

  async deployAll() {
    await this.refresh();
    if (!this.online) throw fail(502, this.lastError || 'Path C plugin is not running');
    const deployed = [];
    const skipped = [];
    for (const device of this.devices) {
      const ids = this.stacks[device.id] || [];
      if (!device.online) { skipped.push({ deviceId: device.id, reason: 'offline' }); continue; }
      if (!ids.length) { skipped.push({ deviceId: device.id, reason: 'empty' }); continue; }
      try {
        const r = await this.deploy({ deviceId: device.id });
        deployed.push({ deviceId: device.id, loaded: r.loaded, warnings: r.warnings });
      } catch (e) {
        skipped.push({ deviceId: device.id, reason: e.message });
      }
    }
    return { deployed, skipped };
  }

  async view({ refresh = true } = {}) {
    if (refresh) await this.refresh();
    const desk = this.desk();
    const library = this.library(desk);
    const devices = this.devices.map((d) => {
      const ids = this.stacks[d.id] || [];
      const lib = library[d.surfaceId] || [];
      const byId = new Map(lib.map((p) => [p.id, p]));
      const userById = new Map(this.userPages().map((p) => [p.id, p]));
      const pages = ids.map((pid) => {
        const p = byId.get(pid);
        if (p) return { id: p.id, title: p.title, system: p.system, profile: p.profile };
        const user = userById.get(pid);
        if (user) return { id: user.id, title: user.name, system: 'page', profile: null };
        return { id: pid, title: pid, system: null, profile: null, missing: true };
      });
      return { ...d, pages, warnings: this.warningsFor(d.id, desk), loaded: this.loaded[d.id] || [] };
    });
    return {
      plugin: { url: this.pluginUrl, online: this.online, error: this.online ? null : this.lastError },
      devices,
      known: knownOffline({
        stacks: this.stacks,
        loaded: this.loaded,
        sessions: Object.fromEntries(this.sessions),
        liveIds: [...this.devices.map((d) => d.id), ...this.usbDevices.map((d) => d.id)],
      }),
      library,
      surfaces: SURFACES,
      desk: { armed: desk.armed },
      control: {
        transport: 'usb',
        driver: this.usb.status(),
        devices: (this.usbDevices.length ? this.usbDevices : [this.previewDevice()]).map((d) => ({ ...d, key: d.serial ? `serial:${d.serial}` : `usb:${d.id}`, face: this.faceFor(d) })),
      },
    };
  }
}

module.exports = { DeckService };
