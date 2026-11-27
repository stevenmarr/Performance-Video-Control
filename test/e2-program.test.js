'use strict';
// Event Master layer programming: discovery from capture-style fixtures, page
// generation, encoder math, and the commands a dial actually sends. The mock
// JSON-RPC server stands in for the processor. No test contacts a real E2.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/e2/schema');
const enc = require('../lib/e2/encoders');
const cmd = require('../lib/e2/commands');
const { buildProgramPages } = require('../lib/e2/pages');
const { ProgramSession } = require('../lib/e2/session');
const { mapUnknown } = require('../lib/e2/llm');
const { E2Driver } = require('../lib/drivers/e2');
const { MockE2 } = require('../lib/mocks/e2');
const { SURFACES } = require('../lib/decks/surfaces');
const { show } = require('../lib/decks/faces');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'e2', name), 'utf8'));

function layerNamed(model, destKey, name) {
  const dest = model.destinations.find((d) => d.key === destKey);
  return dest.layers.find((l) => l.name === name);
}

test('v9.2 single screen: mix pair, free layer, aux name, program vs preview', () => {
  const model = normalize(fixture('single-dest-v92.json'));
  assert.equal(model.frame.model, 'E2');
  assert.equal(model.destinations.length, 2);
  const screen = model.destinations[0];
  assert.equal(screen.name, 'Center LED');
  assert.equal(screen.live, true, 'a layer on program marks the destination');
  const a = layerNamed(model, 'S1', 'Layer1-A');
  const b = layerNamed(model, 'S1', 'Layer1-B');
  const free = layerNamed(model, 'S1', 'Layer2-A');
  assert.equal(a.role, 'mix');
  assert.equal(b.role, 'split');
  assert.equal(a.pgm.active, true);
  assert.equal(a.pvw.active, false);
  assert.equal(b.pvw.active, true);
  assert.equal(b.pvw.window.hPos, 960);
  assert.equal(b.pvw.mask.left, 4);
  assert.equal(free.free, true);
  assert.equal(a.capabilities.border, false, 'this frame did not send a border');
  assert.equal(a.capabilities.key, false);
  const aux = model.destinations.find((d) => d.kind === 'aux');
  assert.equal(aux.name, 'Record');
  assert.equal(aux.aux.pgmSourceId, 0);
  assert.equal(model.sources[0].name, 'Cam 1 Wide');
});

test('multi destination: free vs in use, split, separate preview and program sources', () => {
  const model = normalize(fixture('multi-dest.json'));
  assert.equal(model.frame.model, 'E2-Gen2');
  assert.deepEqual(model.destinations.map((d) => d.name), ['Main Wall', 'IMAG', 'DSMs', 'Confidence', 'Stream']);
  const pip = layerNamed(model, 'S1', 'Layer3');
  assert.equal(pip.role, 'pip');
  assert.equal(pip.pvw.active, true);
  assert.equal(pip.pgm.active, false);
  assert.equal(pip.pvw.sourceId, 4);
  assert.equal(pip.pgm.sourceId, 3);
  assert.equal(pip.pvw.freeze, true);
  assert.equal(pip.pvw.crop.hPos, 200, 'source crop is not the layer mask');
  assert.equal(pip.pvw.mask.left, 1.5);
  const split = layerNamed(model, 'S1', 'Layer1-B');
  assert.equal(split.role, 'split');
  assert.equal(split.free, true);
  const imag = layerNamed(model, 'S2', 'Layer1-A');
  assert.equal(imag.pgm.active, true);
  assert.equal(model.destinations[1].live, true);
  assert.equal(model.destinations[2].live, false);
  assert.equal(model.presets[2].locked, true);
});

