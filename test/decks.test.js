'use strict';
// DECKS: page library from the desk, jump warnings, and deploy through the Path C plugin HTTP API.
// The mock hardware exists only in this file. Control Center itself always calls the plugin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');
const { SURFACES, surfaceFor } = require('../lib/decks/surfaces');
const { libraryFor, stampPage, stackWarnings, moveItem } = require('../lib/decks/pages');
const { createPluginServer } = require('../lib/decks/plugin-server');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('surface size follows the model name, then the Elgato type', () => {
  assert.equal(surfaceFor({ model: 'Stream Deck + XL' }).id, 'plusxl');
  assert.equal(surfaceFor({ model: 'Stream Deck +' }).id, 'plus');
  assert.equal(surfaceFor({ model: 'Stream Deck Mini' }).id, 'mini');
  assert.equal(surfaceFor({ model: 'Stream Deck Neo' }).id, 'neo');
  assert.equal(surfaceFor({ type: 2 }).id, 'xl');
  assert.equal(surfaceFor({ columns: 5, rows: 3 }).id, 'mk2');
});

test('page library is the systems on the desk, and a push stamps the camera', () => {
  const desk = {
    armed: ['rs6', 'ptz'],
    byKey: {
      rs6: { host: '192.0.2.20', port: 80 },
      ptz: { cameras: [{ id: 'cam3', name: 'Center', host: '10.1.2.3', port: 80 }], selected: 'cam3' },
    },
  };
  const pages = libraryFor(desk, SURFACES.xl);
  const ids = pages.map((p) => p.id);
  assert.ok(ids.includes('rs6-presets'));
  assert.ok(ids.includes('ptz-live'));
  assert.ok(!ids.includes('atem-switcher'));
  assert.ok(!ids.includes('e2-presets'));
  const live = stampPage(pages.find((p) => p.id === 'ptz-live'), desk);
  assert.equal(live.device.cam, 'cam3');
  assert.equal(live.device.host, '10.1.2.3');
  const recall = live.keys.find((k) => k.action && /recall/.test(k.action.path));
  assert.equal(recall.action.body.cam, 'cam3');
  assert.equal(recall.caption, 'Center');
  const warn = stackWarnings(['ptz-live'], pages);
  assert.ok(warn.some((w) => /PTZ LIVE jumps to PTZ PAINT/.test(w.message)));
  assert.equal(stackWarnings(['ptz-live', 'ptz-paint', 'ptz-func', 'ptz-move'], pages).length, 0);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
});

test('the plugin HTTP server refuses to start without hardware and 404s an unknown deck', async () => {
  assert.throws(() => createPluginServer(), /hardware adapter/);
  const pushed = [];
  const hardware = {
    devices: () => [{ id: '@(1)[4057/150]', name: 'Show XL', model: 'Stream Deck XL', type: 2, columns: 8, rows: 4, online: true }],
    deploy(deviceId, body) {
      if (deviceId !== '@(1)[4057/150]') {
        const e = new Error('unknown device'); e.status = 404; throw e;
      }
      pushed.push({ deviceId, pages: body.pages });
      return { ok: true, loaded: body.pages.map((p) => p.title) };
    },
  };
  const plugin = await createPluginServer({ hardware, port: 0 }).listen();
  try {
    const missing = await fetch(`${plugin.url}/v1/deploy`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: '@(1)[nope/1]', pages: [{ id: 'x' }] }),
    });
    assert.equal(missing.status, 404);
    const health = await fetch(`${plugin.url}/v1/health`);
    assert.equal((await health.json()).plugin, 'com.performancevideo.control');
  } finally { await plugin.close(); }
});

