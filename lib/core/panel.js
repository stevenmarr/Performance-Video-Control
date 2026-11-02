'use strict';
// Panel lockout and safe mode.
// Lock freezes the Stream Deck (except unlock and health ack). The web UI stays
// up so a laptop can still run the show.
// Safe mode refuses power, show load, and turning a module off. Takes still run.

function createPanel(store, onChange) {
  const api = {
    get locked() { return !!store.panel.locked; },
    get safe() { return !!store.panel.safe; },
    get pinSet() { return !!(store.panel.pin && store.panel.pin.length); },
    snapshot() { return { locked: api.locked, safe: api.safe, pinSet: api.pinSet }; },
    lock() {
      store.panel.locked = true;
      onChange();
      return api.snapshot();
    },
    unlock(pin) {
      const want = store.panel.pin || '';
      const got = pin == null ? '' : String(pin);
      if (want && got !== want) { const e = new Error('PIN does not match'); e.status = 403; throw e; }
      store.panel.locked = false;
      onChange();
      return api.snapshot();
    },
    setSafe(on) {
      store.panel.safe = on === undefined ? !store.panel.safe : !!on;
      onChange();
      return api.snapshot();
    },
    setPin(current, next) {
      if (api.locked) { const e = new Error('Unlock the panel before changing the PIN'); e.status = 423; throw e; }
      const want = store.panel.pin || '';
      if (want && String(current || '') !== want) { const e = new Error('PIN does not match'); e.status = 403; throw e; }
      store.panel.pin = String(next == null ? '' : next).slice(0, 32);
      onChange();
      return { pinSet: api.pinSet };
    },
    allows(action, meta) {
      if (!api.locked) return true;
      return !!(meta && meta.locked);
    },
  };
  return api;
}

module.exports = { createPanel };
