'use strict';
// 0.11.0 ATEM audio MUTE ALL / DESK ZERO and SAVE STARTUP STATE, over the driver and /api/sys/atem, against the mock on
// 127.0.0.1. RICD / RICE / RMOD / RMOE / SRsv encodings follow atem-connection 3.10.3 (unverified on hardware).
const test = require('node:test');
const assert = require('node:assert/strict');
const { AtemDriver } = require('../lib/drivers/atem');
const { MockAtem } = require('../lib/mocks/atem');
const P = require('../lib/drivers/atem-proto');
const { until } = require('./helpers');

async function rig(model) { const m = new MockAtem({ model }); const port = await m.start(0); const d = new AtemDriver({ host: '127.0.0.1', port }); await d.connect(); return { m, d, stop: async () => { d.close(); await m.stop(); } }; }

test('Fairlight (TVS HD8 ISO): MUTE ALL remembers each mix and un-mutes only what it muted; DESK ZERO resets levels, EQ, dynamics', async () => {
  const { m, d, stop } = await rig('tvshd8iso');
  try {
    const ids = d.view().audio.inputs.map((x) => x.id);
    await d.audioMute(2, true); await until(() => d.view().audio.inputs.find((x) => x.id === 2).muted, 2000, 'input 2 muted first');
    await d.audioInput(3, { mix: 'on' }); await until(() => d.view().audio.inputs.find((x) => x.id === 3).mix === 'on', 2000, 'input 3 on');
    const before = Object.fromEntries(d.view().audio.inputs.map((x) => [x.id, x.mix]));
    const r = await d.audioMuteAll(true);
    assert.ok(!r.inputs.includes(2), 'an already muted input is left alone'); assert.deepEqual(r.inputs, ids.filter((i) => before[i] !== 'off'));
    await until(() => d.view().audio.inputs.every((x) => x.muted), 3000, 'every input muted');
    await d.audioMuteAll(false);
    await until(() => d.view().audio.inputs.every((x) => x.mix === before[x.id]), 3000, 'mixes restored');
    assert.equal(d.view().audio.inputs.find((x) => x.id === 2).mix, 'off', 'input 2 stays muted (MUTE ALL did not mute it)');

    await d.audioInput(1, { fader: -12, gain: 3, balance: 40 }); await d.audioMaster({ fader: -5 });
    m.fl.inputs[1].src.equalizerEnabled = true; m.fl.inputs[1].src.makeUpGain = 300; // as if set on the desk
    await until(() => d.view().audio.inputs[0].fader === -12 && d.view().audio.master.fader === -5, 2000, 'levels set');
    const mixes = Object.fromEntries(d.view().audio.inputs.map((x) => [x.id, x.mix]));
    const z = await d.audioDeskZero(); assert.equal(z.type, 'fairlight'); assert.ok(z.commands > ids.length * 3);
    await until(() => d.view().audio.inputs.every((x) => x.fader === 0 && x.gain === 0 && x.balance === 0) && d.view().audio.master.fader === 0, 3000, 'all at unity');
    for (const x of Object.values(m.fl.inputs)) { assert.equal(x.src.equalizerEnabled, false); assert.equal(x.src.makeUpGain, 0); assert.equal(x.src.equalizerGain, 0); }
    assert.equal(m.fl.master.makeUpGain, 0); assert.equal(m.fl.master.equalizerEnabled, false);
    assert.deepEqual(Object.fromEntries(d.view().audio.inputs.map((x) => [x.id, x.mix])), mixes, 'DESK ZERO leaves on / off / AFV alone');
    const ricd = m.calls('RICD'); const rice = m.calls('RICE');
    assert.equal(ricd.length, ids.length); assert.equal(rice.length, ids.length);
    const b = Buffer.from(ricd[0].hex, 'hex'); assert.equal(b.length, 20); assert.equal(b.readUInt16BE(0), 1); assert.equal(b.readBigInt64BE(8).toString(), P.FL_STEREO); assert.equal(b.readUInt8(17), 15);
    const e = Buffer.from(rice[0].hex, 'hex'); assert.equal(e.readUInt8(0), 1); assert.equal(e.readUInt16BE(2), 1); assert.equal(e.readUInt8(16), 1);
    assert.equal(m.calls('RMOD').length, 1); assert.equal(Buffer.from(m.calls('RMOD')[0].hex, 'hex').readUInt8(1), 15);
    assert.deepEqual([...Buffer.from(m.calls('RMOE')[0].hex, 'hex')], [1, 1, 0, 0]);
    await d.saveStartup(); await until(() => m.startupSaves === 1, 2000, 'SRsv');
    assert.equal(m.calls('SRsv')[0].hex, '00000000');
  } finally { await stop(); }
});

test('classic (4 M/E Broadcast Studio 4K): MUTE ALL / un-mute, DESK ZERO sets every level to 0 dB and balance centre', async () => {
  const { m, d, stop } = await rig('4mebs4k');
  try {
    await d.audioInput(5, { fader: -6, balance: 50, mix: 'on' }); await d.audioMaster({ fader: -10 });
    await until(() => d.view().audio.inputs.find((x) => x.id === 5).mix === 'on', 2000, 'set');
    await d.audioMuteAll(); await until(() => d.view().audio.inputs.every((x) => x.muted), 3000, 'all muted (classic mix off)');
    await d.audioMuteAll(false); await until(() => d.view().audio.inputs.find((x) => x.id === 5).mix === 'on', 3000, 'input 5 back on');
    await d.audioDeskZero();
    await until(() => d.view().audio.inputs.every((x) => Math.abs(x.fader) < 0.05 && x.balance === 0) && Math.abs(d.view().audio.master.fader) < 0.05, 3000, 'unity');
    assert.equal(m.classic.inputs[5].gain, P.dbToU16(0)); assert.equal(m.calls('RICD').length, 0, 'no Fairlight resets on a classic mixer');
  } finally { await stop(); }
});
