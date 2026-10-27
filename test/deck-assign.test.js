'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');

test('a Plus can stay on RS6 while a + XL stays on PTZ', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-assign-'));
  const systems = { getState() { return { armed: ['rs6', 'ptz'], systems: { rs6: { short: 'RS6' }, ptz: { short: 'PTZ' } } }; } };
  const decks = new DeckService({ dataDir: dir, systems, engine: { settings: {} } });
  decks.usb.paint = async () => {};
  decks.usbDevices = [
    { id: 'plus-path', serial: 'PLUS1', name: 'Stream Deck +', model: 'Stream Deck +', surfaceId: 'plus', columns: 4, rows: 2, transport: 'usb' },
    { id: 'xl-path', serial: 'XL1', name: 'Stream Deck + XL', model: 'Stream Deck + XL', surfaceId: 'plusxl', columns: 9, rows: 4, transport: 'usb' },
  ];
  await decks.assign('plus-path', 'rs6');
  await decks.assign('xl-path', 'ptz');
  assert.equal(decks.faceFor(decks.usbDevices[0]).system, 'rs6');
  assert.equal(decks.faceFor(decks.usbDevices[1]).system, 'ptz');
  decks.usbDevices[0] = { ...decks.usbDevices[0], id: 'plus-path-after-replug' };
  assert.equal(decks.faceFor(decks.usbDevices[0]).system, 'rs6', 'the Plus keeps RS6 when the USB path changes');
  assert.equal(decks.faceFor(decks.usbDevices[1]).system, 'ptz');
  fs.rmSync(dir, { recursive: true, force: true });
});