test('variant firmware: $t ranges, Pvw/Pgm objects, border, shadow, key, transition; unknown field stays listed', () => {
  const model = normalize(fixture('firmware-variant.json'));
  assert.equal(model.frame.model, 'S3-4K');
  assert.equal(model.destinations[0].size.h, 1920);
  const pip = model.destinations[0].layers.find((l) => l.role !== 'background');
  assert.equal(pip.pvw.window.hPos, 120);
  assert.equal(pip.pvw.window.vSize, 540);
  assert.equal(pip.pgm.window.hSize, 1920);
  assert.equal(pip.pvw.sourceId, 2);
  assert.equal(pip.pgm.sourceId, 1);
  assert.equal(pip.capabilities.border, true);
  assert.equal(pip.capabilities.shadow, true);
  assert.equal(pip.capabilities.opacity, true);
  assert.equal(pip.pvw.opacityName, 'Transparency');
  assert.equal(pip.capabilities.key, true);
  assert.equal(pip.pvw.key.mode, 'chroma');
  assert.equal(pip.pvw.key.invert, 1);
  assert.equal(pip.capabilities.transition, true);
  assert.equal(pip.pvw.transition.inTime, 18);
  assert.equal(pip.capabilities.effects, true);
  assert.equal(pip.capabilities.crop, true);
  assert.equal(pip.capabilities.mask, true);
  assert.ok(model.unknown.some((u) => u.field === 'WinH'));
  assert.equal(pip.pvw.z, 3);
});

test('encoder banks only include what that layer sent', () => {
  const sparse = normalize(fixture('single-dest-v92.json'));
  const rich = normalize(fixture('firmware-variant.json'));
  const plain = layerNamed(sparse, 'S1', 'Layer1-A');
  const full = rich.destinations[0].layers.find((l) => l.capabilities.border);
  const plainBanks = enc.banksFor(plain, sparse.destinations[0]).map((b) => b.id);
  const fullBanks = enc.banksFor(full, rich.destinations[0]).map((b) => b.id);
  assert.deepEqual(plainBanks, ['place']);
  assert.ok(fullBanks.includes('look'));
  assert.ok(fullBanks.includes('key'));
  const labels = enc.banksFor(full, rich.destinations[0]).flatMap((b) => b.encoders.flatMap((e) => e.pair.map((p) => p.label)));
  assert.ok(labels.includes('MASK L'));
  assert.ok(labels.includes('CROP X'));
  assert.ok(labels.includes('BDR SIZE'));
  assert.ok(labels.includes('CLIP'));
  assert.ok(labels.includes('IN TYPE'));
  assert.ok(labels.includes('TRANSP'));
  assert.equal(enc.banksFor({ role: 'background', fields: {} }, null).length, 0);
});

test('slow turn is one step, a fast spin is coarse, 800 ms is a reset', () => {
  const fine = enc.stepsFor({ fine: 1, curve: enc.CURVE }, 1, 200);
  const fresh = enc.stepsFor({ fine: 1, curve: enc.CURVE }, 1, null);
  const fast = enc.stepsFor({ fine: 1, curve: enc.CURVE }, 1, 10);
  const back = enc.stepsFor({ fine: 1, curve: enc.CURVE }, -2, 10);
  assert.equal(fine, 1);
  assert.equal(fresh, 1);
  assert.ok(fast > 1, `fast spin should leave the fine zone, got ${fast}`);
  assert.ok(back < -2);
  const percent = enc.stepsFor({ fine: 0.1, curve: enc.PERCENT }, 1, 200);
  assert.equal(percent, 0.1);
  assert.equal(enc.pressKind(799), 'toggle');
  assert.equal(enc.pressKind(800), 'reset');
  assert.equal(enc.LONG_PRESS_MS, 800);
  const turned = enc.applyTurn({ value: 100, min: 0, max: 200, fine: 1, curve: enc.CURVE }, 1, 200);
  assert.equal(turned.value, 101);
  const capped = enc.applyTurn({ value: 199, min: 0, max: 200, fine: 1, curve: enc.CURVE }, 5, 10);
  assert.equal(capped.value, 200);
});

