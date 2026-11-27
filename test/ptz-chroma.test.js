'use strict';
// Chroma level / phase on Panasonic PTZ. Sources: AW-UE150 / HE145 IF v2.94 (Chroma Level OSD:B0 00h OFF,
// 1Dh..E3h = -99..+99 %; Chroma Phase OSJ:0B 61h..9Fh = -31..+31) and AW-UE160 IF (Mar. 1, 2025): CHROMA LEVEL
// OSD:B0 1Ch = -100 % .. 80h = 0 .. A8h = +40 %, needs CHROMA LEVEL SW OSG:93 ON; no OSJ:0B (no global phase);
// COLOR CORRECTION OSA:85 + 12 PHASE axes OSD:81..97 (01h = -127 .. 80h = 0 .. FEh = +126).
// Also: the browser paint sender (one request in flight per camera + parameter, latest wins, final value sent),
// the driver's latest-wins queue for range writes, and the read-back hold that stops a knob snapping back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PC = require('../lib/drivers/ptz-commands');
const { PTZDriver, OPT_HOLD_MS } = require('../lib/drivers/ptz');
const { MockPTZ } = require('../lib/mocks/ptz');
const { createPaintSender } = require('../public/paint-send');

const cmd = (id, v, model) => PC.build('UE150', id, v, model).cmd;
const tick = () => new Promise((r) => setImmediate(r));

test('chroma level encoding: UE150 table vs AW-UE160 table', () => {
  // UE150 / HE145: -100 is the app's OFF (00h), -99..+99 around 80h
  assert.equal(cmd('chromaLevel', -100, 'AW-UE150'), 'OSD:B0:00');
  assert.equal(cmd('chromaLevel', -99, 'AW-UE150'), 'OSD:B0:1D');
  assert.equal(cmd('chromaLevel', 0, 'AW-UE150'), 'OSD:B0:80');
  assert.equal(cmd('chromaLevel', 99, 'AW-UE150'), 'OSD:B0:E3');
  assert.equal(PC.chromaDec('00'), -100); assert.equal(PC.chromaDec('E3'), 99);
  // AW-UE160: -100 % is a real level (1Ch), the top is +40 % (A8h)
  assert.equal(cmd('chromaLevel', -100, 'AW-UE160'), 'OSD:B0:1C');
  assert.equal(cmd('chromaLevel', 0, 'AW-UE160'), 'OSD:B0:80');
  assert.equal(cmd('chromaLevel', 12, 'AW-UE160'), 'OSD:B0:8C');
  assert.equal(cmd('chromaLevel', 40, 'AW-UE160'), 'OSD:B0:A8');
  assert.throws(() => cmd('chromaLevel', 41, 'AW-UE160'), (e) => e.status === 400);
  assert.equal(PC.ue160ChromaDec('A8'), 40); assert.equal(PC.ue160ChromaDec('1C'), -100); assert.equal(PC.ue160ChromaDec('0x80'), 0);
  // the catalog ranges the UI draws
  const ue150 = PC.catalogFor('UE150', 'AW-UE150').ops.find((o) => o.id === 'chromaLevel');
  const ue160 = PC.catalogFor('UE150', 'AW-UE160').ops.find((o) => o.id === 'chromaLevel');
  assert.deepEqual([ue150.range.min, ue150.range.max, ue150.range.off], [-100, 99, -100]);
  assert.deepEqual([ue160.range.min, ue160.range.max, ue160.range.off], [-100, 40, undefined]);
  // a letter-suffixed UE160 (AW-UE160W / KMC) gets the same table
  assert.equal(cmd('chromaLevel', 40, 'AW-UE160W'), 'OSD:B0:A8');
});

