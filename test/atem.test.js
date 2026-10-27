'use strict';
// 0.7.0 Blackmagic ATEM driver: packet / command byte layouts (against Sofie atem-connection), the UDP session
// against the mock switcher on 127.0.0.1 (hello, state dump, acks, resends), every switcher operation, validation,
// the SystemManager whitelist and the /api/sys/atem routes. No test contacts a real device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/drivers/atem-proto');
const { AtemDriver } = require('../lib/drivers/atem');
const { MockAtem, INPUTS } = require('../lib/mocks/atem');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');

const until = async (fn, ms = 3000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); } };
async function rig() { const m = new MockAtem(); const port = await m.start(0); const d = new AtemDriver({ host: '127.0.0.1', port }); await d.connect(); return { m, d, port, stop: async () => { d.close(); await m.stop(); } }; }
const last = (m, name) => { const l = m.calls(name); return l.length ? l[l.length - 1].hex : null; };

// ---------- protocol (atem-connection src/lib/atemSocketChild.ts, src/commands/*) ----------
test('ATEM proto: header packs flags (5 bits) + length (11 bits), session, ack, packet id; hello is the 20-byte SYN', () => {
  const h = P.header(P.FLAG.AckRequest, 24, 0x8001, { packetId: 7 });
  assert.equal(h.length, 12); assert.equal(h.readUInt16BE(0), (P.FLAG.AckRequest << 11) | 24); assert.equal(h.readUInt16BE(2), 0x8001); assert.equal(h.readUInt16BE(10), 7);
  const r = P.parseHeader(Buffer.concat([h, Buffer.alloc(12)])); assert.deepEqual([r.flags, r.length, r.session, r.packetId], [P.FLAG.AckRequest, 24, 0x8001, 7]);
  const a = P.parseHeader(P.header(P.FLAG.AckReply, 12, 5, { ack: 300 })); assert.equal(a.ack, 300);
  assert.equal(P.HELLO.length, 20); assert.deepEqual([...P.HELLO.subarray(0, 4)], [0x10, 0x14, 0x53, 0xab]);
  assert.equal(P.MAX_PACKET_ID, 32768); assert.equal(P.FLAG.NewSessionId, 2); assert.equal(P.FLAG.RetransmitRequest, 8);
});

test('ATEM proto: command framing and serializers match atem-connection byte for byte', () => {
  const c = P.cmd('DCut', Buffer.from([0, 0, 0, 0])); assert.equal(c.readUInt16BE(0), 12); assert.equal(c.toString('ascii', 4, 8), 'DCut');
  const split = P.splitCommands(Buffer.concat([P.OUT.program(0, 3), P.OUT.preview(1, 1000)]));
  assert.deepEqual(split.map((x) => [x.name, x.data.toString('hex')]), [['CPgI', '00000003'], ['CPvI', '010003e8']]);
  const hex = (b) => b.toString('ascii', 4, 8) + b.subarray(8).toString('hex');
  assert.equal(hex(P.OUT.cut(0)), 'DCut00000000');
  assert.equal(hex(P.OUT.auto(1)), 'DAut01000000');
  assert.equal(hex(P.OUT.style(0, 2)), 'CTTp01000200', 'mask 1 = nextStyle');
  assert.equal(hex(P.OUT.nextSelection(0, 0b101)), 'CTTp02000005', 'mask 2 = nextSelection; bit0 background, bit n+1 key n');
  assert.equal(hex(P.OUT.mixRate(0, 30)), 'CTMx001e0000');
  assert.equal(hex(P.OUT.ftb(0)), 'FtbA00000000');
  assert.equal(hex(P.OUT.ftbRate(0, 50)), 'FtbC01003200');
  assert.equal(hex(P.OUT.uskOnAir(0, 2, true)), 'CKOn00020100');
  assert.equal(hex(P.OUT.dskOnAir(1, true)), 'CDsL01010000');
  assert.equal(hex(P.OUT.dskTie(0, true)), 'CDsT00010000');
  assert.equal(hex(P.OUT.dskAuto(1, P.V8_0_1 + 1)), 'DDsA00010000', 'from 8.0.1 the key index is byte 1');
  assert.equal(hex(P.OUT.dskAuto(1, P.V8_0_1 - 1)), 'DDsA01000000', 'before 8.0.1 byte 0');
  assert.equal(hex(P.OUT.aux(1, 3010)), 'CAuS01010bc2');
  assert.equal(hex(P.OUT.macroRun(5)), 'MAct00050000');
  assert.equal(hex(P.OUT.macroStop()), 'MActffff0100');
  assert.equal(hex(P.OUT.macroRecord(0)), 'MAct00000500');
  assert.equal(hex(P.OUT.macroStopRecord()), 'MActffff0200');
  assert.equal(hex(P.OUT.macroUserWait()), 'MActffff0300');
  assert.equal(hex(P.OUT.macroContinue()), 'MActffff0400');
  for (const b of Object.values(P.OUT).map((f) => f(0, 1, 1))) assert.equal(b.readUInt16BE(0), b.length);
});

