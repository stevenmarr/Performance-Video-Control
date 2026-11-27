'use strict';
// Live programming session for one Event Master processor.
// Discovery builds the normalized model. Every dial, source, preset, cut and
// clear goes to Preview (PvwMode 1). Program changes only when the operator
// cuts or runs the auto transition.

const { normalize, applyProposal } = require('./schema');
const enc = require('./encoders');
const cmd = require('./commands');
const llm = require('./llm');

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function snapshotOf(layer) {
  const ids = Object.keys(layer.fields || {}).filter((k) => layer.fields[k]);
  const out = {};
  for (const id of ids) out[id] = enc.valueOf(layer, id);
  return out;
}

class ProgramSession {
  constructor(driver) {
    this.driver = driver;
    this.model = null;
    this.error = null;
    this.sel = { dest: null, layer: null, bank: null, aspectLock: false, ratio: null, pairs: {}, pager: { dest: 0, layer: 0, source: 0, preset: 0 } };
    this.snapshot = {};
    this.review = [];
    this.llmStatus = { enabled: false, reason: 'not run', proposals: 0 };
    this.cacheDir = null;
    this.confirmClear = 0;
  }

  async rpc(method, params) {
    const op = this.driver && typeof this.driver._op === 'function' ? this.driver._op(params || {}) : (params || {});
    return this.driver.rpc(method, op);
  }

  async discover() {
    const frame = await this.rpc('getFrameSettings', {});
    const destinations = await this.rpc('listDestinations', { type: 0 });
    let sources = [];
    try { sources = await this.rpc('listSources', {}); } catch (e) { this.error = e.message; }
    let inputs = [];
    try { inputs = await this.rpc('listInputs', { inputId: -1 }); } catch { /* listSources is enough on older frames */ }
    let presets = [];
    try { presets = await this.rpc('listPresets', { ScreenDest: -1, AuxDest: -1 }); } catch (e) { this.error = e.message; }
    const screens = (destinations && destinations.ScreenDestination) || [];
    const auxes = (destinations && destinations.AuxDestination) || [];
    const contents = {};
    for (const s of screens) {
      try { contents[s.id] = await this.rpc('listContent', { id: s.id }); } catch (e) { contents[s.id] = { error: e.message }; }
    }
    const auxContent = {};
    for (const a of auxes) {
      try { auxContent[a.id] = await this.rpc('listAuxContent', { id: a.id }); } catch { /* name stays generic */ }
    }
    const model = normalize({ frame, destinations, sources, inputs, presets, contents, auxContent });
    const mapped = await llm.mapUnknown(model.unknown, { cacheDir: this.cacheDir });
    this.llmStatus = llm.publicStatus(mapped);
    this.review = (mapped.proposals || []).map((p) => {
      const applied = p.prop !== 'ignore' && p.confidence >= 0.8 && applyProposal(model, p);
      return { ...p, applied: !!applied };
    });
    this.model = model;
    this.error = null;
    if (!this.sel.dest && model.destinations[0]) this.sel.dest = model.destinations[0].key;
    this._keepSelection();
    return this.view();
  }

  _dest() {
    if (!this.model) return null;
    return this.model.destinations.find((d) => d.key === this.sel.dest) || this.model.destinations[0] || null;
  }

  _layer() {
    const dest = this._dest();
    if (!dest || dest.kind === 'aux') return null;
    return dest.layers.find((l) => l.id === this.sel.layer) || dest.layers.find((l) => l.role !== 'background') || dest.layers[0] || null;
  }

  _keepSelection() {
    const dest = this._dest();
    if (!dest) { this.sel.dest = null; this.sel.layer = null; return; }
    this.sel.dest = dest.key;
    if (dest.kind === 'aux') { this.sel.layer = null; return; }
    const layer = this._layer();
    this.sel.layer = layer ? layer.id : null;
    const banks = enc.banksFor(layer, dest);
    if (!banks.some((b) => b.id === this.sel.bank)) this.sel.bank = banks[0] ? banks[0].id : null;
  }

  _sourceName(id) {
    if (id == null || !this.model) return '';
    const s = this.model.sources.find((x) => x.id === id);
    return s ? s.name : '';
  }

  _sourceLive(id) {
    if (!this.model || id == null) return false;
    for (const d of this.model.destinations) {
      if (d.aux && d.aux.pgmSourceId === id) return true;
      for (const l of d.layers || []) {
        if (l.pgm && l.pgm.active && l.pgm.sourceId === id) return true;
      }
    }
    return false;
  }

