'use strict';
// Live device state: keeps one AWJ connection open, subscribes to change notifications (§1.4 p.4-5)
// and tracks layer sources per screen/aux on both preset sides (A/B, §3.6, §3.8, §3.9), the TBAR
// position (§3.8 p.13), last loaded Screen/Master memories (§3.11-3.12), memory labels (§3.7), inputs
// (§6.1), backups (§6.4-6.11) and audio mutes (§5.1-5.2). From that it computes real tally.
//
// Modes: 'push'     AWJ connected and the Subscriptions list was accepted
//        'poll-awj' AWJ connected, subscribing failed -> AWJ gets every pollMs
//        'poll-rest' AWJ unreachable -> REST layer status (REST p.15, p.17, p.24) + inputs (REST p.66)
//        'off'      disabled / not started
const { EventEmitter } = require('events');
const { P, awjToRest, restToAwj } = require('./paths');
const { API } = require('./rest');

const SIDES = ['A', 'B'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const slotStr = (v) => (v === undefined || v === null ? 'NONE' : String(v));

class Live extends EventEmitter {
  constructor({ device, settings, log }) {
    super();
    this.device = device; this.settings = settings; this.log = log || (() => {});
    this.mode = 'off'; this.timers = []; this.gen = 0;
    this.reset();
  }

  reset() {
    this.dests = []; this.raw = {}; this.inputs = {}; this.memLabels = { screen: {}, master: {} };
    this.master = { program: null, preview: null }; this.bg = {}; this.groups = {}; this.audio = { in: {}, out: {} };
    this.lastUpdate = null; this.error = null; this.subscribed = false; this.hasMemoryInfo = false;
  }

  get awj() { return this.device.awj; }
  get rest() { return this.device.rest; }
  s(k, d) { return this.settings[k] ?? d; }

  // ---------------- lifecycle ----------------
  start(dests) {
    this.stop();
    const gen = ++this.gen;
    this.reset();
    this.dests = dests.map((d) => d.key);
    for (const k of this.dests) this.raw[k] = { transition: null, layers: [], A: {}, B: {}, mem: { A: null, B: null } };
    if (this.settings.liveEnabled === false) { this.mode = 'off'; this.ready = Promise.resolve(); return this.ready; }
    this.ready = this._startAwj(gen).catch((e) => {
      if (gen !== this.gen) return;
      this.error = `AWJ unavailable (${e.message}); polling REST every ${this.s('pollMs', 1000)} ms`;
      this.log('warn', `Live: ${this.error}`);
      this._startRestPolling(gen);
    });
    return this.ready;
  }

  stop() {
    this.gen++;
    for (const t of this.timers) clearInterval(t), clearTimeout(t);
    this.timers = [];
    if (this._onNotify && this._boundAwj) { this._boundAwj.off('notify', this._onNotify); this._boundAwj.off('close', this._onClose); }
    this._boundAwj = null;
    this.mode = 'off';
  }

  _changed() { this.lastUpdate = new Date().toISOString(); if (this._deb) return; this._deb = setTimeout(() => { this._deb = null; this.emit('change'); }, 20); }

  async _startAwj(gen) {
    const awj = this.awj;
    await awj.connect();
    if (gen !== this.gen) return;
    this._boundAwj = awj;
    this._onNotify = ({ path, value }) => { if (this.ingest(path, value)) this._changed(); };
    this._onClose = () => {
      if (gen !== this.gen) return;
      this.log('warn', 'Live: AWJ connection lost; falling back to REST polling and retrying AWJ');
      this.mode = 'poll-rest'; this.subscribed = false; this._changed();
      this._startRestPolling(gen);
    };
    awj.on('notify', this._onNotify); awj.on('close', this._onClose);
    await this._discover();
    await this.readAll();
    if (gen !== this.gen) return;
    try {
      const subs = this.subscriptionList();
      const echo = await awj.replaceAndWait(P.subscriptions(), subs);
      if (!Array.isArray(echo) || !echo.includes(subs[0])) throw new Error('device did not echo the subscription list');
      this.subscribed = true; this.mode = 'push';
      this.log('info', `Live: subscribed to ${subs.length} AWJ paths (push updates)`);
      // slow safety re-read of everything (covers anything a notification might miss)
      this.timers.push(setInterval(() => this.readAll().then(() => this._changed()).catch(() => {}), this.s('resyncMs', 60000)));
    } catch (e) {
      this.subscribed = false; this.mode = 'poll-awj';
      this.error = `AWJ subscription failed (${e.message}); polling AWJ every ${this.s('pollMs', 1000)} ms`;
      this.log('warn', `Live: ${this.error}`);
      this.timers.push(setInterval(() => this.readFast().then(() => this._changed()).catch((err) => this.log('warn', `Live poll: ${err.message}`)), this.s('pollMs', 1000)));
      this.timers.push(setInterval(() => this.readAll().catch(() => {}), this.s('resyncMs', 60000)));
    }
    this._changed();
  }

  _startRestPolling(gen) {
    for (const t of this.timers) clearInterval(t), clearTimeout(t);
    this.timers = [];
    this.mode = 'poll-rest'; this.hasMemoryInfo = false;
    const tick = () => this.pollRest().then(() => this._changed()).catch((e) => { this.error = `REST poll failed: ${e.message}`; });
    tick();
    this.timers.push(setInterval(tick, this.s('pollMs', 1000)));
    // retry AWJ periodically
    this.timers.push(setInterval(async () => {
      if (gen !== this.gen || this.awj.connected) return;
      try {
        await this.awj.connect();
        this.log('info', 'Live: AWJ reachable again; switching back');
        const dests = this.dests.map((key) => ({ key }));
        this.start(dests);
      } catch { /* still down */ }
    }, this.s('awjRetryMs', 10000)));
  }

  // ---------------- discovery ----------------
  async _discover() {
    const awj = this.awj; const maxL = this.s('maxLayers', 8);
    for (const k of this.dests) {
      const layers = [];
      if (k[0] === 'S') {
        const caps = await awj.getMany(Array.from({ length: maxL }, (_, i) => P.layerCapability(k, i + 1))); // §3.5
        for (let l = 1; l <= maxL; l++) { const c = caps[P.layerCapability(k, l)]; if (c !== undefined && c !== 'OFF') layers.push(l); }
      } else {
        const probe = await awj.getMany(Array.from({ length: Math.min(maxL, 8) }, (_, i) => P.layerSource(k, 'A', i + 1)));
        for (let l = 1; l <= Math.min(maxL, 8); l++) if (probe[P.layerSource(k, 'A', l)] !== undefined) layers.push(l);
      }
      this.raw[k].layers = layers;
    }
    const maxIn = this.s('maxInputs', 32);
    const lab = await awj.getMany(Array.from({ length: maxIn }, (_, i) => P.input.label(i + 1)));
    this.inputList = []; for (let n = 1; n <= maxIn; n++) if (lab[P.input.label(n)] !== undefined) this.inputList.push(n);
    const ch = this.s('audioChannels', 8);
    const inPaths = []; for (let i = 1; i <= this.s('maxAudioInputs', maxIn); i++) for (let c = 1; c <= ch; c++) inPaths.push(P.audioInMute(i, c));
    const outPaths = []; for (let o = 1; o <= this.s('maxAudioOutputs', 20); o++) for (let c = 1; c <= ch; c++) outPaths.push(P.audioOutMute(o, c));
    const a = await awj.getMany([...inPaths, ...outPaths]);
    this.audioPaths = [...inPaths, ...outPaths].filter((p) => a[p] !== undefined);
    const g = await awj.getMany(Array.from({ length: this.s('maxGroups', 8) }, (_, i) => P.groupBackupSelect(i + 1)));
    this.groupList = []; for (let i = 1; i <= this.s('maxGroups', 8); i++) if (g[P.groupBackupSelect(i)] !== undefined) this.groupList.push(i);
    this.log('info', `Live: tracking ${this.dests.length} destinations, ${this.inputList.length} inputs, ${this.audioPaths.length} audio channels, ${this.groupList.length} backup groups`);
  }

  fastPaths() {
    const out = [];
    for (const k of this.dests) {
      out.push(P.transition(k));
      for (const sd of SIDES) {
        for (const l of [...this.raw[k].layers, 'NATIVE']) out.push(P.layerSource(k, sd, l));
        out.push(P.lastScreenMemory(k, sd));
      }
    }
    out.push(P.lastMasterMemory('program'), P.lastMasterMemory('preview'));
    for (const n of this.inputList || []) out.push(P.input.freeze(n), P.input.isAvailable(n), P.input.isEnabled(n), P.inputBackupSelect(n));
    for (const k of this.dests.filter((x) => x[0] === 'S')) for (let b = 1; b <= this.s('maxBgSets', 8); b++) out.push(P.bgBackupSelect(k, b));
    for (const g of this.groupList || []) out.push(P.groupBackupSelect(g));
    out.push(...(this.audioPaths || []));
    return out;
  }

  slowPaths() {
    const out = [];
    for (const k of this.dests) out.push(P.destLabel(k));
    for (let n = 1; n <= this.s('screenMemoryLabels', 1000); n++) out.push(P.screenMemoryLabel(n));
    for (let n = 1; n <= this.s('masterMemoryLabels', 500); n++) out.push(P.masterLabel(n));
    for (const n of this.inputList || []) {
      out.push(P.input.label(n), P.input.capability(n), P.input.scope(n), P.input.device(n), P.inputBackupSource(n, 1), P.inputBackupSource(n, 2), P.inputBackupAuto(n));
    }
    for (const k of this.dests.filter((x) => x[0] === 'S')) {
      for (let b = 1; b <= this.s('maxBgSets', 8); b++) out.push(P.bgBackupSource(k, b, 1), P.bgBackupSource(k, b, 2), P.bgBackupAuto(k, b));
    }
    for (const g of this.groupList || []) out.push(P.groupBackupAuto(g));
    return out;
  }

  async readFast() { const r = await this.awj.getMany(this.fastPaths()); for (const [p, v] of Object.entries(r)) if (v !== undefined) this.ingest(p, v); }
  async readAll() {
    const r = await this.awj.getMany([...this.fastPaths(), ...this.slowPaths()]);
    for (const [p, v] of Object.entries(r)) if (v !== undefined) this.ingest(p, v);
    this.hasMemoryInfo = true;
  }

  // Prefixes for the Subscriptions list. Derived from the documented read paths (the §1.4 example's
  // "$screenGroup" predates the 4.0 split, see §1.4 p.5 and §3.2's "$screenAuxGroup").
  subscriptionList() {
    const out = [];
    for (const k of this.dests) {
      out.push(P.transition(k), P.destLabel(k));
      for (const sd of SIDES) for (const l of [...this.raw[k].layers, 'NATIVE']) out.push(P.layerSource(k, sd, l).replace(/\/@props\/inputNum$/, ''));
    }
    out.push('DeviceObject/presetBank/status/presetId', 'DeviceObject/masterPresetBank/status/lastUsed',
      'DeviceObject/presetBank/$bank', 'DeviceObject/masterPresetBank/$bank', 'DeviceObject/$input/@items/', 'DeviceObject/backup/$group');
    for (const k of this.dests.filter((x) => x[0] === 'S')) out.push(`DeviceObject/preconfig/backgrounds/$screen/@items/${k}/$backgroundSet`);
    for (const p of this.audioPaths || []) out.push(p.replace(/\/@props\/mute$/, ''));
    return out;
  }

  // ---------------- ingest ----------------
  // Returns true if the value was recognised. Object values (if the device notifies at object level)
  // are flattened into child paths.
  ingest(path, value, depth = 0) {
    if (isObj(value) && depth < 8) { let any = false; for (const [k, v] of Object.entries(value)) any = this.ingest(`${path}/${k}`, v, depth + 1) || any; return any; }
    let m;
    if ((m = /^DeviceObject\/\$(?:screen|auxiliary)\/@items\/([SA]\d+)\/\$preset\/@items\/([AB])\/\$layer\/@items\/(\d+|NATIVE)\/source\/@props\/inputNum$/.exec(path))) {
      const r = this.raw[m[1]]; if (!r) return false; r[m[2]][m[3]] = String(value); return true;
    }
    if ((m = /^DeviceObject\/\$screenAuxGroup\/@items\/([SA]\d+)\/status\/@props\/transition$/.exec(path))) { const r = this.raw[m[1]]; if (!r) return false; r.transition = value; return true; }
    if ((m = /^DeviceObject\/presetBank\/status\/presetId\/\$(?:screen|auxiliary)\/@items\/([SA]\d+)\/\$preset\/@items\/([AB])\/@props\/id$/.exec(path))) { const r = this.raw[m[1]]; if (!r) return false; r.mem[m[2]] = num(value); return true; }
    if ((m = /^DeviceObject\/masterPresetBank\/status\/lastUsed\/\$presetMode\/@items\/(PROGRAM|PREVIEW)\/@props\/memoryId$/.exec(path))) { this.master[m[1] === 'PROGRAM' ? 'program' : 'preview'] = num(value); return true; }
    if ((m = /^DeviceObject\/presetBank\/\$bank\/@items\/(\d+)\/control\/@props\/label$/.exec(path))) { this._label('screen', +m[1], value); return true; }
    if ((m = /^DeviceObject\/masterPresetBank\/\$bank\/@items\/(\d+)\/control\/@props\/label$/.exec(path))) { this._label('master', +m[1], value); return true; }
    if ((m = /^DeviceObject\/\$(?:screen|auxiliary)\/@items\/([SA]\d+)\/control\/@props\/label$/.exec(path))) { const r = this.raw[m[1]]; if (!r) return false; r.label = value; return true; }
    if ((m = /^DeviceObject\/\$input\/@items\/IN_(\d+)\/(status|control|mapping)\/@props\/(isEnabled|capability|label|isAvailable|freeze|device|scope)$/.exec(path))) {
      this._input(+m[1])[m[3]] = value; return true;
    }
    if ((m = /^DeviceObject\/\$input\/@items\/IN_(\d+)\/backup\/\$slot\/@items\/([12])\/control\/@props\/source$/.exec(path))) { this._input(+m[1]).backup.slots[m[2]] = value; return true; }
    if ((m = /^DeviceObject\/\$input\/@items\/IN_(\d+)\/backup\/control\/@props\/(xSelectSlot|enableAutoSelect)$/.exec(path))) {
      const b = this._input(+m[1]).backup; if (m[2] === 'xSelectSlot') b.selected = slotStr(value); else b.auto = !!value; return true;
    }
    if ((m = /^DeviceObject\/preconfig\/backgrounds\/\$screen\/@items\/(S\d+)\/\$backgroundSet\/@items\/(\d+)\/backup\/(?:\$slot\/@items\/([12])\/control\/@props\/source|control\/@props\/(xSelectSlot|enableAutoSelect))$/.exec(path))) {
      const id = `${m[1]}/${m[2]}`; const b = this.bg[id] || (this.bg[id] = { screen: m[1], set: +m[2], slots: {}, selected: 'NONE', auto: false });
      if (m[3]) b.slots[m[3]] = value; else if (m[4] === 'xSelectSlot') b.selected = slotStr(value); else b.auto = !!value;
      return true;
    }
    if ((m = /^DeviceObject\/backup\/\$group\/@items\/GROUP_(\d+)\/control\/@props\/(xSelectSlot|enableAutoSelect)$/.exec(path))) {
      const g = this.groups[m[1]] || (this.groups[m[1]] = { group: +m[1], selected: 'NONE', auto: false });
      if (m[2] === 'xSelectSlot') g.selected = slotStr(value); else g.auto = !!value; return true;
    }
    if ((m = /^DeviceObject\/audio\/control\/\$device\/@items\/1\/\$rx\/@items\/INPUT_(\d+)_CHANNEL_(\d+)\/control\/@props\/mute$/.exec(path))) { this.audio.in[`${m[1]}/${m[2]}`] = !!value; return true; }
    if ((m = /^DeviceObject\/audio\/control\/\$device\/@items\/1\/\$tx\/@items\/OUTPUT_(\d+)\/\$channel\/@items\/(\d+)\/control\/@props\/mute$/.exec(path))) { this.audio.out[`${m[1]}/${m[2]}`] = !!value; return true; }
    return false;
  }

  _label(kind, n, v) { if (v) this.memLabels[kind][n] = String(v); else delete this.memLabels[kind][n]; }
  _input(n) { return this.inputs[n] || (this.inputs[n] = { number: n, label: '', backup: { slots: {}, selected: 'NONE', auto: false } }); }

  // ---------------- REST polling fallback ----------------
  async pollRest() {
    const maxL = this.s('maxLayers', 8);
    for (const k of this.dests) {
      const id = Number(k.slice(1)); const r = this.raw[k];
      r.transition = 'AT_DOWN'; r.restDerived = true; r.mem = { A: null, B: null }; // REST has no TBAR or last-memory read
      const layers = [];
      for (const [target, sd] of [['program', 'A'], ['preview', 'B']]) {
        for (let l = 1; l <= (k[0] === 'S' ? maxL : Math.min(maxL, 8)); l++) {
          const path = k[0] === 'S' ? `${API}/screens/${id}/layers/${l}/presets/${target}` : `${API}/auxiliary-screens/${id}/layers/${l}/presets/${target}/source`;
          try {
            const res = await this.rest.get(path);
            if (!res) continue;
            if (sd === 'A') layers.push(l);
            // a closed/off layer is not visible, so it does not count for tally (REST p.15 status)
            r[sd][l] = res.status && ['off', 'close'].includes(res.status) ? 'NONE' : restToAwj(res.sourceType, res.sourceId);
          } catch (e) { if (e.status === 401) throw e; }
        }
        if (k[0] === 'S') {
          try { const b = await this.rest.get(`${API}/screens/${id}/background-layer/presets/${target}`); r[sd].NATIVE = b ? restToAwj(b.sourceType, b.sourceId) : 'NONE'; } catch (e) { if (e.status === 401) throw e; }
        }
      }
      r.layers = layers;
    }
    for (let n = 1; n <= this.s('maxInputs', 32); n++) {
      try {
        const i = await this.rest.get(`${API}/inputs/${n}`); // REST p.66
        const x = this._input(n);
        Object.assign(x, { label: i.label, isEnabled: i.isEnabled, isAvailable: i.isValid, freeze: i.isFrozen, capacity: i.capacity, restDerived: true });
      } catch (e) { if (e.status === 401) throw e; if (e.status === 404) break; }
    }
    this.inputList = Object.keys(this.inputs).map(Number);
  }

  // ---------------- views ----------------
  sides(k) { const r = this.raw[k]; const pg = r && r.transition === 'AT_UP' ? 'B' : 'A'; return { program: pg, preview: pg === 'A' ? 'B' : 'A' }; }

  sourceLabel(src) {
    const s = String(src || 'NONE'); let m;
    if ((m = /^LIVE_(\d+)$/.exec(s))) { const i = this.inputs[m[1]]; return (i && i.label) || `Input ${m[1]}`; }
    if ((m = /^STILL_(\d+)$/.exec(s))) return `Still ${m[1]}`;
    if ((m = /^SCREEN_(\d+)$/.exec(s))) return `Screen ${m[1]}`;
    if ((m = /^NATIVE_(\d+)$/.exec(s))) return `Background ${m[1]}`;
    return s === 'COLOR' ? 'Color' : '';
  }

  memRef(kind, id) { return id ? { id, label: this.memLabels[kind][id] || '' } : null; }

  destView(k) {
    const r = this.raw[k]; if (!r) return null;
    const sd = this.sides(k);
    const side = (which) => {
      const L = r[sd[which]]; const layers = {};
      for (const l of r.layers) layers[l] = L[l] || 'NONE';
      return { layers, background: L.NATIVE || 'NONE', memory: this.memRef('screen', r.mem[sd[which]]), layer1Label: this.sourceLabel(L[r.layers[0] || 1]) };
    };
    return { key: k, transition: r.transition, program: side('program'), preview: side('preview') };
  }

  tally() {
    const inputs = {}; const program = new Set(); const preview = new Set();
    const add = (n, which, k) => { const t = inputs[n] || (inputs[n] = { program: [], preview: [] }); if (!t[which].includes(k)) t[which].push(k); (which === 'program' ? program : preview).add(Number(n)); };
    for (const k of this.dests) {
      const r = this.raw[k]; if (!r || !r.transition) continue;
      const sd = this.sides(k);
      for (const which of ['program', 'preview']) {
        const L = r[sd[which]];
        for (const l of [...r.layers, 'NATIVE']) { const m = /^LIVE_(\d+)$/.exec(L[l] || ''); if (m) add(m[1], which, k); }
      }
    }
    return { program: [...program].sort((a, b) => a - b), preview: [...preview].sort((a, b) => a - b), inputs };
  }

  inputsView() {
    const t = this.tally();
    return Object.values(this.inputs).sort((a, b) => a.number - b.number).map((i) => ({
      number: i.number, label: i.label || '', isEnabled: i.isEnabled ?? null, isAvailable: i.isAvailable ?? null,
      capability: i.capability ?? null, freeze: i.freeze ?? null, scope: i.scope ?? null, device: i.device ?? null,
      onProgram: t.program.includes(i.number), onPreview: t.preview.includes(i.number),
      programOn: (t.inputs[i.number] || {}).program || [], previewOn: (t.inputs[i.number] || {}).preview || [],
      backup: { ...i.backup, active: !!(i.backup && i.backup.selected && i.backup.selected !== 'NONE') },
    }));
  }

  backupView() {
    return {
      inputs: this.inputsView().filter((i) => Object.values(i.backup.slots || {}).some((s) => s && s !== 'NONE') || i.backup.active || i.backup.auto)
        .map((i) => ({ number: i.number, label: i.label, ...i.backup })),
      backgrounds: Object.values(this.bg).map((b) => ({ ...b, active: b.selected !== 'NONE' })),
      groups: Object.values(this.groups).map((g) => ({ ...g, active: g.selected !== 'NONE' })),
    };
  }

  audioView() {
    const group = (map, key) => {
      const out = {};
      for (const [id, mute] of Object.entries(map)) { const [a, c] = id.split('/').map(Number); (out[a] || (out[a] = { [key]: a, channels: [] })).channels.push({ channel: c, mute }); }
      return Object.values(out).map((x) => ({ ...x, channels: x.channels.sort((p, q) => p.channel - q.channel) }));
    };
    return { inputs: group(this.audio.in, 'input'), outputs: group(this.audio.out, 'output') };
  }

  memoriesView() {
    return {
      screen: this.memLabels.screen, master: this.memLabels.master,
      lastMaster: { program: this.memRef('master', this.master.program), preview: this.memRef('master', this.master.preview) },
      destinations: Object.fromEntries(this.dests.map((k) => { const v = this.destView(k); return [k, { program: v.program.memory, preview: v.preview.memory }]; })),
    };
  }

  status() { return { mode: this.mode, subscribed: this.subscribed, hasMemoryInfo: this.hasMemoryInfo, lastUpdate: this.lastUpdate, error: this.error }; }

  snapshot() {
    return {
      ...this.status(),
      destinations: Object.fromEntries(this.dests.map((k) => [k, this.destView(k)])),
      tally: this.tally(), inputs: this.inputsView(),
      lastMaster: this.memoriesView().lastMaster,
      backup: this.backupView(), audio: this.audioView(),
    };
  }

  // ---------------- writes (AWJ only) ----------------
  _needAwj() { if (!this.awj.connected) throw new Error('This control needs the AWJ connection (TCP 10606), which is not available'); }
  async _write(path, value) { this._needAwj(); await this.awj.replace(path, value); try { const v = await this.awj.get(path); this.ingest(path, v); } catch { this.ingest(path, value); } this._changed(); return value; }

  setFreeze(n, value) { const cur = this._input(n).freeze; return this._write(P.input.freeze(n), value === undefined ? !cur : !!value); } // INFERRED write (§6.1 documents get only)
  inputBackupSelect(n, slot) { return this._write(P.inputBackupSelect(n), checkSlot(slot)); } // §6.5
  inputBackupMode(n, auto) { return this._write(P.inputBackupAuto(n), !!auto); } // §6.6
  bgBackupSelect(k, set, slot) { return this._write(P.bgBackupSelect(k, set), checkSlot(slot)); } // §6.8
  bgBackupMode(k, set, auto) { return this._write(P.bgBackupAuto(k, set), !!auto); } // §6.9
  groupBackupSelect(g, slot) { return this._write(P.groupBackupSelect(g), checkSlot(slot)); } // §6.10
  groupBackupMode(g, auto) { return this._write(P.groupBackupAuto(g), !!auto); } // §6.11
  audioMute(dir, a, c, value) { // §5.1.2 / §5.2.2
    const map = dir === 'in' ? this.audio.in : this.audio.out; const cur = map[`${a}/${c}`];
    return this._write(dir === 'in' ? P.audioInMute(a, c) : P.audioOutMute(a, c), value === undefined ? !cur : !!value);
  }
}

function checkSlot(slot) { const s = String(slot ?? '').toUpperCase(); if (!['NONE', '1', '2'].includes(s)) throw new Error('Backup slot must be NONE, 1 or 2 (§6.5)'); return s; }

module.exports = { Live, awjToRest };