// ---------- session against the mock ----------
test('ATEM: hello -> session id -> state dump (InCm); model, protocol, inputs with names, topology, macros', async () => {
  const { m, d, stop } = await rig();
  try {
    const st = d.status(); assert.equal(st.connected, true); assert.equal(st.info.model, 'ATEM Television Studio HD8 ISO'); assert.equal(st.info.version, '2.32');
    const v = d.view();
    assert.equal(v.topology.mixEffects, 1); assert.equal(v.topology.downstreamKeyers, 2); assert.equal(v.topology.auxilliaries, 2);
    assert.equal(v.keyers.length, 4); assert.equal(v.dsk.length, 2); assert.equal(v.aux.length, 2);
    assert.equal(v.bus.length, INPUTS.filter((i) => i[5] & 1).length); assert.equal(v.bus.length, 17); // 0.10.0: HD8 ISO profile adds MP keys and SuperSource
    const cam1 = v.inputs.find((i) => i.id === 1); assert.equal(cam1.long, 'Cam 1 Wide'); assert.equal(cam1.short, 'CAM1');
    assert.ok(v.bus.every((i) => i.id !== 10010 && i.id !== 10011), 'PGM / PVW outputs are not bus buttons');
    assert.ok(v.auxSources.some((i) => i.id === 10010), 'program is an aux source');
    assert.deepEqual(v.macros.map((x) => x.index), [0, 1, 2, 5]);
    assert.equal(v.program, 1); assert.equal(v.preview, 2); assert.deepEqual(v.tally, { program: ['CAM1'], preview: ['CAM2'] });
    assert.ok(m.packets.length >= 1 && m.packets.every((p) => p.length >= 12));
  } finally { await stop(); }
});

test('ATEM: preview / program / CUT / AUTO update the bus and tally from the switcher\'s own state', async () => {
  const { m, d, stop } = await rig();
  try {
    await d.preview(3); assert.equal(last(m, 'CPvI'), '00000003');
    await until(() => d.view().preview === 3, 2000, 'PVW 3');
    await d.cut(); await until(() => d.view().program === 3 && d.view().preview === 1, 2000, 'cut swap');
    assert.deepEqual(d.view().tally.program, ['CAM3']);
    await d.auto(); await until(() => d.view().inTransition, 2000, 'transition running');
    await until(() => !d.view().inTransition && d.view().program === 1, 3000, 'auto done');
    await d.program(5); await until(() => d.view().program === 5, 2000, 'PGM 5');
    assert.equal(last(m, 'CPgI'), '00000005');
  } finally { await stop(); }
});

test('ATEM: style, mix rate, FTB (and its rate), USK on air / tie, DSK tie / on air / auto, aux, macros', async () => {
  const { m, d, stop } = await rig();
  try {
    await d.style('wipe'); await until(() => d.view().nextStyle === 'WIPE', 2000, 'style');
    await d.mixRate(30); await until(() => d.view().mixRate === 30, 2000, 'rate');
    await d.ftbRate(10); await until(() => d.view().ftb && d.view().ftb.rate === 10, 2000, 'ftb rate');
    await d.ftb(); await until(() => d.view().ftb.black, 3000, 'black');
    await d.uskOnAir(1, true); await until(() => d.view().keyers[1].onAir, 2000, 'usk on');
    await d.uskTie(0, true); await until(() => d.view().keyers[0].tie, 2000, 'usk tie'); assert.equal(d.view().nextSelection, 0b11);
    await d.uskTie(0, false); await until(() => !d.view().keyers[0].tie, 2000, 'usk untie');
    await d.dskTie(0, true); await until(() => d.view().dsk[0].tie, 2000, 'dsk tie');
    await d.dskOnAir(1, true); await until(() => d.view().dsk[1].onAir, 2000, 'dsk on');
    await d.dskAuto(1); await until(() => !d.view().dsk[1].onAir && !d.view().dsk[1].inTransition, 3000, 'dsk auto off');
    assert.equal(last(m, 'DDsA'), '00010000', 'ATEM 8.0.1+ layout for this protocol version');
    await d.aux(0, 10010); await until(() => d.view().aux[0].source === 10010, 2000, 'aux');
    await d.macroRun(5); await until(() => d.view().macroRun.isRunning && d.view().macroRun.macroIndex === 5, 2000, 'macro run');
    await d.macroStop(); await until(() => !d.view().macroRun.isRunning, 2000, 'macro stop');
  } finally { await stop(); }
});

