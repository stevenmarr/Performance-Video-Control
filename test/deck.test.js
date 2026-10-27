'use strict';
// 0.20 Path C: the Stream Deck plugin talks HTTP to Control Center, and Control Center talks to the camera.
// These tests are the contract the plugin uses (lib/deck.js) plus the routes it calls. No test opens a
// camera port except the loopback mock, and the deck snapshot never carries a password.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deck = require('../lib/deck');
const img = require('../lib/deck-image');
const PC = require('../lib/drivers/ptz-commands');
const { MockPTZ } = require('../lib/mocks/ptz');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');

const SECRET = 'super-secret-pw';

function fakeSnap(over = {}) {
  return {
    selected: 'cam1',
    cameras: [
      { slot: 1, id: 'cam1', name: 'Wide', connected: true, tally: false, selected: true },
      { slot: 2, id: 'cam2', name: 'Stage', connected: true, tally: true, selected: false },
    ],
    presets: Array.from({ length: 18 }, (_, i) => ({ n: i + 1, name: i === 0 ? 'Wide' : `Preset ${i + 1}` })),
    values: { iris: 26, irisMode: true, rGain: -14, bGain: 22, focusMode: false, detail: true },
    readouts: {
      iris: { id: 'iris', text: '26', value: 26, fraction: 0.26, type: 'range', centre: null, range: { min: 1, max: 99, step: 1 } },
      irisMode: { id: 'irisMode', text: 'ON', value: true, on: true, type: 'toggle' },
      rGain: { id: 'rGain', text: '-14', value: -14, fraction: 0.46, type: 'range', centre: 0 },
      bGain: { id: 'bGain', text: '+22', value: 22, fraction: 0.55, type: 'range', centre: 0 },
      rPed: { id: 'rPed', text: '+4', value: 4, fraction: 0.52, type: 'range', centre: 0 },
      bPed: { id: 'bPed', text: '-3', value: -3, fraction: 0.48, type: 'range', centre: 0 },
      masterPed: { id: 'masterPed', text: '+5', value: 5, fraction: 0.51, type: 'range', centre: 0 },
      zoomPos: { id: 'zoomPos', text: '42.0%', value: 42, fraction: 0.42, type: 'range', centre: null },
      focusPos: { id: 'focusPos', text: '55.0%', value: 55, fraction: 0.55, type: 'range', centre: null },
      focusMode: { id: 'focusMode', text: 'OFF', value: false, on: false, type: 'toggle' },
      detail: { id: 'detail', text: 'ON', value: true, on: true, type: 'toggle' },
      masterDetail: { id: 'masterDetail', text: '0', value: 0, fraction: 0.5, type: 'range', centre: 0 },
      gamma: { id: 'gamma', text: '0.45', value: 45, fraction: 0.33, type: 'range', centre: 55 },
      chromaLevel: { id: 'chromaLevel', text: '+10%', value: 10, fraction: 0.55, type: 'range', centre: 0 },
      kneePoint: { id: 'kneePoint', text: '85.00%', value: 85, fraction: 0.4, type: 'range', centre: null, range: { min: 70, max: 107, step: 0.25 } },
      gain: { id: 'gain', text: '0 dB', value: '08', type: 'list' },
    },
    speeds: { pt: 25, zoom: 25, focus: 15 },
    liveGuard: { mode: 'hold', holdMs: 600 },
    ...over,
  };
}

const pathsOf = (plan) => plan.requests.map((r) => r.path);

