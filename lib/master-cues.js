'use strict';
// Master cues. One click fires hi-res preset recalls, ATEM macros and PTZ
// recalls, each at an offset from the click. Hi-res actions use the cue stack's
// preview / relative / follow-up / bail path. STOP cancels anything still waiting.

const fs = require('fs');
const path = require('path');

const fail = (status, message) => Object.assign(new Error(message), { status });
const idOf = (v) => String(v || '').replace(/[^\w-]/g, '').slice(0, 40);
const tenth = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(600000, Math.round(n / 100) * 100);
};
const freshId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HIRES = new Set(['rs6', 'e2', 'pixelhue']);

function cleanFollow(b) {
  if (!b || typeof b !== 'object') return null;
  const preset = b.preset == null ? '' : String(b.preset).trim().slice(0, 40);
  if (!preset) return null;
  return { preset, delayMs: tenth(b.delayMs), mode: b.mode === 'relative' ? 'relative' : 'absolute' };
}

function cleanAction(a) {
  if (!a || typeof a !== 'object') return null;
  const type = a.type === 'atem-macro' || a.type === 'ptz' ? a.type : (a.type === 'hires' ? 'hires' : '');
  if (!type) return null;
  const base = { id: idOf(a.id) || freshId(), type, offsetMs: tenth(a.offsetMs) };
  if (type === 'hires') {
    const system = String(a.system || '');
    const preset = a.preset == null ? '' : String(a.preset).trim().slice(0, 40);
    if (!HIRES.has(system) || !preset) return null;
    const bailPreset = a.bail && a.bail.preset != null ? String(a.bail.preset).trim().slice(0, 40) : '';
    return { ...base, system, preset, mode: a.mode === 'relative' ? 'relative' : 'absolute', followUp: cleanFollow(a.followUp), bail: bailPreset ? { preset: bailPreset } : null };
  }
  if (type === 'atem-macro') {
    const macro = Number(a.macro);
    if (!Number.isInteger(macro) || macro < 0 || macro > 99) return null;
    return { ...base, macro };
  }
  const camera = idOf(a.camera);
  const preset = Number(a.preset);
  if (!camera || !Number.isInteger(preset) || preset < 1 || preset > 100) return null;
  return { ...base, camera, preset };
}

function cleanCue(body, prev) {
  const id = idOf(body.id || (prev && prev.id)) || freshId();
  const actions = Array.isArray(body.actions) ? body.actions.map(cleanAction).filter(Boolean).slice(0, 64) : ((prev && prev.actions) || []);
  return { id, name: String(body.name || (prev && prev.name) || 'Cue').slice(0, 60), actions };
}

function seed() {
  return Array.from({ length: 8 }, (_, i) => ({ id: `mc${i + 1}`, name: `Cue ${i + 1}`, actions: [] }));
}

