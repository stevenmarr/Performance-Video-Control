'use strict';
// 0.11.0 auto recall (follow-up presets) on E2 / S3 and PixelHue, against the built-in mocks on 127.0.0.1: after
// TAKE / CUT the follow-up goes to Preview after the wait (PixelHue: at least its transition time); own setting beats
// the desk default; 0 = none; no self-loop; a manual recall cancels; it is in show files (format 2, additive) and an
// older show without it still opens; it persists in systems.json; the API routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemManager } = require('../lib/systems');
const { MockE2 } = require('../lib/mocks/e2');
const { MockPixelHue } = require('../lib/mocks/pixelhue');
const SH = require('../lib/shows');
const { until, setup } = require('./helpers');
const { createServer } = require('../lib/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rs6fu-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeEngine() { return { settings: { host: '192.0.2.10', restPort: 80, awjPort: 10606, protocol: 'rest' }, presets: [], destinations: [], live: { inputs: {} }, log() {}, changed() {} }; }

test('E2 auto recall: TAKE → follow-up on Preview, default, none, cancel, show round trip, persistence', async () => {
  const dir = tmp(); const m = new MockE2(); const port = await m.start(0);
  try {
    const sm = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
    sm.updateConnection('e2', { host: '127.0.0.1', port }); await sm.setActive('e2'); await sm.setSelection('e2', ['S2', 'S3']);
    await sm.refresh('e2');
    sm.setFollowUpDefaults('e2', { delayMs: 60 });
    const r0 = sm.setFollowUp('e2', 'e2:2', { target: 'e2:3' }); assert.deepEqual([r0.followUp, r0.resolved, r0.bail.source], [{ target: 'e2:3' }, 'e2:3', 'preset']);
    assert.throws(() => sm.setFollowUp('e2', 'e2:2', { target: 'e2:2' }), /cannot follow itself/);
    await sm.recall('e2', 'e2:2'); await sm.take('e2');
    let v = sm.view('e2'); assert.equal(v.followUp.pending.to[0].key, 'e2:3', 'pending while the transition runs');
    assert.equal(v.presets.find((p) => p.key === 'e2:2').followUpResolved, 'e2:3');
    await until(() => sm.tally.e2.pvw.S2 === 'e2:3', 2000, 'Panel 4-up on Preview');
    assert.equal(sm.tally.e2.pgm.S2, 'e2:2', 'never takes'); assert.equal(m.calls('activatePreset').pop().params.type, 0, 'recalled to Preview');
    // desk default for presets without their own; 0 overrides it
    sm.setFollowUpDefaults('e2', { default: 'e2:1' });
    await sm.take('e2'); await until(() => sm.tally.e2.pvw.S2 === 'e2:1' || m.calls('activatePreset').some((c) => c.params.id === 1), 2000, 'default after e2:3');
    sm.setFollowUp('e2', 'e2:3', { enabled: false }); await sm.recall('e2', 'e2:3'); const n = m.calls('activatePreset').length; await sm.cut('e2'); await sleep(150);
    assert.equal(m.calls('activatePreset').length, n, 'none: nothing recalled after CUT');
    // manual recall cancels a pending one
    await sm.recall('e2', 'e2:2'); await sm.take('e2'); assert.ok(sm.view('e2').followUp.pending);
    await sm.recall('e2', 'e2:9'); assert.equal(sm.view('e2').followUp.pending, null);
    await sleep(150); assert.notEqual(sm.tally.e2.pvw.S2, 'e2:3');
    // a destination group (S2) beats the desk default; universal switch off stops everything
    sm.setFollowUpDefaults('e2', { groups: [{ name: 'IMAG', dests: ['S2'], target: 'e2:9' }] });
    assert.equal(sm.followUpInfo('e2', sm.preset('e2', 'e2:9')).target, 0, 'its own target would be itself → none');
    assert.equal(sm.followUpCfg('e2').groups[0].target, 'e2:9', 'stored as the preset key'); sm.setFollowUpDefaults('e2', { groups: [{ name: 'IMAG', dests: ['S2'], target: 10 }] }); assert.equal(sm.followUpCfg('e2').groups[0].target, sm.view('e2').presets.find((p) => p.tile === 10).key, 'a tile number resolves to its key'); sm.setFollowUpDefaults('e2', { groups: [{ name: 'IMAG', dests: ['S2'], target: 'e2:9' }] });
    assert.deepEqual(sm.view('e2').presets.find((p) => p.key === 'e2:1').bail.source, 'default', 'Keynote (S1 only) is not in the S2 group');
    assert.equal(sm.view('e2').presets.find((p) => p.key === 'e2:2').bail.source, 'preset');
    sm.setFollowUpDefaults('e2', { enabled: false }); await sm.recall('e2', 'e2:2'); await sm.take('e2'); assert.equal(sm.view('e2').followUp.pending, null, 'switch off');
    sm.setFollowUpDefaults('e2', { enabled: true });
    // show part + parse + apply; persistence
    const part = sm.showPart();
    assert.deepEqual(part.systems.e2.followUps, { 'e2:2': { target: 'e2:3' }, 'e2:3': { enabled: false } }); assert.equal(part.systems.e2.followUpDefault, 'e2:1'); assert.equal(part.systems.e2.followUpDelayMs, 60);
    const show = { format: SH.SHOW_FORMAT, version: SH.SHOW_VERSION, name: 'fu', presets: [], ...part };
    const parsed = SH.parseShow(JSON.stringify(show)).show;
    assert.deepEqual(parsed.systems.e2.followUps, { 'e2:2': { target: 'e2:3' }, 'e2:3': { enabled: false } }); assert.equal(parsed.systems.e2.followUpGroups[0].target, 'e2:9'); assert.equal(parsed.systems.e2.followUpDefault, 'e2:1');
    const old = JSON.parse(JSON.stringify(show)); delete old.systems.e2.followUps; delete old.systems.e2.followUpDefault; delete old.systems.e2.followUpDelayMs;
    const po = SH.parseShow(JSON.stringify(old)).show; assert.equal(po.systems.e2.followUps, undefined, 'older show: no auto recall');
    sm.applyShowPart(po); assert.deepEqual(sm.cfg.sessions.e2.followUps, {}); assert.equal(sm.cfg.sessions.e2.followUpDelayMs, 1000);
    sm.applyShowPart(parsed); assert.deepEqual(sm.cfg.sessions.e2.followUps['e2:2'], { target: 'e2:3' }); assert.equal(sm.cfg.sessions.e2.followUpGroups.length, 1);
    sm.close();
    const sm2 = new SystemManager({ dataDir: dir, engine: fakeEngine(), autoStart: false });
    assert.deepEqual(sm2.cfg.sessions.e2.followUps['e2:2'], { target: 'e2:3' }); assert.equal(sm2.cfg.sessions.e2.followUpDefault, 'e2:1'); sm2.close();
  } finally { await m.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PixelHue auto recall waits at least the transition time; API routes for E2 / RS6', async () => {
  const ctx = await setup({});
  const systems = new SystemManager({ dataDir: ctx.dataDir, engine: ctx.engine, autoStart: false });
  const server = createServer(ctx.engine, systems);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const m = new MockPixelHue(); const port = await m.start(0);
  try {
    systems.updateConnection('pixelhue', { host: '127.0.0.1', port, time: '300' }); await systems.setActive('pixelhue'); await systems.setSelection('pixelhue', ['S1']);
    await systems.refresh('pixelhue');
    assert.equal((await call('POST', '/api/sys/pixelhue/followup', { delayMs: 20 })).json.delayMs, 20);
    assert.equal((await call('POST', `/api/sys/pixelhue/presets/${encodeURIComponent('ph:preset-2-guid')}/followup`, { followUp: { target: 'ph:preset-6-guid' } })).json.resolved, 'ph:preset-6-guid');
    await systems.recall('pixelhue', 'ph:preset-2-guid'); const t0 = Date.now(); await systems.take('pixelhue');
    await until(() => systems.tally.pixelhue.pvw.S1 === 'ph:preset-6-guid', 3000, 'Video Roll on Preview');
    assert.ok(Date.now() - t0 >= 280, `waited the 300 ms transition (${Date.now() - t0} ms)`);
    assert.equal((await call('POST', '/api/sys/e2/presets/nope/followup', { followUp: 0 })).status, 404);
    // RS6 routes
    await ctx.engine.connect();
    await ctx.engine.savePreset({ number: 1, name: 'A', destinations: ['S1'], memories: { S1: 1 } }); await ctx.engine.savePreset({ number: 2, name: 'B', destinations: ['S1'], memories: { S1: 2 } });
    assert.equal((await call('POST', '/api/presets/1/followup', { followUp: { target: 2 } })).json.followUpResolved, 2);
    assert.equal((await call('POST', '/api/presets/1/followup', { followUp: { target: 1 } })).status, 400);
    assert.deepEqual((await call('POST', '/api/followup', { default: 0, delayMs: 250 })).json, { enabled: true, default: 0, delayMs: 250, groups: [], pending: null });
    assert.equal((await call('GET', '/api/state')).json.followUp.delayMs, 250);
    const put = await call('PUT', '/api/presets/2', { followUp: { enabled: true, target: 1 } }); assert.deepEqual(put.json.followUp, { enabled: true, target: 1 }, 'edit dialog path');
  } finally { await m.stop(); systems.close(); server.close(); await ctx.teardown(); }
});