test('Control Center lists plugin decks, stamps on push, warns, reorders, and deploys only online decks', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({
    dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false,
    overrides: { ptz: { cameras: [{ id: 'cam3', name: 'Center', host: '10.1.2.3', port: 80 }] } },
  });
  systems.cfg.armed = ['rs6', 'ptz'];
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  const pushed = [];
  const hardware = {
    devices: () => [
      { id: '@(1)[4057/150]', name: 'Show XL', model: 'Stream Deck XL', type: 2, columns: 8, rows: 4, online: true },
      { id: 'mini-off', name: 'Spare Mini', model: 'Stream Deck Mini', type: 1, online: false },
      { id: 'neo-empty', name: 'Empty Neo', model: 'Stream Deck Neo', type: 9, online: true },
    ],
    deploy(deviceId, body) {
      pushed.push({ deviceId, pages: body.pages });
      return { ok: true, loaded: body.pages.map((p) => p.title) };
    },
  };
  const plugin = await createPluginServer({ hardware, port: 0 }).listen();
  try {
    const hello = await call('POST', '/api/decks/hello', { url: plugin.url, devices: [{ id: 'fake', name: 'Invented Deck', model: 'Stream Deck XL', online: true }] });
    assert.equal(hello.status, 200);
    assert.ok(!hello.json.devices.some((d) => d.id === 'fake'), 'a hello body is not a device list');
    assert.deepEqual(hello.json.devices.map((d) => d.id), ['@(1)[4057/150]', 'mini-off', 'neo-empty']);
    assert.equal(hello.json.devices[0].surfaceId, 'xl');
    assert.equal(hello.json.devices[1].online, false);
    const libIds = hello.json.library.xl.map((p) => p.id);
    assert.ok(libIds.includes('ptz-live') && libIds.includes('rs6-presets'));
    assert.ok(!libIds.includes('atem-macros'));
    const stamped = hello.json.library.xl.find((p) => p.id === 'ptz-live');
    assert.equal(stamped.device.host, '10.1.2.3');
    assert.equal(stamped.keys.find((k) => k.action).action.body.cam, 'cam3');

    const bad = await call('POST', '/api/decks/stack', { deviceId: '@(1)[4057/150]', pages: ['not-a-page'] });
    assert.equal(bad.status, 400);
    const stack = await call('POST', '/api/decks/stack', { deviceId: '@(1)[4057/150]', pages: ['ptz-live', 'ptz-paint', 'rs6-presets'] });
    assert.equal(stack.status, 200);
    assert.ok(stack.json.warnings.some((w) => /PTZ FUNC/.test(w.message)), 'live still jumps to FUNC, which is not on the stack');
    const moved = await call('POST', '/api/decks/stack', { deviceId: '@(1)[4057/150]', from: 2, to: 0 });
    assert.deepEqual(moved.json.pages, ['rs6-presets', 'ptz-live', 'ptz-paint']);
    const liveOnly = await call('POST', '/api/decks/stack', { deviceId: '@(1)[4057/150]', pages: ['ptz-live'] });
    assert.ok(liveOnly.json.warnings.some((w) => /not on this deck/.test(w.message)));

    const gone = await call('POST', '/api/decks/deploy', { deviceId: '@(1)[nope/1]' });
    assert.equal(gone.status, 404);
    const offline = await call('POST', '/api/decks/stack', { deviceId: 'mini-off', pages: ['rs6-presets'] });
    assert.equal(offline.status, 200);
    const offPush = await call('POST', '/api/decks/deploy', { deviceId: 'mini-off' });
    assert.equal(offPush.status, 409);

    const push = await call('POST', '/api/decks/deploy', { deviceId: '@(1)[4057/150]' });
    assert.equal(push.status, 200, JSON.stringify(push.json));
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].deviceId, '@(1)[4057/150]');
    assert.equal(pushed[0].pages[0].id, 'ptz-live');
    assert.equal(pushed[0].pages[0].device.cam, 'cam3');
    assert.equal(pushed[0].pages[0].device.host, '10.1.2.3');
    assert.ok(pushed[0].pages[0].keys.some((k) => k.action && k.action.body && k.action.body.cam === 'cam3'));
    assert.ok(push.json.warnings.length > 0);

    const all = await call('POST', '/api/decks/deploy-all');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.deployed.map((d) => d.deviceId), ['@(1)[4057/150]']);
    assert.ok(all.json.skipped.some((s) => s.deviceId === 'mini-off' && s.reason === 'offline'));
    assert.ok(all.json.skipped.some((s) => s.deviceId === 'neo-empty' && s.reason === 'empty'));
    assert.ok(pushed.every((p) => p.deviceId === '@(1)[4057/150]'));

    await plugin.close();
    const down = await call('GET', '/api/decks');
    assert.equal(down.status, 200);
    assert.equal(down.json.plugin.online, false);
    assert.deepEqual(down.json.devices, []);
    const downPush = await call('POST', '/api/decks/deploy', { deviceId: '@(1)[4057/150]' });
    assert.equal(downPush.status, 502);
  } finally {
    server.close();
    systems.close();
    await plugin.close();
    await ctx.teardown();
  }
});

test('DECKS is a top tab and the client calls the plugin routes, not Companion', () => {
  const html = read('public/index.html');
  const js = read('public/decks.js');
  assert.match(html, /class="tab tab-decks" data-tab="decks"/);
  assert.match(html, /id="pane-decks"/);
  assert.match(html, /id="btnDeckAll"/);
  assert.match(html, /src="\/decks\.js"/);
  assert.match(read('public/app.js'), /'decks'/);
  assert.match(read('public/sys.js'), /decks: \['decks'\]/);
  assert.match(js, /\/api\/decks\/deploy/);
  assert.match(js, /\/api\/decks\/deploy-all/);
  assert.match(js, /\/api\/decks\/stack/);
  assert.doesNotMatch(js, /\/api\/companion/);
  assert.match(read('lib/server.js'), /\\\/api\\\/decks\\\/deploy/);
  assert.match(read('streamdeck/src/plugin.ts'), /startDeckServer/);
  assert.match(read('streamdeck/src/serve.ts'), /\/api\/decks\/hello/);
});
