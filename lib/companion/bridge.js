'use strict';
// COMPANION tab (0.31.0). Control Center defines buttons and pages (BUTTONS /
// PAGES). Bitfocus Companion, and Steven's fork with its page designs and page
// templates, puts them on Stream Decks. Two ways across:
//   1. The Companion module (companion-module-rs6-presets 0.10.0+) reads
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

const MODULE_ID = 'rs6-presets';
const MODULE_MIN_VERSION = '0.10.0';
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
  }

  _save() {
    if (this.file) writeJsonAtomic(this.file, { host: this.config.host, port: this.config.port, syncSeq: this.syncSeq, syncedAt: this.syncedAt });
  }

  webUrl() {
    return `http://${this.config.host}:${this.config.port}`;
  }

  setConfig(body = {}) {
    this.config = { host: cleanHost(body.host), port: cleanPort(body.port) };
    this.status = { checked: false, online: false, httpApi: false, connections: [], error: null, checkedAt: null };
    this._save();
    return this.view();
  }

  // Is Companion answering on host:port, and does it have a PV Control Center
  // (rs6-presets) connection? Companion 4.3+ lists connections on
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
        .filter((c) => c && c.moduleId === MODULE_ID)
        .map((c) => ({ id: String(c.id || ''), label: String(c.label || ''), enabled: c.enabled !== false, status: c.status || null }));
      this.status = {
        checked: true,
        online: true,
        httpApi: Array.isArray(list),
        connections,
        error: Array.isArray(list) ? null : 'Companion is running, but its HTTP API is off (Settings → Protocols → HTTP), so the connection list cannot be read.',
        checkedAt: at,
      };
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
      at: new Date().toISOString(),
    };
    this.module.current = semverAtLeast(this.module.version, MODULE_MIN_VERSION);
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
  // connection stands in for "cc" (pick the PV Control Center connection).
  companionConfig(pageId, { label = 'cc' } = {}) {
    if (!this.buttons) throw fail(503, 'Button library is not loaded');
    const page = this.buttons.page(String(pageId || ''));
    const surface = surfaceById(page.surface);
    const byId = new Map((this.buttons.buttons || []).map((b) => [b.id, b]));
    const conn = 'ccPvControlCenter';
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
      instances: { [conn]: { label: String(label || 'cc').replace(/[^\w-]/g, '_').slice(0, 40) || 'cc', moduleId: MODULE_ID, lastUpgradeIndex: -1 } },
      connectionCollections: undefined,
      oldPageNumber: 1,
    };
    const safe = page.name.replace(/[^\w .-]/g, '_').trim() || page.id;
    return { name: `${safe}.companionconfig`, body: JSON.stringify(body, null, 2), json: body };
  }

  view() {
    const model = this.buttonsModel();
    const module = this.module ? { ...this.module, stale: this.module.rev !== model.rev } : null;
    return {
      config: { ...this.config },
      webUrl: this.webUrl(),
      status: { ...this.status, connections: this.status.connections.slice() },
      module,
      moduleId: MODULE_ID,
      moduleMinVersion: MODULE_MIN_VERSION,
      moduleRepo: 'https://github.com/stevenmarr/companion-module-rs6-presets',
      rev: model.rev,
      syncSeq: this.syncSeq,
      syncedAt: this.syncedAt,
      counts: { buttons: model.buttons.length, pages: model.pages.length },
      pages: model.pages.map((p) => ({ id: p.id, name: p.name, surface: p.surface, label: p.layout ? p.layout.label : p.surface })),
    };
  }
}

module.exports = { CompanionBridge, MODULE_ID, MODULE_MIN_VERSION, COMPANION_LAYOUT, semverAtLeast, httpGet };
