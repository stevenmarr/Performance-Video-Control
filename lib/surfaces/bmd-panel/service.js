'use strict';
// Control Center drives a Blackmagic ATEM Micro Panel directly over USB / Bluetooth HID, in place of ATEM
// Software Control: presses go through SystemManager.atem() (the same path as the ATEM page and the
// Stream Deck), and every lamp follows the switcher's state. Off until enabled; settings are per install
// (<dataDir>/atem-panel.json), never in a show. CC_BMD_PANEL=0 keeps it off whatever the settings say.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./protocol');
const { PanelHost } = require('./host');
const { AtemPanelEmulation, clean } = require('./emulation');

const CONFLICT_APPS = ['ATEM Software Control', 'ATEM Setup'];
const BLINK_MS = 250; const CONFLICT_MS = 5000; const RING = 100;

// macOS / Linux: is a Blackmagic app that also drives the panel running on this machine?
function defaultConflictCheck() {
  if (process.platform === 'win32') return Promise.resolve([]);
  return Promise.all(CONFLICT_APPS.map((name) => new Promise((resolve) => {
    execFile('pgrep', ['-x', name], { timeout: 2000 }, (err, out) => resolve(!err && String(out).trim() ? name : null));
  }))).then((x) => x.filter(Boolean));
}

function disabledByEnv(env = process.env) { const v = String(env.CC_BMD_PANEL == null ? '' : env.CC_BMD_PANEL).toLowerCase(); return v === '0' || v === 'false' || v === 'off' || v === 'no'; }

class AtemPanelService {
  constructor({ systems, dataDir, host = null, conflictCheck = defaultConflictCheck, env = process.env, now = () => Date.now(), blinkMs = BLINK_MS, conflictMs = CONFLICT_MS } = {}) {
    this.systems = systems; this.env = env; this.now = now; this.blinkMs = blinkMs; this.conflictMs = conflictMs;
    this.file = dataDir ? path.join(dataDir, 'atem-panel.json') : null;
    this.cfg = this._load();
    this.host = host || new PanelHost({ env });
    this.conflictCheck = conflictCheck;
    this.hw = { state: 'off', device: null, error: null, battery: null, lease: null };
    this.conflict = []; this.events = []; this.lastFrame = null; this.started = false; this.blink = true; this._timers = [];
    this.emu = new AtemPanelEmulation({
      settings: this.cfg,
      dispatch: (op, body) => this._dispatch(op, body),
      view: () => this._view(),
      locked: () => (this.systems && this.systems.os && this.systems.os.panel && this.systems.os.panel.locked ? 'Control Center is locked (CONSOLE LOCK): unlock it to use the panel' : false),
      now,
      onEvent: (e) => this._event(e),
    });
    this.host.on('status', (s) => { this.hw = { ...this.hw, state: s.state, device: s.device || null, error: s.error || null, lease: s.lease || this.hw.lease }; this._event({ kind: 'status', detail: s.state + (s.error ? `: ${s.error}` : '') }); if (s.state === 'connected') { this.lastFrame = null; this.render(); } });
    this.host.on('down', (k) => { this.emu.down(k); this.render(); });
    this.host.on('up', (k) => { this.emu.up(k); this.render(); });
    this.host.on('tbar', (v) => { this.emu.tbar(v); this.render(); });
    this.host.on('battery', (p) => { this.hw.battery = p; });
    this.host.on('log', (level, msg) => this._log(level, msg));
    this._onState = () => { this.emu.sync(); this.render(); };
  }

