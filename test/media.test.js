'use strict';
// 0.9.4 Pixera (JSON-RPC over TCP, pxr1 framing) and Millumin (OSC over UDP): framing, the command set, the
// SystemManager whitelist and the /api/sys routes, all against the loopback mocks. No test contacts a real device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PixeraDriver, frame, takeFrames } = require('../lib/drivers/pixera');
const { MockPixera, TIMELINES } = require('../lib/mocks/pixera');
const { MilluminDriver } = require('../lib/drivers/millumin');
const { MockMillumin, COLUMNS } = require('../lib/mocks/millumin');
const osc = require('../lib/drivers/osc');
const { SystemManager } = require('../lib/systems');
const { createServer } = require('../lib/server');
const { setup } = require('./helpers');

const until = async (fn, ms = 3000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); } };

test('Pixera framing: pxr1 + uint32le length round-trips, including a body longer than 255 bytes', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'Pixera.Timelines.getTimelines', params: { note: 'x'.repeat(300) } });
  const buf = frame(body);
  assert.equal(buf.subarray(0, 4).toString(), 'pxr1');
  assert.equal(buf.readUInt32LE(4), Buffer.byteLength(body));
  assert.ok(buf.readUInt32LE(4) > 255, 'the length is a uint32, not one byte');
  const st = { buf: null };
  const split = Buffer.concat([buf.subarray(0, 5), buf.subarray(5)]);
  assert.deepEqual(takeFrames(st, split.subarray(0, 3)), []);
  assert.deepEqual(takeFrames(st, split.subarray(3)), [body]);
  assert.equal(st.buf.length, 0);
});

test('Pixera: timelines, transport, next / previous cue and apply-by-name against the mock', async () => {
  const m = new MockPixera(); const port = await m.start(0);
  const d = new PixeraDriver({ host: '127.0.0.1', port });
  try {
    await d.connect(); await d.load();
    assert.equal(d.status().connected, true);
    assert.equal(d.status().info.version, '367');
    assert.deepEqual(d.view().timelines.map((t) => t.name), TIMELINES.map((t) => t.name));
    assert.equal(d.view().selected, 101);
    const play = await d.transport('play', 102);
    assert.equal(play.mode, 'play'); assert.equal(m.transport[102], 'play');
    assert.deepEqual(m.calls('Pixera.Timelines.Timeline.setTransportMode').at(-1).params, { handle: 102, mode: 1 });
    await d.transport('toggle', 102); assert.equal(m.transport[102], 'pause');
    await d.transport('stop'); assert.equal(m.transport[101], 'stop', 'no handle uses the selected timeline');
    const next = await d.cue('next', 101); assert.equal(next.cue, 'Keynote');
    await d.cue('next', 101, { ignore: true });
    assert.equal(m.calls('Pixera.Timelines.Timeline.moveToNextCueIgnoreProperties').length, 1);
    assert.equal(d.view().timelines[0].cue, 'Rollout');
    await d.cue('prev', 101); assert.equal(m.cue[101], 'Keynote');
    await d.applyCue({ timeline: 'Countdown', cue: 'Stand by' });
    assert.equal(m.cue[103], 'Stand by'); assert.equal(d.view().selected, 103);
    await d.applyCue({ timeline: 1, cue: 1, index: true }); assert.equal(m.cue[102], 'Logos');
    await assert.rejects(d.applyCue({ timeline: 'Main', cue: 'Nope' }), /no cue/);
    await assert.rejects(d.transport('rewind'), /play, pause, stop or toggle/);
    assert.throws(() => d.timeline(999), /no timeline/);
  } finally { d.close(); await m.stop(); }
});

test('Pixera: no host opens nothing; a peer that never answers times out', async () => {
  const d = new PixeraDriver({ host: '' }); await assert.rejects(d.connect(), /no IP address/); assert.equal(d.sock, null);
  // 192.0.2.1 is the documentation range (TEST-NET-1): it does not answer, so the handshake timer is what fires.
  const d2 = new PixeraDriver({ host: '192.0.2.1', port: 1400 }); d2.connectMs = 300;
  await assert.rejects(d2.connect(), /no answer within/); assert.equal(d2.sock, null);
});

