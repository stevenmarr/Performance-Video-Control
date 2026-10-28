'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CueStack, offsetPreset } = require('../lib/cues');

test('relative offset keeps the preset prefix', () => {
  assert.equal(offsetPreset('4', '+2'), '6');
  assert.equal(offsetPreset('e2:4', 1), 'e2:5');
  assert.equal(offsetPreset('12', '-2'), '10');
});

test('a cue stack recalls absolute then relative, trails on lag, and bails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cues-'));
  const calls = [];
  const engine = { recall: async (n) => { calls.push(['rs6', n, Date.now()]); } };
  const systems = { recall: async (sys, key) => { calls.push([sys, key, Date.now()]); } };
  const stack = new CueStack({ dataDir: dir, engine, systems });
  stack.save({
    name: 'Open',
    advance: 'go',
    steps: [
      { system: 'rs6', preset: '4', mode: 'absolute', lagMs: 0, atMs: 0 },
      { system: 'rs6', preset: '+2', mode: 'relative', lagMs: 40, atMs: 0 },
      { system: 'e2', preset: 'e2:1', mode: 'absolute', lagMs: 0, atMs: 0 },
    ],
    bail: { system: 'rs6', preset: '9' },
  });
  const again = new CueStack({ dataDir: dir, engine, systems });
  assert.equal(again.status().cues[0].name, 'Open');
  await again.go();
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [['rs6', 4], ['rs6', 6], ['e2', 'e2:1'], ['rs6', 9]]);
  assert.ok(calls[1][2] - calls[0][2] >= 30, 'the second preset trails the first');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auto-advance fires the next cue only when this one is set to auto', async () => {
  const calls = [];
  const engine = { recall: async (n) => { calls.push(n); } };
  const stack = new CueStack({ engine, systems: { recall: async () => {} } });
  stack.save({ name: 'A', advance: 'auto', steps: [{ system: 'rs6', preset: '1', mode: 'absolute' }] });
  stack.save({ name: 'B', advance: 'go', steps: [{ system: 'rs6', preset: '2', mode: 'absolute' }] });
  stack.save({ name: 'C', advance: 'auto', steps: [{ system: 'rs6', preset: '3', mode: 'absolute' }] });
  await stack.go();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(stack.index, 1);
});

test('ATEM is refused as a hi-res cue step', () => {
  const stack = new CueStack({});
  const cue = stack.save({ name: 'No', steps: [{ system: 'atem', preset: '1', mode: 'absolute' }, { system: 'rs6', preset: '3', mode: 'absolute' }] });
  assert.deepEqual(cue.steps.map((s) => s.system), ['rs6']);
});
