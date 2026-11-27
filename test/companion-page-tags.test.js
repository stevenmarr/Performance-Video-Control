'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tagFor, displayName, isCcTagged, lastHandBuiltIndex, placeCcPages } = require('../lib/surfaces/companion-pages');

test('CC pages are tagged by id, not by a reserved number range', () => {
  assert.equal(tagFor('ptz.rcp.exposure'), 'cc:ptz.rcp.exposure');
  assert.equal(displayName('PTZ · RCP · Exposure'), 'CC · PTZ · RCP · Exposure');
  assert.equal(isCcTagged({ name: 'My page' }), false);
  assert.equal(isCcTagged({ tag: 'cc:core.home', name: 'CC · HOME' }), true);
});

test('new CC pages append after the last hand-built page and never rewrite one', () => {
  const existing = [
    { name: 'Opener' },
    { name: 'Bumpers' },
    { name: 'Credits' },
  ];
  const { pages, report } = placeCcPages(existing, [
    { id: 'core.home', title: 'HOME' },
    { id: 'ptz.rcp.exposure', title: 'PTZ · RCP · Exposure' },
  ]);
  assert.equal(pages.length, 5);
  assert.equal(lastHandBuiltIndex(pages), 2);
  assert.equal(pages[3].tag, 'cc:core.home');
  assert.equal(pages[4].tag, 'cc:ptz.rcp.exposure');
  assert.equal(pages[0].name, 'Opener');
  assert.equal(report.appended.length, 2);
  assert.equal(report.rewritten.length, 0);
  assert.equal(report.untouched.length, 3);
  assert.equal(report.appendedAfterHandBuilt, true);
});

test('a later apply rewrites only tagged pages and leaves a new hand-built page alone', () => {
  const existing = [
    { name: 'Opener' },
    { name: 'CC · HOME', tag: 'cc:core.home', keys: ['old'] },
    { name: 'Late hand-built' },
  ];
  const { pages, report } = placeCcPages(existing, [
    { id: 'core.home', title: 'HOME', keys: ['new'] },
    { id: 'atem.switcher', title: 'ATEM · Switcher' },
  ]);
  assert.equal(pages[1].tag, 'cc:core.home');
  assert.deepEqual(pages[1].keys, ['new']);
  assert.equal(pages[2].name, 'Late hand-built');
  assert.equal(isCcTagged(pages[2]), false);
  assert.equal(pages[3].tag, 'cc:atem.switcher');
  assert.equal(report.rewritten.length, 1);
  assert.equal(report.appended.length, 1);
  assert.equal(pages[2].keys, undefined, 'the hand-built page was not rewritten');
});

test('stripping the tag (or copying to a User page) stops CC from rewriting that copy', () => {
  const existing = [{ name: 'My copy of HOME', origin: 'cc:core.home' }];
  const { pages, report } = placeCcPages(existing, [{ id: 'core.home', title: 'HOME' }]);
  assert.equal(pages[0].name, 'My copy of HOME');
  assert.equal(isCcTagged(pages[0]), false);
  assert.equal(pages[1].tag, 'cc:core.home');
  assert.equal(report.untouched.length, 1);
});
