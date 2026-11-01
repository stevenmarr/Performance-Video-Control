'use strict';
// Layout editor: macro ops for SuperSource boxes and upstream DVE keys, capability limits,
// and a round trip through the simulator (no hardware).
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/atem-layout');
const { AtemDesk } = require('../lib/atem-desk');
const { AtemDriver } = require('../lib/drivers/atem');
const { MockAtem } = require('../lib/mocks/atem');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup, until } = require('./helpers');

const quad = {
  me: 0,
  ss: 0,
  art: { artFillSource: 3010, artCutSource: 3011, artOption: 1, artPreMultiplied: false, artClip: 400, artGain: 700, artInvertKey: false },
  border: { borderEnabled: true, borderBevel: 0, borderOuterWidth: 20, borderInnerWidth: 0, borderOuterSoftness: 0, borderInnerSoftness: 0, borderHue: 1200, borderSaturation: 500, borderLuma: 800, borderLightSourceDirection: 360, borderLightSourceAltitude: 25 },
  boxes: [
    { index: 0, enabled: true, source: 1, x: -800, y: 450, size: 500, cropped: true, cropTop: 1000, cropBottom: 0, cropLeft: 500, cropRight: 0 },
    { index: 1, enabled: false, source: 2, x: 800, y: 450, size: 280, cropped: false, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0 },
  ],
  keys: [
    { index: 0, onAir: true, type: 'dve', flyEnabled: false, fill: 3, cut: 0, mask: { enabled: true, top: 8000, bottom: -8000, left: -14000, right: 14000 },
      luma: { preMultiplied: true, clip: 500, gain: 700, invert: false },
      dve: { sizeX: 400, sizeY: 400, positionX: 8000, positionY: -2000, rotation: 900, borderEnabled: true, borderOuterWidth: 15, borderHue: 2000, borderSaturation: 800, borderLuma: 600, shadowEnabled: true, lightSourceDirection: 450, lightSourceAltitude: 30, maskEnabled: false, maskTop: 0, rate: 25 } },
    { index: 1, onAir: false, type: 'luma', flyEnabled: false, fill: 4, cut: 0, luma: { preMultiplied: false, clip: 200, gain: 800, invert: true }, mask: { enabled: false, top: 9000, bottom: -9000, left: -16000, right: 16000 } },
    { index: 2, onAir: false, type: 'chroma', fill: 5, chroma: { hue: 1230, gain: 500, ySuppress: 400, lift: 100, narrow: true } },
    { index: 3, onAir: false, type: 'pattern', fill: 6, pattern: { style: 7, size: 5000, symmetry: 5000, softness: 1000, positionX: 5000, positionY: 4000, invert: false } },
  ],
};
const full = { superSources: 1, boxCounts: [4], mes: 1, keyersByMe: [4], dve: 2, dveElsewhere: () => 0 };

function ids(ops) { return ops.map((o) => o.id); }

test('raster math: a half-size box at (-8, +4.5) sits in the top-left quadrant, and the conversion rounds back', () => {
  const r = L.rectOf(-8, 4.5, 0.5, 0.5);
  assert.equal(r.left, 0);
  assert.equal(r.top, 0);
  assert.equal(r.width, 50);
  assert.equal(r.height, 50);
  const u = L.unitsOf(r.left, r.top, r.width, r.height);
  assert.equal(u.x, -8);
  assert.equal(u.y, 4.5);
  assert.equal(u.sx, 0.5);
  const snapped = L.snap(0.2, [0, 16], 0.4);
  assert.equal(snapped, 0);
  assert.equal(L.snap(1, [0], 0.4), 1);
});

test('source tokens are the names Software Control writes', () => {
  assert.equal(L.sourceToken(0), 'Black');
  assert.equal(L.sourceToken(1), 'Camera1');
  assert.equal(L.sourceToken(1000), 'ColorBars');
  assert.equal(L.sourceToken(2002), 'Color2');
  assert.equal(L.sourceToken(3010), 'MediaPlayer1');
  assert.equal(L.sourceToken(3011), 'MediaPlayer1Key');
  assert.equal(L.sourceToken(6000), 'SuperSource');
  assert.equal(L.sourceToken(6001), 'SuperSource2');
  assert.equal(L.sourceToken(10010), 'ME1Program');
  assert.equal(L.sourceToken(10011), 'ME1Preview');
  assert.equal(L.tokenToId('Camera8'), 8);
  assert.equal(L.tokenToId('MediaPlayer2Key'), 3021);
});

