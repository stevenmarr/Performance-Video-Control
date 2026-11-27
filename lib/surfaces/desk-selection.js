'use strict';
// Shared selected M/E and ARM (gang-all-M/Es) latch for the ATEM Micro Panel and the Stream Deck.
// One instance is created in createServer and handed to both services, so a press on either surface
// is seen on the other. Pure state: no I/O.
const { EventEmitter } = require('events');

function clampMe(n) { return Math.max(1, Math.min(4, Math.round(Number(n) || 1))); }

class DeskSelection extends EventEmitter {
  constructor({ me = 1, armed = false } = {}) {
    super();
    this._me = clampMe(me);
    this._armed = !!armed;
  }

  get me() { return this._me; }
  get armed() { return this._armed; }

  // M/Es that CUT, AUTO and the T-bar should fire. `count` is how many the switcher actually has.
  mes(count) {
    const n = Math.max(1, Math.round(Number(count) || 1));
    if (this._armed) return Array.from({ length: n }, (_, i) => i + 1);
    return [Math.min(this._me, n)];
  }

  snapshot() { return { me: this._me, armed: this._armed }; }

  set({ me, armed, source } = {}) {
    let changed = false;
    if (me !== undefined) {
      const n = clampMe(me);
      if (n !== this._me) { this._me = n; changed = true; }
    }
    if (armed !== undefined && !!armed !== this._armed) { this._armed = !!armed; changed = true; }
    const out = this.snapshot();
    if (changed) this.emit('change', { ...out, source: source || null });
    return out;
  }
}

module.exports = { DeskSelection, clampMe };