test('OSC: string, int32 and float32 round-trip, and an address must start with /', () => {
  const pkt = osc.encode('/action/launchColumn', [{ type: 's', value: 'Keynote' }]);
  const back = osc.decode(pkt); assert.equal(back.address, '/action/launchColumn'); assert.deepEqual(back.args, [{ type: 's', value: 'Keynote' }]);
  const n = osc.decode(osc.encode('/selectedLayer/opacity', [{ type: 'f', value: 0.25 }]));
  assert.equal(n.args[0].type, 'f'); assert.ok(Math.abs(n.args[0].value - 0.25) < 1e-6);
  const i = osc.decode(osc.encode('/action/goToTime', 3)); assert.equal(i.args[0].type, 'i'); assert.equal(i.args[0].value, 3);
  assert.throws(() => osc.encode('launchColumn'), /must start with/);
  assert.equal(osc.decode(Buffer.from([0, 0, 0, 0])), null);
});

test('Millumin: columns, transport, layer and opacity against the mock, with its feedback', async () => {
  const m = new MockMillumin(); const port = await m.start(0);
  const d = new MilluminDriver({ host: '127.0.0.1', port }, () => {}, () => {});
  try {
    await d.connect(); assert.equal(d.status().connected, true); assert.equal(d.status().info.model, 'Millumin');
    await d.send('launchColumn', 2);
    await until(() => m.calls('/action/launchColumn').length === 1, 1000, 'launch');
    assert.deepEqual(m.calls('/action/launchColumn')[0].args, [{ type: 'i', value: 2 }]);
    await until(() => d.view().columnName === 'Keynote', 1000, 'feedback');
    assert.equal(d.view().running, true); assert.equal(m.s.column, 2);
    await d.send('launchColumn', 'Walk out');
    await until(() => m.calls('/action/launchColumn').length === 2, 1000, 'named launch');
    assert.equal(m.calls('/action/launchColumn').at(-1).args[0].type, 's');
    await until(() => d.view().columnName === 'Walk out', 1000, 'named column');
    await d.send('nextColumn'); await until(() => m.s.column === 5, 1000, 'next column');
    await d.send('stopColumn'); await until(() => d.view().running === false, 1000, 'stopped');
    await d.send('selectLayer', 'Titles'); await until(() => m.s.layer === 'Titles', 1000, 'layer'); assert.equal(d.view().layer, 'Titles');
    await d.send('opacity', 0.4); await until(() => Math.abs(m.s.opacity - 0.4) < 1e-6, 1000, 'opacity');
    await d.send('enterFullscreen'); await until(() => m.s.fullscreen === true, 1000, 'fullscreen');
    await d.send('displayTestCard'); await until(() => m.s.testCard === true, 1000, 'test card');
    await d.send('hideTestCard'); await until(() => m.s.testCard === false, 1000, 'test card hidden');
    assert.throws(() => d.send('launchColumn'), /needs a column/);
    assert.throws(() => d.send('opacity', 2), /0\.\.1/);
    assert.throws(() => d.send('explode'), /Unknown Millumin command/);
  } finally { d.close(); await m.stop(); }
});

