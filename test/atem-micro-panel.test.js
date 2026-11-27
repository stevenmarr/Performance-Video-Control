'use strict';
// ATEM Micro Panel driven by Control Center (lib/surfaces/bmd-panel). No test opens real HID: the panel is
// the pretend one in mock-hid.js, the switcher is MockAtem as a 2 M/E Constellation HD.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/surfaces/bmd-panel/protocol');
const { PanelDevice } = require('../lib/surfaces/bmd-panel/device');
const { MockPanel, mockHid } = require('../lib/surfaces/bmd-panel/mock-hid');
const { PanelScanner } = require('../lib/surfaces/bmd-panel/scanner');
const { PanelHost } = require('../lib/surfaces/bmd-panel/host');
const { AtemPanelEmulation } = require('../lib/surfaces/bmd-panel/emulation');
const { AtemPanelService } = require('../lib/surfaces/bmd-panel/service');
const { MockAtem } = require('../lib/mocks/atem');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');

const until = async (fn, ms = 3000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); } };

// ---------- protocol ----------
test('panel protocol: 50 keys, codes 1..50, lamp bits at 13 + 3 x code, clear of the 16-segment T-bar meter', () => {
  assert.equal(P.KEYS.length, 50);
  assert.deepEqual(P.KEYS.map((k) => k.code).sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1));
  const bits = new Set();
  for (const k of P.KEYS) {
    assert.equal(k.ledBit, 13 + 3 * k.code);
    for (let i = 0; i < 3; i++) { assert.ok(!bits.has(k.ledBit + i), `${k.id} overlaps`); bits.add(k.ledBit + i); }
    assert.ok(k.ledBit >= P.TBAR_SEGMENTS, 'clear of the meter');
    assert.ok(1 + ((k.ledBit + 2) >> 3) < P.LED_REPORT_LEN, 'fits the 32-byte report');
  }
  // spot checks against node-blackmagic-controller's definitions.ts
  assert.deepEqual(['macro', 'transition-mix', 'auto', 'dsk2-auto'].map((id) => P.BY_ID.get(id).ledBit), [16, 130, 145, 163]);
  assert.equal(P.BY_ID.get('shift').code, 0x26); assert.equal(P.BY_ID.get('preview-transition').code, 0x2a);
  assert.equal(P.labelOf('dsk1-tie'), 'DSK 1 TIE'); assert.equal(P.labelOf('preview7'), 'PVW 7');
});

test('panel protocol: handshake answer matches node-blackmagic-controller bit for bit', () => {
  // vectors computed with packages/core/src/authenticate.ts (bmd_kbd_auth) under Node 24
  const v = [['0000000000000000', '3ae1206f97c10bc8'], ['0000000000000001', '2b9ab32bebf244c6'], ['0123456789abcdef', 'e5c7b689e9967608'], ['fedcba9876543210', 'c4a7da4761c769e8'],
    ['deadbeefcafef00d', '6a04b6fcff2b4b21'], ['0000000000000007', '751bf623f42e0ade'], ['8000000000000000', 'ba61206f97c10bc8'], ['1122334455667788', 'abd3311ac6f61e30']];
  for (const [c, r] of v) assert.equal(P.authResponse(BigInt(`0x${c}`)).toString(16).padStart(16, '0'), r, c);
  assert.deepEqual([...P.authPacket(3, 0x0102n)], [5, 3, 2, 1, 0, 0, 0, 0, 0, 0]);
});

