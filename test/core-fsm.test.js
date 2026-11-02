'use strict';
// Connection machine, transport, macro run. No devices. These are the rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnection, step, legacyLink, due } = require('../lib/core/connection');
const { createTransport, send: sendTransport } = require('../lib/core/transport');
const { createMacro, send: sendMacro, mirror: mirrorMacro } = require('../lib/core/macro');
const { createCueMachine, send: sendCue } = require('../lib/core').cue;

test('connection: a healthy device walks disconnected → connecting → connected', () => {
  let machine = createConnection({ baseMs: 20, capMs: 100, maxAttempts: 4 });
  const started = step(machine, { type: 'start' }, 1000);
  assert.equal(started.changed, true);
  assert.equal(started.to, 'connecting');
  assert.equal(legacyLink(started.machine), 'connecting');
  const up = step(started.machine, { type: 'up' }, 1100);
  assert.equal(up.to, 'connected');
  assert.equal(legacyLink(up.machine), 'ok');
  assert.equal(up.machine.context.attempt, 0);
  assert.equal(up.machine.context.everConnected, true);
  const again = step(up.machine, { type: 'up' }, 1200);
  assert.equal(again.changed, false);
  assert.equal(again.machine, up.machine, 'a repeat up does not copy the state');
});

test('connection: ignored events do not move a disconnected device', () => {
  const machine = createConnection();
  const up = step(machine, { type: 'up' });
  assert.equal(up.changed, false);
  assert.equal(up.machine, machine);
  const retry = step(machine, { type: 'retry' });
  assert.equal(retry.changed, false);
});

test('connection: a drop backs off, then fails, then a later start is allowed', () => {
  let machine = createConnection({ baseMs: 50, capMs: 200, maxAttempts: 3 });
  machine = step(machine, { type: 'start' }, 0).machine;
  machine = step(machine, { type: 'up' }, 5).machine;
  let r = step(machine, { type: 'down', error: 'no answer' }, 10);
  assert.equal(r.to, 'reconnecting');
  assert.equal(legacyLink(r.machine), 'reconnecting');
  assert.equal(r.machine.context.attempt, 1);
  assert.equal(r.machine.context.backoffMs, 50);
  assert.equal(due(r.machine, 50), false);
  assert.equal(due(r.machine, 60), true);
  machine = step(r.machine, { type: 'retry' }, 20).machine;
  assert.equal(machine.state, 'connecting');
  assert.equal(legacyLink(machine), 'reconnecting', 'a retry after a good link still reads as reconnecting');
  r = step(machine, { type: 'down', error: 'no answer' }, 30);
  machine = step(r.machine, { type: 'retry' }, 50).machine;
  r = step(machine, { type: 'down', error: 'no answer' }, 60);
  assert.equal(r.to, 'failed');
  assert.equal(legacyLink(r.machine), 'offline');
  assert.ok(r.machine.history.filter((h) => h.to === 'failed').length >= 1);
  const back = step(r.machine, { type: 'start' }, 200);
  assert.equal(back.to, 'connecting');
  const held = step(back.machine, { type: 'stop' }, 210);
  assert.equal(held.to, 'disconnected');
  assert.equal(held.machine.context.reason, 'held');
});

test('connection: degraded is partial health, and up clears it', () => {
  let machine = step(createConnection(), { type: 'start' }).machine;
  machine = step(machine, { type: 'up' }).machine;
  const bad = step(machine, { type: 'degrade', reason: '1/3 cameras answering' });
  assert.equal(bad.to, 'degraded');
  assert.equal(legacyLink(bad.machine), 'ok', 'the card stays online while the machine says degraded');
  const same = step(bad.machine, { type: 'degrade', reason: '1/3 cameras answering' });
  assert.equal(same.changed, false);
  const fixed = step(bad.machine, { type: 'up' });
  assert.equal(fixed.to, 'connected');
  assert.equal(fixed.machine.context.reason, null);
});

test('transport: play, pause, stop, record. A playing deck does not start recording', () => {
  let machine = createTransport();
  let r = sendTransport(machine, 'record');
  assert.equal(r.to, 'recording');
  r = sendTransport(r.machine, 'play');
  assert.equal(r.changed, false, 'stop the recording before play');
  r = sendTransport(r.machine, 'stop');
  assert.equal(r.to, 'stopped');
  r = sendTransport(r.machine, 'play');
  assert.equal(r.to, 'playing');
  r = sendTransport(r.machine, 'pause');
  assert.equal(r.to, 'paused');
  r = sendTransport(r.machine, 'toggle');
  assert.equal(r.to, 'playing');
  r = sendTransport(r.machine, 'record');
  assert.equal(r.changed, false);
});

test('macro: strict run refuses a second run; mirror follows the switcher', () => {
  let machine = createMacro();
  let r = sendMacro(machine, 'run');
  assert.equal(r.to, 'running');
  const again = sendMacro(r.machine, 'run');
  assert.equal(again.changed, false);
  r = sendMacro(r.machine, 'wait');
  assert.equal(r.to, 'waiting');
  r = sendMacro(r.machine, 'continue');
  assert.equal(r.to, 'running');
  r = sendMacro(r.machine, 'stop');
  assert.equal(r.to, 'stopped');
  const forced = mirrorMacro(createMacro(), 'wait');
  assert.equal(forced.to, 'waiting');
  assert.equal(forced.forced, true);
});

test('cue machine is the same one the show already runs', () => {
  const machine = sendCue(createCueMachine(), { type: 'run', cueId: 'mc1' });
  assert.equal(machine.state.state, 'running');
  assert.equal(machine.state.locked, true);
  const locked = sendCue(machine.state, { type: 'run', cueId: 'mc1' });
  assert.equal(locked.ignored, true);
});
