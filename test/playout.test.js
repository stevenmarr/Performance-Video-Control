'use strict';
// Playout: HTTP control against the loopback mock. Connect is read-only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlayoutDriver, applyStatus, emptyState, COMMANDS } = require('../lib/drivers/playout');
const { MockPlayout } = require('../lib/mocks/playout');
const { SystemManager, SYSTEMS } = require('../lib/systems');

test('status JSON is tolerant of the documented shape and of missing fields', () => {
  const bare = applyStatus(emptyState(), '{"ok":true,"transport":"playing","frame":12,"buffered":3}');
  assert.equal(bare.transport, 'playing');
  assert.equal(bare.frame, 12);
  assert.equal(bare.buffered, 3);
  assert.equal(bare.elapsed, '12', 'the frame index is the elapsed position when no timecode is sent');
  assert.equal(bare.remaining, null);
  assert.equal(bare.clip, null);
  assert.equal(bare.standby, null);
  assert.equal(bare.cued, null);
  assert.deepEqual(bare.clips, []);
  assert.deepEqual(bare.playlist, []);
  assert.equal(applyStatus(emptyState(), 'not-json').transport, 'stopped');
  assert.equal(applyStatus(emptyState(), '').clip, null);

  const rich = applyStatus(emptyState(), {
    transport: 'paused',
    frame: 90,
    remaining: '00:01:00:00',
    timecode: '00:00:03:00',
    clip: { name: 'Keynote' },
    cue: '2',
    clips: ['Open', { name: 'Keynote', number: '2' }],
    standby: { name: 'Walk out' },
    cued: 'Walk out',
  });
  assert.equal(rich.transport, 'paused');
  assert.equal(rich.elapsed, '00:00:03:00');
  assert.equal(rich.remaining, '00:01:00:00');
  assert.equal(rich.clip, 'Keynote');
  assert.equal(rich.cue, '2');
  assert.equal(rich.standby, 'Walk out');
  assert.equal(rich.cued, 'Walk out');
  assert.deepEqual(rich.playlist.map((c) => c.name), ['Open', 'Keynote']);
  const framesOnly = applyStatus(emptyState(), { remaining: 2580 });
  assert.equal(framesOnly.remaining, '2580');
});

test('connect reads health, status, and lists, and posts nothing', async () => {
  const mock = new MockPlayout();
  const port = await mock.start(0);
  const d = new PlayoutDriver({ host: '127.0.0.1', port });
  try {
    const info = await d.connect();
    assert.equal(info.model, 'Playout');
    assert.equal(info.version, '0.2.0');
    assert.equal(d.status().connected, true);
    assert.deepEqual(mock.posts(), []);
    assert.deepEqual(mock.requests.map((r) => `${r.method} ${r.path}`), [
      'GET /health', 'GET /status', 'GET /clips', 'GET /playlist', 'GET /standby',
    ]);
    const view = d.view();
    assert.equal(view.transport, 'stopped');
    assert.equal(view.clip, 'Open');
    assert.equal(view.elapsed, '00:00:04:00');
    assert.equal(view.remaining, '00:01:26:00');
    assert.equal(view.standby, 'Keynote');
    assert.equal(view.cued, 'Keynote');
    assert.deepEqual(view.playlist.map((c) => c.name), ['Open', 'Keynote', 'Walk out']);
    const vars = Object.fromEntries(view.variables.map((v) => [v.id, v.value]));
    assert.equal(vars.connected, 'true');
    assert.equal(vars.remaining, '00:01:26:00');
    assert.equal(vars.clip, 'Open');
    assert.equal(vars.standby, 'Keynote');
    const flags = Object.fromEntries(view.feedbacks.map((f) => [f.id, f.active]));
    assert.equal(flags.connected, true);
    assert.equal(flags.playing, false);
    assert.equal(flags.stopped, true);
    assert.equal(flags.remaining, true);
    assert.equal(flags.cued, true);
    assert.ok(COMMANDS.play && COMMANDS.pause && COMMANDS.stop && COMMANDS.cue && COMMANDS.next);
    assert.equal(COMMANDS.go, undefined);
  } finally {
    d.close();
    await mock.stop();
  }
});

test('a minimal status document still connects, and the missing fields stay empty', async () => {
  const mock = new MockPlayout({ minimal: true });
  const port = await mock.start(0);
  const d = new PlayoutDriver({ host: '127.0.0.1', port });
  try {
    await d.connect();
    assert.deepEqual(mock.posts(), []);
    assert.equal(d.view().transport, 'stopped');
    assert.equal(d.view().elapsed, '120');
    assert.equal(d.view().remaining, null);
    assert.equal(d.view().clip, null);
    assert.equal(d.view().standby, null);
    assert.deepEqual(d.view().playlist, []);
    const flags = Object.fromEntries(d.feedbacks().map((f) => [f.id, f.active]));
    assert.equal(flags.remaining, false);
    assert.equal(flags.cued, false);
  } finally {
    d.close();
    await mock.stop();
  }
});

