'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const sysJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sys.js'), 'utf8');

test('AVAILABLE cards use palStatus: unconfigured is NOT CONFIGURED, off-desk is not FAILED or OFFLINE', () => {
  assert.match(sysJs, /function palStatus\(s\)/);
  assert.match(sysJs, /txt: 'NOT CONFIGURED'/);
  assert.match(sysJs, /txt: 'NOT ON DESK'/);
  assert.match(sysJs, /const palRow = \(s\) => \{\s*const st = palStatus\(s\);/);
  assert.match(sysJs, /function typeOnDesk\(type\)/);
  const pal = sysJs.slice(sysJs.indexOf('function palStatus'), sysJs.indexOf('const ver ='));
  assert.match(pal, /if \(!conf\) return \{ cls: 'idle', txt: 'NOT CONFIGURED' \}/);
  assert.match(pal, /if \(!typeOnDesk\([^)]+\)\) return \{ cls: 'idle', txt: 'NOT ON DESK' \}/);
  assert.doesNotMatch(pal, /txt: 'FAILED'/);
  assert.doesNotMatch(pal, /txt: 'OFFLINE'/);
});

test('desk cards still use statusOf, including FAILED and OFFLINE, only for instances on the desk', () => {
  assert.match(sysJs, /const desk = instances\(\)\.filter\(\(i\) => i\.armed\);/);
  assert.match(sysJs, /const instRow = \(s\) => \{\s*const st = statusOf\(s\);/);
  const statusOf = sysJs.slice(sysJs.indexOf('function statusOf'), sysJs.indexOf('function typeOnDesk'));
  assert.match(statusOf, /if \(!conf\) return \{ cls: 'idle', txt: 'NOT CONFIGURED' \}/);
  assert.match(statusOf, /st\.fsm === 'failed'/);
  assert.match(statusOf, /txt: 'OFFLINE'/);
});