test('macro ops cover SuperSource geometry, art, border and each key type, and do not animate', () => {
  const built = L.build(quad, full, {});
  const xml = L.toXml(built.ops, { name: 'Two shot', index: 4, description: built.note });
  const want = ['SuperSourceV2ArtFillInput', 'SuperSourceV2ArtCutInput', 'SuperSourceV2ArtAbove', 'SuperSourceV2ArtPreMultiply', 'SuperSourceV2ArtClip', 'SuperSourceV2BoxEnable', 'SuperSourceV2BoxInput', 'SuperSourceV2BoxXPosition', 'SuperSourceV2BoxYPosition', 'SuperSourceV2BoxSize', 'SuperSourceV2BoxMaskEnable', 'SuperSourceV2BoxMaskTop', 'SuperSourceV2BoxMaskLeft', 'SuperSourceV2BorderEnable', 'SuperSourceV2BorderHue', 'SuperSourceV2BorderLuminescence', 'SuperSourceV2BorderLightSourceDirection', 'KeyType', 'KeyFillInput', 'KeyOnAir', 'DVEAndFlyKeyXSize', 'DVEAndFlyKeyYSize', 'DVEAndFlyKeyXPosition', 'DVEAndFlyKeyYPosition', 'DVEAndFlyKeyRotation', 'DVEKeyBorderEnable', 'DVEKeyBorderOuterWidth', 'DVEKeyShadowEnable', 'DVEKeyShadowDirection', 'KeyMaskEnable', 'LumaKeyClip', 'LumaKeyInvert', 'ChromaKeyHue', 'ChromaKeyNarrow', 'PatternKeyPattern', 'PatternKeySize', 'PatternKeyXPosition'];
  for (const id of want) assert.ok(ids(built.ops).includes(id), id);
  assert.equal(built.ops.find((o) => o.id === 'SuperSourceV2BoxXPosition' && o.attrs.boxIndex === '0').attrs.xPosition, '-8');
  assert.equal(built.ops.find((o) => o.id === 'SuperSourceV2BoxYPosition' && o.attrs.boxIndex === '0').attrs.yPosition, '4.5');
  assert.equal(built.ops.find((o) => o.id === 'SuperSourceV2BoxSize' && o.attrs.boxIndex === '0').attrs.size, '0.5');
  assert.equal(built.ops.find((o) => o.id === 'SuperSourceV2BoxInput' && o.attrs.boxIndex === '0').attrs.input, 'Camera1');
  assert.equal(built.ops.find((o) => o.id === 'SuperSourceV2BoxMaskTop').attrs.top, '1');
  assert.equal(built.ops.find((o) => o.id === 'SuperSourceV2ArtAbove').attrs.artAbove, 'True');
  assert.equal(built.ops.find((o) => o.id === 'SuperSourceV2ArtFillInput').attrs.input, 'MediaPlayer1');
  assert.equal(built.ops.find((o) => o.id === 'DVEAndFlyKeyXPosition').attrs.xPosition, '8');
  assert.equal(built.ops.find((o) => o.id === 'DVEAndFlyKeyYPosition').attrs.yPosition, '-2');
  assert.equal(built.ops.find((o) => o.id === 'DVEAndFlyKeyRotation').attrs.rotation, '90');
  assert.equal(built.ops.find((o) => o.id === 'DVEAndFlyKeyXSize').attrs.xSize, '0.4');
  assert.equal(built.ops.find((o) => o.id === 'KeyType' && o.attrs.keyIndex === '0').attrs.type, 'DVE');
  assert.equal(built.ops.find((o) => o.id === 'PatternKeyPattern').attrs.pattern, 'CircleIris');
  assert.equal(built.ops.find((o) => o.id === 'LumaKeyClip').attrs.clip, '0.2');
  assert.ok(!ids(built.ops).some((id) => /Run|Sleep|TransitionPosition/.test(id)), 'a layout macro does not animate');
  assert.match(xml, /<Macro index="4" name="Two shot"/);
  assert.match(xml, /SuperSourceV2BoxXPosition/);
  assert.doesNotMatch(xml, /FlyKeyRun/);
});