test('chroma phase: OSJ:0B on the UE150 series; the AW-UE160 has per-axis COLOR CORRECTION phase instead', () => {
  assert.equal(cmd('chromaPhase', -31, 'AW-UE150'), 'OSJ:0B:61');
  assert.equal(cmd('chromaPhase', 0, 'AW-UE150'), 'OSJ:0B:80');
  assert.equal(cmd('chromaPhase', 31, 'AW-UE150'), 'OSJ:0B:9F');
  assert.equal(cmd('chromaPhase', 5, ''), 'OSJ:0B:85', 'Auto type (model not known yet) keeps the UE150 table');
  const ids = new Set(PC.catalogFor('UE150', 'AW-UE160').ops.map((o) => o.id));
  assert.ok(!ids.has('chromaPhase'), 'no dead PHASE control on a UE160');
  assert.throws(() => cmd('chromaPhase', 5, 'AW-UE160'), (e) => e.status === 409 && /AW-UE160/.test(e.message));
  for (const id of ['chromaSwitch', 'chromaLevel', 'colorCorrect', 'ccPhaseR', 'ccPhaseYe', 'ccPhaseG', 'ccPhaseCy', 'ccPhaseB', 'ccPhaseMg', 'ccPhaseMgR']) assert.ok(ids.has(id), id);
  assert.equal(cmd('chromaSwitch', true, 'AW-UE160'), 'OSG:93:1');
  assert.equal(cmd('colorCorrect', false, 'AW-UE160'), 'OSA:85:0');
  assert.equal(cmd('ccPhaseB', -127, 'AW-UE160'), 'OSD:97:01');
  assert.equal(cmd('ccPhaseB', 0, 'AW-UE160'), 'OSD:97:80');
  assert.equal(cmd('ccPhaseB', 126, 'AW-UE160'), 'OSD:97:FE');
  assert.equal(cmd('ccPhaseR', 1, 'AW-UE160'), 'OSD:87:81');
  assert.equal(cmd('ccPhaseBMg', 1, 'AW-UE160'), 'OSD:81:81');
  assert.throws(() => cmd('ccPhaseB', 127, 'AW-UE160'), (e) => e.status === 400);
  assert.throws(() => cmd('ccPhaseB', 1, 'AW-UE150'), (e) => e.status === 409, 'UE150 keeps its own command set');
  // order in the CHROMA card: switch, level, then colour correction
  const chroma = PC.catalogFor('UE150', 'AW-UE160').ops.filter((o) => o.group === 'chroma').map((o) => o.id);
  assert.deepEqual(chroma.slice(0, 3), ['chromaSwitch', 'chromaLevel', 'colorCorrect']);
  assert.equal(chroma.length, 15);
  // read-back
  const rb = PC.readback('UE150', { 'OSD:B0': 'A8', 'OSG:93': '1', 'OSA:85': '1', 'OSD:97': '01', 'OSJ:0B': '9F' }, 'AW-UE160');
  assert.deepEqual([rb.chromaLevel, rb.chromaSwitch, rb.colorCorrect, rb.ccPhaseB, rb.chromaPhase], [40, true, true, -127, undefined]);
  assert.equal(PC.UE160_COMMANDS.chromaLevel.query, 'QSD:B0');
  assert.equal(PC.UE160_COMMANDS.chromaPhase, null);
});

function fakeClock() {
  let t = 1000; const timers = [];
  return {
    now: () => t,
    schedule: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    cancel: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) { t += ms; for (const h of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(h), 1); h.fn(); } await tick(); await tick(); },
  };
}

test('paint sender: one request in flight per lane, latest value wins, the final value is always sent', async () => {
  const clk = fakeClock(); const sent = []; let open = 0; let maxOpen = 0; const gates = [];
  const ps = createPaintSender({ intervalMs: 80, now: clk.now, schedule: clk.schedule, cancel: clk.cancel,
    send: (v) => { sent.push(v); open++; maxOpen = Math.max(maxOpen, open); return new Promise((r) => gates.push(() => { open--; r(); })); } });
  for (let v = 1; v <= 30; v++) ps.submit('cam1:chromaLevel', v, {}); // one drag burst
  await tick(); await tick();
  assert.deepEqual(sent, [1], 'first value goes at once');
  assert.ok(ps.busy('cam1:chromaLevel'));
  gates.shift()(); await tick(); await tick();
  assert.deepEqual(sent, [1], 'rate gap: nothing before 80 ms');
  await clk.advance(80);
  assert.deepEqual(sent, [1, 30], 'only the newest pending value is sent');
  ps.submit('cam1:chromaLevel', 31, {}); ps.submit('cam1:chromaLevel', 32, {}, { now: true }); // release while one is in flight
  await tick();
  assert.deepEqual(sent, [1, 30], 'still one in flight');
  gates.shift()(); await tick(); await tick(); await tick();
  assert.deepEqual(sent, [1, 30, 32], 'release value is sent as soon as the lane is free, without the rate gap');
  gates.shift()(); await tick(); await tick();
  assert.equal(maxOpen, 1);
  assert.equal(ps.busy('cam1:chromaLevel'), false);
});