test('play, pause, stop, cue, and next; close does not stop the server', async () => {
  const mock = new MockPlayout();
  const port = await mock.start(0);
  const d = new PlayoutDriver({ host: '127.0.0.1', port });
  try {
    await d.connect();
    const before = mock.posts().length;
    const play = await d.send('play');
    assert.equal(play.transport, 'playing');
    assert.equal(mock.transport, 'playing');
    assert.equal(d.feedbacks().find((f) => f.id === 'playing').active, true);
    await d.send('pause');
    assert.equal(d.view().transport, 'paused');
    await d.send('play');
    await d.send('stop');
    assert.equal(d.view().transport, 'stopped');
    assert.equal(mock.frame, 0);
    const cue = await d.send('cue', { value: 'Walk out' });
    assert.equal(cue.clip, 'Walk out');
    assert.equal(mock.clip, 'Walk out');
    assert.equal(d.view().standby, 'Walk out');
    await d.send('cue', { value: '1' });
    assert.equal(d.view().clip, 'Open');
    assert.equal(d.view().standby, 'Keynote');
    const next = await d.send('next');
    assert.equal(next.clip, 'Keynote');
    assert.equal(d.view().standby, 'Walk out');
    await d.send('play');
    assert.ok(mock.posts().slice(before).every((r) => r.path !== '/transport/go'));
    assert.ok(mock.posts().some((r) => r.path === '/transport/next'));
    assert.ok(mock.posts().some((r) => r.path === '/rpc' && r.body.includes('playout.cues.jump')));
    const posted = mock.posts().length;
    assert.equal(mock.transport, 'playing');
    d.close();
    assert.equal(d.status().connected, false);
    assert.equal(mock.transport, 'playing', 'close does not send stop');
    assert.equal(mock.posts().length, posted);
    await assert.rejects(d.send('play'), /not connected/);
    await assert.rejects(d.send('explode'), /Unknown Playout command/);
    await assert.rejects(d.send('cue', {}), /not connected/);
  } finally {
    d.close();
    await mock.stop();
  }
});

test('a refused play stays stopped, and a missing next does not wrap the list', async () => {
  const refused = new MockPlayout({ refusePlay: true });
  const port = await refused.start(0);
  const d = new PlayoutDriver({ host: '127.0.0.1', port });
  try {
    await d.connect();
    await assert.rejects(d.send('play'), /Preroll/);
    assert.equal(refused.transport, 'stopped');
    assert.equal(d.view().transport, 'stopped');
  } finally {
    d.close();
    await refused.stop();
  }
  const end = new MockPlayout();
  end.clip = 'Walk out';
  end.cue = '3';
  const port2 = await end.start(0);
  const d2 = new PlayoutDriver({ host: '127.0.0.1', port: port2 });
  try {
    await d2.connect();
    assert.equal(d2.view().clip, 'Walk out');
    await assert.rejects(d2.send('next'), /no next clip/);
    assert.equal(end.clip, 'Walk out');
  } finally {
    d2.close();
    await end.stop();
  }
});

test('no host opens nothing', async () => {
  const d = new PlayoutDriver({ host: '' });
  await assert.rejects(d.connect(), /no IP address/);
  assert.equal(d.status().connected, false);
});

test('SystemManager lists Playout, connects without posting, and runs the transport', async () => {
  assert.equal(SYSTEMS.playout.short, 'Playout');
  assert.equal(SYSTEMS.playout.group, 'Media servers');
  const mock = new MockPlayout();
  const port = await mock.start(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playout-'));
  const eng = { settings: { host: '192.0.2.10' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} };
  const sm = new SystemManager({
    dataDir: dir,
    engine: eng,
    overrides: { playout: { host: '127.0.0.1', port } },
    autoStart: false,
  });
  try {
    assert.equal(sm.configured('playout'), true);
    const info = await sm.connect('playout');
    assert.equal(info.connected, true);
    assert.deepEqual(mock.posts(), []);
    const view = sm.view('playout');
    assert.equal(view.clip, 'Open');
    assert.equal(view.remaining, '00:01:26:00');
    assert.equal(view.standby, 'Keynote');
    assert.equal(sm.counts('playout').playlist, 3);
    assert.equal(sm.counts('playout').remaining, '00:01:26:00');
    const st = await sm.setActive('playout');
    assert.equal(st.active, 'playout');
    assert.equal(st.view.clip, 'Open');
    assert.ok(st.groups.some((g) => g.name === 'Media servers' && g.systems.includes('playout')));
    const play = await sm.playout('play', {});
    assert.equal(play.transport, 'playing');
    assert.equal(mock.transport, 'playing');
    await sm.playout('cue', { value: 'Keynote' });
    assert.equal(sm.view('playout').clip, 'Keynote');
    await sm.playout('next', {});
    assert.equal(sm.view('playout').clip, 'Walk out');
    assert.ok(mock.posts().every((r) => r.path !== '/transport/go'));
    await assert.rejects(sm.playout('reboot', {}), /Unknown Playout command/);
  } finally {
    await sm.close();
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
