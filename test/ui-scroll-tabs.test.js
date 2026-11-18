'use strict';
// PTZ CAMERA CONTROL and the standalone Scopes app must scroll vertically instead of shrinking
// their dock row to fit the window. BUTTONS and PAGES are always-visible top-level tabs.
// Scopes stays out of this Control Center (including on a Pi).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function cssRules(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((chunk) => {
    const i = chunk.lastIndexOf('{');
    if (i < 0) return null;
    return { sel: chunk.slice(0, i).trim().replace(/\s+/g, ' '), body: chunk.slice(i + 1) };
  }).filter(Boolean);
}

test('PTZ camera dock keeps a fixed 30 px row and scrolls vertically', () => {
  const css = read('public/style.css');
  const js = read('public/ptz.js');
  const rules = cssRules(css);
  const rcpRules = rules.filter((r) => r.sel === '#pane-pctl .rcp');
  assert.ok(rcpRules.length, '#pane-pctl .rcp rule exists');
  const body = rcpRules.map((r) => r.body).join('\n');
  assert.match(body, /overflow-y\s*:\s*auto/);
  assert.match(body, /min-height\s*:\s*0/);
  assert.match(body, /scrollbar-gutter\s*:\s*stable/);
  assert.doesNotMatch(body, /overflow\s*:\s*hidden/);
  assert.doesNotMatch(js, /function fitPtz\b/);
  assert.doesNotMatch(js, /setProperty\('--dk-row'/);
  assert.match(js, /Row unit stays the dock default/);
  assert.match(read('public/dock.js'), /const ROW = 30/);
});

test('standalone Scopes stage scrolls; layout does not shrink the dock row to fit', () => {
  const html = read('apps/scopes/public/scopes.html');
  const js = read('apps/scopes/public/scopes.js');
  assert.match(html, /\.stage\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(html, /\.stage\s*\{[^}]*scrollbar-gutter:\s*stable/);
  assert.match(html, /grid-auto-rows:\s*var\(--dk-row, 30px\)/);
  assert.match(html, /id="stagePort"/);
  assert.match(html, /class="stage-port"/);
  assert.doesNotMatch(js, /setProperty\('--dk-row'/);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /addEventListener\('scroll'/);
  assert.match(js, /--stage-vh/);
});

test('BUTTONS and PAGES are always-visible top-level tabs; Scopes is not a Control Center tab', () => {
  const html = read('public/index.html');
  const top = html.split('id="tabsSub"')[0];
  assert.match(top, /id="tabsTop"/);
  assert.match(top, /class="tab tab-buttons" data-tab="buttons"/);
  assert.match(top, /class="tab tab-pages" data-tab="pages"/);
  assert.match(top, /class="tab tab-decks" data-tab="decks"/);
  assert.doesNotMatch(top, /hidden>BUTTONS</);
  assert.doesNotMatch(top, /hidden>PAGES</);
  assert.match(html, /id="pane-buttons"/);
  assert.match(html, /id="pane-pages"/);
  assert.match(html, /src="\/button-library\.js"/);
  assert.match(html, /src="\/surface-pages\.js"/);
  assert.match(read('public/app.js'), /'buttons'/);
  assert.match(read('public/app.js'), /'pages'/);
  assert.match(read('public/sys.js'), /decks: \['decks', 'buttons', 'pages', 'companion'\]/);
  assert.match(read('public/button-library.js'), /data-field="theme"/);
  assert.doesNotMatch(html, /data-tab="scopes"/);
  assert.doesNotMatch(html, /id="pane-scopes"/);
  assert.doesNotMatch(html, /id="scopesFrame"/);
});

test('Control Center has a light and dark appearance; Scopes stays dark', () => {
  const css = read('public/style.css');
  const html = read('public/index.html');
  const prefs = read('public/prefs.js');
  const scopes = read('apps/scopes/public/scopes.html');
  assert.match(css, /html\[data-theme=light\]/);
  assert.match(css, /--input-bg/);
  assert.match(html, /id="uiTheme"/);
  assert.match(html, /documentElement\.dataset\.theme/);
  assert.match(prefs, /window\.CCTHEME/);
  assert.match(prefs, /prefers-color-scheme/);
  assert.doesNotMatch(scopes, /data-theme=light/);
  assert.doesNotMatch(scopes, /prefers-color-scheme/);
});