test('aspect lock, center, fit and fill, and z-order stay inside the destination', () => {
  const dest = { h: 1920, v: 1080 };
  const locked = enc.lockSize('h', 960, 16 / 9);
  assert.equal(locked.hSize, 960);
  assert.equal(locked.vSize, 540);
  const centered = enc.centerWindow(dest, { hSize: 960, vSize: 540 });
  assert.equal(centered.hPos, 480);
  assert.equal(centered.vPos, 270);
  const fit = enc.fitWindow(dest, 16 / 9, 'fit');
  assert.ok(fit.hSize <= 1920 && fit.vSize <= 1080);
  assert.equal(fit.hSize / fit.vSize, 16 / 9);
  const fill = enc.fitWindow(dest, 2, 'fill');
  assert.ok(fill.hSize >= 1920 && fill.vSize >= 1080);
  assert.equal(enc.zStep(0, 1, 3), 1);
  assert.equal(enc.zStep(2, 1, 3), 2);
  assert.equal(enc.zStep(0, -1, 3), 0);
});

test('mask, window and source crop are separate changeContent calls, and they go to preview', () => {
  const dest = { id: 0, kind: 'screen' };
  const layer = {
    id: 3,
    wire: { sourceKey: 'LastSrcIdx' },
    pvw: {
      window: { hPos: 10, vPos: 20, hSize: 640, vSize: 360 },
      mask: { left: 5, right: 6, top: 1, bottom: 2 },
      crop: { hPos: 8, vPos: 9, hSize: 100, vSize: 50 },
      active: true,
    },
  };
  const window = cmd.windowCommand(dest, layer);
  const mask = cmd.maskCommand(dest, layer);
  const crop = cmd.cropCommand(dest, layer);
  assert.equal(window.method, 'changeContent');
  assert.equal(window.params.Layers[0].PvwMode, 1);
  assert.deepEqual(window.params.Layers[0].Window, { HPos: 10, VPos: 20, HSize: 640, VSize: 360 });
  assert.equal(window.params.Layers[0].Mask, undefined);
  assert.deepEqual(mask.params.Layers[0].Mask, { Left: 5, Right: 6, Top: 1, Bottom: 2 });
  assert.equal(mask.params.Layers[0].Window, undefined);
  assert.equal(mask.params.Layers[0].LastSrcIdx, undefined);
  assert.deepEqual(crop.params.Layers[0].Source, { HPos: 8, VPos: 9, HSize: 100, VSize: 50 });
  const cleared = cmd.clearCommand(dest, layer);
  assert.equal(cleared.params.Layers[0].PvwMode, 0);
  assert.equal(cleared.params.Layers[0].LastSrcIdx, -1);
  const aux = cmd.auxCommand({ id: 1 }, 4);
  assert.equal(aux.method, 'changeAuxContent');
  assert.deepEqual(aux.params, { id: 1, PvwLastSrcIndex: 4 });
});