test('paint sender: lanes are independent; ~12.5 Hz while dragging; only the newest refusal is reported', async () => {
  const clk = fakeClock(); const sent = []; const errs = [];
  const ps = createPaintSender({ intervalMs: 80, now: clk.now, schedule: clk.schedule, cancel: clk.cancel, onError: (e, v, ctx, key) => errs.push([key, v]),
    send: (v, ctx, key) => { sent.push([key, v]); return v === 50 ? Promise.reject(new Error('ER3')) : Promise.resolve(); } });
  ps.submit('cam1:chromaLevel', 5, {}); ps.submit('cam2:chromaLevel', 6, {}); ps.submit('cam1:chromaPhase', 7, {});
  await tick(); await tick();
  assert.equal(sent.length, 3, 'a different camera or parameter does not wait');
  // a 1 s drag that moves every 10 ms: at most 1000 / 80 + 1 sends
  sent.length = 0;
  for (let i = 0; i < 100; i++) { ps.submit('cam1:rGain', i, {}); await clk.advance(10); }
  await clk.advance(200);
  assert.ok(sent.length <= 14 && sent.length >= 10, `sent ${sent.length}`);
  assert.deepEqual(sent[sent.length - 1], ['cam1:rGain', 99], 'the last value lands');
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i][1] > sent[i - 1][1], 'in order');
  ps.submit('cam1:bGain', 50, {}, { now: true }); await tick(); await tick(); await tick();
  assert.deepEqual(errs, [['cam1:bGain', 50]]);
});

test('driver: a burst of range writes collapses to the newest value; read-back holds the written value', async () => {
  const m = new MockPTZ({ model: 'AW-UE160', title: 'UE160' });
  const d = new PTZDriver({ cameras: [{ id: 'cam1', name: 'UE160', host: '127.0.0.1', port: await m.start(0), model: 'AW-UE160' }] });
  try {
    await d.connect();
    const before = m.calls('OSD:B0').length;
    const all = []; for (let v = -10; v <= 40; v++) all.push(d.op('cam1', 'chromaLevel', v));
    const res = await Promise.all(all);
    const writes = m.calls('OSD:B0').slice(before);
    assert.ok(writes.length <= 3, `51 drag steps became ${writes.length} camera writes`);
    assert.equal(writes[writes.length - 1].cmd, 'OSD:B0:A8', 'the camera ends on the last value');
    assert.equal(res[res.length - 1].value, 40);
    const c = d.cam('cam1');
    assert.equal(d.values(c).chromaLevel, 40);
    // a camdata read that lags the write must not snap the value back inside the hold window
    c.st.raw['OSD:B0'] = '80'; c.st.polledAt = Date.now() + 1;
    assert.equal(d.values(c).chromaLevel, 40);
    c.st.opt.chromaLevel.at = Date.now() - OPT_HOLD_MS - 10;
    assert.equal(d.values(c).chromaLevel, 0, 'after the hold the camera read-back wins again');
    // CHROMA LEVEL SW OFF: the camera refuses the level and the optimistic value is dropped
    await d.op('cam1', 'chromaSwitch', false);
    await assert.rejects(d.op('cam1', 'chromaLevel', 10), (e) => e.status === 409 && /ER3/.test(e.message));
    assert.equal(c.st.opt.chromaLevel, undefined);
    await d.op('cam1', 'chromaSwitch', true);
    assert.equal((await d.op('cam1', 'chromaLevel', 10)).cmd, 'OSD:B0:8A');
    // phase: refused until COLOR CORRECT is ON, then sent
    await assert.rejects(d.op('cam1', 'ccPhaseR', 3), (e) => e.status === 409);
    await d.op('cam1', 'colorCorrect', true);
    assert.equal((await d.op('cam1', 'ccPhaseR', 3)).cmd, 'OSD:87:83');
    await assert.rejects(d.op('cam1', 'chromaPhase', 3), (e) => e.status === 409);
    assert.equal(m.calls('OSJ:0B').length, 0, 'OSJ:0B is never sent to a UE160');
  } finally { d.close && d.close(); await m.stop(); }
});

