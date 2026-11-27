'use strict';
// Design tokens and shared controls. Colour names stay the job colours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('design tokens name the job colours once', () => {
  const css = read('public/tokens.css');
  assert.match(css, /--cc-pgm:\s*#e5262e/);
  assert.match(css, /--cc-pvw:\s*#18c35a/);
  assert.match(css, /--cc-sel:\s*#f0a500/);
  assert.match(css, /--cc-accent:\s*#3b8cff/);
  assert.match(css, /--pgm:\s*var\(--cc-pgm\)/);
  assert.match(css, /--pvw:\s*var\(--cc-pvw\)/);
  assert.match(css, /html\[data-theme=light\]/);
  assert.match(css, /--cc-hit-mini:\s*32px/);
});

test('the page loads the shared controls and the help tip', () => {
  const html = read('public/index.html');
  const css = read('public/ui.css');
  const js = read('public/ui.js');
  assert.match(html, /href="\/tokens\.css"/);
  assert.match(html, /href="\/ui\.css"/);
  assert.match(html, /href="\/desk\.css"/);
  assert.match(html, /src="\/ui\.js"/);
  assert.match(css, /\.cc-tip\s*\{/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.cc-live\s*\{/);
  assert.match(css, /\.cc-empty\s*\{/);
  assert.match(css, /\.cc-status-ok\s*\{/);
  assert.match(js, /role', 'tooltip'/);
  assert.match(js, /window\.CCUI/);
  assert.doesNotMatch(js, /fetch\(/);
  assert.doesNotMatch(js, /XMLHttpRequest/);
});

test('a fixed-position tip is not a button class', () => {
  const css = read('public/ui.css');
  assert.match(css, /\.cc-tip\s*\{[^}]*position:\s*fixed/);
  assert.doesNotMatch(css, /button\.cc-tip|\.btn\.cc-tip|\.ghost\{[^}]*position:\s*fixed/);
});
