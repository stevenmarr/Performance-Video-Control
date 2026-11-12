'use strict';
// Scan USB is POST /api/decks/refresh. One press rescans USB and the Path C list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');
const { createPluginServer } = require('../lib/decks/plugin-server');

test('Scan USB rescans USB once and refreshes the plugin list once', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let scans = 0;
  server.decks.usb.scan = async () => {
    scans += 1;
    server.decks.usb.lastReport = { installed: true, found: 1, opened: [{ serial: 'CL1', path: '/dev/hidraw9' }], failed: [], skipped: [] };
    return [{ id: 'usb-1', name: 'Desk XL', model: 'Stream Deck XL', serial: 'CL1', columns: 8, rows: 4 }];
  };
  server.decks.usb.paint = async () => {};
  server.decks.usb.buttonSize = () => null;
  let lists = 0;
  const hardware = {
    devices: () => {
      lists += 1;
      return [{ id: '@(1)[4057/150]', name: 'Show XL', model: 'Stream Deck XL', type: 2, columns: 8, rows: 4, online: true }];
    },
    deploy() { return { ok: true, loaded: [] }; },
  };
  const plugin = await createPluginServer({ hardware, port: 0 }).listen();
  try {
    assert.match(fs.readFileSync(require('path').join(__dirname, '..', 'public/decks.js'), 'utf8'), /POST', '\/api\/decks\/refresh'/);
    const hello = await fetch(base + '/api/decks/hello', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: plugin.url }),
    });
    assert.equal(hello.status, 200);
    const beforeScan = scans;
    const beforeList = lists;
    const res = await fetch(base + '/api/decks/refresh', { method: 'POST' });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(scans - beforeScan, 1);
    assert.equal(lists - beforeList, 1);
    assert.ok(json.devices.some((device) => device.id === '@(1)[4057/150]'));
    assert.ok(json.control.devices.some((device) => device.id === 'usb-1'));
  } finally {
    server.decks.stopUsb();
    server.close();
    systems.close();
    await plugin.close();
    await ctx.teardown();
  }
});
