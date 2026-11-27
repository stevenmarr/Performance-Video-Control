'use strict';
// What each ATEM Micro Panel control does, and what every lamp shows, following Blackmagic's own mapping
// (ATEM Software Control with the panel on USB; "Using ATEM Micro Panel" in the ATEM Constellation manual,
// Dec 2024, pp. 93-101), with Control Center as the host on the Raspberry Pi 5. Pure logic: the switcher
// view comes in through view(), commands go out through dispatch(op, body) -> Promise, where op is a
// SystemManager.atem() name and body carries a 1-based `me`. No I/O, so it is tested without a panel or a switcher.
//
// Blackmagic behaviour kept:
//  - PROGRAM row hot-cuts the selected M/E; PREVIEW row selects preview. SHIFT (held) gives 11-20. A blinking
//    key means the shifted source is the one on program / preview. Double-press on PREVIEW = shift-select
//    (not on PROGRAM, as Blackmagic: it would flash the wrong source to air).
//  - MACRO held: the PROGRAM row is macros 1-10 (SHIFT: 11-20), lit blue; the pressed one goes green and stays
//    green while it runs; pressing the green one stops it (or continues it at a user wait).
//  - KEY 1-4 ON cut a key on / off air. BKGD / KEY 1-4: a single press selects only that layer, keys held
//    together are combined, double-press BKGD adds every key that is on air.
//  - MIX / DIP / WIPE / DVE / STING pick the next transition style. PREV TRANS toggles transition preview.
//  - CUT, AUTO (red while the M/E transitions), the T-bar with its 16-LED progress meter.
//  - DSK 1/2 TIE, CUT (lit on air), AUTO (red while it mixes).
//  - M/E 1-4 choose which M/E the whole panel drives, and that selection is shared with the Stream Deck.
// Control Center additions: refused presses flash red and say why (log / status), the console LOCK is
// honoured, the T-bar picks up only from an end, per-key remaps (settings.overrides), buttons 1-20 are
// mappable, unlit keys glow white, and ARM gangs CUT / AUTO / T-bar across every M/E.

const P = require('./protocol');

const STYLE_KEYS = { 'transition-mix': 'MIX', 'transition-dip': 'DIP', 'transition-wipe': 'WIPE', 'transition-dve': 'DVE', 'transition-sting': 'STING' };
const NEXT_KEYS = { 'next-background': 0, 'next-key1': 1, 'next-key2': 2, 'next-key3': 3, 'next-key4': 4 };
const END = 0.015; // T-bar "at the end" (1.5 % of travel)
const DEFAULTS = Object.freeze({
  me: 1,
  sources: null,        // 20 source ids for buttons 1-20 (SHIFT = 11-20); null = ATEM inputs 1..20
  programRow: 'hot',    // 'hot' (Blackmagic) | 'off' (tally only, presses refused)
  idle: 'white',        // lamp for an available key that is not selected: 'white' (default, "dim white") | 'off' | 'blue'
                        // The panel has no brightness levels (8 solid colours only), so white is the dim-white stand-in.
  tbarInvert: false,    // the T-bar reports 0 at the top instead of the bottom
  tbarLedReverse: false, // meter segment 0 is at the other end
  doubleMs: 350,
  overrides: {},        // { keyId: { op, args } | { none: true } }
});

