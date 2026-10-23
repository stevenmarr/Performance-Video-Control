'use strict';
// 0.10.0 ATEM byte layouts for the router, audio, keyer, DSK and SuperSource commands, checked byte for byte against
// LibAtem-generated vectors (test/fixtures/atem-vectors.json; see the note in it). Pure buffers, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/drivers/atem-proto');
const { vectors } = require('./fixtures/atem-vectors.json');

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('-');
const body = (v) => Buffer.from(v.bytes.split('-').map((x) => parseInt(x, 16))).subarray(8);
const B = (c) => ({ borderEnabled: c.enabled, borderBevel: c.bevel, borderOuterWidth: c.outerWidth, borderInnerWidth: c.innerWidth, borderOuterSoftness: c.outerSoftness, borderInnerSoftness: c.innerSoftness, borderBevelSoftness: c.bevelSoftness,
  borderBevelPosition: c.bevelPosition, borderHue: c.hue, borderSaturation: c.saturation, borderLuma: c.luma, borderLightSourceDirection: c.lightSourceDirection, borderLightSourceAltitude: c.lightSourceAltitude });
const DVE = (c) => ({ sizeX: c.sizeX, sizeY: c.sizeY, positionX: c.positionX, positionY: c.positionY, rotation: c.rotation, borderEnabled: c.borderEnabled, shadowEnabled: c.borderShadowEnabled, borderBevel: c.borderBevel,
  borderOuterWidth: c.borderOuterWidth, borderInnerWidth: c.borderInnerWidth, borderOuterSoftness: c.borderOuterSoftness, borderInnerSoftness: c.borderInnerSoftness, borderBevelSoftness: c.borderBevelSoftness, borderBevelPosition: c.borderBevelPosition,
  borderOpacity: c.borderOpacity, borderHue: c.borderHue, borderSaturation: c.borderSaturation, borderLuma: c.borderLuma, lightSourceDirection: c.lightSourceDirection, lightSourceAltitude: c.lightSourceAltitude, maskEnabled: c.maskEnabled,
  maskTop: c.maskTop, maskBottom: c.maskBottom, maskLeft: c.maskLeft, maskRight: c.maskRight, rate: c.rate });
const MASK = (c) => ({ enabled: c.maskEnabled, top: c.maskTop, bottom: c.maskBottom, left: c.maskLeft, right: c.maskRight });

// setter name -> (converted LibAtem values) => serialized command
const SET = {
  CMvI: (c) => P.OUT.mvSource(c.multiviewIndex, c.windowIndex, c.source),
  CKTp: (c) => P.OUT.uskType(c.mixEffectIndex, c.keyerIndex, { type: c.keyType, flyEnabled: c.flyEnabled }, c.mask),
  CKeF: (c) => P.OUT.uskFill(c.mixEffectIndex, c.keyerIndex, c.fillSource),
  CKeC: (c) => P.OUT.uskCut(c.mixEffectIndex, c.keyerIndex, c.cutSource),
  CKMs: (c) => P.OUT.uskMask(c.mixEffectIndex, c.keyerIndex, MASK(c), c.mask),
  CKLm: (c) => P.OUT.uskLuma(c.mixEffectIndex, c.keyerIndex, c, c.mask),
  CKCk: (c) => P.OUT.uskChroma(c.mixEffectIndex, c.keyerIndex, c, c.mask),
  CKPt: (c) => P.OUT.uskPattern(c.mixEffectIndex, c.keyerIndex, { style: c.pattern, size: c.size, symmetry: c.symmetry, softness: c.softness, positionX: c.xPosition, positionY: c.yPosition, invert: c.inverse }, c.mask),
  CKDV: (c) => P.OUT.uskDve(c.mixEffectIndex, c.keyerIndex, DVE(c), c.mask),
  SFKF: (c) => P.OUT.uskFlyStore(c.mixEffectIndex, c.keyerIndex, c.keyFrame),
  CDsF: (c) => P.OUT.dskFill(c.index, c.fillSource),
  CDsC: (c) => P.OUT.dskCut(c.index, c.cutSource),
  CDsG: (c) => P.OUT.dskGeneral(c.index, { preMultiply: c.preMultipliedKey, clip: c.clip, gain: c.gain, invert: c.invert }, c.mask),
  CDsM: (c) => P.OUT.dskMask(c.index, MASK(c), c.mask),
  CDsR: (c) => P.OUT.dskRate(c.index, c.rate),
  CSBP: (c, v) => P.OUT.ssBox(c.sSrcId, c.boxIndex, { enabled: c.enabled, source: c.source, x: c.positionX, y: c.positionY, size: c.size, cropped: c.cropped, cropTop: c.cropTop, cropBottom: c.cropBottom, cropLeft: c.cropLeft, cropRight: c.cropRight }, c.mask, v.version),
  CSSc: (c) => P.OUT.ssProps(c.sSrcId, c, c.mask),
  CSBd: (c) => P.OUT.ssBorder(c.sSrcId, B(c), c.mask),
  CAMI: (c) => P.OUT.classicInput(c.index, c, c.mask),
  CAMM: (c) => P.OUT.classicMaster(c, c.mask),
  CAMm: (c) => P.OUT.classicMonitor(c, c.mask),
  CAMH: (c) => P.OUT.classicHeadphones(c, c.mask),
  CFSP: (c) => P.OUT.flSource(c.index, c.sourceId, c, c.mask),
  CFMP: (c) => P.OUT.flMaster({ ...c, faderGain: c.gain }, c.mask),
  CFMH: (c) => P.OUT.flMonitor({ ...c, inputMasterMuted: !c.inputMasterEnabled, inputTalkbackMuted: !c.inputTalkbackEnabled }, c.mask),
  AROC: (c) => P.OUT.audioRoute(c.id, c.sourceId, c.mask, c.name),
};