test('panel protocol: lamp report and input reports', () => {
  const b = P.encodeLeds({ keys: { macro: 'red', 'dsk2-auto': 'white', program1: 'green' }, tbar: [true, false, true] });
  assert.equal(b.length, 32); assert.equal(b[0], 2);
  assert.equal(b[1], 0b101, 'meter segments 0 and 2'); assert.equal(b[3], 1, 'MACRO red = bit 16');
  const d = P.decodeLeds(b);
  assert.equal(d.keys.macro, 'red'); assert.equal(d.keys['dsk2-auto'], 'white'); assert.equal(d.keys.program1, 'green'); assert.equal(d.keys.cut, 'off');
  assert.deepEqual(d.tbar.slice(0, 4), [true, false, true, false]);
  const keys = Buffer.from([3, 0x2b, 0, 0x26, 0, 0, 0, 0x01, 0]);
  assert.deepEqual(P.decodeInput(keys), { type: 'keys', held: ['cut', 'shift'] }, 'stops at the first 0');
  assert.deepEqual(P.decodeInput(Buffer.from([8, 0x00, 0x08])), { type: 'tbar', raw: 2048, value: 0.5 });
  assert.deepEqual(P.decodeInput(Buffer.from([6, 0, 77])), { type: 'battery', percent: 77 });
  assert.equal(P.decodeInput(Buffer.from([9, 1, 2])), null);
  assert.deepEqual(P.diffHeld(['cut'], ['shift']), { down: ['shift'], up: ['cut'] });
});

// ---------- device ----------
test('panel device: answers the challenge, reports keys and the T-bar, renews at half the lease, refuses a bad panel', async () => {
  const panel = new MockPanel({ lease: 300 });
  const timers = { pending: [], setTimeout(fn, ms) { const t = { fn, ms }; this.pending.push(t); return t; }, clearTimeout(t) { timers.pending = timers.pending.filter((x) => x !== t); } };
  const dev = new PanelDevice(panel, { timers });
  assert.deepEqual(await dev.open(), { lease: 300 });
  assert.equal(panel.auths, 1);
  assert.equal(timers.pending.length, 1); assert.equal(timers.pending[0].ms, 150000, 'renew at half of 300 s');
  const ev = []; dev.on('down', (k) => ev.push(`+${k}`)); dev.on('up', (k) => ev.push(`-${k}`)); dev.on('tbar', (v) => ev.push(`t${v}`));
  panel.press('shift'); panel.press('preview3'); panel.release('shift'); panel.tbar(0.25); panel.tbar(0.25);
  assert.deepEqual(ev, ['+shift', '+preview3', '-shift', 't0.25'], 'a repeated T-bar value is not re-sent');
  const t = timers.pending.shift(); t.fn(); await until(() => panel.auths === 2, 1000, 'renewal');
  assert.equal(await dev.setLeds({ keys: { cut: 'white' } }), true); assert.equal(await dev.setLeds({ keys: { cut: 'white' } }), false, 'same frame not re-sent');
  assert.equal(panel.lastLeds().keys.cut, 'white');
  let closed = false; dev.on('close', () => { closed = true; }); dev.on('error', () => {});
  panel.unplug(); await until(() => closed, 1000, 'close on unplug');
  await assert.rejects(new PanelDevice(new MockPanel({ refuse: true })).open(), /refused the handshake/);
});

test('panel scanner: finds the panel among other HID devices, reopens it after an unplug', async () => {
  const panel = new MockPanel();
  const hid = mockHid([panel]); const listed = hid.devicesAsync;
  hid.devicesAsync = async () => [{ vendorId: 0x0fd9, productId: 0x0080, path: 'streamdeck' }, ...(await listed())];
  const st = []; const keys = [];
  const sc = new PanelScanner({ hid, scanMs: 20, retryMs: 50, send: (m) => { if (m.event === 'status') st.push(m.state); if (m.event === 'down') keys.push(m.key); } });
  sc.start();
  await until(() => st.includes('connected'), 2000, 'connected');
  panel.tap('cut'); assert.deepEqual(keys, ['cut']);
  panel.gone = true; panel.unplug();
  await until(() => st[st.length - 1] === 'searching', 2000, 'searching after unplug');
  panel.gone = false;
  await until(() => st.filter((s) => s === 'connected').length === 2, 2000, 'reconnected');
  assert.equal(panel.opened, 2);
  await sc.stop(); assert.equal(st[st.length - 1], 'off');
  const none = new PanelScanner({ hid: null, send: (m) => st.push(m.state) }); none.start(); assert.equal(st[st.length - 1], 'no-hid');
});

