'use strict';
// Paint writes that arrive together become one camera command. A write that
// arrives while that command is in flight is sent afterwards, so the last
// value is the one the camera keeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createValueCoalescer } = require('../lib/paint-coalesce');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('two targets queued before the send leave only the latest value', async () => {
  const sent = [];
  const gate = deferred();
  const c = createValueCoalescer({
    intervalMs: 50,
    send: async (cam, op, value) => {
      sent.push(value);
      await gate.promise;
      return { value, cam, op };
    },
  });
  const a = c.submit('cam1', 'rGain', 25);
  const b = c.submit('cam1', 'rGain', 40);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [40]);
  gate.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.value, 40);
  assert.equal(rb.value, 40);
});

test('a target that arrives during the request is sent when it finishes', async () => {
  const sent = [];
  const gates = [];
  const c = createValueCoalescer({
    intervalMs: 0,
    send: (cam, op, value) => {
      sent.push(value);
      const gate = deferred();
      gates.push(gate);
      return gate.promise.then(() => ({ value }));
    },
  });
  const first = c.submit('cam1', 'iris', 21);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [21]);
  const second = c.submit('cam1', 'iris', 30);
  gates[0].resolve();
  assert.equal((await first).value, 21);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [21, 30]);
  gates[1].resolve();
  assert.equal((await second).value, 30);
});

test('the rate limit holds a burst and then sends the newest value once', async () => {
  let now = 1000;
  const timers = [];
  const sent = [];
  let release = null;
  const c = createValueCoalescer({
    intervalMs: 80,
    now: () => now,
    schedule: (fn) => {
      const id = { fn };
      timers.push(id);
      return id;
    },
    cancel: (id) => { id.cancelled = true; },
    send: (cam, op, value) => {
      sent.push(value);
      if (!release) return Promise.resolve({ value });
      const done = release;
      release = null;
      return done.then(() => ({ value }));
    },
  });
  let open;
  release = new Promise((r) => { open = r; });
  const first = c.submit('cam1', 'masterPed', 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [1]);
  const pending = c.submit('cam1', 'masterPed', 4);
  open();
  await first;
  assert.equal(timers.length, 1, 'the follow-up waits out the gap');
  c.submit('cam1', 'masterPed', 9);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [1]);
  now += 80;
  timers[0].fn();
  assert.equal((await pending).value, 9);
  assert.deepEqual(sent, [1, 9]);
});

test('a failed send still lets a newer target go out', async () => {
  const sent = [];
  let fail = true;
  const c = createValueCoalescer({
    intervalMs: 0,
    send: async (cam, op, value) => {
      sent.push(value);
      if (fail) throw new Error('camera busy');
      return { value };
    },
  });
  const first = c.submit('cam1', 'iris', 10).then(
    () => { throw new Error('the refused write should reject'); },
    (e) => e,
  );
  await new Promise((r) => setImmediate(r));
  fail = false;
  const second = c.submit('cam1', 'iris', 12);
  assert.match((await first).message, /camera busy/);
  assert.equal((await second).value, 12);
  assert.deepEqual(sent, [10, 12]);
});
