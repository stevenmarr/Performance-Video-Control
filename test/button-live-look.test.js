'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keySvg, liveChrome, tallyChrome } = require('../lib/deck-image');
const { liveLook } = require('../lib/surfaces/button-core');

test('the category bar sits on the top edge and no longer covers the title', () => {
  const svg = keySvg({ fill: '#222226', bar: '#7c8cff', title: 'IRIS', value: 'F4.0', caption: 'AUTO' });
  assert.match(svg, /x="18" y="7" width="108" height="6"/);
  assert.doesNotMatch(svg, /x="18" y="16" width="108" height="8"/);
});

test('a live control keeps its fill and draws a LIVE corner; a target still fills red', () => {
  const paint = { fill: '#222226', bar: '#7c8cff', title: 'IRIS', value: 'F4.0', caption: 'AUTO' };
  const live = keySvg(liveChrome(liveLook(paint, { kind: 'control', tally: 'pgm' })));
  assert.match(live, /#222226/, 'job colour remains the fill');
  assert.match(live, />LIVE</);
  assert.match(live, /#E5262E/);
  assert.doesNotMatch(live, /fill="#C42020"/);
  const target = keySvg(tallyChrome({ fill: '#1d1a2b', bar: '#8B5CF6', title: 'CAM 1', value: 'Wide' }, 'pgm'));
  assert.match(target, /#C42020|#8C1C22|#3A0D10/);
  assert.doesNotMatch(target, />LIVE</);
});