// ---------- emulation (pure) ----------
function fakeView({ mes = 2, keys = 4 } = {}) {
  const bus = [0, ...Array.from({ length: 20 }, (_, i) => i + 1), 1000, 3010, 3020, 6000, 6001].map((id) => ({ id }));
  return {
    topology: { mixEffects: mes },
    inputs: bus.map((b) => ({ id: b.id })),
    mes: Array.from({ length: mes }, (_, i) => ({ index: i, bus, program: 1, preview: 2, style: 'MIX', nextStyle: 'MIX', nextSelection: 1, inTransition: false, handle: 0, previewTransition: false, ftb: { black: false, inTransition: false },
      keyers: Array.from({ length: keys }, (_, k) => ({ index: k, onAir: false })) })),
    dsk: [{ index: 0, onAir: false, tie: false, inTransition: false }, { index: 1, onAir: false, tie: false, inTransition: false }],
    macros: [{ index: 0, isUsed: true }, { index: 11, isUsed: true }],
    macroRun: { isRunning: false, isWaiting: false, macroIndex: 65535 },
  };
}
const refused = (r) => r.events.filter((e) => e.kind === 'refused').pop();
function rig(opts = {}) {
  const v = fakeView(opts); let t = 1000; const sent = []; const events = []; let locked = false;
  const emu = new AtemPanelEmulation({ view: () => ({ connected: true, view: v }), dispatch: (op, body) => { sent.push([op, body]); return opts.fail && opts.fail(op, body) ? Promise.reject(new Error('nope')) : Promise.resolve({ ok: true }); },
    now: () => t, locked: () => locked, onEvent: (e) => events.push(e), settings: opts.settings || {}, timers: { setTimeout: (fn) => ({ fn }), clearTimeout() {} } });
  const tap = (k) => { emu.down(k); emu.up(k); };
  return { v, emu, sent, events, tap, tick: (ms) => { t += ms; }, lock: (x) => { locked = x; } };
}

test('panel map: program hot-cuts, preview selects, SHIFT and double-press give 11-20, shifted tally blinks', () => {
  const r = rig();
  r.tap('program3'); r.tap('preview4');
  r.emu.down('shift'); r.tap('preview2'); r.tap('program5'); r.emu.up('shift');
  r.tick(1000); r.tap('preview6'); r.tick(100); r.tap('preview6');
  assert.deepEqual(r.sent, [['program', { me: 1, source: 3 }], ['preview', { me: 1, source: 4 }], ['preview', { me: 1, source: 12 }], ['program', { me: 1, source: 15 }], ['preview', { me: 1, source: 6 }], ['preview', { me: 1, source: 16 }]]);
  r.tick(1000); r.tap('program6'); r.tick(100); r.tap('program6');
  assert.deepEqual(r.sent.slice(-2), [['program', { me: 1, source: 6 }], ['program', { me: 1, source: 6 }]], 'no double-press shift on PROGRAM (Blackmagic)');
  r.v.mes[0].program = 13; r.v.mes[0].preview = 2;
  let f = r.emu.frame(true);
  assert.equal(f.keys.program3, 'red', 'shifted source on air: its unshifted key blinks'); assert.equal(r.emu.frame(false).keys.program3, 'off');
  assert.equal(f.keys.preview2, 'green'); assert.equal(f.keys.program1, 'white', 'unlit keys glow white');
  r.emu.down('shift'); f = r.emu.frame(false); assert.equal(f.keys.program3, 'red', 'SHIFT held: the 11-20 page, solid'); assert.equal(f.keys.preview2, 'white', 'shifted page: PVW 2 is source 12, not on preview'); assert.equal(f.keys.shift, 'yellow'); r.emu.up('shift');
});

test('panel map: MACRO held turns the PROGRAM row into macros (blue, green while running, press again stops)', () => {
  const r = rig();
  r.emu.down('macro');
  assert.equal(r.emu.frame().keys.program4, 'blue');
  r.tap('program1');
  r.emu.down('shift'); r.tap('program2'); r.emu.up('shift');
  r.tap('program3');
  r.v.macroRun = { isRunning: true, isWaiting: false, macroIndex: 0 };
  assert.equal(r.emu.frame().keys.program1, 'green'); assert.equal(r.emu.frame().keys.macro, 'yellow');
  r.tap('program1');
  r.v.macroRun = { isRunning: true, isWaiting: true, macroIndex: 0 }; r.tap('program1');
  r.emu.up('macro'); r.tick(1000); // the refused-press flash on PGM 3 is over
  assert.equal(r.emu.frame(true).keys.macro, 'green'); assert.equal(r.emu.frame(false).keys.macro, 'off', 'waiting: MACRO blinks');
  assert.deepEqual(r.sent.map((s) => s[0] + (s[1].macro !== undefined ? s[1].macro : '')), ['macroRun0', 'macroRun11', 'macroStop', 'macroContinue']);
  assert.ok(r.events.some((e) => e.kind === 'refused' && /macro 3 is empty/.test(e.reason)));
  assert.equal(r.emu.frame(true).keys.program3, 'white', 'macro mode ends with MACRO released; unlit keys glow white');
});

