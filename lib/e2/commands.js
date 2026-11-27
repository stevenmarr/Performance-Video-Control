'use strict';
// Documented Event Master writes.
//
// changeContent puts a layer on Preview when PvwMode is 1. Barco's own example
// sends Window (or LastSrcIdx) in one call and Mask in another: "Mask parameters
// must be sent separately from Window and LastSrcIdx." Source is the crop into
// the input (HPos/VPos/HSize/VSize). Mask is the layer edge (Left/Right/Top/Bottom).
// Those are not the same command. Aux destinations have no layers; a source
// goes on with changeAuxContent. Preset save / recall / cut / allTrans are the
// methods already used by the preset desk.

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === '') continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

function layerHead(layer, extra) {
  const body = { id: layer.id, PvwMode: 1, ...(extra || {}) };
  if (layer.destOutMap != null) body._destOutMap = layer.destOutMap;
  return body;
}

function screenParams(destId, layerBody, destOutMap) {
  const layer = { ...layerBody };
  delete layer._destOutMap;
  const params = { id: destId, Layers: [layer] };
  if (destOutMap != null) params.DestOutMap = destOutMap;
  return { method: 'changeContent', params };
}

function windowCommand(dest, layer) {
  const w = layer.pvw && layer.pvw.window;
  if (!w) return null;
  return screenParams(dest.id, clean({
    id: layer.id,
    PvwMode: 1,
    Window: clean({ HPos: w.hPos, VPos: w.vPos, HSize: w.hSize, VSize: w.vSize }),
  }), layer.destOutMap);
}

function maskCommand(dest, layer) {
  const m = layer.pvw && layer.pvw.mask;
  if (!m) return null;
  return screenParams(dest.id, clean({
    id: layer.id,
    PvwMode: 1,
    Mask: clean({ Left: m.left, Right: m.right, Top: m.top, Bottom: m.bottom }),
  }), layer.destOutMap);
}

function cropCommand(dest, layer) {
  const c = layer.pvw && layer.pvw.crop;
  if (!c) return null;
  return screenParams(dest.id, clean({
    id: layer.id,
    PvwMode: 1,
    Source: clean({ HPos: c.hPos, VPos: c.vPos, HSize: c.hSize, VSize: c.vSize }),
  }), layer.destOutMap);
}

function sourceCommand(dest, layer, sourceId) {
  const key = (layer.wire && layer.wire.sourceKey) || 'LastSrcIdx';
  return screenParams(dest.id, { id: layer.id, PvwMode: 1, [key]: Number(sourceId) }, layer.destOutMap);
}

function clearCommand(dest, layer) {
  const key = (layer.wire && layer.wire.sourceKey) || 'LastSrcIdx';
  return screenParams(dest.id, { id: layer.id, PvwMode: 0, [key]: -1 }, layer.destOutMap);
}

function freezeCommand(dest, layer, on) {
  const key = (layer.wire && layer.wire.freezeKey) || 'Freeze';
  return screenParams(dest.id, { id: layer.id, PvwMode: 1, [key]: on ? 1 : 0 }, layer.destOutMap);
}

function zCommand(dest, layer, z) {
  return screenParams(dest.id, { id: layer.id, PvwMode: 1, PvwZOrder: z }, layer.destOutMap);
}

function borderCommand(dest, layer) {
  const b = layer.pvw && layer.pvw.border;
  if (!b) return null;
  const color = b.color || {};
  return screenParams(dest.id, {
    id: layer.id,
    PvwMode: 1,
    Border: clean({
      Enable: b.size ? 1 : (b.enable != null ? b.enable : undefined),
      Size: b.size,
      Softness: b.softness,
      Opacity: b.opacity,
      Red: color.r,
      Green: color.g,
      Blue: color.b,
    }),
  }, layer.destOutMap);
}

