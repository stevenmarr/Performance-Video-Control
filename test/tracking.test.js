'use strict';
// PTZ auto-tracking: settings file, the bridge to the Mac app, and the override that a desk move sends.
// The Mac app is simulated with a WebSocket server. No test contacts a real camera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { cleanSettings, loadStore, saveStore, fileFor, nudge, defaults } = require('../lib/tracking/settings');
const { actionToRequest } = require('../lib/decks/page-push');
const deck = require('../lib/deck');
const { TrackingService } = require('../lib/tracking/service');
const { FrameDecoder } = require('../lib/tracking/ws');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { MockPTZ } = require('../lib/mocks/ptz');
const { setup } = require('./helpers');

const until = async (fn, ms = 3000, what = 'condition') => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

function serverFrame(text) {
  const data = Buffer.from(text);
  let header;
  if (data.length < 126) header = Buffer.from([0x81, data.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  }
  return Buffer.concat([header, data]);
}

function mockTracker() {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    let up = false;
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      if (!up) {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end).toString('utf8');
        const key = (/Sec-WebSocket-Key:\s*(.+)/i.exec(head) || [])[1];
        const crypto = require('crypto');
        const accept = crypto.createHash('sha1').update(`${(key || '').trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        up = true;
        const rest = buf.slice(end + 4);
        buf = Buffer.alloc(0);
        if (rest.length) for (const frame of decoder.push(rest)) take(frame);
        return;
      }
      for (const frame of decoder.push(chunk)) take(frame);
    });
    socket.on('close', () => sockets.delete(socket));
    function take(frame) {
      if (frame.opcode !== 1) return;
      try { messages.push(JSON.parse(frame.payload.toString('utf8'))); } catch { /* not a tracker message */ }
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, messages, port: server.address().port,
      send(obj) { const frame = serverFrame(JSON.stringify(obj)); for (const s of sockets) s.write(frame); },
      close() { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); },
    }));
  });
}

test('tracking settings: clamps, preset framing, atomic file, a corrupt file falls back', () => {
  const wide = cleanSettings({ preset: 'wide', smoothing: 9, maxSpeed: { pan: 400, tilt: 0, zoom: 3 }, streamUrl: 'file:///etc/passwd', detect: 'face' });
  assert.equal(wide.preset, 'wide');
  assert.equal(wide.framing.headroom, 0.16);
  assert.equal(wide.framing.subjectHeight, 0.38);
  assert.equal(wide.smoothing, 1);
  assert.equal(wide.maxSpeed.pan, 49);
  assert.equal(wide.maxSpeed.tilt, 1);
  assert.equal(wide.streamUrl, '');
  assert.equal(wide.detect, 'face');
  const custom = cleanSettings({ preset: 'custom', framing: { subjectHeight: 0.42, headroom: 0.2, anchorX: 0.4, lead: 0.1 } });
  assert.equal(custom.framing.subjectHeight, 0.42);
  assert.equal(cleanSettings({ lostAction: 'stop' }).lostAction, 'stop');
  assert.equal(cleanSettings({ source: 'jpeg' }).source, 'jpeg');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-track-'));
  const store = loadStore(dir);
  assert.equal(store.loaded, false);
  assert.equal(store.link.port, 8765);
  store.cameras['ptz:cam1'] = cleanSettings({ preset: 'close' });
  store.loaded = true;
  saveStore(store);
  const raw = fs.readFileSync(fileFor(dir), 'utf8');
  assert.equal(JSON.parse(raw).cameras['ptz:cam1'].preset, 'close');
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  fs.writeFileSync(fileFor(dir), 'null');
  const again = loadStore(dir);
  assert.equal(again.loaded, false);
  assert.deepEqual(again.cameras, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tracking bridge: settings, status, start, and a desk move tells the tracker to let go', async () => {
  const ctx = await setup({});
  const cam = new MockPTZ({ model: 'AW-UE150', title: 'CAM-1' });
  const tracker = await mockTracker();
  const list = [{ id: 'cam1', name: 'Wide', host: '127.0.0.1', port: await cam.start(0), user: 'admin', pass: 'secret' }];
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides: { ptz: { cameras: list } }, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json().catch(() => null);
    return { status: r.status, json };
  };
  try {
    let view = (await call('GET', '/api/sys/ptz/tracking')).json;
    assert.equal(view.link.connected, false);
    assert.equal(view.cameras[0].name, 'Wide');
    assert.equal(view.cameras[0].settings.preset, 'medium');
    assert.equal((await call('POST', '/api/sys/ptz/tracking/link', { host: '127.0.0.1', port: tracker.port })).json.connected, false);
    await until(() => tracker.messages.some((m) => m.type === 'hello' && m.role === 'control'), 2000, 'hello');
    view = (await call('GET', '/api/sys/ptz/tracking')).json;
    assert.equal(view.link.connected, true);
    assert.equal(view.link.port, tracker.port);

    const saved = await call('POST', '/api/sys/ptz/tracking/settings', { cam: 'cam1', detect: 'face', preset: 'wide', latencyMs: 240 });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.cameras[0].settings.detect, 'face');
    assert.equal(saved.json.cameras[0].settings.framing.headroom, 0.16);
    assert.equal(JSON.stringify(saved.json).includes('secret'), false, 'the page does not receive the camera password');
    const pushed = await until(() => tracker.messages.find((m) => m.type === 'settings.set'), 2000, 'settings.set');
    assert.equal(pushed.cameraId, 'ptz:cam1');
    assert.equal(pushed.settings.detect, 'face');
    assert.equal(pushed.settings.control.host, '127.0.0.1');
    assert.equal(pushed.settings.control.password, 'secret');
    assert.match(pushed.settings.control.streamUrl, /\/cgi-bin\/mjpeg\?resolution=640&framerate=15$/);
    const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'ptz-tracking.json'), 'utf8'));
    assert.equal(JSON.stringify(onDisk).includes('secret'), false);

    assert.equal((await call('POST', '/api/sys/ptz/tracking/start', { cam: 'cam1' })).status, 200);
    await until(() => tracker.messages.some((m) => m.type === 'start' && m.cameraId === 'ptz:cam1'), 2000, 'start');
    tracker.send({ v: 1, type: 'status', cameraId: 'ptz:cam1', state: 'locked', fps: 14.2, detections: [{ id: 't3', x: 0.4, y: 0.12, w: 0.2, h: 0.55, confidence: 0.9, kind: 'body', missing: false }], lockedTarget: 't3', lastCommand: { pan: 6, tilt: 0, zoom: 0, panTilt: 'PTS5650' } });
    view = await until(async () => {
      const got = (await call('GET', '/api/sys/ptz/tracking')).json;
      return got.cameras[0].status.state === 'locked' ? got : null;
    }, 2000, 'status');
    assert.equal(view.cameras[0].status.lockedTarget, 't3');
    assert.equal(view.cameras[0].status.detections[0].id, 't3');
    assert.equal(view.cameras[0].status.lastCommand.panTilt, 'PTS5650');

    const before = tracker.messages.filter((m) => m.type === 'override').length;
    const moved = await call('POST', '/api/sys/ptz/cmd/move', { cam: 'cam1', pan: 10, tilt: 0, speed: true });
    assert.equal(moved.json.ok, true, JSON.stringify(moved.json));
    assert.equal(cam.s.pt, '6050');
    await until(() => tracker.messages.filter((m) => m.type === 'override').length > before, 2000, 'override');
    const over = tracker.messages.filter((m) => m.type === 'override').at(-1);
    assert.equal(over.cameraId, 'ptz:cam1');
    assert.equal(over.reason, 'operator');
    assert.equal(over.command, 'move');
    const n = tracker.messages.length;
    const held = await call('POST', '/api/sys/ptz/cmd/keepalive', { cam: 'cam1' });
    assert.equal(held.json.moving, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(tracker.messages.length, n, 'a keep-alive is not an operator move');

    assert.equal((await call('POST', '/api/sys/ptz/tracking/lock', { cam: 'nope', targetId: 't3' })).status, 404);
    assert.equal((await call('POST', '/api/sys/ptz/tracking/settings', { cam: 'cam1', source: 'jpeg' })).status, 200);
    const jpeg = await until(() => tracker.messages.find((m) => m.type === 'settings.set' && m.settings && m.settings.source === 'jpeg'), 2000, 'jpeg source');
    assert.match(jpeg.settings.control.streamUrl, /\/cgi-bin\/camera\?resolution=640$/);
  } finally {
    server.closeClients();
    await new Promise((r) => server.close(r));
    systems.close();
    await tracker.close();
    await cam.stop();
    await ctx.teardown();
  }
});

test('tracking feel, nudge, and the encoder actions stay inside the camera scale', async () => {
  const lecture = cleanSettings({ feel: 'lecture', smoothing: 0 });
  const sports = cleanSettings({ feel: 'sports' });
  assert.ok(lecture.maxSpeed.pan < sports.maxSpeed.pan);
  assert.ok(lecture.deadZone.x > sports.deadZone.x);
  assert.ok(lecture.jitter > sports.jitter);
  for (const speed of [lecture.maxSpeed.pan, lecture.maxSpeed.tilt, lecture.maxSpeed.zoom, sports.maxSpeed.pan, sports.maxSpeed.tilt, sports.maxSpeed.zoom]) {
    assert.ok(speed >= 1 && speed <= 49);
  }
  assert.equal(lecture.smoothing, 0.72, 'a named feel replaces a number sent with it');
  const kept = cleanSettings({ deadZone: { x: 0.2, y: 0.2, size: 0.2 }, lostAction: 'stop' });
  assert.equal(kept.feel, 'custom');
  assert.equal(kept.deadZone.x, 0.2);
  assert.equal(kept.lostAction, 'stop');

  const nudged = nudge(defaults(), 'deadZone', 1);
  assert.equal(nudged.feel, 'custom');
  assert.equal(Math.round(nudged.deadZone.x * 1000), Math.round((defaults().deadZone.x + 0.005) * 1000));
  assert.equal(nudge(defaults(), 'maxSpeed', 100).maxSpeed.pan, defaults().maxSpeed.pan + 20, 'a detent burst is clamped to 20');
  assert.equal(nudge({ maxSpeed: { pan: 48, tilt: 14, zoom: 8 } }, 'maxSpeed', 5).maxSpeed.pan, 49);
  assert.equal(nudge({ deadZone: { x: 0.2, y: 0.2, size: 0.2 } }, 'deadZone', 0, true).deadZone.x, defaults().deadZone.x);

  const sens = actionToRequest({ action: 'ptz.trackSensitivity', options: { steps: 1 } });
  assert.equal(sens.path, '/api/sys/ptz/tracking/tune');
  assert.equal(sens.body.param, 'deadZone');
  assert.equal(sens.body.steps, 1);
  const speed = actionToRequest({ action: 'ptz.trackSpeed', instance: 'ptz-ab12', options: { steps: -2 } });
  assert.equal(speed.path, '/api/sys/ptz-ab12/tracking/tune');
  assert.equal(speed.body.steps, -2);
  const dial = deck.plan({ gesture: 'dial', widget: 'trackSens', event: 'rotate', ticks: 2, snapshot: { selected: 'cam1' } });
  assert.equal(dial.requests[0].path, '/api/sys/ptz/tracking/tune');
  assert.equal(dial.requests[0].body.param, 'deadZone');
  assert.equal(dial.requests[0].body.steps, 2);
  assert.equal(dial.requests[0].body.cam, 'cam1');
  const reset = deck.plan({ gesture: 'dial', widget: 'trackSpeed', event: 'reset', snapshot: { selected: 'cam1' } });
  assert.equal(reset.requests[0].body.reset, true);
  assert.equal(reset.requests[0].body.param, 'maxSpeed');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-track-'));
  const svc = new TrackingService({ dataDir: dir, cameras: () => [{ id: 'cam1', name: 'Wide', host: '127.0.0.1', port: 80 }] });
  try {
    const saved = svc.saveProfile('ptz', { cam: 'cam1', name: 'Choir' });
    assert.equal(saved.profiles.length, 1);
    svc.tune('ptz', { cam: 'cam1', param: 'maxSpeed', steps: 2 });
    assert.equal(svc.view('ptz').cameras[0].settings.maxSpeed.pan, defaults().maxSpeed.pan + 2);
    const loaded = svc.loadProfile('ptz', { cam: 'cam1', id: saved.profiles[0].id });
    assert.equal(loaded.cameras[0].settings.maxSpeed.pan, defaults().maxSpeed.pan);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(fileFor(dir), 'utf8'))).includes('12345'), false);
  } finally { svc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tracking service does not connect until a link is saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-track-'));
  const svc = new TrackingService({ dataDir: dir, cameras: () => [] });
  assert.equal(svc.bridge.connected, false);
  assert.equal(svc.bridge.socket, null);
  svc.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
