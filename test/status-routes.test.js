'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');

async function withApp(fn) {
  const ctx = await setup({ liveEnabled: false });
  const server = createServer(ctx.engine);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text };
  };
  try { await fn(call); }
  finally {
    server.closeClients();
    await new Promise((resolve) => server.close(resolve));
    await ctx.teardown();
  }
}

test('the status wall is read-only and layouts round-trip', async () => {
  await withApp(async (call) => {
    const page = await call('GET', '/status');
    assert.equal(page.status, 200);
    assert.match(page.text, /STATUS/);
    assert.doesNotMatch(page.text, /<button/i);
    const config = await call('GET', '/status/config');
    assert.equal(config.status, 200);
    assert.match(config.text, /ADD A TILE/);
    const list = await call('GET', '/api/status/layouts');
    assert.equal(list.status, 200);
    assert.ok(list.json.layouts.some((layout) => layout.name === 'FOH'));
    const wall = await call('GET', '/api/status?layout=Green%20room');
    assert.equal(wall.status, 200);
    assert.equal(wall.json.layout.name, 'Green room');
    assert.ok(wall.json.tiles.length >= 3);
    const missing = await call('GET', '/api/status?layout=Nope');
    assert.equal(missing.json.missing, true);
    const made = await call('POST', '/api/status/layouts', { name: 'Booth' });
    assert.equal(made.status, 200);
    assert.equal(made.json.name, 'Booth');
    const saved = await call('PUT', `/api/status/layouts/${made.json.id}`, {
      name: 'Booth', timeZone: 'America/Chicago', hour12: false,
      tiles: [{ id: 'c', type: 'clock', label: 'Clock', col: 0, row: 0, w: 12, h: 2, fontSize: 80, source: { kind: 'clock' }, warn: { amberSec: 30, redSec: 10 } }],
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.hour12, false);
    const shown = await call('GET', '/api/status?layout=Booth');
    assert.equal(shown.json.layout.hour12, false);
    assert.match(shown.json.tiles[0].primary, /\d/);
    const preview = await call('POST', '/api/status/preview', { name: 'Scratch', tiles: [{ id: 't', type: 'text', label: 'Temp', source: { kind: 'companion', variable: 'show_name' } }] });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.tiles[0].primary, 'Not set');
    const still = await call('GET', '/api/status/layouts');
    assert.equal(still.json.layouts.some((layout) => layout.name === 'Scratch'), false);
    const exported = await call('GET', `/api/status/layouts/${made.json.id}/export`);
    assert.equal(exported.json.format, 'cc-status-layout');
    const imported = await call('POST', '/api/status/import', { format: 'cc-status-layout', layout: { ...exported.json.layout, name: 'Lobby' } });
    assert.equal(imported.status, 200);
    assert.ok(imported.json.layouts.some((layout) => layout.name === 'Lobby'));
    const bad = await call('POST', '/api/status/import', { layout: { name: 'Bad', tiles: [{ type: 'launch', label: 'Go' }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /does not know/);
  });
});

test('the viewing page never posts', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'status.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'status.html'), 'utf8');
  assert.doesNotMatch(js, /POST/);
  assert.doesNotMatch(html, /<button/i);
  assert.match(html, /status-view\.js/);
});