test('/api/sys/pixera and /api/sys/millumin: both on the desk, commands through the whitelist, unknown names refused', async () => {
  const ctx = await setup({});
  const mp = new MockPixera(); const mm = new MockMillumin();
  const overrides = { pixera: { host: '127.0.0.1', port: await mp.start(0) }, millumin: { host: '127.0.0.1', port: await mm.start(0) } };
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, overrides, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const lines = []; const orig = systems.log.bind(systems); systems.log = (l, msg) => { lines.push(msg); orig(l, msg); };
  try {
    assert.equal((await call('POST', '/api/sys/pixera/cmd/transport', { mode: 'play' })).status, 409, 'not connected yet');
    let st = (await call('POST', '/api/sys/active', { system: 'pixera' })).json;
    assert.equal(st.active, 'pixera'); assert.equal(st.view.status.connected, true);
    assert.equal(st.view.timelines.length, 3); assert.equal(st.systems.pixera.counts.timelines, 3);
    assert.equal((await call('POST', '/api/sys/pixera/cmd/transport', { handle: 102, mode: 'play' })).json.ok, true);
    assert.equal(mp.transport[102], 'play');
    assert.equal((await call('POST', '/api/sys/pixera/cmd/nextCue', { handle: 101 })).json.cue, 'Keynote');
    assert.equal((await call('POST', '/api/sys/pixera/cmd/applyCue', { timeline: 'Main', cue: 'Walk out' })).json.ok, true);
    assert.equal(mp.cue[101], 'Walk out');
    assert.equal((await call('POST', '/api/sys/pixera/cmd/reboot')).status, 404, 'only whitelisted operations');
    assert.equal((await call('POST', '/api/sys/pixera/connection', { host: '192.0.2.77' })).status, 409, 'mock connection is fixed');
    assert.ok(lines.some((l) => l.includes('Pixera: Side wall: PLAY')));
    // Pixera stays on the desk when Millumin is opened
    st = (await call('POST', '/api/sys/active', { system: 'millumin' })).json;
    assert.ok(st.armed.includes('pixera')); assert.ok(st.armed.includes('millumin'));
    assert.equal(st.view.status.connected, true);
    assert.equal((await call('POST', '/api/sys/millumin/cmd/launchColumn', { value: 3 })).json.address, '/action/launchColumn');
    await until(() => systems.view('millumin').columnName === 'Rollout', 1000, 'column feedback');
    assert.equal((await call('POST', '/api/sys/millumin/cmd/selectLayer', { value: 'Lower third' })).json.ok, true);
    assert.equal(mm.s.layer, 'Lower third');
    assert.equal((await call('POST', '/api/sys/millumin/cmd/opacity', { value: 0.5 })).json.ok, true);
    assert.equal((await call('POST', '/api/sys/millumin/cmd/quit')).status, 404, 'quit is not in the useful set');
    assert.ok(lines.some((l) => l.includes('Millumin: launchColumn 3')));
    assert.ok(st.groups.some((g) => g.name === 'Media servers' && g.systems.includes('pixera') && g.systems.includes('millumin')));
  } finally { server.closeClients(); await new Promise((r) => server.close(r)); systems.close(); await mp.stop(); await mm.stop(); await ctx.teardown(); }
});