test('pages come from the discovered config, and a program layer wears LIVE', () => {
  const model = normalize(fixture('multi-dest.json'));
  const session = new ProgramSession({ rpc: async () => { throw new Error('offline'); } });
  session.model = model;
  session.sel.dest = 'S1';
  session._keepSelection();
  const view = session.view();
  const pages = buildProgramPages(SURFACES.plusxl, view, 'e2');
  assert.equal(pages.length, 5);
  assert.deepEqual(pages.map((p) => p.designId), ['e2-program-dest', 'e2-program-layer', 'e2-program-adjust', 'e2-program-source', 'e2-program-preset']);
  const destNames = pages[0].keys.filter((k) => k.action && k.action.body && k.action.body.op === 'selectDest').map((k) => k.label);
  assert.ok(destNames.includes('Main Wall'));
  assert.ok(destNames.includes('IMAG'));
  assert.ok(!destNames.includes('Screen 1'), 'names come from the frame, not a fixed layout');
  const imag = pages[0].keys.find((k) => k.label === 'IMAG');
  assert.equal(imag.liveCorner, true);
  assert.equal(imag.tone, 'stop');
  session.sel.dest = 'S2';
  const layerPage = buildProgramPages(SURFACES.plusxl, session.view(), 'e2')[1];
  const live = layerPage.keys.find((k) => k.liveCorner && k.action && k.action.body.op === 'selectLayer');
  assert.ok(live);
  assert.match(live.caption, /LIVE/);
  const dsm = buildProgramPages(SURFACES.plusxl, (() => { session.sel.dest = 'S3'; return session.view(); })(), 'e2')[1];
  const free = dsm.keys.find((k) => k.action && k.action.body.op === 'selectLayer');
  assert.match(free.caption, /FREE/);
  assert.equal(free.liveCorner, undefined);
  const rich = normalize(fixture('firmware-variant.json'));
  session.model = rich;
  session.sel.dest = 'S1';
  session.sel.layer = 0;
  session.sel.bank = 'look';
  const adjust = buildProgramPages(SURFACES.plusxl, session.view(), 'e2')[2];
  assert.equal(adjust.dials.length, 6);
  assert.ok(adjust.dials.some((d) => d.e2 && /BDR/.test(d.label)));
  const sparseAdjust = buildProgramPages(SURFACES.plusxl, (() => {
    session.model = normalize(fixture('single-dest-v92.json'));
    session.sel.dest = 'S1';
    session.sel.layer = 0;
    session.sel.bank = 'place';
    return session.view();
  })(), 'e2')[2];
  assert.ok(sparseAdjust.dials.every((d) => !d.label || !/BDR|CLIP|SHDW/.test(d.label)));
});

test('the preset gallery stays page 0 until programming is discovered; then LAYER opens it', () => {
  const quiet = show(SURFACES.plusxl, { armed: ['e2'], byKey: { e2: { view: { presets: [], destinations: [] } } } }, { system: 'e2', page: 0 });
  assert.equal(quiet.designId, 'e2-panel');
  const model = normalize(fixture('single-dest-v92.json'));
  const session = new ProgramSession({ rpc: async () => {} });
  session.model = model;
  const face = show(SURFACES.plusxl, { armed: ['e2'], byKey: { e2: { view: { presets: [], destinations: [], program: session.view() } } } }, { system: 'e2', page: 0 });
  assert.equal(face.designId, 'e2-panel');
  const door = face.keys.find((k) => k.label === 'LAYER');
  assert.equal(door.caption, 'PROGRAM');
  assert.equal(door.nav, 'page');
  const program = show(SURFACES.plusxl, { armed: ['e2'], byKey: { e2: { view: { presets: [], program: session.view() } } } }, { system: 'e2', page: door.page });
  assert.equal(program.designId, 'e2-program-dest');
  assert.ok(program.keys.some((k) => k.label === 'Center LED'));
});

test('mock JSON-RPC: discover, move preview, mask stays a second call, cut copies preview to program', async () => {
  const mock = new MockE2();
  const port = await mock.start(0);
  const driver = new E2Driver({ host: '127.0.0.1', port, timeout: 2000 });
  const session = driver.programSession();
  try {
    const view = await session.discover();
    assert.equal(view.ready, true);
    assert.equal(view.frame.model, 'E2-Gen2');
    assert.ok(view.destinations.some((d) => d.name === 'Main LED' && d.live));
    const banks = view.banks.map((b) => b.id);
    assert.ok(banks.includes('look'), 'the mock show file exposes border and shadow');
    assert.ok(banks.includes('key'));
    await session.act({ op: 'selectDest', dest: 'S1' });
    await session.act({ op: 'selectLayer', layer: 1 });
    mock.history.length = 0;
    await session.act({ op: 'turn', encoder: 0, ticks: 1, dtMs: 250 });
    const moved = mock.calls('changeContent');
    assert.equal(moved.length, 1);
    const layer = moved[0].params.Layers[0];
    assert.equal(layer.PvwMode, 1);
    assert.equal(layer.id, 1);
    assert.equal(layer.Window.HPos, 241);
    assert.equal(layer.Mask, undefined);
    mock.history.length = 0;
    await session.act({ op: 'selectBank', bank: 'place' });
    const view2 = session.view();
    const maskIndex = view2.encoders.findIndex((e) => e.pair.some((p) => p.id === 'maskL'));
    assert.ok(maskIndex >= 0);
    const active = view2.encoders[maskIndex];
    if (active.pair[active.active].id !== 'maskL') await session.act({ op: 'press', encoder: maskIndex, kind: 'toggle' });
    await session.act({ op: 'turn', encoder: maskIndex, ticks: 1, dtMs: 250 });
    const maskCall = mock.calls('changeContent').pop();
    assert.ok(maskCall.params.Layers[0].Mask);
    assert.equal(maskCall.params.Layers[0].Window, undefined);
    mock.history.length = 0;
    await session.act({ op: 'source', id: 4 });
    assert.equal(mock.calls('changeContent').pop().params.Layers[0].LastSrcIdx, 4);
    await session.act({ op: 'cut' });
    assert.ok(mock.calls('cut').length >= 1);
    const after = mock.contents[0].Layers.find((l) => l.id === 1);
    assert.equal(after.PgmMode, after.PvwMode);
  } finally {
    await mock.stop();
  }
});

