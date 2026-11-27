'use strict';
// Schema-tolerant read of an Event Master JSON-RPC capture.
//
// Barco's listContent / changeContent shape is not one schema. Toolset 9.2 and
// Toolset 10 (R5919184, and the JSON-RPC notes shipped with the Crestron module)
// return a layer Window, Source and Mask as arrays: index 0 is Program, index 1
// is Preview. Other frames nest the same numbers under Pvw / Pgm, wrap every
// value as {Min, Max, $t}, or add Border, Shadow, Opacity, Key and a per-layer
// transition only when that show file uses them. listDestinations sometimes
// reports Layers as a count, sometimes as null, and Aux destinations often have
// no Name until listAuxContent.
//
// This parser does not assume a layout. It recognizes those documented shapes,
// records a capability only when that field was actually present, and lists
// anything it does not recognize. It never invents a border, a key or a layer.

function unwrap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && '$t' in v) return unwrap(v.$t);
  return v;
}

function num(v) {
  const u = unwrap(v);
  if (typeof u === 'boolean') return u ? 1 : 0;
  if (typeof u === 'number' && Number.isFinite(u)) return u;
  if (typeof u === 'string' && u.trim() !== '' && Number.isFinite(Number(u))) return Number(u);
  return null;
}

function text(v) {
  const u = unwrap(v);
  if (u == null) return '';
  return String(u);
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function pick(obj, names) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(k.toLowerCase(), k);
  for (const n of names) {
    const hit = map.get(String(n).toLowerCase());
    if (hit !== undefined) return obj[hit];
  }
  return undefined;
}

function hasKey(obj, names) {
  return pick(obj, names) !== undefined;
}

// Window[0] / Mask[0] / Source[0] are Program. Index 1 is Preview.
// A Pvw/Pgm object is the other documented nesting. A flat object is one
// shared readout (some frames do not split the buses on the read).
function splitBus(value) {
  if (value == null) return { pgm: null, pvw: null, shared: false, present: false };
  if (Array.isArray(value)) {
    if (value.length >= 2) return { pgm: value[0], pvw: value[1], shared: false, present: true };
    if (value.length === 1) return { pgm: null, pvw: value[0], shared: false, present: true };
    return { pgm: null, pvw: null, shared: false, present: true };
  }
  if (typeof value === 'object') {
    const pgm = pick(value, ['Pgm', 'Program', 'PGM']);
    const pvw = pick(value, ['Pvw', 'Preview', 'PVW']);
    if (pgm !== undefined || pvw !== undefined) return { pgm: pgm ?? null, pvw: pvw ?? null, shared: false, present: true };
    return { pgm: value, pvw: value, shared: true, present: true };
  }
  return { pgm: value, pvw: value, shared: true, present: true };
}

function rectOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hPos = num(pick(raw, ['HPos', 'HPosition', 'X', 'PosX']));
  const vPos = num(pick(raw, ['VPos', 'VPosition', 'Y', 'PosY']));
  const hSize = num(pick(raw, ['HSize', 'H', 'Width', 'W']));
  const vSize = num(pick(raw, ['VSize', 'V', 'Height']));
  if (hPos == null && vPos == null && hSize == null && vSize == null) return null;
  return { hPos, vPos, hSize, vSize };
}

function maskOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const left = num(pick(raw, ['Left', 'L']));
  const right = num(pick(raw, ['Right', 'R']));
  const top = num(pick(raw, ['Top', 'T']));
  const bottom = num(pick(raw, ['Bottom', 'B']));
  if (left == null && right == null && top == null && bottom == null) return null;
  return { left, right, top, bottom };
}

function colorOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const box = pick(raw, ['Color', 'Colour', 'BGColor']) || raw;
  const r = num(pick(box, ['Red', 'R']));
  const g = num(pick(box, ['Green', 'G']));
  const b = num(pick(box, ['Blue', 'B']));
  if (r == null && g == null && b == null) return null;
  return { r, g, b };
}

