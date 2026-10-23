'use strict';
// 0.10.0 ATEM expansion: model profiles (simulator for every model, detection from product id + topology), the
// router (aux / M/E / multiviewer outputs), classic and Fairlight audio, upstream / downstream keys, SuperSource and
// its layouts, over the driver and over /api/sys/atem. Everything runs against the profile-driven mock on 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/drivers/atem-proto');
const M = require('../lib/drivers/atem-models');
const { AtemDriver } = require('../lib/drivers/atem');
const { MockAtem } = require('../lib/mocks/atem');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup, until } = require('./helpers');

async function rig(model) { const m = new MockAtem({ model }); const port = await m.start(0); const d = new AtemDriver({ host: '127.0.0.1', port }); await d.connect(); return { m, d, stop: async () => { d.close(); await m.stop(); } }; }
const REQUIRED = ['mini', 'minipro', 'miniextreme', 'miniextremeiso', 'tvshd8', 'tvshd8iso', 'chd1me', 'chd2me', 'chd4me', 'c4k1me', 'c4k2me', 'c4k4me', 'c8k', '2meps4k', '4mebs4k', 'ps4k'];

test('profiles: every required model exists with a complete, consistent description', () => {
  for (const k of REQUIRED) assert.ok(M.profile(k), k);
  const ids = new Set();
  for (const p of M.PROFILES) {
    for (const f of ['name', 'productId', 'mes', 'uskPerMe', 'dsk', 'dve', 'superSources', 'ssBoxes', 'mediaPlayers', 'aux', 'multiviewers', 'inputs', 'audio']) assert.notEqual(p[f], undefined, `${p.key}.${f}`);
    assert.ok(!ids.has(p.productId), `${p.key}: product id unique`); ids.add(p.productId);
    assert.ok(['fairlight', 'classic'].includes(p.audio.type));
    const src = M.sources(p);
    assert.equal(src.filter((x) => x.kind === 'input').length > 0, true);
    assert.ok(src.every((x) => x.short.length <= 4 && x.long.length <= 20), `${p.key}: names fit the switcher`);
    if (p.superSources) assert.equal(src.filter((x) => x.kind === 'supersource').length, p.superSources, `${p.key}: SuperSource sources`);
    assert.equal(src.filter((x) => x.port === M.PORT.MediaPlayerFill).length, p.mediaPlayers, `${p.key}: media players`);
    assert.deepEqual(M.detect(p.productId, null), { key: p.key, name: p.name, mismatch: false });
  }
  const c4 = M.summary(M.profile('c4k4me'));
  assert.deepEqual([c4.mes, c4.inputs, c4.keyers, c4.dsk, c4.superSources, c4.aux, c4.multiviewers, c4.audio, c4.madi], [4, 40, 16, 4, 2, 24, 4, 'fairlight', true]);
  const bs = M.summary(M.profile('4mebs4k')); assert.equal(bs.audio, 'classic'); assert.equal(bs.mes, 4);
  assert.equal(M.summary(M.profile('ps4k')).dve, 0);
});

test('simulator: every model answers with its own product id and topology, and the driver detects it', async () => {
  for (const p of M.PROFILES) {
    const { d, stop } = await rig(p.key);
    try {
      const v = d.view();
      assert.equal(v.profile.key, p.key); assert.equal(v.profile.mismatch, false); assert.equal(v.product, p.name);
      assert.equal(v.topology.mixEffects, p.mes); assert.equal(v.topology.auxilliaries, p.aux.length); assert.equal(v.topology.superSources, p.superSources); assert.equal(v.topology.DVEs, p.dve);
      assert.equal(v.mixEffects.length, p.mes); assert.ok(v.mixEffects.every((x) => x.keyers.length === p.uskPerMe));
      assert.equal(v.dsk.length, p.dsk); assert.equal(v.superSources.length, p.superSources); assert.equal(v.multiviewers.length, p.multiviewers);
      assert.equal(v.audio.type, p.audio.type); assert.equal(v.audio.inputs.length, p.audio.inputs.length);
      assert.equal(!!v.audio.routing, p.audio.type === 'fairlight' && !!p.audio.routing);
      assert.equal(v.outputs.filter((o) => o.group === 'aux').length, p.aux.length);
      assert.equal(v.outputs.filter((o) => o.group === 'me').length, p.mes * 2);
    } finally { await stop(); }
  }
});

