'use strict';
// COMPANION tab (0.31.0). Control Center defines buttons and pages (BUTTONS /
// PAGES). Bitfocus Companion, and Steven's fork with its page designs and page
// templates, puts them on Stream Decks. Two ways across:
//   1. The Control Center Companion module (pvllc-control-center 0.11.0+, or
//      the same module under its old id rs6-presets 0.10.0) reads
//      GET /api/companion/buttons, publishes every CC button and page as
//      Companion presets, and runs a CC button with
//      POST /api/companion/buttons/:id/run. It reports itself with
//      POST /api/companion/hello and refreshes when `rev` changes (SYNC bumps it).
//   2. GET /api/companion/pages/:id/companionconfig downloads one CC page as a
//      Companion page export (.companionconfig, export version 6, upgraded by
//      Companion on import). Its buttons call the module's cc_button_run action.
// Nothing here stores Companion credentials. Companion's own HTTP API has none;
// only host and port are saved, in companion.json next to the other data files.

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../store');
const { surfaceById } = require('../decks/surfaces');
const { resolveKey } = require('../decks/key-class');
const { actionToRequest } = require('../decks/page-push');
const mirror = require('./deck-mirror');
const { UserPages } = require('./user-pages');

// 0.31.1: the module is now "Performance Video Control Center", id pvllc-control-center.
// Its 0.10.0 release used the id rs6-presets; that id is still accepted as legacy.
const MODULE_ID = 'pvllc-control-center';
const LEGACY_MODULE_IDS = ['rs6-presets'];
const MODULE_IDS = [MODULE_ID, ...LEGACY_MODULE_IDS];
// GitHub redirects this URL if the repo is renamed to companion-module-pvllc-control-center.
const MODULE_REPO = 'https://github.com/stevenmarr/companion-module-rs6-presets';
const MODULE_MIN_VERSION = '0.10.0';
// 0.33.0: the module version that publishes the deck pages (CC deck: ... presets), and the one that reports them
const DECK_MIN_VERSION = '0.12.0';
const DECK_REPORT_VERSION = '0.13.0';
const DEFAULT_PORT = 8000;
const EVENTS = ['press', 'release', 'hold', 'turn', 'push', 'touch'];
const fail = (status, message) => Object.assign(new Error(message), { status });

// Companion page layout ids on Steven's fork (shared-lib/lib/PageSurfaceLayout.ts).
const COMPANION_LAYOUT = { mk2: 'streamdeck', xl: 'streamdeck-xl', plus: 'streamdeck-plus', plusxl: 'streamdeck-plus-xl' };

function cleanHost(v) {
  const host = String(v == null ? '' : v).trim();
  if (!host) return '127.0.0.1';
  if (!/^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]+\]$/.test(host)) throw fail(400, 'Host must be a name or an IP address');
  return host;
}

function cleanPort(v) {
  if (v == null || v === '') return DEFAULT_PORT;
  const port = Number(v);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, 'Port must be 1 to 65535');
  return port;
}

