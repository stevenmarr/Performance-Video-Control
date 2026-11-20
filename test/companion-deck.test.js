'use strict';
// 0.32.0: the Stream Deck pages Control Center draws (HOME, PTZ with its paint knobs,
// ATEM, CONSOLE) go to Companion through virtual decks (companion-<surface>), with a
// touch-strip readout and a knob per dial. GET /api/companion/deck, POST .../key|dial.
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const { CompanionBridge } = require('../lib/companion/bridge');
const mirror = require('../lib/companion/deck-mirror');
const { snapshot } = require('../lib/deck');
const { catalogFor } = require('../lib/drivers/ptz-commands');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cdeck-'));
  const svc = new DeckService({ dataDir: dir, systems: null, usbEnv: { CC_DECK_USB: '0' } });
  const values = { rGain: 0, bGain: 0, iris: 26 };
  const view = () => ({ rev: 1, selected: 'cam1', cameras: [{ id: 'cam1', name: 'CAM 1', connected: true, series: 'UE150', values }] });
  svc.desk = () => ({ armed: ['ptz'], byKey: { ptz: { cameras: [{ id: 'cam1', name: 'CAM 1', host: '10.0.0.9', port: 80 }], selected: 'cam1' } } });
  svc.ptzSnap = () => snapshot(view(), catalogFor);
  const sent = [];
  svc.runAction = async (a) => {
    sent.push(a);
    if (a.path === '/api/sys/ptz/cmd/step' && a.body && a.body.op in values) values[a.body.op] += a.body.steps;
    return { ok: true };
  };
  const bridge = new CompanionBridge({ dataDir: dir, decks: svc, appVersion: '0.32.0', apiVersion: 9 });
  return { dir, svc, bridge, sent, values };
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('each surface has a Companion virtual deck that is not a USB deck', () => {
  const { dir, svc } = rig();
  const d = svc.companionDevice('plusxl');
  assert.equal(d.id, 'companion-plusxl');
  assert.equal(d.transport, 'companion');
  assert.equal(svc.liveDevice('companion-plus').surfaceId, 'plus');
  assert.equal(svc.liveDevice('companion-nope'), null);
  assert.equal(svc.liveDevice('deck-1'), null);
  cleanup(dir);
});

test('the deck model has HOME, every PTZ page and the CONSOLE, with the + XL knobs as strip readouts', () => {
  const { dir, bridge } = rig();
  const m = bridge.deckModel({ surfaces: 'plusxl' });
  assert.equal(m.surfaces.length, 1);
  const s = m.surfaces[0];
  assert.equal(s.touchRow, 4);
  assert.equal(s.encoderRow, 5);
  assert.deepEqual(s.knobCols, [0, 2, 3, 5, 6, 8]);
  assert.equal(s.companionLayout, 'streamdeck-plus-xl');
  assert.deepEqual(s.at, { system: 'home', page: 0 });
  const ids = s.pages.map((p) => p.id);
  assert.equal(ids[0], 'home.0');
  assert.ok(ids.includes('ptz.0'), ids.join(','));
  assert.ok(ids.some((id) => id.startsWith('console.')));
  const paint = s.pages.filter((p) => p.system === 'ptz').find((p) => p.dials.some((d) => d.widget === 'gainRb'));
  assert.ok(paint, 'a PTZ page with the R / B gain knob');
  const gain = paint.dials.find((d) => d.widget === 'gainRb');
  assert.ok(s.knobCols.includes(gain.col));
  assert.match(gain.lines.join(' '), /R GAIN 0/);
  assert.match(gain.lines.join(' '), /B GAIN 0/);
  assert.equal(gain.color, '#ff8a8f', 'the R side is active, so the strip is the R tint');
  assert.ok(m.widgets.gainRb && m.widgets.iris && m.widgets.masterDetail, 'standalone strip displays');
  assert.ok(!m.widgets.trackSens, 'tracking dials are not offered');
  assert.equal(bridge.deckModel({ surfaces: 'plusxl' }).rev, m.rev, 'rev is stable');
  cleanup(dir);
});

