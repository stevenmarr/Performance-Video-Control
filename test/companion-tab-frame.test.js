'use strict';
// 0.31.2: the COMPANION tab must not rebuild Companion's iframe on every status
// change. The module says hello every 30 s with a new `at`, the 10 s poll saw
// `module` change and repainted the whole tab, and each new iframe loaded
// Companion's UI at / which redirects to Connections: the "page keeps reloading
// back to Connections" loop. Runs public/companion-tab.js against a tiny fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'companion-tab.js'), 'utf8');

function el(id) {
  const e = { id, writes: 0, _html: '', tagName: 'DIV', listeners: {} };
  Object.defineProperty(e, 'innerHTML', { get: () => e._html, set: (h) => { e._html = h; e.writes += 1; if (e.onHtml) e.onHtml(h); } });
  e.addEventListener = (t, f) => { e.listeners[t] = f; };
  e.contains = () => false;
  return e;
}

function harness() {
  const root = el('companionRoot');
  let left = null; let right = null;
  root.onHtml = (h) => {
    if (h.includes('id="cmpLeft"')) { left = el('cmpLeft'); right = el('cmpRight'); } else { left = null; right = null; }
  };
  root.querySelector = (s) => (s === '#cmpLeft' ? left : s === '#cmpRight' ? right : null);
  let view = null;
  let interval = null;
  const winListeners = {};
  const ctx = {
    console,
    JSON, Date, Promise, String, Number, Array, Object,
    localStorage: { getItem: () => null, setItem() {} },
    document: { hidden: false, activeElement: null, querySelector: (s) => (s === '#companionRoot' ? root : null) },
    setInterval: (f) => { interval = f; return 1; },
    clearInterval() {},
    window: null,
  };
  ctx.window = {
    addEventListener: (t, f) => { winListeners[t] = f; },
    CC: {
      api: async () => JSON.parse(JSON.stringify(view)),
      toast() {}, run: (p) => p, esc: (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
      getTab: () => 'companion',
    },
  };
  vm.createContext(ctx);
  return {
    root, ctx, winListeners,
    get right() { return right; }, get left() { return left; },
    setView(v) { view = v; },
    async tick() { interval(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); },
    run() { vm.runInContext(src, ctx); },
  };
}

const baseView = (over = {}) => ({
  config: { host: '127.0.0.1', port: 8000 }, webUrl: 'http://127.0.0.1:8000',
  status: { checked: true, online: true, httpApi: true, connections: [], checkedAt: '2026-11-17T12:00:00Z' },
  module: { version: '0.11.1', label: 'cc', rev: 'r1', presets: 4, at: '2026-11-17T12:00:00Z', current: true, stale: false },
  moduleId: 'pvllc-control-center', moduleMinVersion: '0.10.0', moduleRepo: 'https://example.invalid/repo',
  decks: { drive: true, setting: 'auto', companionUsed: true, released: 0 },
  rev: 'r1', syncSeq: 0, syncedAt: null, counts: { buttons: 4, pages: 1 }, pages: [],
  ...over,
});

test('poll repaint after a module hello keeps the iframe; address / online changes rebuild it', async () => {
  const h = harness();
  h.setView(baseView());
  h.run();
  h.winListeners['cc:tab']({ detail: 'companion' }); // the app switching to the tab starts the poll
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.ok(h.right, 'two-column layout painted');
  assert.match(h.right.innerHTML, /<iframe class="cmp-frame" src="http:\/\/127\.0\.0\.1:8000"/);
  const right = h.right;
  const frameWrites = right.writes;
  const leftWrites = h.left.writes;

  // The module says hello again: only `at` changes. The old code rebuilt the iframe here.
  h.setView(baseView({ module: { ...baseView().module, at: '2026-11-17T12:00:30Z' } }));
  await h.tick();
  assert.equal(h.right, right, 'right column element kept');
  assert.equal(right.writes, frameWrites, 'iframe not rewritten by a status-only repaint');
  assert.ok(h.left.writes > leftWrites, 'status column repainted');
  assert.match(h.left.innerHTML, /Module 0\.11\.1/);

  // Decks setting flips: still no iframe rebuild.
  h.setView(baseView({ module: { ...baseView().module, at: '2026-11-17T12:01:00Z' }, decks: { drive: false, setting: false, companionUsed: true, released: 0 } }));
  await h.tick();
  assert.equal(right.writes, frameWrites);

  // Companion goes away: the frame is replaced by the note.
  h.setView(baseView({ status: { ...baseView().status, online: false } }));
  await h.tick();
  assert.ok(right.writes > frameWrites);
  assert.doesNotMatch(right.innerHTML, /<iframe/);
});

test('the tab script never replaces the whole root on a poll once painted', () => {
  // Only paint()'s first layout, the Loading note and the load-error note write root.innerHTML.
  const writes = src.match(/root\.innerHTML\s*=/g) || [];
  assert.equal(writes.length, 3);
  assert.match(src, /if \(key !== frameKey\) \{ right\.innerHTML = frameHtml\(v\); frameKey = key; \}/);
});

// 0.34.0: one web app. The frame shows Companion through Control Center (/companion/, same origin), and the
// COMPANION SERVICE card shows the service Control Center runs. A service state change repaints the card only.
test('0.34.0: the frame is /companion/ and the COMPANION SERVICE card follows the service without reloading the frame', async () => {
  const h = harness();
  const service = { mode: 'managed', managed: true, state: 'running', message: 'Companion is running inside Control Center.', pid: 4242, port: 8000, uptimeSec: 75, restarts: 0, node: { path: '/x/node', version: 'v26.13.1' }, settings: { mode: 'managed', path: '~/companion', configDir: '~/companion-config', port: 8000, nodePath: '', yarnPath: '' }, envOverrides: [] };
  h.setView(baseView({ uiUrl: '/companion/', service }));
  h.run();
  h.winListeners['cc:tab']({ detail: 'companion' });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.match(h.right.innerHTML, /<iframe class="cmp-frame" src="\/companion\/"/);
  assert.match(h.right.innerHTML, /href="\/companion\/" target="_blank"/);
  assert.match(h.left.innerHTML, /COMPANION SERVICE/);
  assert.match(h.left.innerHTML, /RUNNING/);
  assert.match(h.left.innerHTML, /pid 4242 · up 1 min · Node v26\.13\.1 · port 8000/);
  assert.match(h.left.innerHTML, /data-svc="restart"/);
  assert.match(h.left.innerHTML, /data-svc="stop"/);
  assert.match(h.left.innerHTML, /id="cmpSvcManaged" checked/);
  assert.match(h.left.innerHTML, /Control Center runs Companion itself/);
  const frameWrites = h.right.writes;
  h.setView(baseView({ uiUrl: '/companion/', service: { ...service, state: 'backoff', pid: null, restarts: 1, message: 'Companion stopped unexpectedly (exit code 1). Restarting in 2 s.' } }));
  await h.tick();
  assert.match(h.left.innerHTML, /BACKOFF/);
  assert.match(h.left.innerHTML, /Restarting in 2 s/);
  assert.equal(h.right.writes, frameWrites, 'the Companion frame is not reloaded by a service status change');
  h.setView(baseView({ uiUrl: '/companion/', service: { ...service, mode: 'external', managed: false, state: 'external', message: 'Companion is run outside Control Center.' } }));
  await h.tick();
  assert.doesNotMatch(h.left.innerHTML, /data-svc=/);
  assert.match(h.left.innerHTML, /id="cmpSvcManaged">/);
});
