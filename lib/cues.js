'use strict';
// Hi-res cue stack. One stack, one switcher: RS6, E2 or PixelHue. Not ATEM.
// Absolute recalls the whole look to preview. Relative recalls that same preset
// id and changes only the layers stored in it (RS6) or only the destinations
// stored in it (E2 / PixelHue). Relative is never a step to the next number.
// GO never takes. A follow-up is another preview recall after a delay.
// Bail is armed for the next TAKE; it is not recalled during GO.

const fs = require('fs');
const path = require('path');

const HIRES = new Set(['rs6', 'e2', 'pixelhue']);

const fail = (status, message) => Object.assign(new Error(message), { status });
const idOf = (v) => String(v || '').replace(/[^\w-]/g, '').slice(0, 40);
const ms = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(600000, Math.round(n));
};
const tenth = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(600000, Math.round(n / 100) * 100);
};
const freshId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function inferSystem(cues) {
  for (const cue of cues || []) {
    const bail = cue && cue.bail;
    if (bail && HIRES.has(bail.system)) return bail.system;
    for (const step of (cue && cue.steps) || []) if (HIRES.has(step.system)) return step.system;
  }
  return 'rs6';
}

function cleanFollow(b) {
  if (!b || typeof b !== 'object') return null;
  const preset = b.preset == null ? '' : String(b.preset).trim().slice(0, 40);
  if (!preset) return null;
  return { preset, delayMs: tenth(b.delayMs), mode: b.mode === 'relative' ? 'relative' : 'absolute' };
}

function cleanBail(b, system) {
  if (!b || typeof b !== 'object') return null;
  if (b.system && HIRES.has(b.system) && b.system !== system) return null;
  const preset = b.preset == null ? '' : String(b.preset).trim().slice(0, 40);
  if (!preset) return null;
  return { system, preset };
}

function cleanStep(s, system) {
  if (!s || typeof s !== 'object') return null;
  const stated = String(s.system || '');
  const sys = system && HIRES.has(system) ? system : stated;
  if (!HIRES.has(sys)) return null;
  if (system && stated && stated !== system) return null;
  const preset = s.preset == null ? '' : String(s.preset).trim().slice(0, 40);
  if (!preset || /^[+-]/.test(preset)) return null;
  return {
    id: idOf(s.id) || freshId(),
    system: sys,
    preset,
    mode: s.mode === 'relative' ? 'relative' : 'absolute',
    lagMs: ms(s.lagMs),
    atMs: ms(s.atMs),
    note: String(s.note || '').slice(0, 80),
  };
}

function cleanCue(body, prev, system) {
  const id = idOf(body.id || (prev && prev.id)) || freshId();
  const steps = Array.isArray(body.steps) ? body.steps.map((s) => cleanStep(s, system)).filter(Boolean).slice(0, 64) : ((prev && prev.steps) || []).map((s) => cleanStep(s, system)).filter(Boolean);
  return {
    id,
    name: String(body.name || (prev && prev.name) || 'Cue').slice(0, 60),
    steps,
    advance: body.advance === 'auto' ? 'auto' : (body.advance == null && prev ? prev.advance : 'go'),
    bail: body.bail === undefined && prev ? cleanBail(prev.bail, system) : cleanBail(body.bail, system),
    followUp: body.followUp === undefined && prev ? cleanFollow(prev.followUp) : cleanFollow(body.followUp),
    settleMs: body.settleMs === undefined && prev ? prev.settleMs : ms(body.settleMs),
  };
}