test('fly key frames are stored after the geometry they capture, and a pair writes A then B', () => {
  const a = JSON.parse(JSON.stringify(quad));
  a.keys[0].dve.positionX = -8000;
  const one = L.build(quad, full, { store: 'b' });
  const storeAt = ids(one.ops).lastIndexOf('FlyKeyStoreKeyFrame');
  const posAt = ids(one.ops).lastIndexOf('DVEAndFlyKeyXPosition');
  assert.ok(storeAt > posAt, 'store follows the position op');
  assert.equal(one.ops[storeAt].attrs.keyFrame, 'B');
  assert.equal(one.steps.filter((s) => s.op === 'uskFlyStore').pop().args.frame, 'b');
  const pair = L.build(quad, full, { store: 'pair', flyFrom: a });
  const frames = pair.ops.filter((o) => o.id === 'FlyKeyStoreKeyFrame').map((o) => o.attrs.keyFrame);
  assert.deepEqual(frames, ['A', 'B']);
  const positions = pair.ops.filter((o) => o.id === 'DVEAndFlyKeyXPosition').map((o) => o.attrs.xPosition);
  assert.deepEqual(positions, ['-8', '8']);
  assert.ok(!pair.ops.some((o) => /Run/.test(o.id)));
});

test('models without SuperSource, without a DVE, or with fewer keyers drop what they cannot do', () => {
  const noSs = L.build(quad, { superSources: 0, boxCounts: [], mes: 1, keyersByMe: [4], dve: 1, dveElsewhere: () => 0 }, {});
  assert.ok(!ids(noSs.ops).some((id) => id.startsWith('SuperSource')));
  assert.ok(noSs.skipped.some((s) => /no SuperSource/.test(s.reason)));
  assert.ok(ids(noSs.ops).includes('DVEAndFlyKeyXPosition'));
  const noDve = L.build(quad, { superSources: 1, boxCounts: [4], mes: 1, keyersByMe: [4], dve: 0, dveElsewhere: () => 0 }, {});
  assert.ok(!ids(noDve.ops).some((id) => id.startsWith('DVE')));
  assert.equal(noDve.ops.find((o) => o.id === 'KeyType' && o.attrs.keyIndex === '0').attrs.type, 'Luma');
  assert.ok(noDve.skipped.some((s) => /No DVE left/.test(s.reason)));
  const oneKey = L.build(quad, { superSources: 1, boxCounts: [4], mes: 1, keyersByMe: [1], dve: 1, dveElsewhere: () => 0 }, {});
  assert.deepEqual([...new Set(oneKey.ops.filter((o) => o.attrs.keyIndex !== undefined).map((o) => o.attrs.keyIndex))], ['0']);
  assert.ok(oneKey.skipped.some((s) => /1 upstream key/.test(s.reason)));
  const noBox = L.build(quad, { superSources: 1, boxCounts: [1], mes: 1, keyersByMe: [4], dve: 2, dveElsewhere: () => 0 }, {});
  assert.ok(!noBox.ops.some((o) => o.attrs.boxIndex === '1'));
});

test('desk XML for a layout step uses the Software Control op, and import reads the position back', () => {
  const desk = new AtemDesk({});
  const built = L.build(quad, full, { store: 'a' });
  desk.saveMacro({ index: 2, name: 'Two shot', description: 'layout', steps: built.steps });
  const xml = desk.toXml();
  assert.match(xml, /SuperSourceV2BoxXPosition/);
  assert.match(xml, /xPosition="-8"/);
  assert.match(xml, /FlyKeyStoreKeyFrame/);
  assert.match(xml, /keyFrame="A"/);
  assert.equal(desk.view().catalog.some((o) => o.op === 'uskDve'), false, 'layout steps stay out of the macro-desk inspector');
  assert.ok(desk.view().catalog.some((o) => o.op === 'ssBox'));
  const back = new AtemDesk({});
  const imported = back.fromXml(xml);
  assert.ok(imported.imported.includes(2));
  const steps = back.view().macros.find((m) => m.index === 2).steps;
  const x = steps.find((s) => s.op === 'ssBox' && s.args.x !== undefined);
  assert.equal(x.args.x, -800);
  assert.ok(steps.some((s) => s.op === 'uskFlyStore' && s.args.frame === 'a'));
  assert.ok(steps.some((s) => s.op === 'uskDve' && s.args.positionX === 8000));
});

