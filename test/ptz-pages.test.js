'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const deck = require('../lib/deck');
const PC = require('../lib/drivers/ptz-commands');
const shutter = require('../lib/drivers/ptz-shutter');
const { GALLERY } = require('../lib/decks/gallery');
const { show, applyReadouts } = require('../lib/decks/faces');
const { SURFACES } = require('../lib/decks/surfaces');
const { keyModel, keySvg } = require('../lib/decks/look');
const { liveChrome, liveLook, presentKey, keySvg: imageKey } = require('../lib/deck-image');
const { createSceneBaseline, parseNotifyLine } = require('../lib/ptz/scene-baseline');
const { createNotifier } = require('../lib/ptz/update-notify');
const { isGuardedOp, isGuardedCommand, refuseLive, EXPOSURE_RESET, blockExposureReset } = require('../lib/ptz/live-guard');
const { createPresetScopes, labelOf } = require('../lib/ptz/preset-scope');
const accel = require('../lib/paint-accel');

function page(id) { return GALLERY.find((g) => g.id === id); }
function dials(id) { return Object.fromEntries((page(id).dials || []).filter((d) => d && d.label).map((d) => [d.label, d.widget])); }

test('RCP knobs are wired to the control their label names (no more blank placeholders)', () => {
  const exp = dials('ptz-rcp-exp');
  assert.equal(exp.IRIS, 'iris');
  assert.equal(exp.ND, 'ndFilter');
  assert.equal(exp['PIC LEVEL'], 'pictureLevel');
  assert.equal(exp.GAIN, 'gain');
  assert.equal(exp.SHUTTER, 'shutter');
  const white = dials('ptz-rcp-white');
  assert.equal(white['R GAIN'], 'rGain');
  assert.equal(white['B GAIN'], 'bGain');
  assert.equal(white['VAR TEMP'], 'varTemp');
  const black = dials('ptz-rcp-black');
  assert.equal(black['M.PED'], 'masterPed');
  assert.equal(black['R PED'], 'rPed');
  assert.equal(black['G PED'], 'gPed');
  assert.equal(black['B PED'], 'bPed');
  const tone = dials('ptz-rcp-tone');
  assert.equal(tone.GAMMA, 'gamma');
  assert.equal(tone['KNEE PT'], 'kneePoint');
  assert.equal(tone['KNEE SLOPE'], 'kneeSlope');
  assert.ok(!page('ptz-rcp-tone').dials.some((d) => d.label === 'GAMMA MODE' && d.widget), 'mode lists are not knobs');
  const detail = dials('ptz-rcp-detail');
  assert.equal(detail['M.DTL'], 'masterDetail');
  assert.equal(detail['SKIN EFFECT'], 'skinEffect');
  const colour = dials('ptz-rcp-colour');
  assert.deepEqual(['R-G', 'R-B', 'G-R', 'G-B', 'B-R', 'B-G'].map((n) => colour[n]),
    ['matrixRG', 'matrixRB', 'matrixGR', 'matrixGB', 'matrixBR', 'matrixBG']);
});

test('shader-order RCP banks: EXP, BLACK, WHITE, TONE, DETAIL, COLOUR; matrix stays on the deck', () => {
  const ids = GALLERY.filter((g) => g.kind === 'ptz').map((g) => g.id);
  for (const id of ['ptz-rcp-exp', 'ptz-rcp-black', 'ptz-rcp-white', 'ptz-rcp-tone', 'ptz-rcp-detail', 'ptz-rcp-colour', 'ptz-msu', 'ptz-msu-cams']) {
    assert.ok(ids.includes(id), id);
  }
  const desk = { armed: ['ptz'], byKey: { ptz: { cameras: [{ id: 'cam1', name: 'Wide' }], selected: 'cam1' } } };
  const face = show(SURFACES.plusxl, desk, { system: 'ptz', page: 1 });
  assert.equal(face.designId, 'ptz-rcp-exp');
  // v0.39.1: page 1 is the v0.38.0 EXP page (classic bank row). The #76 banks are on the later pages.
  for (const label of ['EXP', 'WHITE', 'DTL', 'GAMMA', 'MATRIX']) {
    assert.ok(face.keys.some((k) => k.label === label), label);
  }
  const black = show(SURFACES.plusxl, desk, { system: 'ptz', page: 10 });
  assert.equal(black.designId, 'ptz-rcp-black');
  for (const label of ['EXP', 'BLACK', 'WHITE', 'TONE', 'DETAIL', 'COLOUR']) {
    assert.ok(black.keys.some((k) => k.label === label), label);
  }
  assert.ok(black.keys.filter((k) => k.tone !== 'blank').every((k) => k.job), 'every drawn key names its job (colour = job)');
});

