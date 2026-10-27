'use strict';
// Desk → Stream Deck stacks. Devices come from the Path C plugin HTTP API.
// This process does not invent a connected deck. Stacks are the only thing persisted.

const fs = require('fs');
const path = require('path');
const { SURFACES, ORDER, surfaceById, surfaceFor } = require('./surfaces');
const { libraryFor, catalogIds, stampPage, stackWarnings, moveItem, linkPages } = require('./pages');
const client = require('./plugin-client');
const { show, applyReadouts } = require('./faces');
const { plan, dialFace } = require('../deck');
const { keySvg, knobSvg } = require('../deck-image');
const { keyModel, keyImage } = require('./look');
const { UsbDecks } = require('./usb');

const fail = (status, message) => Object.assign(new Error(message), { status });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

class DeckService {
  constructor({ dataDir, systems, engine, pluginUrl } = {}) {
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
        this.sessions.set(id, { system: saved.system || null, page: Number(saved.page) || 0 });
      }
    }
    this.usb = new UsbDecks();
    this.usbDevices = [];
    this.devices = [];
    this.online = false;
    this.lastError = null;
    this.steps = new Map();
    this.usb.onPress((id, at) => { this.press(id, at.col, at.row).catch(() => {}); });
    this.usb.onRelease((id, at) => { this.release(id, at.col, at.row).catch(() => {}); });
    this.usb.onTurn((id, at) => { this.turn(id, at.index, at.ticks, at.event).catch(() => {}); });
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
      const sys = (st.systems && st.systems[key]) || {};
      const conn = sys.connection || {};
      let cameras = [];
      let selected = null;
      if (key === 'ptz' && this.systems && this.systems.ptzView) {
        const view = this.systems.ptzView();
        cameras = (view.cameras || []).map((c) => ({ id: c.id, name: c.name, host: c.host || '', port: c.port == null ? 80 : c.port }));
        selected = view.selected || null;
      }
      const host = key === 'rs6'
        ? ((this.engine && this.engine.settings && this.engine.settings.host) || conn.host || '')
        : (conn.host || '');
      const port = key === 'rs6'
        ? ((this.engine && this.engine.settings && this.engine.settings.restPort) || conn.restPort || null)
        : (conn.port == null ? null : conn.port);
      byKey[key] = { key, label: sys.label, short: sys.short, host, port, cameras, selected };
    }
    return { armed, byKey };
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
    try {
      this.usbDevices = await this.usb.scan();
      await this.paintUsb();
    } catch (e) {
      this.usbDevices = this.usbDevices || [];
    }
    return { online: this.online, error: this.lastError, devices: this.devices.map((d) => ({ ...d })) };
  }

  session(id) {
    return this.sessions.get(id) || { system: null, page: 0 };
  }

  remember(id) {
    const session = this.session(id);
    this.sessions.set(id, { system: session.system || null, page: Number(session.page) || 0 });
    this.save();
  }

  warm(device) {
    const size = this.usb.buttonSize(device.id);
    if (!size) return;
    const surface = surfaceById(device.surfaceId) || surfaceFor(device);
    const session = this.session(device.id);
    const count = show(surface, this.desk(), session).pages || 1;
    for (let page = 0; page < count; page++) {
      const face = show(surface, this.desk(), { ...session, page });
      for (const key of face.keys || []) keyImage(key, size.width, size.height);
    }
  }

  stamp(device, face) {
    face.snap = this.ptzSnap();
    if (face.system === 'ptz') face.keys = applyReadouts(face.keys, face.snap);
    face.dials = (face.dials || []).map((dial, i) => ({ ...dial, stepIndex: this.steps.get(`${device.id}:${i}`) || 0 }));
    return face;
  }

  faceFor(device) {
    const surface = surfaceById(device.surfaceId) || surfaceFor(device);
    return this.withArt(this.stamp(device, show(surface, this.desk(), this.session(device.id))));
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
    if (sys) return null;
    return null;
  }

  async press(deviceId, col, row) {
    const preview = deviceId === 'preview';
    const device = this.usbDevices.find((d) => d.id === deviceId) || (preview ? this.previewDevice() : null);
    if (!device) throw fail(404, 'That Stream Deck is not open over USB. Quit the Elgato app and scan again.');
    const face = this.faceFor(device);
    const key = (face.keys || []).find((k) => k.col === Number(col) && k.row === Number(row));
    const session = this.session(deviceId);
    if (key && key.nav === 'home') {
      session.system = null;
      session.page = 0;
    } else if (key && key.nav === 'system') {
      session.system = key.system;
      session.page = 0;
    } else if (key && key.nav === 'page') {
      session.page = key.page;
    } else if (key && key.action) {
      if (!preview) {
        const flash = (face.keys || []).map((k) => (k.col === key.col && k.row === key.row ? { ...k, pressed: true } : k));
        await this.usb.paint(deviceId, flash, face);
      }
      await this.runAction(key.action);
    }
    this.sessions.set(deviceId, session);
    this.remember(deviceId);
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

  async turn(deviceId, index, ticks, event) {
    const device = this.usbDevices.find((d) => d.id === deviceId);
    if (!device) return { ok: false };
    const face = this.faceFor(device);
    const dial = (face.dials || [])[index];
    if (!dial || !dial.widget) return { ok: false };
    const name = event || (ticks ? 'rotate' : 'push');
    const slot = `${deviceId}:${index}`;
    const stepIndex = this.steps.get(slot) || 0;
    let planned;
    try {
      planned = plan({ gesture: 'dial', widget: dial.widget, event: name, ticks, stepIndex, snapshot: this.ptzSnap() });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (planned.stepIndex != null) this.steps.set(slot, planned.stepIndex);
    for (const req of planned.requests || []) await this.runAction(req);
    const next = this.stamp(device, this.faceFor(device));
    await this.usb.paint(deviceId, next.keys, next);
    return { ok: true };
  }

  ptzSnap() {
    try { return this.systems && this.systems.deckSnapshot ? this.systems.deckSnapshot() : {}; } catch { return {}; }
  }

  async paintUsb() {
    for (const device of this.usbDevices) {
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
        devices: (this.usbDevices.length ? this.usbDevices : [this.previewDevice()]).map((d) => ({ ...d, face: this.faceFor(d) })),
      },
    };
  }
}

module.exports = { DeckService };
