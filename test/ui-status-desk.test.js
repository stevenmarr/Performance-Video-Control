'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const sysJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sys.js'), 'utf8');
const modJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sys-modules.js'), 'utf8');

// 0.33.0: AVAILABLE rows only add to the desk. They show "N ON DESK" or "NOT ON DESK", never a connection state.
test('AVAILABLE rows use palStatus: NOT ON DESK or a desk count, never NOT CONFIGURED, FAILED or OFFLINE', () => {
  assert.match(sysJs, /function palStatus\(s\)/);
  assert.match(sysJs, /const palRow = \(s\) => \{\s*const st = palStatus\(s\);/);
  const pal = sysJs.slice(sysJs.indexOf('function palStatus'), sysJs.indexOf('const ver ='));
  assert.match(pal, /txt: 'NOT ON DESK'/);
  assert.match(pal, /txt: `\$\{n\} ON DESK`/);
  for (const bad of ['NOT CONFIGURED', 'NOT SET UP', 'FAILED', 'OFFLINE', 'ONLINE']) assert.doesNotMatch(pal, new RegExp(`txt: '${bad}'`));
  assert.doesNotMatch(pal, /configured/);
  // module rows: the same
  const modPal = modJs.slice(modJs.indexOf('function palRow'), modJs.indexOf('function field'));
  assert.match(modPal, /onDeskLine\(n\)/);
  assert.doesNotMatch(modPal, /statusOf/);
  assert.match(modJs, /`<span class="led ok"><\/span>\$\{n\} ON DESK`/);
});

test('the left filter is ALL / ON DESK / NOT ON DESK; connection states are only on desk cards', () => {
  assert.match(sysJs, /stChip\('all', 'ALL'/);
  assert.match(sysJs, /stChip\('desk', 'ON DESK'/);
  assert.match(sysJs, /stChip\('off', 'NOT ON DESK'/);
  assert.doesNotMatch(sysJs, /stChip\('online'/);
  assert.doesNotMatch(sysJs, /stChip\('idle', 'NOT SET UP'/);
});

test('desk cards still use statusOf, including NOT SET UP, FAILED and OFFLINE, only for instances on the desk', () => {
  assert.match(sysJs, /const desk = instances\(\)\.filter\(\(i\) => i\.armed\);/);
  assert.match(sysJs, /const instRow = \(s\) => \{\s*const st = statusOf\(s\);/);
  const statusOf = sysJs.slice(sysJs.indexOf('function statusOf'), sysJs.indexOf('function typeOnDesk'));
  assert.match(statusOf, /if \(!conf\) return \{ cls: 'idle', txt: 'NOT SET UP' \}/);
  assert.match(statusOf, /st\.fsm === 'failed'/);
  assert.match(statusOf, /txt: 'OFFLINE'/);
  const modStatus = modJs.slice(modJs.indexOf('function statusOf'), modJs.indexOf('const onDeskLine'));
  for (const t of ['NOT SET UP', 'ONLINE', 'OFFLINE', 'CONFIGURED']) assert.match(modStatus, new RegExp(`txt: [^}]*'${t}'`));
});

test('desk cards carry the BUTTONS · VARIABLES · FEEDBACKS section MODULES had', () => {
  assert.match(sysJs, /M\(\)\.nativePanel\(type, s\.id, openDet\)/);
  assert.match(modJs, /BUTTONS · VARIABLES · FEEDBACKS/);
  assert.match(modJs, /\/api\/modules\/preview/);
  assert.match(modJs, /\/api\/modules\/instances\/\$\{encodeURIComponent\(id\)\}\/connection/);
  assert.match(modJs, /type="password" value=""/, 'a saved secret is never written back into the page');
});