test('MSU knobs each target that camera, not the selected camera\'s mixed controls', () => {
  // v0.39.1: the per-camera knobs live on ptz-msu-cams so ptz.0 can keep the v0.38.0 selected-camera knobs.
  const msu = page('ptz-msu-cams');
  assert.equal(msu.dials.length, 6);
  msu.dials.forEach((d, i) => {
    assert.equal(d.widget, 'msuCam');
    assert.equal(d.camSlot, i + 1);
    assert.equal(d.label, `CAM ${i + 1}`);
  });
  const planned = deck.plan({
    gesture: 'dial', widget: 'msuCam', event: 'rotate', ticks: 1,
    cam: 'cam3', msuBank: 'masterPed',
    snapshot: { selected: 'cam1', cameras: [{ id: 'cam1' }, { id: 'cam2' }, { id: 'cam3' }] },
  });
  assert.equal(planned.requests[0].body.cam, 'cam3');
  assert.equal(planned.requests[0].body.op, 'masterPed');
  assert.equal(planned.requests[0].body.wrap, false);
});

test('list knobs clamp; list keys still wrap. Auto gain is not a knob stop', () => {
  const nd = PC.catalogFor('UE150', 'AW-UE150').ops.find((o) => o.id === 'ndFilter');
  const first = nd.options[0][0];
  const last = nd.options[nd.options.length - 1][0];
  assert.equal(deck.nextValue(nd, last, 1), first, 'a key still wraps forward');
  assert.equal(deck.nextValue(nd, last, 1, { wrap: false }), last, 'a knob stops at the last ND');
  assert.equal(deck.nextValue(nd, first, -1, { forKnob: true }), first, 'a knob stops at CLEAR');
  const gain = PC.catalogFor('UE150', 'AW-UE150').ops.find((o) => o.id === 'gain');
  const zero = gain.options.find(([, l]) => /0\s*dB/i.test(l))[0];
  const auto = gain.options.find(([, l]) => /^auto$/i.test(l))[0];
  assert.notEqual(deck.nextValue(gain, zero, -1, { wrap: false }), auto, 'gain 0 dB −1 does not land on Auto');
  assert.equal(deck.nextValue(gain, auto, 1, { wrap: false }), zero);
  const chroma = PC.catalogFor('UE150', 'AW-UE150').ops.find((o) => o.id === 'chromaLevel');
  assert.equal(deck.nextValue(chroma, -99, -1, { wrap: false }), -99, 'chroma knob stops before OFF (−100)');
});

test('long press is 800 ms and reset prefers the cached scene value', () => {
  assert.equal(accel.LONG_PRESS_MS, 800);
  assert.equal(accel.pressKind(799), 'toggle');
  assert.equal(accel.pressKind(800), 'reset');
  const base = createSceneBaseline();
  base.remember('cam1', { iris: 62, gamma: 45 }, { scene: '2', source: 'notify' });
  assert.equal(base.sceneValue('cam1', 'iris'), 62);
  assert.equal(base.sceneValue('cam1', 'kneePoint'), undefined);
  const parsed = parseNotifyLine('OSA:30:0x85');
  assert.deepEqual(parsed, { key: 'OSA:30', data: '85' });
});

test('update notifications fill the scene baseline', () => {
  const baseline = createSceneBaseline();
  const n = createNotifier({
    baseline,
    decode: (_cam, key, data) => (key === 'OSI:20' ? { varTemp: parseInt(data, 16) } : undefined),
  });
  n.ingest('cam1', 'OSI:20:00C94\nOSA:6A:80\n');
  assert.equal(baseline.sceneValue('cam1', 'varTemp'), 0xC94);
  assert.equal(baseline.sceneValue('cam1', 'cgi:OSA:6A'), '80');
});

test('live guard covers ABB, bars, scene, exposure reset; recall still uses the flag', () => {
  assert.equal(isGuardedOp('abb'), true);
  assert.equal(isGuardedOp('colorBars'), true);
  assert.equal(isGuardedOp('scene'), true);
  assert.equal(isGuardedOp('iris'), false);
  assert.equal(isGuardedOp('iris', { reset: true }), true);
  assert.ok(EXPOSURE_RESET.has('gain'));
  assert.equal(isGuardedCommand('op', { op: 'awb' }), true);
  assert.equal(isGuardedCommand('reset', { op: 'iris' }), true);
  assert.equal(isGuardedCommand('step', { op: 'iris' }), false);
  const lock = refuseLive('PTZ1', { mode: 'lock', holdMs: 600 }, { action: 'ABB' });
  assert.equal(lock.status, 423);
  assert.match(lock.message, /locked/i);
  const hold = refuseLive('PTZ1', { mode: 'hold', holdMs: 800 }, { action: 'reset iris' });
  assert.equal(hold.status, 423);
  assert.match(hold.message, /800 ms/);
  assert.equal(refuseLive('PTZ1', { mode: 'hold', holdMs: 800 }, { confirmed: true, action: 'reset iris' }), null);
  const blocked = blockExposureReset('PTZ1');
  assert.equal(blocked.status, 423);
  assert.match(blocked.message, /exposure reset is blocked/);
});

