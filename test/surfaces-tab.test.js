'use strict';
// UI presence checks for the SURFACES tab (designer Phase B).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('SURFACES tab replaces BUTTONS, PAGES and Control Devices', () => {
  assert.match(html, /data-tab="surfaces"/);
  assert.match(html, /id="pane-surfaces"/);
  assert.match(html, /data-surfaces="pages"/);
  assert.match(html, /data-surfaces="buttons"/);
  assert.match(html, /data-surfaces="devices"/);
  assert.match(html, /data-surfaces="tourbox"/);
  assert.match(html, /data-surfaces="selftest"/);
  assert.doesNotMatch(html, /data-tab="decks"/);
  assert.doesNotMatch(html, /data-tab="buttons"/);
  assert.doesNotMatch(html, /data-tab="pages"/);
  assert.match(app, /'surfaces'/);
  assert.doesNotMatch(app, /'decks', 'buttons', 'pages'/);
});

test('Page Builder elements are present', () => {
  assert.match(html, /id="surfacesPages"/);
  assert.match(html, /LIVE ON DECK|live-pill|WHAT CHANGED/);
});
