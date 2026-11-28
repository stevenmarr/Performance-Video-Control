'use strict';
// v0.39.4: TourBox mapping UI plus ATEM Stream Deck + XL encoder bugs on a
// 2 M/E Constellation HD (transition type wrap/DVE, wipe encoder, rate on M/E 2).
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const map = require('../lib/decks/atem-map');
const models = require('../lib/drivers/atem-models');

const chd2me = models.profile('chd2me') || { key: 'chd2me', dve: 2, mes: 2 };

function atemView() {
  return {
    profile: chd2me,
    topology: { mixEffects: 2, DVEs: 2 },
    mes: [
      { style: 'MIX', nextStyle: 'MIX', mixRate: 30, wipe: 2, handle: 0 },
      { style: 'DIP', nextStyle: 'DIP', mixRate: 12, wipe: 5, handle: 0 },
    ],
  };
}

function rig({ me = 1, mes = [me], view = atemView() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-v0394-'));
  const svc = new DeckService({ dataDir: dir, systems: null, usbEnv: { CC_DECK_USB: '0' } });
  svc.desk = () => ({ armed: ['atem'], byKey: { atem: { view, connected: true, label: 'ATEM 2 M/E Constellation HD' } } });
  const sent = [];
  svc.runAction = async (a) => { sent.push(a); return { ok: true }; };
  const device = svc.companionDevice('plusxl');
  svc.remember(device, { system: 'atem', page: 0, atemUi: { me, mes, flexBank: 0, shift: 0 } });
  return { dir, svc, sent, device };
}

function cmd(sent, name) {
  return sent.filter((a) => a && a.path && String(a.path).endsWith(`/cmd/${name}`));
}

test('availableEffects keeps DVE and STING on a 2 M/E Constellation HD and skips only missing hardware', () => {
  assert.equal(map.normalizeStyle('STINGER'), 'STING');
  assert.equal(map.normalizeStyle('dve'), 'DVE');
  assert.deepEqual(map.availableEffects({ profile: chd2me }), ['MIX', 'DIP', 'WIPE', 'DVE', 'STING']);
  assert.deepEqual(map.availableEffects({ profile: { dve: 2 }, topology: { stingers: 0 } }), ['MIX', 'DIP', 'WIPE', 'DVE']);
  assert.deepEqual(map.availableEffects({ profile: { dve: 0 }, topology: { DVEs: 0, stingers: 0 } }), ['MIX', 'DIP', 'WIPE']);
  assert.deepEqual(map.availableEffects({}), ['MIX', 'DIP', 'WIPE', 'DVE', 'STING']);
});

test('ATEM + XL encoder 1 cycles mix→dip→wipe→DVE→sting→mix both ways, including when a DVE key is busy', async () => {
  const view = atemView();
  view.mes[0].style = 'WIPE';
  view.mes[0].nextStyle = 'WIPE';
  const { dir, svc, sent, device } = rig({ view });
  try {
    const face = svc.faceFor(device);
    assert.equal(face.dials[1].atem, 'effect', 'compact encoder 1 is transition type');
    assert.equal(face.dials[2].atem, 'wipe', 'compact encoder 2 is wipe pattern');
    assert.equal(face.dials[3].atem, 'time', 'compact encoder 3 is transition rate');

    sent.length = 0;
    await svc._turn(device.id, 1, 1, 'rotate');
    assert.deepEqual(cmd(sent, 'style').map((a) => a.body), [{ style: 'DVE', me: 1 }]);

    view.mes[0].nextStyle = 'DVE';
    view.mes[0].style = 'WIPE'; // nextStyle wins, so a stale style must not trap the wheel
    sent.length = 0;
    await svc._turn(device.id, 1, 1, 'rotate');
    assert.deepEqual(cmd(sent, 'style').map((a) => a.body), [{ style: 'STING', me: 1 }]);

    view.mes[0].nextStyle = 'STING';
    sent.length = 0;
    await svc._turn(device.id, 1, 1, 'rotate');
    assert.deepEqual(cmd(sent, 'style').map((a) => a.body), [{ style: 'MIX', me: 1 }]);

    view.mes[0].nextStyle = 'MIX';
    sent.length = 0;
    await svc._turn(device.id, 1, -1, 'rotate');
    assert.deepEqual(cmd(sent, 'style').map((a) => a.body), [{ style: 'STING', me: 1 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ATEM + XL encoder 2 selects the next wipe pattern on the followed M/E', async () => {
  const { dir, svc, sent, device } = rig({ me: 1, mes: [1] });
  try {
    await svc._turn(device.id, 2, 1, 'rotate');
    const hits = cmd(sent, 'wipePattern');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].body.pattern, 3, 'wipe 2 + 1 tick lands on pattern 3');
    assert.equal(hits[0].body.me, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ATEM + XL rate encoder targets the M/E the page is following, including M/E 2', async () => {
  const { dir, svc, sent, device } = rig({ me: 2, mes: [2] });
  try {
    const face = svc.faceFor(device);
    assert.match(face.dials[3].readout, /12f/);
    await svc._turn(device.id, 3, 1, 'rotate');
    const hits = cmd(sent, 'mixRate');
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].body, { rate: 13, me: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ATEM + XL effect and wipe encoders on a page following M/E 2 address M/E 2', async () => {
  const { dir, svc, sent, device } = rig({ me: 2, mes: [2] });
  try {
    await svc._turn(device.id, 1, 1, 'rotate');
    assert.deepEqual(cmd(sent, 'style').map((a) => a.body), [{ style: 'WIPE', me: 2 }]);
    sent.length = 0;
    await svc._turn(device.id, 2, 1, 'rotate');
    assert.deepEqual(cmd(sent, 'wipePattern').map((a) => a.body), [{ pattern: 6, me: 2 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
