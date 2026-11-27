'use strict';
// Shared BACKUP / STILLS pane: PixelHue PRIMARY restore needs confirm, and labels do not add 1.
// E2 keeps the +1 display and still resets a primary with or without the flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');
const { SystemManager } = require('../lib/systems');
const { MockE2 } = require('../lib/mocks/e2');
const { MockPixelHue } = require('../lib/mocks/pixelhue');

test('backup confirm reaches PixelHue PRIMARY restore; E2 reset is unchanged either way', async () => {
  const ctx = await setup({});
  const me = new MockE2(); const mp = new MockPixelHue();
  const overrides = { e2: { host: '127.0.0.1', port: await me.start(0) }, pixelhue: { host: '127.0.0.1', port: await mp.start(0) } };
  await ctx.engine.connect();
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    assert.equal((await call('POST', '/api/sys/active', { system: 'pixelhue' })).json.view.status.connected, true);
    const denied = await call('POST', '/api/sys/pixelhue/backups/2', { slot: -1 });
    assert.equal(denied.status, 400);
    assert.match(denied.json.error, /confirm: true/);
    assert.equal(mp.layers.find((l) => l.layerId === 21).source.general.sourceId, 8, 'a refused restore leaves the backup on air');
    const ok = await call('POST', '/api/sys/pixelhue/backups/2', { slot: -1, confirm: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(mp.layers.find((l) => l.layerId === 21).source.general.sourceId, 2);

    assert.equal((await call('POST', '/api/sys/active', { system: 'e2' })).json.view.status.connected, true);
    assert.equal((await call('POST', '/api/sys/e2/backups/3', { slot: -1 })).status, 200);
    assert.equal((await call('POST', '/api/sys/e2/backups/3', { slot: -1, confirm: true })).status, 200);
    const resets = me.calls('resetSourceMainBackup');
    assert.equal(resets.length, 2);
    assert.deepEqual(resets.map((c) => c.params), [{ id: 3 }, { id: 3 }]);
  } finally {
    await new Promise((r) => server.close(r));
    systems.close();
    await me.stop(); await mp.stop();
    await ctx.teardown();
  }
});

test('still and backup labels add 1 only for E2', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/sys.js'), 'utf8');
  const stills = src.slice(src.indexOf('function renderStills'), src.indexOf('function renderBackups'));
  const backups = src.slice(src.indexOf('function renderBackups'), src.indexOf("$('#xbkList').addEventListener"));
  assert.match(src, /const devOff = \(\) => \(\(V && \(V\.type \|\| V\.system\) === 'e2'\) \? 1 : 0\)/);
  assert.match(stills, /s\.id \+ off/);
  assert.match(stills, /input \+ off/);
  assert.match(stills, /file = slot - off/);
  assert.doesNotMatch(stills, /id \+ 1/);
  assert.match(backups, /Input \$\{x\.id \+ off\}/);
  assert.match(backups, /b\.id \+ off/);
  assert.match(backups, /inputId \?\? 0\) \+ off/);
  assert.doesNotMatch(backups, /id \+ 1/);
  const click = src.slice(src.indexOf("$('#xbkList')"));
  assert.match(click, /slot < 0\) body\.confirm = true/);
});
