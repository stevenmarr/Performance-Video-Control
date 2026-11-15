'use strict';
// 0.11.0 per-install UI preferences (kept by the server in systems.json, so every browser on this install shares them):
// CCPREFS.get(key, fallback), CCPREFS.set(key, value) (null deletes), CCPREFS.ready (a promise), CCPREFS.on(fn).
// A localStorage copy covers the moment before the server answers and an offline server.
(() => {
  const LS = 'cc.prefs'; let prefs = {}; const subs = [];
  try { prefs = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { prefs = {}; }
  const keep = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch { /* full */ } };
  const ready = fetch('/api/ui-prefs').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.prefs) { prefs = j.prefs; keep(); subs.forEach((f) => f()); } }).catch(() => {});
  const get = (k, d) => (Object.prototype.hasOwnProperty.call(prefs, k) ? JSON.parse(JSON.stringify(prefs[k])) : d);
  const set = (k, v) => {
    if (v === null || v === undefined) delete prefs[k]; else prefs[k] = v; keep();
    return fetch(`/api/ui-prefs/${encodeURIComponent(k)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v === undefined ? null : v }) }).catch(() => {});
  };
  window.CCPREFS = { get, set, ready, on: (f) => subs.push(f) };
})();
