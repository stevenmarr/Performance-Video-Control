'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const map = require('../lib/decks/atem-map');
const { SURFACES } = require('../lib/decks/surfaces');
const { show } = require('../lib/decks/faces');

const view = {
  mes: [{ index: 0, program: 2, preview: 1, style: 'MIX', mixRate: 30, handle: 0, wipe: 0, bus: [
    { id: 1, long: 'Camera Left', short: 'CamL' },
    { id: 2, long: 'Camera Right', short: 'CamR' },
  ] }],
  macros: [{ index: 0, isUsed: true, name: 'Open' }],
};

test('button maps are shared across M/Es until the ATEM says otherwise', () => {
  let stored = map.cleanMap(null);
  stored = map.assignSlot(stored, view, 0, 0, 2);
  assert.equal(map.slotList(stored, view, 0)[0].id, 2);
  assert.equal(map.slotList(stored, view, 1)[0].id, 2);
  const per = { ...view, busMap: true };
  stored = map.assignSlot(stored, per, 1, 0, 1);
  assert.equal(map.slotList(stored, per, 0)[0].id, 2);
  assert.equal(map.slotList(stored, per, 1)[0].id, 1);
});

test('a + XL switcher page matches the drawn rows and a Mini keeps HOME and PAGE', () => {
  const desk = { armed: ['atem'], byKey: { atem: { view, buttonMap: map.cleanMap(null) } } };
  const xl = show(SURFACES.plusxl, desk, { system: 'atem', page: 0 });
  const row = (r) => xl.keys.filter((k) => k.row === r).sort((a, b) => a.col - b.col).map((k) => k.label);
  assert.deepEqual(row(0), ['HOME', 'INFO', '', '', 'SWITCHER', 'ROUTER', 'AUDIO', 'KEYS', 'MV']);
  assert.equal(row(1)[7], 'MACRO');
  assert.equal(row(1)[8], 'CUT');
  assert.equal(row(2)[8], 'TRANS');
  assert.equal(row(3)[8], 'SHIFT');
  assert.equal(xl.keys.find((k) => k.caption === 'PGM').tone, 'stop');
  const mini = show(SURFACES.mini, desk, { system: 'atem', page: 0 });
  assert.equal(mini.keys.find((k) => k.col === 0 && k.row === 0).label, 'HOME');
  assert.equal(mini.keys.find((k) => k.col === 2 && k.row === 1).label, 'PAGE');
  assert.ok(mini.pages > 1);
});
