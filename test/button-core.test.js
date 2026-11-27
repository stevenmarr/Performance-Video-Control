'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CATEGORIES, ROLE_CATEGORY, categoryStyle, cleanButton, migrateLegacyButton,
  liveLook, SharedButtonLibrary, libraryPath, SCHEMA_VERSION,
} = require('../lib/surfaces/button-core');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-btn-'));

test('every category has a fill and a bar, and colour is by job not by system', () => {
  const jobs = ['nav', 'target', 'take', 'bus', 'recall', 'paint', 'motion', 'route', 'mode', 'status', 'danger'];
  assert.deepEqual(Object.keys(CATEGORIES).sort(), jobs.sort());
  assert.equal(categoryStyle('take').fill, '#C42020');
  assert.equal(categoryStyle('paint').bar, '#7c8cff');
  assert.equal(ROLE_CATEGORY.program, 'bus');
  assert.equal(ROLE_CATEGORY.macro, 'recall');
  assert.equal(ROLE_CATEGORY.nav, 'nav');
  assert.throws(() => categoryStyle('atem'), /Unknown category/);
});

test('a v1 button keeps follow-selected as the default target', () => {
  const b = cleanButton({ name: 'Iris / Gain', kind: 'dial', category: 'paint', system: 'ptz' });
  assert.equal(b.schemaVersion, SCHEMA_VERSION);
  assert.equal(b.kind, 'dial');
  assert.equal(b.category, 'paint');
  assert.deepEqual(b.target, { mode: 'follow' });
});

test('legacy ATEM library buttons migrate to category plus kind', () => {
  const cut = migrateLegacyButton({
    id: 'bcut', name: 'CUT', element: 'button', role: 'hot',
    text: 'CUT', actions: { press: [{ action: 'atem.cut' }] },
  });
  assert.equal(cut.kind, 'key');
  assert.equal(cut.category, 'take');
  assert.equal(cut.do.press.verb, 'trigger');
  assert.equal(cut.do.press.cap, 'atem.cut');
  const iris = migrateLegacyButton({
    id: 'biris', name: 'Iris', element: 'encoder', role: 'toggle',
    actions: { turn: [{ action: 'ptz.iris' }], push: [{ action: 'ptz.pair' }] },
  });
  assert.equal(iris.kind, 'dial');
  assert.equal(iris.category, 'mode');
  assert.equal(iris.do.turn.verb, 'step');
});

test('the shared library lives under surfaces/ and is never packable in a show', () => {
  const dir = tmp();
  const lib = new SharedButtonLibrary({ dataDir: dir });
  assert.equal(lib.packableInShow(), false);
  assert.equal(libraryPath(dir), path.join(dir, 'surfaces', 'buttons.json'));
  lib.save({ name: 'CUT', kind: 'key', category: 'take', system: 'atem' });
  assert.equal(fs.existsSync(path.join(dir, 'surfaces', 'buttons.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'button-library.json')), false);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'surfaces', 'buttons.json'), 'utf8'));
  assert.equal(raw.shared, true);
  assert.equal(raw.packableInShow, false);
  assert.equal(raw.buttons[0].category, 'take');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an existing button-library.json is migrated into the shared surfaces file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'button-library.json'), JSON.stringify({
    version: 2,
    buttons: [{ id: 'bpgm', name: 'Program', element: 'button', role: 'program', text: 'PGM 1' }],
  }));
  const lib = new SharedButtonLibrary({ dataDir: dir });
  assert.equal(lib.list().length, 1);
  assert.equal(lib.list()[0].category, 'bus');
  assert.equal(lib.migratedFrom, path.join(dir, 'button-library.json'));
  assert.equal(fs.existsSync(path.join(dir, 'surfaces', 'buttons.json')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live look: controls get a frame and LIVE corner; target keys fill red', () => {
  const paint = { fill: '#222226', bar: '#7c8cff', category: 'paint' };
  const control = liveLook(paint, { kind: 'control', tally: 'pgm' });
  assert.equal(control.fill, '#222226', 'the job colour stays');
  assert.equal(control.liveCorner, true);
  assert.equal(control.live, true);
  assert.equal(control.border, '#E5262E');
  const cam = liveLook({ fill: '#1d1a2b', category: 'target' }, { kind: 'target', tally: 'pgm' });
  assert.equal(cam.fill, '#C42020');
  assert.equal(cam.liveCorner, false);
  const idle = liveLook(paint, { kind: 'control', tally: null });
  assert.equal(idle.liveCorner, undefined);
});