function clean(s = {}) {
  const o = { ...DEFAULTS, ...(s || {}) };
  o.me = Math.max(1, Math.min(4, Math.round(Number(o.me) || 1)));
  o.programRow = o.programRow === 'off' ? 'off' : 'hot';
  o.idle = ['off', 'white', 'blue'].includes(o.idle) ? o.idle : 'white';
  o.tbarInvert = !!o.tbarInvert; o.tbarLedReverse = !!o.tbarLedReverse;
  o.doubleMs = Math.max(150, Math.min(800, Number(o.doubleMs) || 350));
  o.sources = Array.isArray(o.sources) ? Array.from({ length: 20 }, (_, i) => (o.sources[i] === null || o.sources[i] === undefined || o.sources[i] === '' ? null : Number(o.sources[i]))) : null;
  const ov = {};
  for (const [k, v] of Object.entries(o.overrides || {})) {
    if (!P.BY_ID.has(k) || !v || typeof v !== 'object') continue;
    if (v.none) ov[k] = { none: true };
    else if (typeof v.op === 'string' && /^\w{1,40}$/.test(v.op)) ov[k] = { op: v.op, args: v.args && typeof v.args === 'object' ? { ...v.args } : {}, label: String(v.label || '').slice(0, 24) };
  }
  o.overrides = ov;
  delete o.arm; // FTB-on-ARM options were removed; ARM is the all-M/E gang latch
  return o;
}

class AtemPanelEmulation {
  constructor({ dispatch, view, locked = () => false, now = () => Date.now(), timers = { setTimeout, clearTimeout }, onEvent = () => {}, settings = {} } = {}) {
    this.dispatch = dispatch; this.view = view; this.locked = locked; this.now = now; this.timers = timers; this.onEvent = onEvent;
    this.settings = clean(settings);
    this.meSel = this.settings.me;
    this.armed = false;      // ARM latch: CUT, AUTO and the T-bar fire every M/E
    this.held = new Set();
    this.lastDown = { key: null, at: 0 };
    this.flash = {};          // key -> until (ms): refused press
    this.pressedMacro = null; // program-row key held while MACRO is held
    this.tb = { engaged: true, flipped: false, raw: null, lastSent: null, lastSentAt: 0, pending: null, timer: null };
  }

  setSettings(s) { this.settings = clean({ ...this.settings, ...s }); if (s && s.me !== undefined) this.selectMe(Math.min(this.settings.me, this._meCount())); }

  // ---------- state helpers ----------
  _v() { const v = this.view(); return v && v.connected !== false && v.view ? v.view : null; }
  _meCount(v = this._v()) { return Math.max(1, (v && v.mes && v.mes.length) || (v && v.topology && v.topology.mixEffects) || 1); }
  _me(v = this._v()) { const i = Math.min(this.meSel, this._meCount(v)) - 1; return (v && v.mes && v.mes[i]) || null; }
  get me() { return Math.min(this.meSel, this._meCount()); }
  _targets(v = this._v()) {
    const n = this._meCount(v);
    return this.armed ? Array.from({ length: n }, (_, i) => i + 1) : [this.me];
  }
  _sources(v = this._v()) {
    if (this.settings.sources) return this.settings.sources;
    const ids = v ? (v.inputs || []).map((i) => i.id).filter((id) => id >= 1 && id <= 40).sort((a, b) => a - b) : [];
    return Array.from({ length: 20 }, (_, i) => (ids.includes(i + 1) ? i + 1 : null)); // button n = input n, as Blackmagic's default map
  }
  _onBus(me, src) { return !!(me && src !== null && src !== undefined && (me.bus || []).some((b) => b.id === src)); }
  _shift() { return this.held.has('shift'); }

  // ---------- input ----------
  down(key) {
    const at = this.now();
    const dbl = this.lastDown.key === key && at - this.lastDown.at <= this.settings.doubleMs;
    this.lastDown = { key, at: dbl ? 0 : at }; // a third press is a new first press
    this.held.add(key);
    this.onEvent({ kind: 'press', key });
    try { this._press(key, dbl); } catch (e) { this._refuse(key, e.message); }
  }

  up(key) {
    this.held.delete(key);
    this.onEvent({ kind: 'release', key });
    if (key === 'macro') this.pressedMacro = null;
    if (this.pressedMacro === key) this.pressedMacro = null;
  }