  _load() {
    let raw = {};
    try { if (this.file && fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { raw = {}; }
    return { enabled: !!raw.enabled, instance: typeof raw.instance === 'string' && raw.instance ? raw.instance : 'atem', ...clean(raw) };
  }
  _save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, ...this.cfg }, null, 2)); fs.renameSync(tmp, this.file);
  }
  _log(level, msg) { if (this.systems && this.systems.log) this.systems.log(level, msg); }
  _event(e) {
    this.events.push({ at: new Date(this.now()).toISOString(), ...e, label: e.key ? P.labelOf(e.key) : undefined });
    if (this.events.length > RING) this.events.splice(0, this.events.length - RING);
    if (e.kind === 'refused') this._log('warn', `ATEM Micro Panel: ${P.labelOf(e.key)} refused: ${e.reason}`);
  }

  _view() {
    try {
      const d = this.systems.driver(this.cfg.instance);
      if (!d || !d.status().connected) return { connected: false, view: null };
      return { connected: true, view: d.view() };
    } catch { return { connected: false, view: null }; }
  }
  _dispatch(op, body) { return this.systems.atem(op, { ...body, instance: this.cfg.instance }); }

  // ---------- lifecycle ----------
  start() {
    if (this.started) return this.status();
    if (disabledByEnv(this.env)) { this.hw.state = 'disabled'; this.hw.error = 'CC_BMD_PANEL=0'; return this.status(); }
    this.started = true;
    if (this.systems && this.systems.on) this.systems.on('state', this._onState);
    const blink = setInterval(() => { this.blink = !this.blink; this.render(); }, this.blinkMs); if (blink.unref) blink.unref();
    const conf = setInterval(() => this._checkConflict(), this.conflictMs); if (conf.unref) conf.unref();
    this._timers = [blink, conf];
    if (this.cfg.enabled) this._checkConflict(true);
    return this.status();
  }

  async _checkConflict(first = false) {
    if (!this.started || !this.cfg.enabled) return;
    let apps = [];
    try { apps = await this.conflictCheck(); } catch { apps = []; }
    const was = this.conflict.length; this.conflict = apps;
    if (apps.length) {
      if (!was) { this._log('warn', `ATEM Micro Panel: ${apps.join(' and ')} ${apps.length > 1 ? 'are' : 'is'} open on this computer and would drive the panel too. Control Center let go of the panel; quit ${apps.length > 1 ? 'them' : 'it'} to take it back.`); await this.host.stop(); this.hw.state = 'conflict'; this.hw.device = null; }
      return;
    }
    if (was || first || (this.hw.state === 'off' || this.hw.state === 'conflict')) { await this.host.start(); }
  }

  async stop() {
    this.started = false;
    for (const t of this._timers) clearInterval(t); this._timers = [];
    if (this.systems && this.systems.off) this.systems.off('state', this._onState);
    await this.host.stop();
    this.hw.state = 'off'; this.hw.device = null;
  }

  render() {
    if (!this.started || this.hw.state !== 'connected') return;
    const buf = P.encodeLeds(this.emu.frame(this.blink));
    const hex = buf.toString('hex');
    if (hex === this.lastFrame) return;
    this.lastFrame = hex;
    Promise.resolve(this.host.setLeds(buf)).catch(() => { this.lastFrame = null; });
  }

  // ---------- API ----------
  async configure(b = {}) {
    const next = { ...this.cfg };
    if (b.enabled !== undefined) next.enabled = !!b.enabled;
    if (b.instance !== undefined) {
      const id = String(b.instance || 'atem');
      if (this.systems && this.systems.typeOf && this.systems.typeOf(id) !== 'atem') { const e = new Error(`"${id}" is not an ATEM`); e.status = 404; throw e; }
      next.instance = id;
    }
    for (const k of ['me', 'sources', 'programRow', 'arm', 'idle', 'tbarInvert', 'tbarLedReverse', 'doubleMs', 'overrides']) if (b[k] !== undefined) next[k] = b[k];
    const wasEnabled = this.cfg.enabled;
    this.cfg = { enabled: next.enabled, instance: next.instance, ...clean(next) };
    this.emu.setSettings(this.cfg);
    this._save();
    if (this.started && this.cfg.enabled && !wasEnabled) await this._checkConflict(true);
    if (this.started && !this.cfg.enabled && wasEnabled) { await this.host.stop(); this.hw.state = 'off'; this.hw.device = null; }
    this.lastFrame = null; this.render();
    return this.status();
  }
  selectMe(me) { this.emu.selectMe(Math.round(Number(me) || 1)); this.render(); return this.status(); }

  status() {
    const v = this._view();
    return {
      enabled: this.cfg.enabled, started: this.started,
      state: this.cfg.enabled ? this.hw.state : this.hw.state === 'disabled' ? 'disabled' : 'off',
      device: this.hw.device, battery: this.hw.battery, error: this.hw.error, conflict: this.conflict,
      instance: this.cfg.instance, atemConnected: v.connected, mes: v.view ? (v.view.mes || []).length : 0,
      ...this.emu.status(),
      controls: P.KEYS.map((k) => ({ id: k.id, label: k.label, row: k.row, column: k.column })),
      events: this.events.slice(-30),
    };
  }
}

module.exports = { AtemPanelService, defaultConflictCheck, disabledByEnv, CONFLICT_APPS };
