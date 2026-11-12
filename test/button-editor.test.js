'use strict';
process.env.RS6_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog } = require('../lib/decks/action-catalog');
const { previewSvg } = require('../lib/decks/button-preview');

test('the action picker binds module ids and marks page-only ids', () => {
  const cat = catalog();
  assert.ok(!cat.roles.includes('flex'));
  assert.ok(!cat.roles.includes('blank'));
  assert.ok(cat.roles.includes('memory') && cat.roles.includes('macro'));
  const cut = cat.actions.find((a) => a.id === 'atem.cut');
  const home = cat.actions.find((a) => a.id === 'nav.home');
  const info = cat.actions.find((a) => a.id === 'atem.info');
  assert.equal(cut.bound, true);
  assert.equal(home.bound, false);
  assert.equal(info.bound, false);
  assert.equal(cat.events.encoder.join(','), 'turn,push');
  assert.equal(cat.events['touch-segment'].join(','), 'touch');
  assert.ok(!cat.events.button.includes('turn'));
});

test('program and CUT previews follow the + XL colors', () => {
  const program = previewSvg({
    role: 'program',
    element: 'button',
    text: '$(atem:name)',
    feedbacks: [{ when: 'onProgram', style: { bgcolor: '#ff2d2d', color: '#ffffff' } }],
  }, {});
  assert.match(program.svg, /#5c2428/);
  assert.match(program.svg, /#C42020/);
  assert.match(program.face.value, /Constellation/);
  assert.match(program.svg, /Constellatio/);
  const live = previewSvg({
    role: 'program',
    element: 'button',
    text: '$(atem:name)',
    feedbacks: [{ when: 'onProgram', style: { bgcolor: '#ff2d2d', color: '#ffffff' } }],
  }, { onProgram: true });
  assert.match(live.svg, /#ff2d2d/);
  const cut = previewSvg({
    role: 'hot',
    element: 'button',
    text: 'CUT',
    feedbacks: [{ when: 'transition', style: { bgcolor: '#ff6b6b' } }],
  }, {});
  assert.match(cut.svg, /#C42020/);
  assert.match(cut.svg, /#E0B030/);
  const going = previewSvg({
    role: 'hot',
    element: 'button',
    text: 'CUT',
    feedbacks: [{ when: 'transition', style: { bgcolor: '#ff6b6b' } }],
  }, { transition: true });
  assert.match(going.svg, /#ff6b6b/);
  const memory = previewSvg({ role: 'memory', element: 'button', text: 'MEM' }, {});
  assert.match(memory.svg, /#A03A8C/);
  assert.doesNotMatch(memory.svg, /#E0B030/);
});
