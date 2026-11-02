'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CueStack, cleanStep } = require('../lib/cues');
const { MasterCues, rowKey, clashMessage } = require('../lib/master-cues');
const { LookBook } = require('../lib/looks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COPY = 'rs6-k3f2a1';
const ATEM2 = 'atem-abcd1234';
const PTZ2 = 'ptz-abcd1234';

function desk() {
  const calls = [];
  const engine = {
    connected: true,
    recall: async (n) => { calls.push(['engine.recall', n]); },
    recallLayers: async (n) => { calls.push(['engine.layers', n]); },
    take: async () => { calls.push(['engine.take']); },
    cut: async () => { calls.push(['engine.cut']); },
    getState: () => ({ connected: true, presets: [{ number: 1, name: 'Open' }, { number: 4, name: 'Wide' }] }),
  };
  const systems = {
    listInstances() {
      return [
        { id: 'rs6', type: 'rs6', name: 'RS6', armed: true },
        { id: COPY, type: 'rs6', name: 'RS6 2', armed: true },
        { id: 'e2', type: 'e2', name: 'E2', armed: true },
        { id: 'pixelhue', type: 'pixelhue', name: 'PixelHue', armed: true },
        { id: 'atem', type: 'atem', name: 'ATEM', armed: true },
        { id: ATEM2, type: 'atem', name: 'ATEM 2', armed: true },
        { id: 'ptz', type: 'ptz', name: 'PTZ', armed: true },
        { id: PTZ2, type: 'ptz', name: 'PTZ 2', armed: true },
        { id: 'pixera', type: 'pixera', name: 'Pixera', armed: true },
      ];
    },
    view(id) {
      if (id === 'ptz') return { cameras: [{ id: 'cam1', name: 'Center', presetNames: {} }] };
      if (id === PTZ2) return { cameras: [{ id: 'cam9', name: 'Side', presetNames: {} }] };
      if (String(id).startsWith('atem')) return { macros: [{ index: 1, name: 'Go' }], presets: [] };
      return { presets: [{ key: `${id}:1`, number: 1, name: 'One' }] };
    },
    recall: async (sys, key, opts) => { calls.push(['recall', sys, key, opts && opts.target]); },
    take: async (sys) => { calls.push(['take', sys]); },
    cut: async (sys) => { calls.push(['cut', sys]); },
    atem: async (name, body) => { calls.push(['atem', name, body]); },
    ptz: async (name, body) => { calls.push(['ptz', name, body]); },
  };
  return { calls, engine, systems };
}

test('hi-res cue steps keep an instance id and drop anything else', () => {
  assert.equal(cleanStep({ system: COPY, preset: '4' }, COPY).system, COPY);
  assert.equal(cleanStep({ system: 'e2-abcd1234', preset: 'e2:1' }, null).system, 'e2-abcd1234');
  assert.equal(cleanStep({ system: 'nope', preset: '4' }, null), null);
  assert.equal(cleanStep({ system: ATEM2, preset: '4' }, null), null);
  assert.equal(cleanStep({ system: 'rs6', preset: '4' }, COPY), null);
  const { engine, systems } = desk();
  const stack = new CueStack({ engine, systems });
  stack.setSystem(COPY);
  assert.equal(stack.system, COPY);
  stack.save({ name: 'Side', steps: [{ system: COPY, preset: '4', mode: 'absolute' }] });
  assert.equal(stack.cues[0].steps[0].system, COPY);
  assert.throws(() => stack.setSystem('deck'), /RS6, E2 or PixelHue/);
});

test('a saved cue file with only an instance id reloads that switcher', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-inst-'));
  fs.writeFileSync(path.join(dir, 'cues.json'), JSON.stringify({
    cues: [{ id: 'c1', name: 'A', steps: [{ system: 'e2-abcd1234', preset: 'e2:1', mode: 'absolute' }] }],
  }));
  const { engine, systems } = desk();
  const loaded = new CueStack({ dataDir: dir, engine, systems });
  assert.equal(loaded.system, 'e2-abcd1234');
  assert.equal(loaded.cues[0].steps[0].system, 'e2-abcd1234');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the original RS6 uses the engine; a copy uses systems recall, take, and cut', async () => {
  const { calls, engine, systems } = desk();
  const stack = new CueStack({ engine, systems });
  stack.setSystem('rs6');
  await stack.recall('rs6', 4, 'absolute', { enforce: false });
  await stack.recall('rs6', 4, 'relative', { enforce: false });
  await stack.take('rs6');
  await stack.cut('rs6');
  await stack.recall(COPY, 4, 'absolute', { enforce: false });
  await stack.recall(COPY, 4, 'relative', { enforce: false });
  await stack.take(COPY);
  await stack.cut(COPY);
  assert.deepEqual(calls, [
    ['engine.recall', 4],
    ['engine.layers', 4],
    ['engine.take'],
    ['engine.cut'],
    ['recall', COPY, 4, 'preview'],
    ['recall', COPY, 4, 'preview'],
    ['take', COPY],
    ['cut', COPY],
  ]);
});

