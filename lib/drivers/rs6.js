'use strict';
// RS6 driver: the common driver interface (lib/drivers/common.js) over the existing Aquilon Engine. The RS6 keeps
// its own richer UI (memories, board, tile presets the app builds itself); this adapter makes the same basic
// operations reachable through /api/sys/rs6/* like the other systems, and it is what a future shared UI or
// Companion-style client can use. It only delegates to Engine, so RS6 behaviour is exactly the 0.5.0 one.
class RS6Driver {
  constructor(engine) {
    this.system = 'rs6';
    this.engine = engine;
    this.capabilities = { presets: true, recallPreview: true, recallProgram: false, take: true, cut: true, destinations: true, armDestinations: false,
      sources: true, freeze: true, auxRoute: false, stills: false, cues: false, backups: true, destFilteredRecall: false, ownUi: true };
  }
  async connect() { await this.engine.connect(); return this.status().info; }
  close() { /* the Engine lives for the whole app */ }
  status() { const e = this.engine; return { connected: !!e.connected, info: e.system ? { model: e.system.type || 'Aquilon', version: e.system.version } : null, error: e.lastError || null, lastSeen: 0 }; }
  async listPresets() { return this.engine.presets.map((p) => ({ key: `rs6:${p.number}`, id: p.number, number: p.number, name: this.engine.presetName(p), dests: [...(p.destinations || [])] })); }
  async listDestinations() { return this.engine.destinations.map((d) => ({ key: d.key, kind: d.kind, id: d.id, label: d.label })); }
  async listSources() { return this.engine.live.inputsView().map((i) => ({ key: `in:${i.number}`, id: i.number, name: i.label || `Input ${i.number}`, kind: 'input', frozen: !!i.freeze, status: i.isAvailable === false ? 'unavailable' : '' })); }
  async recall(preset) { return this.engine.recall(preset.id); }
  async select(keys) { this.engine.setSelection(keys); }
  async take(keys) { if (keys) this.engine.setSelection(keys); return this.engine.take(); }
  async cut(keys) { if (keys) this.engine.setSelection(keys); return this.engine.cut(); }
  async freeze(kind, id, on) { return this.engine.live.setFreeze(Number(id), on); }
}
module.exports = { RS6Driver };
