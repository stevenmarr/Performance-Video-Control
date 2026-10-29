'use strict';
// ATEM macro editor and absolute memories. One desk, not a hi-res preset.
// The switcher pool (names, used slots, run / record) is synced from the ATEM.
// Steps live here: the protocol we speak can run and record a slot, not download
// the switcher's operation list. Playing steps sends those operations back.
// A memory is a captured switcher state. Recalling it sets buses and keys to
// those values. It is not a macro, and it is not an RS6 / E2 / PixelHue preset.

const fs = require('fs');
const path = require('path');

const OPS = [
  { group: 'Mix Effects', op: 'preview', label: 'Preview', fields: ['source', 'me'] },
  { group: 'Mix Effects', op: 'program', label: 'Program', fields: ['source', 'me'] },
  { group: 'Mix Effects', op: 'cut', label: 'Cut', fields: ['me'] },
  { group: 'Mix Effects', op: 'auto', label: 'Auto', fields: ['me'] },
  { group: 'Mix Effects', op: 'style', label: 'Transition', fields: ['style', 'me'] },
  { group: 'Mix Effects', op: 'mixRate', label: 'Mix rate', fields: ['rate', 'me'] },
  { group: 'Keys', op: 'uskOnAir', label: 'Upstream key', fields: ['key', 'on', 'me'] },
  { group: 'Keys', op: 'dskOnAir', label: 'Downstream key', fields: ['key', 'on'] },
  { group: 'Router', op: 'aux', label: 'Aux', fields: ['aux', 'source'] },
  { group: 'Super Source', op: 'ssBox', label: 'Super Source box', fields: ['ss', 'box', 'source'] },
  { group: 'Wait', op: 'wait', label: 'Wait', fields: ['frames'] },
  { group: 'Wait', op: 'userWait', label: 'User wait', fields: [] },
];
const OP_NAMES = new Set(OPS.map((o) => o.op));
const SKIP_NOTE = new Set(['macroRun', 'macroStop', 'macroRecord', 'macroStopRecord', 'macroContinue', 'macroUserWait']);

const fail = (status, message) => Object.assign(new Error(message), { status });
const freshId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

function cleanArgs(op, args) {
  const src = args && typeof args === 'object' ? args : {};
  const keep = {};
  const spec = OPS.find((o) => o.op === op);
  for (const field of (spec && spec.fields) || []) {
    if (src[field] === undefined) continue;
    if (field === 'on') keep.on = !!src.on;
    else if (field === 'style') keep.style = String(src.style).slice(0, 16);
    else keep[field] = num(src[field]);
  }
  return keep;
}

function cleanStep(s) {
  if (!s || !OP_NAMES.has(s.op)) return null;
  const frames = Math.max(0, Math.min(250, Math.round(Number(s.waitFrames) || 0)));
  return {
    id: String(s.id || freshId()).replace(/[^\w-]/g, '').slice(0, 40) || freshId(),
    op: s.op,
    args: cleanArgs(s.op, s.args),
    waitFrames: s.op === 'wait' ? Math.max(1, frames || Number(s.args && s.args.frames) || 1) : frames,
    userWait: s.op === 'userWait' || !!s.userWait,
  };
}

function cleanMacro(body, prev) {
  const index = num(body.index !== undefined ? body.index : (prev && prev.index));
  if (index === undefined || index < 0 || index > 99) throw fail(400, 'Macro slot is 0–99');
  const steps = Array.isArray(body.steps) ? body.steps.map(cleanStep).filter(Boolean).slice(0, 200) : ((prev && prev.steps) || []);
  return {
    index,
    name: String(body.name || (prev && prev.name) || `Macro ${index + 1}`).slice(0, 40),
    description: String(body.description !== undefined ? body.description : ((prev && prev.description) || '')).slice(0, 120),
    used: body.used !== undefined ? !!body.used : !!(prev && prev.used),
    dirty: body.dirty !== undefined ? !!body.dirty : !!(prev && prev.dirty),
    steps,
    pos: Number.isFinite(Number(body.pos)) ? Number(body.pos) : (prev && prev.pos) || index,
  };
}

