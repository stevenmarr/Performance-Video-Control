'use strict';
// AWJ v6.2 path builders. Section/page refs are to the "Aquilon AWJ Protocol Programmer's Guide",
// document version 6.2 (printed page numbers). test/paths.test.js checks each builder against the
// literal example printed in the guide.
//
// Path forms: the guide uses $screen / $auxiliary for per-screen objects, $screenAuxGroup for
// transition control/status, and a device index ($device/@items/1) only for system and audio paths.
// It never uses "$auxiliaryScreen" or a device index in screen/layer paths, so neither do we.

const coll = (key) => (key[0] === 'S' ? '$screen' : '$auxiliary');
const inp = (n) => `IN_${Number(n)}`;

const P = {
  // §2.1-2.3 (p.6-7)
  deviceType: () => 'DeviceObject/system/$device/@items/1/@props/dev',
  firmware: () => 'DeviceObject/system/$device/@items/1/version/@props/updater',
  // §3.1 (p.8)
  screenMode: (key) => `DeviceObject/preconfig/resources/new/$screen/@items/${key}/control/@props/mode`,
  destLabel: (key) => `DeviceObject/${coll(key)}/@items/${key}/control/@props/label`,
  // §3.2 (p.9)
  take: (key) => `DeviceObject/$screenAuxGroup/@items/${key}/control/@props/xTake`,
  // §3.3 (p.9)
  loadScreenMemory: (slot, key, target) => `DeviceObject/presetBank/control/load/$slot/@items/${Number(slot)}/${coll(key)}/@items/${key}/$preset/@items/${target === 'program' ? 'PROGRAM' : 'PREVIEW'}/@props/xRequest`,
  // §3.4 (p.10)
  loadMasterMemory: (slot, target) => `DeviceObject/masterPresetBank/control/load/$slot/@items/${Number(slot)}/$preset/@items/${target === 'program' ? 'PROGRAM' : 'PREVIEW'}/@props/xRequest`,
  // §3.5 (p.10)
  layerCapability: (key, layer) => `DeviceObject/preconfig/resources/new/$screen/@items/${key}/$layer/@items/${layer}/control/@props/capability`,
  // §3.6 (p.11-12), §3.8 (p.13-14); layer "NATIVE" = background, §3.9-3.10 (p.14-15)
  layerSource: (key, side, layer) => `DeviceObject/${coll(key)}/@items/${key}/$preset/@items/${side}/$layer/@items/${layer}/source/@props/inputNum`,
  // §3.7 (p.12-13)
  masterLabel: (n) => `DeviceObject/masterPresetBank/$bank/@items/${Number(n)}/control/@props/label`,
  screenMemoryLabel: (n) => `DeviceObject/presetBank/$bank/@items/${Number(n)}/control/@props/label`,
  // §3.8 (p.13)
  transition: (key) => `DeviceObject/$screenAuxGroup/@items/${key}/status/@props/transition`,
  globalUpdate: () => 'DeviceObject/$screenAuxGroup/control/@props/xUpdate',
  // §3.11 (p.16)
  lastScreenMemory: (key, side) => `DeviceObject/presetBank/status/presetId/${coll(key)}/@items/${key}/$preset/@items/${side}/@props/id`,
  // §3.12 (p.16-17)
  lastMasterMemory: (mode) => `DeviceObject/masterPresetBank/status/lastUsed/$presetMode/@items/${mode === 'program' ? 'PROGRAM' : 'PREVIEW'}/@props/memoryId`,
  // §5.1.1-5.1.2 (p.21-22)
  audioInMute: (input, ch) => `DeviceObject/audio/control/$device/@items/1/$rx/@items/INPUT_${Number(input)}_CHANNEL_${Number(ch)}/control/@props/mute`,
  // §5.2.1-5.2.2 (p.22-23)
  audioOutMute: (output, ch) => `DeviceObject/audio/control/$device/@items/1/$tx/@items/OUTPUT_${Number(output)}/$channel/@items/${Number(ch)}/control/@props/mute`,
  // §6.1 (p.24-25)
  input: {
    isEnabled: (n) => `DeviceObject/$input/@items/${inp(n)}/status/@props/isEnabled`,
    capability: (n) => `DeviceObject/$input/@items/${inp(n)}/status/@props/capability`,
    label: (n) => `DeviceObject/$input/@items/${inp(n)}/control/@props/label`,
    isAvailable: (n) => `DeviceObject/$input/@items/${inp(n)}/status/@props/isAvailable`,
    freeze: (n) => `DeviceObject/$input/@items/${inp(n)}/control/@props/freeze`, // get documented; replace INFERRED
    device: (n) => `DeviceObject/$input/@items/${inp(n)}/mapping/@props/device`,
    scope: (n) => `DeviceObject/$input/@items/${inp(n)}/status/@props/scope`,
  },
  // §6.4-6.6 (p.28-29)
  inputBackupSource: (n, slot) => `DeviceObject/$input/@items/${inp(n)}/backup/$slot/@items/${Number(slot)}/control/@props/source`,
  inputBackupSelect: (n) => `DeviceObject/$input/@items/${inp(n)}/backup/control/@props/xSelectSlot`,
  inputBackupAuto: (n) => `DeviceObject/$input/@items/${inp(n)}/backup/control/@props/enableAutoSelect`,
  // §6.7-6.9 (p.29-30)
  bgBackupSource: (key, set, slot) => `DeviceObject/preconfig/backgrounds/$screen/@items/${key}/$backgroundSet/@items/${Number(set)}/backup/$slot/@items/${Number(slot)}/control/@props/source`,
  bgBackupSelect: (key, set) => `DeviceObject/preconfig/backgrounds/$screen/@items/${key}/$backgroundSet/@items/${Number(set)}/backup/control/@props/xSelectSlot`,
  bgBackupAuto: (key, set) => `DeviceObject/preconfig/backgrounds/$screen/@items/${key}/$backgroundSet/@items/${Number(set)}/backup/control/@props/enableAutoSelect`,
  // §6.10-6.11 (p.30)
  groupBackupSelect: (g) => `DeviceObject/backup/$group/@items/GROUP_${Number(g)}/control/@props/xSelectSlot`,
  groupBackupAuto: (g) => `DeviceObject/backup/$group/@items/GROUP_${Number(g)}/control/@props/enableAutoSelect`,
  // §1.4 (p.4-5)
  subscriptions: () => 'Subscriptions',
};