test('panel map: next transition (single press, chord, double BKGD), key on air, styles, PREV TRANS, CUT / AUTO, DSK', () => {
  const r = rig();
  r.tap('next-key2');
  r.emu.down('next-background'); r.emu.down('next-key1'); r.emu.up('next-key1'); r.emu.up('next-background');
  r.v.mes[0].keyers[2].onAir = true; r.tick(1000); r.tap('next-background'); r.tick(50); r.tap('next-background');
  r.tap('key1-on'); r.v.mes[0].keyers[0].onAir = true; r.tap('key1-on');
  r.tap('transition-wipe'); r.tap('preview-transition'); r.tap('cut'); r.tap('auto');
  r.tap('dsk1-tie'); r.tap('dsk2-cut'); r.tap('dsk1-auto');
  const short = r.sent.map(([op, b]) => `${op}:${b.selection ?? b.key ?? b.style ?? (b.on !== undefined ? b.on : '')}${b.on !== undefined && b.key !== undefined ? `/${b.on}` : ''}`);
  assert.deepEqual(short, ['nextSelection:4', 'nextSelection:1', 'nextSelection:3', 'nextSelection:1', 'nextSelection:9', 'uskOnAir:0/true', 'uskOnAir:0/false', 'style:WIPE', 'previewTransition:true', 'cut:', 'auto:', 'dskTie:0/true', 'dskOnAir:1/true', 'dskAuto:0']);
  Object.assign(r.v.mes[0], { nextSelection: 0b101, nextStyle: 'DVE', inTransition: true, handle: 5000, previewTransition: true }); r.v.dsk[1].onAir = true; r.v.dsk[0].tie = true;
  const f = r.emu.frame(true).keys;
  assert.equal(f['next-background'], 'yellow'); assert.equal(f['next-key2'], 'yellow'); assert.equal(f['next-key1'], 'white');
  assert.equal(f['key1-on'], 'red'); assert.equal(f['transition-dve'], 'yellow'); assert.equal(f['transition-mix'], 'white'); assert.equal(f['preview-transition'], 'yellow');
  assert.equal(f.auto, 'red'); assert.equal(f.cut, 'white'); assert.equal(f['dsk2-cut'], 'red'); assert.equal(f['dsk1-tie'], 'yellow'); assert.equal(f['dsk1-auto'], 'white');
});

test('panel map: M/E keys pick the M/E (only those the switcher has), refused presses flash red and say why, LOCK', () => {
  const r = rig({ fail: (op) => op === 'style' });
  assert.equal(r.emu.frame().keys.mixeffect1, 'yellow'); assert.equal(r.emu.frame().keys.mixeffect2, 'white'); assert.equal(r.emu.frame().keys.mixeffect3, 'off');
  r.tap('mixeffect2'); r.tap('program7'); assert.deepEqual(r.sent.pop(), ['program', { me: 2, source: 7 }]);
  r.tap('mixeffect3'); assert.equal(r.emu.me, 2); assert.match(r.events.filter((e) => e.kind === 'refused').pop().reason, /has 2 M\/Es/);
  r.tap('transition-dve');
  return new Promise((res) => setImmediate(res)).then(() => {
    assert.equal(r.emu.frame(true).keys['transition-dve'], 'red'); assert.equal(r.emu.frame(false).keys['transition-dve'], 'off');
    r.tick(1000); assert.equal(r.emu.frame(true).keys['transition-dve'], 'white', 'flash ends, unlit style key glows white');
    r.lock('locked'); const n = r.sent.length; r.tap('cut'); r.tap('mixeffect1'); assert.equal(r.sent.length, n, 'locked: nothing sent'); assert.equal(r.emu.me, 1, 'M/E select is local, still works');
    r.emu.setSettings({ programRow: 'off' }); r.lock(false); r.tap('program1'); assert.equal(r.sent.length, n); assert.match(refused(r).reason, /tally only/);
    r.emu.setSettings({ overrides: { 'transition-arm': { op: 'macroRun', args: { macro: 0 } }, 'dsk2-auto': { none: true } } });
    r.tap('transition-arm'); assert.deepEqual(r.sent.pop(), ['macroRun', { me: 1, macro: 0 }]);
    r.tap('dsk2-auto'); assert.equal(r.sent.length, n, 'a key turned off in the map sends nothing');
  });
});

