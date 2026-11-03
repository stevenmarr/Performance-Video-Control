'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const { diagnose } = require('../lib/decks/diag');
const { createServer } = require('../lib/server');
const { Engine } = require('../lib/engine');
const { SystemManager } = require('../lib/systems');

test('USB scan logs found N decks, opened serial, and a missing library once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usb-'));
  const logs = [];
  const svc = new DeckService({ dataDir: dir, engine: { settings: {}, log: (level, msg) => logs.push(`${level} ${msg}`) } });
  try {
    await svc.pollUsb();
    if (svc.usb.status().installed) assert.ok(logs.some((l) => /^info found \d+ decks$/.test(l)), logs.join('\n'));
    const alreadyMissing = logs.filter((l) => /library is missing/.test(l)).length;
    svc._usbLoggedMissing = false;
    svc._logScan({ installed: false, error: 'need the package', found: 0, opened: [], failed: [] });
    svc._logScan({ installed: false, error: 'need the package', found: 0, opened: [], failed: [] });
    const missing = logs.filter((l) => /library is missing/.test(l));
    assert.equal(missing.length, alreadyMissing + 1);
    assert.match(missing[missing.length - 1], /npm ci --omit=dev/);
    const before = logs.length;
    svc._logScan({
      installed: true,
      found: 1,
      opened: [{ serial: 'CL123', path: '/dev/hidraw2' }],
      failed: [{ message: 'cannot open /dev/hidraw3: EACCES (Permission denied). fix hint' }],
      skipped: [],
    });
    const fresh = logs.slice(before);
    assert.ok(fresh.some((l) => l.includes('opened serial CL123')));
    assert.ok(fresh.some((l) => l.includes('cannot open /dev/hidraw3: EACCES')));
    svc._logScan({
      installed: true,
      found: 1,
      opened: [],
      failed: [{ message: 'cannot open /dev/hidraw3: EACCES (Permission denied). fix hint' }],
      skipped: [],
    });
    assert.equal(logs.filter((l) => l.includes('cannot open /dev/hidraw3: EACCES')).length, 1);
  } finally {
    svc.stopUsb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diag names the HID library and GET /api/surfaces/diag returns it', async () => {
  const report = await diagnose();
  assert.equal(report.library.name, '@elgato-stream-deck/node');
  assert.equal(typeof report.library.installed, 'boolean');
  assert.ok(Array.isArray(report.hidraw));
  assert.ok(Array.isArray(report.streamDecks));
  assert.match(report.text, /HID library/);
  assert.match(report.text, /found \d+ stream decks/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diag-'));
  const engine = new Engine({ dataDir: dir, settingsOverride: { mock: true } });
  const sm = new SystemManager({ dataDir: dir, engine, autoStart: false });
  const server = createServer(engine, sm);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/surfaces/diag`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.library.name, '@elgato-stream-deck/node');
    assert.match(body.text, /Stream Deck diagnostic/);
    assert.ok(Array.isArray(body.hidraw));
  } finally {
    if (server.closeClients) server.closeClients();
    await new Promise((resolve) => server.close(resolve));
    await sm.close();
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