class CueStack {
  constructor({ dataDir, engine = null, systems = null } = {}) {
    this.file = dataDir ? path.join(dataDir, 'cues.json') : null;
    this.engine = engine;
    this.systems = systems;
    this.cues = [];
    this.index = 0;
    this.system = 'rs6';
    this._firing = null;
    this._wake = null;
    this.pendingBail = null;
    this._follows = [];
    this.lastPreset = {};
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.system = HIRES.has(raw.system) ? raw.system : inferSystem(raw.cues);
        this.cues = (raw.cues || []).map((c) => cleanCue(c, null, this.system)).filter((c) => c.id);
        this.index = Math.max(0, Number(raw.index) || 0);
        this.lastPreset = raw.lastPreset && typeof raw.lastPreset === 'object' ? raw.lastPreset : {};
      } catch { this.cues = []; }
    }
    if (this.index >= this.cues.length) this.index = 0;
  }

  write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ system: this.system, cues: this.cues, index: this.index, lastPreset: this.lastPreset }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  connected(system) {
    const sys = system || this.system;
    if (sys === 'rs6') {
      if (this.engine && this.engine.connected) return true;
      try { return !!(this.engine && this.engine.getState && this.engine.getState().connected); } catch { return false; }
    }
    try {
      if (this.systems && this.systems.sim && this.systems.sim[sys]) return true;
      const driver = this.systems && this.systems.drivers && this.systems.drivers[sys];
      if (driver && driver.status) return !!driver.status().connected;
    } catch { /* that system is not on the desk */ }
    return false;
  }

  link() {
    const sys = this.system;
    const connected = this.connected(sys);
    let simulator = false;
    let error = null;
    if (sys === 'rs6') {
      try { error = this.engine && this.engine.lastError; } catch { error = null; }
    } else {
      try {
        simulator = !!(this.systems && this.systems.sim && this.systems.sim[sys]);
        const driver = this.systems && this.systems.drivers && this.systems.drivers[sys];
        error = driver && driver.status ? driver.status().error : null;
      } catch { error = null; }
    }
    return {
      system: sys,
      connected,
      state: connected ? 'connected' : 'offline',
      simulator,
      error: error || null,
      rs6Simulator: false,
      note: sys === 'rs6' ? 'RS6 has no simulator. Connect the live switcher.' : (simulator ? 'Simulator is standing in for the switcher.' : ''),
    };
  }

  catalog() {
    const out = { rs6: [], e2: [], pixelhue: [] };
    try {
      const st = this.engine && this.engine.getState ? this.engine.getState() : null;
      out.rs6 = ((st && st.presets) || []).map((p) => {
        const name = p.name || `Preset ${p.number}`;
        const layers = !!(p.sources && Object.values(p.sources).some((s) => s && Array.isArray(s.layers) && s.layers.length));
        return { id: String(p.number), number: p.number, name, label: `${p.number} ${name}`, layers, bail: (p.bail && p.bail.target) || p.followUpResolved || null };
      });
    } catch { /* RS6 state is optional */ }
    for (const sys of ['e2', 'pixelhue']) {
      try {
        if (!this.systems || !this.systems.view) continue;
        const v = this.systems.view(sys);
        out[sys] = (v.presets || []).map((p) => {
          const number = p.sno || p.number;
          const name = p.name || String(number || p.key);
          return { id: String(p.key || p.tile || p.number), number, name, label: `${number} ${name}`.trim(), layers: false, bail: (p.bail && p.bail.target) || p.followUpResolved || null };
        });
      } catch { /* that system is not on the desk */ }
    }
    return out;
  }

  known(system, preset) {
    return (this.catalog()[system] || []).some((p) => String(p.id) === String(preset));
  }

  annotate(cue) {
    const on = this.connected(this.system);
    const missing = (preset) => on && preset && !this.known(this.system, preset);
    const steps = cue.steps.map((s) => {
      const row = (this.catalog()[this.system] || []).find((p) => String(p.id) === String(s.preset));
      return { ...s, invalid: !!missing(s.preset), label: row ? row.label : s.preset };
    });
    const followUp = cue.followUp ? { ...cue.followUp, invalid: !!missing(cue.followUp.preset) } : null;
    const bail = cue.bail ? { ...cue.bail, invalid: !!missing(cue.bail.preset) } : null;
    const invalid = steps.some((s) => s.invalid) || !!(followUp && followUp.invalid) || !!(bail && bail.invalid);
    return { ...cue, steps, followUp, bail, invalid };
  }

  status() {
    const cues = this.cues.map((c) => this.annotate(c));
    const cue = cues[this.index] || null;
    return {
      system: this.system,
      systems: ['rs6', 'e2', 'pixelhue'],
      cues,
      index: this.index,
      current: cue ? cue.id : null,
      firing: this._firing ? { cue: this._firing.cue, step: this._firing.step, cancelled: !!this._firing.cancelled } : null,
      pendingBail: this.pendingBail ? { system: this.pendingBail.system, preset: this.pendingBail.preset } : null,
      lastPreset: { ...this.lastPreset },
      link: this.link(),
    };
  }

  setSystem(system) {
    const sys = String(system || '');
    if (!HIRES.has(sys)) throw fail(400, 'A cue stack is RS6, E2 or PixelHue');
    this.system = sys;
    for (const cue of this.cues) {
      cue.steps = cue.steps.filter((s) => s.system === sys);
      if (cue.bail && cue.bail.system !== sys) cue.bail = null;
    }
    this.write();
    return this.status();
  }

  save(body = {}) {
    if (body.system && HIRES.has(String(body.system))) this.system = String(body.system);
    if (Array.isArray(body.cues)) {
      this.cues = body.cues.map((c) => cleanCue(c, null, this.system)).filter((c) => c.id);
      if (this.index >= this.cues.length) this.index = Math.max(0, this.cues.length - 1);
      this.write();
      return this.status();
    }
    const onlySystem = body.system && body.id == null && body.name == null && body.steps == null && body.advance == null && body.bail === undefined && body.followUp === undefined;
    if (onlySystem) { this.write(); return this.status(); }
    const prev = this.cues.find((c) => c.id === idOf(body.id));
    const cue = cleanCue(body, prev, this.system);
    const i = this.cues.findIndex((c) => c.id === cue.id);
    if (i >= 0) this.cues[i] = cue;
    else this.cues.push(cue);
    this.write();
    return this.annotate(cue);
  }

  remove(id) {
    const before = this.cues.length;
    this.cues = this.cues.filter((c) => c.id !== id);
    if (this.cues.length === before) throw fail(404, `No cue ${id}`);
    if (this.index >= this.cues.length) this.index = Math.max(0, this.cues.length - 1);
    this.write();
    return this.status();
  }

  reorder(ids) {
    const want = (ids || []).map(idOf).filter(Boolean);
    const by = new Map(this.cues.map((c) => [c.id, c]));
    const next = [];
    for (const id of want) if (by.has(id)) { next.push(by.get(id)); by.delete(id); }
    for (const cue of this.cues) if (by.has(cue.id)) next.push(cue);
    this.cues = next;
    this.write();
    return this.status();
  }

  select(index) {
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0 || n >= this.cues.length) throw fail(400, 'Cue index is out of range');
    this.index = n;
    this.write();
    return this.status();
  }

  async recall(system, preset, mode, { enforce = true } = {}) {
    if (!HIRES.has(system)) throw fail(400, 'Hi-res cues do not recall ATEM');
    if (enforce && system !== this.system) throw fail(400, `This stack only fires ${this.system}`);
    if (system === 'rs6') {
      if (!this.engine) throw fail(409, 'RS6 is not available');
      if (mode === 'relative') {
        if (!this.engine.recallLayers) throw fail(409, 'RS6 relative recall is not available');
        await this.engine.recallLayers(Number(preset));
        return;
      }
      if (!this.engine.recall) throw fail(409, 'RS6 is not available');
      await this.engine.recall(Number(preset), { autoTake: false });
      return;
    }
    if (!this.systems || !this.systems.recall) throw fail(409, `${system} is not available`);
    await this.systems.recall(system, preset, { target: 'preview', autoTake: false });
  }

  sleep(delay) {
    return new Promise((resolve) => {
      if (delay <= 0 || (this._firing && this._firing.cancelled)) return resolve();
      const timer = setTimeout(() => { this._wake = null; resolve(); }, delay);
      this._wake = () => { clearTimeout(timer); this._wake = null; resolve(); };
    });
  }

  clearFollows(owner) {
    this._follows = (this._follows || []).filter((item) => {
      if (owner && item.owner !== owner) return true;
      clearTimeout(item.timer);
      return false;
    });
  }

  clearBail(owner) {
    if (!this.pendingBail) return;
    if (owner && this.pendingBail.owner !== owner) return;
    this.pendingBail = null;
  }

  armFollow(system, followUp, owner) {
    if (!followUp || !followUp.preset) return;
    const delay = tenth(followUp.delayMs);
    const preset = String(followUp.preset);
    const mode = followUp.mode === 'relative' ? 'relative' : 'absolute';
    const item = { owner: owner || 'stack', timer: null };
    item.timer = setTimeout(() => {
      this._follows = this._follows.filter((x) => x !== item);
      this.recall(system, preset, mode, { enforce: false }).catch(() => {});
    }, delay);
    if (item.timer.unref) item.timer.unref();
    this._follows.push(item);
  }

  consumeBail(system) {
    const b = this.pendingBail;
    if (!b || (system && b.system !== system)) return null;
    this.pendingBail = null;
    return { system: b.system, preset: b.preset };
  }

  stop() {
    if (this._firing) this._firing.cancelled = true;
    this.clearFollows();
    this.clearBail();
    if (this._wake) this._wake();
    return this.status();
  }

  back() {
    this.stop();
    if (this.index > 0) this.index -= 1;
    this.write();
    return this.status();
  }

  assertValid(cue) {
    const view = this.annotate(cue);
    if (view.invalid) throw fail(409, 'This cue is invalid. Re-pick the missing preset before GO.');
    return view;
  }

  async firePreset({ system, preset, mode = 'absolute', followUp = null, bail = null, enforce = false, owner = 'master' } = {}) {
    if (!HIRES.has(system)) throw fail(400, 'Not a hi-res switcher');
    if (this.connected(system) && !this.known(system, preset)) throw fail(409, `Preset ${preset} is not on ${system}`);
    await this.recall(system, preset, mode === 'relative' ? 'relative' : 'absolute', { enforce });
    this.lastPreset[system] = String(preset);
    if (followUp && followUp.preset) {
      if (this.connected(system) && !this.known(system, followUp.preset)) throw fail(409, `Follow-up ${followUp.preset} is not on ${system}`);
      this.armFollow(system, followUp, owner);
    }
    if (bail && bail.preset) {
      if (this.connected(system) && !this.known(system, bail.preset)) throw fail(409, `Bail ${bail.preset} is not on ${system}`);
      this.pendingBail = { system, preset: String(bail.preset), owner };
    }
  }

  async go() {
    if (this._firing) return this.status();
    if (!this.cues.length) throw fail(404, 'The cue stack is empty');
    let guard = 0;
    while (guard++ < 64) {
      const cue = this.cues[this.index];
      if (!cue) break;
      this.assertValid(cue);
      this._firing = { cue: cue.id, step: 0, cancelled: false };
      const t0 = Date.now();
      let finishedAt = 0;
      try {
        for (let i = 0; i < cue.steps.length; i++) {
          if (this._firing.cancelled) break;
          const step = cue.steps[i];
          const due = Math.max(step.atMs || 0, finishedAt + (i === 0 ? 0 : (step.lagMs || 0)));
          const wait = due - (Date.now() - t0);
          if (wait > 0) await this.sleep(wait);
          if (this._firing.cancelled) break;
          await this.recall(step.system, step.preset, step.mode);
          this.lastPreset[step.system] = String(step.preset);
          this._firing.step = i + 1;
          finishedAt = Date.now() - t0;
        }
        if (!this._firing.cancelled && cue.followUp && cue.followUp.preset) {
          if (cue.followUp.delayMs) await this.sleep(cue.followUp.delayMs);
          if (!this._firing.cancelled) {
            await this.recall(this.system, cue.followUp.preset, cue.followUp.mode || 'absolute');
            this.lastPreset[this.system] = String(cue.followUp.preset);
          }
        }
        if (!this._firing.cancelled && cue.bail && cue.bail.preset) {
          this.pendingBail = { system: this.system, preset: String(cue.bail.preset), owner: 'stack', cue: cue.id };
        }
        if (!this._firing.cancelled && cue.settleMs) await this.sleep(cue.settleMs);
      } finally {
        const cancelled = !!(this._firing && this._firing.cancelled);
        const auto = !cancelled && cue.advance === 'auto' && this.index < this.cues.length - 1;
        this._firing = null;
        if (auto) this.index += 1;
        this.write();
        if (!auto) break;
      }
    }
    return this.status();
  }
}

module.exports = { CueStack, cleanCue, cleanStep, HIRES, tenth };
