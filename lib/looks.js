'use strict';
// A look is a memory, not a macro. Recalling it loads one preset onto preview
// and then sets every stored key to the saved on or off. It does not toggle,
// and it does not run a list of actions.
// RS6, E2 and Pixelhue: the preset itself is the absolute picture (the device
// memory already holds the keyers). ATEM: the preview source is set, then each
// upstream key and DSK is forced to the stored value.
const fs = require('fs');
const path = require('path');

const SYSTEMS = new Set(['rs6', 'e2', 'pixelhue', 'atem']);

function cleanKey(k) {
  const id = String((k && k.id) || '').replace(/[^\w-]/g, '').slice(0, 24);
  if (!id) return null;
  return { id, label: String((k && k.label) || id).slice(0, 24), on: !!(k && k.on) };
}

function cleanLook(body = {}, prev) {
  const system = String(body.system || (prev && prev.system) || '');
  if (!SYSTEMS.has(system)) {
    throw Object.assign(new Error('A look belongs to rs6, e2, pixelhue or atem'), { status: 400 });
  }
  const preset = body.preset === undefined ? (prev && prev.preset) : body.preset;
  if (preset === undefined || preset === null || preset === '') {
    throw Object.assign(new Error('A look needs a preset'), { status: 400 });
  }
  const id = String(body.id || (prev && prev.id) || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (!id) throw Object.assign(new Error('A look needs an id'), { status: 400 });
  const keys = Array.isArray(body.keys) ? body.keys.map(cleanKey).filter(Boolean).slice(0, 16) : ((prev && prev.keys) || []);
  const presetText = String(preset);
  const numeric = (system === 'rs6' || system === 'atem') && /^\d+$/.test(presetText);
  return {
    id,
    name: String(body.name || (prev && prev.name) || `Look ${preset}`).slice(0, 40),
    system,
    preset: numeric ? Number(presetText) : presetText.slice(0, 40),
    keys,
  };
}

class LookBook {
  constructor({ dataDir, engine = null, systems = null } = {}) {
    this.file = dataDir ? path.join(dataDir, 'looks.json') : null;
    this.engine = engine;
    this.systems = systems;
    this.items = [];
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.items = Array.isArray(raw) ? raw : (raw.looks || []);
      } catch { this.items = []; }
    }
  }
  write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ looks: this.items }, null, 2));
    fs.renameSync(tmp, this.file);
  }
  list(system) {
    return this.items.filter((l) => !system || l.system === system).map((l) => ({ ...l, keys: (l.keys || []).map((k) => ({ ...k })) }));
  }
  save(body) {
    const prev = this.items.find((l) => l.id === body.id);
    const look = cleanLook(body, prev);
    const i = this.items.findIndex((l) => l.id === look.id);
    if (i >= 0) this.items[i] = look;
    else this.items.push(look);
    this.write();
    return look;
  }
  remove(id) {
    this.items = this.items.filter((l) => l.id !== id);
    this.write();
    return { ok: true };
  }
  async recall(id) {
    const look = this.items.find((l) => l.id === id);
    if (!look) throw Object.assign(new Error(`No look ${id}`), { status: 404 });
    const steps = [];
    if (look.system === 'rs6') {
      if (!this.engine) throw Object.assign(new Error('RS6 is not available'), { status: 409 });
      await this.engine.recall(look.preset);
      steps.push('preset');
    } else if (look.system === 'e2' || look.system === 'pixelhue') {
      await this.systems.recall(look.system, look.preset, { target: 'preview' });
      steps.push('preset');
    } else if (look.system === 'atem' && look.preset !== '' && look.preset != null) {
      await this.systems.atem('preview', { source: look.preset });
      steps.push('preview');
    }
    for (const key of look.keys || []) {
      if (look.system !== 'atem' || !this.systems) continue;
      if (String(key.id).startsWith('dsk')) await this.systems.atem('dskOnAir', { key: Number(String(key.id).replace(/^dsk/, '')), on: !!key.on });
      else await this.systems.atem('uskOnAir', { key: Number(key.id), on: !!key.on });
      steps.push(`${key.id}:${key.on ? 'on' : 'off'}`);
    }
    return { ok: true, id: look.id, target: 'preview', absolute: true, steps };
  }
}

module.exports = { LookBook, cleanLook };