test('apply on the simulator moves a box, sets a DVE key, and stores key frame B', async () => {
  const m = new MockAtem({ model: 'chd2me' });
  const port = await m.start(0);
  const d = new AtemDriver({ host: '127.0.0.1', port });
  await d.connect();
  try {
    const view = d.view();
    const layout = L.fromView(view, { me: 1, ss: 0 });
    layout.boxes[0].x = 1200;
    layout.boxes[0].y = -300;
    layout.boxes[0].size = 350;
    layout.keys[0].type = 'dve';
    layout.keys[0].onAir = true;
    layout.keys[0].dve.positionX = 5000;
    layout.keys[0].dve.positionY = 1000;
    layout.keys[0].dve.sizeX = 600;
    layout.keys[0].dve.sizeY = 600;
    const built = L.build(layout, L.capsFromView(view), { store: 'b' });
    const me = (n) => (Number(n) || 1) - 1;
    const body = (a) => Object.fromEntries(Object.entries(a).filter(([k]) => !['me', 'key', 'ss', 'box'].includes(k)));
    for (const step of built.steps) {
      const a = step.args;
      if (step.op === 'ssBox') await d.ssBox(a.ss || 0, a.box, body(a));
      else if (step.op === 'ssProps') await d.ssProps(a.ss || 0, body(a));
      else if (step.op === 'ssBorder') await d.ssBorder(a.ss || 0, body(a));
      else if (step.op === 'uskType') await d.uskType(me(a.me), a.key, a.type, a.flyEnabled);
      else if (step.op === 'uskSources') await d.uskSources(me(a.me), a.key, body(a));
      else if (step.op === 'uskLuma') await d.uskLuma(me(a.me), a.key, body(a));
      else if (step.op === 'uskChroma') await d.uskChroma(me(a.me), a.key, body(a));
      else if (step.op === 'uskPattern') await d.uskPattern(me(a.me), a.key, body(a));
      else if (step.op === 'uskMask') await d.uskMask(me(a.me), a.key, body(a));
      else if (step.op === 'uskDve') await d.uskDve(me(a.me), a.key, body(a));
      else if (step.op === 'uskOnAir') await d.uskOnAir(a.key, !!a.on, me(a.me));
      else if (step.op === 'uskFlyStore') await d.uskFlyStore(me(a.me), a.key, a.frame);
    }
    await until(() => {
      const k = d.view().mixEffects[1].keyers[0];
      return d.view().superSources[0].boxes[0].x === 1200 && k.type === 'dve' && k.dve.positionX === 5000 && k.keyframes && k.keyframes.b && k.keyframes.b.positionX === 5000;
    }, 2000, 'box, dve and key frame');
    const after = d.view();
    assert.equal(after.superSources[0].boxes[0].y, -300);
    assert.equal(after.superSources[0].boxes[0].size, 350);
    assert.equal(after.mixEffects[1].keyers[0].onAir, true);
    assert.equal(after.mixEffects[1].keyers[0].dve.sizeX, 600);
    assert.equal(after.mixEffects[1].keyers[0].fly.isBSet, true);
  } finally { d.close(); await m.stop(); }
});

test('layout presets and the macro route stay on this install and apply through the API', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  try {
    assert.ok((await call('GET', '/api/version')).json.features.includes('atemLayout'));
    await call('POST', '/api/sys/atem/simulate', { model: 'mini' });
    await until(() => systems.view('atem').profile && systems.view('atem').profile.key === 'mini', 2000, 'mini');
    const mini = await call('POST', '/api/sys/atem/cmd/layoutApply', { layout: quad });
    assert.equal(mini.status, 200, JSON.stringify(mini.json));
    assert.ok(mini.json.skipped.some((s) => /no SuperSource/.test(s.reason)));
    assert.equal(systems.view('atem').superSources.length, 0);
    await call('POST', '/api/sys/atem/simulate', { model: 'chd2me' });
    await until(() => systems.view('atem').profile && systems.view('atem').profile.key === 'chd2me', 2000, 'chd2me');
    const look = JSON.parse(JSON.stringify(quad));
    look.boxes[0].x = 1400; look.boxes[0].size = 420;
    const saved = await call('POST', '/api/sys/atem/layout-presets', { name: 'Two shot', layout: look });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const recalled = await call('POST', '/api/sys/atem/cmd/layoutRecall', { preset: saved.json.id });
    assert.equal(recalled.status, 200, JSON.stringify(recalled.json));
    await until(() => systems.view('atem').superSources[0].boxes[0].x === 1400, 2000, 'preset recalled');
    assert.equal(systems.view('atem').superSources[0].boxes[0].size, 420);
    const macro = await call('POST', '/api/sys/atem/layout-macro', { name: 'Two shot', index: 8, layout: quad, store: 'b' });
    assert.equal(macro.status, 200, JSON.stringify(macro.json));
    assert.match(macro.json.xml, /FlyKeyStoreKeyFrame/);
    assert.match(macro.json.xml, /keyFrame="B"/);
    assert.equal(macro.json.macro.steps > 5, true);
    const again = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
    assert.ok(again.layoutPresets().some((p) => p.name === 'Two shot'));
    assert.equal(systems.showPart({ includeConnection: true }).systems.atem && systems.showPart({ includeConnection: true }).systems.atem.layoutPresets, undefined);
    again.close();
  } finally { server.close(); systems.close(); await ctx.teardown(); }
});
