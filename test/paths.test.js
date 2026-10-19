'use strict';
// Each builder must reproduce the literal example printed in the AWJ v6.2 guide (whitespace from PDF
// line wrapping removed). This guards against typos that a mock sharing the same builders could not catch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { P, awjToRest, restToAwj } = require('../lib/paths');

const DOC = [
  ['§2.1 p.6', P.deviceType(), 'DeviceObject/system/$device/@items/1/@props/dev'],
  ['§2.3 p.7', P.firmware(), 'DeviceObject/system/$device/@items/1/version/@props/updater'],
  ['§3.1 p.8', P.screenMode('S1'), 'DeviceObject/preconfig/resources/new/$screen/@items/S1/control/@props/mode'],
  ['§3.1 p.8', P.destLabel('S1'), 'DeviceObject/$screen/@items/S1/control/@props/label'],
  ['§3.1 p.8', P.destLabel('A1'), 'DeviceObject/$auxiliary/@items/A1/control/@props/label'],
  ['§3.2 p.9', P.take('S1'), 'DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake'],
  ['§3.3 p.9', P.loadScreenMemory(33, 'S1', 'preview'), 'DeviceObject/presetBank/control/load/$slot/@items/33/$screen/@items/S1/$preset/@items/PREVIEW/@props/xRequest'],
  ['§3.3 p.9', P.loadScreenMemory(13, 'S2', 'program'), 'DeviceObject/presetBank/control/load/$slot/@items/13/$screen/@items/S2/$preset/@items/PROGRAM/@props/xRequest'],
  ['§3.3 p.9', P.loadScreenMemory(8, 'A1', 'program'), 'DeviceObject/presetBank/control/load/$slot/@items/8/$auxiliary/@items/A1/$preset/@items/PROGRAM/@props/xRequest'],
  ['§3.4 p.10', P.loadMasterMemory(15, 'preview'), 'DeviceObject/masterPresetBank/control/load/$slot/@items/15/$preset/@items/PREVIEW/@props/xRequest'],
  ['§3.5 p.10', P.layerCapability('S2', 1), 'DeviceObject/preconfig/resources/new/$screen/@items/S2/$layer/@items/1/control/@props/capability'],
  ['§3.6 p.11', P.layerSource('S2', 'A', 1), 'DeviceObject/$screen/@items/S2/$preset/@items/A/$layer/@items/1/source/@props/inputNum'],
  ['§3.6 p.12', P.layerSource('A1', 'A', 2), 'DeviceObject/$auxiliary/@items/A1/$preset/@items/A/$layer/@items/2/source/@props/inputNum'],
  ['§3.8 p.14', P.layerSource('S2', 'B', 1), 'DeviceObject/$screen/@items/S2/$preset/@items/B/$layer/@items/1/source/@props/inputNum'],
  ['§3.9 p.14', P.layerSource('S2', 'A', 'NATIVE'), 'DeviceObject/$screen/@items/S2/$preset/@items/A/$layer/@items/NATIVE/source/@props/inputNum'],
  ['§3.9 p.15', P.layerSource('A1', 'A', 'NATIVE'), 'DeviceObject/$auxiliary/@items/A1/$preset/@items/A/$layer/@items/NATIVE/source/@props/inputNum'],
  ['§3.7 p.12', P.masterLabel(3), 'DeviceObject/masterPresetBank/$bank/@items/3/control/@props/label'],
  ['§3.7 p.12', P.screenMemoryLabel(12), 'DeviceObject/presetBank/$bank/@items/12/control/@props/label'],
  ['§3.8 p.13', P.transition('S1'), 'DeviceObject/$screenAuxGroup/@items/S1/status/@props/transition'],
  ['§3.8 p.14', P.globalUpdate(), 'DeviceObject/$screenAuxGroup/control/@props/xUpdate'],
  ['§3.11 p.16', P.lastScreenMemory('S2', 'A'), 'DeviceObject/presetBank/status/presetId/$screen/@items/S2/$preset/@items/A/@props/id'],
  ['§3.11 p.16', P.lastScreenMemory('A1', 'A'), 'DeviceObject/presetBank/status/presetId/$auxiliary/@items/A1/$preset/@items/A/@props/id'],
  ['§3.12 p.16', P.lastMasterMemory('program'), 'DeviceObject/masterPresetBank/status/lastUsed/$presetMode/@items/PROGRAM/@props/memoryId'],
  ['§3.12 p.17', P.lastMasterMemory('preview'), 'DeviceObject/masterPresetBank/status/lastUsed/$presetMode/@items/PREVIEW/@props/memoryId'],
  ['§5.1.1 p.21', P.audioInMute(5, 7), 'DeviceObject/audio/control/$device/@items/1/$rx/@items/INPUT_5_CHANNEL_7/control/@props/mute'],
  ['§5.2.1 p.22', P.audioOutMute(4, 3), 'DeviceObject/audio/control/$device/@items/1/$tx/@items/OUTPUT_4/$channel/@items/3/control/@props/mute'],
  ['§6.1 p.24', P.input.isEnabled(8), 'DeviceObject/$input/@items/IN_8/status/@props/isEnabled'],
  ['§6.1 p.24', P.input.capability(8), 'DeviceObject/$input/@items/IN_8/status/@props/capability'],
  ['§6.1 p.24', P.input.label(8), 'DeviceObject/$input/@items/IN_8/control/@props/label'],
  ['§6.1 p.24', P.input.isAvailable(8), 'DeviceObject/$input/@items/IN_8/status/@props/isAvailable'],
  ['§6.1 p.25', P.input.freeze(8), 'DeviceObject/$input/@items/IN_8/control/@props/freeze'],
  ['§6.1 p.25', P.input.device(8), 'DeviceObject/$input/@items/IN_8/mapping/@props/device'],
  ['§6.1 p.25', P.input.scope(8), 'DeviceObject/$input/@items/IN_8/status/@props/scope'],
  ['§6.4 p.28', P.inputBackupSource(9, 1), 'DeviceObject/$input/@items/IN_9/backup/$slot/@items/1/control/@props/source'],
  ['§6.5 p.28', P.inputBackupSelect(9), 'DeviceObject/$input/@items/IN_9/backup/control/@props/xSelectSlot'],
  ['§6.6 p.29', P.inputBackupAuto(9), 'DeviceObject/$input/@items/IN_9/backup/control/@props/enableAutoSelect'],
  ['§6.7 p.29', P.bgBackupSource('S2', 3, 1), 'DeviceObject/preconfig/backgrounds/$screen/@items/S2/$backgroundSet/@items/3/backup/$slot/@items/1/control/@props/source'],
  ['§6.8 p.29', P.bgBackupSelect('S2', 1), 'DeviceObject/preconfig/backgrounds/$screen/@items/S2/$backgroundSet/@items/1/backup/control/@props/xSelectSlot'],
  ['§6.9 p.30', P.bgBackupAuto('S2', 3), 'DeviceObject/preconfig/backgrounds/$screen/@items/S2/$backgroundSet/@items/3/backup/control/@props/enableAutoSelect'],
  ['§6.10 p.30', P.groupBackupSelect(4), 'DeviceObject/backup/$group/@items/GROUP_4/control/@props/xSelectSlot'],
  ['§6.11 p.30', P.groupBackupAuto(2), 'DeviceObject/backup/$group/@items/GROUP_2/control/@props/enableAutoSelect'],
];

for (const [ref, got, want] of DOC) test(`AWJ path ${ref}: ${want.split('/').slice(-3).join('/')}`, () => assert.equal(got, want));

test('AWJ <-> REST source mapping (AWJ §3.6 p.12, REST p.15)', () => {
  assert.deepEqual(awjToRest('LIVE_4'), { sourceType: 'input', sourceId: 4 });
  assert.deepEqual(awjToRest('NATIVE_2'), { sourceType: 'background-set', sourceId: 2 });
  assert.deepEqual(awjToRest('NONE'), { sourceType: 'none', sourceId: 0 });
  assert.equal(restToAwj('image', 24), 'STILL_24');
  assert.equal(restToAwj('screen', 2), 'SCREEN_2');
});