// AWJ source strings (§3.6 p.12: LIVE_X, STILL_X, SCREEN_X, NATIVE_X, COLOR, NONE) <-> REST {sourceType, sourceId} (REST p.15)
function awjToRest(v) {
  const s = String(v || 'NONE');
  let m;
  if ((m = /^LIVE_(\d+)$/.exec(s))) return { sourceType: 'input', sourceId: +m[1] };
  if ((m = /^STILL_(\d+)$/.exec(s))) return { sourceType: 'image', sourceId: +m[1] };
  if ((m = /^SCREEN_(\d+)$/.exec(s))) return { sourceType: 'screen', sourceId: +m[1] };
  if ((m = /^NATIVE_(\d+)$/.exec(s))) return { sourceType: 'background-set', sourceId: +m[1] };
  if (s === 'COLOR') return { sourceType: 'color', sourceId: 0 };
  return { sourceType: 'none', sourceId: 0 };
}
function restToAwj(t, id) {
  switch (t) {
    case 'input': return `LIVE_${id}`;
    case 'image': return `STILL_${id}`;
    case 'screen': return `SCREEN_${id}`;
    case 'background-set': return `NATIVE_${id}`;
    case 'color': return 'COLOR';
    default: return 'NONE';
  }
}

module.exports = { P, coll, awjToRest, restToAwj };
