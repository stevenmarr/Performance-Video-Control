'use strict';
// A saved surface page deploys through the same Path C plugin call as a built-in stack.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');
const { SURFACES } = require('../lib/decks/surfaces');
const { ButtonLibrary } = require('../lib/decks/button-library');
const { compileUserPage, actionToRequest } = require('../lib/decks/page-push');
const { createPluginServer } = require('../lib/decks/plugin-server');

test('a library page becomes the plugin page shape without eating the last row', () => {
  const data = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'push-'));
  const lib = new ButtonLibrary({ dataDir: data });
  const cut = lib.createButton({ name: 'CUT', role: 'hot', element: 'button', text: 'CUT', actions: { press: [{ action: 'atem.cut' }] } });
  const program = lib.createButton({ name: 'Program', role: 'program', element: 'button', text: '$(atem:name)', actions: { press: [{ action: 'atem.program', options: { source: 1 } }] } });
  const iris = lib.createButton({ name: 'Iris', role: 'toggle', element: 'encoder', text: 'IRIS', actions: { turn: [{ action: 'ptz.iris' }] } });
  const page = lib.createPage({
    name: 'Show ATEM',
    surface: 'plusxl',
    keys: [{ row: 3, col: 8, buttonId: cut.id }, { row: 0, col: 0, buttonId: program.id }],
    encoders: [{ col: 0, buttonId: iris.id }],
  });
  const desk = { byKey: { ptz: { cameras: [{ id: 'cam3', name: 'Center', host: '10.1.2.3', port: 80 }], selected: 'cam3' }, atem: { short: 'Constellation', host: '192.0.2.40' } } };
  const built = compileUserPage(page, lib.byId(), SURFACES.plusxl, desk);
  const corner = built.keys.find((key) => key.row === 3 && key.col === 8);
  assert.equal(built.title, 'Show ATEM');
  assert.equal(corner.label, 'CUT');
  assert.equal(corner.action.path, '/api/sys/atem/cmd/cut');
  assert.equal(corner.action.method, 'POST');
  assert.equal(built.keys.find((key) => key.row === 0 && key.col === 0).label, 'Constellation');
  assert.equal(built.knobs[0].col, 0);
  assert.equal(built.knobs[0].action.path, '/api/sys/ptz/cmd/iris');
  assert.equal(built.knobs[0].action.body.cam, 'cam3');
  assert.equal(built.dials.length, 9);
  assert.ok(built.dials.every((dial) => typeof dial === 'string'));
  assert.equal(actionToRequest({ action: 'nav.home' }), null);
  assert.equal(actionToRequest({ action: 'nav.page', options: { page: 'atem-switcher' } }).jump, 'atem-switcher');
  require('fs').rmSync(data, { recursive: true, force: true });
});

test('pushing a saved page deploys it first and leaves a built-in stack in place', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({
    dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false,
    overrides: { ptz: { cameras: [{ id: 'cam3', name: 'Center', host: '10.1.2.3', port: 80 }] } },
  });
  systems.cfg.armed = ['rs6', 'ptz'];
  const server = createServer(ctx.engine, systems);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
    ],
    deploy(deviceId, body) {
      pushed.push({ deviceId, pages: body.pages });
      return { ok: true, loaded: body.pages.map((p) => p.title) };
    },
  };
  const plugin = await createPluginServer({ hardware, port: 0 }).listen();
  try {
    const hello = await call('POST', '/api/decks/hello', { url: plugin.url });
    assert.equal(hello.status, 200);
    const cut = await call('POST', '/api/buttons', { name: 'CUT', role: 'hot', text: 'CUT', actions: { press: [{ action: 'atem.cut' }] } });
    const page = await call('POST', '/api/surface-pages', { name: 'Show ATEM', surface: 'xl', keys: [{ row: 3, col: 7, buttonId: cut.json.id }] });
    const empty = await call('POST', '/api/surface-pages', { name: 'Empty', surface: 'xl' });
    assert.equal(page.status, 200);

    const stack = await call('POST', '/api/decks/stack', { deviceId: '@(1)[4057/150]', pages: ['ptz-live', page.json.id] });
    assert.equal(stack.status, 200, JSON.stringify(stack.json));
    const builtIn = await call('POST', '/api/decks/deploy', { deviceId: '@(1)[4057/150]' });
    assert.equal(builtIn.status, 200, JSON.stringify(builtIn.json));
    assert.equal(pushed[0].pages[0].id, 'ptz-live');
    assert.equal(pushed[0].pages[0].device.cam, 'cam3');
    const saved = pushed[0].pages.find((p) => p.id === page.json.id);
    assert.equal(saved.title, 'Show ATEM');
    assert.equal(saved.keys.find((key) => key.row === 3 && key.col === 7).label, 'CUT');
    assert.equal(saved.keys.find((key) => key.row === 3 && key.col === 7).action.path, '/api/sys/atem/cmd/cut');

    pushed.length = 0;
    const again = await call('POST', '/api/decks/deploy', { deviceId: '@(1)[4057/150]', pageId: page.json.id });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(pushed[0].deviceId, '@(1)[4057/150]');
    assert.equal(pushed[0].pages[0].id, page.json.id);
    assert.ok(pushed[0].pages.some((p) => p.id === 'ptz-live'));
    assert.ok(again.json.loaded.includes('Show ATEM'));
    const view = await call('GET', '/api/decks');
    const device = view.json.devices.find((d) => d.id === '@(1)[4057/150]');
    assert.deepEqual(device.pages.map((p) => p.id), [page.json.id, 'ptz-live']);
    assert.ok(device.loaded.includes('Show ATEM'));

    const blank = await call('POST', '/api/decks/deploy', { deviceId: '@(1)[4057/150]', pageId: empty.json.id });
    assert.equal(blank.status, 400);
    assert.match(blank.json.error, /no buttons/);
    const missing = await call('POST', '/api/decks/deploy', { deviceId: '@(1)[nope/1]', pageId: page.json.id });
    assert.equal(missing.status, 404);
    const offline = await call('POST', '/api/decks/deploy', { deviceId: 'mini-off', pageId: page.json.id });
    assert.equal(offline.status, 409);

    await plugin.close();
    const down = await call('POST', '/api/decks/deploy', { deviceId: '@(1)[4057/150]', pageId: page.json.id });
    assert.equal(down.status, 502);
  } finally {
    server.close();
    systems.close();
    await plugin.close();
    await ctx.teardown();
  }
});