function borderOf(raw) {
  if (raw == null || typeof raw === 'number') {
    const n = num(raw);
    return n == null ? null : { size: n };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const size = num(pick(raw, ['Size', 'HSize', 'Width', 'BorderSize']));
  const softness = num(pick(raw, ['Softness', 'Soft', 'BorderSoft']));
  const opacity = num(pick(raw, ['Opacity', 'Alpha']));
  const enable = num(pick(raw, ['Enable', 'Enabled', 'On']));
  const color = colorOf(raw);
  if (size == null && softness == null && !color && opacity == null && enable == null) return null;
  return { size, softness, opacity, enable, color };
}

function shadowOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = num(pick(raw, ['HOffset', 'HPos', 'X', 'H']));
  const v = num(pick(raw, ['VOffset', 'VPos', 'Y', 'V']));
  const size = num(pick(raw, ['Size', 'Width']));
  const softness = num(pick(raw, ['Softness', 'Soft']));
  const opacity = num(pick(raw, ['Opacity', 'Alpha', 'Transparency']));
  const enable = num(pick(raw, ['Enable', 'Enabled', 'On']));
  if (h == null && v == null && size == null && softness == null && opacity == null && enable == null) return null;
  return { h, v, size, softness, opacity, enable };
}

function keyOf(raw, layer) {
  const box = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const luma = pick(layer, ['LumaKey']) || pick(box, ['Luma', 'LumaKey']);
  const chroma = pick(layer, ['ChromaKey']) || pick(box, ['Chroma', 'ChromaKey']);
  const clip = num(pick(box, ['Clip', 'KeyClip'])) ?? num(luma && pick(luma, ['Clip'])) ?? num(chroma && pick(chroma, ['Clip']));
  const gain = num(pick(box, ['Gain', 'KeyGain'])) ?? num(luma && pick(luma, ['Gain'])) ?? num(chroma && pick(chroma, ['Gain']));
  const invert = num(pick(box, ['Invert', 'KeyInvert'])) ?? num(luma && pick(luma, ['Invert'])) ?? num(chroma && pick(chroma, ['Invert']));
  const hue = num(pick(box, ['Hue'])) ?? num(chroma && pick(chroma, ['Hue']));
  let mode = text(pick(box, ['Mode', 'Type', 'KeyMode'])).toLowerCase();
  if (!mode) {
    if (chroma && !luma) mode = 'chroma';
    else if (luma && !chroma) mode = 'luma';
  }
  if (clip == null && gain == null && invert == null && hue == null && !mode) return null;
  return { mode: mode || null, clip, gain, invert, hue };
}

function transitionOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const inn = pick(raw, ['In', 'TransIn', 'TransitionIn']) || raw;
  const out = pick(raw, ['Out', 'TransOut', 'TransitionOut']);
  const inType = num(pick(inn, ['Type', 'TransType', 'Mode'])) ?? (typeof pick(inn, ['Type', 'Name']) === 'string' ? text(pick(inn, ['Type', 'Name'])) : null);
  const inTime = num(pick(inn, ['Time', 'Duration', 'TransTime', 'Frames']));
  const outType = out ? (num(pick(out, ['Type', 'TransType', 'Mode'])) ?? (typeof pick(out, ['Type']) === 'string' ? text(pick(out, 'Type')) : null)) : null;
  const outTime = out ? num(pick(out, ['Time', 'Duration', 'TransTime', 'Frames'])) : null;
  if (inType == null && inTime == null && outType == null && outTime == null) return null;
  return { inType, inTime, outType, outTime };
}

function effectOf(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' || typeof raw === 'string') return { type: unwrap(raw), time: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = pick(raw, ['Type', 'Mode', 'Name', 'Effect']);
  const time = num(pick(raw, ['Time', 'Duration', 'Frames']));
  const t = type == null ? null : unwrap(type);
  if (t == null && time == null) return null;
  return { type: t, time };
}

const KNOWN = new Set([
  'id', 'name', 'label', 'lastsrcidx', 'lastsrcindex', 'srcindex',
  'pvwlastsrcindex', 'pvwlastsrcidx', 'pgmlastsrcindex', 'pgmlastsrcidx',
  'previewsrc', 'programsrc', 'pvwmode', 'pgmmode', 'previewmode', 'programmode',
  'linklayerid', 'linkdestid', 'capacity', 'pvwzorder', 'pgmzorder', 'zorder', 'z',
  'previewzorder', 'programzorder', 'freeze', 'layerfreeze', 'scalingmode', 'aspectmode',
  'window', 'source', 'mask', 'border', 'bordersize', 'bordersoft', 'shadow', 'dropshadow',
  'shade', 'opacity', 'transparency', 'alpha', 'key', 'lumakey', 'chromakey',
  'keyclip', 'keygain', 'keyinvert', 'transin', 'transout', 'transitionin', 'transitionout',
  'layertransition', 'transition', 'effect', 'layereffect', 'pipeffect', 'fx',
  'layertype', 'mixmode', 'type', 'aspect', 'aspectlock',
  'lastbgsourceindex', 'bgshowmatte', 'bgcolor',
].map((s) => s.toLowerCase()));

