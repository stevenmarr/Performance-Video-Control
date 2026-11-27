'use strict';
// HyperDeck clip list / remaining time, and Mitti cue list / remaining time.
// Both are exercised against the in-process mocks, not a live deck or a Mac.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { HyperDeckDriver, parseClipLine } = require('../lib/drivers/hyperdeck');
const { MittiDriver } = require('../lib/drivers/mitti');
const { MockHyperDeck } = require('../lib/mocks/hyperdeck');
const { MockMitti } = require('../lib/mocks/mitti');
const { SystemManager } = require('../lib/systems');
const osc = require('../lib/drivers/osc');

const ACTION = /^(record\b|play\b|play:|stop\b|preview:|goto:|slot select:)/;
const MITTI_ACTION = new Set(['/mitti/play', '/mitti/stop', '/mitti/pause', '/mitti/togglePlay', '/mitti/cue', '/mitti/cueNext', '/mitti/cuePrev', '/mitti/gotoCueByName']);

function fakeEngine(dir) {
  const eng = new EventEmitter();
  eng.dataDir = dir;
  eng.settings = { host: '192.0.2.10', restPort: 80, awjPort: 10606, protocol: 'rest' };
  eng.presets = [];
  eng.destinations = [];
  eng.live = { inputs: {} };
  eng.log = () => {};
  eng.changed = () => {};
  eng.currentShow = { id: null, name: 'Desk' };
  eng.showStatus = () => ({ id: null, name: 'Desk', dirty: false });
  return eng;
}