  _send(key, op, body = {}) {
    const b = { me: this.me, ...body };
    this.onEvent({ kind: 'send', key, op, body: b });
    let p;
    try { p = Promise.resolve(this.dispatch(op, b)); } catch (e) { p = Promise.reject(e); }
    return p.then((r) => { if (r && r.ok === false) this._refuse(key, r.reason || r.error || 'refused'); return r; }, (e) => { this._refuse(key, e.message); return { ok: false, reason: e.message }; });
  }

  // CUT, AUTO and the T-bar: one command per targeted M/E. Failures on one M/E do not cancel the others;
  // any refusal is reported with the M/E named (DVE budget, LOCK already applied before we get here).
  _sendMany(key, op, body = {}) {
    const mes = this._targets();
    const jobs = mes.map((me) => {
      const b = { ...body, me };
      this.onEvent({ kind: 'send', key, op, body: b });
      let p;
      try { p = Promise.resolve(this.dispatch(op, b)); } catch (e) { p = Promise.reject(e); }
      return p.then((r) => ({ me, r: r || { ok: true } }), (e) => ({ me, r: { ok: false, reason: e.message } }));
    });
    return Promise.all(jobs).then((rows) => {
      const failed = rows.filter((x) => x.r && x.r.ok === false);
      if (failed.length) {
        const reason = failed.map((f) => `M/E ${f.me}: ${f.r.reason || f.r.error || 'refused'}`).join('; ');
        this._refuse(key, reason);
      }
      return rows;
    });
  }

  _refuse(key, reason) {
    this.flash[key] = this.now() + 900;
    this.onEvent({ kind: 'refused', key, reason: String(reason || 'refused') });
  }

  _press(key, dbl) {
    if (key === 'shift') return;
    if (/^mixeffect\d$/.test(key)) return this.selectMe(Number(key.slice(-1)), key);
    const lock = this.locked();
    if (lock) return this._refuse(key, typeof lock === 'string' ? lock : 'Control Center is locked (CONSOLE LOCK)');
    const v = this._v();
    if (!v) return this._refuse(key, 'ATEM not connected');
    const me = this._me(v);
    const ov = this.settings.overrides[key];
    if (ov) { if (ov.none) return this._refuse(key, 'this key is turned off in the panel map'); return this._send(key, ov.op, ov.args); }
    const shift = this._shift();
    let m;
    if (key === 'macro') return;
    if ((m = /^program(\d+)$/.exec(key))) {
      const n = Number(m[1]);
      if (this.held.has('macro')) return this._macro(key, n + (shift ? 10 : 0), v);
      if (this.settings.programRow === 'off') return this._refuse(key, 'the PROGRAM row is tally only (panel setting)');
      const src = this._sources(v)[n - 1 + (shift ? 10 : 0)];
      if (!this._onBus(me, src)) return this._refuse(key, `no source on button ${n + (shift ? 10 : 0)} for M/E ${this.me}`);
      return this._send(key, 'program', { source: src });
    }
    if ((m = /^preview(\d+)$/.exec(key))) {
      const n = Number(m[1]);
      const idx = n - 1 + (shift || dbl ? 10 : 0);
      const src = this._sources(v)[idx];
      if (!this._onBus(me, src)) return this._refuse(key, `no source on button ${idx + 1} for M/E ${this.me}`);
      return this._send(key, 'preview', { source: src });
    }
    if ((m = /^key(\d)-on$/.exec(key))) {
      const k = Number(m[1]) - 1; const kv = (me.keyers || [])[k];
      if (!kv) return this._refuse(key, `M/E ${this.me} has no key ${k + 1}`);
      return this._send(key, 'uskOnAir', { key: k, on: !kv.onAir });
    }
    if (key in NEXT_KEYS) return this._next(key, dbl, me);
    if (key in STYLE_KEYS) return this._send(key, 'style', { style: STYLE_KEYS[key] });
    if (key === 'preview-transition') return this._send(key, 'previewTransition', { on: !me.previewTransition });
    if (key === 'cut') return this._sendMany(key, 'cut');
    if (key === 'auto') return this._sendMany(key, 'auto');
    if (key === 'transition-arm') return this.setArmed(!this.armed);
    if ((m = /^dsk(\d)-(tie|cut|auto)$/.exec(key))) {
      const count = (v.dsk || []).length;
      const k = Number(m[1]) - 1 + (shift && count > 2 ? 2 : 0);
      const d = (v.dsk || [])[k];
      if (!d) return this._refuse(key, `this switcher has no DSK ${k + 1}`);
      if (m[2] === 'tie') return this._send(key, 'dskTie', { key: k, on: !d.tie });
      if (m[2] === 'cut') return this._send(key, 'dskOnAir', { key: k, on: !d.onAir });
      return this._send(key, 'dskAuto', { key: k });
    }
    return this._refuse(key, 'not mapped');
  }

