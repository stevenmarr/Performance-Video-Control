'use strict';
// Paint knob / slider writes from the browser (CAMERA CONTROL). One lane per camera + parameter:
//   * at most one request in flight per lane; while it is out, newer values only replace the pending one
//     (latest wins), so a fast drag never queues a backlog and never lands out of order;
//   * at most one request per intervalMs (80 ms = 12.5 Hz) while dragging;
//   * flush() (release, wheel stop, +/-) sends the final value as soon as the lane is free, never dropped;
//   * an error is reported once per lane, and only for the newest value (a superseded value's refusal is moot).
// Loaded as a plain <script> (window.CCPaintSend) and by node tests (module.exports).
(function (root) {
  function createPaintSender({ send, intervalMs = 80, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout, onError = null } = {}) {
    if (typeof send !== 'function') throw new Error('createPaintSender needs send()');
    const lanes = new Map();
    const lane = (key) => { let l = lanes.get(key); if (!l) { l = { key, inflight: false, has: false, value: undefined, ctx: undefined, last: -Infinity, timer: null, gen: 0, sentGen: 0 }; lanes.set(key, l); } return l; };
    function pump(l) {
      if (l.inflight || !l.has) return;
      const wait = intervalMs - (now() - l.last);
      if (wait > 0 && !l.flush) { if (l.timer == null) l.timer = schedule(() => { l.timer = null; pump(l); }, wait); return; }
      if (l.timer != null) { cancel(l.timer); l.timer = null; }
      const value = l.value; const ctx = l.ctx; const gen = l.gen;
      l.has = false; l.flush = false; l.inflight = true; l.last = now();
      Promise.resolve().then(() => send(value, ctx, l.key)).then(() => { l.sentGen = gen; }, (e) => {
        // only the newest value's refusal matters; a newer pending value will be tried next
        if (!l.has && gen === l.gen && onError) onError(e, value, ctx, l.key);
      }).then(() => {
        l.inflight = false;
        if (l.has) pump(l); // an idle lane is kept: it remembers when it last sent, for the rate gap
      });
    }
    // Queue a value for this lane. { now: true } = final value (pointer up, a +/- tap): skip the rate gap.
    function submit(key, value, ctx, { now: final = false } = {}) {
      const l = lane(key);
      l.value = value; l.ctx = ctx; l.has = true; l.gen += 1;
      if (final) l.flush = true;
      pump(l);
    }
    const busy = (key) => { const l = lanes.get(key); return !!(l && (l.inflight || l.has)); };
    return { submit, busy, get size() { return lanes.size; } };
  }
  const api = { createPaintSender };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CCPaintSend = api;
}(typeof window !== 'undefined' ? window : null));