test('simulator: a large state dump (4 M/E Constellation) survives lost packets (window + resend)', async () => {
  const m = new MockAtem({ model: 'c4k4me' }); m.dropOutgoing = 3; const port = await m.start(0);
  const d = new AtemDriver({ host: '127.0.0.1', port });
  try { await d.connect(); const v = d.view(); assert.equal(v.sources.length, M.sources(M.profile('c4k4me')).length); assert.equal(v.audio.routing.outputs.length, Object.keys(m.fl.routing).length); } finally { d.close(); await m.stop(); }
});

test('router: aux, M/E program / preview and multiviewer windows, with validation of what each output takes', async () => {
  const { m, d, stop } = await rig('chd2me');
  try {
    await d.route('aux:3', 5); await until(() => d.view().outputs.find((o) => o.key === 'aux:3').source === 5, 2000, 'aux 4');
    assert.equal(m.calls('CAuS').pop().hex, '01030005');
    await d.route('me:1:program', 7); await until(() => d.view().mixEffects[1].program === 7, 2000, 'M/E 2 pgm');
    await d.route('me:1:preview', 8); await until(() => d.view().mixEffects[1].preview === 8, 2000, 'M/E 2 pvw');
    assert.equal(m.calls('CPgI').pop().hex, '01000007');
    await d.route('mv:1:5', 3010); await until(() => d.view().multiviewers[1].windows[5].source === 3010, 2000, 'mv window');
    assert.equal(m.calls('CMvI').pop().hex, '01050bc2');
    const out = d.view().outputs.find((o) => o.key === 'mv:1:5'); assert.equal(out.sourceName, 'Media Player 1'); assert.equal(out.label, 'MV 2 Window 6');
    assert.throws(() => d.route('me:0:program', 4010), /not on the M\/E 1 bus/, 'a key mask is not a bus source');
    assert.throws(() => d.route('mv:2:0', 1), /No multiviewer 3/);
  } finally { await stop(); }
  const r2 = await rig('ps4k');
  try {
    assert.throws(() => r2.d.route('mv:0:1', 1), /fixed/, 'the classic 10-view program / preview windows are fixed');
    assert.throws(() => r2.d.route('me:0:program', 10010), /not on the M\/E 1 bus/);
    assert.throws(() => r2.d.route('aux:5', 1), /No aux 6/);
    assert.throws(() => r2.d.route('bogus', 1), /Unknown output/);
  } finally { await r2.stop(); }
});

test('audio (Fairlight, TVS HD8): mix option, fader dB, nudge, mute toggle back to AFV, master, monitor, solo, routing', async () => {
  const { m, d, stop } = await rig('tvshd8iso');
  try {
    const a0 = d.view().audio; const in1 = a0.inputs.find((x) => x.id === 1); assert.equal(in1.mix, 'afv'); assert.deepEqual(in1.supported, ['off', 'on', 'afv']);
    assert.equal(a0.madi.inputs, 16);
    await d.audioInput(1, { fader: -12.5, balance: -40 }); await until(() => d.view().audio.inputs[0].fader === -12.5, 2000, 'fader');
    assert.equal(d.view().audio.inputs[0].balance, -40); assert.equal(m.fl.inputs[1].src.faderGain, -1250);
    await d.audioNudge(1, 2.5); await until(() => d.view().audio.inputs[0].fader === -10, 2000, 'nudge');
    await d.audioMute(1, 'toggle'); await until(() => d.view().audio.inputs[0].muted, 2000, 'muted');
    await d.audioMute(1, 'toggle'); await until(() => d.view().audio.inputs[0].mix === 'afv', 2000, 'back to AFV');
    assert.throws(() => d.audioInput(1301, { mix: 'afv' }), /no afv option/, 'mic has no AFV');
    await d.audioInput(1, { fader: 99 }); await until(() => d.view().audio.inputs[0].fader === 10, 2000, 'clamped +10 dB');
    await d.audioMaster({ fader: -3 }); await until(() => d.view().audio.master.fader === -3, 2000, 'master');
    await d.audioMasterNudge(-1); await until(() => d.view().audio.master.fader === -4, 2000, 'master nudge');
    await d.audioMonitor({ gain: -6, mute: true }); await until(() => d.view().audio.monitor.mute && d.view().audio.monitor.gain === -6, 2000, 'monitor');
    await d.audioSolo(3, true); await until(() => d.view().audio.inputs.find((x) => x.id === 3).solo, 2000, 'solo');
    const r = d.view().audio.routing; const madi1 = r.outputs.find((o) => o.madi); const src = r.sources.find((s) => s.name === 'Input 5 1/2');
    await d.audioRoute(madi1.id, src.id); await until(() => d.view().audio.routing.outputs.find((o) => o.id === madi1.id).sourceName === 'Input 5 1/2', 2000, 'route');
    assert.throws(() => d.audioRoute(123, src.id), /No audio routing output/);
  } finally { await stop(); }
});