test('the cues tree lists every instance by name and stores the id', () => {
  const { engine, systems } = desk();
  const stack = new CueStack({ engine, systems });
  const masters = new MasterCues({ cues: stack, systems, atemDesk: { view: () => ({ macros: [{ index: 3, name: 'Desk' }] }) } });
  const pal = masters.palette();
  const rs6s = pal.filter((g) => g.type === 'rs6');
  assert.deepEqual(rs6s.map((g) => g.label), ['RS6', 'RS6 2']);
  assert.equal(rs6s[0].items[0].system, 'rs6');
  assert.equal(rs6s[0].items[0].instance, 'rs6');
  assert.equal(rs6s[1].items[0].instance, COPY);
  assert.equal(rs6s[1].items[0].preset, '1');
  const atems = pal.filter((g) => g.type === 'atem');
  assert.deepEqual(atems.map((g) => [g.label, g.items[0].instance, g.items[0].macro]), [
    ['ATEM', 'atem', 3],
    ['ATEM 2', ATEM2, 1],
  ]);
  const ptz = pal.filter((g) => g.type === 'ptz');
  assert.equal(ptz[0].items[0].instance, 'ptz');
  assert.equal(ptz[0].items[0].camera, 'cam1');
  assert.equal(ptz[1].label, 'PTZ 2');
  assert.equal(ptz[1].items[0].instance, PTZ2);
  assert.equal(ptz[1].items[0].camera, 'cam9');
  assert.ok(pal.some((g) => g.id === 'pixera' && g.label === 'Pixera'));
  assert.equal(stack.status().instances.find((i) => i.id === COPY).name, 'RS6 2');
});

test('two RS6 instances are two rows, and one instance cannot share a step with itself', () => {
  const { engine, systems } = desk();
  const masters = new MasterCues({ cues: new CueStack({ engine, systems }), systems });
  assert.equal(clashMessage([
    { type: 'hires', system: 'rs6', instance: 'rs6', section: 'take', step: 0 },
    { type: 'hires', system: COPY, instance: COPY, section: 'take', step: 0 },
  ]), '');
  assert.match(clashMessage([
    { type: 'hires', system: COPY, instance: COPY, section: 'take', step: 0 },
    { type: 'hires', system: COPY, instance: COPY, section: 'take', step: 0 },
  ], masters.deskInstances()), /RS6 2/);
  assert.doesNotThrow(() => masters.save({
    id: 'mc1',
    actions: [
      { type: 'hires', system: 'rs6', preset: '1', step: 0, section: 'take' },
      { type: 'hires', system: COPY, preset: '4', step: 0, section: 'take' },
    ],
  }));
  const saved = masters.list.find((c) => c.id === 'mc1');
  assert.deepEqual(saved.actions.map((a) => a.system), ['rs6', COPY]);
  assert.equal(rowKey(saved.actions[0]), 'rs6');
  assert.equal(rowKey(saved.actions[1]), COPY);
  assert.throws(() => masters.save({
    id: 'mc1',
    actions: [
      { type: 'hires', system: COPY, preset: '1', step: 0 },
      { type: 'hires', system: COPY, preset: '4', step: 0 },
    ],
  }), /RS6 2/);
});

test('an ATEM macro names its switcher, and a PTZ step names an added PTZ', async () => {
  const { calls, engine, systems } = desk();
  const masters = new MasterCues({ cues: new CueStack({ engine, systems }), systems });
  masters.save({
    id: 'mc1', goMs: 0,
    actions: [
      { type: 'atem-macro', macro: 1, instance: ATEM2, step: 0, section: 'take' },
      { type: 'ptz', camera: 'cam9', preset: 2, instance: PTZ2, step: 1, section: 'take' },
      { type: 'atem-macro', macro: 3, step: 0, section: 'post' },
      { type: 'ptz', camera: 'cam1', preset: 1, step: 1, section: 'post' },
    ],
  });
  masters.go('mc1');
  await sleep(40);
  assert.deepEqual(calls[0], ['atem', 'macroRun', { macro: 1, instance: ATEM2 }]);
  assert.deepEqual(calls[1], ['ptz', 'recall', { cam: 'cam9', preset: 2, instance: PTZ2 }]);
  assert.deepEqual(calls[2], ['atem', 'macroRun', { macro: 3, instance: 'atem' }]);
  assert.deepEqual(calls[3], ['ptz', 'recall', { cam: 'cam1', preset: 1 }]);
  assert.equal(calls[3][2].instance, undefined);
});

test('a look stores the instance id and recalls that id; a family name stays the original', async () => {
  const { calls, engine, systems } = desk();
  const book = new LookBook({ engine, systems });
  book.save({ id: 'orig', system: 'rs6', preset: 2, name: 'Main' });
  book.save({ id: 'copy', system: COPY, preset: 4, name: 'Side' });
  book.save({ id: 'bus', system: ATEM2, preset: 5, name: 'Bus', keys: [{ id: '1', on: true }, { id: 'dsk0', on: false }] });
  assert.throws(() => book.save({ id: 'bad', system: 'pixera', preset: 1 }), /rs6, e2, pixelhue or atem/);
  await book.recall('orig');
  await book.recall('copy');
  await book.recall('bus');
  assert.deepEqual(calls, [
    ['engine.recall', 2],
    ['recall', COPY, 4, 'preview'],
    ['atem', 'preview', { source: 5, instance: ATEM2 }],
    ['atem', 'uskOnAir', { key: 1, on: true, instance: ATEM2 }],
    ['atem', 'dskOnAir', { key: 0, on: false, instance: ATEM2 }],
  ]);
  const { engine: e2, systems: s2 } = desk();
  const again = new LookBook({ engine: e2, systems: s2 });
  again.save({ id: 'atem-1', system: 'atem', preset: 4, name: 'Key off', keys: [{ id: '0', on: false }] });
  const local = [];
  s2.atem = async (name, body) => { local.push([name, body]); };
  await again.recall('atem-1');
  assert.deepEqual(local, [['preview', { source: 4 }], ['uskOnAir', { key: 0, on: false }]]);
});