test('a recall uses the scope stored with that preset', () => {
  const scopes = createPresetScopes();
  scopes.store('cam1', 3, '2');
  scopes.store('cam1', 1, '0');
  assert.equal(scopes.scopeOf('cam1', 3), '2');
  assert.equal(labelOf(scopes.scopeOf('cam1', 3)), 'C');
  assert.equal(scopes.badge('cam1', 1), 'A');
  assert.equal(scopes.scopeOf('cam1', 9), undefined);
  const raw = scopes.serialize();
  const again = createPresetScopes();
  again.load(raw);
  assert.equal(again.scopeOf('cam1', 3), '2');
});

test('UE160 per-model map: matrix centre 1Fh, gain −6..+12, flare only, no zebra, format-aware shutter', () => {
  const u = PC.catalogFor('UE150', 'AW-UE160', { format: '19' });
  const by = Object.fromEntries(u.ops.map((o) => [o.id, o]));
  assert.deepEqual(by.matrixRG.range, { min: -31, max: 31, step: 1, centre: 0 });
  assert.equal(PC.build('UE150', 'matrixRG', 0, 'AW-UE160').cmd, 'OSD:2F:1F');
  assert.equal(PC.build('UE150', 'matrixRG', -31, 'AW-UE160').cmd, 'OSD:2F:00');
  const gains = by.gain.options.map(([, l]) => l);
  assert.ok(gains.includes('-6dB') && gains.includes('12dB') && !gains.includes('13dB'));
  assert.equal(PC.build('UE150', 'skinEffect', 0, 'AW-UE160').cmd, 'OSG:49:80');
  assert.equal(PC.build('UE150', 'gammaMode', '2', 'AW-UE160').cmd, 'OSJ:D7:02');
  assert.equal(PC.build('UE150', 'drs', '1', 'AW-UE160').cmd, 'OSA:0D:1');
  assert.ok(by.flare && by.flareMaster);
  assert.equal(PC.ZEBRA.supported, false);
  assert.deepEqual(by.shutterStep.options.map(([k]) => k), ['100', '120', '125', '250', '500', '1000', '1500', '2000']);
  assert.throws(() => PC.build('UE150', 'shutterStep', '24', 'AW-UE160'), /not one of/);
  assert.throws(() => PC.build('UE150', 'superGain', true, 'AW-UE160'), /not on the AW-UE160/);
  const e = PC.catalogFor('UE150', 'AW-UE150');
  assert.ok(e.ops.find((o) => o.id === 'superGain'));
  assert.ok(!e.ops.find((o) => o.id === 'flare'));
  assert.equal(PC.build('UE150', 'skinEffect', 9, 'AW-UE150').cmd, 'OSD:A3:89');
  assert.equal(shutter.rateFamily('AW-UE150', '19'), '59.94');
});

test('live camera look is a red frame plus a LIVE corner, not a solid red fill', () => {
  const model = liveLook({ fill: '#222226', border: '#2a313b', value: 'PTZ1', caption: 'CAM' });
  const svg = imageKey(model);
  assert.match(svg, /LIVE/);
  assert.match(svg, /#C42020/);
  assert.match(svg, /#222226/);
  const cam = imageKey(presentKey({ role: 'camera', slot: 2 }, {
    cameras: [
      { id: 'cam1', name: 'Wide', connected: true, tally: false, selected: false },
      { id: 'cam2', name: 'Tight', connected: true, tally: true, selected: true },
    ],
  }));
  assert.match(cam, /LIVE/);
  assert.match(cam, /#C42020/);
  const desk = { armed: ['ptz'], byKey: { ptz: { cameras: [{ id: 'cam1', name: 'Wide', tally: true }], selected: 'cam1' } } };
  const face = show(SURFACES.plusxl, desk, { system: 'ptz', page: 1 });
  const snap = { cameras: [{ id: 'cam1', name: 'Wide', tally: true, selected: true }], selected: 'cam1' };
  const keys = applyReadouts(face.keys, snap);
  const camKey = keys.find((k) => k.cam === 'cam1');
  assert.equal(camKey.liveLook, 'control');
  assert.equal(camKey.caption, 'LIVE');
  const drawn = keySvg(keyModel(camKey));
  assert.match(drawn, /LIVE/);
  assert.equal(accel.LONG_PRESS_MS, 800);
});
