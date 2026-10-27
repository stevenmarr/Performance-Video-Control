'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LookBook } = require('../lib/looks');

test('a look recalls to preview, then forces each key to the stored on or off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looks-'));
  const calls = [];
  const engine = { recall: async (n) => { calls.push(['rs6', n]); return { done: ['S1'] }; } };
  const systems = {
    recall: async (sys, key, opts) => { calls.push([sys, key, opts.target]); return { ok: true }; },
    atem: async (name, body) => { calls.push(['atem', name, body]); return { ok: true }; },
  };
  const book = new LookBook({ dataDir: dir, engine, systems });
  book.save({ id: 'rs6-2', system: 'rs6', preset: 2, name: 'Wide', keys: [{ id: '0', label: 'KEY 1', on: true }] });
  const again = new LookBook({ dataDir: dir, engine, systems });
  assert.equal(again.list('rs6')[0].name, 'Wide');
  assert.equal(again.list('rs6')[0].keys[0].on, true);
  await again.recall('rs6-2');
  assert.deepEqual(calls, [['rs6', 2]]);
  calls.length = 0;
  book.save({ id: 'atem-1', system: 'atem', preset: 4, name: 'Key off', keys: [{ id: '0', on: false }, { id: 'dsk0', on: true }] });
  const rec = await book.recall('atem-1');
  assert.equal(rec.absolute, true);
  assert.equal(rec.target, 'preview');
  assert.deepEqual(calls, [
    ['atem', 'preview', { source: 4 }],
    ['atem', 'uskOnAir', { key: 0, on: false }],
    ['atem', 'dskOnAir', { key: 0, on: true }],
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});