test('panel map: buttons 1-20 are mappable (Black, Bars, media players, SuperSource); default is inputs 1-20', () => {
  const r = rig();
  r.tap('program1'); assert.deepEqual(r.sent.pop(), ['program', { me: 1, source: 1 }]);
  r.emu.setSettings({ sources: [0, 1000, 3010, 6000, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] });
  r.tap('program1'); r.tap('program2'); r.tap('program3'); r.tap('program4');
  assert.deepEqual(r.sent.slice(-4), [
    ['program', { me: 1, source: 0 }],
    ['program', { me: 1, source: 1000 }],
    ['program', { me: 1, source: 3010 }],
    ['program', { me: 1, source: 6000 }],
  ]);
  r.v.mes[0].program = 0;
  assert.equal(r.emu.frame().keys.program1, 'red', 'mapped Black on air');
  assert.equal(r.emu.frame().keys.program2, 'white');
});

test('panel map: ARM gangs CUT, AUTO and the T-bar on every M/E; a refusal names the M/E; ARM blinks while armed', () => {
  const r = rig({ fail: (op, body) => op === 'auto' && body.me === 2 });
  assert.equal(r.emu.frame().keys['transition-arm'], 'white', 'ARM idle is white');
  r.tap('transition-arm');
  assert.equal(r.emu.armed, true);
  assert.equal(r.emu.frame(true).keys['transition-arm'], 'red');
  assert.equal(r.emu.frame(false).keys['transition-arm'], 'off', 'ARM blinks while armed');
  r.tap('cut');
  assert.deepEqual(r.sent.filter((s) => s[0] === 'cut'), [['cut', { me: 1 }], ['cut', { me: 2 }]]);
  r.tap('auto');
  return new Promise((res) => setImmediate(res)).then(() => {
    assert.ok(r.sent.some((s) => s[0] === 'auto' && s[1].me === 1));
    assert.ok(r.sent.some((s) => s[0] === 'auto' && s[1].me === 2));
    assert.match(refused(r).reason, /M\/E 2:/);
    r.emu.tbar(0); r.tick(20); r.emu.tbar(0.5);
    const pos = r.sent.filter((s) => s[0] === 'transitionPosition');
    assert.deepEqual(pos.map((s) => s[1].me).sort((a, b) => a - b), [1, 2], 'T-bar handle sent to every M/E');
    assert.ok(pos.every((s) => s[1].handle === 5000));
    r.tap('transition-arm');
    assert.equal(r.emu.armed, false);
    const n = r.sent.length;
    r.tap('cut');
    assert.deepEqual(r.sent.slice(n), [['cut', { me: 1 }]], 'ARM released: only the selected M/E');
    r.lock('locked'); r.tap('transition-arm');
    assert.equal(r.emu.armed, false, 'CONSOLE LOCK leaves ARM alone and refuses the press');
    assert.match(refused(r).reason, /LOCK|locked/i);
  });
});