function sampleOf(v) {
  const u = unwrap(v);
  if (u == null) return null;
  if (typeof u === 'number' || typeof u === 'string' || typeof u === 'boolean') return u;
  if (Array.isArray(u)) return u.slice(0, 2).map(sampleOf);
  if (typeof u === 'object') {
    const out = {};
    for (const k of Object.keys(u).slice(0, 8)) out[k] = sampleOf(u[k]);
    return out;
  }
  return null;
}

function collectUnknown(obj, path, into, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) {
    if (KNOWN.has(k.toLowerCase())) continue;
    if (into.length >= 80) return;
    into.push({
      path: `${path}.${k}`,
      field: k,
      type: Array.isArray(obj[k]) ? 'array' : typeof unwrap(obj[k]),
      sample: sampleOf(obj[k]),
      destKey: where.destKey,
      layerId: where.layerId,
    });
  }
}

function sourceId(layer, bus) {
  const specific = bus === 'pvw'
    ? num(pick(layer, ['PvwLastSrcIndex', 'PvwLastSrcIdx', 'PreviewSrc']))
    : num(pick(layer, ['PgmLastSrcIndex', 'PgmLastSrcIdx', 'ProgramSrc']));
  if (specific != null) return specific < 0 ? null : specific;
  const one = num(pick(layer, ['LastSrcIdx', 'LastSrcIndex', 'SrcIndex']));
  if (one == null || one < 0) return null;
  return one;
}

function modeOn(layer, bus) {
  const names = bus === 'pvw' ? ['PvwMode', 'PreviewMode'] : ['PgmMode', 'ProgramMode'];
  if (!hasKey(layer, names)) return null;
  const n = num(pick(layer, names));
  if (n == null) return null;
  return n !== 0;
}

function busValue(split, bus) {
  if (!split || !split.present) return null;
  return bus === 'pvw' ? split.pvw : split.pgm;
}

function fieldsFrom(side) {
  const f = {};
  const mark = (id, ok) => { if (ok) f[id] = true; };
  const w = side.window;
  const c = side.crop;
  const m = side.mask;
  if (w) {
    mark('posH', w.hPos != null); mark('posV', w.vPos != null);
    mark('sizeH', w.hSize != null); mark('sizeV', w.vSize != null);
  }
  if (c) {
    mark('cropH', c.hPos != null); mark('cropV', c.vPos != null);
    mark('cropW', c.hSize != null); mark('cropHsize', c.vSize != null);
  }
  if (m) {
    mark('maskL', m.left != null); mark('maskR', m.right != null);
    mark('maskT', m.top != null); mark('maskB', m.bottom != null);
  }
  const b = side.border;
  if (b) {
    mark('borderSize', b.size != null); mark('borderSoft', b.softness != null);
    mark('borderR', b.color && b.color.r != null);
    mark('borderG', b.color && b.color.g != null);
    mark('borderB', b.color && b.color.b != null);
    mark('borderOpacity', b.opacity != null);
  }
  const s = side.shadow;
  if (s) {
    mark('shadowH', s.h != null); mark('shadowV', s.v != null);
    mark('shadowSize', s.size != null); mark('shadowSoft', s.softness != null);
    mark('shadowOpacity', s.opacity != null);
  }
  mark('opacity', side.opacity != null);
  const k = side.key;
  if (k) {
    mark('keyClip', k.clip != null); mark('keyGain', k.gain != null);
    mark('keyInvert', k.invert != null);
  }
  const t = side.transition;
  if (t) {
    mark('transInType', t.inType != null); mark('transInTime', t.inTime != null);
    mark('transOutType', t.outType != null); mark('transOutTime', t.outTime != null);
  }
  const e = side.effect;
  if (e) {
    mark('effectType', e.type != null); mark('effectTime', e.time != null);
  }
  mark('freeze', side.freeze != null);
  mark('z', side.z != null);
  mark('aspect', side.scaling != null);
  return f;
}

