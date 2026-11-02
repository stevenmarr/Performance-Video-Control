'use strict';
// Desk → Stream Deck stacks. Devices come from the Path C plugin HTTP API.
// This process does not invent a connected deck. Stacks are the only thing persisted.

const fs = require('fs');
const path = require('path');
const { SURFACES, ORDER, surfaceById, surfaceFor } = require('./surfaces');
const { libraryFor, catalogIds, stampPage, stackWarnings, moveItem, linkPages } = require('./pages');
const client = require('./plugin-client');
const { show, applyReadouts } = require('./faces');
const { plan, dialFace, LONG_PRESS_MS } = require('../deck');
const { keySvg, knobSvg } = require('../deck-image');
const { keyModel, keyImage } = require('./look');
const { createDeckUsb, usbDisabled } = require('./usb-host');
const { stampConsole } = require('../core/console-deck');

const fail = (status, message) => Object.assign(new Error(message), { status });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

class DeckService {
  constructor({ dataDir, systems, engine, pluginUrl, usbEnv } = {}) {
    if (!dataDir) throw new Error('DeckService needs a data directory');
    this.dataDir = dataDir;
    this.systems = systems;
    this.engine = engine;
    this.file = path.join(dataDir, 'decks.json');
    const raw = readJson(this.file);
    this.pluginUrl = pluginUrl || raw.pluginUrl || client.DEFAULT_URL;
    this.stacks = raw.stacks && typeof raw.stacks === 'object' ? raw.stacks : {};
    this.loaded = raw.loaded && typeof raw.loaded === 'object' ? raw.loaded : {};
    this.sessions = new Map();
    if (raw.sessions && typeof raw.sessions === 'object') {
      for (const [id, saved] of Object.entries(raw.sessions)) {
        if (!saved || typeof saved !== 'object') continue;
        this.sessions.set(id, { system: saved.system || null, page: Number(saved.page) || 0, out: saved.out || null });
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
    this.usb.onPress((id, at) => { this.press(id, at.col, at.row).catch(() => {}); });
    this.usb.onRelease((id, at) => { this.release(id, at.col, at.row).catch(() => {}); });
    this.usb.onTurn((id, at) => { this.turn(id, at.index, at.ticks, at.event).catch(() => {}); });
    if (systems && systems.on) {
      let timer = null;
      systems.on('state', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { this.paintUsb().catch(() => {}); }, 80);
      });
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
      byKey[key] = { key, type, label: (inst && inst.name) || sys.label, short: (inst && inst.name) || sys.short, host, port, cameras, selected, view };
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
    const copy = { system: (session && session.system) || null, page: Number(session && session.page) || 0, out: (session && session.out) || null };
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

  faceFor(device) {
    const surface = surfaceById(device.surfaceId) || surfaceFor(device);
    return this.withArt(this.stamp(device, show(surface, this.desk(), this.sessionFor(device))));
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
    m = path.match(/^\/api\/sys\/ptz\/cmd\/(\w+)$/);
    if (m && this.systems && this.systems.ptz) return this.systems.ptz(m[1], body);
    m = path.match(/^\/api\/sys\/atem\/cmd\/(\w+)$/);
    if (m && this.systems && this.systems.atem) return this.systems.atem(m[1], body);
    m = path.match(/^\/api\/sys\/pixera\/cmd\/(\w+)$/);
    if (m && this.systems && this.systems.pixera) return this.systems.pixera(m[1], body);
    m = path.match(/^\/api\/sys\/millumin\/cmd\/(\w+)$/);
    if (m && this.systems && this.systems.millumin) return this.systems.millumin(m[1], body);
    m = path.match(/^\/api\/sys\/((?:videohub|hyperdeck|mitti)(?:-[a-z0-9]{4,12})?)\/cmd\/(\w+)$/);
    if (m && this.systems) {
      const type = m[1].split('-')[0];
      if (typeof this.systems[type] === 'function') return this.systems[type](m[2], { ...(body || {}), instance: m[1] });
    }
    if (sys) return null;
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
    const face = this.faceFor(device);
    const key = (face.keys || []).find((k) => k.col === Number(col) && k.row === Number(row));
    const session = this.sessionFor(device);
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
    } else if (key && key.nav === 'page') {
      session.page = Number(key.page) || 0;
      if (key.clearOut) session.out = null;
    } else if (key && key.pick) {
      session.out = key.pick;
      if (key.page != null) session.page = Number(key.page) || 0;
    } else if (key && key.action) {
      if (!preview) {
        const flash = (face.keys || []).map((k) => (k.col === key.col && k.row === key.row ? { ...k, pressed: true } : k));
        await this.usb.paint(deviceId, flash, face);
      }
      await this.runAction(key.action);
    }
    this.remember(device, session);
    const next = this.stamp(device, this.faceFor(device));
    if (!preview && !(key && key.hold)) {
      this.warm(device);
      await this.usb.paint(deviceId, next.keys, next);
    }
    return { ok: true, face: next };
  }

  async release(deviceId, col, row) {
    const device = this.usbDevices.find((d) => d.id === deviceId);
    if (!device) return { ok: false };
    const face = this.faceFor(device);
    const key = (face.keys || []).find((k) => k.col === Number(col) && k.row === Number(row));
    if (key && key.hold) {
      const axes = key.hold === 'zoom' ? ['zoom'] : key.hold === 'focus' ? ['focus'] : ['pt'];
      await this.runAction({ method: 'POST', path: '/api/sys/ptz/cmd/stop', body: { axes } });
    }
    const next = this.stamp(device, this.faceFor(device));
    await this.usb.paint(deviceId, next.keys, next);
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
    if (!dial || !dial.widget) return { ok: false };
    const slot = `${deviceId}:${index}`;
    const name = event || (ticks ? 'rotate' : 'toggle');
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
    if (event === 'rotate') {
      send.catch(() => {});
    } else {
      await send;
      const next = this.stamp(device, this.faceFor(device));
      await this.usb.paint(device.id, next.keys, next);
    }
    return { ok: true, stepIndex: planned.stepIndex };
  }

  ptzSnap() {
    try { return this.systems && this.systems.deckSnapshot ? this.systems.deckSnapshot() : {}; } catch { return {}; }
  }

  async paintUsb() {
    for (const device of this.usbDevices) {
      if (this.os && this.os.surfaces.deckOwner(device.id) === 'companion') continue;
      const face = this.stamp(device, this.faceFor(device));
      try {
        this.warm(device);
        await this.usb.paint(device.id, face.keys, face);
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

  warningsFor(deviceId, desk = this.desk()) {
    const device = this.devices.find((d) => d.id === deviceId);
    const surface = surfaceById(device && device.surfaceId) || SURFACES.xl;
    const pages = libraryFor(desk, surface);
    return stackWarnings(this.stacks[deviceId] || [], pages);
  }

  setStack(body = {}) {
    const id = String(body.deviceId || '');
    if (!id) throw fail(400, 'deviceId required');
    const known = new Set(catalogIds(this.desk()));
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

  pagesFor(device, desk) {
    const surface = surfaceById(device.surfaceId) || surfaceFor(device);
    const lib = libraryFor(desk, surface);
    const byId = new Map(lib.map((p) => [p.id, p]));
    const ids = this.stacks[device.id] || [];
    const missing = ids.filter((pid) => !byId.has(pid));
    if (missing.length) throw fail(400, `Unknown page "${missing[0]}"`);
    const rest = lib.map((p) => p.id).filter((pid) => !ids.includes(pid));
    const ordered = [...ids, ...rest].map((pid) => stampPage(byId.get(pid), desk));
    return {
      pages: linkPages(ordered, surface),
      warnings: stackWarnings(ids, lib),
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
    const ids = this.stacks[id] || [];
    if (!ids.length) throw fail(400, 'This deck has no pages to push');
    const built = this.pagesFor(device, this.desk());
    const result = await client.deploy(this.pluginUrl, { deviceId: id, pages: built.pages }, { timeout: 8000 });
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
      const pages = ids.map((pid) => {
        const p = byId.get(pid);
        return p
          ? { id: p.id, title: p.title, system: p.system, profile: p.profile }
          : { id: pid, title: pid, system: null, profile: null, missing: true };
      });
      return { ...d, pages, warnings: this.warningsFor(d.id, desk), loaded: this.loaded[d.id] || [] };
    });
    return {
      plugin: { url: this.pluginUrl, online: this.online, error: this.online ? null : this.lastError },
      devices,
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