test('UE150 cameras keep chroma phase OSJ:0B and the -99..+99 chroma range', async () => {
  const m = new MockPTZ({ model: 'AW-UE150', title: 'UE150' });
  const d = new PTZDriver({ cameras: [{ id: 'cam1', name: 'UE150', host: '127.0.0.1', port: await m.start(0) }] });
  try {
    await d.connect();
    assert.equal((await d.op('cam1', 'chromaPhase', -31)).cmd, 'OSJ:0B:61');
    assert.equal((await d.op('cam1', 'chromaLevel', 99)).cmd, 'OSD:B0:E3');
    assert.equal((await d.op('cam1', 'chromaLevel', -100)).cmd, 'OSD:B0:00');
    const ids = new Set(d.catalog('cam1').ops.map((o) => o.id));
    assert.ok(ids.has('chromaPhase') && !ids.has('ccPhaseR') && !ids.has('chromaSwitch'));
  } finally { d.close && d.close(); await m.stop(); }
});

test('Stream Deck: chroma phase and chroma level stay first-class widgets; matrix knobs live on COLOUR', () => {
  const deck = require('../lib/deck');
  const { GALLERY } = require('../lib/decks/gallery');
  const colour = GALLERY.find((g) => g.id === 'ptz-rcp-colour');
  const byLabel = Object.fromEntries(colour.dials.map((x) => [x.label, x.widget]));
  assert.equal(byLabel['R-G'], 'matrixRG');
  assert.equal(deck.WIDGETS.chroma.op, 'chromaLevel');
  assert.equal(deck.WIDGETS.chromaPhase.op, 'chromaPhase');
  const ue150 = PC.catalogFor('UE150', 'AW-UE150').ops.find((o) => o.id === 'chromaLevel');
  const ue160 = PC.catalogFor('UE150', 'AW-UE160').ops.find((o) => o.id === 'chromaLevel');
  assert.equal(deck.formatValue('chromaLevel', -100, ue150), 'OFF');
  assert.equal(deck.formatValue('chromaLevel', -100, ue160), '-100%');
  assert.equal(deck.formatValue('chromaLevel', 40, ue160), '+40%');
  assert.equal(deck.nextValue(ue160, 40, 5), 40, 'a dial stops at +40 on a UE160');
  const html = fs.readFileSync(path.join(__dirname, '../streamdeck/com.performancevideo.control.sdPlugin/ui/settings.html'), 'utf8');
  assert.match(html, /value="chromaPhase"/);
});

test('CAMERA CONTROL UI: paint writes go through paint-send.js; the catalog cache is per camera type', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../public/ptz.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="/paint-send.js"') > 0 && html.indexOf('<script src="/paint-send.js"') < html.indexOf('<script src="/ptz.js"'), 'paint-send.js loads before ptz.js');
  assert.match(ui, /CCPaintSend\.createPaintSender/);
  assert.doesNotMatch(ui, /const pend = \{\}/, 'the old fire-and-forget timer is gone');
  assert.match(ui, /cats\.get\(catKey\(c\)\)/, 'a UE150 and a UE160 do not share one catalog');
  assert.match(ui, /cameraType \|\| c\.model/);
  assert.match(ui, /'chromaSwitch', 'chromaLevel', 'chromaPhase'/);
  assert.match(ui, /ccPhaseR/);
});

test('camera type lists: AW-UE160 is offered by Control Center and by Scopes', () => {
  const ids = PC.modelList().map((m) => m.id);
  assert.ok(ids.includes('AW-UE160') && ids.includes('AW-UE163') && ids.includes('AW-UE150'));
  const Cameras = require('../apps/scopes/lib/cameras');
  const choices = Cameras.modelChoices().map((m) => m.id);
  assert.ok(choices.includes('AW-UE160'));
  assert.equal(choices[0], '');
  assert.equal(Cameras.seriesOf('AW-UE160'), 'UE150');
  const sj = fs.readFileSync(path.join(__dirname, '../apps/scopes/public/scopes.js'), 'utf8');
  assert.match(sj, /data-f="model"/);
  assert.match(sj, /set\.models/);
});