test('Pixera and Millumin connections are saved per install and stay out of a show unless asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6media-'));
  try {
    const eng = { settings: { host: '192.0.2.10' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} };
    const sm = new SystemManager({ dataDir: dir, engine: eng, autoStart: false });
    assert.equal(sm.configured('pixera'), false); assert.equal(sm.configured('millumin'), false);
    sm.updateConnection('pixera', { host: '192.0.2.40', port: 1400 });
    sm.updateConnection('millumin', { host: '192.0.2.41', port: 99999 });
    assert.equal(sm.conn('millumin').port, 5000, 'a port out of range keeps the default');
    assert.deepEqual(sm.cfg.armed, ['pixera', 'millumin'], 'saving an address puts it on the desk');
    assert.equal(sm.showPart().systems.pixera, undefined);
    assert.equal(sm.showPart({ includeConnection: true }).systems.pixera.connection.host, '192.0.2.40');
    sm.applyShowPart({ system: 'rs6', armed: ['rs6'], systems: {} });
    assert.deepEqual(sm.cfg.armed, ['rs6'], 'a show that names a desk restores it');
    sm.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ADD TO DESK AS SIMULATOR: fixture stays off disk, REMOVE FROM DESK stops it, RS6 is refused', async () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'sys.js'), 'utf8');
  assert.match(ui, /ADD AS SIMULATOR/);
  assert.match(ui, /REMOVE FROM DESK/);
  assert.match(ui, /data-use="\$\{s\.key\}" data-open="\$\{s\.key\}">OPEN /);
  assert.doesNotMatch(ui, /data-open="\$\{s\.key\}">OPEN</);
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const file = () => JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'systems.json'), 'utf8'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6simfix-'));
  const fixed = new SystemManager({ dataDir: dir2, overrides: { pixera: { host: '127.0.0.1', port: 9 } }, autoStart: false });
  try {
    await assert.rejects(() => systems.simulate('rs6'), /RS6/);
    assert.equal((await call('POST', '/api/sys/rs6/simulate')).status, 400);
    await assert.rejects(() => fixed.simulate('pixera'), (e) => e.status === 409 && /already the built-in mock/.test(e.message));
    let st = (await call('POST', '/api/sys/pixera/simulate')).json;
    assert.equal(st.systems.pixera.status.connected, true);
    assert.equal(st.systems.pixera.counts.timelines, 3);
    assert.equal(st.systems.pixera.connection.mock, true);
    assert.equal(st.systems.pixera.connection.simulator, true);
    assert.equal(st.systems.pixera.connection.host, '127.0.0.1');
    assert.ok(st.armed.includes('pixera'));
    const port = st.systems.pixera.connection.port;
    st = (await call('POST', '/api/sys/pixera/simulate')).json;
    assert.equal(st.systems.pixera.connection.port, port, 'a second simulate does not start another fixture');
    let saved = file();
    assert.ok(!saved.armed.includes('pixera'));
    assert.equal(saved.active, 'rs6');
    assert.equal(saved.connections.pixera.host, '');
    assert.equal(systems.cfg.connections.pixera.host, '');
    assert.equal(systems.showPart().system, 'rs6');
    assert.ok(!systems.showPart().armed.includes('pixera'));
    assert.equal((await call('POST', '/api/sys/pixera/connection', { host: '192.0.2.50' })).status, 409);
    assert.equal(systems.cfg.connections.pixera.host, '');
    assert.equal((await call('POST', '/api/sys/pixera/cmd/transport', { handle: 101, mode: 'play' })).json.ok, true);
    systems.applyShowPart({ system: 'rs6', armed: ['rs6'], systems: {} });
    assert.equal(systems.isMock('pixera'), false, 'opening a show stops a simulator the show does not list');
    assert.equal(systems.cfg.connections.pixera.host, '');
    assert.ok(!systems.cfg.armed.includes('pixera'));
    systems.updateConnection('millumin', { host: '192.0.2.41', port: 5000 });
    assert.ok(systems.cfg.armed.includes('millumin'));
    assert.equal((await call('POST', '/api/sys/millumin/simulate')).status, 409, 'a system already on the desk is not replaced');
    assert.equal(systems.cfg.connections.millumin.host, '192.0.2.41');
    await systems.setArmed('millumin', false);
    st = await systems.simulate('millumin');
    assert.equal(st.systems.millumin.connection.host, '127.0.0.1');
    assert.equal(systems.cfg.connections.millumin.host, '192.0.2.41');
    assert.equal(systems.showPart({ includeConnection: true }).systems.millumin.connection.host, '192.0.2.41');
    assert.ok(!file().armed.includes('millumin'));
    st = await systems.setArmed('millumin', false);
    assert.equal(st.systems.millumin.connection.host, '192.0.2.41');
    assert.equal(st.systems.millumin.connection.mock, false);
    assert.equal(systems.isMock('millumin'), false);
    st = await systems.simulate('ptz');
    assert.equal(st.systems.ptz.connection.cameras.length, 3);
    assert.ok(st.systems.ptz.connection.cameras.every((c) => c.host === '127.0.0.1'));
    assert.deepEqual(file().connections.ptz.cameras, []);
    assert.deepEqual(systems.showPart({ includeConnection: true }).systems.ptz.cameras, []);
    await systems.setArmed('ptz', false);
    assert.equal(systems.mockCams, null);
    assert.equal(systems.conn('ptz').cameras.length, 0);
    assert.equal(systems.cfg.connections.ptz.cameras.length, 0);
    st = await systems.setArmed('pixera', false);
    assert.ok(!st.armed.includes('pixera'));
    assert.equal(st.systems.pixera.connection.mock, false);
    assert.equal(st.systems.pixera.connection.host, '');
    assert.equal(file().connections.pixera.host, '');
    assert.equal((await call('POST', '/api/sys/pixera/cmd/transport', { mode: 'play' })).status, 409);
    st = await systems.simulate('e2');
    assert.equal(st.systems.e2.connection.mock, true);
    await systems.setArmed('rs6', false);
    assert.deepEqual(systems.cfg.armed, ['e2']);
    st = await systems.setArmed('e2', false);
    assert.deepEqual(st.armed, [], 'the last system can leave, and RS6 is not put back');
    assert.equal(systems.isMock('e2'), false);
    assert.equal(systems.cfg.connections.e2.host, '');
    saved = file();
    assert.deepEqual(saved.armed, []);
    assert.equal(saved.connections.e2.host, '');
    assert.equal(saved.connections.millumin.host, '192.0.2.41');
  } finally {
    server.closeClients();
    await new Promise((r) => server.close(r));
    await systems.close();
    await fixed.close();
    fs.rmSync(dir2, { recursive: true, force: true });
    await ctx.teardown();
  }
});

