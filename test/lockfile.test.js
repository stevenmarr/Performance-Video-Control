'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const { formatDiag } = require('../lib/decks/diag');

test('package-lock.json matches package.json and installs the Stream Deck library', () => {
  const root = lock.packages[''];
  assert.equal(lock.version, pkg.version);
  assert.equal(root.version, pkg.version);
  for (const [name, range] of Object.entries(pkg.dependencies)) {
    assert.equal(root.dependencies[name], range, `${name} range differs`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `lockfile has no node_modules/${name}`);
    assert.notEqual(entry.optional, true, `${name} is optional, so npm ci can skip it`);
    assert.ok(entry.resolved, `${name} has no resolved tarball`);
    assert.ok(entry.integrity, `${name} has no integrity`);
  }
  for (const [name, range] of Object.entries(pkg.optionalDependencies || {})) {
    assert.equal(root.optionalDependencies[name], range, name);
    assert.equal(root.dependencies[name], undefined, `${name} must not also be a required dependency`);
  }
  const hid = lock.packages['node_modules/node-hid'];
  assert.equal(hid.version, '3.4.0');
  assert.notEqual(hid.optional, true);
  const deck = lock.packages['node_modules/@elgato-stream-deck/node'];
  assert.equal(deck.version, '7.8.0');
  assert.equal(deck.engines.node, '>=18.18');
  assert.notEqual(deck.optional, true);
});

test('npm ci --omit=dev dry-run names @elgato-stream-deck/node and node-hid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lock-'));
  const root = path.join(__dirname, '..');
  fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(dir, 'package-lock.json'));
  const out = spawnSync('npm', ['ci', '--omit=dev', '--dry-run', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const text = `${out.stdout || ''}\n${out.stderr || ''}`;
  assert.equal(out.status, 0, text);
  assert.match(text, /@elgato-stream-deck\/node/);
  assert.match(text, /node-hid/);
});

test('deck diag prints the require() error when the HID library did not load', () => {
  const text = formatDiag({
    node: 'v18.20.4',
    platform: 'linux',
    pid: 1,
    uid: 1000,
    user: 'pi',
    gid: 1000,
    group: 'pi',
    groups: [],
    library: {
      name: '@elgato-stream-deck/node',
      installed: false,
      code: 'MODULE_NOT_FOUND',
      error: "MODULE_NOT_FOUND: Cannot find module '@elgato-stream-deck/node'",
    },
    streamDecks: [],
    elgatoHid: [],
    hidraw: [],
    proc: true,
  });
  assert.match(text, /HID library: MISSING/);
  assert.match(text, /require\('@elgato-stream-deck\/node'\) failed: MODULE_NOT_FOUND: Cannot find module '@elgato-stream-deck\/node'/);
});
