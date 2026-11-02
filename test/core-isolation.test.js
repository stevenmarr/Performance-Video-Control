'use strict';
// One module crashing must not take the next module with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createDispatch } = require('../lib/core/dispatch');
const { createLog } = require('../lib/core/log');
const { createSupervisor } = require('../lib/core/supervisor');
const { SystemManager } = require('../lib/systems');
const { MockE2 } = require('../lib/mocks/e2');
const { MockPixelHue } = require('../lib/mocks/pixelhue');
const { until } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-iso-'));
function fakeEngine() {
  const eng = new EventEmitter();
  eng.settings = { host: '', restPort: 80, awjPort: 10606, protocol: 'rest' };
  eng.log = () => {};
  eng.changed = () => {};
  eng.currentShow = { id: null, name: 'Iso' };
  return eng;
}

test('dispatch times out one action and still runs the next', async () => {
  const dispatch = createDispatch(createLog());
  let release = () => {};
  const hung = new Promise((resolve) => { release = resolve; });
  try {
    await assert.rejects(
      () => dispatch.run({ module: 'atem', instance: 'atem', action: 'hang', timeoutMs: 40, run: () => hung }),
      /timed out/,
    );
  } finally { release(); }
  const value = await dispatch.run({ module: 'ptz', instance: 'ptz', action: 'stop', timeoutMs: 200, run: async () => ({ ok: true }) });
  assert.deepEqual(value, { ok: true });
  const recent = dispatch.recent();
  assert.equal(recent[0].ok, false);
  assert.equal(recent[0].status, 504);
  assert.equal(recent[1].ok, true);
  assert.equal(recent[1].module, 'ptz');
});

test('supervisor restarts the crashing module and leaves the sibling count at zero', async () => {
  const log = createLog();
  const sup = createSupervisor(log);
  let closed = 0;
  sup.onRestart = () => { closed += 1; };
  const boom = () => { throw new TypeError('driver blew up'); };
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => sup.run('e2', 'poll', boom), TypeError);
  }
  assert.equal(closed, 1);
  assert.equal(sup.restarts('e2'), 1);
  await assert.rejects(() => sup.run('pixelhue', 'poll', () => { throw new Error('no answer'); }), /no answer/);
  assert.equal(sup.faults('pixelhue'), 0, 'a normal miss is not a crash');
  assert.equal(sup.restarts('pixelhue'), 0);
});

test('an E2 heartbeat crash does not drop PixelHue', async () => {
  const dir = tmp();
  const e2 = new MockE2();
  const ph = new MockPixelHue();
  const e2Port = await e2.start(0);
  const phPort = await ph.start(0);
  const sm = new SystemManager({
    dataDir: dir,
    engine: fakeEngine(),
    pollMs: 40,
    refreshMs: 60000,
    overrides: {
      e2: { host: '127.0.0.1', port: e2Port },
      pixelhue: { host: '127.0.0.1', port: phPort },
    },
  });
  try {
    await until(() => sm.bag('e2').conn.state === 'connected' && sm.bag('pixelhue').conn.state === 'connected', 4000, 'both online');
    sm.driver('e2').heartbeat = () => { throw new TypeError('e2 exploded'); };
    await until(() => sm.os.supervisor.restarts('e2') >= 1, 4000, 'supervised restart');
    assert.equal(sm.driver('pixelhue').status().connected, true);
    assert.notEqual(sm.bag('pixelhue').conn.state, 'failed');
  } finally {
    sm.close();
    await e2.stop();
    await ph.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