test('audio (classic, 4 M/E Broadcast Studio 4K): level in dB, balance, mute, master, monitor', async () => {
  const { m, d, stop } = await rig('4mebs4k');
  try {
    const a = d.view().audio; assert.equal(a.type, 'classic'); assert.equal(a.routing, null); assert.equal(a.inputs.length, 26);
    await d.audioInput(5, { fader: -6, balance: 50, mix: 'on' }); await until(() => d.view().audio.inputs.find((x) => x.id === 5).mix === 'on', 2000, 'on');
    const x = d.view().audio.inputs.find((i) => i.id === 5); assert.ok(Math.abs(x.fader + 6) < 0.05); assert.equal(x.balance, 50); assert.equal(m.classic.inputs[5].gain, P.dbToU16(-6));
    await d.audioMute(5, true); await until(() => d.view().audio.inputs.find((i) => i.id === 5).muted, 2000, 'muted');
    await d.audioMaster({ fader: -10 }); await until(() => Math.abs(d.view().audio.master.fader + 10) < 0.05, 2000, 'master');
    await d.audioMonitor({ dim: true }); await until(() => d.view().audio.monitor.dim, 2000, 'dim');
    await d.audioSolo(2, true); await until(() => d.view().audio.inputs.find((i) => i.id === 2).solo, 2000, 'solo');
    assert.throws(() => d.audioRoute(1, 1), /No audio routing output/);
  } finally { await stop(); }
});

test('keys: USK type, fill / key, luma, chroma, pattern, mask, DVE, fly key frames; DVE count enforced; DSK settings', async () => {
  const { m, d, stop } = await rig('chd2me');
  try {
    await d.uskType(1, 2, 'dve'); await until(() => d.view().mixEffects[1].keyers[2].type === 'dve', 2000, 'dve');
    await d.uskSources(1, 2, { fill: 6, cut: 7 }); await until(() => d.view().mixEffects[1].keyers[2].fill === 6 && d.view().mixEffects[1].keyers[2].cut === 7, 2000, 'sources');
    await d.uskDve(1, 2, { positionX: -4000, sizeX: 300, sizeY: 300, rotation: 450, borderEnabled: true }); await until(() => d.view().mixEffects[1].keyers[2].dve.positionX === -4000, 2000, 'dve pos');
    const dv = d.view().mixEffects[1].keyers[2].dve; assert.deepEqual([dv.sizeX, dv.rotation, dv.borderEnabled, dv.positionY], [300, 450, true, 4500]);
    await d.uskFlyStore(1, 2, 'a'); await until(() => d.view().mixEffects[1].keyers[2].fly.isASet, 2000, 'A set');
    await d.uskDve(1, 2, { positionX: 4000 }); await until(() => d.view().mixEffects[1].keyers[2].dve.positionX === 4000, 2000, 'moved');
    await d.uskFlyRun(1, 2, 'a'); await until(() => d.view().mixEffects[1].keyers[2].dve.positionX === -4000, 3000, 'ran to A');
    await d.uskType(0, 0, 'dve'); await until(() => d.view().mixEffects[0].keyers[0].type === 'dve', 2000, '2nd dve');
    await d.uskType(0, 1, 'dve'); await new Promise((r) => setTimeout(r, 150));
    assert.equal(d.view().mixEffects[0].keyers[1].type, 'luma', 'the 2 M/E Constellation has 2 DVEs: a third DVE key is refused');
    assert.equal(d.view().dves.count, 2); assert.equal(d.view().dves.inUse, 2);
    await d.uskType(0, 1, 'chroma'); await d.uskChroma(0, 1, { hue: 2000, gain: 600 }); await until(() => d.view().mixEffects[0].keyers[1].chroma.hue === 2000, 2000, 'chroma');
    await d.uskLuma(0, 3, { clip: 400, invert: true }); await until(() => d.view().mixEffects[0].keyers[3].luma.clip === 400, 2000, 'luma');
    await d.uskPattern(0, 3, { style: 2, size: 5000 }); await until(() => d.view().mixEffects[0].keyers[3].pattern.style === 2, 2000, 'pattern');
    await d.uskMask(0, 3, { enabled: true, top: 4000 }); await until(() => d.view().mixEffects[0].keyers[3].mask.enabled, 2000, 'mask');
    assert.equal(d.view().mixEffects[0].keyers[3].mask.top, 4000);
    assert.throws(() => d.uskLuma(0, 3, { bogus: 1 }), /unknown field bogus/);
    assert.throws(() => d.uskLuma(0, 9, { clip: 1 }), /No upstream key 10/);
    await d.dskSources(1, { fill: 3020, cut: 3021 }); await d.dskGeneral(1, { preMultiply: false, clip: 300, gain: 500, invert: true }); await d.dskRate(1, 50);
    await d.dskMask(1, { enabled: true, left: -8000 });
    await until(() => { const k = d.view().dsk[1]; return k.fill === 3020 && k.cut === 3021 && k.clip === 300 && k.rate === 50 && k.mask.left === -8000 && k.invert && !k.preMultiply; }, 2000, 'dsk');
    assert.ok(m.calls('CDsG').length && m.calls('CDsM').length);
  } finally { await stop(); }
  const r = await rig('ps4k'); try { assert.throws(() => r.d.uskType(0, 0, 'dve'), /has no DVE/); } finally { await r.stop(); }
});

