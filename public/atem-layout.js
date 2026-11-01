'use strict';
// ATEM LAYOUT: a 16:9 program raster for SuperSource boxes and upstream DVE keys.
// Drag, resize, snap. Numbers sit beside the picture. APPLY / READ talk to the switcher.
// SAVE PRESET keeps it in Control Center. SAVE MACRO writes Software Control XML and a
// Macro Desk macro. Geometry matches lib/atem-layout.js (32×18 frame, +y up).
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  const cmd = (name, body = {}) => run(api('POST', `/api/sys/atem/cmd/${name}`, body));
  let V = null; let tab = '';
  let doc = null; let dirty = false; let holding = false; let drag = null;
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const saveLs = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  let show = ls('cc.layShow', 'both');
  let grids = ls('cc.layGrid', { thirds: true, center: true, safe: true });
  let aspect = ls('cc.layAspect', true) !== false;
  let liveSend = ls('cc.layLive', true) !== false;
  let ssSel = Number(ls('cc.laySs', 0)) || 0;
  let sel = ls('cc.laySel', 'box:0');
  const BOX_COLORS = ['#3b8cff', '#18c35a', '#f0a500', '#e5262e'];
  const KEY_COLORS = ['#c084fc', '#2ec4b6', '#ff7a59', '#8fd14f'];
  const PATTERNS = ['Left-right bar', 'Top-bottom bar', 'H barn door', 'V barn door', 'Corners in four', 'Rect iris', 'Diamond iris', 'Circle iris', 'Top-left box', 'Top-right box', 'Bottom-right box', 'Bottom-left box', 'Top centre box', 'Right centre box', 'Bottom centre box', 'Left centre box', 'Top-left diagonal', 'Top-right diagonal'];
  const BEVELS = ['None', 'In', 'Out', 'In / out'];

  const connected = () => V && V.kind === 'atem' && V.status && V.status.connected;
  const meIndex = () => (window.CCATEMME ? window.CCATEMME.get() : 0);
  const srcOf = (id) => (V.sources || []).find((x) => x.id === id);
  const sname = (id) => { const x = srcOf(id); return x ? x.long : id === undefined || id === null ? '—' : String(id); };
  const ME = () => (V.mixEffects || [])[meIndex()] || { keyers: [] };
  const SS = () => (V.superSources || [])[ssSel] || null;
  const hasSs = () => (V.superSources || []).length > 0;
  const hasDve = () => !!((V.dves && V.dves.count) || (V.profile && V.profile.dve));

  // Keep in step with lib/atem-layout.js rectOf / unitsOf.
  function rectOf(x, y, sx, sy) {
    const width = sx * 100; const height = sy * 100;
    return { left: ((x + 16) / 32) * 100 - width / 2, top: ((9 - y) / 18) * 100 - height / 2, width, height };
  }
  function unitsOf(left, top, width, height) {
    return { x: ((left + width / 2) / 100) * 32 - 16, y: 9 - ((top + height / 2) / 100) * 18, sx: width / 100, sy: height / 100 };
  }
  function guides() {
    const third = 32 / 3;
    return { x: [-16, -16 + third, 0, -16 + 2 * third, 16, -14.4, 14.4, -12.8, 12.8], y: [9, 3, 0, -3, -9, 8.1, -8.1, 7.2, -7.2] };
  }
  function snap(v, targets) { let best = v; let dist = 0.4; for (const t of targets) { const d = Math.abs(v - t); if (d <= dist) { best = t; dist = d; } } return best; }

  function snapshot() {
    const m = ME(); const s = SS();
    return {
      me: meIndex(), ss: s ? ssSel : null,
      art: s && s.props ? { ...s.props } : null,
      border: s && s.border ? { ...s.border } : null,
      boxes: s ? (s.boxes || []).map((b) => ({ ...b })) : [],
      keys: (m.keyers || []).map((k) => ({
        ...k, luma: k.luma ? { ...k.luma } : null, chroma: k.chroma ? { ...k.chroma } : null,
        pattern: k.pattern ? { ...k.pattern } : null, mask: k.mask ? { ...k.mask } : null, dve: k.dve ? { ...k.dve } : null,
      })),
    };
  }
  function pull(force) {
    if (!connected()) return;
    if (!force && (holding || busy())) return;
    if (!force && !liveSend && dirty && doc) return;
    doc = snapshot();
    if (force) dirty = false;
  }

  const busy = () => { const a = document.activeElement; const pane = $('#pane-alayout'); return !!(a && pane && pane.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox' && a.id !== 'layName' && a.id !== 'laySlot' && a.id !== 'layFly' && a.id !== 'layFlyFrom'); };
  function num(label, value, scale, step, min, max, k, part, extra) {
    const shown = value === undefined || value === null || value === '' ? '' : +(Number(value) / scale).toFixed(3);
    return `<label class="ak-num">${label}<input type="number" step="${step}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} value="${shown}" data-k="${k}" data-scale="${scale}" data-part="${part}" ${extra || ''}></label>`;
  }
  function tog(label, on, k, part, extra) {
    return `<button type="button" class="mode mini ${on ? 'active' : ''}" data-bool="${on ? 0 : 1}" data-k="${k}" data-part="${part}" ${extra || ''}>${label}</button>`;
  }
  function selOpts(list, current) {
    const rows = list.slice();
    if (current !== undefined && current !== null && !rows.some((s) => s.id === current)) rows.unshift({ id: current, long: sname(current) });
    return rows.map((s) => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${esc(s.long || s.short || s.id)}</option>`).join('');
  }
  function boxVisual(b) {
    const u = rectOf((b.x || 0) / 100, (b.y || 0) / 100, Math.max(0.07, (b.size || 70) / 1000), Math.max(0.07, (b.size || 70) / 1000));
    if (!b.cropped) return u;
    const ft = (b.cropTop || 0) / 18000; const fb = (b.cropBottom || 0) / 18000; const fl = (b.cropLeft || 0) / 32000; const fr = (b.cropRight || 0) / 32000;
    const width = u.width * Math.max(0, 1 - fl - fr); const height = u.height * Math.max(0, 1 - ft - fb);
    return { left: u.left + u.width * fl, top: u.top + u.height * ft, width, height };
  }
  function keyVisual(k) {
    const d = k.dve || {};
    return rectOf((d.positionX || 0) / 1000, (d.positionY || 0) / 1000, Math.max(0.02, (d.sizeX || 1000) / 1000), Math.max(0.02, (d.sizeY || 1000) / 1000));
  }
  function styleOf(r) { return `left:${r.left}%;top:${r.top}%;width:${Math.max(r.width, 0)}%;height:${Math.max(r.height, 0)}%`; }
  const swatch = (hue, sat, luma) => `hsl(${(Number(hue) || 0) / 10} ${(Number(sat) || 0) / 10}% ${(Number(luma) || 0) / 10}%)`;

  function layerOnCanvas(kind, index) {
    if (kind === 'box') return show !== 'keys';
    if (kind === 'key') { const k = (doc.keys || [])[index]; return show !== 'ss' && k && (k.type === 'dve' || k.flyEnabled) && k.dve; }
    return false;
  }

  function render() {
    const pane = $('#pane-alayout'); if (!pane || tab !== 'alayout') return;
    if (busy() || holding) return;
    pull(false);
    const info = $('#layInfo');
    if (!connected()) {
      info.textContent = 'program raster · SuperSource boxes and upstream DVE keys';
      S.set($('#layMe'), 'laym', ''); S.set($('#laySs'), 'lays', '');
      S.set($('#layBody'), 'lay', '<div class="note">Not connected · put an ATEM (or its simulator) on the desk on ⌂ SYSTEMS.</div>');
      return;
    }
    if (ssSel >= (V.superSources || []).length) ssSel = 0;
    const mes = V.mixEffects || [];
    const name = V.profile ? V.profile.name : (V.product || 'ATEM');
    const dve = V.dves ? `${V.dves.inUse} of ${V.dves.count} DVE in use` : (hasDve() ? 'DVE' : 'no DVE');
    info.textContent = `${name} · ${(V.superSources || []).length} SuperSource · ${dve}`;
    S.set($('#layMe'), 'laym', mes.length > 1 ? mes.map((m) => `<button type="button" class="mode mini ${m.index === meIndex() ? 'active' : ''}" data-layme="${m.index}">M/E ${m.index + 1}</button>`).join('') : '');
    S.set($('#laySs'), 'lays', (V.superSources || []).length > 1 ? (V.superSources || []).map((s) => `<button type="button" class="mode mini ${s.index === ssSel ? 'active' : ''}" data-layss="${s.index}">SS ${s.index + 1}</button>`).join('') : '');
    if (!doc) doc = snapshot();
    ensureSel();
    S.set($('#layBody'), 'lay', canvasHtml());
    paintPresets();
  }
  function ensureSel() {
    const id = String(sel || '');
    if (id === 'art' && doc.ss !== null) return;
    if (id.startsWith('box:') && (doc.boxes || []).some((b) => b.index === Number(id.slice(4)))) return;
    if (id.startsWith('key:') && (doc.keys || []).some((k) => k.index === Number(id.slice(4)))) return;
    if ((doc.boxes || []).length) sel = `box:${doc.boxes[0].index}`;
    else if (doc.ss !== null) sel = 'art';
    else if ((doc.keys || []).length) sel = `key:${doc.keys[0].index}`;
    else sel = '';
  }

  function canvasHtml() {
    const g = grids;
    const thirds = g.thirds ? '<div class="lay-grid thirds"><i class="v" style="left:33.333%"></i><i class="v" style="left:66.666%"></i><i class="h" style="top:33.333%"></i><i class="h" style="top:66.666%"></i></div>' : '';
    const center = g.center ? '<div class="lay-grid center"><i class="v"></i><i class="h"></i></div>' : '';
    const safe = g.safe ? '<div class="lay-safe" style="left:5%;top:5%;width:90%;height:90%"><span>ACTION</span></div><div class="lay-safe title" style="left:10%;top:10%;width:80%;height:80%"><span>TITLE</span></div>' : '';
    const art = doc.art;
    const artName = art ? sname(art.artFillSource) : '';
    const artEl = doc.ss !== null ? `<div class="lay-art">${esc(artName)} ART · ${art && art.artOption === 1 ? 'FOREGROUND' : 'BACKGROUND'}</div>` : '';
    const boxes = (doc.boxes || []).map((b) => {
      if (!layerOnCanvas('box', b.index)) return '';
      const color = BOX_COLORS[b.index % BOX_COLORS.length];
      const border = doc.border && doc.border.borderEnabled;
      return `<div class="lay-box ${b.enabled ? '' : 'off'} ${sel === `box:${b.index}` ? 'sel' : ''}" data-layer="box:${b.index}" style="${styleOf(boxVisual(b))};background:${color}55;border-color:${color};z-index:${12 - b.index};${border ? `outline:2px solid ${swatch(doc.border.borderHue, doc.border.borderSaturation, doc.border.borderLuma)};` : ''}" title="${esc(sname(b.source))}">
        <b style="color:${color}">${b.index + 1}</b><span>${esc(sname(b.source))}</span>${sel === `box:${b.index}` ? handles() : ''}</div>`;
    }).join('');
    const keys = (doc.keys || []).map((k) => {
      if (!layerOnCanvas('key', k.index)) return '';
      const color = KEY_COLORS[k.index % KEY_COLORS.length];
      const d = k.dve || {};
      const border = d.borderEnabled;
      return `<div class="lay-box ${k.onAir ? '' : 'off'} ${sel === `key:${k.index}` ? 'sel' : ''}" data-layer="key:${k.index}" style="${styleOf(keyVisual(k))};background:${color}55;border-color:${color};z-index:${20 + k.index};transform:rotate(${(d.rotation || 0) / 10}deg);${border ? `outline:2px solid ${swatch(d.borderHue, d.borderSaturation, d.borderLuma)};` : ''}" title="${esc(sname(k.fill))}">
        <b style="color:${color}">K${k.index + 1}</b><span>${esc(sname(k.fill))}</span>${sel === `key:${k.index}` ? handles() : ''}</div>`;
    }).join('');
    const empty = !boxes && !keys ? `<div class="lay-art" style="align-items:center;justify-content:center;text-align:center;padding:16px">${hasSs() || hasDve() ? 'Turn a key to DVE, or enable a SuperSource box, to place it on the raster.' : 'This model has no SuperSource and no DVE. Key type, mask and pattern settings are still on the right.'}</div>` : '';
    const tools = `<div class="lay-tools">
      <button type="button" class="mode mini ${show === 'both' ? 'active' : ''}" data-layshow="both">BOTH</button>
      <button type="button" class="mode mini ${show === 'ss' ? 'active' : ''}" data-layshow="ss" ${hasSs() ? '' : 'disabled'}>SUPERSOURCE</button>
      <button type="button" class="mode mini ${show === 'keys' ? 'active' : ''}" data-layshow="keys">DVE KEYS</button>
      <button type="button" class="mode mini ${g.thirds ? 'active' : ''}" data-laygrid="thirds">THIRDS</button>
      <button type="button" class="mode mini ${g.center ? 'active' : ''}" data-laygrid="center">CENTER</button>
      <button type="button" class="mode mini ${g.safe ? 'active' : ''}" data-laygrid="safe">SAFE</button>
      <button type="button" class="mode mini ${aspect ? 'active' : ''}" data-layaspect="${aspect ? 0 : 1}">ASPECT</button>
      <button type="button" class="mode mini ${liveSend ? 'active' : ''}" data-laylive="${liveSend ? 0 : 1}">${liveSend ? 'LIVE' : 'HOLD'}</button>
      ${dirty ? '<span class="chip">UNSENT</span>' : ''}
    </div>`;
    const note = `<p class="note small">${hasSs() ? 'SuperSource size stays 16:9. Its border is one border for every box, not a border per box.' : 'This model has no SuperSource.'} ${hasDve() ? 'DVE keys can be a different shape. ASPECT locks that shape while you drag.' : 'This model has no DVE, so keys cannot be placed as boxes.'} Boxes snap to thirds, center, title and action safe, and to each other.</p>`;
    return `<div class="lay"><div class="lay-stage">${tools}<div class="lay-raster ${doc.art && doc.art.artOption === 1 ? 'art-fg' : ''}" id="layRaster">${thirds}${center}${safe}${artEl}${boxes}${keys}${empty}</div>${note}</div>${sideHtml()}</div>`;
  }
  function handles() { return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<i data-h="${h}" class="${h}"></i>`).join(''); }

  function sideHtml() {
    const layers = [];
    if (doc.ss !== null) layers.push(layerBtn('art', 'ART', doc.art && doc.art.artOption === 1 ? 'Foreground' : 'Background', '#8b97a8'));
    for (const b of doc.boxes || []) layers.push(layerBtn(`box:${b.index}`, `BOX ${b.index + 1}`, `${b.enabled ? '' : 'off · '}${sname(b.source)}`, BOX_COLORS[b.index % BOX_COLORS.length]));
    for (const k of doc.keys || []) layers.push(layerBtn(`key:${k.index}`, `KEY ${k.index + 1}`, `${k.type.toUpperCase()} · ${sname(k.fill)}${k.onAir ? ' · ON AIR' : ''}`, KEY_COLORS[k.index % KEY_COLORS.length]));
    if (!layers.length) layers.push('<div class="note small">This M/E has no upstream keys.</div>');
    return `<div class="lay-side"><div class="lay-layers">${layers.join('')}</div><div class="lay-insp">${inspector()}</div></div>`;
  }
  function layerBtn(id, title, sub, color) {
    return `<button type="button" class="lay-layer ${sel === id ? 'on' : ''}" data-laysel="${id}"><i class="sw" style="background:${color}"></i><span><b>${title}</b><br><small>${esc(sub)}</small></span></button>`;
  }

  function inspector() {
    if (sel === 'art' && doc.art) return artHtml();
    if (String(sel).startsWith('box:')) { const b = (doc.boxes || []).find((x) => x.index === Number(sel.slice(4))); return b ? boxHtml(b) : '<div class="note small">That box is not on this model.</div>'; }
    if (String(sel).startsWith('key:')) { const k = (doc.keys || []).find((x) => x.index === Number(sel.slice(4))); return k ? keyHtml(k) : '<div class="note small">That key is not on this M/E.</div>'; }
    if ((doc.boxes || []).length) { sel = `box:${doc.boxes[0].index}`; return boxHtml(doc.boxes[0]); }
    if ((doc.keys || []).length) { sel = `key:${doc.keys[0].index}`; return keyHtml(doc.keys[0]); }
    return '<div class="note small">Nothing to edit on this model.</div>';
  }
  function artHtml() {
    const a = doc.art; const artSrc = (V.sources || []).filter((x) => x.sa & 4);
    return `<div class="ak-head"><b>ART</b>${tog(a.artOption === 1 ? 'FOREGROUND' : 'BACKGROUND', a.artOption === 1, 'artOption', 'art')}</div>
      <div class="ak-row"><label class="ak-sel">FILL<select data-k="artFillSource" data-part="art">${selOpts(artSrc, a.artFillSource)}</select></label>
        <label class="ak-sel">KEY<select data-k="artCutSource" data-part="art">${selOpts(V.sources || [], a.artCutSource)}</select></label></div>
      <div class="ak-row">${tog(a.artPreMultiplied ? 'PRE-MULT' : 'CLIP / GAIN', a.artPreMultiplied, 'artPreMultiplied', 'art')}${num('CLIP %', a.artClip, 10, 1, 0, 100, 'artClip', 'art')}${num('GAIN %', a.artGain, 10, 1, 0, 100, 'artGain', 'art')}${tog('INVERT', a.artInvertKey, 'artInvertKey', 'art')}</div>
      ${borderHtml('border', doc.border || {}, 'Border for every box on this SuperSource')}`;
  }
  function borderHtml(part, bd, note) {
    return `<div class="ak-head"><b>BORDER</b>${tog(bd.borderEnabled ? 'ON' : 'OFF', bd.borderEnabled, 'borderEnabled', part)}<i class="lay-swatch" style="background:${swatch(bd.borderHue, bd.borderSaturation, bd.borderLuma)}"></i></div>
      <p class="note small">${esc(note)}</p>
      <div class="ak-row">${num('OUT', bd.borderOuterWidth, 100, 0.01, 0, 16, 'borderOuterWidth', part)}${num('IN', bd.borderInnerWidth, 100, 0.01, 0, 16, 'borderInnerWidth', part)}${num('SOFT', bd.borderOuterSoftness, 1, 1, 0, 100, 'borderOuterSoftness', part)}${num('IN SOFT', bd.borderInnerSoftness, 1, 1, 0, 100, 'borderInnerSoftness', part)}</div>
      <div class="ak-row">${num('HUE', bd.borderHue, 10, 1, 0, 359.9, 'borderHue', part)}${num('SAT %', bd.borderSaturation, 10, 1, 0, 100, 'borderSaturation', part)}${num('LUMA %', bd.borderLuma, 10, 1, 0, 100, 'borderLuma', part)}
        <label class="ak-sel">BEVEL<select data-k="borderBevel" data-part="${part}">${BEVELS.map((n, i) => `<option value="${i}" ${i === bd.borderBevel ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
      <div class="ak-row">${num('LIGHT °', part === 'border' ? bd.borderLightSourceDirection : bd.lightSourceDirection, 10, 1, 0, 359.9, part === 'border' ? 'borderLightSourceDirection' : 'lightSourceDirection', part)}${num('ALT', part === 'border' ? bd.borderLightSourceAltitude : bd.lightSourceAltitude, 1, 1, 0, 100, part === 'border' ? 'borderLightSourceAltitude' : 'lightSourceAltitude', part)}${part === 'dve' ? tog(bd.shadowEnabled ? 'SHADOW' : 'NO SHADOW', bd.shadowEnabled, 'shadowEnabled', part) : ''}</div>`;
  }
  function boxHtml(b) {
    const ids = `data-box="${b.index}"`;
    const boxSrc = (V.sources || []).filter((x) => x.sa & 8);
    return `<div class="ak-head"><b>BOX ${b.index + 1}</b>${tog(b.enabled ? 'ENABLED' : 'DISABLED', b.enabled, 'enabled', 'box', ids)}</div>
      <div class="ak-row"><label class="ak-sel">SOURCE<select data-k="source" data-part="box" ${ids}>${selOpts(boxSrc, b.source)}</select></label></div>
      <div class="ak-row">${num('X', b.x, 100, 0.1, -48, 48, 'x', 'box', ids)}${num('Y', b.y, 100, 0.1, -27, 27, 'y', 'box', ids)}${num('SIZE', b.size, 1000, 0.01, 0.07, 1, 'size', 'box', ids)}</div>
      <div class="ak-row">${tog(b.cropped ? 'CROP ON' : 'CROP', b.cropped, 'cropped', 'box', ids)}${num('T', b.cropTop, 1000, 0.1, 0, 18, 'cropTop', 'box', ids)}${num('B', b.cropBottom, 1000, 0.1, 0, 18, 'cropBottom', 'box', ids)}${num('L', b.cropLeft, 1000, 0.1, 0, 32, 'cropLeft', 'box', ids)}${num('R', b.cropRight, 1000, 0.1, 0, 32, 'cropRight', 'box', ids)}</div>
      ${borderHtml('border', doc.border || {}, 'Shared by every box on this SuperSource')}`;
  }
  function keyHtml(k) {
    const ids = `data-key="${k.index}"`;
    const keySrc = (V.sources || []).filter((x) => x.sa & 16);
    const d = k.dve || {}; const mk = k.mask || {};
    const types = ['luma', 'chroma', 'pattern', 'dve'].map((t) => `<button type="button" class="mode mini ${k.type === t ? 'active' : ''}" data-laytype="${t}" data-key="${k.index}" ${t === 'dve' && !hasDve() ? 'disabled title="No DVE on this model"' : ''}>${t.toUpperCase()}</button>`).join('');
    let body = '';
    if (k.type === 'luma' && k.luma) body = `${tog('PRE-MULT', k.luma.preMultiplied, 'preMultiplied', 'luma', ids)}${num('CLIP %', k.luma.clip, 10, 1, 0, 100, 'clip', 'luma', ids)}${num('GAIN %', k.luma.gain, 10, 1, 0, 100, 'gain', 'luma', ids)}${tog('INVERT', k.luma.invert, 'invert', 'luma', ids)}`;
    if (k.type === 'chroma' && k.chroma) body = `${num('HUE °', k.chroma.hue, 10, 1, 0, 359.9, 'hue', 'chroma', ids)}${num('GAIN %', k.chroma.gain, 10, 1, 0, 100, 'gain', 'chroma', ids)}${num('Y SUPP %', k.chroma.ySuppress, 10, 1, 0, 100, 'ySuppress', 'chroma', ids)}${num('LIFT %', k.chroma.lift, 10, 1, 0, 100, 'lift', 'chroma', ids)}${tog('NARROW', k.chroma.narrow, 'narrow', 'chroma', ids)}`;
    if (k.type === 'pattern' && k.pattern) body = `<label class="ak-sel">PATTERN<select data-k="style" data-part="pattern" ${ids}>${PATTERNS.map((n, i) => `<option value="${i}" ${i === k.pattern.style ? 'selected' : ''}>${n}</option>`).join('')}</select></label>${num('SIZE %', k.pattern.size, 100, 1, 0, 100, 'size', 'pattern', ids)}${num('SYMM %', k.pattern.symmetry, 100, 1, 0, 100, 'symmetry', 'pattern', ids)}${num('SOFT %', k.pattern.softness, 100, 1, 0, 100, 'softness', 'pattern', ids)}${num('X', k.pattern.positionX, 10000, 0.01, 0, 1, 'positionX', 'pattern', ids)}${num('Y', k.pattern.positionY, 10000, 0.01, 0, 1, 'positionY', 'pattern', ids)}${tog('INVERT', k.pattern.invert, 'invert', 'pattern', ids)}`;
    const dve = (k.type === 'dve' || k.flyEnabled) && k.dve ? `<div class="ak-row">${num('X', d.positionX, 1000, 0.1, -32, 32, 'positionX', 'dve', ids)}${num('Y', d.positionY, 1000, 0.1, -18, 18, 'positionY', 'dve', ids)}${num('SIZE X', d.sizeX, 1000, 0.01, 0, 99, 'sizeX', 'dve', ids)}${num('SIZE Y', d.sizeY, 1000, 0.01, 0, 99, 'sizeY', 'dve', ids)}${num('ROT °', d.rotation, 10, 1, -360, 360, 'rotation', 'dve', ids)}</div>
      ${borderHtml('dve', d, 'Border and light on this DVE key')}
      <div class="ak-row"><span class="modes-lbl">DVE MASK</span>${tog(d.maskEnabled ? 'ON' : 'OFF', d.maskEnabled, 'maskEnabled', 'dve', ids)}${num('T', d.maskTop, 1000, 0.1, 0, 18, 'maskTop', 'dve', ids)}${num('B', d.maskBottom, 1000, 0.1, 0, 18, 'maskBottom', 'dve', ids)}${num('L', d.maskLeft, 1000, 0.1, 0, 32, 'maskLeft', 'dve', ids)}${num('R', d.maskRight, 1000, 0.1, 0, 32, 'maskRight', 'dve', ids)}</div>
      <div class="ak-fly"><span class="modes-lbl">FLY</span><button type="button" class="mode mini" data-layfly="store" data-frame="a" data-key="${k.index}">STORE A</button><button type="button" class="mode mini" data-layfly="store" data-frame="b" data-key="${k.index}">STORE B</button><button type="button" class="mode mini" data-layfly="run" data-frame="a" data-key="${k.index}">RUN A</button><button type="button" class="mode mini" data-layfly="run" data-frame="b" data-key="${k.index}">RUN B</button></div>` : '';
    return `<div class="ak-head"><b>KEY ${k.index + 1}</b><button type="button" class="mode ${k.onAir ? 'onair' : ''}" data-layair="${k.index}" data-on="${k.onAir ? 0 : 1}">${k.onAir ? 'ON AIR' : 'OFF'}</button><span class="seg-row">${types}</span>${k.type !== 'dve' ? tog(k.flyEnabled ? 'FLY ON' : 'FLY', k.flyEnabled, 'flyEnabled', 'type', ids) : ''}</div>
      <div class="ak-row"><label class="ak-sel">FILL<select data-k="fill" data-part="sources" ${ids}>${selOpts(keySrc, k.fill)}</select></label>${k.type === 'luma' ? `<label class="ak-sel">KEY<select data-k="cut" data-part="sources" ${ids}>${selOpts(V.sources || [], k.cut)}</select></label>` : ''}</div>
      <div class="ak-row">${body}</div>${dve}
      <div class="ak-row"><span class="modes-lbl">MASK</span>${tog(mk.enabled ? 'ON' : 'OFF', mk.enabled, 'enabled', 'mask', ids)}${num('T', mk.top, 1000, 0.1, -9, 9, 'top', 'mask', ids)}${num('B', mk.bottom, 1000, 0.1, -9, 9, 'bottom', 'mask', ids)}${num('L', mk.left, 1000, 0.1, -16, 16, 'left', 'mask', ids)}${num('R', mk.right, 1000, 0.1, -16, 16, 'right', 'mask', ids)}</div>`;
  }

  function paintPresets() {
    const list = V.layoutPresets || [];
    const fly = $('#layFlyFrom');
    if (fly && document.activeElement !== fly) {
      const cur = fly.value;
      fly.innerHTML = `<option value="">—</option>${list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}`;
      if ([...fly.options].some((o) => o.value === cur)) fly.value = cur;
    }
  }

  function patch(part, keyIndex, k, value) {
    if (part === 'box') { const b = doc.boxes.find((x) => x.index === keyIndex); if (b) b[k] = value; }
    else if (part === 'art') { doc.art[k] = value; if (k === 'artOption') doc.art.artOption = value ? 1 : 0; }
    else if (part === 'border') { doc.border = doc.border || {}; doc.border[k] = value; }
    else if (part === 'dve') { const key = doc.keys.find((x) => x.index === keyIndex); if (key) { key.dve = key.dve || {}; key.dve[k] = value; } }
    else if (part === 'mask') { const key = doc.keys.find((x) => x.index === keyIndex); if (key) { key.mask = key.mask || {}; key.mask[k] = value; } }
    else if (part === 'luma' || part === 'chroma' || part === 'pattern') { const key = doc.keys.find((x) => x.index === keyIndex); if (key && key[part]) key[part][k] = value; }
    else if (part === 'sources') { const key = doc.keys.find((x) => x.index === keyIndex); if (key) key[k] = value; }
    else if (part === 'type') { const key = doc.keys.find((x) => x.index === keyIndex); if (key) key.flyEnabled = !!value; }
    if (!liveSend) dirty = true;
  }
  function sendPart(part, keyIndex, k, value) {
    if (!liveSend) { render(); return; }
    const me = meIndex() + 1;
    if (part === 'box') return cmd('ssBox', { ss: ssSel, box: keyIndex, [k]: value });
    if (part === 'art') return cmd('ssProps', { ss: ssSel, [k]: k === 'artOption' ? (value ? 1 : 0) : value });
    if (part === 'border') return cmd('ssBorder', { ss: ssSel, [k]: value });
    if (part === 'dve') return cmd('uskDve', { me, key: keyIndex, [k]: value });
    if (part === 'mask') return cmd('uskMask', { me, key: keyIndex, [k]: value });
    if (part === 'luma') return cmd('uskLuma', { me, key: keyIndex, [k]: value });
    if (part === 'chroma') return cmd('uskChroma', { me, key: keyIndex, [k]: value });
    if (part === 'pattern') return cmd('uskPattern', { me, key: keyIndex, [k]: value });
    if (part === 'sources') return cmd('uskSources', { me, key: keyIndex, [k]: value });
    if (part === 'type') return cmd('uskType', { me, key: keyIndex, flyEnabled: !!value });
    return undefined;
  }

  function raster() { return $('#layRaster'); }
  function layerEl(id) { return document.querySelector(`#layRaster [data-layer="${id}"]`); }
  function readLayer(id) {
    if (id.startsWith('box:')) return { kind: 'box', item: (doc.boxes || []).find((b) => b.index === Number(id.slice(4))) };
    return { kind: 'key', item: (doc.keys || []).find((k) => k.index === Number(id.slice(4))) };
  }
  function uncropped(kind, item) {
    if (kind === 'box') return rectOf(item.x / 100, item.y / 100, item.size / 1000, item.size / 1000);
    const d = item.dve || {};
    return rectOf(d.positionX / 1000, d.positionY / 1000, d.sizeX / 1000, d.sizeY / 1000);
  }
  function writeGeom(kind, item, u) {
    if (kind === 'box') {
      const size = Math.max(0.07, Math.min(1, u.sx));
      item.x = Math.round(Math.max(-48, Math.min(48, u.x)) * 100);
      item.y = Math.round(Math.max(-27, Math.min(27, u.y)) * 100);
      item.size = Math.round(size * 1000);
      return { x: item.x, y: item.y, size: item.size };
    }
    const d = item.dve || (item.dve = {});
    let sx = Math.max(0.02, u.sx); let sy = Math.max(0.02, u.sy);
    if (aspect) { const r = (drag && drag.ratio) || (sx / sy) || 1; sy = sx / r; }
    d.positionX = Math.round(Math.max(-32, Math.min(32, u.x)) * 1000);
    d.positionY = Math.round(Math.max(-18, Math.min(18, u.y)) * 1000);
    d.sizeX = Math.round(Math.min(99, sx) * 1000);
    d.sizeY = Math.round(Math.min(99, sy) * 1000);
    return { positionX: d.positionX, positionY: d.positionY, sizeX: d.sizeX, sizeY: d.sizeY };
  }
  function otherTargets(id) {
    const g = guides(); const xs = g.x.slice(); const ys = g.y.slice();
    for (const b of doc.boxes || []) {
      if (`box:${b.index}` === id || !layerOnCanvas('box', b.index)) continue;
      const r = uncropped('box', b); const u = unitsOf(r.left, r.top, r.width, r.height);
      xs.push(u.x, u.x - 16 * u.sx, u.x + 16 * u.sx); ys.push(u.y, u.y - 9 * u.sy, u.y + 9 * u.sy);
    }
    for (const k of doc.keys || []) {
      if (`key:${k.index}` === id || !layerOnCanvas('key', k.index)) continue;
      const r = uncropped('key', k); const u = unitsOf(r.left, r.top, r.width, r.height);
      xs.push(u.x, u.x - 16 * u.sx, u.x + 16 * u.sx); ys.push(u.y, u.y - 9 * u.sy, u.y + 9 * u.sy);
    }
    return { x: xs, y: ys };
  }
  function paintEl(id, kind, item) {
    const el = layerEl(id); if (!el) return;
    const r = kind === 'box' ? boxVisual(item) : keyVisual(item);
    el.style.left = `${r.left}%`; el.style.top = `${r.top}%`; el.style.width = `${Math.max(r.width, 0)}%`; el.style.height = `${Math.max(r.height, 0)}%`;
  }

  $('#pane-alayout').addEventListener('pointerdown', (e) => { if (e.target.closest('input, select, textarea')) holding = true; }, true);
  document.addEventListener('pointerup', () => { if (drag) return; if (!holding) return; holding = false; setTimeout(render, 40); });
  $('#layBody').addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-h]');
    const layer = e.target.closest('[data-layer]');
    const pick = e.target.closest('[data-laysel]');
    if (pick) { sel = pick.dataset.laysel; saveLs('cc.laySel', sel); render(); return; }
    if (!layer || !doc) return;
    sel = layer.dataset.layer; saveLs('cc.laySel', sel);
    const found = readLayer(sel); if (!found.item) return;
    const r = uncropped(found.kind, found.item);
    holding = true;
    drag = { id: e.pointerId, layer: sel, kind: found.kind, item: found.item, mode: h ? 'resize' : 'move', edge: h ? h.dataset.h : '', x0: e.clientX, y0: e.clientY, rect: r, ratio: r.width / Math.max(0.01, r.height) };
    layer.setPointerCapture(e.pointerId);
    document.querySelectorAll('#layRaster .lay-box').forEach((n) => n.classList.toggle('sel', n.dataset.layer === sel));
  });
  $('#layBody').addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const box = raster(); if (!box) return;
    const w = box.clientWidth; const h = box.clientHeight;
    const dx = ((e.clientX - drag.x0) / w) * 100; const dy = ((e.clientY - drag.y0) / h) * 100;
    let r = { ...drag.rect };
    if (drag.mode === 'move') { r.left += dx; r.top += dy; }
    else {
      const edge = drag.edge;
      if (edge.includes('e')) r.width = Math.max(2, drag.rect.width + dx);
      if (edge.includes('s')) r.height = Math.max(2, drag.rect.height + dy);
      if (edge.includes('w')) { r.width = Math.max(2, drag.rect.width - dx); r.left = drag.rect.left + drag.rect.width - r.width; }
      if (edge.includes('n')) { r.height = Math.max(2, drag.rect.height - dy); r.top = drag.rect.top + drag.rect.height - r.height; }
      const lock = drag.kind === 'box' || aspect;
      if (lock) {
        if (edge === 'e' || edge === 'w') r.height = r.width / drag.ratio;
        else if (edge === 'n' || edge === 's') r.width = r.height * drag.ratio;
        else { const s = Math.max(r.width / drag.rect.width, r.height / drag.rect.height); r.width = drag.rect.width * s; r.height = drag.rect.height * s; if (edge.includes('w')) r.left = drag.rect.left + drag.rect.width - r.width; if (edge.includes('n')) r.top = drag.rect.top + drag.rect.height - r.height; }
      }
    }
    let u = unitsOf(r.left, r.top, r.width, r.height);
    if (drag.mode === 'move') { const t = otherTargets(drag.layer); u.x = snap(u.x, t.x); u.y = snap(u.y, t.y); }
    if (drag.kind === 'box') u.sy = u.sx;
    writeGeom(drag.kind, drag.item, u);
    paintEl(drag.layer, drag.kind, drag.item);
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const sent = drag; drag = null; holding = false;
    const fields = sent.kind === 'box'
      ? { x: sent.item.x, y: sent.item.y, size: sent.item.size }
      : { positionX: sent.item.dve.positionX, positionY: sent.item.dve.positionY, sizeX: sent.item.dve.sizeX, sizeY: sent.item.dve.sizeY };
    if (!liveSend) { dirty = true; render(); return; }
    const p = sent.kind === 'box' ? cmd('ssBox', { ss: ssSel, box: sent.item.index, ...fields }) : cmd('uskDve', { me: meIndex() + 1, key: sent.item.index, ...fields });
    p.then(() => render());
  }
  $('#layBody').addEventListener('pointerup', endDrag);
  $('#layBody').addEventListener('pointercancel', endDrag);

  $('#layBody').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !connected()) return;
    if (b.dataset.laysel) { sel = b.dataset.laysel; saveLs('cc.laySel', sel); render(); return; }
    if (b.dataset.layshow) { show = b.dataset.layshow; saveLs('cc.layShow', show); return render(); }
    if (b.dataset.laygrid) { grids[b.dataset.laygrid] = !grids[b.dataset.laygrid]; saveLs('cc.layGrid', grids); return render(); }
    if (b.dataset.layaspect !== undefined) { aspect = b.dataset.layaspect === '1'; saveLs('cc.layAspect', aspect); return render(); }
    if (b.dataset.laylive !== undefined) { liveSend = b.dataset.laylive === '1'; saveLs('cc.layLive', liveSend); return render(); }
    if (b.dataset.bool !== undefined) {
      const part = b.dataset.part; const k = b.dataset.k; const idx = Number(b.dataset.box ?? b.dataset.key);
      let value = b.dataset.bool === '1';
      if (k === 'artOption') value = !(doc.art && doc.art.artOption === 1);
      patch(part, idx, k, value);
      return sendPart(part, idx, k, k === 'artOption' ? value : value);
    }
    if (b.dataset.laytype) {
      const key = doc.keys.find((x) => x.index === Number(b.dataset.key)); if (!key) return;
      key.type = b.dataset.laytype; if (!liveSend) dirty = true;
      return cmd('uskType', { me: meIndex() + 1, key: key.index, type: key.type }).then(() => { if (!liveSend) render(); });
    }
    if (b.dataset.layair !== undefined) {
      const key = doc.keys.find((x) => x.index === Number(b.dataset.layair)); if (!key) return;
      key.onAir = b.dataset.on === '1'; if (!liveSend) dirty = true;
      return cmd('uskOnAir', { me: meIndex() + 1, key: key.index, on: key.onAir });
    }
    if (b.dataset.layfly) {
      const body = { me: meIndex() + 1, key: Number(b.dataset.key), frame: b.dataset.frame };
      if (b.dataset.layfly === 'store') return run(api('POST', '/api/sys/atem/cmd/layoutApply', { layout: doc, store: b.dataset.frame })).then((r) => toast(`Key frame ${b.dataset.frame.toUpperCase()} stored${r.skipped && r.skipped.length ? ` · ${r.skipped[0].reason}` : ''}`));
      return cmd('uskFlyRun', body).then(() => toast(`Run to ${b.dataset.frame.toUpperCase()}`));
    }
    return undefined;
  });
  $('#layBody').addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset || !t.dataset.part || !doc) return;
    const part = t.dataset.part; const idx = Number(t.dataset.box ?? t.dataset.key);
    const value = t.tagName === 'SELECT' || t.dataset.scale ? (t.dataset.scale ? Math.round(Number(t.value) * Number(t.dataset.scale)) : Number(t.value)) : t.value;
    if (t.dataset.scale && !Number.isFinite(value)) return;
    patch(part, idx, t.dataset.k, value);
    sendPart(part, idx, t.dataset.k, value);
    if (t.tagName === 'SELECT') t.blur();
  });
  $('#layMe').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layme]'); if (!b) return;
    if (dirty) toast('Unsent edits were dropped');
    dirty = false;
    if (window.CCATEMME) window.CCATEMME.set(Number(b.dataset.layme));
    doc = null; render();
  });
  $('#laySs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layss]'); if (!b) return;
    if (dirty) toast('Unsent edits were dropped');
    dirty = false; ssSel = Number(b.dataset.layss); saveLs('cc.laySs', ssSel); doc = null; render();
  });
  $('#layRead').addEventListener('click', () => { dirty = false; pull(true); toast('Read from the switcher'); render(); });
  $('#layApply').addEventListener('click', () => {
    if (!connected() || !doc) return;
    run(api('POST', '/api/sys/atem/cmd/layoutApply', { layout: doc })).then((r) => {
      dirty = false;
      const skip = r.skipped && r.skipped.length ? ` · ${r.skipped.map((s) => s.reason).join('; ')}` : '';
      toast(`Layout applied${skip}`, !!(r.skipped && r.skipped.length));
    });
  });
  $('#laySavePreset').addEventListener('click', () => {
    if (!doc) return;
    const name = $('#layName').value.trim(); if (!name) return toast('Type a name', true);
    run(api('POST', '/api/sys/atem/layout-presets', { name, layout: doc })).then(() => { toast(`Preset “${name}” saved`); S.refetch(); });
  });
  $('#laySaveMacro').addEventListener('click', () => {
    if (!doc) return;
    const name = $('#layName').value.trim() || 'Layout';
    const slot = Number($('#laySlot').value);
    if (!(slot >= 1 && slot <= 100)) return toast('Macro slot is 1–100', true);
    const mode = $('#layFly').value;
    const flyFrom = $('#layFlyFrom').value;
    if (mode === 'pair' && !flyFrom) return toast('Pick the preset that should become key frame A', true);
    const body = { name, index: slot - 1, layout: doc, store: mode || null };
    if (mode === 'pair') body.flyFromPreset = flyFrom;
    run(api('POST', '/api/sys/atem/layout-macro', body)).then((r) => {
      $('#layXml').value = r.xml || '';
      const skip = r.skipped && r.skipped.length ? ` · ${r.skipped[0].reason}` : '';
      toast(`Macro ${slot} “${name}” saved${skip}`);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (window.CC.getTab() !== 'alayout' || !doc || drag || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const step = e.shiftKey ? 1 : 0.1;
    const found = readLayer(sel); if (!found.item) return;
    let dx = 0; let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step; else if (e.key === 'ArrowUp') dy = step; else if (e.key === 'ArrowDown') dy = -step; else return;
    e.preventDefault();
    const r = uncropped(found.kind, found.item);
    const u = unitsOf(r.left, r.top, r.width, r.height);
    u.x += dx; u.y += dy;
    const fields = writeGeom(found.kind, found.item, u);
    if (!liveSend) { dirty = true; render(); return; }
    const p = found.kind === 'box' ? cmd('ssBox', { ss: ssSel, box: found.item.index, ...fields }) : cmd('uskDve', { me: meIndex() + 1, key: found.item.index, ...fields });
    p.then(() => render());
  });

  S.onRender((v, t) => { V = v; tab = t; if (tab === 'alayout') render(); });
})();
