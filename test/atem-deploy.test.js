'use strict';
// A + XL deploy of atem-switcher is the USB key-class face. An XL keeps the packed page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');
const { createPluginServer } = require('../lib/decks/plugin-server');
const { bindSwitcher } = require('../lib/decks/atem-xl-page');

test('deploying the + XL ATEM page matches the USB face and an XL stays on the old page', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  systems.cfg.armed = ['atem'];
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
      { id: 'plus-1', name: 'Show + XL', model: 'Stream Deck + XL', type: 11, columns: 9, rows: 4, online: true },
      { id: 'xl-1', name: 'Show XL', model: 'Stream Deck XL', type: 2, columns: 8, rows: 4, online: true },
    ],
    deploy(deviceId, body) {
      pushed.push({ deviceId, pages: body.pages });
      return { ok: true, loaded: body.pages.map((page) => page.title) };
    },
  };
  const plugin = await createPluginServer({ hardware, port: 0 }).listen();
  try {
    assert.equal((await call('POST', '/api/decks/hello', { url: plugin.url })).status, 200);
    assert.equal((await call('POST', '/api/decks/stack', { deviceId: 'plus-1', pages: ['atem-switcher'] })).status, 200);
    const plus = await call('POST', '/api/decks/deploy', { deviceId: 'plus-1' });
    assert.equal(plus.status, 200, JSON.stringify(plus.json));
    const page = pushed[0].pages.find((item) => item.id === 'atem-switcher');
    const usb = bindSwitcher(server.decks.desk(), server.decks.sessionFor({ id: 'plus-1' }), 'atem');
    assert.equal(page.keys.length, usb.keys.length);
    page.keys.forEach((key, i) => {
      const face = usb.keys[i];
      assert.equal(key.row, face.row);
      assert.equal(key.col, face.col);
      assert.equal(key.label, face.label || ' ');
      if (face.action && face.action.path) assert.deepEqual(key.action, { method: face.action.method || 'POST', path: face.action.path, body: face.action.body || {} });
      else assert.equal(key.action, null);
    });
    assert.equal(page.keys.find((key) => key.row === 2 && key.col === 8).label, 'CUT');
    assert.equal(page.keys.find((key) => key.row === 3 && key.col === 8).label, 'TRANS');
    assert.ok(page.dials.every((dial) => typeof dial === 'string'));
    assert.deepEqual(page.keyClass.dials, usb.dials);
    assert.equal(page.keyClass.keys.length, usb.keys.length);

    assert.equal((await call('POST', '/api/decks/stack', { deviceId: 'xl-1', pages: ['atem-switcher'] })).status, 200);
    const xl = await call('POST', '/api/decks/deploy', { deviceId: 'xl-1' });
    assert.equal(xl.status, 200, JSON.stringify(xl.json));
    const packed = pushed.find((push) => push.deviceId === 'xl-1').pages.find((item) => item.id === 'atem-switcher');
    assert.equal(packed.title, 'ATEM SWITCHER');
    assert.equal(packed.keyClass, undefined);
    assert.ok(packed.keys.some((key) => key.label === 'AUTO'));
    assert.ok(packed.keys.some((key) => key.action && key.action.path === '/api/sys/atem/cmd/cut'));
  } finally {
    server.decks.stopUsb();
    server.close();
    systems.close();
    await plugin.close();
    await ctx.teardown();
  }
});