function semverAtLeast(v, min) {
  const a = String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

function hexToInt(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  return m ? parseInt(m[1], 16) : fallback;
}

// One plain HTTP GET with a short timeout. Resolves { status, headers, body }.
function httpGet(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('Response too large')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`No answer from ${url} in ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

class CompanionBridge {
  constructor({ dataDir, buttons, decks, appVersion, apiVersion, fetch } = {}) {
    this.file = dataDir ? path.join(dataDir, 'companion.json') : null;
    const raw = this.file ? readJson(this.file, {}) : {};
    this.config = { host: '127.0.0.1', port: DEFAULT_PORT };
    try { this.config = { host: cleanHost(raw.host), port: cleanPort(raw.port) }; } catch { /* keep defaults */ }
    this.syncSeq = Number(raw.syncSeq) || 0;
    this.syncedAt = raw.syncedAt || null;
    this.buttons = buttons || null;
    this.decks = decks || null;
    this.appVersion = appVersion || '';
    this.apiVersion = apiVersion || null;
    this.get = fetch || httpGet;
    this.status = { checked: false, online: false, httpApi: false, connections: [], error: null, checkedAt: null };
    this.module = null;
    this.supervisor = null;
    // 0.31.1: "Let Companion drive Stream Decks". driveDecks is the explicit
    // choice (true / false), or null for automatic: on once Companion is in use
    // (the module said hello, or a check found a Control Center connection).
    this.driveDecks = typeof raw.driveDecks === 'boolean' ? raw.driveDecks : null;
    this.companionUsed = raw.companionUsed === true;
    this.userPages = new UserPages({ dataDir });
    this._applyDecks();
  }

  drivesDecks() {
    return this.driveDecks == null ? this.companionUsed : this.driveDecks;
  }

  // Tell the deck service who owns the USB decks. When Companion drives them,
  // Control Center closes every USB deck handle and stops opening decks.
  _applyDecks() {
    if (!this.decks || typeof this.decks.setCompanionDrivesDecks !== 'function') return null;
    return this.decks.setCompanionDrivesDecks(this.drivesDecks());
  }

  _markUsed() {
    if (this.companionUsed) return;
    this.companionUsed = true;
    this._save();
    this._applyDecks();
  }

  // body.drive: true, false, or null / 'auto' for the automatic default.
  async setDecks(body = {}) {
    const d = body.drive;
    if (d === true || d === false) this.driveDecks = d;
    else if (d == null || d === 'auto') this.driveDecks = null;
    else throw fail(400, 'drive must be true, false or "auto"');
    this._save();
    await this._applyDecks();
    return this.view();
  }

  decksView() {
    const d = this.decks;
    return {
      drive: this.drivesDecks(),
      setting: this.driveDecks == null ? 'auto' : this.driveDecks,
      companionUsed: this.companionUsed,
      released: d && Array.isArray(d.releasedToCompanion) ? d.releasedToCompanion.length : 0,
    };
  }

  _save() {
    if (this.file) writeJsonAtomic(this.file, { host: this.config.host, port: this.config.port, syncSeq: this.syncSeq, syncedAt: this.syncedAt, driveDecks: this.driveDecks, companionUsed: this.companionUsed });
  }

  // 0.34.0: where Companion is. While Control Center runs Companion (lib/companion/supervisor.js) or found one on
  // its port, 127.0.0.1:<service port>. Otherwise (external mode, no checkout such as on the Pi, or between
  // restarts) the host and port saved on the COMPANION tab.
  uiTarget() {
    const sup = this.supervisor;
    const t = sup && sup.managed ? sup.target() : null;
    return t || { host: this.config.host, port: this.config.port };
  }

  webUrl() {
    const t = this.uiTarget();
    return `http://${t.host}:${t.port}`;
  }

  setConfig(body = {}) {
    this.config = { host: cleanHost(body.host), port: cleanPort(body.port) };
    this.status = { checked: false, online: false, httpApi: false, connections: [], error: null, checkedAt: null };
    this._save();
    return this.view();
  }

  // Is Companion answering on host:port, and does it have a Control Center module
  // connection (pvllc-control-center, or the legacy rs6-presets id)? Companion 4.3+ lists connections on
  // GET /api/connections when its HTTP API is on (the default).
  async check() {
    const base = this.webUrl();
    const at = new Date().toISOString();
    try {
      const r = await this.get(`${base}/api/connections`);
      let list = null;
      if (r.status === 200) { try { list = JSON.parse(r.body); } catch { list = null; } }
      const isCompanion = Array.isArray(list) || String((r.headers && r.headers['x-app']) || '').includes('Companion');
      if (!isCompanion) {
        const home = await this.get(`${base}/`).catch(() => null);
        const named = home && (String((home.headers && home.headers['x-app']) || '').includes('Companion') || /Companion/i.test(home.body || ''));
        this.status = { checked: true, online: !!named, httpApi: false, connections: [], error: named ? null : `${base} answered, but it is not Companion`, checkedAt: at };
        return this.view();
      }
      const connections = (Array.isArray(list) ? list : [])
        .filter((c) => c && MODULE_IDS.includes(c.moduleId))
        .map((c) => {
          // 0.33.0: PV Companion (fork) says which copy runs: "builtin", "dev", or an imported / store version
          const versionId = typeof c.moduleVersionId === 'string' ? c.moduleVersionId.slice(0, 40) : null;
          const imported = !!versionId && versionId !== 'builtin' && versionId !== 'dev';
          return { id: String(c.id || ''), label: String(c.label || ''), moduleId: c.moduleId, legacy: c.moduleId !== MODULE_ID, enabled: c.enabled !== false, status: c.status || null, versionId, oldImport: imported && !semverAtLeast(versionId, DECK_MIN_VERSION) };
        });
      this.status = {
        checked: true,
        online: true,
        httpApi: Array.isArray(list),
        connections,
        error: Array.isArray(list) ? null : 'Companion is running, but its HTTP API is off (Settings → Protocols → HTTP), so the connection list cannot be read.',
        checkedAt: at,
      };
      if (connections.length) this._markUsed();
    } catch (e) {
      this.status = { checked: true, online: false, httpApi: false, connections: [], error: e.message || 'Companion is not answering', checkedAt: at };
    }
    return this.view();
  }

  // The module calls this when it connects and after each refresh.
  hello(body = {}) {
    const str = (v, n) => String(v == null ? '' : v).replace(/[^\w .:+()/-]/g, '').slice(0, n);
    this.module = {
      version: str(body.moduleVersion, 20),
      label: str(body.label, 60),
      companion: str(body.companionVersion, 40),
      rev: str(body.rev, 40),
      presets: Number.isFinite(Number(body.presets)) ? Number(body.presets) : null,
      // 0.13.0 modules: the deck pages they publish (null from an older module: it does not say)
      deckPresets: body.deckPresets != null && Number.isFinite(Number(body.deckPresets)) ? Number(body.deckPresets) : null,
      deckSurfaces: Array.isArray(body.deckSurfaces) ? body.deckSurfaces.map((x) => str(x, 12)).filter((x) => mirror.DECK_SURFACES.includes(x)) : null,
      deckState: ['ok', 'loading', 'off', 'error'].includes(body.deckState) ? body.deckState : null,
      deckError: str(body.deckError, 120),
      at: new Date().toISOString(),
    };
    this.module.deckCapable = semverAtLeast(this.module.version, DECK_MIN_VERSION);
    this.module.deckReports = semverAtLeast(this.module.version, DECK_REPORT_VERSION);
    this.module.current = semverAtLeast(this.module.version, MODULE_MIN_VERSION);
    this._markUsed();
    return { ok: true, rev: this.rev(), expected: MODULE_MIN_VERSION };
  }

  sync() {
    this.syncSeq += 1;
    this.syncedAt = new Date().toISOString();
    this._save();
    return { ok: true, rev: this.rev(), syncSeq: this.syncSeq, syncedAt: this.syncedAt };
  }

  _lib() {
    if (!this.buttons) return { buttons: [], pages: [] };
    return { buttons: this.buttons.buttons || [], pages: this.buttons.pages || [] };
  }

  // Changes whenever a CC button or page changes, or SYNC is pressed.
  rev() {
    const { buttons, pages } = this._lib();
    const hash = crypto.createHash('sha1').update(JSON.stringify({ buttons, pages })).digest('hex').slice(0, 12);
    return `${hash}.${this.syncSeq}`;
  }

  // What the module needs: each button with its look, events, and actions, and
  // each page with its surface layout (keys on top, touch strip, then encoders).
  buttonsModel() {
    const { buttons, pages } = this._lib();
    return {
      rev: this.rev(),
      appVersion: this.appVersion,
      apiVersion: this.apiVersion,
      moduleId: MODULE_ID,
      buttons: buttons.map((b) => {
        const look = resolveKey(b, {}, {});
        return {
          id: b.id,
          name: b.name,
          element: b.element,
          role: b.role,
          text: b.text || '',
          title: b.title || '',
          caption: b.caption || '',
          look: { bgcolor: look.style.bgcolor || '#000000', color: look.style.color || '#ffffff', bar: look.style.bar || null, border: look.style.border || null },
          events: EVENTS.filter((ev) => Array.isArray(b.actions && b.actions[ev]) && b.actions[ev].length),
          actions: b.actions || {},
          feedbacks: b.feedbacks || [],
        };
      }),
      pages: pages.map((p, index) => {
        const s = surfaceById(p.surface);
        return {
          id: p.id,
          name: p.name,
          index,
          surface: p.surface,
          layout: s ? {
            label: s.label,
            cols: s.cols,
            rows: s.rows,
            knobCols: (s.knobCols || []).slice(),
            touchRow: (s.knobCols || []).length ? s.rows : null,
            encoderRow: (s.knobCols || []).length ? s.rows + 1 : null,
            companionLayout: COMPANION_LAYOUT[s.id] || null,
          } : null,
          keys: p.keys || [],
          encoders: p.encoders || [],
          touch: p.touch || [],
        };
      }),
    };
  }

  // Run one event of a CC button, the same way a USB deck press runs it.
  async runButton(id, body = {}) {
    if (!this.buttons) throw fail(503, 'Button library is not loaded');
    const button = this.buttons.button(String(id || ''));
    const event = String(body.event || (button.element === 'encoder' ? 'turn' : button.element === 'touch-segment' ? 'touch' : 'press'));
    if (!EVENTS.includes(event)) throw fail(400, `Unknown event "${event}"`);
    const list = (button.actions && button.actions[event]) || [];
    const target = button.target || { mode: 'follow' };
    const delta = Number(body.delta);
    const ran = [];
    for (const row of list) {
      const instance = target.mode === 'fixed' && target.instance ? target.instance : row.instance;
      const options = { ...(row.options || {}) };
      if (event === 'turn' && Number.isFinite(delta) && delta !== 0 && options.steps == null) options.steps = delta;
      const request = actionToRequest({ ...row, options }, instance);
      if (!request || !request.path) { ran.push({ action: row.action, ok: false, skipped: 'No route for this action yet' }); continue; }
      if (row.delayMs) await new Promise((r) => setTimeout(r, Math.min(row.delayMs, 60000)));
      try {
        const out = this.decks && this.decks.runAction ? await this.decks.runAction(request) : null;
        ran.push({ action: row.action, ok: out !== null, path: request.path });
      } catch (e) {
        ran.push({ action: row.action, ok: false, path: request.path, error: e.message });
      }
    }
    return { ok: ran.every((r) => r.ok), id: button.id, event, ran };
  }

  // One CC page as a Companion page export (type "page", export version 6).
  // Companion upgrades version 6 on import, so the same file opens on Companion
  // 4.x and on Steven's 5.x fork. Keys keep their row/column; the + / + XL touch
  // strip is the row under the keys and the encoders the row under that, the
  // same rows the fork's page layouts use. The import asks which Companion
  // connection stands in for "cc" (pick the Control Center module connection).
  companionConfig(pageId, { label = 'cc' } = {}) {
    if (!this.buttons) throw fail(503, 'Button library is not loaded');
    const page = this.buttons.page(String(pageId || ''));
    const surface = surfaceById(page.surface);
    const byId = new Map((this.buttons.buttons || []).map((b) => [b.id, b]));
    const conn = 'ccPvControlCenter';
    // Use the current id, unless the last check found only legacy rs6-presets
    // connections (module 0.10.0), in which case the export matches those.
    const conns = this.status.connections || [];
    const moduleId = conns.length && conns.every((c) => c.legacy) ? conns[0].moduleId : MODULE_ID;
    let n = 0;
    const nid = () => `cc${(++n).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const act = (buttonId, event, extra = {}) => ({ id: nid(), instance: conn, action: 'cc_button_run', options: { button: buttonId, event, delta: '', ...extra } });
    const controls = {};
    const put = (row, col, control) => { (controls[row] = controls[row] || {})[col] = control; };
    const control = (b, kind) => {
      const look = resolveKey(b, {}, {});
      const rotary = kind === 'encoder';
      const steps = { 0: { action_sets: { down: [], up: [] }, options: { runWhileHeld: [] } } };
      const sets = steps[0].action_sets;
      if (kind === 'key') {
        sets.down.push(act(b.id, 'press'));
        if ((b.actions && b.actions.release || []).length) sets.up.push(act(b.id, 'release'));
      } else if (kind === 'touch') {
        sets.down.push(act(b.id, 'touch'));
      } else {
        if ((b.actions && b.actions.push || []).length) sets.down.push(act(b.id, 'push'));
        sets.rotate_left = [act(b.id, 'turn', { delta: '-1' })];
        sets.rotate_right = [act(b.id, 'turn', { delta: '1' })];
      }
      return {
        type: 'button',
        style: {
          text: [look.text, look.title].filter(Boolean).join('\n') || b.name,
          size: 'auto',
          alignment: 'center:center',
          pngalignment: 'center:center',
          color: hexToInt(look.style.color, 0xffffff),
          bgcolor: hexToInt(look.style.bgcolor, 0x000000),
          show_topbar: false,
        },
        options: { relativeDelay: false, rotaryActions: rotary, stepAutoProgress: true },
        feedbacks: [{ id: nid(), instance_id: conn, type: 'cc_button_look', options: { button: b.id } }],
        steps,
      };
    };
    for (const slot of page.keys || []) { const b = byId.get(slot.buttonId); if (b) put(slot.row, slot.col, control(b, 'key')); }
    const knobs = surface && (surface.knobCols || []).length;
    for (const slot of page.touch || []) { const b = byId.get(slot.buttonId); if (b && knobs) put(surface.rows, slot.col, control(b, 'touch')); }
    for (const slot of page.encoders || []) { const b = byId.get(slot.buttonId); if (b && knobs) put(surface.rows + 1, slot.col, control(b, 'encoder')); }
    const rows = surface ? surface.rows + (knobs ? 2 : 0) : 4;
    const body = {
      version: 6,
      type: 'page',
      companionBuild: undefined,
      page: {
        name: page.name,
        controls,
        gridSize: { minColumn: 0, maxColumn: (surface ? surface.cols : 8) - 1, minRow: 0, maxRow: rows - 1 },
        ...(surface && COMPANION_LAYOUT[surface.id] ? { surfaceLayout: COMPANION_LAYOUT[surface.id] } : {}),
      },
      instances: { [conn]: { label: String(label || 'cc').replace(/[^\w-]/g, '_').slice(0, 40) || 'cc', moduleId, lastUpgradeIndex: -1 } },
      connectionCollections: undefined,
      oldPageNumber: 1,
    };
    const safe = page.name.replace(/[^\w .-]/g, '_').trim() || page.id;
    return { name: `${safe}.companionconfig`, body: JSON.stringify(body, null, 2), json: body };
  }

  // 0.32.0: the deck pages a USB Stream Deck shows (HOME, PTZ LIVE / PAINT / FUNC /
  // MOVE with their knobs, the ATEM switcher page, CONSOLE), for Companion.
  // GET /api/companion/deck. Each surface size is one Control Center virtual deck
  // (companion-<surface>); "live" is what it shows now, "pages" every system page
  // for pinned presets. widgets: every PTZ dial as a standalone strip display.
  deckSurfaces(list) {
    const want = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = want.length ? want.filter((id) => mirror.DECK_SURFACES.includes(id)) : mirror.DECK_SURFACES.slice();
    return ids.length ? ids : mirror.DECK_SURFACES.slice();
  }

  deckModel({ surfaces } = {}) {
    const d = this.decks;
    if (!d || typeof d.companionFaces !== 'function') throw fail(503, 'Stream Deck pages are not running');
    const faces = this.deckSurfaces(surfaces).map((id) => d.companionFaces(id));
    const snap = typeof d.ptzSnap === 'function' ? d.ptzSnap() : {};
    const model = mirror.deckModel(faces, { snap, stepOf: (w) => (typeof d.companionWidgetStep === 'function' ? d.companionWidgetStep(w) : 0) });
    return { ...model, appVersion: this.appVersion, moduleId: MODULE_ID };
  }

  _deckFor(surface) {
    const d = this.decks;
    if (!d || typeof d.companionDevice !== 'function') throw fail(503, 'Stream Deck pages are not running');
    const device = d.companionDevice(String(surface || ''));
    if (!device || !mirror.DECK_SURFACES.includes(device.surfaceId)) throw fail(404, `Unknown surface "${surface}"`);
    return device;
  }

  // A pin is "<system>.<page>" ("ptz.0", "atem.0", "home.0") or { system, page }. Empty: follow.
  _pin(body) {
    let pin = body && body.pin;
    if (typeof pin === 'string') {
      const m = /^([\w-]{1,40})\.(\d{1,2})$/.exec(pin.trim());
      pin = m ? { system: m[1], page: Number(m[2]) } : null;
    }
    if (!pin || typeof pin !== 'object' || !pin.system) return null;
    return { system: String(pin.system).replace(/[^\w-]/g, '').slice(0, 40), page: Math.max(0, Math.min(50, Number(pin.page) || 0)) };
  }

  // body: { row, col, event: 'press' | 'release', pin?: { system, page } }
  async deckKey(surface, body = {}) {
    const device = this._deckFor(surface);
    const row = Number(body.row); const col = Number(body.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= device.rows || col >= device.columns) throw fail(400, 'row / col is not a key on this surface');
    const event = String(body.event || 'press');
    if (event !== 'press' && event !== 'release') throw fail(400, 'event must be press or release');
    if (event === 'press') {
      this.decks.companionPin(device, this._pin(body));
      const out = await this.decks.press(device.id, col, row);
      return { ok: !!(out && out.ok), surface: device.surfaceId, event };
    }
    const out = await this.decks.release(device.id, col, row);
    return { ok: !!(out && out.ok), surface: device.surfaceId, event };
  }

  // body: { index, event: 'rotate' | 'down' | 'up' | 'push' | 'tap', ticks, pin? }
  async deckDial(surface, body = {}) {
    const device = this._deckFor(surface);
    const surf = surfaceById(device.surfaceId);
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0 || index >= (surf.knobCols || []).length) throw fail(400, 'index is not a knob on this surface');
    const event = String(body.event || 'rotate');
    if (!['rotate', 'down', 'up', 'push', 'tap'].includes(event)) throw fail(400, 'event must be rotate, down, up, push or tap');
    const ticks = Math.trunc(Number(body.ticks) || 0);
    if (event === 'rotate' && (!ticks || Math.abs(ticks) > 100)) throw fail(400, 'ticks must be a non-zero integer from -100 to 100');
    this.decks.companionPin(device, this._pin(body));
    const out = await this.decks.turn(device.id, index, event === 'rotate' ? ticks : 0, event);
    return { ok: !!(out && out.ok !== false), surface: device.surfaceId, event };
  }

  // body: { event: 'rotate' | 'down' | 'up' | 'push' | 'tap' | 'reset', ticks }
  async deckWidget(widget, body = {}) {
    const d = this.decks;
    if (!d || typeof d.companionWidget !== 'function') throw fail(503, 'Stream Deck pages are not running');
    const id = String(widget || '');
    if (!mirror.widgetNames().some((w) => w.id === id)) throw fail(404, `Unknown dial "${id}"`);
    const event = String(body.event || 'rotate');
    if (!['rotate', 'down', 'up', 'push', 'tap', 'reset'].includes(event)) throw fail(400, 'event must be rotate, down, up, push, tap or reset');
    const ticks = Math.trunc(Number(body.ticks) || 0);
    if (event === 'rotate' && (!ticks || Math.abs(ticks) > 100)) throw fail(400, 'ticks must be a non-zero integer from -100 to 100');
    const out = await d.companionWidget(id, event, ticks);
    return { ok: !!(out && out.ok), widget: id, event, stepIndex: out && out.stepIndex };
  }

  // One Control Center deck page as a Companion page export (.companionconfig, version 6).
  // pin "" is the whole deck that follows HOME / system / page keys; "ptz.0" etc. is one page.
  // Every button calls the module's cc_deck_key / cc_deck_dial and draws with cc_deck_look.
  deckCompanionConfig(surfaceId, pinId, { label = 'cc' } = {}) {
    const device = this._deckFor(surfaceId);
    const model = this.deckModel({ surfaces: device.surfaceId });
    const s = model.surfaces[0];
    const pin = String(pinId || '');
    let keys; let dials; let name;
    if (pin) {
      const page = s.pages.find((p) => p.id === pin);
      if (!page) throw fail(404, `No page "${pin}" on the ${s.label}`);
      keys = page.keys.filter((k) => k.pressable || k.lines.length);
      dials = page.dials;
      name = `CC ${page.title} (${s.label})`;
    } else {
      keys = [];
      for (let row = 0; row < s.rows; row++) for (let col = 0; col < s.cols; col++) keys.push(s.live.keys.find((k) => k.row === row && k.col === col) || { row, col, lines: [], color: '#E6E6E8', bgcolor: '#222226' });
      dials = s.knobCols.map((col, index) => s.live.dials.find((d) => d.index === index) || { index, col, lines: [], knob: [], color: '#E6E6E8', bgcolor: '#101012' });
      name = `CC deck (${s.label})`;
    }
    const conn = 'ccPvControlCenter';
    const conns = this.status.connections || [];
    const moduleId = conns.length && conns.every((c) => c.legacy) ? conns[0].moduleId : MODULE_ID;
    let n = 0;
    const nid = () => `cd${(++n).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const act = (action, options) => ({ id: nid(), instance: conn, action, options });
    const look = (part, extra) => [{ id: nid(), instance_id: conn, type: 'cc_deck_look', options: { surface: s.id, part, pin, row: 0, col: 0, index: 0, ...extra } }];
    const style = (lines, color, bgcolor) => ({ text: (lines || []).join('\n'), size: 'auto', alignment: 'center:center', pngalignment: 'center:center', color: hexToInt(color, 0xffffff), bgcolor: hexToInt(bgcolor, 0x000000), show_topbar: false });
    const controls = {};
    const put = (row, col, control) => { (controls[row] = controls[row] || {})[col] = control; };
    const button = (st, sets, feedbacks, rotary) => ({ type: 'button', style: st, options: { relativeDelay: false, rotaryActions: !!rotary, stepAutoProgress: true }, feedbacks, steps: { 0: { action_sets: sets, options: { runWhileHeld: [] } } } });
    for (const k of keys) {
      const key = { surface: s.id, row: k.row, col: k.col, pin };
      put(k.row, k.col, button(style(k.lines, k.color, k.bgcolor), { down: [act('cc_deck_key', { ...key, event: 'press' })], up: [act('cc_deck_key', { ...key, event: 'release' })] }, look('key', { row: k.row, col: k.col })));
    }
    if (s.touchRow != null) {
      for (const d of dials) {
        const dial = { surface: s.id, index: d.index, pin };
        put(s.touchRow, d.col, button(style(d.lines, d.color, d.bgcolor), { down: [act('cc_deck_dial', { ...dial, event: 'tap', delta: '' })], up: [] }, look('strip', { index: d.index })));
        put(s.encoderRow, d.col, button(style(d.knob, '#E6E6E8', '#101012'), {
          down: [act('cc_deck_dial', { ...dial, event: 'down', delta: '' })],
          up: [act('cc_deck_dial', { ...dial, event: 'up', delta: '' })],
          rotate_left: [act('cc_deck_dial', { ...dial, event: 'rotate', delta: '-1' })],
          rotate_right: [act('cc_deck_dial', { ...dial, event: 'rotate', delta: '1' })],
        }, look('knob', { index: d.index }), true));
      }
    }
    const rows = s.rows + (s.touchRow != null ? 2 : 0);
    const body = {
      version: 6,
      type: 'page',
      companionBuild: undefined,
      page: {
        name,
        controls,
        gridSize: { minColumn: 0, maxColumn: s.cols - 1, minRow: 0, maxRow: rows - 1 },
        ...(s.companionLayout ? { surfaceLayout: s.companionLayout } : {}),
      },
      instances: { [conn]: { label: String(label || 'cc').replace(/[^\w-]/g, '_').slice(0, 40) || 'cc', moduleId, lastUpgradeIndex: -1 } },
      connectionCollections: undefined,
      oldPageNumber: 1,
    };
    const safe = name.replace(/[^\w .()-]/g, '_').replace(/\s+/g, ' ').trim();
    return { name: `${safe}.companionconfig`, body: JSON.stringify(body, null, 2), json: body };
  }

  view() {
    const model = this.buttonsModel();
    const module = this.module ? { ...this.module, stale: this.module.rev !== model.rev } : null;
    return {
      config: { ...this.config },
      webUrl: this.webUrl(),
      // 0.34.0: the same-origin web UI, and Control Center's Companion service (null without one)
      uiUrl: '/companion/',
      service: this.supervisor ? this.supervisor.status() : null,
      status: { ...this.status, connections: this.status.connections.slice() },
      module,
      moduleId: MODULE_ID,
      legacyModuleIds: LEGACY_MODULE_IDS.slice(),
      moduleName: 'Performance Video Control Center',
      moduleMinVersion: MODULE_MIN_VERSION,
      deckMinVersion: DECK_MIN_VERSION,
      deckReportVersion: DECK_REPORT_VERSION,
      userPages: this.userPages.list(),
      moduleRepo: MODULE_REPO,
      decks: this.decksView(),
      rev: model.rev,
      syncSeq: this.syncSeq,
      syncedAt: this.syncedAt,
      counts: { buttons: model.buttons.length, pages: model.pages.length },
      pages: model.pages.map((p) => ({ id: p.id, name: p.name, surface: p.surface, label: p.layout ? p.layout.label : p.surface })),
      deckPages: this.deckPagesList(),
    };
  }

  // 0.33.0: every page Control Center outputs for Companion, for PV Companion's "Control Center pages": the live deck
  // pages per deck size (the whole deck, or one page), the PAGES library pages, and the user pages saved back.
  catalog() {
    const model = this.buttonsModel();
    return {
      appVersion: this.appVersion,
      connection: 'ccPvControlCenter',
      moduleId: MODULE_ID,
      deck: this.deckPagesList().map((d) => ({
        surface: d.surface,
        label: d.label,
        layout: COMPANION_LAYOUT[d.surface] || '',
        pages: [{ id: `deck:${d.surface}:`, title: 'Whole deck (follows HOME and page keys)' }, ...d.pages.map((p) => ({ id: `deck:${d.surface}:${p.id}`, title: p.title }))],
      })),
      library: model.pages.map((p) => ({ id: `library:${p.id}`, title: p.name, surface: p.surface, label: p.layout ? p.layout.label : p.surface, layout: COMPANION_LAYOUT[p.surface] || '' })),
      user: this.userPages.list().map((p) => ({ ...p, id: `user:${p.id}`, userId: p.id, title: p.name })),
    };
  }

  // one catalog page as a Companion page export: { name, body, json }
  catalogExport(id, { label = 'cc' } = {}) {
    const m = /^(deck|library|user):([\w-]*)(?::([\w.-]*))?$/.exec(String(id || ''));
    if (!m) throw fail(400, 'id is deck:<surface>:<page>, library:<page> or user:<id>');
    if (m[1] === 'deck') return this.deckCompanionConfig(m[2], m[3] || '', { label });
    if (m[3] != null) throw fail(400, 'Bad page id');
    if (m[1] === 'library') return this.companionConfig(m[2], { label });
    return this.userPages.companionConfig(m[2]);
  }

  // 0.32.0: the deck pages per surface, for the COMPANION tab's download list.
  deckPagesList() {
    const d = this.decks;
    if (!d || typeof d.companionFaces !== 'function') return [];
    try {
      return mirror.DECK_SURFACES.map((id) => {
        const f = d.companionFaces(id);
        return { surface: id, label: f.surface.label, pages: f.pages.map((p) => ({ id: `${p.system}.${p.page}`, title: p.title })) };
      });
    } catch {
      return [];
    }
  }
}

module.exports = { CompanionBridge, MODULE_ID, LEGACY_MODULE_IDS, MODULE_IDS, MODULE_REPO, MODULE_MIN_VERSION, DECK_MIN_VERSION, DECK_REPORT_VERSION, COMPANION_LAYOUT, semverAtLeast, httpGet };
