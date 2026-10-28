'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AtemDesk } = require('../lib/atem-desk');

function live() {
  return {
    macros: [{ index: 0, isUsed: true, name: 'Open', description: 'from switcher' }, { index: 2, isUsed: false, name: '', description: '' }],
    macroRun: { isRunning: false, isWaiting: false, macroIndex: 0xffff },
    inputs: [{ id: 1, long: 'Camera Left' }, { id: 6000, long: 'Super Source' }],
    mes: [{ index: 0, program: 1, preview: 6000, style: 'MIX', mixRate: 30, keyers: [{ index: 0, onAir: true }] }],
    dsk: [{ index: 0, onAir: false }],
    aux: [{ index: 0, source: 1 }],
    superSources: [{ index: 0, boxes: [{ index: 0, source: 1 }] }],
  };
}

test('sync keeps local steps and takes switcher names until the editor dirties them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-desk-'));
  const desk = new AtemDesk({ dataDir: dir, systems: { drivers: { atem: { view: live } } } });
  desk.saveMacro({ index: 0, name: 'Local', steps: [{ op: 'preview', args: { source: 1, me: 1 } }], dirty: false });
  desk.sync();
  const row = desk.view().macros.find((m) => m.index === 0);
  assert.equal(row.name, 'Open');
  assert.equal(row.steps[0].op, 'preview');
  desk.saveMacro({ index: 0, name: 'Edited', steps: row.steps, dirty: true });
  desk.sync();
  assert.equal(desk.view().macros.find((m) => m.index === 0).name, 'Edited');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playing steps sends them, and a user wait holds until continue', async () => {
  const calls = [];
  const systems = { atem: async (name, body) => { calls.push([name, body]); } };
  const desk = new AtemDesk({ systems, frameMs: 1 });
  desk.saveMacro({
    index: 1,
    name: 'Walk',
    steps: [
      { op: 'preview', args: { source: 4, me: 1 } },
      { op: 'userWait', args: {}, userWait: true },
      { op: 'cut', args: { me: 1 } },
    ],
  });
  const running = desk.play(1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, [['preview', { source: 4, me: 1 }]]);
  assert.equal(desk.view().play.waiting, true);
  desk.continuePlay();
  await running;
  assert.deepEqual(calls.map((c) => c[0]), ['preview', 'cut']);
});

test('a memory recalls absolute switcher state, including Super Source', async () => {
  const calls = [];
  const systems = { atem: async (name, body) => { calls.push([name, body]); }, drivers: { atem: { view: live } } };
  const desk = new AtemDesk({ systems });
  const mem = desk.capture('Look');
  calls.length = 0;
  const rec = await desk.recallMemory(mem.id);
  assert.equal(rec.absolute, true);
  assert.ok(calls.some((c) => c[0] === 'program' && c[1].source === 1 && c[1].me === 1));
  assert.ok(calls.some((c) => c[0] === 'preview' && c[1].source === 6000));
  assert.ok(calls.some((c) => c[0] === 'uskOnAir' && c[1].on === true));
  assert.ok(calls.some((c) => c[0] === 'dskOnAir' && c[1].on === false));
  assert.ok(calls.some((c) => c[0] === 'aux' && c[1].source === 1));
  assert.ok(calls.some((c) => c[0] === 'ssBox' && c[1].source === 1));
});

test('sim scrubs steps without calling the switcher', () => {
  let hits = 0;
  const desk = new AtemDesk({ systems: { atem: async () => { hits += 1; }, drivers: { atem: { view: live } } } });
  desk.saveMacro({ index: 3, name: 'Sim', steps: [{ op: 'preview', args: { source: 8, me: 1 } }, { op: 'cut', args: { me: 1 } }] });
  const mid = desk.simulate(3, 0);
  assert.equal(mid.mes[0].preview, 8);
  assert.equal(mid.mes[0].program, 1);
  const end = desk.simulate(3, 1);
  assert.equal(end.mes[0].program, 8);
  assert.equal(hits, 0);
});

test('recording from the app appends steps onto the armed slot', () => {
  const desk = new AtemDesk({});
  desk.arm(4);
  desk.note('program', { source: 2, me: 1 });
  desk.note('macroRun', { macro: 4 });
  const row = desk.view().macros.find((m) => m.index === 4);
  assert.deepEqual(row.steps.map((s) => s.op), ['program']);
  desk.disarm();
  desk.note('cut', { me: 1 });
  assert.equal(desk.view().macros.find((m) => m.index === 4).steps.length, 1);
});
