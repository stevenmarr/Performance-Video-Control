'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installJpegGuard, jpegTurboAllowed } = require('../lib/decks/jpeg-guard');
const { UsbWorker, usbDisabled } = require('../lib/decks/usb-host');
const { DeckService } = require('../lib/decks/service');
const { explainRs6ConnectError } = require('../lib/engine');

test('jpeg-turbo stays unloaded on Node 18 and when CC_JPEG_TURBO=0', () => {
  assert.equal(jpegTurboAllowed('v18.20.4', {}), false);
  assert.equal(jpegTurboAllowed('v22.23.4', {}), true);
  assert.equal(jpegTurboAllowed('v18.20.4', { CC_JPEG_TURBO: '1' }), true);
  assert.equal(jpegTurboAllowed('v22.23.4', { CC_JPEG_TURBO: '0' }), false);
  const prev = process.env.CC_JPEG_TURBO;
  process.env.CC_JPEG_TURBO = '0';
  installJpegGuard();
  let resolved = null;
  try { resolved = require.resolve('@julusian/jpeg-turbo'); } catch { resolved = null; }
  if (resolved) delete require.cache[resolved];
  assert.throws(() => require('@julusian/jpeg-turbo'), (err) => err && err.code === 'CC_SKIP_JPEG_TURBO');
  if (prev === undefined) delete process.env.CC_JPEG_TURBO;
  else process.env.CC_JPEG_TURBO = prev;
  if (resolved) delete require.cache[resolved];
});

test('CC_DECK_USB=0 does not open decks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deck-off-'));
  const logs = [];
  try {
    assert.equal(usbDisabled({ CC_DECK_USB: '0' }), true);
    const svc = new DeckService({
      dataDir: dir,
      usbEnv: { CC_DECK_USB: '0' },
      engine: { settings: {}, log: (level, msg) => logs.push(msg) },
    });
    assert.equal(svc.usb.disabled, true);
    svc.startUsb();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(logs.some((line) => /CC_DECK_USB=0/.test(line)));
    svc.stopUsb();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a SIGSEGV in the deck worker leaves this process running', async () => {
  const logs = [];
  const usb = new UsbWorker({ testCrash: true, log: (level, msg) => logs.push(String(msg)) });
  try {
    await usb.die().catch(() => {});
    const devices = await usb.scan();
    assert.ok(Array.isArray(devices));
    assert.ok(logs.some((line) => /USB deck worker died \(signal SIGSEGV\)/.test(line)), logs.join('\n'));
    assert.ok(logs.some((line) => /Control Center stays up/.test(line)));
  } finally {
    usb.stop();
  }
});

test('ECONNREFUSED to 127.0.0.1:3001 names the RS6 Engine', () => {
  const line = explainRs6ConnectError(
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3001'), { code: 'ECONNREFUSED' }),
    { host: '127.0.0.1', restPort: 3001 },
  );
  assert.match(line, /RS6 Engine refused 127\.0\.0\.1:3001/);
  assert.match(line, /Web RCS/);
  assert.match(line, /SYSTEMS → CONFIGURE/);
  assert.doesNotMatch(line, /^Connect failed/);
  const other = explainRs6ConnectError(new Error('HTTP 401'));
  assert.match(other, /^Connect failed: HTTP 401$/);
});
