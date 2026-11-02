'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCueMachine, send } = require('../lib/cue-machine');

test('load then run enters TAKE, and a second run is the same object', () => {
  let m = createCueMachine();
  const loaded = send(m, { type: 'load', cueId: 'mc1' });
  assert.equal(loaded.ignored, false);
  assert.equal(loaded.state.state, 'loaded');
  assert.equal(loaded.state.cueId, 'mc1');
  assert.equal(loaded.state.locked, false);
  const running = send(loaded.state, { type: 'run' });
  assert.equal(running.state.state, 'running');
  assert.equal(running.state.phase, 'take');
  assert.equal(running.state.locked, true);
  assert.equal(running.state.generation, 1);
  const again = send(running.state, { type: 'run', cueId: 'mc2' });
  assert.equal(again.ignored, true);
  assert.equal(again.state, running.state);
  assert.equal(again.state.generation, 1);
  assert.equal(again.state.cueId, 'mc1');
  const loadWhile = send(running.state, { type: 'load', cueId: 'mc2' });
  assert.equal(loadWhile.ignored, true);
  assert.equal(loadWhile.state, running.state);
});

test('timeline walks TAKE, GO, POST TAKE, then stacks or idles', () => {
  let m = send(createCueMachine(), { type: 'run', cueId: 'mc1' }).state;
  m = send(m, { type: 'enterGo' }).state;
  assert.equal(m.phase, 'go');
  m = send(m, { type: 'enterPost' }).state;
  assert.equal(m.phase, 'post');
  const stacked = send(m, { type: 'timelineDone', stacked: true, nextCueId: 'mc2' });
  assert.equal(stacked.state.state, 'loaded');
  assert.equal(stacked.state.cueId, 'mc2');
  assert.equal(stacked.state.locked, false);
  const ran = send(stacked.state, { type: 'run' }).state;
  const idle = send(ran, { type: 'timelineDone', stacked: false });
  assert.equal(idle.state.state, 'idle');
  assert.equal(idle.state.cueId, null);
  assert.equal(send(idle.state, { type: 'run' }).ignored, true);
});

test('a failed action is not finished, and ack returns to loaded', () => {
  const running = send(createCueMachine(), { type: 'run', cueId: 'mc1' }).state;
  const failed = send(running, { type: 'fail', error: 'macro missing' });
  assert.equal(failed.state.state, 'failed');
  assert.equal(failed.state.error, 'macro missing');
  assert.equal(failed.state.cueId, 'mc1');
  assert.equal(failed.state.locked, false);
  assert.equal(send(failed.state, { type: 'run' }).ignored, true);
  assert.equal(send(failed.state, { type: 'timelineDone' }).ignored, true);
  const acked = send(failed.state, { type: 'ack' });
  assert.equal(acked.state.state, 'loaded');
  assert.equal(acked.state.cueId, 'mc1');
  assert.equal(acked.state.error, null);
  assert.equal(send(acked.state, { type: 'ack' }).ignored, true);
});

test('external preset take unloads a loaded, running, or failed cue and ignores idle', () => {
  const idle = createCueMachine();
  const stay = send(idle, { type: 'externalPresetTake' });
  assert.equal(stay.ignored, true);
  assert.equal(stay.state, idle);
  const loaded = send(idle, { type: 'load', cueId: 'mc1' }).state;
  const dropped = send(loaded, { type: 'externalPresetTake' });
  assert.equal(dropped.state.state, 'idle');
  assert.equal(dropped.state.cueId, null);
  assert.ok(dropped.state.generation > loaded.generation);
  const running = send(createCueMachine(), { type: 'run', cueId: 'mc1' }).state;
  assert.equal(send(running, { type: 'externalPresetTake' }).state.state, 'idle');
  const failed = send(running, { type: 'fail', error: 'no' }).state;
  assert.equal(send(failed, { type: 'cancel' }).state.state, 'idle');
});