function shadowCommand(dest, layer) {
  const s = layer.pvw && layer.pvw.shadow;
  if (!s) return null;
  const key = (layer.wire && layer.wire.shadowKey) || 'Shadow';
  return screenParams(dest.id, {
    id: layer.id,
    PvwMode: 1,
    [key]: clean({
      Enable: 1,
      HOffset: s.h,
      VOffset: s.v,
      Size: s.size,
      Softness: s.softness,
      Opacity: s.opacity,
    }),
  }, layer.destOutMap);
}

function opacityCommand(dest, layer) {
  const s = layer.pvw;
  if (!s || s.opacity == null) return null;
  const key = (s.opacityName || (layer.wire && layer.wire.opacityKey) || 'Opacity');
  return screenParams(dest.id, { id: layer.id, PvwMode: 1, [key]: s.opacity }, layer.destOutMap);
}

function keyCommand(dest, layer) {
  const k = layer.pvw && layer.pvw.key;
  if (!k) return null;
  return screenParams(dest.id, {
    id: layer.id,
    PvwMode: 1,
    Key: clean({ Mode: k.mode, Clip: k.clip, Gain: k.gain, Invert: k.invert, Hue: k.hue }),
  }, layer.destOutMap);
}

function transitionCommand(dest, layer) {
  const t = layer.pvw && layer.pvw.transition;
  if (!t) return null;
  return screenParams(dest.id, {
    id: layer.id,
    PvwMode: 1,
    LayerTransition: clean({
      In: clean({ Type: t.inType, Time: t.inTime }),
      Out: clean({ Type: t.outType, Time: t.outTime }),
    }),
  }, layer.destOutMap);
}

function effectCommand(dest, layer) {
  const e = layer.pvw && layer.pvw.effect;
  if (!e) return null;
  return screenParams(dest.id, {
    id: layer.id,
    PvwMode: 1,
    Effect: clean({ Type: e.type, Time: e.time }),
  }, layer.destOutMap);
}

function auxCommand(aux, sourceId) {
  return { method: 'changeAuxContent', params: { id: aux.id, PvwLastSrcIndex: Number(sourceId) } };
}

function saveCommand(name, dest, fromProgram) {
  const params = { presetName: name || 'Program', saveFromProgram: fromProgram ? 1 : 0 };
  if (dest && dest.kind === 'aux') params.AuxDestination = [{ id: dest.id }];
  else if (dest) params.ScreenDestination = [{ id: dest.id }];
  return { method: 'savePreset', params };
}

function recallCommand(id, target) {
  return { method: 'activatePreset', params: { id: Number(id), type: target === 'program' ? 1 : 0 } };
}

// Which documented call a dial belongs to. Mask, source-crop and window stay apart.
function groupOf(paramId) {
  if (/^mask/.test(paramId)) return 'mask';
  if (/^crop/.test(paramId)) return 'crop';
  if (/^pos|^size/.test(paramId)) return 'window';
  if (/^border/.test(paramId)) return 'border';
  if (/^shadow/.test(paramId)) return 'shadow';
  if (paramId === 'opacity') return 'opacity';
  if (/^key/.test(paramId)) return 'key';
  if (/^trans/.test(paramId)) return 'transition';
  if (/^effect/.test(paramId)) return 'effect';
  return 'window';
}

function commandsFor(group, dest, layer) {
  if (!dest || dest.kind === 'aux') return [];
  const fn = {
    window: windowCommand,
    mask: maskCommand,
    crop: cropCommand,
    border: borderCommand,
    shadow: shadowCommand,
    opacity: opacityCommand,
    key: keyCommand,
    transition: transitionCommand,
    effect: effectCommand,
  }[group];
  const cmd = fn && fn(dest, layer);
  return cmd ? [cmd] : [];
}

module.exports = {
  clean, windowCommand, maskCommand, cropCommand, sourceCommand, clearCommand,
  freezeCommand, zCommand, borderCommand, shadowCommand, opacityCommand, keyCommand,
  transitionCommand, effectCommand, auxCommand, saveCommand, recallCommand,
  groupOf, commandsFor,
};
