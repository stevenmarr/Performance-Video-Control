'use strict';
// v0.39.1: regressions found after the v0.39.0 combined release.
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const { CompanionBridge } = require('../lib/companion/bridge');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-v039-'));
  const svc = new DeckService({ dataDir: dir, systems: null, usbEnv: { CC_DECK_USB: '0' } });
  svc.desk = () => ({ armed: ['atem'], byKey: { atem: { view: { mes: [{}] }, connected: true } } });
  const sent = [];
  svc.runAction = async (a) => { sent.push(a); return { ok: true }; };
  const bridge = new CompanionBridge({ dataDir: dir, decks: svc, appVersion: '0.39.1', apiVersion: 9 });
  return { dir, svc, bridge, sent };
}

test('SURFACES hands each sub-tab to its editor (BUTTONS, PAGES, TourBox were empty in 0.39.0)', () => {
  const surfaces = read('public/surfaces.js');
  const buttons = read('public/button-library.js');
  const pages = read('public/surface-pages.js');
  const html = read('public/index.html');
  assert.match(surfaces, /cc:surfaces/);
  assert.match(buttons, /addEventListener\('cc:surfaces'[^]*'buttons'/);
  assert.match(pages, /addEventListener\('cc:surfaces'[^]*'pages'/);
  assert.match(surfaces, /#pane-pages/);
  assert.match(surfaces, /#pane-buttons/);
  assert.match(surfaces, /#tbxPanel/);
  assert.doesNotMatch(surfaces, /sd-key|\/api\/surfaces\/apply/, 'the stub Page Builder is gone');
  assert.doesNotMatch(html, /TourBox integration is planned/);
  assert.doesNotMatch(html, /Not connected in this build/);
});

test('every editor script is loaded before surfaces.js, so each is wired before it is moved', () => {
  const html = read('public/index.html');
  const at = (f) => html.indexOf(`/${f}"`);
  for (const f of ['button-library.js', 'surface-pages.js', 'decks.js', 'tourbox.js']) assert.ok(at(f) > 0 && at(f) < at('surfaces.js'), f);
});

test('help mode never swallows keys on the Companion virtual deck', async () => {
  const { dir, svc, bridge, sent } = rig();
  const dev = 'companion-plusxl';
  svc.companionDevice('plusxl');
  const sys = { row: 1, col: 0 };
  // hold SYSTEM for more than 800 ms on the HOME page, which entered help mode in 0.39.0
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  try {
    await bridge.deckKey('plusxl', { ...sys, event: 'press', pin: 'home.0' });
    t += 1200;
    await bridge.deckKey('plusxl', { ...sys, event: 'release', pin: 'home.0' });
  } finally { Date.now = real; }
  assert.equal(!!(svc.helpStates.get(dev) || {}).helpMode, false);
  const before = sent.length;
  const out = await bridge.deckKey('plusxl', { row: 0, col: 1, event: 'press', pin: 'home.0' });
  assert.equal(out.ok, true);
  assert.ok(svc.sessionFor(svc.liveDevice(dev)).system, 'the key navigated');
  assert.ok(sent.length >= before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push, touch and release on an ATEM knob are quiet no-ops, not refusals', async () => {
  const { dir, svc } = rig();
  const device = svc.companionDevice('plusxl');
  svc.liveDevice(device.id);
  svc.faceFor = () => ({ dials: [{ atem: 'me', widget: null }, { widget: null }] });
  for (const ev of ['down', 'up', 'push', 'tap']) {
    const a = await svc._turn(device.id, 0, 0, ev);
    assert.equal(a.ok, true, `atem ${ev}`);
    const b = await svc._turn(device.id, 1, 0, ev);
    assert.equal(b.ok, true, `unbound ${ev}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hello warnings drop an old refusal instead of keeping the module yellow for good', () => {
  const { dir, svc, bridge } = rig();
  svc.noteError('key 1/1 on companion-plusxl', new Error('ATEM not connected'));
  assert.ok(bridge.warnings().some((w) => /Last refused command/.test(w)));
  svc.lastErrors[0].at = new Date(Date.now() - 60000).toISOString();
  assert.equal(bridge.warnings().some((w) => /Last refused command/.test(w)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a label-only Companion key is a quiet no-op; a key with no handler is refused with its reason', async () => {
  const { dir, svc, bridge } = rig();
  const labelOnly = bridge._keyAnswer({ ok: false, noop: true, reason: 'This key has no function' }, { surfaceId: 'plusxl' }, 'press');
  assert.deepEqual(labelOnly, { ok: true, noop: true, reason: 'This key has no function', surface: 'plusxl', event: 'press' });
  const dead = bridge._keyAnswer({ ok: false, noop: true, reason: 'No handler for /api/x' }, { surfaceId: 'plusxl' }, 'press');
  assert.equal(dead.ok, false);
  assert.equal(dead.reason, 'No handler for /api/x');
  assert.equal(bridge._keyAnswer(undefined, { surfaceId: 'plusxl' }, 'release').ok, false);
  // end to end: an info key on the ATEM page answers ok
  svc.companionDevice('plusxl');
  const out = await bridge.deckKey('plusxl', { row: 0, col: 2, event: 'press', pin: 'home.0' });
  assert.equal(out.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ptz.0–ptz.8 keep the v0.38.0 page order; #76 pages start at ptz.9', () => {
  const { GALLERY } = require('../lib/decks/gallery');
  const { show } = require('../lib/decks/faces');
  const { SURFACES } = require('../lib/decks/surfaces');
  const classic = [
    'ptz-msu', 'ptz-rcp-exp', 'ptz-rcp-wb', 'ptz-rcp-dtl', 'ptz-rcp-gamma', 'ptz-rcp-matrix',
    'ptz-presets', 'ptz-matrix', 'ptz-lens',
  ];
  const added = ['ptz-msu-cams', 'ptz-rcp-black', 'ptz-rcp-white', 'ptz-rcp-tone', 'ptz-rcp-detail', 'ptz-rcp-colour'];
  const ids = GALLERY.filter((g) => g.kind === 'ptz').map((g) => g.id);
  assert.deepEqual(ids.slice(0, 9), classic);
  assert.deepEqual(ids.slice(9, 15), added);
  const msu = GALLERY.find((g) => g.id === 'ptz-msu');
  assert.deepEqual(msu.dials.map((d) => d.widget), ['iris', 'masterPed', 'gainRb', 'pedRb', 'zoom', 'focus']);
  const desk = { armed: ['ptz'], byKey: { ptz: { cameras: [{ id: 'cam1', name: 'Wide' }], selected: 'cam1' } } };
  classic.forEach((id, page) => {
    const face = show(SURFACES.plusxl, desk, { system: 'ptz', page });
    assert.equal(face.designId, id, `ptz.${page} should be ${id}`);
  });
  added.forEach((id, i) => {
    const face = show(SURFACES.plusxl, desk, { system: 'ptz', page: 9 + i });
    assert.equal(face.designId, id, `ptz.${9 + i} should be ${id}`);
  });
});