class AtemDesk {
  constructor({ dataDir, systems = null, frameMs = 33 } = {}) {
    this.file = dataDir ? path.join(dataDir, 'atem-desk.json') : null;
    this.systems = systems;
    this.frameMs = frameMs;
    this.macros = [];
    this.memories = [];
    this.recording = null;
    this._play = null;
    this._wake = null;
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.macros = (raw.macros || []).map((m) => {
          const row = cleanMacro(m);
          row.opaque = !!m.opaque;
          row.versions = Array.isArray(m.versions) ? m.versions.slice(-30) : [];
          row.backup = m.backup || null;
          row.conflict = m.conflict || null;
          return row;
        });
        this.memories = Array.isArray(raw.memories) ? raw.memories : [];
      } catch { this.macros = []; }
    }
  }

  write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ macros: this.macros, memories: this.memories }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  view() {
    const live = this.liveView();
    return {
      macros: this.macros.slice().sort((a, b) => a.pos - b.pos || a.index - b.index).map((m) => ({ ...m, steps: m.steps.map((s) => ({ ...s, args: { ...s.args } })) })),
      memories: this.memories.map((m) => ({ ...m, state: m.state })),
      recording: this.recording,
      play: this._play ? { index: this._play.index, step: this._play.step, waiting: !!this._play.waiting } : null,
      catalog: this.catalogOps(),
      protocol: 'The ATEM protocol lists macro names and descriptions (MPrp). It does not download the steps inside a slot. Steps authored here stay in Control Center.',
      showLock: false,
      switcher: {
        macros: (live && live.macros) || [],
        running: (live && live.macroRun) || null,
        inputs: ((live && live.inputs) || []).map((i) => ({ id: i.id, long: i.long || i.longName || i.short || String(i.id) })),
      },
    };
  }

  liveView() {
    try {
      if (!this.systems || !this.systems.drivers || !this.systems.drivers.atem) return null;
      return this.systems.drivers.atem.view();
    } catch { return null; }
  }

  sync(view) {
    const live = view || this.liveView();
    if (!live) return this.view();
    for (const m of live.macros || []) {
      const row = this.macros.find((x) => x.index === m.index);
      if (!row) {
        this.macros.push({ index: m.index, name: m.name || `Macro ${m.index + 1}`, description: m.description || '', used: !!m.isUsed, dirty: false, steps: [], pos: m.index, opaque: !!m.isUsed, versions: [], backup: null, conflict: null });
      } else {
        row.used = !!m.isUsed;
        if (!row.steps.length && row.used) row.opaque = true;
        if (row.steps.length) row.opaque = false;
        if (row.dirty && m.name && row.name !== m.name) row.conflict = { switcherName: m.name, appName: row.name, at: new Date().toISOString() };
        else row.conflict = null;
        if (!row.dirty) {
          if (m.name) row.name = m.name;
          if (m.description) row.description = m.description;
        }
      }
    }
    this.write();
    return this.view();
  }

  saveMacro(body) {
    const prev = this.macros.find((m) => m.index === num(body.index));
    if (prev && prev.opaque && Array.isArray(body.steps) && body.steps.length && !body.acknowledgeOpaque) {
      throw fail(409, 'This slot is used on the switcher and Control Center cannot read its steps, so it will not overwrite it.');
    }
    const row = cleanMacro({ ...body, dirty: body.dirty !== undefined ? body.dirty : true }, prev);
    row.opaque = !!(prev && prev.opaque && !body.acknowledgeOpaque);
    row.versions = (prev && prev.versions ? prev.versions : []).slice();
    row.conflict = prev && prev.conflict ? prev.conflict : null;
    if (prev && prev.steps && prev.steps.length) row.backup = { at: new Date().toISOString(), name: prev.name, steps: prev.steps.map((s) => ({ ...s, args: { ...s.args } })) };
    else row.backup = prev && prev.backup ? prev.backup : null;
    row.versions.push({ at: new Date().toISOString(), note: String(body.note || 'save').slice(0, 80), name: row.name, steps: row.steps.map((s) => ({ ...s, args: { ...s.args } })) });
    row.versions = row.versions.slice(-30);
    const i = this.macros.findIndex((m) => m.index === row.index);
    if (i >= 0) this.macros[i] = row;
    else this.macros.push(row);
    this.write();
    return row;
  }

  addMacro(body = {}) {
    const used = new Set(this.macros.map((m) => m.index));
    let index = num(body.index);
    if (index === undefined) {
      index = 0;
      while (used.has(index) && index < 100) index += 1;
    }
    return this.saveMacro({ index, name: body.name || `Macro ${index + 1}`, description: '', steps: [], dirty: true, used: false, pos: this.macros.length });
  }

  duplicate(index) {
    const src = this.macros.find((m) => m.index === num(index));
    if (!src) throw fail(404, `No macro ${index}`);
    const copy = this.addMacro({ name: `${src.name} copy` });
    copy.steps = src.steps.map((s) => ({ ...s, id: freshId(), args: { ...s.args } }));
    copy.description = src.description;
    this.write();
    return copy;
  }

  removeMacro(index) {
    const n = num(index);
    const before = this.macros.length;
    this.macros = this.macros.filter((m) => m.index !== n);
    if (this.macros.length === before) throw fail(404, `No macro ${index}`);
    if (this.recording === n) this.recording = null;
    this.write();
    return this.view();
  }

  reorder(indexes) {
    (indexes || []).forEach((index, pos) => {
      const row = this.macros.find((m) => m.index === num(index));
      if (row) row.pos = pos;
    });
    this.write();
    return this.view();
  }

  arm(index) {
    const n = num(index);
    if (n === undefined) throw fail(400, 'Record needs a macro slot');
    if (!this.macros.find((m) => m.index === n)) this.addMacro({ index: n, name: `Macro ${n + 1}` });
    this.recording = n;
    this.write();
    return this.view();
  }

  disarm() {
    this.recording = null;
    this.write();
    return this.view();
  }

  note(op, args) {
    if (this.recording === null || this.recording === undefined) return null;
    if (SKIP_NOTE.has(op)) return null;
    const row = this.macros.find((m) => m.index === this.recording);
    if (!row || !OP_NAMES.has(op)) return null;
    const step = cleanStep({ op, args, userWait: op === 'userWait' });
    if (!step) return null;
    row.steps.push(step);
    row.dirty = true;
    row.used = true;
    this.write();
    return step;
  }

  sleep(delay) {
    return new Promise((resolve) => {
      if (delay <= 0 || (this._play && this._play.cancelled)) return resolve();
      const timer = setTimeout(() => { this._wake = null; resolve(); }, delay);
      this._wake = () => { clearTimeout(timer); this._wake = null; resolve(); };
    });
  }

  continuePlay() {
    if (this._play) this._play.waiting = false;
    if (this._wake) this._wake();
    return this.view();
  }

  stopPlay() {
    if (this._play) this._play.cancelled = true;
    if (this._wake) this._wake();
    return this.view();
  }

  async play(index, { loop = false } = {}) {
    const row = this.macros.find((m) => m.index === num(index));
    if (!row) throw fail(404, `No macro ${index}`);
    if (this._play) return this.view();
    let guard = 0;
    do {
      this._play = { index: row.index, step: 0, waiting: false, cancelled: false };
      try {
        for (let i = 0; i < row.steps.length; i++) {
          if (this._play.cancelled) break;
          const step = row.steps[i];
          this._play.step = i;
          if (step.userWait || step.op === 'userWait') {
            this._play.waiting = true;
            await new Promise((resolve) => { this._wake = () => { this._wake = null; resolve(); }; });
            if (this._play.cancelled) break;
            this._play.waiting = false;
            continue;
          }
          if (step.op === 'wait' || step.waitFrames) {
            await this.sleep((step.waitFrames || 1) * this.frameMs);
            if (step.op === 'wait') continue;
          }
          if (this._play.cancelled) break;
          if (!this.systems || !this.systems.atem) throw fail(409, 'ATEM is not available');
          await this.systems.atem(step.op, step.args);
          this._play.step = i + 1;
        }
      } finally {
        const cancelled = !!(this._play && this._play.cancelled);
        this._play = null;
        if (cancelled) loop = false;
      }
    } while (loop && guard++ < 8);
    return this.view();
  }

  capture(name) {
    const live = this.liveView();
    if (!live || !live.mes) throw fail(409, 'ATEM is not connected');
    const state = {
      mes: (live.mes || []).map((m) => ({
        index: m.index,
        program: m.program,
        preview: m.preview,
        style: m.style || null,
        mixRate: m.mixRate || null,
        keyers: (m.keyers || []).map((k) => ({ index: k.index, onAir: !!k.onAir })),
      })),
      dsk: (live.dsk || []).map((d) => ({ index: d.index, onAir: !!d.onAir })),
      aux: (live.aux || []).map((a) => ({ index: a.index, source: a.source })),
      superSources: (live.superSources || []).map((ss) => ({
        index: ss.index,
        boxes: (ss.boxes || []).filter((b) => b.source !== undefined && b.source !== null).map((b) => ({ index: b.index, source: b.source })),
      })),
    };
    const id = freshId();
    const memory = { id, name: String(name || `Memory ${this.memories.length + 1}`).slice(0, 40), at: new Date().toISOString(), state };
    this.memories.push(memory);
    this.write();
    return memory;
  }

  saveMemory(body) {
    const row = this.memories.find((m) => m.id === body.id);
    if (!row) throw fail(404, `No memory ${body.id}`);
    if (body.name !== undefined) row.name = String(body.name).slice(0, 40);
    this.write();
    return row;
  }

  removeMemory(id) {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    if (this.memories.length === before) throw fail(404, `No memory ${id}`);
    this.write();
    return { ok: true };
  }

  async recallMemory(id) {
    const row = this.memories.find((m) => m.id === id);
    if (!row) throw fail(404, `No memory ${id}`);
    if (!this.systems || !this.systems.atem) throw fail(409, 'ATEM is not available');
    const st = row.state || {};
    const sent = [];
    for (const me of st.mes || []) {
      const base = { me: me.index + 1 };
      if (me.program !== undefined && me.program !== null) { await this.systems.atem('program', { ...base, source: me.program }); sent.push('program'); }
      if (me.preview !== undefined && me.preview !== null) { await this.systems.atem('preview', { ...base, source: me.preview }); sent.push('preview'); }
      if (me.style) { await this.systems.atem('style', { ...base, style: me.style }); sent.push('style'); }
      if (me.mixRate) { await this.systems.atem('mixRate', { ...base, rate: me.mixRate }); sent.push('mixRate'); }
      for (const key of me.keyers || []) {
        await this.systems.atem('uskOnAir', { ...base, key: key.index, on: !!key.onAir });
        sent.push(`usk${key.index}`);
      }
    }
    for (const dsk of st.dsk || []) {
      await this.systems.atem('dskOnAir', { key: dsk.index, on: !!dsk.onAir });
      sent.push(`dsk${dsk.index}`);
    }
    for (const aux of st.aux || []) {
      if (aux.source === undefined || aux.source === null) continue;
      await this.systems.atem('aux', { aux: aux.index, source: aux.source });
      sent.push(`aux${aux.index}`);
    }
    for (const ss of st.superSources || []) {
      for (const box of ss.boxes || []) {
        await this.systems.atem('ssBox', { ss: ss.index, box: box.index, source: box.source });
        sent.push(`ss${ss.index}.${box.index}`);
      }
    }
    return { ok: true, id: row.id, absolute: true, sent };
  }

  // Local scrub. Does not talk to the switcher. Starts from the live buses when
  // we have them, then applies steps 0..upto.
  simulate(index, upto) {
    const row = this.macros.find((m) => m.index === num(index));
    if (!row) throw fail(404, `No macro ${index}`);
    const live = this.liveView();
    const mes = ((live && live.mes) || [{ index: 0, program: null, preview: null, keyers: [] }]).map((m) => ({
      index: m.index, program: m.program, preview: m.preview, keyers: (m.keyers || []).map((k) => ({ ...k })),
    }));
    const aux = ((live && live.aux) || []).map((a) => ({ ...a }));
    const n = Math.max(-1, Math.min(row.steps.length - 1, Number(upto)));
    for (let i = 0; i <= n; i++) {
      const step = row.steps[i];
      const me = mes[Math.max(0, (Number(step.args.me) || 1) - 1)] || mes[0];
      if (!me) continue;
      if (step.op === 'preview') me.preview = step.args.source;
      if (step.op === 'program') me.program = step.args.source;
      if (step.op === 'cut' || step.op === 'auto') { const p = me.program; me.program = me.preview; me.preview = p; }
      if (step.op === 'aux') {
        const slot = aux.find((a) => a.index === step.args.aux) || { index: step.args.aux, source: null };
        slot.source = step.args.source;
        if (!aux.includes(slot)) aux.push(slot);
      }
    }
    return { index: row.index, upto: n, mes, aux };
  }

  catalogOps() {
    const live = this.liveView();
    const topo = (live && live.topology) || null;
    const ss = topo ? Number(topo.superSources) || 0 : null;
    const dsk = topo ? Number(topo.downstreamKeyers) || 0 : null;
    return OPS.map((op) => {
      let disabled = false;
      let reason = '';
      if (op.op === 'ssBox' && ss === 0) { disabled = true; reason = 'This model has no SuperSource'; }
      if (op.op === 'dskOnAir' && dsk === 0) { disabled = true; reason = 'This model has no downstream key'; }
      return { ...op, disabled, reason, tested: false };
    });
  }

  resolve(index, body = {}) {
    const row = this.macros.find((m) => m.index === num(index));
    if (!row) throw fail(404, `No macro ${index}`);
    const choice = body.choice || body.keep;
    const live = (this.liveView() && (this.liveView().macros || []).find((m) => m.index === row.index)) || null;
    if (choice === 'switcher') {
      if (live && live.name) row.name = live.name;
      if (live && live.description) row.description = live.description;
      row.dirty = false;
      row.conflict = null;
    } else if (choice === 'app') {
      row.dirty = true;
      row.conflict = null;
    } else if (choice === 'merge') {
      if ((!row.name || row.name === `Macro ${row.index + 1}`) && live && live.name) row.name = live.name;
      row.dirty = true;
      row.conflict = null;
    } else throw fail(400, 'Choose switcher, app, or merge');
    this.write();
    return row;
  }

  restore(index, body = {}) {
    const row = this.macros.find((m) => m.index === num(index));
    if (!row) throw fail(404, `No macro ${index}`);
    const at = body.at || body.version;
    const hit = (row.versions || []).find((v) => v.at === at) || (row.backup && body.backup ? row.backup : null);
    if (!hit) throw fail(404, 'That version is not stored');
    return this.saveMacro({ index: row.index, name: hit.name || row.name, description: row.description, steps: hit.steps || [], dirty: true, note: 'restore', acknowledgeOpaque: true });
  }

  commit(index) {
    const row = this.macros.find((m) => m.index === num(index));
    if (!row) throw fail(404, `No macro ${index}`);
    if (row.opaque || !row.steps.length) throw fail(409, 'This slot is used on the switcher and Control Center cannot read its steps, so it will not overwrite it.');
    row.backup = { at: new Date().toISOString(), name: row.name, steps: row.steps.map((s) => ({ ...s, args: { ...s.args } })) };
    row.versions = row.versions || [];
    row.versions.push({ at: new Date().toISOString(), note: 'write', name: row.name, steps: row.steps.map((s) => ({ ...s, args: { ...s.args } })) });
    row.versions = row.versions.slice(-30);
    this.write();
    return {
      ok: false,
      uploaded: false,
      backup: true,
      showLock: false,
      reason: 'The ATEM protocol exposes macro names only (MPrp). A backup and a version were kept. The switcher slot was not overwritten. Play the steps from Control Center to run them.',
    };
  }

  toXml() {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));
    const opXml = (s) => {
      const a = s.args || {};
      const me = a.me ? ` mixEffectIndex="${Number(a.me) - 1}"` : '';
      if (s.op === 'preview') return `<Op id="PreviewInput"${me} input="${Number(a.source) || 0}"/>`;
      if (s.op === 'program') return `<Op id="ProgramInput"${me} input="${Number(a.source) || 0}"/>`;
      if (s.op === 'cut') return `<Op id="CutTransition"${me}/>`;
      if (s.op === 'auto') return `<Op id="AutoTransition"${me}/>`;
      if (s.op === 'style') return `<Op id="TransitionStyle"${me} style="${esc(a.style || '')}"/>`;
      if (s.op === 'mixRate') return `<Op id="TransitionMixRate"${me} rate="${Number(a.rate) || 0}"/>`;
      if (s.op === 'uskOnAir') return `<Op id="UpstreamKeyerOnAir"${me} keyIndex="${Number(a.key) || 0}" onAir="${a.on ? 1 : 0}"/>`;
      if (s.op === 'dskOnAir') return `<Op id="DownstreamKeyerOnAir" keyIndex="${Number(a.key) || 0}" onAir="${a.on ? 1 : 0}"/>`;
      if (s.op === 'aux') return `<Op id="AuxSource" auxIndex="${Number(a.aux) || 0}" input="${Number(a.source) || 0}"/>`;
      if (s.op === 'ssBox') return `<Op id="SuperSourceBoxSource" boxIndex="${Number(a.box) || 0}" input="${Number(a.source) || 0}"/>`;
      if (s.op === 'wait' || s.op === 'userWait') return `<Op id="${s.op === 'userWait' ? 'MacroUserWait' : 'MacroSleep'}" frames="${Number(s.waitFrames) || Number(a.frames) || 0}"/>`;
      return '';
    };
    const macros = this.macros.map((m) => `    <Macro index="${m.index}" name="${esc(m.name)}" description="${esc(m.description || '')}">\n${m.steps.map(opXml).filter(Boolean).map((line) => `      ${line}`).join('\n')}\n    </Macro>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile majorVersion="1" minorVersion="0" product="Control Center ATEM subset">\n  <MacroPool>\n${macros}\n  </MacroPool>\n</Profile>\n`;
  }

  fromXml(text) {
    const xml = String(text || '');
    if (!/<MacroPool[\s>]/.test(xml) && !/<Macro[\s>]/.test(xml)) throw fail(400, 'That file has no MacroPool');
    const blocks = xml.match(/<Macro\b[^>]*>[\s\S]*?<\/Macro>/g) || [];
    const imported = [];
    const skipped = [];
    const idOf = (chunk) => {
      const id = (chunk.match(/\bid="([^"]+)"/) || [])[1] || '';
      const map = { PreviewInput: 'preview', ProgramInput: 'program', CutTransition: 'cut', AutoTransition: 'auto', TransitionStyle: 'style', TransitionMixRate: 'mixRate', UpstreamKeyerOnAir: 'uskOnAir', DownstreamKeyerOnAir: 'dskOnAir', AuxSource: 'aux', SuperSourceBoxSource: 'ssBox', MacroSleep: 'wait', MacroUserWait: 'userWait' };
      return map[id] || null;
    };
    const attr = (chunk, name) => {
      const m = chunk.match(new RegExp(`\\b${name}="([^"]*)"`));
      return m ? m[1] : '';
    };
    for (const block of blocks) {
      const open = (block.match(/<Macro\b[^>]*>/) || [''])[0];
      const index = Number(attr(open, 'index'));
      if (!Number.isInteger(index)) continue;
      const steps = [];
      for (const op of block.match(/<Op\b[^>]*\/>/g) || []) {
        const opName = idOf(op);
        if (!opName) { skipped.push({ index, op: attr(op, 'id') }); continue; }
        const meRaw = attr(op, 'mixEffectIndex');
        const args = {};
        if (meRaw !== '') args.me = Number(meRaw) + 1;
        if (attr(op, 'input') !== '') args.source = Number(attr(op, 'input'));
        if (attr(op, 'rate') !== '') args.rate = Number(attr(op, 'rate'));
        if (attr(op, 'style') !== '') args.style = attr(op, 'style');
        if (attr(op, 'keyIndex') !== '') args.key = Number(attr(op, 'keyIndex'));
        if (attr(op, 'onAir') !== '') args.on = attr(op, 'onAir') === '1' || attr(op, 'onAir') === 'true';
        if (attr(op, 'auxIndex') !== '') args.aux = Number(attr(op, 'auxIndex'));
        if (attr(op, 'boxIndex') !== '') args.box = Number(attr(op, 'boxIndex'));
        if (opName === 'wait') args.frames = Number(attr(op, 'frames') || 1);
        steps.push({ op: opName, args, userWait: opName === 'userWait', waitFrames: opName === 'wait' ? Number(attr(op, 'frames') || 1) : 0 });
      }
      const prev = this.macros.find((m) => m.index === index);
      if (prev && prev.opaque && steps.length) { skipped.push({ index, op: 'opaque' }); continue; }
      const row = this.saveMacro({ index, name: attr(open, 'name') || `Macro ${index + 1}`, description: attr(open, 'description') || '', steps, dirty: true, note: 'xml import' });
      imported.push(row.index);
    }
    return { imported, skipped, note: 'This is a Control Center macro subset. It is not a verified ATEM Software Control document.', xml: this.toXml() };
  }
}

module.exports = { AtemDesk, OPS, cleanStep, cleanMacro };