  _macro(key, slot, v) {
    const idx = slot - 1;
    const run = v.macroRun || {};
    this.pressedMacro = key;
    if (run.isRunning && run.macroIndex === idx) return run.isWaiting ? this._send(key, 'macroContinue') : this._send(key, 'macroStop');
    if (!(v.macros || []).some((x) => x.index === idx)) return this._refuse(key, `macro ${slot} is empty`);
    return this._send(key, 'macroRun', { macro: idx });
  }

  _next(key, dbl, me) {
    let sel = 0;
    if (key === 'next-background' && dbl) {
      sel = 1; (me.keyers || []).forEach((k, i) => { if (k.onAir) sel |= 1 << (i + 1); });
    } else {
      for (const k of Object.keys(NEXT_KEYS)) if (this.held.has(k)) sel |= 1 << NEXT_KEYS[k];
    }
    const keyCount = (me.keyers || []).length;
    sel &= (1 << (keyCount + 1)) - 1;
    if (!sel) return this._refuse(key, `M/E ${this.me} has no key ${NEXT_KEYS[key]}`);
    return this._send(key, 'nextSelection', { selection: sel });
  }

  selectMe(n, key = `mixeffect${n}`) {
    const count = this._meCount();
    if (n > count) return this._refuse(key, `this switcher has ${count} M/E${count > 1 ? 's' : ''}`);
    if (n === this.meSel) return;
    this.meSel = n;
    this.onEvent({ kind: 'me', me: n });
    this._tbarResync();
  }

  setArmed(on) {
    const next = !!on;
    if (next === this.armed) return;
    this.armed = next;
    this.onEvent({ kind: 'arm', armed: next });
  }

  // ---------- T-bar ----------
  // The raw bar position is v (0..1). A stroke runs from the end the bar starts at (pos 0) to the other end
  // (pos 1 = handle 10000 = done); the next stroke runs back. While the switcher's transition and the bar
  // disagree (an AUTO or CUT mid-stroke, an M/E change, someone else's fader), the bar is ignored until it
  // is parked at either end, which becomes the new start. When ARM is lit, the same handle is sent to every M/E.
  tbar(value) {
    const v = this.settings.tbarInvert ? 1 - value : value;
    this.tb.raw = v;
    const t = this.tb;
    let pos = t.flipped ? 1 - v : v;
    if (!t.engaged) {
      if (pos <= END) t.engaged = true;
      else if (pos >= 1 - END) { t.flipped = !t.flipped; t.engaged = true; pos = 1 - pos; }
      else return;
      this.onEvent({ kind: 'tbar', detail: 'picked up' });
      t.lastSent = 0;
      return;
    }
    const handle = pos >= 1 - END ? 10000 : pos <= END ? 0 : Math.round(pos * 10000);
    if (handle === t.lastSent) return;
    if (t.lastSent === null && handle === 0) { t.lastSent = 0; return; } // the bar resting at its start: nothing to send
    if (this.locked() || !this._v()) { if (handle === 10000 || handle === 0) t.lastSent = handle; return this._refuse('auto', this.locked() ? 'Control Center is locked' : 'ATEM not connected'); }
    if (handle === 10000) { this._tbarFlush(); t.flipped = !t.flipped; t.lastSent = 0; t.lastSentAt = this.now(); this._sendMany('auto', 'transitionPosition', { handle: 10000 }); return; }
    if (handle === 0 || this.now() - t.lastSentAt >= 15) { this._tbarFlush(); t.lastSent = handle; t.lastSentAt = this.now(); this._sendMany('auto', 'transitionPosition', { handle }); return; }
    t.pending = handle; t.lastSent = handle;
    if (!t.timer) { t.timer = this.timers.setTimeout(() => { t.timer = null; if (t.pending === null) return; const h = t.pending; t.pending = null; t.lastSentAt = this.now(); this._sendMany('auto', 'transitionPosition', { handle: h }); }, 15); if (t.timer && t.timer.unref) t.timer.unref(); }
  }
  _tbarFlush() { const t = this.tb; if (t.timer) { this.timers.clearTimeout(t.timer); t.timer = null; } t.pending = null; }

