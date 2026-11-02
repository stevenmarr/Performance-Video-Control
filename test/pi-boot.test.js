'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { listen } = require('../lib/listen');
const { sdNotify } = require('../lib/core/notify');
const { deckOpenMessage } = require('../lib/decks/usb');

test('a taken port logs one line and exits non-zero, with no stack trace', async () => {
  const held = http.createServer();
  await new Promise((r) => held.listen(0, '127.0.0.1', r));
  const port = held.address().port;
  const lines = [];
  let code = 0;
  const server = http.createServer();
  await new Promise((resolve) => {
    listen(server, port, '127.0.0.1', () => { throw new Error('listen should not succeed'); }, {
      write: (line) => lines.push(String(line)),
      exit: (c) => { code = c; resolve(); },
    });
  });
  held.close();
  server.close();
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`Port ${port} is already in use`));
  assert.match(lines[0], new RegExp(`sudo ss -ltnp \\| grep ${port}`));
  assert.doesNotMatch(lines[0], /EADDRINUSE/);
});

test('sdNotify does nothing without NOTIFY_SOCKET and does not throw when systemd-notify is missing', () => {
  const prev = process.env.NOTIFY_SOCKET;
  delete process.env.NOTIFY_SOCKET;
  assert.equal(sdNotify('READY=1', { sync: true }), false);
  process.env.NOTIFY_SOCKET = '/tmp/control-center-no-notify.sock';
  const logs = [];
  const orig = console.error;
  console.error = (line) => logs.push(String(line));
  let result = false;
  try { result = sdNotify('READY=1', { sync: true }); }
  finally { console.error = orig; if (prev === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = prev; }
  assert.equal(result, false);
  assert.ok(logs.length >= 1);
  assert.match(logs[0], /systemd notify did not go out/);
});

test('a deck held by another program names the Companion setting', () => {
  const line = deckOpenMessage('/dev/hidraw0', new Error('cannot open device: LIBUSB_ERROR_BUSY'));
  assert.match(line, /held by another program/);
  assert.match(line, /Enable direct connection to Stream Decks/);
  const other = deckOpenMessage('serial', new Error('short read'));
  assert.match(other, /did not open/);
  assert.doesNotMatch(other, /Enable direct connection/);
});

test('the shipped unit is Type=simple on port 8088 and does not arm the watchdog', () => {
  const unit = fs.readFileSync(path.join(__dirname, '../tools/systemd/control-center.service'), 'utf8');
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /--port 8088/);
  assert.match(unit, /Environment=PORT=8088/);
  assert.doesNotMatch(unit, /^Type=notify$/m);
  assert.doesNotMatch(unit, /^WatchdogSec=/m);
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  assert.match(readme, /Enable direct connection to Stream Decks/);
  assert.match(readme, /systemctl edit control-center/);
  assert.match(readme, /CC_HOST_POWER=1/);
  assert.match(readme, /CC_SERVICE_CONTROL=1/);
  assert.match(readme, /git pull && sudo cp/);
});
