'use strict';
// ATEM layout editor: SuperSource boxes and upstream DVE keys as one picture, then as
// switcher commands and as an ATEM Software Control macro.
//
// The raster is the 32×18 frame centered on the origin (±16 across, ±9 up) used by
// Software Control exports. SuperSource x/y are that frame ×100, size and crop ×1000.
// DVE position and size are the same frame ×1000. Positive y is up.
//
// Macro Op ids that appear in real Software Control exports (Constellation / the public
// snippet catalogs built from those exports) are marked export-confirmed in docs/atem-layout.md.
// Ops that only share that family's prefix are marked there too. Nothing here has been
// imported on a switcher; playing a macro from Control Center sends the protocol commands
// the driver already speaks (CSBP, CKDV, SFKF, …), which the simulator applies.
//
// A macro sets the end state. It does not interpolate. Fly key frames are stored after the
// geometry (SFKF / FlyKeyStoreKeyFrame) so the switcher can run between them later.

const FRAME = { width: 32, height: 18, left: -16, right: 16, top: 9, bottom: -9 };
const PATTERNS = ['LeftToRightBar', 'TopToBottomBar', 'HorizontalBarnDoor', 'VerticalBarnDoor', 'CornersInFourBox', 'RectangleIris', 'DiamondIris', 'CircleIris', 'TopLeftBox', 'TopRightBox', 'BottomRightBox', 'BottomLeftBox', 'TopCentreBox', 'RightCentreBox', 'BottomCentreBox', 'LeftCentreBox', 'TopLeftDiagonal', 'TopRightDiagonal'];
const BEVELS = ['None', 'In', 'Out', 'InOut'];
const KEY_TYPES = ['luma', 'chroma', 'pattern', 'dve'];

