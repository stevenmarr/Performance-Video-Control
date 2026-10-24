'use strict';
// 0.11.0 AW-UE150 profile: the default when a camera's model is not known yet, and its shutter / auto-iris codes
// checked against the Panasonic "AW-UE150 / AW-HE145 Interface Specifications" v2.94 (Brightness table).
const test = require('node:test');
const assert = require('node:assert/strict');
const PC = require('../lib/drivers/ptz-commands');
const { MockPTZ } = require('../lib/mocks/ptz');

const b = (op, v, sr = 'UE150') => PC.build(sr, op, v);

test('UE150 is the default profile; a reported model still decides', () => {
  assert.equal(PC.DEFAULT_SERIES, 'UE150');
  assert.equal(PC.seriesFor(''), 'UE150'); assert.equal(PC.seriesFor(undefined), 'UE150'); assert.equal(PC.seriesFor('  '), 'UE150');
  assert.equal(PC.seriesFor('AW-HE130'), 'AW-HE130'); assert.equal(PC.seriesFor('NOT-A-CAM'), 'Other');
  assert.equal(PC.seriesFor('', 'AW-HE130'), 'AW-HE130', 'an explicit series override wins');
  const ids = new Set(PC.catalogFor(PC.seriesFor('')).ops.map((o) => o.id));
  for (const id of ['irisMode', 'iris', 'shutterMode', 'shutterStep', 'synchro', 'autoIrisSpeed', 'autoIrisWindow', 'autoIrisLimit', 'pictureLevel', 'elcLimit', 'rGain', 'bGain', 'rPed', 'gPed', 'bPed', 'masterPed']) assert.ok(ids.has(id), `default profile has ${id}`);
  assert.ok(!ids.has('shutter'), 'UE150 has no module shutS list (it uses OSJ:03 / OSJ:06)');
});

test('UE150 auto-iris codes (spec v2.94)', () => {
  assert.equal(b('irisMode', true).path, 'ptz'); assert.equal(b('irisMode', true).cmd, 'D31', 'auto iris = #D31 (aw_ptz)');
  assert.equal(b('irisMode', false).cmd, 'D30', 'manual iris = #D30');
  assert.equal(b('iris', 1).cmd, 'I01'); assert.equal(b('iris', 99).cmd, 'I99');
  assert.equal(b('autoIrisSpeed', '0').cmd, 'OSJ:01:0'); assert.equal(b('autoIrisSpeed', '2').cmd, 'OSJ:01:2'); assert.equal(b('autoIrisSpeed', '0').path, 'cam');
  assert.equal(b('autoIrisWindow', '2').cmd, 'OSJ:02:2');
  assert.equal(b('autoIrisLimit', '3').cmd, 'OSJ:C0:3');
  assert.equal(b('pictureLevel', -50).cmd, 'OSD:48:00'); assert.equal(b('pictureLevel', 0).cmd, 'OSD:48:32'); assert.equal(b('pictureLevel', 50).cmd, 'OSD:48:64');
  assert.throws(() => b('autoIrisSpeed', '3'), (e) => e.status === 400);
  // read back: camdata d3<0|1>, OSJ:01:0x<n>, OSD:48:0x<hh>
  const rb = PC.readback('UE150', { d3: '1', 'OSJ:01': '0x2', 'OSJ:C0': '0x1', 'OSD:48': '0x3C' });
  assert.equal(rb.irisMode, true); assert.equal(rb.autoIrisSpeed, '2'); assert.equal(rb.autoIrisLimit, '1'); assert.equal(rb.pictureLevel, 10);
});

test('UE150 shutter codes (spec v2.94)', () => {
  assert.equal(b('shutterMode', '0').cmd, 'OSJ:03:0'); assert.equal(b('shutterMode', '1').cmd, 'OSJ:03:1'); assert.equal(b('shutterMode', '2').cmd, 'OSJ:03:2'); assert.equal(b('shutterMode', '3').cmd, 'OSJ:03:3');
  assert.equal(b('shutterStep', '60').cmd, 'OSJ:06:003C', 'spec example: 1/60 = OSJ:06:003C');
  assert.equal(b('shutterStep', '10000').cmd, 'OSJ:06:2710', '1/10000 = 2710h (the maximum)');
  const steps = PC.catalogFor('UE150').ops.find((o) => o.id === 'shutterStep').options.map(([v]) => Number(v));
  assert.deepEqual(steps, [24, 25, 30, 48, 50, 60, 100, 120, 250, 500, 1000, 2000, 4000, 8000, 10000], 'every step the spec lists for some format, nothing else');
  assert.ok(!steps.includes(125), 'there is no 1/125 step on the UE150');
  assert.equal(b('shutterStepUp').cmd, 'OSJ:04:01'); assert.equal(b('shutterStepDown').cmd, 'OSJ:05:01');
  assert.equal(b('synchro', 60).cmd, 'OSJ:09:00258', 'spec example: 60.0 Hz = OSJ:09:00258');
  assert.equal(b('synchroUp').cmd, 'OSJ:07:01'); assert.equal(b('synchroDown').cmd, 'OSJ:08:01');
  assert.equal(b('elcLimit', '2').cmd, 'OSD:BF:2'); assert.equal(b('elcLimit', '4').cmd, 'OSD:BF:4');
  const rb = PC.readback('UE150', { 'OSJ:03': '0x1', 'OSJ:06': '0x003C', 'OSJ:09': '0x00258' });
  assert.equal(rb.shutterMode, '1'); assert.equal(rb.shutterStep, '60'); assert.equal(rb.synchro, 60);
});

test('mock UE150 accepts the new codes and refuses out-of-range values', () => {
  const m = new MockPTZ({ model: 'AW-UE150' });
  for (const c of ['OSJ:01:2', 'OSJ:02:1', 'OSJ:C0:3', 'OSD:48:00', 'OSD:48:64', 'OSD:BF:4', 'OSJ:06:2710']) assert.equal(m.cam(c), c, c);
  assert.match(m.cam('OSJ:01:3'), /^ER3/); assert.match(m.cam('OSD:48:65'), /^ER3/); assert.match(m.cam('OSJ:06:007D'), /^ER3/, '1/125 is refused');
  m.cam('OSJ:06:003C'); m.cam('OSJ:04:01'); assert.equal(parseInt(m.raw['OSJ:06'], 16), 100, 'step + from 1/60 is 1/100');
  assert.equal(m.ptz('D30'), 'd30'); assert.equal(m.ptz('D31'), 'd31');
});
