
'use strict';
// TourBox NEO surface: Control Center talks to the box over USB serial, maps every
// control through the shared action layer, and drives the selected PTZ camera
// (the same camera the Stream Deck has selected). Settings live in
// <dataDir>/tourbox.json, never in a show. CC_TOURBOX=0 keeps it off.
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const { TourBoxHost } = require('./host');
const { loadBuiltins, resolve, withIndex, factoryId, normHeld } = require('./mapping');
const paint = require('../../paint-accel');

const RING = 100;
const EXPOSURE_RESET = new Set(['iris', 'gain', 'shutterStep', 'ndFilter', 'pictureLevel']);
const RATE_IDLE_MS = paint.ACCEL.windowMs;
const DECK_PAGES = {
  'ptz-rcp': 'ptz-rcp-exp',
  'ptz-msu': 'ptz-msu',
  white: 'ptz-rcp-white',
  black: 'ptz-rcp-black',
  tone: 'ptz-rcp-tone',
};
const DECK_ALIASES = {
  'ptz-rcp-white': ['ptz-rcp-wb'],
  'ptz-rcp-black': ['ptz-rcp-wb'],
  'ptz-rcp-tone': ['ptz-rcp-gamma'],
  'ptz-rcp-wb': ['ptz-rcp-white', 'ptz-rcp-black'],
  'ptz-rcp-gamma': ['ptz-rcp-tone'],
};


