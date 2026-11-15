'use strict';
// Scopes left Control Center. The tab, the routes, and the in-process module are gone. TSL stays on ATEM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');
const { systems } = require('../lib/modules/catalog');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Control Center has no Scopes tab, routes, feature flags, or catalog entry', async () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /data-tab="scopes"/);
  assert.doesNotMatch(html, /id="pane-scopes"/);
  assert.doesNotMatch(html, /id="scopesFrame"/);
  assert.doesNotMatch(html, /scopes-tab\.js/);
  assert.doesNotMatch(html, /id="tabsScopesNote"/);
  const atem = html.slice(html.indexOf('id="pane-atem"'), html.indexOf('id="pane-arouter"'));
  const system = html.slice(html.indexOf('id="pane-system"'), html.indexOf('id="pane-xpresets"'));
  assert.match(atem, /id="tslPanel"/);
  assert.doesNotMatch(system, /id="tslPanel"/);
  assert.match(read('public/tsl.js'), /ev\.detail === 'atem'/);
  assert.doesNotMatch(read('public/app.js'), /'scopes'/);
  assert.doesNotMatch(read('public/sys.js'), /scopes: \['scopes'\]/);
  assert.doesNotMatch(read('public/sys.js'), /h === 'lightning'/);
  assert.equal(fs.existsSync(path.join(root, 'lib/scopes')), false);
  assert.equal(fs.existsSync(path.join(root, 'public/scopes-tab.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'public/scopes.html')), false);
  assert.throws(() => require(path.join(root, 'lib/scopes/service')));
  assert.equal(systems().some((s) => s.id === 'scopes'), false);
  const features = read('lib/engine.js');
  assert.doesNotMatch(features, /'scopes'/);
  assert.doesNotMatch(features, /'lightning'/);
  assert.doesNotMatch(features, /'ndiIngest'/);
  assert.match(features, /'tslTally'/);

  const ctx = await setup();
  const server = createServer(ctx.engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/api/scopes/sources', '/api/scopes/status', '/scopes.html', '/lightning.html', '/lightning']) {
      const r = await fetch(B + p);
      assert.equal(r.status, 404, p);
      const body = await r.text();
      assert.doesNotMatch(body, /data-show="ltng"/, p);
    }
    const ver = await (await fetch(B + '/api/version')).json();
    assert.equal(ver.apiVersion, 9);
    assert.equal(ver.features.includes('scopes'), false);
    assert.equal(ver.features.includes('lightning'), false);
    assert.equal(ver.features.includes('ndiIngest'), false);
    assert.equal(ver.features.includes('tslTally'), true);
  } finally {
    server.closeClients();
    await new Promise((r) => server.close(r));
    await ctx.teardown();
  }
});
