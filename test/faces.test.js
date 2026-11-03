'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SURFACES } = require('../lib/decks/surfaces');
const { show, applyReadouts } = require('../lib/decks/faces');
const { keySvg } = require('../lib/deck-image');
const { keyModel, keyImage, stripImage, dialSignature } = require('../lib/decks/look');

test('deck keys use the Control Dark SVG, not a bitmap font', () => {
  const model = keyModel({ label: 'TAKE', caption: 'PGM', tone: 'stop' });
  const svg = keySvg(model);
  assert.match(svg, /TAKE/);
  assert.match(svg, /Arial/);
  assert.match(svg, /#3A0D10/);
  assert.match(svg, /#C42020/);
  const guard = keySvg(keyModel({ label: 'ALL STOP', caption: 'HOLD', tone: 'guard' }));
  assert.match(guard, /stroke-dasharray/);
  assert.match(guard, /#E0B030/);
  assert.doesNotMatch(guard, /#3A0D10/);
  const image = keyImage({ label: 'HOME', caption: 'BACK', nav: 'system', tone: 'home' }, 112, 112);
  assert.equal(image.data.length, 112 * 112 * 4);
  const strip = stripImage(1200, 100, [
    { widget: 'iris' }, { widget: 'masterPed' }, { widget: 'gainRb' },
    { widget: 'pedRb' }, { widget: 'zoom' }, { widget: 'focus' },
  ], {});
  assert.equal(strip.data.length, 1200 * 100 * 4);
});

const desk = { armed: ['rs6', 'ptz', 'e2'] };

test('home is the first face and every system page can return there', () => {
  const home = show(SURFACES.plusxl, desk, {});
  assert.equal(home.id, 'home');
  assert.deepEqual(home.keys.filter((k) => k.nav === 'system').map((k) => k.system), ['rs6', 'ptz', 'e2']);
  const ptz = show(SURFACES.plusxl, desk, { system: 'ptz', page: 0 });
  assert.equal(ptz.keys.find((k) => k.col === 0 && k.row === 0).nav, 'home');
  assert.equal(ptz.system, 'ptz');
  assert.ok(!ptz.keys.some((k) => k.action && String(k.action.path).includes('/api/take')));
});

test('a + XL PTZ deck opens on the RCP paint pages', () => {
  const big = show(SURFACES.plusxl, desk, { system: 'ptz', page: 0 });
  const small = show(SURFACES.plus, desk, { system: 'ptz', page: 0 });
  assert.ok(small.pages > big.pages, `${small.pages} pages on + should be more than ${big.pages} on + XL`);
  assert.equal(big.designId, 'ptz-msu');
  assert.equal(big.dials.length, 6);
  assert.equal(show(SURFACES.xl, desk, { system: 'ptz', page: 0 }).dials.length, 0);
  assert.equal(big.keys.find((k) => k.col === 0 && k.row === 0).label, 'HOME');
  const exp = show(SURFACES.plusxl, desk, { system: 'ptz', page: 1 });
  assert.equal(exp.designId, 'ptz-rcp-exp');
  assert.ok(exp.keys.some((k) => k.label === 'EXP'));
  assert.ok(exp.keys.some((k) => k.label === 'ND'));
  assert.ok(exp.keys.some((k) => k.label === 'WB'));
  const allStop = big.keys.find((k) => k.label === 'ALL STOP');
  assert.ok(allStop, 'wide PTZ page keeps ALL STOP');
  assert.equal(allStop.col, 8);
  assert.equal(allStop.row, 3);
  const rs6 = show(SURFACES.xl, desk, { system: 'rs6', page: 0 });
  const os = show(SURFACES.xl, desk, { system: 'console', page: 0 });
  const go = os.keys.find((k) => k.label === 'GO');
  assert.ok(go, 'console page keeps GO');
  assert.equal(go.col, 7);
  assert.equal(go.row, 3);
  assert.equal(go.action.path, '/api/cues/go');
  assert.equal(rs6.keys.find((k) => k.col === 1 && k.row === 0).label, 'TAKE');
  assert.equal(rs6.keys.find((k) => k.col === 2 && k.row === 0).label, 'CUT');
  assert.equal(rs6.keys.find((k) => k.absolute && k.label === '1').col, 3, 'memory 1 sits in the pad, not under Home');
});

test('one system at a time, and switcher memories are absolute recalls', () => {
  const rs6 = show(SURFACES.xl, desk, { system: 'rs6', page: 0 });
  assert.ok(rs6.keys.every((k) => !k.action || !String(k.action.path).includes('/ptz/')));
  const memories = rs6.keys.filter((k) => k.absolute);
  assert.ok(memories.length >= 8);
  assert.ok(memories.every((k) => /\/recall$/.test(k.action.path)));
  const e2 = show(SURFACES.xl, desk, { system: 'e2', page: 0 });
  const mem = e2.keys.find((k) => k.absolute);
  assert.equal(mem.action.body.target, 'preview');
});

test('PTZ camera keys are the cameras on the desk, and the selected one is marked', () => {
  const ptzDesk = {
    armed: ['ptz'],
    byKey: {
      ptz: {
        cameras: [
          { id: 'cam1', name: 'Wide' },
          { id: 'cam2', name: 'Tight' },
          { id: 'cam3', name: 'End' },
        ],
        selected: 'cam2',
      },
    },
  };
  const face = show(SURFACES.plusxl, ptzDesk, { system: 'ptz', page: 0 });
  const cams = face.keys.filter((k) => k.cam);
  assert.deepEqual(cams.map((k) => k.cam), ['cam1', 'cam2', 'cam3']);
  assert.equal(cams.find((k) => k.cam === 'cam2').on, true);
  assert.equal(cams.find((k) => k.cam === 'cam2').action.body.cam, 'cam2');
  assert.equal(cams.find((k) => k.cam === 'cam1').action.body.slot, undefined);
  const bars = applyReadouts([{ label: 'BARS', op: 'colorBars', caption: 'FUNC' }], { readouts: { colorBars: { on: true, text: 'ON' } } });
  assert.equal(bars[0].caption, 'ON');
  assert.equal(bars[0].on, true);
  const func = show(SURFACES.plusxl, ptzDesk, { system: 'ptz', page: 1 });
  assert.deepEqual(func.keys.filter((k) => k.cam).map((k) => k.label), ['Wide', 'Tight', 'End']);
});

test('ATEM is one page per M/E plus routing, with long names and program / preview feedback', () => {
  const view = {
    mes: [
      { index: 0, program: 2, preview: 1, bus: [
        { id: 1, long: 'Camera Left', short: 'CamL', pgm: false, pvw: true },
        { id: 2, long: 'Camera Right', short: 'CamR', pgm: true, pvw: false },
        { id: 6000, long: 'Super Source', short: 'SSrc', pgm: false, pvw: false },
      ] },
      { index: 1, program: 1, preview: 6000, bus: [
        { id: 1, long: 'Camera Left', short: 'CamL', pgm: true, pvw: false },
        { id: 2, long: 'Camera Right', short: 'CamR', pgm: false, pvw: false },
        { id: 6000, long: 'Super Source', short: 'SSrc', pgm: false, pvw: true },
      ] },
    ],
    outputs: [
      { key: 'aux:0', label: 'Aux 1', source: 1, sourceName: 'Camera Left', accepts: 'aux' },
      { key: 'aux:1', label: 'Aux 2', source: 6000, sourceName: 'Super Source', accepts: 'aux' },
    ],
    auxSources: [
      { id: 1, long: 'Camera Left', short: 'CamL' },
      { id: 2, long: 'Camera Right', short: 'CamR' },
      { id: 6000, long: 'Super Source', short: 'SSrc' },
    ],
  };
  const atemDesk = { armed: ['atem'], byKey: { atem: { view } } };
  const cols = SURFACES.xl.cols;
  let face = null;
  for (let p = 0; p < 12; p++) {
    const candidate = show(SURFACES.xl, atemDesk, { system: 'atem', page: p });
    if (candidate.keys.some((k) => k.label === 'ME1')) { face = candidate; break; }
  }
  assert.ok(face, 'the live M/E page is still reachable');
  assert.equal(face.keys.find((k) => k.col === cols - 1 && k.row === 0).label, 'AUTO');
  assert.equal(face.keys.find((k) => k.col === cols - 2 && k.row === 0).label, 'CUT');
  const top = face.keys.filter((k) => k.row === 0);
  assert.equal(top.find((k) => k.label === 'ME1').tone, 'nav');
  assert.equal(top.find((k) => k.label === 'ME1').on, true);
  assert.equal(top.find((k) => k.label === 'ME2').tone, 'nav');
  assert.equal(top.find((k) => k.label === 'ROUTE').tone, 'nav');
  assert.ok(top.find((k) => k.label === 'ME1').col < cols - 2);
  const pvw = face.keys.find((k) => k.label === 'Camera Left');
  const pgm = face.keys.find((k) => k.label === 'Camera Right');
  assert.equal(pvw.tone, 'pvw');
  assert.equal(pvw.caption, 'PVW');
  assert.equal(pvw.action.body.me, 1);
  assert.equal(pgm.tone, 'stop');
  assert.equal(pgm.caption, 'PGM');
  assert.ok(face.keys.some((k) => k.label === 'Super Source'));
  const routePage = top.find((k) => k.label === 'ROUTE').page;
  const route = show(SURFACES.xl, atemDesk, { system: 'atem', page: routePage });
  assert.equal(route.keys.find((k) => k.caption === 'Aux 1').label, 'Camera Left');
  assert.equal(route.keys.find((k) => k.caption === 'Aux 2').label, 'Super Source');
  const pick = route.keys.find((k) => k.caption === 'Aux 2');
  const assigning = show(SURFACES.xl, atemDesk, { system: 'atem', page: pick.page, out: pick.pick });
  const ss = assigning.keys.find((k) => k.label === 'Super Source');
  assert.equal(ss.tone, 'pvw');
  assert.equal(ss.action.body.output, 'aux:1');
  assert.equal(ss.action.body.source, 6000);
  const me2 = show(SURFACES.xl, atemDesk, { system: 'atem', page: top.find((k) => k.label === 'ME2').page });
  assert.equal(me2.keys.find((k) => k.label === 'Super Source').tone, 'pvw');
  assert.equal(me2.keys.find((k) => k.label === 'Camera Left').caption, 'PGM');
});

test('the home page is labeled HOME and Control Center keys are not device keys', () => {
  const home = show(SURFACES.xl, desk, {});
  assert.equal(home.title, 'HOME');
  const title = home.keys.find((k) => k.col === 0 && k.row === 0);
  assert.equal(title.label, 'HOME');
  assert.equal(title.tone, 'os');
  const os = show(SURFACES.xl, desk, { system: 'console', page: 0 });
  const save = os.keys.find((k) => k.role === 'show.save');
  let power = null;
  for (let p = 0; p < 6; p++) {
    const hit = show(SURFACES.xl, desk, { system: 'console', page: p }).keys.find((k) => k.label === 'REBOOT');
    if (hit) power = hit;
  }
  assert.equal(save.tone, 'os');
  assert.equal(power.tone, 'os');
  const model = keyModel(save);
  const device = keyModel({ label: 'TAKE', caption: 'PGM', tone: 'stop' });
  assert.equal(model.os, true);
  assert.equal(model.fill, '#243044');
  assert.notEqual(model.fill, device.fill);
  const svg = keySvg(model);
  assert.match(svg, /SHOW/);
  assert.match(svg, /#243044/);
  assert.match(svg, /#8EA0B5/);
  const back = keyModel({ label: 'HOME', caption: 'BACK', nav: 'home', tone: 'os' });
  assert.equal(back.value, 'HOME');
  assert.equal(back.os, true);
});

test('every PTZ page names the camera the deck is controlling', () => {
  const ptzDesk = {
    armed: ['ptz'],
    byKey: { ptz: { cameras: [{ id: 'cam1', name: 'Wide' }, { id: 'cam2', name: 'Tight' }], selected: 'cam2' } },
  };
  const snap = { cameras: [{ id: 'cam1', name: 'Wide' }, { id: 'cam2', name: 'Tight', selected: true }], selected: 'cam2', readouts: {} };
  const wide = show(SURFACES.plusxl, ptzDesk, { system: 'ptz', page: 0 });
  const small = show(SURFACES.plus, ptzDesk, { system: 'ptz', page: 0 });
  for (const first of [wide, small]) {
    assert.match(first.title, /PTZ|lens|preset/i);
    for (let p = 0; p < first.pages; p++) {
      const face = show(first === wide ? SURFACES.plusxl : SURFACES.plus, ptzDesk, { system: 'ptz', page: p });
      const home = applyReadouts(face.keys, snap).find((k) => k.nav === 'home');
      assert.ok(home, `page ${p} has a home key`);
      assert.equal(home.label, 'HOME');
      assert.equal(home.caption, 'Tight');
    }
  }
  const switched = { ...snap, selected: 'cam1', cameras: snap.cameras.map((c) => ({ ...c, selected: c.id === 'cam1' })) };
  const again = applyReadouts(wide.keys, switched).find((k) => k.nav === 'home');
  assert.equal(again.caption, 'Wide');
  const dials = [{ widget: 'iris' }, { widget: 'zoom' }];
  assert.notEqual(dialSignature(dials, snap), dialSignature(dials, switched));
});