test('Path C layout: + XL strip is the paint knobs, keys are toggles, HOME is the M4 mark, red is PGM only', () => {
  assert.deepEqual(deck.layoutIssues(), []);
  assert.equal(deck.THEME.pgm, '#C42020');
  assert.equal(deck.THEME.accent, '#3B8CFF');
  assert.equal(deck.THEME.panel, '#222226');
  assert.equal(deck.PLUSXL.knobCols.join(','), '0,2,3,5,6,8');
  for (const page of deck.PLUSXL.pages) {
    assert.equal(page.keys[0][0].role, 'home');
    assert.equal(page.keys[3][8].role, 'allStop');
    assert.equal(page.dials.length, 6);
    const roles = page.keys.flat().map((c) => c.role);
    for (const banned of ['rGain', 'bGain', 'rPed', 'bPed', 'masterPed']) assert.equal(roles.includes(banned), false, `${page.id} must not put ${banned} on a key`);
  }
  assert.deepEqual(deck.PLUSXL.pages[0].dials, ['iris', 'masterPed', 'gainRb', 'pedRb', 'zoom', 'focus']);
  assert.deepEqual(deck.PLUSXL.pages[1].dials, ['gainRb', 'pedRb', 'masterDetail', 'gamma', 'chroma', 'kneePoint']);
  const live = deck.PLUSXL.pages[0];
  assert.deepEqual(live.keys[3].map((c) => c.role), ['page', 'page', 'page', 'page', 'irisMode', 'oneTouchAF', 'awb', 'guard', 'allStop']);
  assert.equal(deck.PLUGIN_UUID, 'com.performancevideo.control');
});

test('paired dial push cycles R·FINE → R·COARSE → B·FINE → B·COARSE; rotate steps only the active axis', () => {
  const snap = fakeSnap();
  let stepIndex = 0;
  const labels = [];
  for (let i = 0; i < 4; i++) {
    const face = deck.dialFace('gainRb', snap, stepIndex);
    labels.push(face.step);
    const turned = deck.plan({ gesture: 'dial', widget: 'gainRb', event: 'rotate', ticks: 1, stepIndex, snapshot: snap });
    assert.equal(turned.requests[0].path, '/api/sys/ptz/cmd/step');
    assert.equal(turned.requests[0].body.op, i < 2 ? 'rGain' : 'bGain');
    assert.equal(turned.requests[0].body.steps, i % 2 === 0 ? 1 : 5);
    stepIndex = deck.plan({ gesture: 'dial', widget: 'gainRb', event: 'push', stepIndex, snapshot: snap }).stepIndex;
  }
  assert.deepEqual(labels, ['R · FINE', 'R · COARSE', 'B · FINE', 'B · COARSE']);
  assert.equal(stepIndex, 0);
  const tap = deck.plan({ gesture: 'dial', widget: 'gainRb', event: 'tap', stepIndex: 0, snapshot: snap });
  assert.deepEqual(tap.requests[0], { method: 'POST', path: '/api/sys/ptz/cmd/op', body: { cam: 'cam1', op: 'awb' } });
  const ped = deck.plan({ gesture: 'dial', widget: 'pedRb', event: 'tap', stepIndex: 0, snapshot: snap });
  assert.equal(ped.requests[0].body.op, 'abb');
  assert.throws(() => deck.plan({ gesture: 'key', role: 'rGain', snapshot: snap }), /Unknown key|dials/);
});

