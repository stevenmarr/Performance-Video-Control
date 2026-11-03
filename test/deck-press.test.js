'use strict';
// A key press has to start the device command before any Stream Deck repaint.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DeckService } = require('../lib/decks/service');
const { UsbDecks } = require('../lib/decks/usb');
const { LONG_PRESS_MS } = require('../lib/deck');

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-press-'));
  const svc = new DeckService({ dataDir: dir, systems: null, usbEnv: { CC_DECK_USB: '0' } });
  svc.usbDevices = [{ id: 'deck', surfaceId: 'xl', columns: 8, rows: 4, transport: 'usb' }];
  return { dir, svc };
}

test('a press starts the command before any deck repaint', async () => {
  const { dir, svc } = service();
  const order = [];
  let releasePaint;
  const paintGate = new Promise((resolve) => { releasePaint = resolve; });
  svc.usb.paint = () => {
    order.push('paint');
    return paintGate;
  };
  svc.bareFace = () => ({
    id: 'ptz',
    system: 'ptz',
    keys: [{
      col: 1, row: 1, label: 'ND', caption: 'CLEAR', tone: 'func',
      action: { method: 'POST', path: '/api/sys/ptz/cmd/step', body: { op: 'ndFilter', steps: 1 } },
    }],
    dials: [],
  });
  svc.runAction = async () => { order.push('action'); };
  const pending = svc.press('deck', 1, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['action']);
  releasePaint();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(order[0], 'action');
  assert.ok(order.includes('paint'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a short press steps forward and a long press steps back around the list', async () => {
  const { dir, svc } = service();
  const steps = [];
  svc.bareFace = () => ({
    id: 'ptz',
    system: 'ptz',
    keys: [{
      col: 2, row: 1, label: 'ND', caption: '1/64', tone: 'func',
      action: { method: 'POST', path: '/api/sys/ptz/cmd/step', body: { op: 'ndFilter', steps: 1 } },
    }],
    dials: [],
  });
  svc.runAction = async (action) => { steps.push(action.body.steps); };
  await svc.press('deck', 2, 1);
  await svc.release('deck', 2, 1);
  await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 40));
  assert.deepEqual(steps, [1]);

  steps.length = 0;
  await svc.press('deck', 2, 1);
  await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 40));
  assert.deepEqual(steps, [1, -2]);
  await svc.release('deck', 2, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a held move starts at a fine speed and the release stops it', async () => {
  const { dir, svc } = service();
  const bodies = [];
  svc.ptzSnap = () => ({ speeds: { pt: 25, zoom: 25, focus: 15 } });
  svc.bareFace = () => ({
    id: 'ptz',
    system: 'ptz',
    keys: [{
      col: 1, row: 1, label: 'UP', caption: 'MOVE', tone: 'go', hold: 'pt',
      action: { method: 'POST', path: '/api/sys/ptz/cmd/move', body: { pan: 0, tilt: 1 } },
    }],
    dials: [],
  });
  svc.runAction = async (action) => { bodies.push(action.body); };
  await svc.press('deck', 1, 1);
  assert.equal(bodies[0].speed, true);
  assert.ok(bodies[0].tilt >= 1 && bodies[0].tilt < 8);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(bodies[bodies.length - 1].tilt >= bodies[0].tilt);
  await svc.release('deck', 1, 1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(bodies[bodies.length - 1].axes, ['pt']);
  const after = bodies.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(bodies.length, after, 'release stops the speed ramp');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a repaint draws only the keys that changed', async () => {
  const usb = new UsbDecks();
  const fills = [];
  const deck = {
    modelInfo: { controls: [{ type: 'button', pixelSize: { width: 72, height: 72 } }] },
    fillKeyBuffer: async (index) => { fills.push(index); },
    calculateFillPanelDimensions: () => null,
  };
  usb.open.set('d', { deck, info: { id: 'd', columns: 2, rows: 1 }, painted: new Map() });
  const keys = [
    { row: 0, col: 0, label: 'A', caption: '', tone: 'func' },
    { row: 0, col: 1, label: 'B', caption: '', tone: 'func' },
  ];
  await usb.paint('d', keys, { dials: [] });
  assert.deepEqual(fills, [0, 1]);
  fills.length = 0;
  const next = [keys[0], { ...keys[1], caption: 'ON' }];
  await usb.paint('d', next, { dials: [] });
  assert.deepEqual(fills, [1]);
});
