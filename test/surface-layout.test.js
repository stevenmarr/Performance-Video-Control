'use strict';
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SURFACES } = require('../lib/decks/surfaces');
const { knownOffline, boardOf } = require('../lib/decks/known-devices');
const { DeckService } = require('../lib/decks/service');

test('each surface grid matches the hardware, including the + XL strip', () => {
  const plusxl = boardOf(SURFACES.plusxl);
  assert.equal(plusxl.cols, 9);
  assert.equal(plusxl.rows, 4);
  assert.equal(plusxl.keys.length, 36);
  assert.deepEqual(plusxl.knobCols, [0, 2, 3, 5, 6, 8]);
  assert.equal(plusxl.encoders.length, 6);
  assert.equal(plusxl.touch.length, 6);
  assert.deepEqual(plusxl.encoders.map((s) => s.col), plusxl.touch.map((s) => s.col));
  const xl = boardOf(SURFACES.xl);
  assert.equal(xl.cols, 8);
  assert.equal(xl.rows, 4);
  assert.equal(xl.encoders.length, 0);
  assert.equal(xl.touch.length, 0);
  assert.equal(xl.keys.length, 32);
  const plus = boardOf(SURFACES.plus);
  assert.equal(plus.cols, 4);
  assert.equal(plus.rows, 2);
  assert.deepEqual(plus.knobCols, [0, 1, 2, 3]);
  assert.equal(plus.encoders.length, 4);
  assert.equal(boardOf(SURFACES.mini).keys.length, 6);
  assert.equal(boardOf(SURFACES.neo).keys.length, 8);
  assert.equal(boardOf(SURFACES.mk2).keys.length, 15);
  assert.equal(boardOf(SURFACES.mini).encoders.length, 0);
});

test('stored deck ids stay on the list when they are not connected, and the preview stand-in does not', () => {
  const known = knownOffline({
    stacks: { 'old-xl': ['ptz-live'], preview: ['nope'] },
    loaded: { 'gone-mini': ['HOME'] },
    sessions: { preview: { system: null }, 'serial:ABC': { system: 'atem' }, 'usb-path': { system: 'ptz' }, 'old-xl': { system: 'atem' } },
    liveIds: ['live-plus'],
  });
  assert.deepEqual(known.map((d) => d.id), ['gone-mini', 'old-xl', 'usb-path']);
  assert.ok(known.every((d) => d.online === false && d.source === 'stored' && d.model === null && d.surfaceId === null));
});

test('GET /api/decks reports a stored deck as offline and still offers the USB layout stand-in separately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvc-pages-'));
  fs.writeFileSync(path.join(dir, 'decks.json'), JSON.stringify({
    stacks: { 'old-xl': ['ptz-live'] },
    sessions: { preview: { system: null } },
  }));
  const decks = new DeckService({ dataDir: dir, pluginUrl: 'http://127.0.0.1:9' });
  try {
    const view = await decks.view();
    assert.equal(view.plugin.online, false);
    assert.deepEqual(view.devices, []);
    assert.deepEqual(view.known.map((d) => d.id), ['old-xl']);
    assert.equal(view.known[0].online, false);
    assert.equal(view.control.devices[0].id, 'preview');
    assert.equal(view.control.devices[0].transport, 'preview');
    assert.equal(view.surfaces.plusxl.cols, 9);
    assert.equal(view.surfaces.plusxl.knobCols.length, 6);
  } finally {
    decks.stopUsb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