test('dials, keys, presets and HOME become Control Center HTTP calls and never a camera URL', () => {
  const snap = fakeSnap();
  const plans = [
    deck.plan({ gesture: 'home', snapshot: snap }),
    deck.plan({ gesture: 'select', slot: 2, snapshot: snap }),
    deck.plan({ gesture: 'recall', preset: 4, confirmed: true, snapshot: snap }),
    deck.plan({ gesture: 'key', role: 'irisMode', snapshot: snap }),
    deck.plan({ gesture: 'key', role: 'guard', snapshot: snap }),
    deck.plan({ gesture: 'key', role: 'allStop', snapshot: snap }),
    deck.plan({ gesture: 'key', role: 'gain', snapshot: snap }),
    deck.plan({ gesture: 'dial', widget: 'iris', event: 'rotate', ticks: -1, stepIndex: 1, snapshot: snap }),
    deck.plan({ gesture: 'dial', widget: 'iris', event: 'tap', snapshot: snap }),
    deck.plan({ gesture: 'dial', widget: 'masterPed', event: 'tap', snapshot: snap }),
    deck.plan({ gesture: 'dial', widget: 'zoom', event: 'tap', snapshot: snap }),
    deck.plan({ gesture: 'dial', widget: 'focus', event: 'tap', snapshot: snap }),
    deck.plan({ gesture: 'dial', widget: 'gamma', event: 'tap', snapshot: snap }),
    deck.plan({ gesture: 'hold', role: 'moveUp', phase: 'move', factor: 0.25, snapshot: snap }),
    deck.plan({ gesture: 'hold', role: 'moveUp', phase: 'stop', snapshot: snap }),
    deck.plan({ gesture: 'page', page: 'paint', snapshot: snap }),
    deck.plan({ gesture: 'dial', widget: 'ptSpeed', event: 'rotate', ticks: 1, stepIndex: 0, snapshot: snap }),
  ];
  assert.equal(plans[0].open, '/');
  assert.equal(plans[0].requests.length, 0);
  assert.equal(plans[1].requests[0].body.cam, 'cam2');
  assert.deepEqual(plans[2].requests[0].body, { cam: 'cam1', preset: 4, guarded: true, confirmed: true });
  assert.equal(plans[3].requests[0].body.value, false, 'iris was auto, the key turns it off');
  assert.equal(plans[4].requests[0].path, '/api/sys/ptz/cmd/guard');
  assert.equal(plans[5].requests[0].path, '/api/sys/ptz/cmd/stopAll');
  assert.equal(plans[6].requests[0].body.op, 'gain');
  assert.equal(plans[7].requests[0].body.steps, -5, 'coarse is 5 codes per detent');
  assert.equal(plans[8].requests[0].body.op, 'irisMode');
  assert.deepEqual(plans[9].requests[0].body, { cam: 'cam1', op: 'masterPed', value: 0 });
  assert.deepEqual(plans[10].requests[0].body.axes, ['z']);
  assert.equal(plans[11].requests[0].body.op, 'oneTouchAF');
  assert.deepEqual(plans[12].requests[0].body, { cam: 'cam1', op: 'gammaMode', value: '0' });
  assert.equal(plans[13].requests[0].body.tilt, 0.25);
  assert.deepEqual(plans[14].requests[0].body.axes, ['pt']);
  assert.equal(plans[15].profile, 'PTZ Paint');
  assert.deepEqual(plans[16].requests[0].body, { pt: 26 });
  for (const p of plans) for (const r of p.requests) {
    assert.match(r.path, /^\/api\//);
    assert.equal(/cgi-bin|aw_ptz|aw_cam/.test(r.path), false);
    assert.equal(JSON.stringify(r).includes(SECRET), false);
  }
  assert.equal(deck.controlCenterBase({}), 'http://127.0.0.1:8080');
  assert.throws(() => deck.controlCenterBase({ host: 'user:pw@10.1.1.1' }), /host/);
});

test('readouts match the paint pane, and the strip SVG is a circular knob (dual R/B, no key double)', () => {
  const cat = (series) => PC.catalogFor(series);
  const view = {
    selected: 'cam1', rev: 3,
    cameras: [{ id: 'cam1', name: 'Wide', connected: true, tally: false, series: 'UE150', presetNames: { 1: 'Wide' }, values: { iris: 26, irisMode: true, rGain: -14, bGain: 22, gamma: 45, chromaLevel: 10, kneePoint: 85, masterPed: 5 } }],
    speeds: { pt: 25, zoom: 25, focus: 15 }, liveGuard: { mode: 'hold', holdMs: 600 },
  };
  const snap = deck.snapshot(view, cat, { rev: 3 });
  assert.equal(snap.rev, 3);
  assert.equal(snap.direct, false);
  assert.equal(snap.companion, false);
  assert.equal(snap.readouts.iris.text, '26');
  assert.equal(snap.readouts.gamma.text, '0.45');
  assert.equal(snap.readouts.chromaLevel.text, '+10%');
  assert.equal(snap.readouts.kneePoint.text, '85.00%');
  assert.equal(snap.readouts.masterPed.text, '+5');
  assert.equal(snap.readouts.rGain.text, '-14');
  assert.equal(snap.readouts.bGain.text, '+22');
  assert.equal(snap.presets[0].name, 'Wide');
  assert.equal(snap.presets.length, 18);
  const irisOp = PC.catalogFor('UE150').ops.find((o) => o.id === 'iris');
  assert.equal(deck.nextValue(irisOp, 26, 5), 31);
  assert.equal(deck.nextValue(irisOp, 98, 5), 99);
  const wb = PC.catalogFor('UE150').ops.find((o) => o.id === 'wbMode');
  assert.equal(deck.nextValue(wb, '0', 1), '1');

  const face = deck.dialFace('gainRb', snap, 0);
  const svg = img.knobSvg(face);
  assert.match(svg, /#ff8a8f/);
  assert.match(svg, /#8fb8ff/);
  assert.match(svg, /-14/);
  assert.match(svg, /\+22/);
  assert.match(arcPathFraction(svg), /A /);
  const low = img.arcPath(50, 50, 40, 0.1);
  const high = img.arcPath(50, 50, 40, 0.9);
  assert.notEqual(low, high);

  const pgm = img.keySvg(img.presentKey({ role: 'camera', slot: 2 }, fakeSnap()));
  const idle = img.keySvg(img.presentKey({ role: 'camera', slot: 1 }, fakeSnap()));
  const on = img.keySvg(img.presentKey({ role: 'irisMode' }, fakeSnap()));
  const home = img.keySvg(img.presentKey({ role: 'home' }, fakeSnap()));
  assert.match(pgm, new RegExp(deck.THEME.pgm));
  assert.equal(idle.includes(deck.THEME.pgm), false);
  assert.match(on, new RegExp(deck.THEME.accent));
  assert.equal(on.includes(deck.THEME.pgm), false, 'a feature that is on is accent, not PGM red');
  assert.match(home, /<path /);
  assert.equal(home.includes(deck.THEME.pgm), false);
  const preset = img.keySvg(img.presentKey({ role: 'preset', preset: 1 }, fakeSnap({ cameras: [{ slot: 1, id: 'cam1', name: 'Wide', connected: true, tally: true, selected: true }] })));
  assert.match(preset, /stroke="#C42020"/);
  assert.match(preset, /HOLD/);
  assert.equal(preset.includes('fill="#C42020"'), false, 'a live preset is outlined, not filled');
});

function arcPathFraction(svg) {
  return svg;
}

test('the property inspector offers key roles and knobs, and the plugin source never names a camera CGI', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'streamdeck', 'com.performancevideo.control.sdPlugin', 'ui', 'settings.html'), 'utf8');
  const roles = [...html.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
  const keyRoles = roles.filter((id) => deck.KEY_ROLES[id]);
  assert.ok(keyRoles.length >= 20);
  for (const id of keyRoles) assert.equal(deck.KEY_BAN.has(id) || deck.KEY_BAN.has(deck.KEY_ROLES[id].op), false, id);
  const roleBlock = html.slice(html.indexOf('id="role"'), html.indexOf('id="widget"'));
  for (const banned of ['rGain', 'bGain', 'rPed', 'bPed', 'masterPed']) assert.equal(roleBlock.includes(`value="${banned}"`), false, banned);
  for (const widget of ['iris', 'gainRb', 'pedRb', 'masterDetail', 'gamma', 'chroma', 'kneePoint']) assert.ok(html.includes(`value="${widget}"`), widget);
  const srcDir = path.join(__dirname, '..', 'streamdeck', 'src');
  const src = fs.readdirSync(srcDir).filter((n) => n.endsWith('.ts')).map((n) => fs.readFileSync(path.join(srcDir, n), 'utf8')).join('\n');
  assert.equal(/cgi-bin|aw_ptz|aw_cam|\/cgi\//.test(src), false);
  assert.match(src, /DECK_PATH|plan\(/);
});

test('manifest icons are PNGs of the M4 mark', () => {
  const png = img.iconPng(40);
  assert.equal(png[0], 137);
  assert.equal(png.slice(1, 4).toString(), 'PNG');
  assert.ok(png.length > 80);
});

test('GET /api/deck/ptz and POST step: the plugin path, with the camera password staying on the server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6deck20-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = new MockPTZ({ model: 'AW-UE150', title: 'CAM-1' }); const port = await m.start(0); t.after(() => m.stop());
  const ctx = await setup({}); t.after(() => ctx.teardown());
  const sm = new SystemManager({ dataDir: dir, engine: ctx.engine, overrides: { ptz: { cameras: [{ id: 'cam1', name: 'Wide', host: '127.0.0.1', port, user: 'admin', pass: SECRET }] } }, autoStart: false });
  const server = createServer(ctx.engine, sm); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeClients && server.closeClients(); server.close(); await sm.close(); });
  const B = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json() }; };
  await sm.drivers.ptz.poll('cam1');
  let snap = await (await fetch(`${B}/api/deck/ptz`)).json();
  assert.equal(snap.plugin, deck.PLUGIN_UUID);
  assert.equal(snap.path, 'C');
  assert.equal(snap.companion, false);
  assert.equal(snap.direct, false);
  assert.equal(snap.cameras[0].id, 'cam1');
  assert.equal(snap.cameras[0].name, 'Wide');
  assert.equal(JSON.stringify(snap).includes(SECRET), false);
  const layout = await (await fetch(`${B}/api/deck/ptz/layout`)).json();
  assert.equal(layout.surface, 'plusxl');
  assert.ok(layout.bannedOnKeys.includes('rGain') && layout.bannedOnKeys.includes('bPed'));
  const ver = await (await fetch(`${B}/api/version`)).json();
  for (const f of ['streamDeck', 'ptzDeck']) assert.ok(ver.features.includes(f), f);
  assert.equal(ver.appVersion, '0.20.2');

  assert.equal((await post('/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'iris', value: 20 })).status, 200);
  const stepped = await post('/api/sys/ptz/cmd/step', { cam: 'cam1', op: 'iris', steps: 5 });
  assert.equal(stepped.status, 200, stepped.json.error);
  assert.equal(stepped.json.value, 25);
  await sm.drivers.ptz.poll('cam1');
  snap = sm.deckSnapshot();
  assert.equal(snap.readouts.iris.text, '25');

  assert.equal((await post('/api/sys/ptz/cmd/op', { cam: 'cam1', op: 'rGain', value: -14 })).status, 200);
  assert.equal((await post('/api/sys/ptz/cmd/lock', { cam: 'cam1', on: true })).status, 200);
  const locked = await post('/api/sys/ptz/cmd/step', { cam: 'cam1', op: 'rGain', steps: 1 });
  assert.equal(locked.status, 423);
  assert.equal((await post('/api/sys/ptz/cmd/lock', { cam: 'cam1', on: false })).status, 200);
  const gain = await post('/api/sys/ptz/cmd/step', { cam: 'cam1', op: 'rGain', steps: 5 });
  assert.equal(gain.status, 200, gain.json.error);
  assert.equal(gain.json.value, -9);

  const rev = sm.rev;
  const pending = fetch(`${B}/api/deck/ptz?since=${rev}&timeout=2000`);
  await post('/api/sys/ptz/cmd/guard', { mode: 'cycle' });
  const polled = await (await pending).json();
  assert.ok(polled.rev > rev);
  assert.equal(polled.liveGuard.mode, 'lock');
});