test('SuperSource: box source / position / size / crop, art, border, layout recall with and without sources', async () => {
  const { d, stop } = await rig('c4k4me');
  try {
    const ss = d.view().superSources; assert.equal(ss.length, 2); assert.equal(ss[1].boxes.length, 4);
    await d.ssBox(1, 2, { source: 12, x: -1200, y: 300, size: 400, cropped: true, cropLeft: 2000 });
    await until(() => { const b = d.view().superSources[1].boxes[2]; return b.source === 12 && b.x === -1200 && b.size === 400 && b.cropLeft === 2000; }, 2000, 'box');
    await d.ssBox(1, 2, { size: 5 }); await until(() => d.view().superSources[1].boxes[2].size === 70, 2000, 'clamped to 0.07');
    assert.throws(() => d.ssBox(1, 2, { source: 10010 }), /cannot be routed to a SuperSource box/);
    assert.throws(() => d.ssBox(2, 0, { x: 1 }), /No SuperSource 3/);
    await d.ssProps(0, { artFillSource: 3010, artOption: 1 }); await until(() => d.view().superSources[0].props.artOption === 1, 2000, 'art');
    await d.ssBorder(0, { borderEnabled: true, borderOuterWidth: 200 }); await until(() => d.view().superSources[0].border.borderEnabled, 2000, 'border');
    const before = d.view().superSources[0].boxes.map((b) => b.source);
    await d.ssLayout(0, [{ box: 0, enabled: true, x: 0, y: 0, size: 1000, source: 9 }, { box: 1, enabled: true, x: 1100, y: -580, size: 280 }, { box: 2, enabled: false }, { box: 3, enabled: false }]);
    await until(() => d.view().superSources[0].boxes[0].size === 1000 && !d.view().superSources[0].boxes[2].enabled, 2000, 'layout');
    assert.deepEqual(d.view().superSources[0].boxes.map((b) => b.source), before, 'sources kept without withSources');
    await d.ssLayout(0, [{ box: 0, source: 9 }], true); await until(() => d.view().superSources[0].boxes[0].source === 9, 2000, 'with sources');
  } finally { await stop(); }
});