async function poke(port, address, arg) {
  const sock = dgram.createSocket('udp4');
  const args = typeof arg === 'number' ? [arg] : [{ type: 's', value: String(arg) }];
  await new Promise((resolve, reject) => {
    sock.send(osc.encode(address, args), port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  sock.close();
}

async function until(fn, ms, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    try { if (fn()) return; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(label || (last && last.message) || 'timed out');
}

test('a plain clips get line keeps a name that contains spaces', () => {
  const clip = parseClipLine('2: Walk In Reel 01:00:10:00 00:01:00:00');
  assert.equal(clip.name, 'Walk In Reel');
  assert.equal(clip.start, '01:00:10:00');
  assert.equal(clip.duration, '00:01:00:00');
});

test('clips get version 2 keeps the name in the last field', () => {
  const clip = parseClipLine('2: 01:00:10:00 00:01:00:00 01:00:10:00 01:01:10:00 Opener Reel');
  assert.equal(clip.name, 'Opener Reel');
  assert.equal(clip.in, '01:00:10:00');
  assert.equal(clip.out, '01:01:10:00');
});

test('HyperDeck connect only reads, then the clip list and remaining time are on the view', async () => {
  const deck = new MockHyperDeck();
  const port = await deck.start(0);
  const driver = new HyperDeckDriver({ host: '127.0.0.1', port }, () => {}, () => {});
  try {
    await driver.connect();
    assert.deepEqual(deck.lines.filter((l) => ACTION.test(l)), []);
    for (const line of ['notify: transport: true', 'slot info', 'clips get', 'transport info']) {
      assert.ok(deck.lines.includes(line), line);
    }
    const view = driver.view();
    assert.equal(view.transport.status, 'stopped');
    assert.equal(view.timecode, '01:00:02:12');
    assert.equal(view.elapsed, '00:00:02:12');
    assert.equal(view.remaining, '00:00:07:13');
    assert.equal(view.clip, 1);
    assert.equal(view.clipName, 'Walk In');
    assert.deepEqual(view.clips.map((c) => c.name), ['Walk In', 'Opener']);
    assert.equal(view.slot.status, 'mounted');
    assert.equal(view.slot.recordingTime, 3600);
    assert.equal(view.variables.remaining, '00:00:07:13');
    assert.equal(view.variables.transport, 'stopped');
    assert.equal(view.variables.clips, 'Walk In, Opener');

    const listed = await driver.transportCmd('clips');
    assert.equal(listed.clips.length, 2);

    const picked = await driver.transportCmd('goto', { clip: 2 });
    assert.equal(picked.clip, 2);
    assert.equal(picked.elapsed, '00:00:00:00');
    assert.equal(picked.remaining, '00:01:00:00');
    assert.equal(driver.view().clipName, 'Opener');

    await driver.transportCmd('play');
    assert.equal(driver.view().transport.status, 'play');
    await driver.transportCmd('stop');
    assert.equal(driver.view().transport.status, 'stopped');
  } finally {
    driver.close();
    await deck.stop();
  }
});

test('HyperDeck version 2 clip lines still produce remaining time', async () => {
  const deck = new MockHyperDeck();
  deck.clipVersion = 2;
  const port = await deck.start(0);
  const driver = new HyperDeckDriver({ host: '127.0.0.1', port }, () => {}, () => {});
  try {
    await driver.connect();
    const view = driver.view();
    assert.equal(view.clips[0].name, 'Walk In');
    assert.equal(view.clips[0].in, '01:00:00:00');
    assert.equal(view.remaining, '00:00:07:13');
  } finally {
    driver.close();
    await deck.stop();
  }
});

test('Mitti connect does not play or cue, and the cue list and remaining time are readable', async () => {
  const mitti = new MockMitti();
  const port = await mitti.start(0);
  const driver = new MittiDriver({ host: '127.0.0.1', port }, () => {}, () => {});
  try {
    await driver.connect();
    const sent = mitti.messages.map((m) => m.address);
    assert.deepEqual(sent.filter((a) => MITTI_ACTION.has(a)), []);
    assert.ok(sent.includes('/mitti/resendOSCFeedback'));
    const view = driver.view();
    assert.equal(view.mode, 'pause');
    assert.equal(view.transport, 'pause');
    assert.equal(view.cue, '1');
    assert.equal(view.cueName, 'Walk In');
    assert.equal(view.remaining, '00:00:45:00');
    assert.equal(view.elapsed, '00:00:15:00');
    assert.equal(view.duration, '00:01:00:00');
    assert.deepEqual(view.cues.map((c) => c.name), ['Walk In', 'Opener']);
    assert.equal(view.variables.remaining, '00:00:45:00');
    assert.equal(view.variables.cues, 'Walk In, Opener');

    await poke(driver.sock.address().port, '/mitti/cueTimeLeft', '-00:00:12:00');
    await poke(driver.sock.address().port, '/mitti/3/cueName', 'Closer');
    await until(() => driver.view().remaining === '00:00:12:00' && driver.view().cues.some((c) => c.id === '3'), 500, 'osc feedback');
    assert.equal(driver.view().cues.find((c) => c.id === '3').name, 'Closer');

    const cued = await driver.send('cue', 2);
    assert.equal(cued.cue, 2);
    assert.equal(driver.view().cue, 2);
    await until(() => mitti.messages.some((m) => m.address === '/mitti/cue'), 500, 'cue osc');
    const cueMsg = mitti.messages.filter((m) => m.address === '/mitti/cue');
    assert.equal(cueMsg.length, 1);
    assert.equal(cueMsg[0].args[0].type, 'i');
    assert.equal(cueMsg[0].args[0].value, 2);
  } finally {
    driver.close();
    await mitti.stop();
  }
});

test('the system view carries HyperDeck and Mitti clocks for Companion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hd-'));
  const deck = new MockHyperDeck();
  const mitti = new MockMitti();
  const deckPort = await deck.start(0);
  const mittiPort = await mitti.start(0);
  const sm = new SystemManager({
    dataDir: dir,
    engine: fakeEngine(dir),
    autoStart: false,
    overrides: {
      hyperdeck: { host: '127.0.0.1', port: deckPort },
      mitti: { host: '127.0.0.1', port: mittiPort },
    },
  });
  try {
    await sm.connect('hyperdeck');
    await sm.connect('mitti');
    const views = sm.allViews();
    assert.equal(views.hyperdeck.remaining, '00:00:07:13');
    assert.equal(views.hyperdeck.variables.clip, '1');
    assert.equal(views.hyperdeck.clips.length, 2);
    assert.equal(sm.counts('hyperdeck').transport, 'stopped');
    assert.equal(sm.counts('hyperdeck').timecode, '01:00:02:12');
    assert.equal(views.mitti.remaining, '00:00:45:00');
    assert.equal(views.mitti.cues.length, 2);
    assert.equal(sm.counts('mitti').mode, 'pause');
    assert.equal(sm.counts('mitti').cue, '1');
    assert.deepEqual(deck.lines.filter((l) => ACTION.test(l)), []);
    assert.deepEqual(mitti.messages.map((m) => m.address).filter((a) => MITTI_ACTION.has(a)), []);
  } finally {
    sm.close();
    await deck.stop();
    await mitti.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