function disabledByEnv(env = process.env) {
  const v = String(env.CC_TOURBOX == null ? '' : env.CC_TOURBOX).toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

function cleanCfg(raw = {}) {
  const profile = factoryId(raw.profile || 'ptz-rcp');
  const instance = typeof raw.instance === 'string' && raw.instance ? raw.instance : 'ptz';
  return {
    enabled: !!raw.enabled,
    instance,
    profile,
    learn: !!raw.learn,
    gang: !!raw.gang,
    msuPair: Math.max(0, Math.round(Number(raw.msuPair) || 0)),
  };
}

class TourBoxService {
  constructor({ systems, dataDir, host = null, deskSelection = null, decks = null, env = process.env, now = () => Date.now() } = {}) {
    this.systems = systems;
    this.env = env;
    this.now = now;
    this.file = dataDir ? path.join(dataDir, 'tourbox.json') : null;
    this.cfg = this._load();
    this.host = host || new TourBoxHost({ env });
    this.deskSelection = deskSelection || null;
    this.decks = decks || null;
    this.hw = { state: 'off', device: null, error: null };
    this.events = [];
    this.started = false;
    this.held = new Set();
    this.presses = new Map();
    this.chorded = new Set();
    this.rateTimers = new Map();
    this.dialOp = 'masterPed';
    this.bank = null;
    this.lastTouched = null;
    this.lastNotice = null;
    this.builtins = loadBuiltins();
    this.profiles = Object.fromEntries(Object.entries(this.builtins).map(([id, p]) => [id, withIndex(p)]));
    this.host.on('status', (s) => {
      this.hw = { state: s.state, device: s.device || null, error: s.error || null };
      this._event({ kind: 'status', detail: s.state + (s.error ? `: ${s.error}` : '') });
    });
    this.host.on('event', (ev) => { this.onEvent(ev).catch((e) => this._refuse(null, e.message)); });
    this.host.on('log', (level, msg) => this._log(level, msg));
    this._onDesk = (s) => { if (s && s.camera) this._event({ kind: 'camera', camera: s.camera, source: s.source || 'desk' }); };
    if (this.deskSelection) this.deskSelection.on('change', this._onDesk);
  }

  _load() {
    let raw = {};
    try { if (this.file && fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { raw = {}; }
    return cleanCfg(raw);
  }
  _save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, ...this.cfg }, null, 2));
    fs.renameSync(tmp, this.file);
  }
  _log(level, msg) { if (this.systems && this.systems.log) this.systems.log(level, msg); }
  _event(e) {
    this.events.push({ at: new Date(this.now()).toISOString(), ...e });
    if (this.events.length > RING) this.events.splice(0, this.events.length - RING);
  }
  _refuse(control, reason) {
    this.lastNotice = { at: this.now(), control, reason };
    this._event({ kind: 'refused', control, reason });
    this._log('warn', `TourBox${control ? ` ${P.labelOf(control)}` : ''}: ${reason}`);
  }
  _notice(reason) { this.lastNotice = { at: this.now(), reason }; this._event({ kind: 'notice', reason }); }

  profile() { return this.profiles[this.cfg.profile] || this.profiles['ptz-rcp']; }

  // ---------- lifecycle ----------
  start() {
    if (this.started) return this.status();
    if (disabledByEnv(this.env)) { this.hw.state = 'disabled'; this.hw.error = 'CC_TOURBOX=0'; return this.status(); }
    this.started = true;
    if (this.cfg.enabled) this.host.start();
    return this.status();
  }

  async stop() {
    this.started = false;
    this._clearRates();
    if (this.deskSelection && this._onDesk) this.deskSelection.off('change', this._onDesk);
    await this.host.stop();
    this.hw.state = 'off'; this.hw.device = null;
  }

  async configure(b = {}) {
    const next = { ...this.cfg };
    if (b.enabled !== undefined) next.enabled = !!b.enabled;
    if (b.instance !== undefined) {
      const id = String(b.instance || 'ptz');
      if (this.systems && this.systems.typeOf && this.systems.typeOf(id) !== 'ptz') {
        const e = new Error(`"${id}" is not a PTZ system`); e.status = 404; throw e;
      }
      next.instance = id;
    }
    if (b.profile !== undefined) next.profile = factoryId(b.profile);
    if (b.learn !== undefined) next.learn = !!b.learn;
    if (b.gang !== undefined) next.gang = !!b.gang;
    if (b.msuPair !== undefined) next.msuPair = Math.max(0, Math.round(Number(b.msuPair) || 0));
    const wasEnabled = this.cfg.enabled;
    this.cfg = cleanCfg(next);
    this._save();
    if (this.started && this.cfg.enabled && !wasEnabled) await this.host.start();
    if (this.started && !this.cfg.enabled && wasEnabled) { await this.host.stop(); this.hw.state = 'off'; this.hw.device = null; }
    if (b.profile !== undefined) this._followDeck(this.cfg.profile === 'ptz-msu' ? 'ptz-msu' : 'ptz-rcp');
    return this.status();
  }

  // ---------- camera / pair ----------
  _view() {
    try { return this.systems.ptzView(this.cfg.instance); } catch { return { cameras: [], selected: null }; }
  }
  _selectedId() {
    if (this.deskSelection && this.deskSelection.camera) return this.deskSelection.camera;
    const v = this._view();
    return v.selected || null;
  }
  _cameras() { return (this._view().cameras || []); }
  _msuPair() {
    const cams = this._cameras();
    if (!cams.length) return { a: null, b: null, index: 0 };
    if (cams.length === 1) return { a: cams[0], b: null, index: 0 };
    let i = this.cfg.msuPair || 0;
    const sel = this._selectedId();
    const si = cams.findIndex((c) => c.id === sel);
    if (si >= 0 && (si < i || si > i + 1)) i = si - (si % 2);
    i = Math.max(0, Math.min(cams.length - 2, i));
    return { a: cams[i], b: cams[i + 1], index: i };
  }
  _targets(spec) {
    const target = (spec && spec.target) || 'selected';
    const pair = this._msuPair();
    const sel = this._selectedId();
    if (target === 'msu-a') return pair.a ? [pair.a.id] : [];
    if (target === 'msu-b') return pair.b ? [pair.b.id] : [];
    if (target === 'pair') return [pair.a, pair.b].filter(Boolean).map((c) => c.id);
    if (target === 'all') return this._cameras().map((c) => c.id);
    if (target === 'gang' || (this.cfg.gang && this.cfg.profile === 'ptz-msu' && (target === 'msu-a' || target === 'msu-b' || (spec && spec.op === 'iris')))) {
      const ids = [pair.a, pair.b].filter(Boolean).map((c) => c.id);
      return ids.length ? ids : (sel ? [sel] : []);
    }
    return sel ? [sel] : [];
  }
  _cam(id) { return this._cameras().find((c) => c.id === id) || null; }
  _locked(id) { const c = this._cam(id); return !!(c && c.locked); }
  _live(id) { const c = this._cam(id); return !!(c && c.tally); }
  _offline(id) { const c = this._cam(id); return !c || !c.connected; }

  // ---------- events ----------
  async onEvent(ev) {
    const at = ev.at || this.now();
    const control = ev.control;
    if (!control) return;
    if (ev.event === 'press') this.held.add(control);
    else if (ev.event === 'release') this.held.delete(control);

    this._event({ kind: ev.event, control, ticks: ev.ticks || 0, held: [...(ev.held || this.held)], code: ev.code });

    if (this.cfg.learn) {
      this.lastTouched = { control, event: ev.event, ticks: ev.ticks || 0, at, learn: true };
      return;
    }

    if (ev.event === 'turn') {
      for (const m of normHeld(this.held)) this.chorded.add(m);
      const press = this.presses.get(control);
      if (press && !press.longLatched) press.turned = true;
      await this._fire(control, 'turn', ev);
      return;
    }
    if (ev.event === 'press') {
      this.presses.set(control, { at, turned: false, longLatched: false });
      // Latch "this is a long press" at 800 ms if the operator holds still (no turn).
      const t = setTimeout(() => {
        const p = this.presses.get(control);
        if (p && !p.turned && this.held.has(control)) p.longLatched = true;
      }, P.LONG_PRESS_MS);
      if (t.unref) t.unref();
      this.presses.get(control).timer = t;
      return;
    }
    if (ev.event === 'release') {
      const press = this.presses.get(control);
      if (press && press.timer) clearTimeout(press.timer);
      this.presses.delete(control);
      const heldMs = press ? at - press.at : 0;
      if (this.chorded.has(control)) { this.chorded.delete(control); return; }
      if (press && press.turned && !press.longLatched) return;
      const kind = press && (press.longLatched || heldMs >= P.LONG_PRESS_MS) && !press.turned ? 'long' : 'press';
      await this._fire(control, kind, { ...ev, heldMs });
    }
  }

  async _fire(control, event, ev) {
    const held = normHeld(ev.held || this.held).filter((h) => h !== control);
    const hit = resolve(this.profile(), control, event, held);
    if (!hit) return;
    try {
      const result = await this._dispatch(hit.binding, { control, event, ev, held: hit.held });
      if (result && result.silent) return;
      this.lastTouched = {
        control, event, action: hit.binding.action, op: hit.binding.op || this.dialOp,
        camera: (result && result.camera) || this._selectedId(),
        value: result && result.value,
        text: result && result.text,
        at: this.now(),
      };
    } catch (e) {
      this._refuse(control, e.message);
    }
  }

  _followDeck(page) {
    this.bank = page;
    if (this.decks && typeof this.decks.followPtzPage === 'function') {
      Promise.resolve(this.decks.followPtzPage(DECK_PAGES[page] || page)).catch((e) => this._log('warn', `TourBox deck follow: ${e.message}`));
    }
  }

  _clearRates() {
    for (const t of this.rateTimers.values()) clearTimeout(t.timer);
    this.rateTimers.clear();
  }

  _armRateStop(axis, cam) {
    const prev = this.rateTimers.get(axis);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.rateTimers.delete(axis);
      this._ptz('stop', { cam, axes: [axis === 'zoom' ? 'zoom' : 'focus'] }).catch(() => {});
    }, RATE_IDLE_MS);
    if (timer.unref) timer.unref();
    this.rateTimers.set(axis, { timer, cam });
  }

  _ptz(name, body) {
    return this.systems.ptz(name, { instance: this.cfg.instance, ...body });
  }

  async _dispatch(binding, ctx) {
    const action = binding.action;
    if (action === 'none') return { silent: true };
    if (action === 'tourbox.profile') {
      this.cfg.profile = factoryId(binding.profile);
      this._save();
      this._followDeck(this.cfg.profile === 'ptz-msu' ? 'ptz-msu' : 'ptz-rcp');
      this._event({ kind: 'profile', profile: this.cfg.profile });
      return { text: this.profile().name };
    }
    if (action === 'tourbox.bank') {
      this._followDeck(binding.bank);
      this._event({ kind: 'bank', bank: binding.bank });
      return { text: String(binding.bank).toUpperCase(), silent: false };
    }
    if (action === 'tourbox.msuPair') {
      const cams = this._cameras();
      if (cams.length < 3) { this._notice('Only two cameras, or fewer — the MSU pair does not page'); return { text: 'pair' }; }
      const cur = this._msuPair();
      const next = Math.max(0, Math.min(cams.length - 2, cur.index + (binding.dir < 0 ? -2 : 2)));
      this.cfg.msuPair = next;
      this._save();
      const pair = this._msuPair();
      const text = `MSU irises: ${pair.a ? pair.a.name : '—'} / ${pair.b ? pair.b.name : '—'}`;
      this._notice(text);
      return { text };
    }
    if (action === 'tourbox.gangToggle') {
      this.cfg.gang = !this.cfg.gang;
      this._save();
      this._event({ kind: 'gang', gang: this.cfg.gang });
      return { text: this.cfg.gang ? 'GANG ON' : 'GANG OFF' };
    }
    if (action === 'ptz.compare') {
      this._notice('COMPARE is not built yet — the picture was not changed');
      return { text: 'not built yet' };
    }
    if (action === 'ptz.stopAll') {
      await this._ptz('stopAll');
      this._clearRates();
      return { text: 'STOP ALL' };
    }
    if (action === 'ptz.dialPair') {
      const ops = binding.ops || ['masterPed', 'pictureLevel'];
      const i = ops.indexOf(this.dialOp);
      this.dialOp = ops[(i < 0 ? 0 : i + 1) % ops.length];
      return { text: this.dialOp, op: this.dialOp };
    }
    if (action === 'ptz.resetActiveDial') {
      return this._dispatch({ action: 'ptz.reset', op: this.dialOp, target: binding.target || 'selected' }, ctx);
    }

    const ids = this._targets(binding);
    if (action === 'ptz.stop') {
      for (const cam of ids) await this._ptz('stop', { cam, axes: binding.axes || ['pt', 'zoom', 'focus'] });
      this._clearRates();
      return { camera: ids[0], text: 'STOP' };
    }

    if (!ids.length) { this._refuse(ctx.control, 'No camera selected'); return { silent: true }; }

    let last = null;
    for (const cam of ids) {
      last = await this._runOnCam(action, binding, cam, ctx);
    }
    return last;
  }

  async _runOnCam(action, binding, cam, ctx) {
    const ev = ctx.ev || {};
    const label = (this._cam(cam) || {}).name || cam;
    if (this._offline(cam) && action !== 'ptz.stop') {
      throw Object.assign(new Error(`${label} is offline`), { status: 409 });
    }
    const allowedWhenLocked = action === 'ptz.stop' || action === 'ptz.stopAll';
    if (this._locked(cam) && !allowedWhenLocked) {
      throw Object.assign(new Error(`PTZ ${label}: paint is locked (unlock it on CAMERA CONTROL)`), { status: 423 });
    }

    if (action === 'ptz.step') {
      const op = binding.op;
      const ticks = ev.ticks || 0;
      if (!ticks) return { camera: cam, silent: true };
      const steps = binding.velocity === false ? ticks : paint.stepsFor(op, ticks, ev.dtMs);
      const r = await this._ptz('step', { cam, op, steps, wrap: false, forKnob: true });
      const readout = this._readout(cam, op);
      return { camera: cam, value: r && r.value, text: readout || String((r && r.value) != null ? r.value : ''), op };
    }
    if (action === 'ptz.reset') {
      const op = binding.op;
      if (!paint.RESETTABLE.has(op)) {
        this._notice(`${op} does not reset on a long press`);
        return { camera: cam, text: 'no reset' };
      }
      if (binding.liveGuard === 'exposure' || EXPOSURE_RESET.has(op)) {
        if (this._live(cam)) throw Object.assign(new Error(`PTZ ${label} is live (red tally): exposure reset is blocked`), { status: 423 });
      }
      const r = await this._ptz('reset', { cam, op });
      return { camera: cam, value: r && r.value, text: this._readout(cam, op), op };
    }
    if (action === 'ptz.toggle') {
      if (binding.auto && binding.op === 'gain') return this._toggleAutoGain(cam);
      const cur = this._value(cam, binding.op);
      const cat = this._op(cam, binding.op);
      if (binding.liveGuard && this._live(cam) && !ev.confirmed) {
        const g = (this._view().liveGuard) || { mode: 'hold', holdMs: 600 };
        if (g.mode === 'lock') throw Object.assign(new Error(`PTZ ${label} is live (red tally): ${cat && cat.label || binding.op} is locked`), { status: 423 });
        if (g.mode === 'hold' && (ev.heldMs || 0) < g.holdMs) throw Object.assign(new Error(`PTZ ${label} is live (red tally): hold the key ${g.holdMs} ms`), { status: 423 });
      }
      let value;
      if (cat && cat.type === 'toggle') value = !cur;
      else if (cat && cat.type === 'list' && cat.options && cat.options.length) {
        const i = cat.options.findIndex(([k]) => String(k) === String(cur));
        value = cat.options[(i < 0 ? 0 : i + 1) % cat.options.length][0];
      } else value = !cur;
      const r = await this._ptz('op', { cam, op: binding.op, value });
      return { camera: cam, value: r && r.value, text: this._readout(cam, binding.op), op: binding.op };
    }
    if (action === 'ptz.oneTouchAF') {
      await this._ptz('oneTouchAF', { cam });
      return { camera: cam, text: 'ONE-TOUCH AF' };
    }
    if (action === 'ptz.rate') {
      const axis = binding.axis === 'focus' ? 'focus' : 'zoom';
      const ticks = ev.ticks || 0;
      if (!ticks) return { camera: cam, silent: true };
      const speeds = (this._view().speeds || {})[axis] || 25;
      const steps = Math.abs(paint.stepsFor(axis === 'zoom' ? 'zoomPos' : 'focusPos', ticks, ev.dtMs));
      const speed = Math.max(1, Math.min(49, Math.round(Math.max(1, steps))));
      const signed = (ticks < 0 ? -1 : 1) * Math.min(speeds, speed);
      await this._ptz(axis, { cam, dir: signed, speed: true });
      this._armRateStop(axis, cam);
      return { camera: cam, value: signed, text: `${axis.toUpperCase()} ${signed}`, op: axis };
    }
    if (action === 'ptz.presetStep') {
      const last = Number((this._cam(cam) || {}).lastPreset || 0) || 1;
      let next = last + (binding.dir < 0 ? -1 : 1);
      if (next < 1) next = 1;
      if (next > 100) next = 100;
      const g = (this._view().liveGuard) || { mode: 'hold', holdMs: 600 };
      const confirmed = (ev.heldMs || 0) >= (g.holdMs || 600);
      await this._ptz('recall', { cam, preset: next, guarded: !!binding.guarded, confirmed });
      return { camera: cam, text: `PRESET ${next}` };
    }
    if (action === 'ptz.sceneStep') {
      const cur = Number(this._value(cam, 'scene') || 1);
      let next = cur + (binding.dir < 0 ? -1 : 1);
      if (next < 1) next = 1;
      if (next > 4) next = 4;
      if (this._live(cam)) {
        const g = (this._view().liveGuard) || { mode: 'hold', holdMs: 600 };
        if (g.mode === 'lock') throw Object.assign(new Error(`PTZ ${label} is live (red tally): scene recall is locked`), { status: 423 });
        if (g.mode === 'hold' && (ev.heldMs || 0) < g.holdMs) throw Object.assign(new Error(`PTZ ${label} is live (red tally): hold the key ${g.holdMs} ms to recall a scene`), { status: 423 });
      }
      await this._ptz('op', { cam, op: 'scene', value: next });
      return { camera: cam, text: `SCENE ${next}` };
    }
    if (action === 'ptz.copyPaint') {
      const src = cam;
      const dests = this._targets({ target: binding.target || 'pair' }).filter((id) => id !== src);
      if (!dests.length) { this._notice('No other camera in the pair to copy to'); return { text: 'no destination' }; }
      const values = (this._cam(src) || {}).values || {};
      const blocked = dests.filter((id) => this._live(id));
      const ok = dests.filter((id) => !this._live(id));
      if (blocked.length && !ok.length) throw Object.assign(new Error(`COPY refused: ${blocked.map((id) => (this._cam(id) || {}).name || id).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} live (red tally)`), { status: 423 });
      let applied = 0;
      for (const dest of ok) {
        for (const [op, value] of Object.entries(values)) {
          try { await this._ptz('op', { cam: dest, op, value }); applied++; } catch { /* skip unsupported */ }
        }
      }
      if (blocked.length) this._notice(`COPY skipped live camera${blocked.length > 1 ? 's' : ''} ${blocked.map((id) => (this._cam(id) || {}).name || id).join(', ')}`);
      return { camera: src, text: `COPY ${applied}` };
    }
    throw new Error(`Unknown TourBox action "${action}"`);
  }

  async _toggleAutoGain(cam) {
    const cur = String(this._value(cam, 'gain') ?? '');
    const cat = this._op(cam, 'gain');
    const auto = (cat && cat.options || []).find(([, label]) => /^auto$/i.test(String(label).trim()));
    const zero = (cat && cat.options || []).find(([, label]) => /0\s*dB/i.test(String(label)));
    const isAuto = auto && String(auto[0]) === cur;
    const value = isAuto ? (this._lastGain && this._lastGain[cam]) || (zero && zero[0]) || '08' : cur;
    if (!isAuto) {
      this._lastGain = this._lastGain || {};
      this._lastGain[cam] = cur;
    }
    const next = isAuto ? value : (auto ? auto[0] : cur);
    const r = await this._ptz('op', { cam, op: 'gain', value: next });
    return { camera: cam, value: r && r.value, text: this._readout(cam, 'gain'), op: 'gain' };
  }

  _op(cam, opId) {
    try {
      const d = this.systems.driver(this.cfg.instance);
      return d.catalog(cam).ops.find((o) => o.id === opId) || null;
    } catch { return null; }
  }
  _value(cam, opId) {
    const c = this._cam(cam);
    if (c && c.values && c.values[opId] !== undefined) return c.values[opId];
    return undefined;
  }
  _readout(cam, opId) {
    const c = this._cam(cam);
    const ro = c && c.readouts && c.readouts[opId];
    if (ro && ro.text) return ro.text;
    const v = this._value(cam, opId);
    return v == null ? '' : String(v);
  }

  // ---------- API ----------
  status() {
    const v = this._view();
    const sel = this._selectedId();
    const cam = this._cameras().find((c) => c.id === sel) || null;
    const pair = this._msuPair();
    return {
      enabled: this.cfg.enabled,
      started: this.started,
      state: this.hw.state,
      error: this.hw.error,
      device: this.hw.device,
      instance: this.cfg.instance,
      profile: this.cfg.profile,
      profileName: this.profile().name,
      learn: this.cfg.learn,
      gang: this.cfg.gang,
      bank: this.bank,
      dialOp: this.dialOp,
      longPressMs: P.LONG_PRESS_MS,
      camera: sel,
      cameraName: cam ? cam.name : null,
      live: !!(cam && cam.tally),
      locked: !!(cam && cam.locked),
      offline: !!(sel && (!cam || !cam.connected)),
      msu: {
        a: pair.a ? { id: pair.a.id, name: pair.a.name } : null,
        b: pair.b ? { id: pair.b.id, name: pair.b.name } : null,
        index: pair.index,
      },
      lastTouched: this.lastTouched,
      lastNotice: this.lastNotice,
      held: [...this.held],
      model: P.MODEL,
      product: P.PRODUCT_NAME,
      events: this.events.slice(-20),
      cameras: v.cameras ? v.cameras.length : 0,
    };
  }
}

module.exports = { TourBoxService, cleanCfg, EXPOSURE_RESET, DECK_PAGES, DECK_ALIASES, disabledByEnv };
