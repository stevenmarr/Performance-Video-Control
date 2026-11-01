'use strict';
// Master cues. RUN CUE plays the loaded cue's timeline: TAKE actions, the GO
// mark, then POST TAKE actions. The run is a cue-machine state, not a pile of
// flags. A second RUN while one is in progress is ignored. One action failure
// fails the cue. The timeline always leaves "running".

const fs = require('fs');
const path = require('path');
const { createCueMachine, send } = require('./cue-machine');

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
  const type = a.type === 'atem-macro' || a.type === 'ptz' || a.type === 'look' ? a.type : (a.type === 'hires' ? 'hires' : '');
  if (!type) return null;
  // Old saves stored offsetMs and no section. Those fire on RUN, which is the TAKE side.
  const atMs = tenth(a.atMs != null ? a.atMs : a.offsetMs);
  const section = a.section === 'post' ? 'post' : 'take';
  const base = { id: idOf(a.id) || freshId(), type, offsetMs: atMs, atMs, section };
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
  if (type === 'look') {
    const look = idOf(a.look);
    if (!look) return null;
    return { ...base, look };
  }
  const camera = idOf(a.camera);
  const preset = Number(a.preset);
  if (!camera || !Number.isInteger(preset) || preset < 1 || preset > 100) return null;
  return { ...base, camera, preset };
}

function defaultGo(actions) {
  const take = (actions || []).filter((a) => a.section !== 'post');
  if (!take.length) return 5000;
  const last = take.reduce((m, a) => Math.max(m, a.atMs || 0), 0);
  return Math.min(600000, Math.max(500, last + 500));
}

function cleanGo(v, actions) {
  if (v === undefined || v === null || v === '') return defaultGo(actions);
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return defaultGo(actions);
  return Math.min(600000, Math.round(n / 100) * 100);
}

function cleanCue(body, prev) {
  const id = idOf(body.id || (prev && prev.id)) || freshId();
  const actions = Array.isArray(body.actions) ? body.actions.map(cleanAction).filter(Boolean).slice(0, 64) : ((prev && prev.actions) || []).map(cleanAction).filter(Boolean);
  const goSource = body.goMs !== undefined ? body.goMs : (prev && prev.goMs !== undefined ? prev.goMs : undefined);
  return { id, name: String(body.name || (prev && prev.name) || 'Cue').slice(0, 60), actions, goMs: cleanGo(goSource, actions) };
}

function seed() {
  return Array.from({ length: 8 }, (_, i) => ({ id: `mc${i + 1}`, name: `Cue ${i + 1}`, actions: [], goMs: 5000 }));
}