  view() {
    if (!this.model) {
      return { ready: false, error: this.error, llm: this.llmStatus, review: this.review, destinations: [], layers: [], sources: [], presets: [] };
    }
    const dest = this._dest();
    const layer = this._layer();
    const banks = enc.banksFor(layer, dest);
    const bank = banks.find((b) => b.id === this.sel.bank) || banks[0] || null;
    const encoders = bank ? bank.encoders.map((e, index) => this._readout(layer, e, index)) : [];
    const caps = (layer && layer.capabilities) || {};
    return {
      ready: true,
      error: this.error,
      frame: this.model.frame,
      destinations: this.model.destinations.map((d) => ({
        key: d.key, kind: d.kind, id: d.id, name: d.name, size: d.size,
        live: !!d.live, preview: !!d.preview, selected: !!(dest && d.key === dest.key),
        layerCount: (d.layers || []).length,
        aux: d.aux || null,
      })),
      layers: dest && dest.kind === 'screen' ? dest.layers.map((l) => ({
        id: l.id, name: l.name, role: l.role, side: l.side, pair: l.pair,
        free: !!l.free, inUse: !l.free, pvw: !!(l.pvw && l.pvw.active), pgm: !!(l.pgm && l.pgm.active),
        live: !!(l.pgm && l.pgm.active),
        sourceName: this._sourceName(l.pvw && l.pvw.sourceId),
        pgmSourceName: this._sourceName(l.pgm && l.pgm.sourceId),
        selected: !!(layer && l.id === layer.id),
        capabilities: l.capabilities,
      })) : [],
      sources: this.model.sources.map((s) => ({
        ...s,
        selected: !!(layer && layer.pvw && layer.pvw.sourceId === s.id) || !!(dest && dest.aux && dest.aux.pvwSourceId === s.id),
        live: this._sourceLive(s.id),
      })),
      presets: this.model.presets,
      selected: {
        dest: dest && dest.key,
        layer: layer && layer.id,
        bank: bank && bank.id,
        aspectLock: !!this.sel.aspectLock,
      },
      banks: banks.map((b) => ({ id: b.id, label: b.label })),
      encoders,
      shortcuts: {
        aspect: !!(caps.size && layer && layer.role !== 'background'),
        center: !!(caps.position && caps.size),
        fit: !!caps.size,
        fill: !!caps.size,
        freeze: !!caps.freeze,
        invert: !!caps.key,
        z: !!caps.zOrder,
        clear: !!(dest && dest.kind === 'screen' && layer && layer.role !== 'background'),
      },
      layerFrozen: !!(layer && layer.pvw && layer.pvw.freeze),
      pager: { ...this.sel.pager },
      unknown: this.model.unknown,
      review: this.review,
      llm: this.llmStatus,
      note: dest && dest.kind === 'aux' ? 'Aux takes a source. It has no layer window.' : null,
    };
  }

  _readout(layer, encoder, index) {
    const active = this.sel.pairs[encoder.id] || 0;
    const pair = encoder.pair.map((p) => {
      const value = enc.valueOf(layer, p.id);
      return { ...p, value };
    });
    const safeActive = active < pair.length ? active : 0;
    return {
      index,
      id: encoder.id,
      label: encoder.label,
      active: safeActive,
      pair,
      knob: null,
    };
  }

  async act(body = {}) {
    const op = String(body.op || 'view');
    if (op === 'discover' || (!this.model && op !== 'view')) await this.discover();
    if (op === 'view' || op === 'discover') return this.view();
    if (!this.model) throw Object.assign(new Error('E2 programming: the frame has not been read yet'), { status: 409 });
    if (op === 'selectDest') return this._selectDest(body.dest);
    if (op === 'selectLayer') return this._selectLayer(body.layer);
    if (op === 'selectBank') { this.sel.bank = body.bank || null; return this.view(); }
    if (op === 'pager') return this._pager(body.which);
    if (op === 'turn') return this._turn(body);
    if (op === 'press') return this._press(body);
    if (op === 'aspect') return this._aspect(body.mode);
    if (op === 'z') return this._z(body.dir);
    if (op === 'freeze') return this._freeze();
    if (op === 'invert') return this._invert();
    if (op === 'clear') return this._clear(body);
    if (op === 'source') return this._source(body.id);
    if (op === 'recall') return this._recall(body);
    if (op === 'save') return this._save(body);
    if (op === 'cut') return this._trans('cut');
    if (op === 'take') return this._trans('take');
    throw Object.assign(new Error(`E2 programming: unknown action ${op}`), { status: 400 });
  }

  _selectDest(key) {
    const dest = this.model.destinations.find((d) => d.key === key);
    if (!dest) throw Object.assign(new Error(`No destination ${key}`), { status: 404 });
    this.sel.dest = dest.key;
    this.sel.layer = null;
    this.sel.aspectLock = false;
    this.sel.pager.layer = 0;
    this._keepSelection();
    const layer = this._layer();
    if (layer) this.snapshot = snapshotOf(layer);
    return this.view();
  }