test('/api/sys/atem: models, simulate {model} (switching model), new ops with log lines, SuperSource layouts CRUD', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const lines = []; const orig = systems.log.bind(systems); systems.log = (l, msg) => { lines.push(msg); orig(l, msg); };
  try {
    const ver = (await call('GET', '/api/version')).json; assert.equal(ver.apiVersion, 9);
    for (const f of ['atemModels', 'atemRouter', 'atemAudio', 'atemFairlight', 'atemKeys', 'atemSuperSource', 'atemSsLayouts', 'atemMultiviewer']) assert.ok(ver.features.includes(f), f);
    const ml = (await call('GET', '/api/sys/atem/models')).json; assert.equal(ml.default, 'tvshd8iso'); assert.ok(ml.models.length >= 16); assert.equal(ml.simulator, null);
    assert.equal((await call('POST', '/api/sys/atem/simulate', { model: 'nope' })).status, 400);
    let st = (await call('POST', '/api/sys/atem/simulate', { model: 'chd2me' })).json;
    assert.equal(st.view.profile.key, 'chd2me'); assert.equal(st.view.connection.simulatorModel, 'chd2me');
    assert.equal((await call('GET', '/api/sys/atem/models')).json.simulator, 'chd2me');
    st = (await call('POST', '/api/sys/atem/simulate', { model: 'ps4k' })).json; assert.equal(st.view.profile.key, 'ps4k', 'a second simulate with another model switches');
    st = (await call('POST', '/api/sys/atem/simulate', { model: 'c4k4me' })).json; assert.equal(st.view.profile.key, 'c4k4me');
    const ok = async (name, body) => { const r = await call('POST', `/api/sys/atem/cmd/${name}`, body); assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`); };
    await ok('route', { output: 'aux:0', source: 3 });
    await ok('route', { output: 'me:2:preview', source: 4 });
    await ok('mvSource', { mv: 3, window: 4, source: 2 });
    await ok('uskOnAir', { me: 3, key: 1, on: true });
    await ok('uskDve', { me: 3, key: 1, positionX: 1000 });
    await ok('ssBox', { ss: 1, box: 0, source: 7 });
    await ok('audioMute', { input: 2, mute: true });
    await ok('audioNudge', { input: 2, delta: -3 });
    await ok('audioRoute', { output: (systems.view('atem').audio.routing.outputs[0]).id, source: systems.view('atem').audio.routing.sources[3].id });
    assert.equal((await call('POST', '/api/sys/atem/cmd/uskDve', { me: 3, key: 1, zoom: 1 })).status, 400);
    await until(() => { const v = systems.view('atem'); return v.outputs.find((o) => o.key === 'aux:0').source === 3 && v.mixEffects[2].keyers[1].onAir && v.superSources[1].boxes[0].source === 7 && v.audio.inputs.find((i) => i.id === 2).muted; }, 2000, 'state through the API');
    assert.ok(lines.includes('ATEM: Output 1 ← Cam 3 Jib'), lines.join(' | '));
    assert.ok(lines.includes('ATEM: M/E 3 USK 2 ON AIR'));
    assert.ok(lines.includes('ATEM: SuperSource 2 box 1 ← Graphics'));
    assert.ok(lines.some((l) => /^ATEM: audio Input 2 MUTED/.test(l)));
    // layouts
    let ls = (await call('GET', '/api/sys/atem/ss-layouts')).json.layouts; assert.ok(ls.some((l) => l.id === 'quad' && l.builtIn));
    const saved = (await call('POST', '/api/sys/atem/ss-layouts', { name: 'Panel 3-up', ss: 1 })).json; assert.equal(saved.boxes.length, 4); assert.equal(saved.boxes[0].source, 7);
    assert.equal((await call('POST', '/api/sys/atem/ss-layouts', { name: 'Quad' })).status, 409, 'built-in names are reserved');
    await ok('ssLayoutRecall', { ss: 1, layout: 'pip' });
    await until(() => systems.view('atem').superSources[1].boxes[0].size === 1000, 2000, 'pip recalled');
    assert.equal(systems.view('atem').superSources[1].boxes[0].source, 7, 'a layout recall keeps sources by default');
    await ok('ssLayoutRecall', { ss: 1, layout: saved.id, withSources: true });
    await until(() => systems.view('atem').superSources[1].boxes[0].size === 500, 2000, 'saved recalled');
    assert.ok(systems.view('atem').ssLayouts.some((l) => l.id === saved.id));
    const sm2 = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false }); assert.ok(sm2.ssLayouts().some((l) => l.name === 'Panel 3-up'), 'saved per install'); sm2.close();
    assert.equal(systems.showPart({ includeConnection: true }).systems.atem && systems.showPart({ includeConnection: true }).systems.atem.ssLayouts, undefined, 'not in show files');
    assert.equal((await call('DELETE', '/api/sys/atem/ss-layouts/quad')).status, 409);
    assert.equal((await call('DELETE', `/api/sys/atem/ss-layouts/${saved.id}`)).status, 200);
    ls = (await call('GET', '/api/sys/atem/ss-layouts')).json.layouts; assert.ok(!ls.some((l) => l.id === saved.id));
    assert.equal((await call('POST', '/api/sys/atem/cmd/ssLayoutRecall', { ss: 1, layout: saved.id })).status, 404);
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); await systems.stopSim('atem'); systems.close(); await ctx.teardown(); }
});