class MasterCues {
  constructor({ dataDir, cues = null, systems = null, atemDesk = null } = {}) {
    this.file = dataDir ? path.join(dataDir, 'master-cues.json') : null;
    this.cues = cues;
    this.systems = systems;
    this.atemDesk = atemDesk;
    this.list = [];
    this._run = null;
    this._timers = [];
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.list = (raw.cues || []).map((c) => cleanCue(c)).filter((c) => c.id);
      } catch { this.list = []; }
    } else this.list = seed();
    if (!this.list.length && this.file && !fs.existsSync(this.file)) this.list = seed();
    if (this.file && !fs.existsSync(this.file)) this.write();
  }

  write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cues: this.list }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  palette() {
    const groups = [];
    const cat = this.cues && this.cues.catalog ? this.cues.catalog() : { rs6: [], e2: [], pixelhue: [] };
    for (const [device, label] of [['rs6', 'RS6'], ['e2', 'E2'], ['pixelhue', 'PIXELHUE']]) {
      groups.push({
        device, label,
        items: (cat[device] || []).map((p) => ({ type: 'hires', system: device, preset: p.id, label: p.label || `${p.number} ${p.name}`, number: p.number, name: p.name })),
      });
    }
    let macros = [];
    try { macros = (this.atemDesk && this.atemDesk.view ? this.atemDesk.view().macros : []) || []; } catch { macros = []; }
    groups.push({
      device: 'atem', label: 'ATEM',
      items: macros.map((m) => ({ type: 'atem-macro', macro: m.index, label: `${m.index + 1} ${m.name}`, name: m.name })),
    });
    let cameras = [];
    try {
      const view = this.systems && this.systems.view ? this.systems.view('ptz') : null;
      cameras = (view && view.cameras) || [];
    } catch { cameras = []; }
    const ptz = [];
    for (const cam of cameras) {
      for (let n = 1; n <= 8; n++) ptz.push({ type: 'ptz', camera: cam.id, preset: n, label: `${cam.name || cam.id} ${n}`, name: cam.name || cam.id });
    }
    groups.push({ device: 'ptz', label: 'PTZ', items: ptz });
    return groups;
  }

  actionInvalid(a) {
    if (!a) return false;
    if (a.type === 'hires') {
      if (!this.cues || !this.cues.connected || !this.cues.connected(a.system)) return false;
      return !this.cues.known(a.system, a.preset) || !!(a.followUp && a.followUp.preset && !this.cues.known(a.system, a.followUp.preset)) || !!(a.bail && a.bail.preset && !this.cues.known(a.system, a.bail.preset));
    }
    if (a.type === 'atem-macro') {
      let macros = [];
      try { macros = (this.atemDesk && this.atemDesk.view ? this.atemDesk.view().macros : []) || []; } catch { return false; }
      if (!macros.length) return false;
      return !macros.some((m) => m.index === a.macro);
    }
    if (a.type === 'ptz') {
      let cameras = [];
      try {
        const view = this.systems && this.systems.view ? this.systems.view('ptz') : null;
        cameras = (view && view.cameras) || [];
      } catch { return false; }
      if (!cameras.length) return false;
      return !cameras.some((c) => c.id === a.camera);
    }
    return false;
  }

  viewCue(cue) {
    const progress = this._run && this._run.id === cue.id ? this._run.actions : null;
    const actions = cue.actions.map((a) => ({ ...a, invalid: this.actionInvalid(a), state: progress ? (progress[a.id] || 'pending') : 'idle' }));
    return { ...cue, actions, invalid: actions.some((a) => a.invalid) };
  }

  status() {
    return {
      cues: this.list.map((c) => this.viewCue(c)),
      palette: this.palette(),
      running: this._run ? { id: this._run.id, actions: { ...this._run.actions } } : null,
    };
  }

  save(body = {}) {
    if (Array.isArray(body.cues)) {
      this.list = body.cues.map((c) => cleanCue(c)).filter((c) => c.id);
      this.write();
      return this.status();
    }
    const prev = this.list.find((c) => c.id === idOf(body.id));
    const cue = cleanCue(body, prev);
    const i = this.list.findIndex((c) => c.id === cue.id);
    if (i >= 0) this.list[i] = cue;
    else this.list.push(cue);
    this.write();
    return this.viewCue(cue);
  }

  reorder(ids) {
    const want = (ids || []).map(idOf).filter(Boolean);
    const by = new Map(this.list.map((c) => [c.id, c]));
    const next = [];
    for (const id of want) if (by.has(id)) { next.push(by.get(id)); by.delete(id); }
    for (const cue of this.list) if (by.has(cue.id)) next.push(cue);
    this.list = next;
    this.write();
    return this.status();
  }

  duplicate(id) {
    const src = this.list.find((c) => c.id === id);
    if (!src) throw fail(404, `No cue ${id}`);
    const copy = cleanCue({ name: `${src.name} copy`, actions: src.actions.map((a) => ({ ...a, id: '' })) });
    this.list.push(copy);
    this.write();
    return this.viewCue(copy);
  }

  clear(id) {
    const cue = this.list.find((c) => c.id === id);
    if (!cue) throw fail(404, `No cue ${id}`);
    cue.actions = [];
    this.write();
    return this.viewCue(cue);
  }

  stop() {
    if (this._run) {
      for (const [id, state] of Object.entries(this._run.actions)) if (state === 'pending') this._run.actions[id] = 'cancelled';
    }
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    if (this.cues) {
      if (this.cues.clearFollows) this.cues.clearFollows('master');
      if (this.cues.clearBail) this.cues.clearBail('master');
    }
    const out = this.status();
    this._run = null;
    return out;
  }

  async runAction(a) {
    if (a.type === 'hires') {
      if (!this.cues || !this.cues.firePreset) throw fail(409, 'Hi-res cues are not available');
      await this.cues.firePreset({ system: a.system, preset: a.preset, mode: a.mode, followUp: a.followUp, bail: a.bail, enforce: false, owner: 'master' });
      return;
    }
    if (a.type === 'atem-macro') {
      if (!this.systems || !this.systems.atem) throw fail(409, 'ATEM is not available');
      await this.systems.atem('macroRun', { macro: a.macro });
      return;
    }
    if (!this.systems || !this.systems.ptz) throw fail(409, 'PTZ is not available');
    await this.systems.ptz('recall', { cam: a.camera, preset: a.preset });
  }

  go(id) {
    const cue = this.list.find((c) => c.id === id);
    if (!cue) throw fail(404, `No cue ${id}`);
    const view = this.viewCue(cue);
    if (view.invalid) throw fail(409, 'This cue is invalid. Re-pick the missing item before GO.');
    if (this._timers.length) this.stop();
    const actions = {};
    for (const a of cue.actions) actions[a.id] = 'pending';
    this._run = { id: cue.id, actions };
    for (const a of cue.actions) {
      const timer = setTimeout(async () => {
        if (!this._run || this._run.actions[a.id] !== 'pending') return;
        try {
          await this.runAction(a);
          if (this._run && this._run.actions[a.id] === 'pending') this._run.actions[a.id] = 'fired';
        } catch {
          if (this._run && this._run.actions[a.id] === 'pending') this._run.actions[a.id] = 'failed';
        }
      }, a.offsetMs || 0);
      if (timer.unref) timer.unref();
      this._timers.push(timer);
    }
    return this.status();
  }
}

module.exports = { MasterCues, cleanAction, seed };