test('panel map: the T-bar runs a stroke to 10000, flips for the next stroke, picks up only from an end, meter shows progress', () => {
  const r = rig();
  r.emu.tbar(0); r.emu.tbar(0.5); r.tick(20); r.emu.tbar(1);
  assert.deepEqual(r.sent.map((s) => s[1].handle), [5000, 10000], 'end of travel completes');
  r.tick(20); r.emu.tbar(0.6); r.tick(20); r.emu.tbar(0);
  assert.deepEqual(r.sent.slice(2).map((s) => s[1].handle), [4000, 10000], 'second stroke runs back down');
  r.v.mes[0].inTransition = true; r.v.mes[0].handle = 5000;
  assert.equal(r.emu.frame().tbar.filter(Boolean).length, 8, 'half way = 8 of 16');
  // a partial stroke, then AUTO finishes it elsewhere: the bar is dropped until parked
  r.emu.tbar(0.3); r.tick(500); r.v.mes[0].inTransition = false; r.v.mes[0].handle = 0; r.emu.sync();
  assert.equal(r.emu.tb.engaged, false); assert.equal(r.emu.frame(true).tbar.every(Boolean), true, 'meter blinks to ask for a park');
  const n = r.sent.length; r.emu.tbar(0.5); assert.equal(r.sent.length, n, 'ignored while not picked up');
  r.emu.tbar(0); assert.equal(r.emu.tb.engaged, true);
  r.emu.tbar(0.5); r.tick(20); r.emu.tbar(1); assert.deepEqual(r.sent.slice(n).map((s) => s[1].handle), [5000, 10000], 'the parked end became the start');
  r.emu.tbar(0.5); r.emu.down('mixeffect2'); assert.equal(r.emu.tb.engaged, false, 'M/E change mid-bar drops the bar');
});

// ---------- the whole chain: panel -> Control Center -> 2 M/E Constellation HD (mock) ----------
async function liveRig({ deskSelection = null } = {}) {
  const ctx = await setup({});
  const m = new MockAtem('chd2me'); m.speed = 20; const port = await m.start(0);
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides: { atem: { host: '127.0.0.1', port, me: 1 } }, autoStart: false });
  await systems.driver('atem').connect();
  const panel = new MockPanel();
  const host = new PanelHost({ inProcess: { hid: mockHid([panel]) } });
  const svc = new AtemPanelService({ systems, dataDir: ctx.dataDir, host, deskSelection, env: {}, blinkMs: 40 });
  return { ctx, m, systems, panel, host, svc, view: () => systems.driver('atem').view(), stop: async () => { try { await svc.stop(); systems.close(); } finally { await m.stop(); await ctx.teardown(); } } };
}

test('panel + Control Center + mock 2 M/E Constellation HD: presses switch the M/E the panel drives, lamps follow the switcher', async () => {
  const L = await liveRig();
  try {
    L.svc.start();
    assert.equal(L.svc.status().state, 'off', 'off until enabled');
    await L.svc.configure({ enabled: true });
    await until(() => L.svc.status().state === 'connected', 3000, 'panel connected');
    assert.equal(JSON.parse(fs.readFileSync(path.join(L.ctx.dataDir, 'atem-panel.json'), 'utf8')).enabled, true, 'saved per install');
    L.panel.tap('preview5'); await until(() => L.view().mes[0].preview === 5, 2000, 'preview 5');
    L.panel.tap('cut'); await until(() => L.view().mes[0].program === 5, 2000, 'cut');
    await until(() => (L.panel.lastLeds() || { keys: {} }).keys.program5 === 'red', 2000, 'PGM 5 lamp red');
    L.panel.tap('mixeffect2'); L.panel.tap('program4');
    await until(() => L.view().mes[1].program === 4, 2000, 'M/E 2 program 4');
    assert.notEqual(L.view().mes[0].program, 4, 'M/E 1 untouched');
    await until(() => L.panel.lastLeds().keys.mixeffect2 === 'yellow' && L.panel.lastLeds().keys.program4 === 'red', 2000, 'M/E 2 lamps');
    // T-bar: one full throw completes the transition on the switcher (handle 10000), program and preview swap
    const before = L.view().mes[1];
    L.panel.tbar(0); for (const x of [0.2, 0.5, 0.8]) { L.panel.tbar(x); await new Promise((r) => setTimeout(r, 25)); }
    await until(() => L.view().mes[1].inTransition && L.view().mes[1].handle >= 7000, 2000, 'mid stroke');
    L.panel.tbar(1);
    await until(() => !L.view().mes[1].inTransition && L.view().mes[1].program === before.preview, 2000, 'stroke done');
    assert.equal(L.view().mes[1].preview, before.program); assert.equal(L.view().mes[1].handle, 0);
    L.panel.tap('preview-transition'); await until(() => L.view().mes[1].previewTransition === true, 2000, 'PREV TRANS on');
    L.panel.tap('dsk1-cut'); await until(() => L.view().dsk[0].onAir === true, 2000, 'DSK 1 on air');
    await until(() => L.panel.lastLeds().keys['dsk1-cut'] === 'red', 2000, 'DSK 1 CUT lamp');
    // LOCK on the Control Center panel: presses refused and logged
    const os0 = L.systems.os; L.systems.os = Object.assign(Object.create(os0), { panel: { locked: true } });
    try { L.panel.tap('cut'); await until(() => L.svc.status().events.some((e) => e.kind === 'refused' && /LOCK/.test(e.reason)), 1000, 'refused when locked'); } finally { L.systems.os = os0; }
    const st = L.svc.status(); assert.equal(st.me, 2); assert.equal(st.mes, 2); assert.equal(st.controls.length, 50); assert.equal(st.device.serial, 'MOCK0001');
    await L.svc.configure({ enabled: false });
    assert.equal(L.svc.status().state, 'off'); assert.equal(L.panel.closed, true, 'disabling lets go of the panel');
  } finally { await L.stop(); }
});

