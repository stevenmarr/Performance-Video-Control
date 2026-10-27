'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SURFACES } = require('../lib/decks/surfaces');
const { show } = require('../lib/decks/faces');

const desk = { armed: ['rs6', 'ptz', 'e2'] };

test('home is the first face and every system page can return there', () => {
  const home = show(SURFACES.plusxl, desk, {});
  assert.equal(home.id, 'home');
  assert.deepEqual(home.keys.filter((k) => k.nav === 'system').map((k) => k.system), ['rs6', 'ptz', 'e2']);
  const ptz = show(SURFACES.plusxl, desk, { system: 'ptz', page: 0 });
  assert.equal(ptz.keys.find((k) => k.col === 0 && k.row === 0).nav, 'home');
  assert.equal(ptz.system, 'ptz');
  assert.ok(!ptz.keys.some((k) => k.action && String(k.action.path).includes('/api/take')));
});

test('a smaller deck needs more PTZ pages than a + XL', () => {
  const big = show(SURFACES.plusxl, desk, { system: 'ptz', page: 0 });
  const small = show(SURFACES.plus, desk, { system: 'ptz', page: 0 });
  assert.ok(small.pages > big.pages, `${small.pages} pages on + should be more than ${big.pages} on + XL`);
  assert.ok(big.pages <= 2, '+ XL should hold PTZ in one or two pages');
});

test('one system at a time, and switcher memories are absolute recalls', () => {
  const rs6 = show(SURFACES.xl, desk, { system: 'rs6', page: 0 });
  assert.ok(rs6.keys.every((k) => !k.action || !String(k.action.path).includes('/ptz/')));
  const memories = rs6.keys.filter((k) => k.absolute);
  assert.ok(memories.length >= 8);
  assert.ok(memories.every((k) => /\/recall$/.test(k.action.path)));
  const e2 = show(SURFACES.xl, desk, { system: 'e2', page: 0 });
  const mem = e2.keys.find((k) => k.absolute);
  assert.equal(mem.action.body.target, 'preview');
});