test('a Companion deck follows HOME → PTZ, and its R / B gain knob steps the camera like a USB knob', async () => {
  const { dir, svc, bridge, sent, values } = rig();
  const home = bridge.deckModel({ surfaces: 'plusxl' }).surfaces[0].live;
  const ptzKey = home.keys.find((k) => k.lines.includes('PTZ'));
  assert.ok(ptzKey, 'HOME has a PTZ key');
  await bridge.deckKey('plusxl', { row: ptzKey.row, col: ptzKey.col, event: 'press' });
  await bridge.deckKey('plusxl', { row: ptzKey.row, col: ptzKey.col, event: 'release' });
  let m = bridge.deckModel({ surfaces: 'plusxl' });
  assert.equal(m.surfaces[0].at.system, 'ptz');
  const page = m.surfaces[0].pages.find((p) => p.id === `ptz.${m.surfaces[0].at.page}`);
  const idx = page.dials.findIndex((d) => d.widget === 'gainRb');
  assert.ok(idx >= 0, 'the PTZ page has the gain knob');
  const index = page.dials[idx].index;
  const layout = m.layoutRev;
  await bridge.deckDial('plusxl', { index, event: 'rotate', ticks: 2 });
  const step = sent.filter((a) => a.path === '/api/sys/ptz/cmd/step');
  assert.equal(step.at(-1).body.op, 'rGain');
  assert.equal(step.at(-1).body.cam, 'cam1');
  await bridge.deckDial('plusxl', { index, event: 'push' });
  await bridge.deckDial('plusxl', { index, event: 'rotate', ticks: -1 });
  assert.equal(sent.filter((a) => a.path === '/api/sys/ptz/cmd/step').at(-1).body.op, 'bGain');
  m = bridge.deckModel({ surfaces: 'plusxl' });
  const strip = m.surfaces[0].live.dials.find((d) => d.index === index);
  assert.ok(values.rGain > 0 && values.bGain < 0);
  assert.match(strip.lines.join(' '), />B GAIN -/);
  assert.equal(m.layoutRev, layout, 'a new value does not change the preset layout');
  cleanup(dir);
  svc.dialDown.forEach((h) => clearTimeout(h.timer));
});

test('a pinned press moves the Companion deck to that page first; bad input is refused', async () => {
  const { dir, bridge } = rig();
  await bridge.deckKey('plusxl', { row: 3, col: 8, event: 'press', pin: 'ptz.0' });
  await bridge.deckKey('plusxl', { row: 3, col: 8, event: 'release', pin: 'ptz.0' });
  assert.deepEqual(bridge.deckModel({ surfaces: 'plusxl' }).surfaces[0].at, { system: 'ptz', page: 0 });
  await bridge.deckDial('plusxl', { index: 0, event: 'tap', pin: { system: 'home', page: 0 } });
  assert.equal(bridge.deckModel({ surfaces: 'plusxl' }).surfaces[0].at.system, 'home');
  await assert.rejects(bridge.deckKey('plusxl', { row: 9, col: 0 }), /not a key/);
  await assert.rejects(bridge.deckKey('mini', { row: 0, col: 0 }), /Unknown surface/);
  await assert.rejects(bridge.deckDial('xl', { index: 0, event: 'rotate', ticks: 1 }), /not a knob/);
  await assert.rejects(bridge.deckDial('plusxl', { index: 0, event: 'rotate', ticks: 0 }), /ticks/);
  await assert.rejects(bridge.deckWidget('nope', { event: 'push' }), /Unknown dial/);
  cleanup(dir);
});