test('setters serialize byte-for-byte like LibAtem', () => {
  let n = 0;
  for (const v of vectors) {
    const f = SET[v.name]; if (!f) continue;
    assert.equal(hex(f(v.c, v)), v.bytes, `${v.name} ${JSON.stringify(v.c)}`); n++;
  }
  assert.ok(n >= 60, `only ${n} setter vectors`);
});

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const GET = {
  MvIn: (s, c) => assert.deepEqual(s.mv[c.multiviewIndex].windows[c.windowIndex], { index: c.windowIndex, source: c.source, vu: c.supportVuMeter, safeArea: c.supportsSafeArea }),
  MvPr: (s, c) => { assert.equal(s.mv[c.multiviewIndex].layout, c.layout); assert.equal(s.mv[c.multiviewIndex].swapped, c.programPreviewSwapped); },
  // _MvC is not checked: from V8.1.1 LibAtem puts the window count in byte 0 while atem-connection (used against real units) reads byte 1; the driver follows atem-connection
  _SSC: (s, c) => assert.equal(s.ssConfig[c.sSrcId].boxCount, c.boxes),
  _AMC: (s, c) => assert.deepEqual(s.audioMixer, { type: 'classic', inputs: c.inputs, monitors: c.monitors, headphones: c.headphones }),
  _FAC: (s, c) => assert.deepEqual(s.audioMixer, { type: 'fairlight', inputs: c.inputs, monitors: c.monitors }),
  KeBP: (s, c) => { const k = s.mes[c.mixEffectIndex].keyers[c.keyerIndex]; assert.deepEqual({ type: k.type, canFlyKey: k.canFlyKey, flyEnabled: k.flyEnabled, fill: k.fill, cut: k.cut, mask: k.mask }, { type: c.keyType, canFlyKey: c.canFlyKey, flyEnabled: c.flyEnabled, fill: c.fillSource, cut: c.cutSource, mask: MASK(c) }); },
  KeLm: (s, c) => assert.deepEqual(s.mes[c.mixEffectIndex].keyers[c.keyerIndex].luma, { preMultiplied: c.preMultiplied, clip: c.clip, gain: c.gain, invert: c.invert }),
  KeCk: (s, c) => assert.deepEqual(s.mes[c.mixEffectIndex].keyers[c.keyerIndex].chroma, { hue: c.hue, gain: c.gain, ySuppress: c.ySuppress, lift: c.lift, narrow: c.narrow }),
  KePt: (s, c) => assert.deepEqual(s.mes[c.mixEffectIndex].keyers[c.keyerIndex].pattern, { style: c.pattern, size: c.size, symmetry: c.symmetry, softness: c.softness, positionX: c.xPosition, positionY: c.yPosition, invert: c.inverse }),
  KeDV: (s, c) => assert.deepEqual(s.mes[c.mixEffectIndex].keyers[c.keyerIndex].dve, DVE(c)),
  KeFS: (s, c) => { const f = s.mes[c.mixEffectIndex].keyers[c.keyerIndex].fly; assert.equal(f.isASet, c.isASet); assert.equal(f.isBSet, c.isBSet); assert.equal(f.runningToKeyFrame, c.runningToKeyFrame); assert.equal(f.runToInfiniteIndex, c.runningToInfinite); },
  DskB: (s, c) => { assert.equal(s.dsk[c.index].fill, c.fillSource); assert.equal(s.dsk[c.index].cut, c.cutSource); },
  DskP: (s, c) => { const d = s.dsk[c.index]; assert.deepEqual({ tie: d.tie, rate: d.rate, preMultiply: d.preMultiply, clip: d.clip, gain: d.gain, invert: d.invert, mask: d.mask }, { tie: c.tie, rate: c.rate, preMultiply: c.preMultipliedKey, clip: c.clip, gain: c.gain, invert: c.invert, mask: MASK(c) }); },
  SSBP: (s, c) => assert.deepEqual(s.ss[c.sSrcId || 0].boxes[c.boxIndex], { index: c.boxIndex, enabled: c.enabled, source: c.source, x: c.positionX, y: c.positionY, size: c.size, cropped: c.cropped, cropTop: c.cropTop, cropBottom: c.cropBottom, cropLeft: c.cropLeft, cropRight: c.cropRight }),
  SSrc: (s, c) => assert.deepEqual(s.ss[c.sSrcId || 0].props, { artFillSource: c.artFillSource, artCutSource: c.artCutSource, artOption: c.artOption, artPreMultiplied: c.artPreMultiplied, artClip: c.artClip, artGain: c.artGain, artInvertKey: c.artInvertKey }),
  SSBd: (s, c) => assert.deepEqual(s.ss[c.sSrcId].border, B(c)),
  AMIP: (s, c) => { const i = s.classic.inputs[c.index]; assert.equal(i.mixOption, c.mixOption); assert.equal(i.portType, c.portType); near(P.u16ToDb(i.gain), c.gain, 0.01, 'gain'); near(P.intToBal(i.balance) / 1, Math.round(c.balance * 200) / 200, 1, 'balance'); assert.equal(i.rcaToXlrEnabled, c.rcaToXlrEnabled); },
  AMMO: (s, c) => { near(P.u16ToDb(s.classic.master.gain), c.gain, 0.01, 'gain'); assert.equal(s.classic.master.followFadeToBlack, c.followFadeToBlack); },
  AMmO: (s, c) => { const m = s.classic.monitor; assert.equal(m.enabled, c.enabled); assert.equal(m.mute, c.mute); assert.equal(m.solo, c.solo); assert.equal(m.soloSource, c.soloSource); assert.equal(m.dim, c.dim); near(P.u16ToDb(m.gain), c.gain, 0.01, 'gain'); },
  AMHP: (s, c) => { near(P.u16ToDb(s.classic.headphones.gain), c.gain, 0.01, 'gain'); near(P.u16ToDb(s.classic.headphones.talkbackGain), c.talkbackGain, 0.01, 'tb'); },
  AMPP: (s, c) => assert.equal(s.classic.afv, c.audioFollowVideo),
  FAIP: (s, c) => assert.deepEqual(s.fairlight.inputs[c.index].props, { inputType: c.inputType, externalPortType: c.externalPortType, supportedConfigurations: c.supportedConfigurations, activeConfiguration: c.activeConfiguration, supportedInputLevels: c.supportedInputLevels, activeInputLevel: c.activeInputLevel }),
  FASP: (s, c) => { const x = s.fairlight.inputs[c.index].sources[c.sourceId]; assert.deepEqual({ g: x.gain, b: x.balance, f: x.faderGain, m: x.mixOption, sm: x.supportedMixOptions, d: x.framesDelay, eq: x.equalizerGain, mu: x.makeUpGain },
    { g: c.gain, b: c.balance, f: c.faderGain, m: c.mixOption, sm: c.supportedMixOptions, d: c.framesDelay, eq: c.equalizerGain, mu: c.makeUpGain }); },
  FAMP: (s, c) => { assert.equal(s.fairlight.master.faderGain, c.gain); assert.equal(s.fairlight.master.makeUpGain, c.makeUpGain); assert.equal(s.fairlight.master.followFadeToBlack, c.followFadeToBlack); },
  FMHP: (s, c) => assert.deepEqual({ g: s.fairlight.monitor.gain, mg: s.fairlight.monitor.inputMasterGain, mm: s.fairlight.monitor.inputMasterMuted, sg: s.fairlight.monitor.inputSidetoneGain }, { g: c.gain, mg: c.inputMasterGain, mm: !c.inputMasterEnabled, sg: c.inputSidetoneGain }),
  AROP: (s, c) => assert.deepEqual(s.routing.outputs[c.id], { id: c.id, output: c.audioOutputId, pair: c.audioChannelPair, source: c.sourceId, externalPortType: c.externalPortType, internalPortType: c.internalPortType, name: c.name }),
  ARSP: (s, c) => assert.deepEqual(s.routing.sources[c.id], { id: c.id, source: c.audioInputId, pair: c.audioChannelPair, externalPortType: c.externalPortType, internalPortType: c.internalPortType, name: c.name }),
};

test('getters parse LibAtem bytes into the driver state', () => {
  let n = 0;
  for (const v of vectors) {
    const f = GET[v.name]; if (!f) continue;
    const st = P.emptyState(); st.version = v.version;
    assert.equal(P.applyCommand(st, v.name, body(v)), true, v.name);
    try { f(st, v.c); } catch (e) { e.message = `${v.name}: ${e.message}`; throw e; } n++;
  }
  assert.ok(n >= 60, `only ${n} getter vectors`);
});

test('classic audio dB helpers round-trip', () => {
  assert.equal(P.dbToU16(0), 32768); assert.equal(P.u16ToDb(32768), 0); assert.equal(P.dbToU16(-Infinity), 0); assert.equal(P.u16ToDb(0), -Infinity);
  for (const db of [-40, -12.5, -3, 0, 3, 6]) near(P.u16ToDb(P.dbToU16(db)), db, 0.05, String(db));
});
