'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const map = require('../lib/decks/atem-map');
const { SURFACES } = require('../lib/decks/surfaces');
const { show } = require('../lib/decks/faces');
const { dialSignature } = require('../lib/decks/look');
const { segmentSvg } = require('../lib/deck-image');

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
  assert.deepEqual(row(0).map((label) => label.split('\n')[0]), ['HOME', 'ATEM —', '', 'SWITCHER', 'ROUTER', 'AUDIO', 'KEYS/SS', 'MULTIVIEWER', 'SELECT']);
  assert.equal(row(1)[7], 'SHIFT');
  assert.equal(row(1)[7] && xl.keys.find((k) => k.row === 1 && k.col === 7).caption, 'MACROS');
  assert.equal(xl.keys.find((k) => k.row === 1 && k.col === 7).faceStyle.arrow, 'left');
  assert.equal(row(1)[8], 'ME 1');
  assert.equal(row(2)[7], '');
  assert.equal(row(2)[8], 'CUT');
  assert.equal(row(3)[7], 'SHIFT');
  assert.equal(row(3)[8], 'TRANS');
  const cut = xl.keys.find((k) => k.row === 2 && k.col === 8);
  const trans = xl.keys.find((k) => k.row === 3 && k.col === 8);
  assert.equal(cut.faceStyle.bar, cut.faceStyle.fill);
  assert.equal(trans.faceStyle.bar, trans.faceStyle.fill);
  const tabs = xl.keys.filter((k) => k.row === 0 && k.faceStyle && k.faceStyle.tab);
  assert.equal(tabs.length, 5);
  assert.equal(tabs.find((k) => k.label === 'MULTIVIEWER').faceStyle.value, 'MULTI-\nVIEWER');
  assert.equal(xl.keys.find((k) => k.col === 0 && k.row === 0).faceStyle.house, true);
  assert.equal(xl.keys.find((k) => k.label === 'SWITCHER').faceStyle.title, '');
  assert.equal(xl.keys.some((k) => /FLEX/.test(`${k.label} ${k.caption} ${(k.faceStyle && k.faceStyle.title) || ''} ${(k.faceStyle && k.faceStyle.value) || ''}`)), false);
  assert.equal(xl.keys.find((k) => k.caption === 'PGM').tone, 'stop');
  const mini = show(SURFACES.mini, desk, { system: 'atem', page: 0 });
  assert.equal(mini.keys.find((k) => k.col === 0 && k.row === 0).label, 'HOME');
  assert.equal(mini.keys.find((k) => k.col === 2 && k.row === 1).label, 'PAGE');
  assert.ok(mini.pages > 1);
});

test('shift shows the next seven sources and the effect list is the five ATEM styles', () => {
  assert.deepEqual(map.EFFECTS, ['MIX', 'DIP', 'WIPE', 'DVE', 'STING']);
  assert.equal(map.EFFECTS.includes('ARM'), false);
  assert.deepEqual(map.toggleMes([1], 1, 2), [1, 2]);
  assert.deepEqual(map.toggleMes([1, 2], 1, 2), [1]);
  assert.deepEqual(map.toggleMes([2], 2, 2), [1, 2]);
  assert.deepEqual(map.toggleMes([1, 2], 2, 2), [2]);
  assert.deepEqual(map.toggleMes([1], 1, 1), [1]);
  assert.deepEqual(map.fireMes({ me: 1, mes: [2] }), [1]);
  assert.deepEqual(map.fireMes({ me: 2, mes: [1, 2] }), [1, 2]);
  const desk = { armed: ['atem'], byKey: { atem: { view, buttonMap: map.cleanMap(null) } } };
  const shifted = show(SURFACES.plusxl, desk, { system: 'atem', page: 0, atemUi: { shift: 1, me: 1, mes: [1] } });
  assert.equal(shifted.keys.find((k) => k.row === 3 && k.col === 0).caption, '8');
  assert.equal(shifted.keys.find((k) => k.row === 3 && k.col === 7).caption, '8–14');
  const lr = segmentSvg({ kind: 'wipe', pattern: 0, text: 'L-R' }, 200, 100);
  assert.match(lr, /width="32"/);
  assert.doesNotMatch(lr, /polygon/);
  const pills = segmentSvg({ kind: 'effect', text: 'DIP', modes: map.EFFECTS }, 200, 100);
  assert.match(pills, /DIP/);
  assert.match(pills, /STING/);
  assert.doesNotMatch(pills, /ARM/);
});

test('a held transition strip updates as soon as a layer is toggled', () => {
  const rich = {
    mes: [{
      program: 1, preview: 2, style: 'DIP', nextSelection: 1, mixRate: 30, handle: 0, wipe: 0,
      keyers: [{ onAir: true }, { onAir: false }, { onAir: true }, { onAir: false }],
      bus: [{ id: 1, long: 'Camera Left', short: 'CamL' }],
    }],
    dsk: [{ onAir: true, tie: false }, { onAir: false, tie: true }],
    topology: { downstreamKeyers: 2, mixEffects: 1 },
  };
  const desk = { armed: ['atem'], byKey: { atem: { view: rich, buttonMap: map.cleanMap(null) } } };
  const before = show(SURFACES.plusxl, desk, {
    system: 'atem', page: 0,
    atemUi: { me: 1, mes: [1], transHold: true, next: { bkgd: true, keys: [true, false, false, false], dsk: [false, false] } },
  });
  const after = show(SURFACES.plusxl, desk, {
    system: 'atem', page: 0,
    atemUi: { me: 1, mes: [1], transHold: true, next: { bkgd: true, keys: [false, true, false, false], dsk: [true, false] } },
  });
  const trans = (face) => face.keys.find((k) => k.row === 3 && k.col === 8);
  assert.equal(trans(before).label, 'TRANS');
  assert.notEqual(trans(before).caption, trans(after).caption);
  assert.equal(trans(after).faceStyle.layers.find((layer) => layer.id === 'K2').next, true);
  assert.equal(trans(after).faceStyle.layers.find((layer) => layer.id === 'K1').air, true);
  assert.equal(trans(after).faceStyle.layers.find((layer) => layer.id === 'K2').air, false);
  assert.notEqual(dialSignature(before.dials, {}), dialSignature(after.dials, {}));
  assert.equal(after.dials.some((dial) => dial.strip && dial.strip.touch && dial.strip.touch.type === 'me'), false);
  assert.equal(after.dials[0].strip.text, 'BKGD');
  assert.equal(after.dials[2].strip.text, 'KEY 2');
  assert.equal(after.dials[2].strip.on, true);
  assert.equal(after.dials.filter((dial) => dial.strip && dial.strip.touch && dial.strip.touch.type === 'dsk').length, 1);
  assert.equal(after.dials[5].strip.text, 'DSK 1');
  assert.equal(after.dials[5].strip.on, true);
});