  _selectLayer(id) {
    const dest = this._dest();
    if (!dest || dest.kind !== 'screen') throw Object.assign(new Error('Pick a screen destination first'), { status: 409 });
    const layer = dest.layers.find((l) => l.id === Number(id));
    if (!layer) throw Object.assign(new Error(`No layer ${id}`), { status: 404 });
    this.sel.layer = layer.id;
    this.sel.aspectLock = false;
    this.sel.ratio = enc.aspectRatio(layer, this._currentSource(layer));
    this.snapshot = snapshotOf(layer);
    this._keepSelection();
    return this.view();
  }

  _currentSource(layer) {
    if (!layer || !layer.pvw || layer.pvw.sourceId == null || !this.model) return null;
    return this.model.sources.find((s) => s.id === layer.pvw.sourceId) || null;
  }

  _pager(which) {
    const key = ['dest', 'layer', 'source', 'preset'].includes(which) ? which : 'dest';
    const view = this.view();
    const len = (view[key === 'dest' ? 'destinations' : key === 'layer' ? 'layers' : key === 'source' ? 'sources' : 'presets'] || []).length;
    const room = 20;
    const pages = Math.max(1, Math.ceil(len / room));
    this.sel.pager[key] = (Number(this.sel.pager[key]) + 1) % pages;
    return this.view();
  }

  _encoder(index) {
    const dest = this._dest();
    const layer = this._layer();
    const banks = enc.banksFor(layer, dest);
    const bank = banks.find((b) => b.id === this.sel.bank) || banks[0];
    if (!bank) return null;
    const encoder = bank.encoders[Number(index)];
    if (!encoder) return null;
    const active = this.sel.pairs[encoder.id] || 0;
    const param = encoder.pair[active] || encoder.pair[0];
    return { dest, layer, encoder, param, active };
  }

  async _turn(body) {
    const hit = this._encoder(body.encoder);
    if (!hit || !hit.param) throw Object.assign(new Error('That dial is not on this layer'), { status: 409 });
    const current = enc.valueOf(hit.layer, hit.param.id);
    const turned = enc.applyTurn({ ...hit.param, value: current == null ? 0 : current }, body.ticks, body.dtMs);
    let group = cmd.groupOf(hit.param.id);
    if ((hit.param.id === 'sizeH' || hit.param.id === 'sizeV') && this.sel.aspectLock) {
      const which = hit.param.id === 'sizeH' ? 'h' : 'v';
      const locked = enc.lockSize(which, turned.value, this.sel.ratio || enc.aspectRatio(hit.layer, this._currentSource(hit.layer)));
      if (locked) {
        enc.writeValue(hit.layer, 'sizeH', locked.hSize);
        enc.writeValue(hit.layer, 'sizeV', locked.vSize);
      } else enc.writeValue(hit.layer, hit.param.id, turned.value);
    } else {
      enc.writeValue(hit.layer, hit.param.id, turned.value);
    }
    await this._send(group, hit.dest, hit.layer);
    return this.view();
  }

  async _press(body) {
    const hit = this._encoder(body.encoder);
    if (!hit) throw Object.assign(new Error('That dial is not on this layer'), { status: 409 });
    const kind = body.kind || enc.pressKind(body.heldMs);
    if (kind === 'toggle') {
      if (hit.encoder.pair.length > 1) {
        this.sel.pairs[hit.encoder.id] = hit.active === 0 ? 1 : 0;
      }
      return this.view();
    }
    const id = hit.param.id;
    const snap = this.snapshot && Object.prototype.hasOwnProperty.call(this.snapshot, id) ? this.snapshot[id] : null;
    const reset = snap != null ? snap : (hit.param.reset != null ? hit.param.reset : 0);
    enc.writeValue(hit.layer, id, reset);
    if ((id === 'sizeH' || id === 'sizeV') && this.sel.aspectLock) {
      const which = id === 'sizeH' ? 'h' : 'v';
      const locked = enc.lockSize(which, reset, this.sel.ratio);
      if (locked) {
        enc.writeValue(hit.layer, 'sizeH', locked.hSize);
        enc.writeValue(hit.layer, 'sizeV', locked.vSize);
      }
    }
    await this._send(cmd.groupOf(id), hit.dest, hit.layer);
    return this.view();
  }

