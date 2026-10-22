'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');

async function withApp(fn, opts) {
  const ctx = await setup(opts);
  await ctx.engine.connect();
  const server = createServer(ctx.engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null), text: r.headers.get('content-type') };
  };
  try { await fn(call, ctx, base); } finally { server.closeClients(); await new Promise((r) => server.close(r)); await ctx.teardown(); }
}

test('HTTP control API used by the UI and Companion', async () => {
  await withApp(async (call, { mock }) => {
    let r = await call('GET', '/api/state');
    assert.equal(r.status, 200); assert.equal(r.json.connected, true); assert.equal(r.json.destinations.length, 6);
    assert.equal(r.json.settings.password, undefined);

    r = await call('POST', '/api/destinations/S1/toggle'); assert.deepEqual(r.json.selection, ['S1']);
    r = await call('POST', '/api/destinations/s3/toggle'); assert.deepEqual(r.json.selection, ['S1', 'S3']);
    r = await call('POST', '/api/presets', { number: 2, name: 'Wide', memories: { S1: 5, S3: 6 } });
    assert.equal(r.status, 200); assert.deepEqual(r.json.destinations, ['S1', 'S3']);
    r = await call('POST', '/api/destinations/S3/toggle'); assert.deepEqual(r.json.selection, ['S1']);
    mock.loadMemory('S1', 44, 'preview');
    r = await call('POST', '/api/capture', { destinations: ['S1'] }); assert.deepEqual(r.json.memories, { S1: 44 });

    r = await call('POST', '/api/presets/2/recall'); assert.deepEqual(r.json.done, ['S1', 'S3']);
    r = await call('GET', '/api/state');
    assert.deepEqual(r.json.selection, ['S1', 'S3']);
    assert.deepEqual(r.json.lastRecalled, { number: 2, name: 'Wide' });
    assert.equal(r.json.presets[0].onPreview, true); assert.equal(r.json.tally.preview.S1, 2);

    r = await call('POST', '/api/take'); assert.deepEqual(r.json.done, ['S1', 'S3']);
    r = await call('GET', '/api/state'); assert.equal(r.json.presets[0].onProgram, true); assert.deepEqual(r.json.programPresets, [2]);
    r = await call('POST', '/api/cut'); assert.deepEqual(r.json.done, ['S1', 'S3']);
    r = await call('POST', '/api/autotake', {}); assert.equal(r.json.autoTake, true);
    r = await call('POST', '/api/autotake', { value: false }); assert.equal(r.json.autoTake, false);

    r = await call('PUT', '/api/presets/2', { name: 'Wide Shot' }); assert.equal(r.json.name, 'Wide Shot');
    r = await call('POST', '/api/presets/2/duplicate', {}); assert.equal(r.json.number, 3);
    r = await call('DELETE', '/api/presets/3'); assert.equal(r.json.ok, true);
    r = await call('POST', '/api/presets/99/recall'); assert.equal(r.status, 400); assert.match(r.json.error, /No preset 99/);
    r = await call('GET', '/api/nope'); assert.equal(r.status, 404);
    r = await call('POST', '/api/destinations/Z1/toggle'); assert.equal(r.status, 404);
  });
});

test('UI is served and SSE pushes state', async () => {
  await withApp(async (call, ctx, base) => {
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /CONTROL <span>CENTER/);
    assert.equal((await fetch(base + '/../package.json')).status, 404);
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/events', { signal: ctrl.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString(), /event: state/);
    ctrl.abort();
  });
});

test('settings update hides the password and reconnects', async () => {
  await withApp(async (call, { restPort }) => {
    const r = await call('POST', '/api/settings', { host: '127.0.0.1', restPort, password: 'x', maxScreens: 4 });
    assert.equal(r.json.settings.passwordSet, true); assert.equal(r.json.settings.password, undefined);
    assert.equal(r.json.connected, true); // mock has no password; extra cookie-less calls still succeed
    assert.equal(r.json.destinations.filter((d) => d.kind === 'screen').length, 4);
  });
});