const SS_BOX = ['enabled', 'source', 'x', 'y', 'size', 'cropped', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight'];
const SS_PROPS = ['artFillSource', 'artCutSource', 'artOption', 'artPreMultiplied', 'artClip', 'artGain', 'artInvertKey'];
const SS_BORDER = ['borderEnabled', 'borderBevel', 'borderOuterWidth', 'borderInnerWidth', 'borderOuterSoftness', 'borderInnerSoftness', 'borderBevelSoftness', 'borderBevelPosition', 'borderHue', 'borderSaturation', 'borderLuma', 'borderLightSourceDirection', 'borderLightSourceAltitude'];
const DVE = ['sizeX', 'sizeY', 'positionX', 'positionY', 'rotation', 'borderEnabled', 'shadowEnabled', 'borderBevel', 'borderOuterWidth', 'borderInnerWidth', 'borderOuterSoftness', 'borderInnerSoftness', 'borderBevelSoftness', 'borderBevelPosition', 'borderOpacity', 'borderHue', 'borderSaturation', 'borderLuma', 'lightSourceDirection', 'lightSourceAltitude', 'maskEnabled', 'maskTop', 'maskBottom', 'maskLeft', 'maskRight', 'rate'];
const KEY_MASK = ['enabled', 'top', 'bottom', 'left', 'right'];
const LUMA = ['preMultiplied', 'clip', 'gain', 'invert'];
const CHROMA = ['hue', 'gain', 'ySuppress', 'lift', 'narrow'];
const PATTERN = ['style', 'size', 'symmetry', 'softness', 'positionX', 'positionY', 'invert'];

const FIELDS = {
  ssBox: SS_BOX,
  ssProps: SS_PROPS,
  ssBorder: SS_BORDER,
  uskDve: DVE,
  uskMask: KEY_MASK,
  uskLuma: LUMA,
  uskChroma: CHROMA,
  uskPattern: PATTERN,
  uskType: ['type', 'flyEnabled'],
  uskSources: ['fill', 'cut'],
  uskOnAir: ['on'],
  uskFlyStore: ['frame'],
};

const BOOL = new Set(['on', 'enabled', 'cropped', 'flyEnabled', 'preMultiplied', 'invert', 'narrow', 'artPreMultiplied', 'artInvertKey', 'borderEnabled', 'shadowEnabled', 'maskEnabled']);
const STR = new Set(['type', 'frame']);

const CLAMP = {
  x: [-4800, 4800], y: [-2700, 2700], size: [70, 1000],
  cropTop: [0, 18000], cropBottom: [0, 18000], cropLeft: [0, 32000], cropRight: [0, 32000],
  positionX: [-32000, 32000], positionY: [-18000, 18000], sizeX: [0, 99000], sizeY: [0, 99000], rotation: [-36000, 36000],
  borderOuterWidth: [0, 1600], borderInnerWidth: [0, 1600],
  borderHue: [0, 3599], borderSaturation: [0, 1000], borderLuma: [0, 1000],
  lightSourceDirection: [0, 3599], borderLightSourceDirection: [0, 3599],
  lightSourceAltitude: [0, 100], borderLightSourceAltitude: [0, 100],
  borderOuterSoftness: [0, 100], borderInnerSoftness: [0, 100], borderBevelSoftness: [0, 100], borderBevelPosition: [0, 100], borderOpacity: [0, 100],
  borderBevel: [0, 3],
  artClip: [0, 1000], artGain: [0, 1000], artOption: [0, 1],
  clip: [0, 1000], gain: [0, 1000], hue: [0, 3599], ySuppress: [0, 1000], lift: [0, 1000],
  style: [0, 17], symmetry: [0, 10000], softness: [0, 10000],
  rate: [1, 250],
  top: [-9000, 9000], bottom: [-9000, 9000], left: [-16000, 16000], right: [-16000, 16000],
  maskTop: [0, 18000], maskBottom: [0, 18000], maskLeft: [0, 32000], maskRight: [0, 32000],
};

function clamp(k, v) {
  const n = Math.round(Number(v) || 0);
  const r = CLAMP[k];
  if (!r) return n;
  return Math.max(r[0], Math.min(r[1], n));
}
function bool(v) { return v === true || v === 'True' || v === 'true' || v === 1 || v === '1'; }
function fixed(n) {
  if (!Number.isFinite(n)) return '0';
  const v = Math.round(n * 1e6) / 1e6;
  return String(v);
}
function xmlEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function flag(v) { return v ? 'True' : 'False'; }

// Protocol source id → the symbolic name Software Control writes in input="…".
function sourceToken(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return 'Black';
  if (n === 0) return 'Black';
  if (n === 1000) return 'ColorBars';
  if (n === 2001) return 'Color1';
  if (n === 2002) return 'Color2';
  if (n >= 1 && n < 1000) return `Camera${n}`;
  if (n >= 3010 && n < 4000) { const m = Math.floor((n - 3000) / 10); return n % 10 === 0 ? `MediaPlayer${m}` : `MediaPlayer${m}Key`; }
  if (n >= 4010 && n < 5000) return `Key${(n - 4000) / 10}Mask`;
  if (n >= 5010 && n < 6000) return `DSK${(n - 5000) / 10}Mask`;
  if (n === 6000) return 'SuperSource';
  if (n >= 6001 && n < 7000) return `SuperSource${n - 5999}`;
  if (n >= 7001 && n < 8000) return `CleanFeed${n - 7000}`;
  if (n >= 8001 && n < 9000) return `Aux${n - 8000}`;
  if (n >= 10010 && n < 11000) { const me = Math.floor((n - 10000) / 10); return n % 10 === 1 ? `ME${me}Preview` : `ME${me}Program`; }
  return String(n);
}

// Screen percents of the program raster. x/y are frame units (+y up); sx/sy are 1 = full frame.
function rectOf(x, y, sx, sy) {
  const width = sx * 100;
  const height = sy * 100;
  const left = ((x + 16) / 32) * 100 - width / 2;
  const top = ((9 - y) / 18) * 100 - height / 2;
  return { left, top, width, height };
}
function unitsOf(left, top, width, height) {
  const sx = width / 100;
  const sy = height / 100;
  const x = ((left + width / 2) / 100) * 32 - 16;
  const y = 9 - ((top + height / 2) / 100) * 18;
  return { x, y, sx, sy };
}

// Snap a frame-unit value to the nearest target within threshold.
function snap(value, targets, threshold = 0.35) {
  let best = value; let dist = threshold;
  for (const t of targets || []) { const d = Math.abs(value - t); if (d <= dist) { best = t; dist = d; } }
  return best;
}
function guideTargets() {
  const third = 32 / 3;
  const xs = [-16, -16 + third, 0, -16 + 2 * third, 16, -14.4, 14.4, -12.8, 12.8];
  const ys = [9, 3, 0, -3, -9, 8.1, -8.1, 7.2, -7.2];
  return { x: xs, y: ys };
}

function capsFromView(view) {
  const v = view || {};
  const mes = v.mixEffects || [];
  return {
    superSources: (v.superSources || []).length,
    boxCounts: (v.superSources || []).map((s) => (s.boxes || []).length),
    mes: mes.length,
    keyersByMe: mes.map((m) => (m.keyers || []).length),
    dve: (v.dves && v.dves.count) || (v.profile && v.profile.dve) || 0,
    dveElsewhere(me) {
      let n = 0;
      for (const m of mes) {
        if (m.index === me) continue;
        for (const k of m.keyers || []) if (k.type === 'dve') n += 1;
      }
      return n;
    },
  };
}

function pick(src, keys, limits) {
  const o = {};
  if (!src) return o;
  for (const k of keys) {
    if (src[k] === undefined || src[k] === null) continue;
    if (BOOL.has(k)) o[k] = !!src[k];
    else if (STR.has(k)) o[k] = String(src[k]);
    else {
      const n = Math.round(Number(src[k]) || 0);
      const r = (limits && limits[k]) || CLAMP[k];
      o[k] = r ? Math.max(r[0], Math.min(r[1], n)) : n;
    }
  }
  return o;
}
const PATTERN_LIMITS = { size: [0, 10000], symmetry: [0, 10000], softness: [0, 10000], positionX: [0, 10000], positionY: [0, 10000], style: [0, 17] };

function normalize(layout) {
  const src = layout && typeof layout === 'object' ? layout : {};
  const me = Math.max(0, Math.min(7, Math.round(Number(src.me) || 0)));
  const ss = src.ss === null || src.ss === undefined ? null : Math.max(0, Math.min(7, Math.round(Number(src.ss) || 0)));
  const boxes = (Array.isArray(src.boxes) ? src.boxes : []).slice(0, 4).map((b, i) => {
    const box = pick(b, SS_BOX);
    box.index = Number.isInteger(Number(b && b.index)) ? Number(b.index) : i;
    return box;
  });
  const keys = (Array.isArray(src.keys) ? src.keys : []).slice(0, 4).map((k, i) => {
    const type = KEY_TYPES.includes(k && k.type) ? k.type : 'luma';
    return {
      index: Number.isInteger(Number(k && k.index)) ? Number(k.index) : i,
      onAir: !!(k && k.onAir),
      type,
      flyEnabled: !!(k && k.flyEnabled),
      fill: k && k.fill !== undefined && k.fill !== null ? Math.round(Number(k.fill) || 0) : undefined,
      cut: k && k.cut !== undefined && k.cut !== null ? Math.round(Number(k.cut) || 0) : undefined,
      luma: k && k.luma ? pick(k.luma, LUMA) : null,
      chroma: k && k.chroma ? pick(k.chroma, CHROMA) : null,
      pattern: k && k.pattern ? pick(k.pattern, PATTERN, PATTERN_LIMITS) : null,
      mask: k && k.mask ? pick(k.mask, KEY_MASK) : null,
      dve: k && k.dve ? pick(k.dve, DVE) : null,
    };
  });
  return {
    me, ss,
    art: src.art ? pick(src.art, SS_PROPS) : null,
    border: src.border ? pick(src.border, SS_BORDER) : null,
    boxes, keys,
  };
}

function fromView(view, { me = 0, ss = 0 } = {}) {
  const m = (view.mixEffects || [])[me];
  const s = (view.superSources || [])[ss];
  return normalize({
    me,
    ss: s ? ss : null,
    art: s ? s.props : null,
    border: s ? s.border : null,
    boxes: s ? (s.boxes || []).map((b) => ({ ...b })) : [],
    keys: m ? (m.keyers || []).map((k) => ({ ...k })) : [],
  });
}

function op(id, attrs) { return { id, attrs }; }
function meAttrs(me, key) { return { mixEffectBlockIndex: String(me), keyIndex: String(key) }; }

function ssOps(layout) {
  const ss = String(layout.ss || 0);
  const out = [];
  const art = layout.art;
  if (art) {
    if (art.artFillSource !== undefined) out.push(op('SuperSourceV2ArtFillInput', { superSource: ss, input: sourceToken(art.artFillSource) }));
    if (art.artCutSource !== undefined) out.push(op('SuperSourceV2ArtCutInput', { superSource: ss, input: sourceToken(art.artCutSource) }));
    if (art.artOption !== undefined) out.push(op('SuperSourceV2ArtAbove', { superSource: ss, artAbove: flag(art.artOption === 1) }));
    if (art.artPreMultiplied !== undefined) out.push(op('SuperSourceV2ArtPreMultiply', { superSource: ss, preMultiply: flag(art.artPreMultiplied) }));
    if (art.artClip !== undefined) out.push(op('SuperSourceV2ArtClip', { superSource: ss, clip: fixed(art.artClip / 1000) }));
    if (art.artGain !== undefined) out.push(op('SuperSourceV2ArtGain', { superSource: ss, gain: fixed(art.artGain / 1000) }));
    if (art.artInvertKey !== undefined) out.push(op('SuperSourceV2ArtInvert', { superSource: ss, invert: flag(art.artInvertKey) }));
  }
  const bd = layout.border;
  if (bd) {
    const b = { superSource: ss };
    if (bd.borderEnabled !== undefined) out.push(op('SuperSourceV2BorderEnable', { ...b, enable: flag(bd.borderEnabled) }));
    if (bd.borderBevel !== undefined) out.push(op('SuperSourceV2BorderBevel', { ...b, bevel: BEVELS[bd.borderBevel] || 'None' }));
    if (bd.borderOuterWidth !== undefined) out.push(op('SuperSourceV2BorderOuterWidth', { ...b, outerWidth: fixed(bd.borderOuterWidth / 100) }));
    if (bd.borderInnerWidth !== undefined) out.push(op('SuperSourceV2BorderInnerWidth', { ...b, innerWidth: fixed(bd.borderInnerWidth / 100) }));
    if (bd.borderOuterSoftness !== undefined) out.push(op('SuperSourceV2BorderOuterSoftness', { ...b, outerSoftness: String(bd.borderOuterSoftness) }));
    if (bd.borderInnerSoftness !== undefined) out.push(op('SuperSourceV2BorderInnerSoftness', { ...b, innerSoftness: String(bd.borderInnerSoftness) }));
    if (bd.borderBevelSoftness !== undefined) out.push(op('SuperSourceV2BorderBevelSoftness', { ...b, bevelSoftness: String(bd.borderBevelSoftness) }));
    if (bd.borderBevelPosition !== undefined) out.push(op('SuperSourceV2BorderBevelPosition', { ...b, bevelPosition: String(bd.borderBevelPosition) }));
    if (bd.borderHue !== undefined) out.push(op('SuperSourceV2BorderHue', { ...b, hue: fixed(bd.borderHue / 10) }));
    if (bd.borderSaturation !== undefined) out.push(op('SuperSourceV2BorderSaturation', { ...b, saturation: fixed(bd.borderSaturation / 1000) }));
    if (bd.borderLuma !== undefined) out.push(op('SuperSourceV2BorderLuminescence', { ...b, luminescence: fixed(bd.borderLuma / 1000) }));
    if (bd.borderLightSourceDirection !== undefined) out.push(op('SuperSourceV2BorderLightSourceDirection', { ...b, direction: fixed(bd.borderLightSourceDirection / 10) }));
    if (bd.borderLightSourceAltitude !== undefined) out.push(op('SuperSourceV2BorderLightSourceAltitude', { ...b, altitude: String(bd.borderLightSourceAltitude) }));
  }
  for (const box of layout.boxes) {
    const c = { superSource: ss, boxIndex: String(box.index) };
    if (box.enabled !== undefined) out.push(op('SuperSourceV2BoxEnable', { ...c, enable: flag(box.enabled) }));
    if (box.source !== undefined) out.push(op('SuperSourceV2BoxInput', { ...c, input: sourceToken(box.source) }));
    if (box.x !== undefined) out.push(op('SuperSourceV2BoxXPosition', { ...c, xPosition: fixed(box.x / 100) }));
    if (box.y !== undefined) out.push(op('SuperSourceV2BoxYPosition', { ...c, yPosition: fixed(box.y / 100) }));
    if (box.size !== undefined) out.push(op('SuperSourceV2BoxSize', { ...c, size: fixed(box.size / 1000) }));
    if (box.cropped !== undefined) out.push(op('SuperSourceV2BoxMaskEnable', { ...c, enable: flag(box.cropped) }));
    if (box.cropTop !== undefined) out.push(op('SuperSourceV2BoxMaskTop', { ...c, top: fixed(box.cropTop / 1000) }));
    if (box.cropBottom !== undefined) out.push(op('SuperSourceV2BoxMaskBottom', { ...c, bottom: fixed(box.cropBottom / 1000) }));
    if (box.cropLeft !== undefined) out.push(op('SuperSourceV2BoxMaskLeft', { ...c, left: fixed(box.cropLeft / 1000) }));
    if (box.cropRight !== undefined) out.push(op('SuperSourceV2BoxMaskRight', { ...c, right: fixed(box.cropRight / 1000) }));
  }
  return out;
}

function dveOps(me, key, dve) {
  const c = meAttrs(me, key);
  const out = [];
  if (!dve) return out;
  if (dve.sizeX !== undefined) out.push(op('DVEAndFlyKeyXSize', { ...c, xSize: fixed(dve.sizeX / 1000) }));
  if (dve.sizeY !== undefined) out.push(op('DVEAndFlyKeyYSize', { ...c, ySize: fixed(dve.sizeY / 1000) }));
  if (dve.positionX !== undefined) out.push(op('DVEAndFlyKeyXPosition', { ...c, xPosition: fixed(dve.positionX / 1000) }));
  if (dve.positionY !== undefined) out.push(op('DVEAndFlyKeyYPosition', { ...c, yPosition: fixed(dve.positionY / 1000) }));
  if (dve.rotation !== undefined) out.push(op('DVEAndFlyKeyRotation', { ...c, rotation: fixed(dve.rotation / 10) }));
  if (dve.rate !== undefined) out.push(op('DVEAndFlyKeyRate', { ...c, rate: String(dve.rate) }));
  if (dve.borderEnabled !== undefined) out.push(op('DVEKeyBorderEnable', { ...c, enable: flag(dve.borderEnabled) }));
  if (dve.borderBevel !== undefined) out.push(op('DVEKeyBorderBevel', { ...c, bevel: BEVELS[dve.borderBevel] || 'None' }));
  if (dve.borderOuterWidth !== undefined) out.push(op('DVEKeyBorderOuterWidth', { ...c, outerWidth: fixed(dve.borderOuterWidth / 100) }));
  if (dve.borderInnerWidth !== undefined) out.push(op('DVEKeyBorderInnerWidth', { ...c, innerWidth: fixed(dve.borderInnerWidth / 100) }));
  if (dve.borderOuterSoftness !== undefined) out.push(op('DVEKeyBorderOuterSoftness', { ...c, outerSoftness: String(dve.borderOuterSoftness) }));
  if (dve.borderInnerSoftness !== undefined) out.push(op('DVEKeyBorderInnerSoftness', { ...c, innerSoftness: String(dve.borderInnerSoftness) }));
  if (dve.borderOpacity !== undefined) out.push(op('DVEKeyBorderOpacity', { ...c, opacity: String(dve.borderOpacity) }));
  if (dve.borderHue !== undefined) out.push(op('DVEKeyBorderHue', { ...c, hue: fixed(dve.borderHue / 10) }));
  if (dve.borderSaturation !== undefined) out.push(op('DVEKeyBorderSaturation', { ...c, saturation: fixed(dve.borderSaturation / 1000) }));
  if (dve.borderLuma !== undefined) out.push(op('DVEKeyBorderLuminescence', { ...c, luminescence: fixed(dve.borderLuma / 1000) }));
  if (dve.shadowEnabled !== undefined) out.push(op('DVEKeyShadowEnable', { ...c, enable: flag(dve.shadowEnabled) }));
  if (dve.lightSourceDirection !== undefined) out.push(op('DVEKeyShadowDirection', { ...c, direction: fixed(dve.lightSourceDirection / 10) }));
  if (dve.lightSourceAltitude !== undefined) out.push(op('DVEKeyShadowAltitude', { ...c, altitude: String(dve.lightSourceAltitude) }));
  if (dve.maskEnabled !== undefined) out.push(op('DVEKeyMaskEnable', { ...c, enable: flag(dve.maskEnabled) }));
  if (dve.maskTop !== undefined) out.push(op('DVEKeyMaskTop', { ...c, top: fixed(dve.maskTop / 1000) }));
  if (dve.maskBottom !== undefined) out.push(op('DVEKeyMaskBottom', { ...c, bottom: fixed(dve.maskBottom / 1000) }));
  if (dve.maskLeft !== undefined) out.push(op('DVEKeyMaskLeft', { ...c, left: fixed(dve.maskLeft / 1000) }));
  if (dve.maskRight !== undefined) out.push(op('DVEKeyMaskRight', { ...c, right: fixed(dve.maskRight / 1000) }));
  return out;
}

function keySettingOps(layout, key) {
  const c = meAttrs(layout.me, key.index);
  const out = [];
  const typeName = { luma: 'Luma', chroma: 'Chroma', pattern: 'Pattern', dve: 'DVE' }[key.type] || 'Luma';
  out.push(op('KeyType', { ...c, type: typeName }));
  if (key.type !== 'dve') out.push(op('KeyFlyEnable', { ...c, enable: flag(key.flyEnabled) }));
  if (key.fill !== undefined) out.push(op('KeyFillInput', { ...c, input: sourceToken(key.fill) }));
  if (key.cut !== undefined && key.type === 'luma') out.push(op('KeyCutInput', { ...c, input: sourceToken(key.cut) }));
  if (key.type === 'luma' && key.luma) {
    const l = key.luma;
    if (l.preMultiplied !== undefined) out.push(op('LumaKeyPreMultiply', { ...c, preMultiply: flag(l.preMultiplied) }));
    if (l.clip !== undefined) out.push(op('LumaKeyClip', { ...c, clip: fixed(l.clip / 1000) }));
    if (l.gain !== undefined) out.push(op('LumaKeyGain', { ...c, gain: fixed(l.gain / 1000) }));
    if (l.invert !== undefined) out.push(op('LumaKeyInvert', { ...c, invert: flag(l.invert) }));
  }
  if (key.type === 'chroma' && key.chroma) {
    const ch = key.chroma;
    if (ch.hue !== undefined) out.push(op('ChromaKeyHue', { ...c, hue: fixed(ch.hue / 10) }));
    if (ch.gain !== undefined) out.push(op('ChromaKeyGain', { ...c, gain: fixed(ch.gain / 1000) }));
    if (ch.ySuppress !== undefined) out.push(op('ChromaKeyYSuppress', { ...c, ySuppress: fixed(ch.ySuppress / 1000) }));
    if (ch.lift !== undefined) out.push(op('ChromaKeyLift', { ...c, lift: fixed(ch.lift / 1000) }));
    if (ch.narrow !== undefined) out.push(op('ChromaKeyNarrow', { ...c, narrow: flag(ch.narrow) }));
  }
  if (key.type === 'pattern' && key.pattern) {
    const p = key.pattern;
    if (p.style !== undefined) out.push(op('PatternKeyPattern', { ...c, pattern: PATTERNS[p.style] || PATTERNS[0] }));
    if (p.size !== undefined) out.push(op('PatternKeySize', { ...c, size: fixed(p.size / 10000) }));
    if (p.symmetry !== undefined) out.push(op('PatternKeySymmetry', { ...c, symmetry: fixed(p.symmetry / 10000) }));
    if (p.softness !== undefined) out.push(op('PatternKeySoftness', { ...c, softness: fixed(p.softness / 10000) }));
    if (p.positionX !== undefined) out.push(op('PatternKeyXPosition', { ...c, xPosition: fixed(p.positionX / 10000) }));
    if (p.positionY !== undefined) out.push(op('PatternKeyYPosition', { ...c, yPosition: fixed(p.positionY / 10000) }));
    if (p.invert !== undefined) out.push(op('PatternKeyInvert', { ...c, invert: flag(p.invert) }));
  }
  if (key.mask) {
    const m = key.mask;
    if (m.enabled !== undefined) out.push(op('KeyMaskEnable', { ...c, enable: flag(m.enabled) }));
    if (m.top !== undefined) out.push(op('KeyMaskTop', { ...c, top: fixed(m.top / 1000) }));
    if (m.bottom !== undefined) out.push(op('KeyMaskBottom', { ...c, bottom: fixed(m.bottom / 1000) }));
    if (m.left !== undefined) out.push(op('KeyMaskLeft', { ...c, left: fixed(m.left / 1000) }));
    if (m.right !== undefined) out.push(op('KeyMaskRight', { ...c, right: fixed(m.right / 1000) }));
  }
  if (key.type === 'dve' || key.flyEnabled) out.push(...dveOps(layout.me, key.index, key.dve));
  out.push(op('KeyOnAir', { ...c, onAir: flag(key.onAir) }));
  return out;
}

function flyStoreOp(me, key, frame) {
  return op('FlyKeyStoreKeyFrame', { ...meAttrs(me, key), keyFrame: frame === 'b' ? 'B' : 'A' });
}

function keySteps(layout, key, { geometryOnly = false } = {}) {
  const me = layout.me + 1;
  const id = { me, key: key.index };
  const steps = [];
  const push = (opName, args) => { if (Object.keys(args).length) steps.push({ op: opName, args: { ...id, ...args } }); };
  if (!geometryOnly) {
    push('uskType', { type: key.type, ...(key.type !== 'dve' ? { flyEnabled: !!key.flyEnabled } : {}) });
    const src = {};
    if (key.fill !== undefined) src.fill = key.fill;
    if (key.cut !== undefined && key.type === 'luma') src.cut = key.cut;
    push('uskSources', src);
    if (key.type === 'luma' && key.luma) push('uskLuma', key.luma);
    if (key.type === 'chroma' && key.chroma) push('uskChroma', key.chroma);
    if (key.type === 'pattern' && key.pattern) push('uskPattern', key.pattern);
    if (key.mask) push('uskMask', key.mask);
  } else {
    push('uskType', { type: 'dve' });
  }
  if (key.type === 'dve' || key.flyEnabled || geometryOnly) push('uskDve', key.dve || {});
  if (!geometryOnly) push('uskOnAir', { on: !!key.onAir });
  return steps.filter((s) => Object.keys(s.args).some((k) => k !== 'me' && k !== 'key'));
}

function ssSteps(layout) {
  const ss = layout.ss || 0;
  const steps = [];
  if (layout.art && Object.keys(layout.art).length) steps.push({ op: 'ssProps', args: { ss, ...layout.art } });
  if (layout.border && Object.keys(layout.border).length) steps.push({ op: 'ssBorder', args: { ss, ...layout.border } });
  for (const box of layout.boxes) {
    const args = { ss, box: box.index };
    for (const k of SS_BOX) if (box[k] !== undefined) args[k] = box[k];
    steps.push({ op: 'ssBox', args });
  }
  return steps;
}

// Fit a layout to the switcher in front of us. Extra boxes, keyers, SuperSources and
// DVE requests are dropped and listed in `skipped` rather than sent.
function fit(layout, caps) {
  const src = normalize(layout);
  const skipped = [];
  const c = caps || { superSources: src.ss === null ? 0 : 1, boxCounts: [4], mes: 1, keyersByMe: [4], dve: 4, dveElsewhere: () => 0 };
  if (!c.superSources || src.ss === null || src.ss >= c.superSources) {
    if (src.boxes.length || src.art || src.border) skipped.push({ what: 'SuperSource', reason: c.superSources ? `No SuperSource ${src.ss + 1}` : 'This model has no SuperSource' });
    src.boxes = []; src.art = null; src.border = null; src.ss = null;
  } else {
    const n = (c.boxCounts && c.boxCounts[src.ss]) || 4;
    const extra = src.boxes.filter((b) => b.index >= n);
    if (extra.length) skipped.push({ what: 'SuperSource boxes', reason: `This SuperSource has ${n} boxes` });
    src.boxes = src.boxes.filter((b) => b.index >= 0 && b.index < n);
  }
  const keyers = (c.keyersByMe && c.keyersByMe[src.me]) || 0;
  if (src.me >= (c.mes || 1)) {
    skipped.push({ what: `M/E ${src.me + 1}`, reason: 'This model has no such M/E' });
    src.keys = [];
  } else if (src.keys.some((k) => k.index >= keyers)) {
    skipped.push({ what: 'upstream keys', reason: `M/E ${src.me + 1} has ${keyers} upstream key${keyers === 1 ? '' : 's'}` });
    src.keys = src.keys.filter((k) => k.index >= 0 && k.index < keyers);
  }
  let budget = Math.max(0, (c.dve || 0) - (c.dveElsewhere ? c.dveElsewhere(src.me) : 0));
  for (const k of src.keys) {
    if (k.type !== 'dve' && !k.flyEnabled) continue;
    if (k.type === 'dve' && budget <= 0) {
      skipped.push({ what: `M/E ${src.me + 1} key ${k.index + 1}`, reason: 'No DVE left on this model' });
      k.type = 'luma'; k.flyEnabled = false; k.dve = null;
      continue;
    }
    if (k.type === 'dve') budget -= 1;
    if (!c.dve && k.flyEnabled) { k.flyEnabled = false; k.dve = null; }
  }
  return { layout: src, skipped };
}

function storeFrames(layout, frame) {
  const steps = [];
  const ops = [];
  for (const k of layout.keys) {
    if (k.type !== 'dve' && !k.flyEnabled) continue;
    steps.push({ op: 'uskFlyStore', args: { me: layout.me + 1, key: k.index, frame } });
    ops.push(flyStoreOp(layout.me, k.index, frame));
  }
  return { steps, ops };
}

// steps: Control Center macro / driver commands (1-based me, 0-based key, ss, box).
// ops: Software Control XML operations, in the same order. No run-to and no sleep,
// so the macro cuts to the layout instead of pretending to fly.
function build(layout, caps, { store = null, flyFrom = null } = {}) {
  const fitted = fit(layout, caps);
  const skipped = fitted.skipped.slice();
  const main = fitted.layout;
  const steps = [];
  const ops = [];
  const note = 'A macro sets this layout in one step. It does not animate the move. Key frames, when stored, let the switcher fly later (RUN A / RUN B).';
  if (store === 'pair' && flyFrom) {
    const from = fit(flyFrom, caps);
    skipped.push(...from.skipped.map((s) => ({ ...s, what: `key frame A ${s.what}` })));
    for (const k of from.layout.keys) {
      if (k.type !== 'dve') continue;
      steps.push(...keySteps(from.layout, k, { geometryOnly: true }));
      ops.push(...dveOps(from.layout.me, k.index, k.dve));
    }
    const a = storeFrames(from.layout, 'a');
    steps.push(...a.steps); ops.push(...a.ops);
  }
  if (main.ss !== null) { steps.push(...ssSteps(main)); ops.push(...ssOps(main)); }
  for (const k of main.keys) { steps.push(...keySteps(main, k)); ops.push(...keySettingOps(main, k)); }
  if (store === 'a' || store === 'b') {
    const s = storeFrames(main, store);
    steps.push(...s.steps); ops.push(...s.ops);
  } else if (store === 'pair') {
    const b = storeFrames(main, 'b');
    steps.push(...b.steps); ops.push(...b.ops);
  }
  return { layout: main, steps, ops, skipped, note, xml: toXml(ops, { name: 'Layout', description: note }) };
}

function toXml(ops, { name = 'Layout', description = '', index = 0, product = 'Control Center ATEM layout' } = {}) {
  const lines = (ops || []).map((o) => {
    const attrs = Object.entries(o.attrs).map(([k, v]) => `${k}="${xmlEsc(v)}"`).join(' ');
    return `      <Op id="${xmlEsc(o.id)}" ${attrs}/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile majorVersion="1" minorVersion="0" product="${xmlEsc(product)}">\n  <MacroPool>\n    <Macro index="${Number(index) || 0}" name="${xmlEsc(name)}" description="${xmlEsc(description)}">\n${lines}\n    </Macro>\n  </MacroPool>\n</Profile>\n`;
}

function numAttr(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// One Software Control Op → one Control Center step, in protocol units. Unknown ops return null.
function stepFromXml(id, attrs) {
  const a = attrs || {};
  const ss = numAttr(a.superSource);
  const box = numAttr(a.boxIndex);
  const me = a.mixEffectBlockIndex !== undefined && a.mixEffectBlockIndex !== '' ? numAttr(a.mixEffectBlockIndex) + 1 : undefined;
  const key = a.keyIndex !== undefined && a.keyIndex !== '' ? numAttr(a.keyIndex) : undefined;
  const idn = me !== undefined || key !== undefined ? { me, key } : {};
  const boxId = { ss, box };
  switch (id) {
    case 'SuperSourceV2BoxEnable': return { op: 'ssBox', args: { ...boxId, enabled: bool(a.enable) } };
    case 'SuperSourceV2BoxInput': return { op: 'ssBox', args: { ...boxId, source: tokenToId(a.input) } };
    case 'SuperSourceV2BoxXPosition': return { op: 'ssBox', args: { ...boxId, x: Math.round(numAttr(a.xPosition) * 100) } };
    case 'SuperSourceV2BoxYPosition': return { op: 'ssBox', args: { ...boxId, y: Math.round(numAttr(a.yPosition) * 100) } };
    case 'SuperSourceV2BoxSize': return { op: 'ssBox', args: { ...boxId, size: Math.round(numAttr(a.size) * 1000) } };
    case 'SuperSourceV2BoxMaskEnable': return { op: 'ssBox', args: { ...boxId, cropped: bool(a.enable) } };
    case 'SuperSourceV2BoxMaskTop': return { op: 'ssBox', args: { ...boxId, cropTop: Math.round(numAttr(a.top) * 1000) } };
    case 'SuperSourceV2BoxMaskBottom': return { op: 'ssBox', args: { ...boxId, cropBottom: Math.round(numAttr(a.bottom) * 1000) } };
    case 'SuperSourceV2BoxMaskLeft': return { op: 'ssBox', args: { ...boxId, cropLeft: Math.round(numAttr(a.left) * 1000) } };
    case 'SuperSourceV2BoxMaskRight': return { op: 'ssBox', args: { ...boxId, cropRight: Math.round(numAttr(a.right) * 1000) } };
    case 'SuperSourceV2ArtFillInput': return { op: 'ssProps', args: { ss, artFillSource: tokenToId(a.input) } };
    case 'SuperSourceV2ArtCutInput': return { op: 'ssProps', args: { ss, artCutSource: tokenToId(a.input) } };
    case 'SuperSourceV2ArtAbove': return { op: 'ssProps', args: { ss, artOption: bool(a.artAbove) ? 1 : 0 } };
    case 'SuperSourceV2ArtPreMultiply': return { op: 'ssProps', args: { ss, artPreMultiplied: bool(a.preMultiply) } };
    case 'SuperSourceV2ArtClip': return { op: 'ssProps', args: { ss, artClip: Math.round(numAttr(a.clip) * 1000) } };
    case 'SuperSourceV2ArtGain': return { op: 'ssProps', args: { ss, artGain: Math.round(numAttr(a.gain) * 1000) } };
    case 'SuperSourceV2ArtInvert': return { op: 'ssProps', args: { ss, artInvertKey: bool(a.invert) } };
    case 'SuperSourceV2BorderEnable': return { op: 'ssBorder', args: { ss, borderEnabled: bool(a.enable) } };
    case 'SuperSourceV2BorderBevel': return { op: 'ssBorder', args: { ss, borderBevel: Math.max(0, BEVELS.indexOf(a.bevel)) } };
    case 'SuperSourceV2BorderOuterWidth': return { op: 'ssBorder', args: { ss, borderOuterWidth: Math.round(numAttr(a.outerWidth) * 100) } };
    case 'SuperSourceV2BorderInnerWidth': return { op: 'ssBorder', args: { ss, borderInnerWidth: Math.round(numAttr(a.innerWidth) * 100) } };
    case 'SuperSourceV2BorderHue': return { op: 'ssBorder', args: { ss, borderHue: Math.round(numAttr(a.hue) * 10) } };
    case 'SuperSourceV2BorderSaturation': return { op: 'ssBorder', args: { ss, borderSaturation: Math.round(numAttr(a.saturation) * 1000) } };
    case 'SuperSourceV2BorderLuminescence': return { op: 'ssBorder', args: { ss, borderLuma: Math.round(numAttr(a.luminescence) * 1000) } };
    case 'SuperSourceV2BorderLightSourceDirection': return { op: 'ssBorder', args: { ss, borderLightSourceDirection: Math.round(numAttr(a.direction) * 10) } };
    case 'SuperSourceV2BorderLightSourceAltitude': return { op: 'ssBorder', args: { ss, borderLightSourceAltitude: numAttr(a.altitude) } };
    case 'KeyType': return { op: 'uskType', args: { ...idn, type: String(a.type || 'Luma').toLowerCase() } };
    case 'KeyFlyEnable': return { op: 'uskType', args: { ...idn, flyEnabled: bool(a.enable) } };
    case 'KeyFillInput': return { op: 'uskSources', args: { ...idn, fill: tokenToId(a.input) } };
    case 'KeyCutInput': return { op: 'uskSources', args: { ...idn, cut: tokenToId(a.input) } };
    case 'KeyOnAir': return { op: 'uskOnAir', args: { ...idn, on: bool(a.onAir) } };
    case 'LumaKeyPreMultiply': return { op: 'uskLuma', args: { ...idn, preMultiplied: bool(a.preMultiply) } };
    case 'LumaKeyClip': return { op: 'uskLuma', args: { ...idn, clip: Math.round(numAttr(a.clip) * 1000) } };
    case 'LumaKeyGain': return { op: 'uskLuma', args: { ...idn, gain: Math.round(numAttr(a.gain) * 1000) } };
    case 'LumaKeyInvert': return { op: 'uskLuma', args: { ...idn, invert: bool(a.invert) } };
    case 'ChromaKeyHue': return { op: 'uskChroma', args: { ...idn, hue: Math.round(numAttr(a.hue) * 10) } };
    case 'ChromaKeyGain': return { op: 'uskChroma', args: { ...idn, gain: Math.round(numAttr(a.gain) * 1000) } };
    case 'ChromaKeyYSuppress': return { op: 'uskChroma', args: { ...idn, ySuppress: Math.round(numAttr(a.ySuppress) * 1000) } };
    case 'ChromaKeyLift': return { op: 'uskChroma', args: { ...idn, lift: Math.round(numAttr(a.lift) * 1000) } };
    case 'ChromaKeyNarrow': return { op: 'uskChroma', args: { ...idn, narrow: bool(a.narrow) } };
    case 'PatternKeyPattern': return { op: 'uskPattern', args: { ...idn, style: Math.max(0, PATTERNS.indexOf(a.pattern)) } };
    case 'PatternKeySize': return { op: 'uskPattern', args: { ...idn, size: Math.round(numAttr(a.size) * 10000) } };
    case 'PatternKeySymmetry': return { op: 'uskPattern', args: { ...idn, symmetry: Math.round(numAttr(a.symmetry) * 10000) } };
    case 'PatternKeySoftness': return { op: 'uskPattern', args: { ...idn, softness: Math.round(numAttr(a.softness) * 10000) } };
    case 'PatternKeyXPosition': return { op: 'uskPattern', args: { ...idn, positionX: Math.round(numAttr(a.xPosition) * 10000) } };
    case 'PatternKeyYPosition': return { op: 'uskPattern', args: { ...idn, positionY: Math.round(numAttr(a.yPosition) * 10000) } };
    case 'PatternKeyInvert': return { op: 'uskPattern', args: { ...idn, invert: bool(a.invert) } };
    case 'KeyMaskEnable': return { op: 'uskMask', args: { ...idn, enabled: bool(a.enable) } };
    case 'KeyMaskTop': return { op: 'uskMask', args: { ...idn, top: Math.round(numAttr(a.top) * 1000) } };
    case 'KeyMaskBottom': return { op: 'uskMask', args: { ...idn, bottom: Math.round(numAttr(a.bottom) * 1000) } };
    case 'KeyMaskLeft': return { op: 'uskMask', args: { ...idn, left: Math.round(numAttr(a.left) * 1000) } };
    case 'KeyMaskRight': return { op: 'uskMask', args: { ...idn, right: Math.round(numAttr(a.right) * 1000) } };
    case 'DVEAndFlyKeyXSize': return { op: 'uskDve', args: { ...idn, sizeX: Math.round(numAttr(a.xSize) * 1000) } };
    case 'DVEAndFlyKeyYSize': return { op: 'uskDve', args: { ...idn, sizeY: Math.round(numAttr(a.ySize) * 1000) } };
    case 'DVEAndFlyKeyXPosition': return { op: 'uskDve', args: { ...idn, positionX: Math.round(numAttr(a.xPosition) * 1000) } };
    case 'DVEAndFlyKeyYPosition': return { op: 'uskDve', args: { ...idn, positionY: Math.round(numAttr(a.yPosition) * 1000) } };
    case 'DVEAndFlyKeyRotation': return { op: 'uskDve', args: { ...idn, rotation: Math.round(numAttr(a.rotation) * 10) } };
    case 'DVEKeyBorderEnable': return { op: 'uskDve', args: { ...idn, borderEnabled: bool(a.enable) } };
    case 'DVEKeyBorderOuterWidth': return { op: 'uskDve', args: { ...idn, borderOuterWidth: Math.round(numAttr(a.outerWidth) * 100) } };
    case 'DVEKeyBorderHue': return { op: 'uskDve', args: { ...idn, borderHue: Math.round(numAttr(a.hue) * 10) } };
    case 'DVEKeyBorderLuminescence': return { op: 'uskDve', args: { ...idn, borderLuma: Math.round(numAttr(a.luminescence) * 1000) } };
    case 'DVEKeyShadowEnable': return { op: 'uskDve', args: { ...idn, shadowEnabled: bool(a.enable) } };
    case 'DVEKeyShadowDirection': return { op: 'uskDve', args: { ...idn, lightSourceDirection: Math.round(numAttr(a.direction) * 10) } };
    case 'DVEKeyShadowAltitude': return { op: 'uskDve', args: { ...idn, lightSourceAltitude: numAttr(a.altitude) } };
    case 'DVEKeyMaskEnable': return { op: 'uskDve', args: { ...idn, maskEnabled: bool(a.enable) } };
    case 'DVEKeyMaskTop': return { op: 'uskDve', args: { ...idn, maskTop: Math.round(numAttr(a.top) * 1000) } };
    case 'FlyKeyStoreKeyFrame': return { op: 'uskFlyStore', args: { ...idn, frame: String(a.keyFrame || 'A').toLowerCase() === 'b' ? 'b' : 'a' } };
    default: return null;
  }
}

function tokenToId(token) {
  const raw = String(token || '');
  if (/^\d+$/.test(raw)) return Number(raw);
  const fixedIds = { Black: 0, ColorBars: 1000, Bars: 1000, Color1: 2001, Color2: 2002, SuperSource: 6000, SuperSource2: 6001 };
  if (fixedIds[raw] !== undefined) return fixedIds[raw];
  let m;
  if ((m = /^Camera(\d+)$/.exec(raw))) return Number(m[1]);
  if ((m = /^Color(\d+)$/.exec(raw))) return 2000 + Number(m[1]);
  if ((m = /^MediaPlayer(\d+)Key$/.exec(raw))) return 3000 + Number(m[1]) * 10 + 1;
  if ((m = /^MediaPlayer(\d+)$/.exec(raw))) return 3000 + Number(m[1]) * 10;
  if ((m = /^CleanFeed(\d+)$/.exec(raw))) return 7000 + Number(m[1]);
  if ((m = /^Aux(\d+)$/.exec(raw))) return 8000 + Number(m[1]);
  if ((m = /^ME(\d+)Program$/.exec(raw))) return 10000 + Number(m[1]) * 10;
  if ((m = /^ME(\d+)Preview$/.exec(raw))) return 10001 + Number(m[1]) * 10;
  if ((m = /^SuperSource(\d+)$/.exec(raw))) return 5999 + Number(m[1]);
  return 0;
}

function xmlForStep(step) {
  if (!step || !step.op) return [];
  const fake = { me: Math.max(0, (Number(step.args && step.args.me) || 1) - 1), ss: Number(step.args && step.args.ss) || 0, boxes: [], keys: [], art: null, border: null };
  if (step.op === 'ssBox') { fake.boxes = [{ index: Number(step.args.box) || 0, ...step.args }]; return ssOps(fake).map(renderOp); }
  if (step.op === 'ssProps') { fake.art = step.args; return ssOps(fake).map(renderOp); }
  if (step.op === 'ssBorder') { fake.border = step.args; return ssOps(fake).map(renderOp); }
  if (step.op === 'uskFlyStore') return [renderOp(flyStoreOp(fake.me, Number(step.args.key) || 0, step.args.frame))];
  if (step.op === 'uskType') {
    const out = [];
    if (step.args.type) out.push(op('KeyType', { ...meAttrs(fake.me, Number(step.args.key) || 0), type: { luma: 'Luma', chroma: 'Chroma', pattern: 'Pattern', dve: 'DVE' }[step.args.type] || 'Luma' }));
    if (step.args.flyEnabled !== undefined) out.push(op('KeyFlyEnable', { ...meAttrs(fake.me, Number(step.args.key) || 0), enable: flag(step.args.flyEnabled) }));
    return out.map(renderOp);
  }
  if (['uskSources', 'uskLuma', 'uskChroma', 'uskPattern', 'uskMask', 'uskDve', 'uskOnAir'].includes(step.op)) {
    const key = {
      index: Number(step.args.key) || 0, type: step.args.type || (step.op === 'uskDve' ? 'dve' : 'luma'), flyEnabled: step.args.flyEnabled, onAir: step.args.on,
      fill: step.args.fill, cut: step.args.cut, luma: step.op === 'uskLuma' ? step.args : null, chroma: step.op === 'uskChroma' ? step.args : null,
      pattern: step.op === 'uskPattern' ? step.args : null, mask: step.op === 'uskMask' ? step.args : null, dve: step.op === 'uskDve' ? step.args : null,
    };
    fake.keys = [key];
    if (step.op === 'uskDve') return dveOps(fake.me, key.index, step.args).map(renderOp);
    return keySettingOps(fake, key).filter((o) => {
      if (step.op === 'uskType') return o.id === 'KeyType' || o.id === 'KeyFlyEnable';
      if (step.op === 'uskSources') return o.id === 'KeyFillInput' || o.id === 'KeyCutInput';
      if (step.op === 'uskOnAir') return o.id === 'KeyOnAir';
      if (step.op === 'uskLuma') return o.id.startsWith('LumaKey');
      if (step.op === 'uskChroma') return o.id.startsWith('ChromaKey');
      if (step.op === 'uskPattern') return o.id.startsWith('PatternKey');
      if (step.op === 'uskMask') return o.id.startsWith('KeyMask');
      return false;
    }).map(renderOp);
  }
  return [];
}
function renderOp(o) {
  const attrs = Object.entries(o.attrs).map(([k, v]) => `${k}="${xmlEsc(v)}"`).join(' ');
  return `<Op id="${xmlEsc(o.id)}" ${attrs}/>`;
}

module.exports = {
  FRAME, PATTERNS, BEVELS, KEY_TYPES, FIELDS, BOOL, STR, CLAMP, SS_BOX, SS_PROPS, SS_BORDER, DVE,
  sourceToken, tokenToId, rectOf, unitsOf, snap, guideTargets, capsFromView, normalize, fromView, fit, build, toXml, stepFromXml, xmlForStep,
};