test('a standalone R / B gain knob keeps its own R / B step', async () => {
  const { dir, bridge, sent } = rig();
  await bridge.deckWidget('gainRb', { event: 'rotate', ticks: 1 });
  assert.equal(sent.at(-1).body.op, 'rGain');
  const r = await bridge.deckWidget('gainRb', { event: 'push' });
  assert.equal(r.stepIndex, 1);
  await bridge.deckWidget('gainRb', { event: 'rotate', ticks: 1 });
  assert.equal(sent.at(-1).body.op, 'bGain');
  assert.match(bridge.deckModel({ surfaces: 'plusxl' }).widgets.gainRb.lines.join(' '), />B GAIN/);
  cleanup(dir);
});

test('a deck page export puts keys on top, the strip readouts on row 4 and the knobs on row 5', () => {
  const { dir, bridge } = rig();
  const out = bridge.deckCompanionConfig('plusxl', 'ptz.0');
  const j = out.json;
  assert.match(out.name, /\.companionconfig$/);
  assert.equal(j.version, 6);
  assert.equal(j.type, 'page');
  assert.equal(j.page.surfaceLayout, 'streamdeck-plus-xl');
  assert.deepEqual(j.page.gridSize, { minColumn: 0, maxColumn: 8, minRow: 0, maxRow: 5 });
  assert.deepEqual(Object.keys(j.page.controls[4]).map(Number), [0, 2, 3, 5, 6, 8]);
  assert.deepEqual(Object.keys(j.page.controls[5]).map(Number), [0, 2, 3, 5, 6, 8]);
  const knob = j.page.controls[5][3];
  assert.equal(knob.options.rotaryActions, true);
  assert.equal(knob.steps[0].action_sets.rotate_left[0].action, 'cc_deck_dial');
  assert.equal(knob.steps[0].action_sets.rotate_left[0].options.delta, '-1');
  assert.equal(knob.steps[0].action_sets.rotate_right[0].options.pin, 'ptz.0');
  const strip = j.page.controls[4][3];
  assert.equal(strip.steps[0].action_sets.down[0].options.event, 'tap');
  assert.equal(strip.feedbacks[0].type, 'cc_deck_look');
  assert.equal(strip.feedbacks[0].options.part, 'strip');
  const key = j.page.controls[0][0];
  assert.equal(key.steps[0].action_sets.down[0].action, 'cc_deck_key');
  assert.equal(key.steps[0].action_sets.up[0].options.event, 'release');
  assert.equal(j.instances.ccPvControlCenter.moduleId, 'pvllc-control-center');
  const whole = bridge.deckCompanionConfig('plusxl', '').json;
  assert.equal(Object.keys(whole.page.controls[0]).length, 9, 'the whole deck has every key');
  assert.equal(whole.page.controls[0][0].steps[0].action_sets.down[0].options.pin, '');
  assert.throws(() => bridge.deckCompanionConfig('plusxl', 'ptz.99'), /No page/);
  cleanup(dir);
});

test('mirror helpers: a house key reads HOME, ATEM dials keep their own readout', () => {
  assert.deepEqual(mirror.keySlot({ row: 0, col: 0, faceStyle: { house: true }, nav: 'home' }).lines, ['HOME']);
  const atem = mirror.dialSlot({ atem: 'time', label: 'AUTO', readout: '30f', strip: { kind: 'time', text: '30f' } }, {});
  assert.deepEqual(atem.lines, ['AUTO', '30f']);
  assert.equal(mirror.dialSlot(null), null);
  assert.ok(mirror.widgetNames().find((w) => w.id === 'gainRb').pair);
});

test('the routes, the long-poll and the feature flag are wired', () => {
  const server = read('lib/server.js');
  assert.match(server, /url\.pathname === '\/api\/companion\/deck'/);
  assert.match(server, /companion\\\/deck\\\/\(\[\\w-\]\+\)\\\/key/);
  assert.match(server, /companion\\\/dials\\\/\(\[\\w-\]\+\)/);
  assert.match(read('lib/engine.js'), /'companionDeck'/);
  assert.match(read('public/companion-tab.js'), /DECK PAGES/);
});