  _tbarResync() {
    const t = this.tb; if (t.raw === null) return;
    if (t.raw <= END) { t.flipped = false; t.engaged = true; t.lastSent = 0; }
    else if (t.raw >= 1 - END) { t.flipped = true; t.engaged = true; t.lastSent = 0; }
    else { t.engaged = false; this.onEvent({ kind: 'tbar', detail: 'park the T-bar at either end to pick up' }); }
  }

  // Called on every switcher state change: a transition finished or moved without the bar drops the bar.
  // When ARM is lit, any targeted M/E disagreeing with the bar is enough to drop it.
  sync() {
    const v = this._v(); const t = this.tb;
    if (!v || !t.engaged || t.lastSent === null) return;
    const quiet = this.now() - t.lastSentAt > 400;
    if (!quiet) return;
    const mes = this._targets(v).map((n) => (v.mes || [])[n - 1]).filter(Boolean);
    if (!mes.length) return;
    if (t.lastSent > 0 && t.lastSent < 10000 && mes.some((me) => !me.inTransition)) {
      t.engaged = false; t.lastSent = 0; this.onEvent({ kind: 'tbar', detail: 'transition finished elsewhere; park the T-bar at either end' });
    } else if (mes.some((me) => me.inTransition && Math.abs((me.handle || 0) - t.lastSent) > 600)) {
      t.engaged = false; this.onEvent({ kind: 'tbar', detail: 'another fader moved this M/E; park the T-bar at either end' });
    }
  }

