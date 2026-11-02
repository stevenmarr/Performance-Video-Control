'use strict';
// RS6 driver. The original id `rs6` is the app Engine (show presets, the pages in public/app.js).
// Every other RS6 instance owns its own Device: its own IP, REST port, and AWJ port.
const { Device } = require('../device');

const CAPS = {
  presets: true, recallPreview: true, recallProgram: false, take: true, cut: true, destinations: true, armDestinations: false,
  sources: true, freeze: true, auxRoute: false, stills: false, cues: false, backups: true, destFilteredRecall: false, ownUi: true,
};

function rs6Settings(raw) {
  const port = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };
  const protocol = raw && raw.protocol === 'awj' ? 'awj' : 'rest';
  return {
    host: String((raw && raw.host) || '').trim(),
    restPort: port(raw && raw.restPort, 80),
    awjPort: port(raw && raw.awjPort, 10606),
    protocol,
    https: !!(raw && raw.https),
    password: raw && typeof raw.password === 'string' ? raw.password : '',
    maxScreens: 24, maxAux: 20, maxInputs: 32,
  };
}

class RS6Driver {
  constructor(engine, log) {
    this.system = 'rs6';
    this.capabilities = CAPS;
    this.peer = !(engine && engine.device && engine.settings);
    if (!this.peer) {
      this.engine = engine;
      return;
    }
    this.log = log || (() => {});
    this.settings = rs6Settings(engine || {});
    this.device = new Device(this.settings, this.log);
    this.connected = false;
    this.systemInfo = null;
    this.lastError = null;
    this.destinations = [];
  }

  configure(conn) {
    if (!this.peer) return;
    this.settings = rs6Settings({ ...this.settings, ...(conn || {}) });
    this.device.configure(this.settings);
    this.connected = false;
  }

  async connect() {
    if (!this.peer) {
      await this.engine.connect();
      return this.status().info;
    }
    if (!this.settings.host) throw new Error('RS6: no IP address set (SYSTEMS tab)');
    try {
      this.systemInfo = await this.device.getSystem();
      this.destinations = await this.device.listDestinations({ maxScreens: this.settings.maxScreens, maxAux: this.settings.maxAux });
      this.connected = true;
      this.lastError = null;
    } catch (e) {
      this.connected = false;
      this.lastError = e.message;
      throw e;
    }
    return this.status().info;
  }

  close() {
    if (!this.peer) return;
    this.connected = false;
    try { this.device.close(); } catch { /* already closed */ }
  }

  status() {
    if (!this.peer) {
      const e = this.engine;
      return { connected: !!e.connected, info: e.system ? { model: e.system.type || 'Aquilon', version: e.system.version } : null, error: e.lastError || null, lastSeen: 0 };
    }
    const v = this.systemInfo && this.systemInfo.version;
    const ver = v && typeof v === 'object' ? `${v.major}.${v.minor}.${v.patch}` : v;
    return {
      connected: this.connected,
      info: this.systemInfo ? { model: this.systemInfo.type || 'Aquilon', version: ver || '' } : null,
      error: this.lastError,
      lastSeen: this.connected ? Date.now() : 0,
    };
  }

  view() {
    if (!this.peer) return null;
    return { destinations: this.destinations.map((d) => ({ ...d })), connection: { ...this.settings, password: undefined } };
  }

  // Load one show preset (the book on the original RS6) onto THIS processor.
  async recallShowPreset(preset) {
    if (!this.peer) throw new Error('The original RS6 recalls through its own pages');
    if (!preset) throw new Error('No preset');
    const done = [];
    const dests = preset.destinations || [];
    for (const dest of dests) {
      if (preset.memories && preset.memories[dest] != null) {
        await this.device.loadMemory(dest, preset.memories[dest], 'preview');
        done.push(dest);
      }
    }
    return { done, preset: preset.number };
  }

  async take(keys) {
    if (!this.peer) {
      if (keys) this.engine.setSelection(keys);
      return this.engine.take();
    }
    const dests = keys && keys.length ? keys : this.destinations.map((d) => d.key);
    await this.device.take(dests);
    return { done: dests };
  }

  async cut(keys) {
    if (!this.peer) {
      if (keys) this.engine.setSelection(keys);
      return this.engine.cut();
    }
    const dests = keys && keys.length ? keys : [];
    return { done: dests, note: 'CUT on an added RS6 loads the preview memory to program from the show book' };
  }

  async listPresets() {
    if (!this.peer) return this.engine.presets.map((p) => ({ key: `rs6:${p.number}`, id: p.number, number: p.number, name: this.engine.presetName(p), dests: [...(p.destinations || [])] }));
    return [];
  }

  async listDestinations() {
    if (!this.peer) return this.engine.destinations.map((d) => ({ key: d.key, kind: d.kind, id: d.id, label: d.label }));
    return this.destinations.map((d) => ({ ...d }));
  }

  async listSources() {
    if (!this.peer) return this.engine.live.inputsView().map((i) => ({ key: `in:${i.number}`, id: i.number, name: i.label || `Input ${i.number}`, kind: 'input', frozen: !!i.freeze, status: i.isAvailable === false ? 'unavailable' : '' }));
    return [];
  }

  async recall(preset) {
    if (!this.peer) return this.engine.recall(preset.id);
    return this.recallShowPreset(preset);
  }

  async select(keys) { if (!this.peer) this.engine.setSelection(keys); }

  async freeze(kind, id, on) {
    if (!this.peer) return this.engine.live.setFreeze(Number(id), on);
    return null;
  }
}

module.exports = { RS6Driver, rs6Settings };
