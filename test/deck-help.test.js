'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const help = require('../lib/surfaces/deck-help');

test('hold SYSTEM 800 ms enters help mode; a shorter press still opens the chooser', () => {
  assert.equal(help.HELP_HOLD_MS, 800);
  let s = help.fresh();
  s = help.onSystemDown(s, 1000);
  s = help.onSystemUp(s, 1799);
  assert.equal(s.action, 'chooser');
  assert.equal(s.helpMode, false);
  assert.equal(s.send, true);
  s = help.onSystemDown(s, 2000);
  s = help.onSystemUp(s, 2800);
  assert.equal(s.action, 'enter');
  assert.equal(s.helpMode, true);
  assert.equal(s.send, false);
  assert.match(help.stripText(s), /Press a key for what it does/);
});

test('in help mode a key is described and sends nothing; SYSTEM leaves', () => {
  let s = help.onSystemUp(help.onSystemDown(help.fresh(), 0), 800);
  s = help.onKey(s, { label: 'IRIS', do: { turn: { verb: 'step', cap: 'ptz.iris' }, hold: { verb: 'reset', to: 'scene' } }, guard: 'blocked on air' }, 900);
  assert.equal(s.send, false);
  assert.equal(s.action, 'describe');
  assert.match(s.help, /IRIS/);
  assert.match(s.help, /step ptz.iris/);
  assert.match(s.help, /blocked on air/);
  s = help.onKey(s, { label: 'SYSTEM', role: 'system-menu' }, 1000);
  assert.equal(s.helpMode, false);
  assert.equal(s.action, 'exit');
  assert.equal(s.send, false);
});

test('a page change or CONSOLE LOCK ends help mode', () => {
  let s = help.onSystemUp(help.onSystemDown(help.fresh(), 0), 800);
  assert.equal(s.helpMode, true);
  s = help.onPageChange(s, 2000);
  assert.equal(s.helpMode, false);
  assert.equal(s.reason, 'page-change');
  s = help.onSystemUp(help.onSystemDown(help.fresh(), 0), 800);
  s = help.onConsoleLock(s, 3000);
  assert.equal(s.helpMode, false);
  assert.equal(s.reason, 'console-lock');
});
