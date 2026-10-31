'use strict';
// Regression checks for the low-risk fixes in the 2026-10-30 audit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AtemDesk } = require('../lib/atem-desk');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('PRESETS and CUES panes live inside main so the page can use the window', () => {
  const html = read('public/index.html');
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  assert.match(main, /id="pane-looks"/);
  assert.match(main, /id="pane-cues"/);
  assert.match(main, /class="grid-wrap pane"/);
});

test('cue, master-cue and macro markup escapes names', () => {
  for (const file of ['public/looks.js', 'public/cues-tab.js', 'public/atem-macros.js']) {
    const js = read(file);
    assert.match(js, /'&': '&amp;'/);
    assert.match(js, /'<': '&lt;'/);
    assert.match(js, /'"': '&quot;'/);
    assert.doesNotMatch(js, /'&': '&'/);
  }
});

test('ATEM macro XML escapes names', () => {
  const desk = new AtemDesk({});
  desk.saveMacro({ index: 1, name: 'A & B <c>', steps: [{ op: 'cut', args: { me: 1 } }] });
  const xml = desk.toXml();
  assert.match(xml, /name="A &amp; B &lt;c&gt;"/);
  assert.doesNotMatch(xml, /name="A & B/);
});

test('master-cue search keeps the caret when the palette repaints', () => {
  const js = read('public/cues-tab.js');
  assert.match(js, /searchCaret/);
  assert.match(js, /setSelectionRange/);
});

test('an empty Available column says the desk is full when no filter is set', () => {
  const js = read('public/sys.js');
  assert.match(js, /Every system is already on the desk\./);
  assert.match(js, /Nothing matches this filter\./);
});

test('ATEM operator LOOP and PLAY sit on their own row', () => {
  assert.match(read('public/style.css'), /\.ad-op>\.ad-opbar\{grid-column:1 \/ -1\}/);
});