function capsFrom(fields) {
  const has = (...ids) => ids.some((id) => fields[id]);
  return {
    position: has('posH', 'posV'),
    size: has('sizeH', 'sizeV'),
    mask: has('maskL', 'maskR', 'maskT', 'maskB'),
    crop: has('cropH', 'cropV', 'cropW', 'cropHsize'),
    border: has('borderSize', 'borderSoft', 'borderR', 'borderG', 'borderB'),
    shadow: has('shadowH', 'shadowV', 'shadowSize', 'shadowSoft', 'shadowOpacity'),
    opacity: !!fields.opacity,
    key: has('keyClip', 'keyGain', 'keyInvert'),
    freeze: !!fields.freeze,
    zOrder: !!fields.z,
    aspect: !!fields.aspect || has('sizeH', 'sizeV'),
    transition: has('transInType', 'transInTime', 'transOutType', 'transOutTime'),
    effects: has('effectType', 'effectTime'),
  };
}

function readSide(layer, bus, splits) {
  const window = rectOf(busValue(splits.window, bus));
  const crop = rectOf(busValue(splits.source, bus));
  const mask = maskOf(busValue(splits.mask, bus));
  const border = borderOf(busValue(splits.border, bus));
  const shadow = shadowOf(busValue(splits.shadow, bus));
  const opacityRaw = busValue(splits.opacity, bus);
  const opacity = num(opacityRaw);
  const key = keyOf(busValue(splits.key, bus) || pick(layer, ['Key', 'LumaKey', 'ChromaKey']) || {}, layer);
  const transition = transitionOf(busValue(splits.transition, bus));
  const effect = effectOf(busValue(splits.effect, bus));
  const freezeN = num(pick(layer, ['Freeze', 'LayerFreeze']));
  const zSpecific = bus === 'pvw'
    ? num(pick(layer, ['PvwZOrder', 'PreviewZOrder']))
    : num(pick(layer, ['PgmZOrder', 'ProgramZOrder']));
  const z = zSpecific != null ? zSpecific : num(pick(layer, ['ZOrder', 'Z']));
  const scaling = num(pick(layer, ['ScalingMode', 'AspectMode']));
  const active = modeOn(layer, bus);
  const src = sourceId(layer, bus);
  return {
    active: active === true,
    modeKnown: active != null,
    sourceId: src,
    z,
    window,
    crop,
    mask,
    border,
    shadow,
    opacity,
    opacityName: splits.opacityName || null,
    key,
    freeze: freezeN == null ? null : freezeN !== 0,
    scaling,
    transition,
    effect,
  };
}

function roleOf(name, group) {
  const n = String(name || '');
  if (/background|\bBG\b/i.test(n)) return { role: 'background', side: null, pair: null };
  const m = n.match(/(\d+)\s*[-_. ]\s*([ABab])\s*$/) || n.match(/\b([ABab])\s*$/);
  if (!m) return { role: 'pip', side: null, pair: group || null };
  const side = m[m.length - 1].toUpperCase();
  const pair = m.length > 2 ? m[1] : (group || n.replace(/[-_. ]*[ABab]\s*$/, ''));
  return { role: side === 'B' ? 'split' : 'mix', side, pair: String(pair) };
}

function emptySide() {
  return {
    active: false, modeKnown: false, sourceId: null, z: null, window: null, crop: null, mask: null,
    border: null, shadow: null, opacity: null, opacityName: null, key: null, freeze: null, scaling: null,
    transition: null, effect: null,
  };
}