test('panel service: selected M/E and ARM follow the shared desk selection, and the desk follows the panel', async () => {
  const { DeskSelection } = require('../lib/surfaces/desk-selection');
  const desk = new DeskSelection();
  const L = await liveRig({ deskSelection: desk });
  try {
    await L.svc.configure({ enabled: true }); L.svc.start();
    await until(() => L.svc.status().state === 'connected', 3000, 'panel connected');
    desk.set({ me: 2, source: 'deck' });
    await until(() => L.svc.status().me === 2, 1000, 'panel followed the Stream Deck M/E');
    desk.set({ armed: true, source: 'deck' });
    await until(() => L.svc.status().armed === true, 1000, 'panel followed ARM');
    assert.equal(L.panel.lastLeds().keys['transition-arm'] === 'red' || L.panel.lastLeds().keys['transition-arm'] === 'off', true, 'ARM blinks');
    L.panel.tap('mixeffect1');
    await until(() => desk.me === 1, 1000, 'desk followed the panel M/E');
    L.panel.tap('transition-arm'); // already armed from the desk: this releases
    await until(() => desk.armed === false, 1000, 'ARM released on the desk');
    L.panel.tap('transition-arm');
    await until(() => desk.armed === true, 1000, 'ARM set from the panel');
    const me2Before = L.view().mes[1].program;
    const me2Preview = L.view().mes[1].preview;
    L.panel.tap('preview6'); await until(() => L.view().mes[0].preview === 6, 2000, 'preview 6 on selected M/E only');
    assert.notEqual(L.view().mes[1].preview, 6, 'PREVIEW stays on the selected M/E while ARM is on');
    L.panel.tap('cut');
    await until(() => L.view().mes[0].program === 6 && L.view().mes[1].program === me2Preview, 2000, 'armed CUT hits every M/E');
    assert.equal(L.view().mes[0].program, 6);
    assert.equal(L.view().mes[1].program, me2Preview, 'M/E 2 cut its own preview');
    assert.notEqual(me2Before, me2Preview);
  } finally { await L.stop(); }
});