class MasterCues {
  constructor({ dataDir, cues = null, systems = null, atemDesk = null, looks = null } = {}) {
    this.file = dataDir ? path.join(dataDir, 'master-cues.json') : null;
    this.cues = cues;
    this.systems = systems;
    this.atemDesk = atemDesk;
    this.looks = looks;
    this.list = [];
    this.stacked = false;
    this.machine = createCueMachine();
    this._progress = null;
    this._fired = new Set();
    this._timers = [];
    this._waits = [];
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.list = (raw.cues || []).map((c) => cleanCue(c)).filter((c) => c.id);
        this.stacked = !!raw.stacked;
      } catch { this.list = []; }
    } else this.list = seed();
    if (!this.list.length && this.file && !fs.existsSync(this.file)) this.list = seed();
    if (this.file && !fs.existsSync(this.file)) this.write();
  }

  write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ stacked: this.stacked, cues: this.list }, null, 2));
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
      const names = cam.presetNames || {};
      for (let n = 1; n <= 8; n++) {
        const named = names[n] || names[String(n)];
        ptz.push({ type: 'ptz', camera: cam.id, preset: n, label: `${cam.name || cam.id} ${named || n}`, name: cam.name || cam.id });
      }
    }
    groups.push({ device: 'ptz', label: 'PTZ', items: ptz });
    if (this.looks && this.looks.list) {
      let looks = [];
      try { looks = this.looks.list() || []; } catch { looks = []; }
      groups.push({
        device: 'looks', label: 'LOOKS',
        items: looks.map((l) => ({ type: 'look', look: l.id, system: l.system, label: `${String(l.system || '').toUpperCase()} ${l.name}`, name: l.name })),
      });
    }
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
    if (a.type === 'look') {
      if (!this.looks || !this.looks.list) return false;
      let all = [];
      try { all = this.looks.list() || []; } catch { return false; }
      if (!all.length) return false;
      return !all.some((l) => l.id === a.look);
    }
    return false;
  }

  cueRunState(id) {
    if (!this.machine || this.machine.cueId !== id) return 'idle';
    if (this.machine.state === 'running') return 'running';
    if (this.machine.state === 'failed') return 'failed';
    if (this.machine.state === 'loaded') return 'loaded';
    return 'idle';
  }

  viewCue(cue) {
    const progress = this._progress && this._progress.id === cue.id ? this._progress.actions : null;
    const actions = cue.actions.map((a) => ({ ...a, invalid: this.actionInvalid(a), state: progress ? (progress[a.id] || 'pending') : 'idle' }));
    return { ...cue, actions, invalid: actions.some((a) => a.invalid), runState: this.cueRunState(cue.id), assigned: actions.length > 0 };
  }

  machineView() {
    const m = this.machine;
    return { state: m.state, phase: m.phase, cueId: m.cueId, error: m.error, locked: m.state === 'running', generation: m.generation };
  }

  feedback() {
    return {
      ...this.machineView(),
      byId: Object.fromEntries(this.list.map((c) => [c.id, this.cueRunState(c.id)])),
    };
  }

  status() {
    const running = this.machine.state === 'running' && this._progress
      ? { id: this._progress.id, phase: this.machine.phase, actions: { ...this._progress.actions }, startedAt: this._progress.startedAt, goMs: this._progress.goMs }
      : null;
    return {
      cues: this.list.map((c) => this.viewCue(c)),
      palette: this.palette(),
      stacked: this.stacked,
      machine: this.machineView(),
      running,
    };
  }

  _need(id) {
    const cue = this.list.find((c) => c.id === id);
    if (!cue) throw fail(404, `No cue ${id}`);
    return cue;
  }

  _guardRunning(id) {
    if (this.machine.state === 'running' && this.machine.cueId === id) throw fail(409, 'This cue is running');
  }

  save(body = {}) {
    if (Array.isArray(body.cues)) {
      this.list = body.cues.map((c) => cleanCue(c)).filter((c) => c.id);
      this.write();
      return this.status();
    }
    if (body.id && body.actions) this._guardRunning(idOf(body.id));
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
    const src = this._need(id);
    const copy = cleanCue({ name: `${src.name} copy`, actions: src.actions.map((a) => ({ ...a, id: '' })), goMs: src.goMs });
    this.list.push(copy);
    this.write();
    return this.viewCue(copy);
  }

  clear(id) {
    const cue = this._need(id);
    this._guardRunning(id);
    cue.actions = [];
    if (this.machine.cueId === id && this.machine.state !== 'running') {
      const step = send(this.machine, { type: 'cancel' });
      if (!step.ignored) this.machine = step.state;
    }
    this.write();
    return this.viewCue(cue);
  }

  remove(id) {
    const cue = this._need(id);
    this._guardRunning(id);
    this.list = this.list.filter((c) => c.id !== id);
    if (this.machine.cueId === id) {
      const step = send(this.machine, { type: 'cancel' });
      if (!step.ignored) this.machine = step.state;
      if (this._progress && this._progress.id === id) this._progress = null;
    }
    this.write();
    return this.status();
  }

  setStacked(body = {}) {
    const value = body.on !== undefined ? body.on : (body.enabled !== undefined ? body.enabled : body.stacked);
    this.stacked = !!value;
    this.write();
    return this.status();
  }

  load(id) {
    const cue = this._need(id);
    const view = this.viewCue(cue);
    if (!cue.actions.length) throw fail(409, 'This cue has no presets');
    if (view.invalid) throw fail(409, 'This cue is invalid. Re-pick the missing item before RUN CUE.');
    const step = send(this.machine, { type: 'load', cueId: cue.id });
    if (step.ignored && this.machine.state === 'running') return { ...this.status(), ignored: true, locked: true };
    if (!step.ignored) this.machine = step.state;
    return this.status();
  }

  _live(gen) {
    return this.machine.state === 'running' && this.machine.generation === gen;
  }

  _clearTimers() {
    const timers = this._timers || [];
    this._timers = [];
    for (const t of timers) clearTimeout(t);
    const waits = this._waits || [];
    this._waits = [];
    for (const w of waits) w.resolve();
  }

  _releaseMaster() {
    if (!this.cues) return;
    if (this.cues.armOwner) this.cues.armOwner('master', null);
    if (this.cues.clearFollows) this.cues.clearFollows('master');
    if (this.cues.clearBail) this.cues.clearBail('master');
  }

  _wait(ms, gen) {
    return new Promise((resolve) => {
      if (ms <= 0 || !this._live(gen)) return resolve();
      const item = { resolve, timer: null };
      item.timer = setTimeout(() => {
        this._waits = (this._waits || []).filter((w) => w !== item);
        resolve();
      }, ms);
      if (item.timer.unref) item.timer.unref();
      this._waits = this._waits || [];
      this._waits.push(item);
      this._timers.push(item.timer);
    });
  }

  _nextWithActions(id) {
    const i = this.list.findIndex((c) => c.id === id);
    for (let n = i + 1; n < this.list.length; n++) {
      if (this.list[n].actions.length) return this.list[n];
    }
    return null;
  }

  _crossGo(gen) {
    if (!this._live(gen)) return;
    let step = send(this.machine, { type: 'enterGo' });
    if (!step.ignored) this.machine = step.state;
    step = send(this.machine, { type: 'enterPost' });
    if (!step.ignored) this.machine = step.state;
    if (this._progress) this._progress.goReached = true;
    this._maybeDone(gen);
  }

  _maybeDone(gen) {
    if (!this._live(gen) || !this._progress || !this._progress.goReached) return;
    const pending = Object.values(this._progress.actions).some((s) => s === 'pending' || s === 'firing');
    if (pending) return;
    this._complete(gen);
  }

  _complete(gen) {
    if (!this._live(gen)) return;
    const cueId = this.machine.cueId;
    const next = this.stacked ? this._nextWithActions(cueId) : null;
    this._clearTimers();
    this._releaseMaster();
    const step = send(this.machine, { type: 'timelineDone', stacked: !!(this.stacked && next), nextCueId: next && next.id });
    if (!step.ignored) this.machine = step.state;
    this._progress = null;
    this._fired = new Set();
  }

  _fail(gen, message) {
    if (!this._live(gen)) return;
    if (this._progress) {
      for (const [id, st] of Object.entries(this._progress.actions)) {
        if (st === 'pending') this._progress.actions[id] = 'cancelled';
      }
    }
    this._clearTimers();
    this._releaseMaster();
    const step = send(this.machine, { type: 'fail', error: message || 'Action failed' });
    if (!step.ignored) this.machine = step.state;
  }

  async _fire(gen, a) {
    if (!this._live(gen) || !this._progress) return;
    if (this._fired.has(a.id)) return;
    if (this._progress.actions[a.id] !== 'pending') return;
    this._fired.add(a.id);
    this._progress.actions[a.id] = 'firing';
    try {
      await this.runAction(a, gen);
      if (!this._live(gen) || !this._progress) return;
      if (this._progress.actions[a.id] === 'firing') this._progress.actions[a.id] = 'fired';
      this._maybeDone(gen);
    } catch (e) {
      if (!this._live(gen) || !this._progress) return;
      this._progress.actions[a.id] = 'failed';
      this._fail(gen, e.message || 'Action failed');
    }
  }

  _start(cue) {
    const gen = this.machine.generation;
    const actions = {};
    for (const a of cue.actions) actions[a.id] = 'pending';
    this._progress = { id: cue.id, actions, startedAt: Date.now(), goMs: cue.goMs, generation: gen, goReached: false };
    this._fired = new Set();
    this._clearTimers();
    if (this.cues) {
      if (this.cues.clearFollows) this.cues.clearFollows('master');
      if (this.cues.clearBail) this.cues.clearBail('master');
      if (this.cues.armOwner) this.cues.armOwner('master', gen);
    }
    const arm = (ms, fn) => {
      const t = setTimeout(fn, Math.max(0, ms));
      if (t.unref) t.unref();
      this._timers.push(t);
    };
    for (const a of cue.actions) {
      const when = a.section === 'post' ? Math.max(a.atMs || 0, cue.goMs || 0) : (a.atMs || 0);
      arm(when, () => { this._fire(gen, a); });
    }
    arm(cue.goMs || 0, () => this._crossGo(gen));
    if (!cue.actions.length) this._complete(gen);
  }

  _halt(type) {
    const step = send(this.machine, { type });
    this._clearTimers();
    this._releaseMaster();
    if (!step.ignored) {
      this.machine = step.state;
      this._progress = null;
      this._fired = new Set();
    }
  }

  stop() {
    this._halt('cancel');
    return this.status();
  }

  // Operator recalled a preset on another tab and hit TAKE. The take itself
  // runs in the route; this only drops the cue so nothing else on its timeline fires.
  externalTake() {
    if (this.cues) {
      if (this.cues.armOwner) this.cues.armOwner('master', null);
      if (this.cues.clearFollows) this.cues.clearFollows('master');
      if (this.cues.clearBail) this.cues.clearBail('master');
    }
    const step = send(this.machine, { type: 'externalPresetTake' });
    this._clearTimers();
    if (!step.ignored) {
      this.machine = step.state;
      this._progress = null;
      this._fired = new Set();
    }
    return this.status();
  }

  ack() {
    const step = send(this.machine, { type: 'ack' });
    if (step.ignored) return { ...this.status(), ignored: true };
    this.machine = step.state;
    this._progress = null;
    return this.status();
  }

  go(id) {
    const cue = this._need(id);
    const view = this.viewCue(cue);
    if (view.invalid) throw fail(409, 'This cue is invalid. Re-pick the missing item before RUN CUE.');
    if (!cue.actions.length) throw fail(409, 'This cue has no presets');
    const before = this.machine;
    const step = send(this.machine, { type: 'run', cueId: cue.id });
    if (step.ignored) return { ...this.status(), ignored: true, locked: before.state === 'running' };
    this.machine = step.state;
    this._start(cue);
    return this.status();
  }

  run() {
    if (this.machine.state === 'running') return { ...this.status(), ignored: true, locked: true };
    if (this.machine.state === 'failed') return { ...this.status(), ignored: true };
    if (this.machine.state !== 'loaded' || !this.machine.cueId) throw fail(409, 'No cue is loaded');
    return this.go(this.machine.cueId);
  }

  async runAction(a, gen) {
    if (a.type === 'hires') {
      if (!this.cues || !this.cues.firePreset) throw fail(409, 'Hi-res cues are not available');
      await this.cues.firePreset({ system: a.system, preset: a.preset, mode: a.mode, followUp: null, bail: a.bail, enforce: false, owner: 'master', generation: gen });
      if (a.followUp && a.followUp.preset) {
        await this._wait(a.followUp.delayMs || 0, gen);
        if (!this._live(gen)) return;
        await this.cues.firePreset({ system: a.system, preset: a.followUp.preset, mode: a.followUp.mode || 'absolute', enforce: false, owner: 'master', generation: gen });
      }
      return;
    }
    if (a.type === 'atem-macro') {
      if (!this.systems || !this.systems.atem) throw fail(409, 'ATEM is not available');
      await this.systems.atem('macroRun', { macro: a.macro });
      return;
    }
    if (a.type === 'look') {
      if (!this.looks || !this.looks.recall) throw fail(409, 'Looks are not available');
      await this.looks.recall(a.look);
      return;
    }
    if (!this.systems || !this.systems.ptz) throw fail(409, 'PTZ is not available');
    await this.systems.ptz('recall', { cam: a.camera, preset: a.preset });
  }
}

module.exports = { MasterCues, cleanAction, cleanCue, seed };