function layerFrom(raw, where, unknown) {
  const name = text(pick(raw, ['Name', 'Label'])) || `Layer ${num(pick(raw, ['id'])) != null ? num(pick(raw, ['id'])) + 1 : ''}`.trim();
  const id = num(pick(raw, ['id']));
  const window = splitBus(pick(raw, ['Window']));
  const source = splitBus(pick(raw, ['Source']));
  const mask = splitBus(pick(raw, ['Mask']));
  const border = splitBus(pick(raw, ['Border', 'BorderSize']));
  const shadow = splitBus(pick(raw, ['Shadow', 'DropShadow', 'Shade']));
  const opacityKey = ['Opacity', 'Transparency', 'Alpha'].find((k) => hasKey(raw, [k]));
  const opacity = splitBus(opacityKey ? pick(raw, [opacityKey]) : undefined);
  const keySplit = splitBus(pick(raw, ['Key']));
  // A Transition *array* on a screen is the destination mix. On a layer, an
  // object with In/Out or Type is that layer's own in/out.
  const trRaw = pick(raw, ['LayerTransition', 'TransIn']) ? (pick(raw, ['LayerTransition']) || { In: pick(raw, ['TransIn']), Out: pick(raw, ['TransOut', 'TransitionOut']) }) : pick(raw, ['Transition']);
  const transition = trRaw && !Array.isArray(trRaw) ? splitBus(trRaw) : { present: false };
  const effect = splitBus(pick(raw, ['Effect', 'LayerEffect', 'PipEffect', 'FX']));
  const splits = { window, source, mask, border, shadow, opacity, opacityName: opacityKey || null, key: keySplit, transition, effect };
  const pvw = readSide(raw, 'pvw', splits);
  const pgm = readSide(raw, 'pgm', splits);
  const fields = { ...fieldsFrom(pvw), ...fieldsFrom(pgm) };
  if (hasKey(raw, ['PvwZOrder', 'PgmZOrder', 'PreviewZOrder', 'ProgramZOrder', 'ZOrder', 'Z'])) fields.z = true;
  if (hasKey(raw, ['Freeze', 'LayerFreeze'])) fields.freeze = true;
  if (hasKey(raw, ['ScalingMode', 'AspectMode'])) fields.aspect = true;
  const meta = roleOf(name);
  const free = !pvw.active && !pgm.active && pvw.sourceId == null && pgm.sourceId == null;
  collectUnknown(raw, where.path, unknown, where);
  return {
    id: id == null ? 0 : id,
    name,
    ...meta,
    capacity: num(pick(raw, ['Capacity'])),
    linkLayerId: num(pick(raw, ['LinkLayerId'])),
    pvw,
    pgm,
    fields,
    capabilities: capsFrom(fields),
    free,
    wire: {
      sourceKey: hasKey(raw, ['PvwLastSrcIndex', 'PvwLastSrcIdx']) ? 'PvwLastSrcIndex' : 'LastSrcIdx',
      opacityKey: opacityKey || 'Opacity',
      borderKey: hasKey(raw, ['Border']) ? 'Border' : 'Border',
      shadowKey: hasKey(raw, ['DropShadow']) ? 'DropShadow' : 'Shadow',
      zKey: 'PvwZOrder',
      freezeKey: 'Freeze',
    },
  };
}

function backgroundLayer(bgList, unknown, destKey) {
  const rows = asArray(bgList);
  if (!rows.length) return null;
  const pgmRaw = rows.find((r) => num(pick(r, ['id'])) === 0) || null;
  const pvwRaw = rows.find((r) => num(pick(r, ['id'])) === 1) || null;
  const side = (raw) => {
    const base = emptySide();
    if (!raw) return base;
    const src = num(pick(raw, ['LastBGSourceIndex', 'LastSrcIdx']));
    base.sourceId = src == null || src < 0 ? null : src;
    base.active = base.sourceId != null || num(pick(raw, ['BGShowMatte'])) === 1;
    base.modeKnown = true;
    const color = colorOf(pick(raw, ['BGColor']) || raw);
    if (color) base.border = { size: null, softness: null, opacity: null, enable: null, color };
    return base;
  };
  const pvw = side(pvwRaw);
  const pgm = side(pgmRaw);
  const fields = {};
  if (pvw.sourceId != null || pgm.sourceId != null || pvwRaw || pgmRaw) fields.opacity = false;
  collectUnknown(pgmRaw, `dest[${destKey}].background`, unknown, { destKey, layerId: -1 });
  return {
    id: -1,
    name: 'Background',
    role: 'background',
    side: null,
    pair: null,
    capacity: null,
    linkLayerId: null,
    pvw,
    pgm,
    fields: { posH: false },
    capabilities: {
      position: false, size: false, mask: false, crop: false, border: false, shadow: false,
      opacity: false, key: false, freeze: false, zOrder: false, aspect: false, transition: false, effects: false,
    },
    free: !pvw.active && !pgm.active,
    wire: { sourceKey: 'LastBGSourceIndex', background: true },
  };
}

function destSize(raw) {
  const h = num(pick(raw, ['HSize', 'Width']));
  const v = num(pick(raw, ['VSize', 'Height']));
  if (h == null && v == null) return null;
  return { h: h || 0, v: v || 0 };
}

