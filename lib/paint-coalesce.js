'use strict';
// Collapse a burst of absolute paint writes into fewer Panasonic HTTP calls.
// The newest target replaces anything not yet on the wire. A target that
// arrives while a call is in flight is sent when that call finishes (after
// the rate-limit gap), so the last step is never dropped.

function createValueCoalescer({ intervalMs = 80, send, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (typeof send !== 'function') throw new Error('createValueCoalescer needs send()');
  const lanes = new Map();

  function drop(l) {
    if (!l.inflight && !l.armed && l.timer == null && !l.waiters.length) lanes.delete(l.key);
  }

  function kick(l) {
    if (l.inflight || l.armed) return;
    if (!l.waiters.length && l.target === l.sent) { drop(l); return; }
    const wait = l.lastSentAt ? Math.max(0, intervalMs - (now() - l.lastSentAt)) : 0;
    if (wait > 0) {
      if (l.timer == null) l.timer = schedule(() => { l.timer = null; kick(l); }, wait);
      return;
    }
    if (l.timer != null) { cancel(l.timer); l.timer = null; }
    l.armed = true;
    Promise.resolve().then(() => {
      l.armed = false;
      if (l.inflight) return;
      const value = l.target;
      const gen = l.gen;
      const waiters = l.waiters.filter((w) => w.gen <= gen);
      l.waiters = l.waiters.filter((w) => w.gen > gen);
      if (!waiters.length && value === l.sent) { drop(l); return; }
      l.inflight = true;
      Promise.resolve()
        .then(() => send(l.cam, l.op, value))
        .then((result) => {
          l.sent = value;
          l.lastSentAt = now();
          l.inflight = false;
          const payload = result && typeof result === 'object' ? result : {};
          for (const w of waiters) w.resolve({ ...payload, value: payload.value !== undefined ? payload.value : value });
          kick(l);
        }, (err) => {
          l.inflight = false;
          for (const w of waiters) w.reject(err);
          // Only a newer waiter retries. Retrying the same target with nobody
          // waiting would spin: the camera already refused this value.
          if (l.waiters.length) kick(l);
          else drop(l);
        });
    });
  }

  function submit(cam, op, value) {
    const key = `${cam}\0${op}`;
    let l = lanes.get(key);
    if (!l) {
      l = { key, cam, op, target: value, sent: undefined, inflight: false, armed: false, timer: null, lastSentAt: 0, gen: 0, waiters: [] };
      lanes.set(key, l);
    }
    l.gen += 1;
    l.target = value;
    const gen = l.gen;
    return new Promise((resolve, reject) => {
      l.waiters.push({ value, gen, resolve, reject });
      kick(l);
    });
  }

  return { submit, get pending() { return lanes.size; } };
}

module.exports = { createValueCoalescer };