  async _aspect(mode) {
    const dest = this._dest();
    const layer = this._layer();
    if (!layer || !layer.pvw) throw Object.assign(new Error('Pick a layer first'), { status: 409 });
    if (mode === 'lock') {
      this.sel.aspectLock = !this.sel.aspectLock;
      this.sel.ratio = enc.aspectRatio(layer, this._currentSource(layer));
      return this.view();
    }
    const size = dest && dest.size;
    let win = null;
    if (mode === 'center') win = enc.centerWindow(size, layer.pvw.window);
    else if (mode === 'fit' || mode === 'fill') win = enc.fitWindow(size, enc.aspectRatio(layer, this._currentSource(layer)), mode);
    else throw Object.assign(new Error(`Unknown aspect shortcut ${mode}`), { status: 400 });
    layer.pvw.window = { ...(layer.pvw.window || {}), ...win };
    await this._send('window', dest, layer);
    return this.view();
  }

  async _z(dir) {
    const dest = this._dest();
    const layer = this._layer();
    if (!layer) throw Object.assign(new Error('Pick a layer first'), { status: 409 });
    const count = dest.layers.filter((l) => l.role !== 'background').length;
    const next = enc.zStep(layer.pvw && layer.pvw.z, dir, count);
    layer.pvw.z = next;
    const call = cmd.zCommand(dest, layer, next);
    await this.rpc(call.method, call.params);
    return this.view();
  }

  async _freeze() {
    const dest = this._dest();
    const layer = this._layer();
    if (!layer || !layer.capabilities.freeze) throw Object.assign(new Error('This layer has no freeze'), { status: 409 });
    const on = !(layer.pvw && layer.pvw.freeze);
    layer.pvw.freeze = on;
    const call = cmd.freezeCommand(dest, layer, on);
    await this.rpc(call.method, call.params);
    return this.view();
  }

  async _invert() {
    const dest = this._dest();
    const layer = this._layer();
    if (!layer || !layer.pvw || !layer.pvw.key) throw Object.assign(new Error('This layer has no key'), { status: 409 });
    layer.pvw.key.invert = layer.pvw.key.invert ? 0 : 1;
    await this._send('key', dest, layer);
    return this.view();
  }

  async _clear(body) {
    const dest = this._dest();
    const layer = this._layer();
    if (!layer) throw Object.assign(new Error('Pick a layer first'), { status: 409 });
    const now = Date.now();
    if (!body.confirm && now - this.confirmClear > 4000) {
      this.confirmClear = now;
      const view = this.view();
      view.confirm = 'Press CLEAR again to take this layer off Preview.';
      return view;
    }
    this.confirmClear = 0;
    layer.pvw.active = false;
    layer.pvw.sourceId = null;
    const call = cmd.clearCommand(dest, layer);
    await this.rpc(call.method, call.params);
    layer.free = !layer.pgm.active;
    return this.view();
  }

  async _source(id) {
    const dest = this._dest();
    if (!dest) throw Object.assign(new Error('Pick a destination first'), { status: 409 });
    const sourceId = Number(id);
    if (!Number.isFinite(sourceId)) throw Object.assign(new Error('Pick a source'), { status: 400 });
    if (dest.kind === 'aux') {
      dest.aux = dest.aux || {};
      dest.aux.pvwSourceId = sourceId;
      const call = cmd.auxCommand(dest, sourceId);
      await this.rpc(call.method, call.params);
      return this.view();
    }
    const layer = this._layer();
    if (!layer) throw Object.assign(new Error('Pick a layer first'), { status: 409 });
    if (layer.wire && layer.wire.background) {
      throw Object.assign(new Error('Background source is set from the preset. Pick a mix layer.'), { status: 409 });
    }
    layer.pvw.sourceId = sourceId;
    layer.pvw.active = true;
    layer.free = false;
    const call = cmd.sourceCommand(dest, layer, sourceId);
    await this.rpc(call.method, call.params);
    return this.view();
  }

  async _recall(body) {
    const call = cmd.recallCommand(body.id, body.target);
    await this.rpc(call.method, call.params);
    await this.discover();
    return this.view();
  }

  async _save(body) {
    const dest = this._dest();
    const name = body.name || (dest ? `${dest.name} PVW` : 'Preview');
    const call = cmd.saveCommand(name, dest, body.fromProgram);
    await this.rpc(call.method, call.params);
    try {
      const presets = await this.rpc('listPresets', { ScreenDest: -1, AuxDest: -1 });
      this.model.presets = normalize({ presets }).presets;
    } catch { /* the save still happened */ }
    return this.view();
  }

  async _trans(which) {
    const dest = this._dest();
    if (!dest) throw Object.assign(new Error('Pick a destination first'), { status: 409 });
    const keys = [dest.key];
    const all = this.model.destinations.map((d) => d.key);
    if (which === 'cut') await this.driver.cut(keys, { allKeys: all });
    else await this.driver.take(keys, { allKeys: all });
    await this.discover();
    return this.view();
  }

  async _send(group, dest, layer) {
    const calls = cmd.commandsFor(group, dest, layer);
    for (const call of calls) await this.rpc(call.method, call.params);
  }
}

module.exports = { ProgramSession, snapshotOf };