test('ATEM: validation refuses unknown sources, M/Es, keys, aux, empty macros and bad rates before sending', async () => {
  const { m, d, stop } = await rig();
  try {
    const n = m.history.length;
    for (const f of [() => d.program(4242), () => d.preview('x'), () => d.cut(3), () => d.uskOnAir(4, true), () => d.dskOnAir(2, true), () => d.aux(2, 1), () => d.aux(0, 4242),
      () => d.macroRun(3), () => d.mixRate(0), () => d.mixRate(251), () => d.ftbRate(-1), () => d.style('SPIN'), () => d.nextSelection(0)]) {
      assert.throws(f, (e) => e.status === 400);
    }
    assert.equal(m.history.length, n, 'nothing was sent');
  } finally { await stop(); }
});

test('ATEM: a lost command packet is resent (IsRetransmit) until acked; a silent switcher is reported offline', async () => {
  const { m, d, stop } = await rig();
  try {
    m.dropIncoming = 2;
    await d.preview(4);
    const mine = m.packets.filter((p) => p.flags & P.FLAG.AckRequest);
    assert.ok(mine.length >= 3, 'sent, then resent twice'); assert.ok(mine.slice(1).every((p) => p.flags & P.FLAG.IsRetransmit));
    assert.equal(m.calls('CPvI').length, 1, 'applied once');
    await until(() => d.view().preview === 4, 2000, 'PVW 4');
    await m.stop(); d.silenceMs = 200;
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(d.heartbeat(), /stopped answering/); assert.equal(d.status().connected, false);
    await assert.rejects(d.cut(), (e) => e.status === 409);
  } finally { await stop(); }
});

test('ATEM: no host = no socket; nothing answering = a clear timeout', async () => {
  const d = new AtemDriver({ host: '' }); await assert.rejects(d.connect(), /no IP address/); assert.equal(d.sock, null);
  const m = new MockAtem(); const port = await m.start(0); await m.stop(); // a closed loopback port
  const d2 = new AtemDriver({ host: '127.0.0.1', port }); d2.connectMs = 300;
  await assert.rejects(d2.connect(), /no answer within/); assert.equal(d2.sock, null);
});

// ---------- SystemManager + routes ----------
test('/api/sys/atem: switching to the ATEM, commands through the whitelist with log lines, unknown names refused', async () => {
  const ctx = await setup({});
  const m = new MockAtem(); const overrides = { atem: { host: '127.0.0.1', port: await m.start(0), me: 1 } };
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const lines = []; const orig = systems.log.bind(systems); systems.log = (l, msg) => { lines.push(msg); orig(l, msg); };
  try {
    assert.equal((await call('POST', '/api/sys/atem/cmd/cut')).status, 409, 'not connected yet');
    const st = (await call('POST', '/api/sys/active', { system: 'atem' })).json;
    assert.equal(st.active, 'atem'); assert.equal(st.view.status.connected, true); assert.equal(st.view.bus.find((b) => b.id === 1).long, 'Cam 1 Wide');
    assert.equal(st.systems.atem.counts.macros, 4);
    assert.equal((await call('POST', '/api/sys/atem/cmd/preview', { source: 6 })).json.ok, true);
    assert.equal((await call('POST', '/api/sys/atem/cmd/cut')).json.ok, true);
    await until(() => systems.view('atem').program === 6, 2000, 'program 6');
    assert.equal((await call('POST', '/api/sys/atem/cmd/program', { source: 4242 })).status, 400);
    assert.equal((await call('POST', '/api/sys/atem/cmd/reboot')).status, 404, 'only whitelisted operations');
    assert.equal((await call('POST', '/api/sys/atem/cmd/aux', { aux: 1, source: 10010 })).json.ok, true);
    assert.equal((await call('POST', '/api/sys/atem/connection', { host: '192.0.2.77' })).status, 409, 'mock connection is fixed');
    assert.ok(lines.includes('ATEM: CUT')); assert.ok(lines.includes('ATEM: AUX 2 ← Program')); assert.ok(!lines.some((l) => /preview/i.test(l)), 'bus selections are not logged');
    assert.equal((await call('GET', '/api/sys/atem')).json.aux[1].source, 10010);
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); systems.close(); await m.stop(); await ctx.teardown(); }
});

test('ATEM connection is saved per install, M/E 1..4, never in a show unless asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6atem-'));
  try {
    const eng = { settings: { host: '192.0.2.10' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} };
    const sm = new SystemManager({ dataDir: dir, engine: eng, autoStart: false });
    assert.equal(sm.configured('atem'), false);
    sm.updateConnection('atem', { host: '192.0.2.60', me: 9, port: 9910 });
    assert.equal(sm.conn('atem').me, 4); assert.equal(sm.configured('atem'), true);
    assert.equal(sm.showPart().systems.atem, undefined);
    assert.equal(sm.showPart({ includeConnection: true }).systems.atem.connection.host, '192.0.2.60');
    sm.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
