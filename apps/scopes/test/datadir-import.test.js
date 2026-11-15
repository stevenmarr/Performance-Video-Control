'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultDataDir, resolveDataDir, importLegacy } = require('../lib/datadir');

test('data dir paths and overrides', () => {
  const home = '/Users/op';
  assert.equal(defaultDataDir({ platform: 'darwin', home }), path.join(home, 'Library', 'Application Support', 'PVLLC Scopes'));
  assert.equal(defaultDataDir({ platform: 'win32', home, env: { APPDATA: 'C:\\Users\\op\\AppData\\Roaming' } }), path.join('C:\\Users\\op\\AppData\\Roaming', 'PVLLC Scopes'));
  assert.equal(defaultDataDir({ platform: 'linux', home, env: {} }), path.join(home, '.config', 'pvllc-scopes'));
  assert.equal(resolveDataDir({ argData: '/tmp/x', appDir: '/app' }).source, '--data');
  assert.equal(resolveDataDir({ env: { SCOPES_DATA_DIR: '/tmp/s' }, appDir: '/app' }).source, 'SCOPES_DATA_DIR');
  assert.equal(resolveDataDir({ env: { RS6_DATA_DIR: '/tmp/r' }, appDir: '/app' }).source, 'RS6_DATA_DIR');
  assert.equal(resolveDataDir({ mock: true, appDir: '/app', env: {} }).dir, path.join('/app', 'mock-data'));
});

test('one-time import copies scopes.json, fills host from systems.json, and does not run again', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scopes-legacy-'));
  const legacy = path.join(root, 'RS6 Presets');
  const dest = path.join(root, 'PVLLC Scopes');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'scopes.json'), JSON.stringify({ cameras: { cam1: { stream: 2 } }, custom: '' }));
  fs.writeFileSync(path.join(legacy, 'systems.json'), JSON.stringify({
    connections: { ptz: { cameras: [{ id: 'cam1', name: 'Wide', host: '192.0.2.30', port: 81, model: 'AW-UE150' }] } },
  }));
  const first = importLegacy({ destDir: dest, sourceDir: legacy });
  assert.equal(first.imported, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(dest, 'scopes.json'), 'utf8'));
  assert.equal(cfg.cameras.cam1.host, '192.0.2.30');
  assert.equal(cfg.cameras.cam1.name, 'Wide');
  assert.equal(cfg.cameras.cam1.stream, 2);
  assert.ok(fs.existsSync(path.join(legacy, 'scopes.json')), 'the old file stays');
  const marker = JSON.parse(fs.readFileSync(path.join(dest, 'migrated-from.json'), 'utf8'));
  assert.match(marker.from, /scopes\.json$/);
  fs.writeFileSync(path.join(legacy, 'scopes.json'), JSON.stringify({ cameras: { cam9: { host: '192.0.2.99', name: 'Other' } } }));
  const second = importLegacy({ destDir: dest, sourceDir: legacy });
  assert.equal(second.imported, false);
  const again = JSON.parse(fs.readFileSync(path.join(dest, 'scopes.json'), 'utf8'));
  assert.equal(again.cameras.cam1.host, '192.0.2.30');
  assert.equal(again.cameras.cam9, undefined);

  const populated = path.join(root, 'already');
  fs.mkdirSync(populated);
  fs.writeFileSync(path.join(populated, 'scopes.json'), JSON.stringify({ cameras: { keep: { host: '192.0.2.1', name: 'Keep' } } }));
  const skipped = importLegacy({ destDir: populated, sourceDir: legacy });
  assert.equal(skipped.imported, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(populated, 'scopes.json'), 'utf8')).cameras.keep.name, 'Keep');
});