  // ---------- lamps ----------
  frame(blinkOn = true) {
    const keys = {}; const now = this.now();
    for (const k of P.KEYS) keys[k.id] = 'off';
    const v = this._v(); const count = this._meCount(v); const sel = Math.min(this.meSel, count);
    const lock = !!this.locked();
    const idle = this.settings.idle;
    for (let n = 1; n <= 4; n++) keys[`mixeffect${n}`] = n === sel ? (!v || lock ? (blinkOn ? (lock ? 'red' : 'white') : 'off') : 'yellow') : n <= count && v ? (idle === 'off' ? 'white' : idle) : 'off';
    const tbar = new Array(P.TBAR_SEGMENTS).fill(false);
    if (!v) return { keys: this._flashes(keys, now, blinkOn), tbar };
    const me = this._me(v) || {};
    const shift = this._shift(); const srcs = this._sources(v);
    const row = (prefix, on, colour) => {
      for (let n = 1; n <= 10; n++) {
        const base = srcs[n - 1]; const up = srcs[n + 9];
        const shown = shift ? up : base;
        let c = this._onBus(me, shown) ? idle : 'off';
        if (shown !== null && shown !== undefined && on === shown) c = colour;
        else if (!shift && up !== null && up !== undefined && on === up) c = blinkOn ? colour : 'off';
        keys[`${prefix}${n}`] = c;
      }
    };
    if (this.held.has('macro')) {
      const run = v.macroRun || {};
      for (let n = 1; n <= 10; n++) {
        const idx = n - 1 + (shift ? 10 : 0); const used = (v.macros || []).some((x) => x.index === idx);
        let c = 'blue';
        if (run.isRunning && run.macroIndex === idx) c = run.isWaiting ? (blinkOn ? 'green' : 'off') : 'green';
        else if (this.pressedMacro === `program${n}` && used) c = 'green';
        keys[`program${n}`] = c;
      }
    } else row('program', me.program, 'red');
    row('preview', me.preview, 'green');
    const run = v.macroRun || {};
    keys.macro = this.held.has('macro') ? 'yellow' : run.isRunning ? (run.isWaiting ? (blinkOn ? 'green' : 'off') : 'green') : idle;
    keys.shift = shift ? 'yellow' : idle;
    (me.keyers || []).slice(0, 4).forEach((k, i) => { keys[`key${i + 1}-on`] = k.onAir ? 'red' : idle; });
    const ns = me.nextSelection || 1; const kc = (me.keyers || []).length;
    for (const [id, bit] of Object.entries(NEXT_KEYS)) keys[id] = bit > kc ? 'off' : ns & (1 << bit) ? 'yellow' : idle;
    const next = String(me.nextStyle || me.style || '').toUpperCase();
    for (const [id, st] of Object.entries(STYLE_KEYS)) keys[id] = next === st ? 'yellow' : idle;
    keys['preview-transition'] = me.previewTransition ? 'yellow' : idle;
    keys.cut = 'white';
    const autoLive = this._targets(v).some((n) => { const m = (v.mes || [])[n - 1]; return m && m.inTransition; });
    keys.auto = autoLive ? 'red' : 'white';
    keys['transition-arm'] = this.armed ? (blinkOn ? 'red' : 'off') : idle;
    const dsk = v.dsk || []; const dOff = shift && dsk.length > 2 ? 2 : 0;
    for (let n = 1; n <= 2; n++) {
      const d = dsk[n - 1 + dOff];
      if (!d) continue;
      keys[`dsk${n}-tie`] = d.tie ? 'yellow' : idle;
      keys[`dsk${n}-cut`] = d.onAir ? 'red' : idle;
      keys[`dsk${n}-auto`] = d.inTransition ? 'red' : 'white';
    }
    for (const [id, ov] of Object.entries(this.settings.overrides)) keys[id] = ov.none ? 'off' : 'white';
    // T-bar meter: progress from the end the stroke started at; all segments blink while the bar waits to be parked
    const t = this.tb;
    if (!t.engaged) tbar.fill(blinkOn);
    else if (autoLive || me.inTransition) {
      const handle = this.armed
        ? Math.max(...this._targets(v).map((n) => ((v.mes || [])[n - 1] || {}).handle || 0), me.handle || 0)
        : (me.handle || 0);
      const k = Math.max(1, Math.round((handle / 10000) * P.TBAR_SEGMENTS));
      const fromZero = !t.flipped; // the stroke started at the raw-0 end
      for (let i = 0; i < k && i < P.TBAR_SEGMENTS; i++) tbar[fromZero ? i : P.TBAR_SEGMENTS - 1 - i] = true;
    }
    if (this.settings.tbarLedReverse) tbar.reverse();
    return { keys: this._flashes(keys, now, blinkOn), tbar };
  }

  _flashes(keys, now, blinkOn) {
    for (const [k, until] of Object.entries(this.flash)) { if (until < now) delete this.flash[k]; else keys[k] = blinkOn ? 'red' : 'off'; }
    return keys;
  }

  status() { return { me: this.me, armed: this.armed, held: [...this.held], tbar: { engaged: this.tb.engaged, flipped: this.tb.flipped, position: this.tb.raw }, settings: this.settings }; }
}

module.exports = { AtemPanelEmulation, clean, DEFAULTS, STYLE_KEYS, NEXT_KEYS };
