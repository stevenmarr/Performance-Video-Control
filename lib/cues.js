'use strict';
// Hi-res cue stack. RS6, E2 and PixelHue only. A cue is an ordered list of
// preset recalls. Absolute recalls that preset. Relative recalls are an offset
// from the last preset this stack put on that system. lagMs holds a step so it
// can trail the one before it. atMs is a time from GO. Bail-to recalls one more
// preset after the cue settles. Advance is operator GO unless the cue is auto.

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
const freshId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function cleanBail(b) {
  if (!b || typeof b !== 'object') return null;
  const system = String(b.system || '');
  const preset = b.preset == null ? '' : String(b.preset).slice(0, 40);
  if (!HIRES.has(system) || !preset) return null;
  return { system, preset };
}

function cleanStep(s) {
  if (!s || typeof s !== 'object') return null;
  const system = String(s.system || '');
  if (!HIRES.has(system)) return null;
  const preset = s.preset == null ? '' : String(s.preset).trim().slice(0, 40);
  if (!preset) return null;
  return {
    id: idOf(s.id) || freshId(),
    system,
    preset,
    mode: s.mode === 'relative' ? 'relative' : 'absolute',
    lagMs: ms(s.lagMs),
    atMs: ms(s.atMs),
    note: String(s.note || '').slice(0, 80),
  };
}

function cleanCue(body, prev) {
  const id = idOf(body.id || (prev && prev.id)) || freshId();
  const steps = Array.isArray(body.steps) ? body.steps.map(cleanStep).filter(Boolean).slice(0, 64) : ((prev && prev.steps) || []);
  return {
    id,
    name: String(body.name || (prev && prev.name) || 'Cue').slice(0, 60),
    steps,
    advance: body.advance === 'auto' ? 'auto' : 'go',
    bail: body.bail === undefined && prev ? prev.bail : cleanBail(body.bail),
    settleMs: body.settleMs === undefined && prev ? prev.settleMs : ms(body.settleMs),
  };
}

function offsetPreset(current, delta) {
  const text = String(delta).trim();
  const signed = /^[+-]/.test(text) ? text : `+${text}`;
  const amount = Number(signed);
  if (!Number.isFinite(amount)) throw fail(400, `Relative offset "${delta}" is not a number`);
  const base = String(current);
  const m = base.match(/^(.*?)(\d+)$/);
  if (!m) throw fail(400, `Cannot offset preset "${current}"`);
  const n = Number(m[2]) + amount;
  if (n < 1) throw fail(400, `Relative recall landed before preset 1`);
  return `${m[1]}${n}`;
}

class CueStack {
  constructor({ dataDir, engine = null, systems = null } = {}) {
    this.file = dataDir ? path.join(dataDir, 'cues.json') : null;
    this.engine = engine;
    this.systems = systems;
    this.cues = [];
    this.index = 0;
    this._firing = null;
    this._wake = null;
    this.lastPreset = {};
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.cues = (raw.cues || []).map((c) => cleanCue(c)).filter((c) => c.id);
        this.index = Math.max(0, Number(raw.index) || 0);
        this.lastPreset = raw.lastPreset && typeof raw.lastPreset === 'object' ? raw.lastPreset : {};
      } catch { this.cues = []; }
    }
    if (this.index >= this.cues.length) this.index = 0;
  }

  write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cues: this.cues, index: this.index, lastPreset: this.lastPreset }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  status() {
    const cue = this.cues[this.index] || null;
    return {
      cues: this.cues.map((c) => ({ ...c, steps: c.steps.map((s) => ({ ...s })), bail: c.bail ? { ...c.bail } : null })),
      index: this.index,
      current: cue ? cue.id : null,
      firing: this._firing ? { cue: this._firing.cue, step: this._firing.step, cancelled: !!this._firing.cancelled } : null,
      lastPreset: { ...this.lastPreset },
      systems: ['rs6', 'e2', 'pixelhue'],
    };
  }

  save(body = {}) {
    if (Array.isArray(body.cues)) {
      this.cues = body.cues.map((c) => cleanCue(c)).filter((c) => c.steps || c.name);
      if (this.index >= this.cues.length) this.index = Math.max(0, this.cues.length - 1);
      this.write();
      return this.status();
    }
    const prev = this.cues.find((c) => c.id === idOf(body.id));
    const cue = cleanCue(body, prev);
    const i = this.cues.findIndex((c) => c.id === cue.id);
    if (i >= 0) this.cues[i] = cue;
    else this.cues.push(cue);
    this.write();
    return cue;
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

  async recall(system, preset) {
    if (!HIRES.has(system)) throw fail(400, 'Hi-res cues do not recall ATEM');
    if (system === 'rs6') {
      if (!this.engine || !this.engine.recall) throw fail(409, 'RS6 is not available');
      await this.engine.recall(Number(preset));
      return;
    }
    if (!this.systems || !this.systems.recall) throw fail(409, `${system} is not available`);
    await this.systems.recall(system, preset, { target: 'preview' });
  }

  resolve(step) {
    if (step.mode !== 'relative') return String(step.preset);
    const current = this.lastPreset[step.system];
    if (current == null || current === '') throw fail(400, `Relative step on ${step.system} has no preset to offset`);
    return offsetPreset(current, step.preset);
  }

  sleep(delay) {
    return new Promise((resolve) => {
      if (delay <= 0 || (this._firing && this._firing.cancelled)) return resolve();
      const timer = setTimeout(() => { this._wake = null; resolve(); }, delay);
      this._wake = () => { clearTimeout(timer); this._wake = null; resolve(); };
    });
  }

  stop() {
    if (this._firing) this._firing.cancelled = true;
    if (this._wake) this._wake();
    return this.status();
  }

  async go() {
    if (this._firing) return this.status();
    if (!this.cues.length) throw fail(404, 'The cue stack is empty');
    let guard = 0;
    while (guard++ < 64) {
      const cue = this.cues[this.index];
      if (!cue) break;
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
          const preset = this.resolve(step);
          await this.recall(step.system, preset);
          this.lastPreset[step.system] = preset;
          this._firing.step = i + 1;
          finishedAt = Date.now() - t0;
        }
        if (!this._firing.cancelled && cue.bail) {
          await this.recall(cue.bail.system, cue.bail.preset);
          this.lastPreset[cue.bail.system] = String(cue.bail.preset);
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

  catalog() {
    const out = { rs6: [], e2: [], pixelhue: [] };
    try {
      const st = this.engine && this.engine.getState ? this.engine.getState() : null;
      out.rs6 = ((st && st.presets) || []).map((p) => ({ id: String(p.number), name: p.name || `Preset ${p.number}`, bail: (p.bail && p.bail.target) || p.followUpResolved || null }));
    } catch { /* RS6 state is optional */ }
    for (const sys of ['e2', 'pixelhue']) {
      try {
        if (!this.systems || !this.systems.view) continue;
        const v = this.systems.view(sys);
        out[sys] = (v.presets || []).map((p) => ({ id: String(p.key || p.tile || p.number), name: p.name || p.sno || String(p.number), bail: (p.bail && p.bail.target) || p.followUpResolved || null }));
      } catch { /* that system is not on the desk */ }
    }
    return out;
  }
}

module.exports = { CueStack, cleanCue, cleanStep, offsetPreset, HIRES };
