'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SURFACES } = require('../lib/decks/surfaces');
const { show } = require('../lib/decks/faces');
const { homePages, TARGET_SLOTS } = require('../lib/surfaces/home-page');

const desk = {
  armed: ['rs6', 'ptz', 'e2'],
  byKey: {
    ptz: { cameras: [{ id: 'cam1', name: 'Wide', tally: true }] },
  },
};

test('the + XL HOME page follows the four-zone grammar', () => {
  const pages = homePages(SURFACES.plusxl, desk.armed, desk);
  assert.equal(pages.length, 1);
  const keys = pages[0].keys;
  assert.equal(keys.length, 36);
  const at = (c, r) => keys.find((k) => k.col === c && k.row === r);
  assert.equal(at(0, 0).label, 'HOME');
  assert.equal(at(0, 0).on, true);
  assert.equal(at(0, 1).label, 'SYSTEM');
  assert.equal(at(0, 1).nav, 'chooser');
  assert.equal(at(0, 1).hold, 'helpMode');
  assert.match(at(0, 2).label, /PAGE/);
  assert.match(at(0, 3).label, /PAGE/);
  assert.deepEqual(
    keys.filter((k) => k.nav === 'system').map((k) => k.system),
    ['rs6', 'ptz', 'e2'],
  );
  assert.equal(at(1, 0).label, 'RS6');
  assert.equal(at(2, 0).label, 'PTZ');
  assert.equal(at(2, 0).tone, 'stop', 'a tallied PTZ is solid red — it is a target key');
  assert.equal(at(3, 0).label, 'E2');
  assert.equal(at(1, 1).label, 'CUES');
  assert.equal(at(2, 1).label, 'PRESETS');
  assert.equal(at(3, 1).label, 'CONSOLE');
  assert.equal(at(3, 1).nav, 'console');
  assert.equal(at(4, 1).label, 'SELF-TEST');
  assert.equal(at(8, 0).label, 'ON AIR');
  assert.equal(at(8, 0).tone, 'stop');
  assert.equal(at(8, 1).label, 'LOCK');
  assert.equal(at(8, 2).label, 'LINK');
  assert.equal(at(8, 3).label, 'ALERTS');
  assert.equal(pages[0].dials.length, 0, 'HOME is not a paint page');
  // function rows 3–4 stay empty (except NAV / STATUS)
  for (const col of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(at(col, 2).tone, 'blank');
    assert.equal(at(col, 3).tone, 'blank');
  }
});

test('show() uses the new HOME on + XL and keeps the packed HOME on other decks', () => {
  const xl = show(SURFACES.plusxl, desk, {});
  assert.equal(xl.designId, 'core-home');
  assert.equal(xl.keys.find((k) => k.col === 0 && k.row === 0).label, 'HOME');
  assert.ok(xl.keys.some((k) => k.label === 'CUES'));
  const classic = show(SURFACES.xl, desk, {});
  assert.equal(classic.title, 'HOME');
  assert.ok(!classic.keys.some((k) => k.label === 'CUES'), 'the packed HOME on an XL is unchanged');
  assert.deepEqual(classic.keys.filter((k) => k.nav === 'system').map((k) => k.system), ['rs6', 'ptz', 'e2']);
});

test('a ninth system overflows onto the next HOME page and moves no function key', () => {
  const many = ['ptz', 'atem', 'rs6', 'e2', 'pixelhue', 'pixera', 'millumin', 'mitti', 'videohub'];
  assert.ok(many.length > TARGET_SLOTS);
  const pages = homePages(SURFACES.plusxl, many, { armed: many });
  assert.equal(pages.length, 2);
  assert.equal(pages[0].keys.filter((k) => k.nav === 'system').length, 7);
  assert.equal(pages[1].keys.filter((k) => k.nav === 'system').map((k) => k.system)[0], 'mitti');
  const cues0 = pages[0].keys.find((k) => k.label === 'CUES');
  const cues1 = pages[1].keys.find((k) => k.label === 'CUES');
  assert.equal(cues0.col, cues1.col);
  assert.equal(cues0.row, cues1.row);
});