test('Stream Deck sessions follow the shared desk selection (M/E and ARM)', () => {
  const { DeskSelection } = require('../lib/surfaces/desk-selection');
  const { DeckService } = require('../lib/decks/service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-me-'));
  try {
    const desk = new DeskSelection();
    const systems = {
      getState: () => ({ armed: ['atem'], instances: [{ id: 'atem', type: 'atem' }], systems: {} }),
      driver: () => ({ view: () => ({ mes: [{}, {}] }), status: () => ({ connected: true }) }),
    };
    const decks = new DeckService({ dataDir: dir, systems, usbEnv: { CC_DECK_USB: '0' }, deskSelection: desk });
    decks.sessions.set('xl', { system: 'atem', page: 0, out: null, atemUi: { me: 1, flexBank: 0, shift: 0, mes: [1] } });
    desk.set({ me: 2, armed: true, source: 'panel' });
    const ui = decks.sessions.get('xl').atemUi;
    assert.equal(ui.me, 2);
    assert.deepEqual(ui.mes, [1, 2], 'ARM on the panel gangs the Stream Deck MES list');
    desk.set({ armed: false, source: 'panel' });
    assert.deepEqual(decks.sessions.get('xl').atemUi.mes, [2]);
    decks.sessions.get('xl').atemUi = { ...decks.sessions.get('xl').atemUi, me: 1, mes: [1, 2] };
    decks.pushDeskFromUi(decks.sessions.get('xl').atemUi, 'deck');
    assert.equal(desk.me, 1);
    assert.equal(desk.armed, true, 'MES on the Stream Deck lights ARM on the panel');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/api/surfaces/atem-panel: status, settings with validation, M/E select', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  try {
    const st = (await call('GET', '/api/surfaces/atem-panel')).json;
    assert.equal(st.enabled, false); assert.equal(st.state, 'off'); assert.equal(st.instance, 'atem'); assert.equal(st.controls.length, 50);
    const set = (await call('POST', '/api/surfaces/atem-panel', { arm: 'shift-ftb', programRow: 'off', sources: [0, 1000, 3010, 6000], tbarInvert: true, me: 9, idle: 'blue', bogus: 1 })).json;
    assert.equal(set.settings.arm, undefined, 'FTB-on-ARM options are gone'); assert.equal(set.settings.programRow, 'off'); assert.equal(set.settings.tbarInvert, true); assert.equal(set.settings.me, 4, 'M/E clamped to 1..4');
    assert.equal(set.settings.idle, 'blue');
    assert.deepEqual(set.settings.sources.slice(0, 5), [0, 1000, 3010, 6000, null]); assert.equal(set.settings.bogus, undefined);
    assert.equal(set.armed, false);
    assert.equal((await call('POST', '/api/surfaces/atem-panel', { instance: 'e2' })).status, 404, 'only an ATEM');
    assert.equal(server.atemPanel.started, false, 'createServer never opens the panel by itself');
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); systems.close(); await ctx.teardown(); }
});

test('panel worker process (pretend panel): connects, forwards presses, paints, stops cleanly', async () => {
  const host = new PanelHost({ env: { ...process.env, CC_BMD_PANEL_MOCK: '1' } });
  const st = []; const keys = [];
  host.on('status', (s) => st.push(s.state)); host.on('down', (k) => keys.push(k));
  try {
    await host.start();
    await until(() => st.includes('connected'), 5000, 'worker connected');
    await host.mock('tap', { key: 'auto' });
    await until(() => keys.includes('auto'), 2000, 'press forwarded');
    const painted = await host.setLeds(P.encodeLeds({ keys: { auto: 'red' } }));
    assert.equal(painted.painted, true);
    const m = await host.mock('noop');
    assert.equal(P.decodeLeds(Buffer.from(m.leds, 'hex')).keys.auto, 'red'); assert.equal(m.auths, 1);
  } finally { await host.stop(); }
  assert.equal(host.child, null);
});

test('ATEM driver additions for the panel: PREV TRANS (CTPr / TrPr) and a T-bar stroke that reaches 10000', () => {
  const AP = require('../lib/drivers/atem-proto');
  const hex = (b) => b.toString('ascii', 4, 8) + b.subarray(8).toString('hex');
  assert.equal(hex(AP.OUT.previewTransition(1, true)), 'CTPr01010000', 'atem-connection PreviewTransitionCommand');
  assert.equal(hex(AP.OUT.transitionPosition(0, 10000)), 'CTPs00002710', '10000 completes the transition');
  assert.equal(hex(AP.OUT.transitionPosition(0, 12345)), 'CTPs00002710', 'clamped');
  const st = { mes: {} };
  assert.equal(AP.applyCommand(st, 'TrPr', Buffer.from([1, 1, 0, 0])), true);
  assert.equal(st.mes[1].previewTransition, true);
});
