'use strict';
// Shared selected M/E, ARM (gang-all-M/Es) latch, and selected PTZ camera for the ATEM Micro Panel,
// the Stream Deck, and the TourBox. One instance is created in createServer and handed to each
// service, so a press on one surface is seen on the others. Pure state: no I/O.
const { EventEmitter } = require('events');

function clampMe(n) { return Math.max(1, Math.min(4, Math.round(Number(n) || 1))); }
function cleanCamera(id) {
  if (id == null || id === '') return null;
  return String(id).slice(0, 80);
}

class DeskSelection extends EventEmitter {
  constructor({ me = 1, armed = false, camera = null } = {}) {
    super();
    this._me = clampMe(me);
    this._armed = !!armed;
    this._camera = cleanCamera(camera);
  }

  get me() { return this._me; }
  get armed() { return this._armed; }
  get camera() { return this._camera; }

  // M/Es that CUT, AUTO and the T-bar should fire. `count` is how many the switcher actually has.
  mes(count) {
    const n = Math.max(1, Math.round(Number(count) || 1));
    if (this._armed) return Array.from({ length: n }, (_, i) => i + 1);
    return [Math.min(this._me, n)];
  }

  snapshot() { return { me: this._me, armed: this._armed, camera: this._camera }; }

  set({ me, armed, camera, source } = {}) {
    let changed = false;
    if (me !== undefined) {
      const n = clampMe(me);
      if (n !== this._me) { this._me = n; changed = true; }
    }
    if (armed !== undefined && !!armed !== this._armed) { this._armed = !!armed; changed = true; }
    if (camera !== undefined) {
      const c = cleanCamera(camera);
      if (c !== this._camera) { this._camera = c; changed = true; }
    }
    const out = this.snapshot();
    if (changed) this.emit('change', { ...out, source: source || null });
    return out;
  }
}

module.exports = { DeskSelection, clampMe, cleanCamera };