test('a fixture can be served by the mock JSON-RPC server', async () => {
  const mock = new MockE2();
  mock.serve = fixture('firmware-variant.json');
  const port = await mock.start(0);
  const session = new E2Driver({ host: '127.0.0.1', port, timeout: 2000 }).programSession();
  try {
    const view = await session.discover();
    assert.equal(view.frame.model, 'S3-4K');
    assert.equal(view.destinations[0].name, 'Stage');
    assert.ok(view.banks.some((b) => b.id === 'look'));
    assert.ok(view.unknown.some((u) => u.field === 'WinH'));
  } finally {
    await mock.stop();
  }
});

test('the optional mapper stays off without the flag, and a reviewed proposal can fill a known property', async () => {
  const prevFlag = process.env.E2_LLM_MAP;
  const prevKey = process.env.E2_LLM_API_KEY;
  delete process.env.E2_LLM_MAP;
  delete process.env.E2_LLM_API_KEY;
  try {
    const off = await mapUnknown([{ path: 'dest[S1].layer[0].WinH', type: 'number', sample: 120 }]);
    assert.equal(off.enabled, false);
    assert.match(off.reason, /E2_LLM_MAP/);
    process.env.E2_LLM_MAP = '1';
    const noKey = await mapUnknown([{ path: 'x', type: 'number', sample: 1 }]);
    assert.equal(noKey.enabled, false);
    assert.match(noKey.reason, /E2_LLM_API_KEY/);
    let calls = 0;
    const memory = new Map();
    const once = await mapUnknown(
      [{ path: 'dest[S1].layer[0].WinH', field: 'WinH', type: 'number', sample: 15, destKey: 'S1', layerId: 0 }],
      {
        memory,
        complete: async () => {
          calls += 1;
          return { proposals: [{ path: 'dest[S1].layer[0].WinH', prop: 'posH', confidence: 0.91, note: 'horizontal window' }, { path: 'dest[S1].layer[0].WinH', prop: 'not-a-dial', confidence: 1 }] };
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(once.proposals.length, 1);
    assert.equal(once.proposals[0].prop, 'posH');
    const again = await mapUnknown(
      [{ path: 'dest[S1].layer[0].WinH', field: 'WinH', type: 'number', sample: 15, destKey: 'S1', layerId: 0 }],
      { memory, complete: async () => { calls += 1; return { proposals: [] }; } },
    );
    assert.equal(calls, 1, 'the same unknown set is cached');
    assert.equal(again.cached, true);
  } finally {
    if (prevFlag == null) delete process.env.E2_LLM_MAP; else process.env.E2_LLM_MAP = prevFlag;
    if (prevKey == null) delete process.env.E2_LLM_API_KEY; else process.env.E2_LLM_API_KEY = prevKey;
  }
});