function readFrame(raw) {
  const sys = raw && (raw.System || raw.system || raw) || {};
  const col = sys.FrameCollection || sys.frameCollection || {};
  const frame = col.Frame || col.frame || {};
  const frames = asArray(frame);
  const host = frames.find((f) => f && (f.isHost || f.IsHost)) || frames[0] || {};
  return {
    name: text(pick(sys, ['Name'])) || text(pick(host, ['Name'])) || '',
    model: text(pick(host, ['FrameTypeName', 'Name'])) || 'Event Master',
    frameType: num(pick(host, ['FrameType'])),
    version: text(pick(host, ['Version'])) || '',
  };
}

function plateColor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 42% 28%)`;
}

function normalizeSources(list, inputs) {
  const rows = asArray(list);
  const inputById = new Map(asArray(inputs).map((r) => [num(pick(r, ['id'])), r]));
  return rows.map((s) => {
    const id = num(pick(s, ['id']));
    const input = inputById.get(id) || inputById.get(num(pick(s, ['InputCfgIndex'])));
    const kind = num(pick(s, ['SrcType'])) === 1 ? 'still' : (num(pick(s, ['DestIndex'])) >= 0 ? 'dest' : 'input');
    const name = text(pick(s, ['Name'])) || `Source ${id == null ? '' : id + 1}`;
    const h = num(pick(s, ['HSize']));
    const v = num(pick(s, ['VSize']));
    const thumb = text(pick(s, ['Thumbnail', 'Thumb', 'Icon', 'thumbnail'])) || '';
    const statusN = num(pick(s, ['InputCfgVideoStatus']));
    const STATUS = { 0: 'invalid', 1: 'ok', 2: 'format mismatch', 3: 'out of range', 4: 'no sync' };
    return {
      id: id == null ? 0 : id,
      name,
      kind,
      size: h ? { h, v: v || 0, label: `${h}×${v || 0}` } : null,
      status: statusN == null ? text(pick(input || {}, ['VideoStatus', 'SyncStatus'])) : (STATUS[statusN] || String(statusN)),
      thumb: thumb || null,
      plate: plateColor(name),
      format: text(pick(input || {}, ['Format'])),
    };
  });
}

function normalizePresets(list) {
  return asArray(list).map((p) => {
    const id = num(pick(p, ['id']));
    const sno = num(pick(p, ['presetSno', 'PresetSno']));
    return {
      id: id == null ? 0 : id,
      name: text(pick(p, ['Name'])) || `Preset ${id == null ? '' : id}`,
      sno: sno == null ? null : sno,
      locked: !!num(pick(p, ['LockMode'])),
    };
  });
}

function contentOf(contents, id) {
  if (!contents) return null;
  if (contents[id] != null) return contents[id];
  if (contents[String(id)] != null) return contents[String(id)];
  return null;
}

function normalize(capture = {}) {
  const unknown = [];
  const frame = readFrame(capture.frame || capture.frameSettings || {});
  const destRoot = capture.destinations || {};
  const screens = asArray(pick(destRoot, ['ScreenDestination', 'ScreenDestinations']) || destRoot.screens);
  const auxes = asArray(pick(destRoot, ['AuxDestination', 'AuxDestinations']) || destRoot.aux);
  const contents = capture.contents || {};
  const auxContent = capture.auxContent || {};
  const destinations = [];

  screens.forEach((raw, index) => {
    const id = num(pick(raw, ['id']));
    const sid = id == null ? index : id;
    const content = contentOf(contents, sid) || {};
    const body = content && content.response && typeof content.response === 'object' ? content.response : content;
    const name = text(pick(raw, ['Name'])) || text(pick(body, ['Name'])) || `Screen ${sid + 1}`;
    const key = `S${sid + 1}`;
    const layerRows = asArray(pick(body, ['Layers', 'Layer'])).filter((r) => r && typeof r === 'object');
    const layers = layerRows.map((row, i) => layerFrom(row, { path: `dest[${key}].layer[${num(pick(row, ['id'])) ?? i}]`, destKey: key, layerId: num(pick(row, ['id'])) ?? i }, unknown));
    const bg = backgroundLayer(pick(body, ['BGLyr', 'Background']), unknown, key);
    if (bg) layers.unshift(bg);
    const groups = new Map();
    for (const layer of layers) {
      if (layer.pair == null) continue;
      const g = groups.get(layer.pair) || [];
      g.push(layer.side);
      groups.set(layer.pair, g);
    }
    for (const layer of layers) {
      if (!layer.pair) continue;
      const sides = groups.get(layer.pair) || [];
      if (sides.includes('A') && sides.includes('B')) {
        layer.role = layer.side === 'B' ? 'split' : 'mix';
      }
    }
    const live = layers.some((l) => l.role !== 'background' && l.pgm && l.pgm.active);
    const preview = layers.some((l) => l.role !== 'background' && l.pvw && l.pvw.active);
    const destTrans = asArray(pick(body, ['Transition'])).filter((r) => r && typeof r === 'object');
    destinations.push({
      key, kind: 'screen', id: sid, name, size: destSize(raw) || destSize(body),
      layers, live, preview, aux: null,
      transition: destTrans.map((r) => ({
        id: num(pick(r, ['id'])),
        time: num(pick(r, ['TransTime', 'Time'])),
        armed: num(pick(r, ['ArmMode'])) === 1,
      })),
    });
  });

  auxes.forEach((raw, index) => {
    const id = num(pick(raw, ['id']));
    const sid = id == null ? index : id;
    const extra = contentOf(auxContent, sid) || {};
    const body = extra && extra.response && typeof extra.response === 'object' ? extra.response : extra;
    const name = text(pick(raw, ['Name'])) || text(pick(body, ['Name'])) || `Aux ${sid + 1}`;
    const pvwSourceId = num(pick(body, ['PvwLastSrcIndex', 'PvwLastSrcIdx']));
    const pgmSourceId = num(pick(body, ['PgmLastSrcIndex', 'PgmLastSrcIdx']));
    destinations.push({
      key: `A${sid + 1}`, kind: 'aux', id: sid, name, size: null, layers: [],
      live: false, preview: false,
      aux: {
        pvwSourceId: pvwSourceId == null || pvwSourceId < 0 ? null : pvwSourceId,
        pgmSourceId: pgmSourceId == null || pgmSourceId < 0 ? null : pgmSourceId,
      },
      transition: [],
    });
  });

  return {
    frame,
    destinations,
    sources: normalizeSources(capture.sources, capture.inputs),
    presets: normalizePresets(capture.presets),
    unknown,
  };
}

// A reviewed mapper proposal may fill a property the schema did not name.
// The write path still uses the documented changeContent keys. This only
// lets a variant *read* show up on a dial the desk already knows.
const PROPOSAL_FIELDS = {
  posH: ['window', 'hPos'],
  posV: ['window', 'vPos'],
  sizeH: ['window', 'hSize'],
  sizeV: ['window', 'vSize'],
  maskL: ['mask', 'left'],
  maskR: ['mask', 'right'],
  maskT: ['mask', 'top'],
  maskB: ['mask', 'bottom'],
  opacity: ['opacity'],
  borderSize: ['border', 'size'],
  borderSoft: ['border', 'softness'],
  shadowH: ['shadow', 'h'],
  shadowV: ['shadow', 'v'],
  keyClip: ['key', 'clip'],
  keyGain: ['key', 'gain'],
};

function applyProposal(model, proposal) {
  const spec = PROPOSAL_FIELDS[proposal && proposal.prop];
  if (!spec) return false;
  const hit = (model.unknown || []).find((u) => u.path === proposal.path);
  if (!hit || typeof hit.sample !== 'number') return false;
  const dest = (model.destinations || []).find((d) => d.key === hit.destKey);
  if (!dest) return false;
  const layer = (dest.layers || []).find((l) => l.id === hit.layerId);
  if (!layer) return false;
  const [group, field] = spec.length === 2 ? spec : [spec[0], null];
  for (const bus of ['pvw', 'pgm']) {
    const side = layer[bus];
    if (!side) continue;
    if (group === 'opacity') {
      if (side.opacity == null) side.opacity = hit.sample;
    } else if (field) {
      side[group] = side[group] || {};
      if (side[group][field] == null) side[group][field] = hit.sample;
    }
  }
  layer.fields = { ...fieldsFrom(layer.pvw), ...fieldsFrom(layer.pgm), ...layer.fields, [proposal.prop]: true };
  layer.capabilities = capsFrom(layer.fields);
  layer.capabilities.aspect = layer.capabilities.aspect || layer.capabilities.size;
  return true;
}

module.exports = {
  unwrap, num, pick, splitBus, normalize, applyProposal, PROPOSAL_FIELDS, plateColor,
};
