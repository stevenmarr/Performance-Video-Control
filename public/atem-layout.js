'use strict';
// ATEM LAYOUT. Three tabs:
//   M/Es — every mix effect at once, upstream keys and downstream keys as resources
//   SUPERSOURCE — every SuperSource and its boxes
//   MULTIVIEW — layout, program/preview swap, window sources, safe area and VU
// Properties sit on the left. Resources sit on the right. A drop places a resource
// on the canvas; it goes on air only while LIVE is on. LIVE also sends position and
// size as the drag ends. Geometry matches lib/atem-layout.js.
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  const cmd = (name, body = {}) => run(api('POST', `/api/sys/atem/cmd/${name}`, body));
  let V = null; let tab = '';
  let doc = null; let mvDoc = null; let dirty = false; let holding = false; let drag = null; let pin = 0;
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const saveLs = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  let layTab = ls('cc.layTab', 'me'); if (!['me', 'ss', 'mv'].includes(layTab)) layTab = 'me';
  let meVis = ls('cc.layMeVis', {}); if (!meVis || typeof meVis !== 'object') meVis = {};
  let grids = ls('cc.layGrid', { thirds: true, center: true, safe: true });
  let aspect = ls('cc.layAspect', true) !== false;
  let liveSend = ls('cc.layLive', true) !== false;
  let sel = ls('cc.laySel', '');
  let zTop = ls('cc.layZ', {}); if (!zTop || typeof zTop !== 'object') zTop = {};
  let zSeq = Object.values(zTop).reduce((n, v) => Math.max(n, Number(v) || 0), 0);
  const BOX_COLORS = ['#3b8cff', '#18c35a', '#f0a500', '#e5262e'];
  const KEY_COLORS = ['#c084fc', '#2ec4b6', '#ff7a59', '#8fd14f'];
  const DSK_COLORS = ['#ff5a7a', '#7eb6ff'];
  const PATTERNS = ['Left-right bar', 'Top-bottom bar', 'H barn door', 'V barn door', 'Corners in four', 'Rect iris', 'Diamond iris', 'Circle iris', 'Top-left box', 'Top-right box', 'Bottom-right box', 'Bottom-left box', 'Top centre box', 'Right centre box', 'Bottom centre box', 'Left centre box', 'Top-left diagonal', 'Top-right diagonal'];
  const BEVELS = ['None', 'In', 'Out', 'In / out'];
  const MV_NAMES = ['Program top', 'Program bottom', 'Program left', 'Program right'];

  const connected = () => V && V.kind === 'atem' && V.status && V.status.connected;
  const srcOf = (id) => (V.sources || []).find((x) => x.id === id);
  const sname = (id) => { const x = srcOf(id); return x ? x.long : id === undefined || id === null ? '—' : String(id); };
  const hasDve = () => !!((V.dves && V.dves.count) || (V.profile && V.profile.dve));
  const dveCount = () => (V.dves && V.dves.count) || (V.profile && V.profile.dve) || 0;
  const meShown = (i) => meVis[String(i)] !== false;
  const keyPlaced = (k) => !!(k && (k.placed || k.onAir || k.type === 'dve' || k.flyEnabled));
  const boxPlaced = (b) => !!(b && b.enabled);
  const dskPlaced = (d) => !!(d && (d.placed || d.onAir || d.tie));
  const positioned = (k) => !!(k && (k.type === 'dve' || k.flyEnabled) && k.dve);

  function copyKey(k) {
    return { ...k, placed: keyPlaced(k), luma: k.luma ? { ...k.luma } : null, chroma: k.chroma ? { ...k.chroma } : null, pattern: k.pattern ? { ...k.pattern } : null, mask: k.mask ? { ...k.mask } : null, dve: k.dve ? { ...k.dve } : null };
  }
  function snapshot() {
    return {
      mes: (V.mixEffects || []).map((m) => ({ me: m.index, program: m.program, preview: m.preview, keys: (m.keyers || []).map(copyKey) })),
      dsks: (V.dsk || []).map((d) => ({ ...d, placed: !!(d.onAir || d.tie), mask: d.mask ? { ...d.mask } : null })),
      superSources: (V.superSources || []).map((s) => ({ ss: s.index, art: s.props ? { ...s.props } : null, border: s.border ? { ...s.border } : null, boxes: (s.boxes || []).map((b) => ({ ...b })) })),
    };
  }
  function mvSnapshot() {
    return (V.multiviewers || []).map((mv) => ({ index: mv.index, layout: mv.layout || 0, swapped: !!mv.swapped, windows: (mv.windows || []).map((w) => ({ ...w })) }));
  }
  function pull(force) {
    if (!connected()) return;
    if (!force && (holding || busy() || pin || (window.CCDRAG && window.CCDRAG.active()))) return;
    if (!force && !liveSend && dirty && doc) return;
    doc = snapshot(); mvDoc = mvSnapshot();
    if (force) dirty = false;
  }
  function commit(p) { pin++; return Promise.resolve(p).finally(() => { pin = Math.max(0, pin - 1); render(); }); }

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
  function packCells(n, area) {
    if (!n) return [];
    const cols = area.cols || Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = i % cols; const r = Math.floor(i / cols);
      out.push({ left: area.x + (area.w * c) / cols, top: area.y + (area.h * r) / rows, width: area.w / cols, height: area.h / rows });
    }
    return out;
  }
  function mvRects(count, layout, swapped) {
    const n = Math.max(0, Math.min(16, count | 0));
    const rects = Array.from({ length: n }, () => null);
    if (!n) return rects;
    if (n === 1) { rects[0] = { left: 0, top: 0, width: 100, height: 100 }; return rects; }
    const lay = ((Number(layout) || 0) % 4 + 4) % 4;
    const large = swapped ? [1, 0] : [0, 1];
    const smallIdx = []; for (let i = 2; i < n; i++) smallIdx.push(i);
    const wideCols = smallIdx.length > 8 ? 7 : 4;
    let largeAreas; let smallArea;
    if (lay === 1) { largeAreas = [{ x: 0, y: 50, w: 50, h: 50 }, { x: 50, y: 50, w: 50, h: 50 }]; smallArea = { x: 0, y: 0, w: 100, h: 50, cols: Math.min(wideCols, Math.max(1, smallIdx.length)) }; }
    else if (lay === 2) { largeAreas = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 0, y: 50, w: 50, h: 50 }]; smallArea = { x: 50, y: 0, w: 50, h: 100, cols: 2 }; }
    else if (lay === 3) { largeAreas = [{ x: 50, y: 0, w: 50, h: 50 }, { x: 50, y: 50, w: 50, h: 50 }]; smallArea = { x: 0, y: 0, w: 50, h: 100, cols: 2 }; }
    else { largeAreas = [{ x: 0, y: 0, w: 50, h: 50 }, { x: 50, y: 0, w: 50, h: 50 }]; smallArea = { x: 0, y: 50, w: 100, h: 50, cols: Math.min(wideCols, Math.max(1, smallIdx.length)) }; }
    rects[large[0]] = { left: largeAreas[0].x, top: largeAreas[0].y, width: largeAreas[0].w, height: largeAreas[0].h };
    if (n > 1) rects[large[1]] = { left: largeAreas[1].x, top: largeAreas[1].y, width: largeAreas[1].w, height: largeAreas[1].h };
    const cells = packCells(smallIdx.length, smallArea);
    smallIdx.forEach((idx, i) => { rects[idx] = cells[i]; });
    return rects;
  }

  const busy = () => { const a = document.activeElement; const pane = $('#pane-alayout'); return !!(a && pane && pane.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox' && !['layName', 'laySlot', 'layFly', 'layFlyFrom', 'layTarget'].includes(a.id)); };
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
  const swatch = (hue, sat, luma) => `hsl(${(Number(hue) || 0) / 10} ${(Number(sat) || 0) / 10}% ${(Number(luma) || 0) / 10}%)`;
  function meOf(i) { return (doc.mes || []).find((m) => m.me === i); }
  function keyOf(me, k) { const m = meOf(me); return m && m.keys.find((x) => x.index === k); }
  function ssOf(i) { return (doc.superSources || []).find((s) => s.ss === i); }
  function boxOf(ss, b) { const s = ssOf(ss); return s && s.boxes.find((x) => x.index === b); }
  function dskOf(i) { return (doc.dsks || []).find((d) => d.index === i); }
  function mvOf(i) { return (mvDoc || []).find((m) => m.index === i); }
  function dveFree() { let n = 0; for (const m of doc.mes || []) for (const k of m.keys) if (k.type === 'dve') n++; return Math.max(0, dveCount() - n); }
  function parseId(id) {
    const p = String(id || '').split(':');
    if (p[0] === 'key') return { kind: 'key', me: Number(p[1]), index: Number(p[2]) };
    if (p[0] === 'dsk') return { kind: 'dsk', index: Number(p[1]) };
    if (p[0] === 'box') return { kind: 'box', ss: Number(p[1]), index: Number(p[2]) };
    if (p[0] === 'art') return { kind: 'art', ss: Number(p[1]) };
    if (p[0] === 'mv') return { kind: 'mv', mv: Number(p[1]), index: Number(p[2]) };
    return null;
  }
  function boxVisual(b) {
    const u = rectOf((b.x || 0) / 100, (b.y || 0) / 100, Math.max(0.07, (b.size || 70) / 1000), Math.max(0.07, (b.size || 70) / 1000));
    if (!b.cropped) return u;
    const ft = (b.cropTop || 0) / 18000; const fb = (b.cropBottom || 0) / 18000; const fl = (b.cropLeft || 0) / 32000; const fr = (b.cropRight || 0) / 32000;
    const width = u.width * Math.max(0, 1 - fl - fr); const height = u.height * Math.max(0, 1 - ft - fb);
    return { left: u.left + u.width * fl, top: u.top + u.height * ft, width, height };
  }
  function keyVisual(k) {
    if (!positioned(k)) return { left: 0, top: 0, width: 100, height: 100 };
    const d = k.dve || {};
    return rectOf((d.positionX || 0) / 1000, (d.positionY || 0) / 1000, Math.max(0.02, (d.sizeX || 1000) / 1000), Math.max(0.02, (d.sizeY || 1000) / 1000));
  }
  function styleOf(r) { return `left:${r.left}%;top:${r.top}%;width:${Math.max(r.width, 0)}%;height:${Math.max(r.height, 0)}%`; }
  function zStyle(id, base) { return base + (zTop[id] || 0) * 30 + (sel === id ? 8 : 0); }
  function handles() { return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<i data-h="${h}" class="${h}"></i>`).join(''); }
  function gridHtml() {
    const g = grids;
    const thirds = g.thirds ? '<div class="lay-grid thirds"><i class="v" style="left:33.333%"></i><i class="v" style="left:66.666%"></i><i class="h" style="top:33.333%"></i><i class="h" style="top:66.666%"></i></div>' : '';
    const center = g.center ? '<div class="lay-grid center"><i class="v"></i><i class="h"></i></div>' : '';
    const safe = g.safe ? '<div class="lay-safe" style="left:5%;top:5%;width:90%;height:90%"><span>ACTION</span></div><div class="lay-safe title" style="left:10%;top:10%;width:80%;height:80%"><span>TITLE</span></div>' : '';
    return thirds + center + safe;
  }

  function render() {
    const pane = $('#pane-alayout'); if (!pane || tab !== 'alayout') return;
    if (busy() || holding || drag || (window.CCDRAG && window.CCDRAG.active())) return;
    document.querySelectorAll('#layTabs [data-laytab]').forEach((b) => b.classList.toggle('active', b.dataset.laytab === layTab));
    const info = $('#layInfo');
    if (!connected()) {
      info.textContent = 'M/Es, SuperSource and multiview';
      S.set($('#layBody'), 'lay', '<div class="note">Not connected · put an ATEM (or its simulator) on the desk on ⌂ SYSTEMS.</div>');
      return;
    }
    pull(false);
    if (!doc) doc = snapshot();
    if (!mvDoc) mvDoc = mvSnapshot();
    const name = V.profile ? V.profile.name : (V.product || 'ATEM');
    const nMe = (doc.mes || []).length; const nSs = (doc.superSources || []).length; const nMv = (mvDoc || []).length;
    info.textContent = `${name} · ${nMe} M/E · ${(doc.dsks || []).length} DSK · ${nSs} SuperSource · ${nMv} multiview · ${V.dves ? `${V.dves.inUse} of ${V.dves.count} DVE` : (hasDve() ? 'DVE' : 'no DVE')}`;
    $('#layApply').title = layTab === 'mv' ? 'Send this multiview to the switcher' : 'Send this layout to the switcher';
    $('#layRead').title = layTab === 'mv' ? 'Show the switcher multiview' : 'Discard unsent edits and show the switcher';
    S.set($('#layBody'), 'lay', shell());
    paintSave();
  }
  function shell() {
    const tools = `<div class="lay-tools">
      ${layTab === 'me' ? visHtml() : ''}
      ${layTab !== 'mv' ? `<button type="button" class="mode mini ${grids.thirds ? 'active' : ''}" data-laygrid="thirds">THIRDS</button>
      <button type="button" class="mode mini ${grids.center ? 'active' : ''}" data-laygrid="center">CENTER</button>
      <button type="button" class="mode mini ${grids.safe ? 'active' : ''}" data-laygrid="safe">SAFE</button>` : ''}
      ${layTab === 'me' ? `<button type="button" class="mode mini ${aspect ? 'active' : ''}" data-layaspect="${aspect ? 0 : 1}">ASPECT</button>` : ''}
      <button type="button" class="mode mini ${liveSend ? 'active' : ''}" data-laylive="${liveSend ? 0 : 1}">${liveSend ? 'LIVE' : 'HOLD'}</button>
      ${dirty ? '<span class="chip">UNSENT</span>' : ''}
    </div>`;
    return `<div class="lay"><aside class="lay-props panel"><div class="section-title">PROPERTIES</div>${propsHtml()}</aside>
      <div class="lay-stage">${tools}<div class="lay-canvases ${gridClass()}">${canvases()}</div>${noteHtml()}</div>
      <aside class="lay-res panel">${resHtml()}</aside></div>`;
  }
  function gridClass() {
    if (layTab === 'mv') { const n = (mvDoc || []).length; return `n${Math.min(4, Math.max(1, n))}`; }
    if (layTab === 'ss') { const n = (doc.superSources || []).length; return `n${Math.min(4, Math.max(1, n || 1))}`; }
    const n = (doc.mes || []).filter((m) => meShown(m.me)).length;
    return `n${Math.min(4, Math.max(1, n || 1))}`;
  }
  function visHtml() {
    return `<span class="lay-vis">${(doc.mes || []).map((m) => `<button type="button" class="mode mini ${meShown(m.me) ? 'active' : ''}" data-layvis="${m.me}" title="${meShown(m.me) ? 'Hide' : 'Show'} M/E ${m.me + 1}">M/E ${m.me + 1}</button>`).join('')}</span>`;
  }
  function noteHtml() {
    if (layTab === 'mv') return '<p class="note small">Click a window, then pick its source. Layout and program/preview swap are per multiviewer. Safe area and VU appear on windows that support them. APPLY sends this multiview. SAVE SALVO keeps it here; SAVE MACRO writes a macro.</p>';
    if (layTab === 'ss') return '<p class="note small">Drag a box onto its SuperSource. Size stays 16:9. The border is one border for every box on that SuperSource. A placed box is checked on the right; right-click it to delete.</p>';
    return `<p class="note small">Drag a key onto its own M/E, or a DSK onto M/E 1. A drop places it. It goes on air only while LIVE is on. LIVE also sends position and size. ${hasDve() ? 'DVE keys snap to the guides. ASPECT keeps the shape.' : 'This model has no DVE, so a placed key fills the frame.'} Hide an M/E with its button; the rest reflow.</p>`;
  }
  function canvases() {
    if (layTab === 'mv') return mvCanvases();
    if (layTab === 'ss') return ssCanvases();
    return meCanvases();
  }
  function meCanvases() {
    const shown = (doc.mes || []).filter((m) => meShown(m.me));
    if (!shown.length) return '<div class="note">Show an M/E to place keys.</div>';
    return shown.map((m) => {
      const keys = (m.keys || []).filter(keyPlaced).map((k) => {
        const id = `key:${m.me}:${k.index}`; const color = KEY_COLORS[k.index % KEY_COLORS.length]; const win = positioned(k); const d = k.dve || {};
        return `<div class="lay-box ${win ? 'win' : 'full'} ${k.onAir ? '' : 'off'} ${sel === id ? 'sel' : ''}" data-layer="${id}" style="${styleOf(keyVisual(k))};background:${color}55;border-color:${color};z-index:${zStyle(id, win ? 20 + k.index : 4)};${win ? `transform:rotate(${(d.rotation || 0) / 10}deg);` : ''}${d.borderEnabled ? `outline:2px solid ${swatch(d.borderHue, d.borderSaturation, d.borderLuma)};` : ''}"><b style="color:${color}">K${k.index + 1}</b><span>${esc(sname(k.fill))}</span>${sel === id && win ? handles() : ''}</div>`;
      }).join('');
      const dsks = m.me === 0 ? (doc.dsks || []).filter(dskPlaced).map((d, i) => {
        const id = `dsk:${d.index}`; const color = DSK_COLORS[d.index % DSK_COLORS.length];
        return `<div class="lay-dsk ${sel === id ? 'sel' : ''}" data-layer="${id}" style="bottom:${8 + i * 26}px;border-color:${color};color:${color}"><b>DSK ${d.index + 1}</b><span>${esc(sname(d.fill))}${d.onAir ? ' · ON AIR' : ''}</span></div>`;
      }).join('') : '';
      const empty = !keys && !dsks ? '<div class="lay-empty">Drag a key from the right onto this M/E</div>' : '';
      const used = (m.keys || []).filter(keyPlaced).length;
      return `<div class="lay-card"><div class="lay-cap"><b>M/E ${m.me + 1}</b><span>${used} of ${(m.keys || []).length} keys</span></div><div class="lay-raster" data-layraster="me:${m.me}">${gridHtml()}${keys}${dsks}${empty}</div></div>`;
    }).join('');
  }
  function ssCanvases() {
    const list = doc.superSources || [];
    if (!list.length) return '<div class="note">This model has no SuperSource.</div>';
    return list.map((s) => {
      const art = s.art;
      const artEl = `<div class="lay-art">${esc(art ? sname(art.artFillSource) : 'ART')} ART · ${art && art.artOption === 1 ? 'FOREGROUND' : 'BACKGROUND'}</div>`;
      const boxes = (s.boxes || []).filter(boxPlaced).map((b) => {
        const id = `box:${s.ss}:${b.index}`; const color = BOX_COLORS[b.index % BOX_COLORS.length];
        const border = s.border && s.border.borderEnabled;
        return `<div class="lay-box win ${sel === id ? 'sel' : ''}" data-layer="${id}" style="${styleOf(boxVisual(b))};background:${color}55;border-color:${color};z-index:${zStyle(id, 12 - b.index)};${border ? `outline:2px solid ${swatch(s.border.borderHue, s.border.borderSaturation, s.border.borderLuma)};` : ''}"><b style="color:${color}">${b.index + 1}</b><span>${esc(sname(b.source))}</span>${sel === id ? handles() : ''}</div>`;
      }).join('');
      const empty = !boxes ? '<div class="lay-empty">Drag a box from the right onto this SuperSource</div>' : '';
      const used = (s.boxes || []).filter(boxPlaced).length;
      return `<div class="lay-card"><div class="lay-cap"><b>SUPERSOURCE ${s.ss + 1}</b><span>${used} of ${(s.boxes || []).length} boxes</span></div><div class="lay-raster ${art && art.artOption === 1 ? 'art-fg' : ''}" data-layraster="ss:${s.ss}">${gridHtml()}${artEl}${boxes}${empty}</div></div>`;
    }).join('');
  }
  function mvCanvases() {
    const list = mvDoc || [];
    if (!list.length) return '<div class="note">This model has no multiview.</div>';
    return list.map((mv) => {
      const rects = mvRects((mv.windows || []).length, mv.layout, mv.swapped);
      const wins = (mv.windows || []).map((w) => {
        const r = rects[w.index]; if (!r) return '';
        const id = `mv:${mv.index}:${w.index}`;
        const badges = `${w.vu ? '<i>VU</i>' : ''}${w.safeArea ? '<i>SAFE</i>' : ''}`;
        return `<div class="mv-win ${w.routable ? '' : 'fixed'} ${sel === id ? 'sel' : ''}" data-layer="${id}" style="${styleOf(r)}"><span class="badges">${badges}</span><b>${w.index + 1}${w.index < 2 ? (mv.swapped ? (w.index === 0 ? ' PGM' : ' PVW') : (w.index === 0 ? ' PVW' : ' PGM')) : ''}</b><span>${esc(sname(w.source))}</span>${w.safeArea ? '<i class="mv-safe"></i>' : ''}</div>`;
      }).join('');
      const layName = MV_NAMES[mv.layout] || `Layout ${mv.layout}`;
      return `<div class="lay-card"><div class="lay-cap"><b>MULTIVIEW ${mv.index + 1}</b><span>${esc(layName)}${mv.swapped ? ' · swapped' : ''}</span></div><div class="lay-raster" data-layraster="mv:${mv.index}">${wins}</div></div>`;
    }).join('');
  }

  function resHtml() {
    if (layTab === 'mv') return '<div class="section-title">WINDOWS <small>click one on the multiview</small></div><p class="note small">Sources are chosen on the window. This column lists each multiviewer.</p>' + (mvDoc || []).map((mv) => `<div class="lay-res-h">MULTIVIEW ${mv.index + 1}</div>` + (mv.windows || []).map((w) => {
      const id = `mv:${mv.index}:${w.index}`;
      return `<button type="button" class="lay-res-item ${sel === id ? 'on' : ''}" data-laysel="${id}"><span><b>Window ${w.index + 1}</b><small>${esc(sname(w.source))}${w.routable ? '' : ' · fixed'}</small></span></button>`;
    }).join('')).join('');
    if (layTab === 'ss') {
      const list = doc.superSources || [];
      if (!list.length) return '<div class="section-title">BOXES</div><p class="note small">This model has no SuperSource.</p>';
      return `<div class="section-title">BOXES <small>drag onto that SuperSource</small></div>` + list.map((s) => `<div class="lay-res-h">SUPERSOURCE ${s.ss + 1}</div>` + (s.boxes || []).map((b) => resItem({
        id: `box:${s.ss}:${b.index}`, kind: 'box', ss: s.ss, index: b.index, title: `BOX ${b.index + 1}`,
        sub: boxPlaced(b) ? sname(b.source) : 'available', used: boxPlaced(b), color: BOX_COLORS[b.index % BOX_COLORS.length], label: `SS ${s.ss + 1} box ${b.index + 1}`,
      })).join('')).join('');
    }
    const mes = doc.mes || [];
    const dsks = doc.dsks || [];
    return `<div class="section-title">KEYS <small>drag onto that M/E</small></div>` + mes.map((m) => `<div class="lay-res-h">M/E ${m.me + 1}</div>` + (m.keys || []).map((k) => resItem({
      id: `key:${m.me}:${k.index}`, kind: 'key', me: m.me, index: k.index, title: `KEY ${k.index + 1}`,
      sub: keyPlaced(k) ? `${k.type.toUpperCase()}${k.onAir ? ' · ON AIR' : ''} · ${sname(k.fill)}` : 'available',
      used: keyPlaced(k), color: KEY_COLORS[k.index % KEY_COLORS.length], label: `M/E ${m.me + 1} key ${k.index + 1}`,
    })).join('')).join('') + (dsks.length ? `<div class="lay-res-h">DOWNSTREAM</div>` + dsks.map((d) => resItem({
      id: `dsk:${d.index}`, kind: 'dsk', index: d.index, title: `DSK ${d.index + 1}`,
      sub: dskPlaced(d) ? `${sname(d.fill)}${d.onAir ? ' · ON AIR' : ''}${d.tie ? ' · TIE' : ''}` : 'available',
      used: dskPlaced(d), color: DSK_COLORS[d.index % DSK_COLORS.length], label: `DSK ${d.index + 1}`,
    })).join('') : '');
  }
  function resItem(o) {
    const attrs = `data-laysel="${o.id}" data-kind="${o.kind}" data-index="${o.index}" ${o.me !== undefined ? `data-me="${o.me}"` : ''} ${o.ss !== undefined ? `data-ss="${o.ss}"` : ''} data-label="${esc(o.label)}"`;
    return `<button type="button" class="lay-res-item ${o.used ? 'used' : ''} ${sel === o.id ? 'on' : ''}" ${attrs} title="${o.used ? 'In use — right-click to delete' : `Drag ${esc(o.label)}`}"><i class="sw" style="background:${o.color}"></i><span><b>${o.title}</b><small>${esc(o.sub)}</small></span><i class="chk">${o.used ? '✓' : ''}</i></button>`;
  }

  function propsHtml() {
    if (!doc) return '';
    if (layTab === 'mv') return mvProps();
    if (layTab === 'ss') return ssProps();
    const p = parseId(sel);
    if (p && p.kind === 'dsk') { const d = dskOf(p.index); if (d) return dskHtml(d); }
    if (p && p.kind === 'key') { const k = keyOf(p.me, p.index); if (k) return keyHtml(p.me, k); }
    return '<div class="note small">Select a key, or drag one onto its M/E. Downstream keys drop on M/E 1.</div>';
  }
  function ssProps() {
    const list = doc.superSources || [];
    if (!list.length) return '<div class="note small">This model has no SuperSource.</div>';
    const p = parseId(sel);
    const ss = p && (p.kind === 'box' || p.kind === 'art') ? p.ss : list[0].ss;
    const s = ssOf(ss) || list[0];
    let html = '';
    if (p && p.kind === 'box') { const b = boxOf(p.ss, p.index); if (b) html += boxHtml(p.ss, b); }
    html += artHtml(s);
    return html;
  }
  function artHtml(s) {
    const a = s.art || {}; const ids = `data-ss="${s.ss}"`;
    const artSrc = (V.sources || []).filter((x) => x.sa & 4);
    return `<div class="ak-head"><b>${(doc.superSources || []).length > 1 ? `SS ${s.ss + 1} ` : ''}ART</b>${tog(a.artOption === 1 ? 'FOREGROUND' : 'BACKGROUND', a.artOption === 1, 'artOption', 'art', ids)}</div>
      <div class="ak-row"><label class="ak-sel">FILL<select data-k="artFillSource" data-part="art" ${ids}>${selOpts(artSrc, a.artFillSource)}</select></label>
        <label class="ak-sel">KEY<select data-k="artCutSource" data-part="art" ${ids}>${selOpts(V.sources || [], a.artCutSource)}</select></label></div>
      <div class="ak-row">${tog(a.artPreMultiplied ? 'PRE-MULT' : 'CLIP / GAIN', a.artPreMultiplied, 'artPreMultiplied', 'art', ids)}${num('CLIP %', a.artClip, 10, 1, 0, 100, 'artClip', 'art', ids)}${num('GAIN %', a.artGain, 10, 1, 0, 100, 'artGain', 'art', ids)}${tog('INVERT', a.artInvertKey, 'artInvertKey', 'art', ids)}</div>
      ${borderHtml('border', s.border || {}, 'One border for every box on this SuperSource', ids)}`;
  }
  function borderHtml(part, bd, note, extra) {
    return `<div class="ak-head"><b>BORDER</b>${tog(bd.borderEnabled ? 'ON' : 'OFF', bd.borderEnabled, 'borderEnabled', part, extra)}<i class="lay-swatch" style="background:${swatch(bd.borderHue, bd.borderSaturation, bd.borderLuma)}"></i></div>
      <p class="note small">${esc(note)}</p>
      <div class="ak-row">${num('OUT', bd.borderOuterWidth, 100, 0.01, 0, 16, 'borderOuterWidth', part, extra)}${num('IN', bd.borderInnerWidth, 100, 0.01, 0, 16, 'borderInnerWidth', part, extra)}${num('SOFT', bd.borderOuterSoftness, 1, 1, 0, 100, 'borderOuterSoftness', part, extra)}${num('IN SOFT', bd.borderInnerSoftness, 1, 1, 0, 100, 'borderInnerSoftness', part, extra)}</div>
      <div class="ak-row">${num('HUE', bd.borderHue, 10, 1, 0, 359.9, 'borderHue', part, extra)}${num('SAT %', bd.borderSaturation, 10, 1, 0, 100, 'borderSaturation', part, extra)}${num('LUMA %', bd.borderLuma, 10, 1, 0, 100, 'borderLuma', part, extra)}
        <label class="ak-sel">BEVEL<select data-k="borderBevel" data-part="${part}" ${extra || ''}>${BEVELS.map((n, i) => `<option value="${i}" ${i === bd.borderBevel ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
      <div class="ak-row">${num('LIGHT °', part === 'border' ? bd.borderLightSourceDirection : bd.lightSourceDirection, 10, 1, 0, 359.9, part === 'border' ? 'borderLightSourceDirection' : 'lightSourceDirection', part, extra)}${num('ALT', part === 'border' ? bd.borderLightSourceAltitude : bd.lightSourceAltitude, 1, 1, 0, 100, part === 'border' ? 'borderLightSourceAltitude' : 'lightSourceAltitude', part, extra)}${part === 'dve' ? tog(bd.shadowEnabled ? 'SHADOW' : 'NO SHADOW', bd.shadowEnabled, 'shadowEnabled', part, extra) : ''}</div>`;
  }
  function boxHtml(ss, b) {
    const ids = `data-ss="${ss}" data-box="${b.index}"`;
    const boxSrc = (V.sources || []).filter((x) => x.sa & 8);
    return `<div class="ak-head"><b>BOX ${b.index + 1}</b>${tog(b.enabled ? 'ENABLED' : 'DISABLED', b.enabled, 'enabled', 'box', ids)}</div>
      <div class="ak-row"><label class="ak-sel">SOURCE<select data-k="source" data-part="box" ${ids}>${selOpts(boxSrc, b.source)}</select></label></div>
      <div class="ak-row">${num('X', b.x, 100, 0.1, -48, 48, 'x', 'box', ids)}${num('Y', b.y, 100, 0.1, -27, 27, 'y', 'box', ids)}${num('SIZE', b.size, 1000, 0.01, 0.07, 1, 'size', 'box', ids)}</div>
      <div class="ak-row">${tog(b.cropped ? 'CROP ON' : 'CROP', b.cropped, 'cropped', 'box', ids)}${num('T', b.cropTop, 1000, 0.1, 0, 18, 'cropTop', 'box', ids)}${num('B', b.cropBottom, 1000, 0.1, 0, 18, 'cropBottom', 'box', ids)}${num('L', b.cropLeft, 1000, 0.1, 0, 32, 'cropLeft', 'box', ids)}${num('R', b.cropRight, 1000, 0.1, 0, 32, 'cropRight', 'box', ids)}</div>`;
  }
  function keyHtml(me, k) {
    const ids = `data-me="${me}" data-key="${k.index}"`;
    const keySrc = (V.sources || []).filter((x) => x.sa & 16);
    const d = k.dve || {}; const mk = k.mask || {};
    const types = ['luma', 'chroma', 'pattern', 'dve'].map((t) => `<button type="button" class="mode mini ${k.type === t ? 'active' : ''}" data-laytype="${t}" data-me="${me}" data-key="${k.index}" ${t === 'dve' && !hasDve() ? 'disabled title="No DVE on this model"' : ''}>${t.toUpperCase()}</button>`).join('');
    let body = '';
    if (k.type === 'luma' && k.luma) body = `${tog('PRE-MULT', k.luma.preMultiplied, 'preMultiplied', 'luma', ids)}${num('CLIP %', k.luma.clip, 10, 1, 0, 100, 'clip', 'luma', ids)}${num('GAIN %', k.luma.gain, 10, 1, 0, 100, 'gain', 'luma', ids)}${tog('INVERT', k.luma.invert, 'invert', 'luma', ids)}`;
    if (k.type === 'chroma' && k.chroma) body = `${num('HUE °', k.chroma.hue, 10, 1, 0, 359.9, 'hue', 'chroma', ids)}${num('GAIN %', k.chroma.gain, 10, 1, 0, 100, 'gain', 'chroma', ids)}${num('Y SUPP %', k.chroma.ySuppress, 10, 1, 0, 100, 'ySuppress', 'chroma', ids)}${num('LIFT %', k.chroma.lift, 10, 1, 0, 100, 'lift', 'chroma', ids)}${tog('NARROW', k.chroma.narrow, 'narrow', 'chroma', ids)}`;
    if (k.type === 'pattern' && k.pattern) body = `<label class="ak-sel">PATTERN<select data-k="style" data-part="pattern" ${ids}>${PATTERNS.map((n, i) => `<option value="${i}" ${i === k.pattern.style ? 'selected' : ''}>${n}</option>`).join('')}</select></label>${num('SIZE %', k.pattern.size, 100, 1, 0, 100, 'size', 'pattern', ids)}${num('SYMM %', k.pattern.symmetry, 100, 1, 0, 100, 'symmetry', 'pattern', ids)}${num('SOFT %', k.pattern.softness, 100, 1, 0, 100, 'softness', 'pattern', ids)}${num('X', k.pattern.positionX, 10000, 0.01, 0, 1, 'positionX', 'pattern', ids)}${num('Y', k.pattern.positionY, 10000, 0.01, 0, 1, 'positionY', 'pattern', ids)}${tog('INVERT', k.pattern.invert, 'invert', 'pattern', ids)}`;
    const dve = (k.type === 'dve' || k.flyEnabled) && k.dve ? `<div class="ak-row">${num('X', d.positionX, 1000, 0.1, -32, 32, 'positionX', 'dve', ids)}${num('Y', d.positionY, 1000, 0.1, -18, 18, 'positionY', 'dve', ids)}${num('SIZE X', d.sizeX, 1000, 0.01, 0, 99, 'sizeX', 'dve', ids)}${num('SIZE Y', d.sizeY, 1000, 0.01, 0, 99, 'sizeY', 'dve', ids)}${num('ROT °', d.rotation, 10, 1, -360, 360, 'rotation', 'dve', ids)}</div>
      ${borderHtml('dve', d, 'Border and light on this DVE key', ids)}
      <div class="ak-row"><span class="modes-lbl">DVE MASK</span>${tog(d.maskEnabled ? 'ON' : 'OFF', d.maskEnabled, 'maskEnabled', 'dve', ids)}${num('T', d.maskTop, 1000, 0.1, 0, 18, 'maskTop', 'dve', ids)}${num('B', d.maskBottom, 1000, 0.1, 0, 18, 'maskBottom', 'dve', ids)}${num('L', d.maskLeft, 1000, 0.1, 0, 32, 'maskLeft', 'dve', ids)}${num('R', d.maskRight, 1000, 0.1, 0, 32, 'maskRight', 'dve', ids)}</div>
      <div class="ak-fly"><span class="modes-lbl">FLY</span><button type="button" class="mode mini" data-layfly="store" data-frame="a" data-me="${me}" data-key="${k.index}">STORE A</button><button type="button" class="mode mini" data-layfly="store" data-frame="b" data-me="${me}" data-key="${k.index}">STORE B</button><button type="button" class="mode mini" data-layfly="run" data-frame="a" data-me="${me}" data-key="${k.index}">RUN A</button><button type="button" class="mode mini" data-layfly="run" data-frame="b" data-me="${me}" data-key="${k.index}">RUN B</button></div>` : '';
    return `<div class="ak-head"><b>M/E ${me + 1} KEY ${k.index + 1}</b><button type="button" class="mode ${k.onAir ? 'onair' : ''}" data-layair="${k.index}" data-me="${me}" data-on="${k.onAir ? 0 : 1}">${k.onAir ? 'ON AIR' : 'OFF'}</button><span class="seg-row">${types}</span>${k.type !== 'dve' ? tog(k.flyEnabled ? 'FLY ON' : 'FLY', k.flyEnabled, 'flyEnabled', 'type', ids) : ''}</div>
      <div class="ak-row"><label class="ak-sel">FILL<select data-k="fill" data-part="sources" ${ids}>${selOpts(keySrc, k.fill)}</select></label>${k.type === 'luma' ? `<label class="ak-sel">KEY<select data-k="cut" data-part="sources" ${ids}>${selOpts(V.sources || [], k.cut)}</select></label>` : ''}</div>
      <div class="ak-row">${body}</div>${dve}
      <div class="ak-row"><span class="modes-lbl">MASK</span>${tog(mk.enabled ? 'ON' : 'OFF', mk.enabled, 'enabled', 'mask', ids)}${num('T', mk.top, 1000, 0.1, -9, 9, 'top', 'mask', ids)}${num('B', mk.bottom, 1000, 0.1, -9, 9, 'bottom', 'mask', ids)}${num('L', mk.left, 1000, 0.1, -16, 16, 'left', 'mask', ids)}${num('R', mk.right, 1000, 0.1, -16, 16, 'right', 'mask', ids)}</div>`;
  }
  function dskHtml(d) {
    const ids = `data-dsk="${d.index}"`; const mk = d.mask || {};
    return `<div class="ak-head"><b>DSK ${d.index + 1}</b><button type="button" class="mode ${d.onAir ? 'onair' : ''}" data-dskair="${d.index}" data-on="${d.onAir ? 0 : 1}">${d.onAir ? 'ON AIR' : 'OFF'}</button>${tog(d.tie ? 'TIE' : 'TIE OFF', d.tie, 'tie', 'dskTie', ids)}</div>
      <p class="note small">Downstream of M/E 1. Tie arms it for the next transition. On air is the program state.</p>
      <div class="ak-row"><label class="ak-sel">FILL<select data-k="fill" data-part="dskSrc" ${ids}>${selOpts(V.sources || [], d.fill)}</select></label><label class="ak-sel">KEY<select data-k="cut" data-part="dskSrc" ${ids}>${selOpts(V.sources || [], d.cut)}</select></label></div>
      <div class="ak-row">${tog(d.preMultiply ? 'PRE-MULT' : 'CLIP / GAIN', d.preMultiply, 'preMultiply', 'dskGen', ids)}${num('CLIP %', d.clip, 10, 1, 0, 100, 'clip', 'dskGen', ids)}${num('GAIN %', d.gain, 10, 1, 0, 100, 'gain', 'dskGen', ids)}${tog('INVERT', d.invert, 'invert', 'dskGen', ids)}${num('RATE', d.rate, 1, 1, 1, 250, 'rate', 'dskRate', ids)}</div>
      <div class="ak-row"><span class="modes-lbl">MASK</span>${tog(mk.enabled ? 'ON' : 'OFF', mk.enabled, 'enabled', 'dskMask', ids)}${num('T', mk.top, 1000, 0.1, -9, 9, 'top', 'dskMask', ids)}${num('B', mk.bottom, 1000, 0.1, -9, 9, 'bottom', 'dskMask', ids)}${num('L', mk.left, 1000, 0.1, -16, 16, 'left', 'dskMask', ids)}${num('R', mk.right, 1000, 0.1, -16, 16, 'right', 'dskMask', ids)}</div>`;
  }
  function mvProps() {
    const p = parseId(sel);
    const mv = (p && p.kind === 'mv' ? mvOf(p.mv) : (mvDoc || [])[0]);
    if (!mv) return '<div class="note small">This model has no multiview.</div>';
    const w = p && p.kind === 'mv' ? (mv.windows || []).find((x) => x.index === p.index) : null;
    const layouts = MV_NAMES.map((n, i) => `<button type="button" class="mode mini ${mv.layout === i ? 'active' : ''}" data-mvlay="${i}" data-mv="${mv.index}">${n.toUpperCase()}</button>`).join('');
    const win = w ? `<div class="ak-head"><b>WINDOW ${w.index + 1}</b>${w.routable ? '' : '<span class="chip">FIXED</span>'}</div>
      ${w.routable ? `<div class="ak-row"><label class="ak-sel">SOURCE<select data-k="source" data-part="mvSrc" data-mv="${mv.index}" data-win="${w.index}">${selOpts((V.sources || []).filter((x) => x.sa & 2), w.source)}</select></label></div>` : `<p class="note small">${esc(sname(w.source))} is fixed on this model.</p>`}
      <div class="ak-row">${w.supportsVu ? tog(w.vu ? 'VU ON' : 'VU', w.vu, 'vu', 'mvVu', `data-mv="${mv.index}" data-win="${w.index}"`) : ''}${w.supportsSafe ? tog(w.safeArea ? 'SAFE ON' : 'SAFE', w.safeArea, 'safeArea', 'mvSafe', `data-mv="${mv.index}" data-win="${w.index}"`) : ''}${!w.supportsVu && !w.supportsSafe ? '<span class="note small">This window has no safe area or VU meter.</span>' : ''}</div>` : '<p class="note small">Click a window to route it.</p>';
    return `<div class="ak-head"><b>MULTIVIEW ${mv.index + 1}</b></div><div class="ak-row seg-row">${layouts}</div><div class="ak-row">${tog(mv.swapped ? 'SWAP ON' : 'SWAP PGM/PVW', mv.swapped, 'swapped', 'mvSwap', `data-mv="${mv.index}"`)}</div>${win}`;
  }

  function patch(part, loc, k, value) {
    if (part === 'box') { const b = boxOf(loc.ss, loc.index); if (b) b[k] = value; }
    else if (part === 'art') { const s = ssOf(loc.ss); if (s) { s.art = s.art || {}; s.art[k] = k === 'artOption' ? (value ? 1 : 0) : value; } }
    else if (part === 'border') { const s = ssOf(loc.ss); if (s) { s.border = s.border || {}; s.border[k] = value; } }
    else if (part === 'dve') { const key = keyOf(loc.me, loc.index); if (key) { key.dve = key.dve || {}; key.dve[k] = value; } }
    else if (part === 'mask') { const key = keyOf(loc.me, loc.index); if (key) { key.mask = key.mask || {}; key.mask[k] = value; } }
    else if (part === 'luma' || part === 'chroma' || part === 'pattern') { const key = keyOf(loc.me, loc.index); if (key && key[part]) key[part][k] = value; }
    else if (part === 'sources') { const key = keyOf(loc.me, loc.index); if (key) key[k] = value; }
    else if (part === 'type') { const key = keyOf(loc.me, loc.index); if (key) key.flyEnabled = !!value; }
    else if (part === 'dskSrc') { const d = dskOf(loc.dsk); if (d) d[k] = value; }
    else if (part === 'dskGen') { const d = dskOf(loc.dsk); if (d) d[k] = value; }
    else if (part === 'dskMask') { const d = dskOf(loc.dsk); if (d) { d.mask = d.mask || {}; d.mask[k] = value; } }
    else if (part === 'dskRate') { const d = dskOf(loc.dsk); if (d) d.rate = value; }
    else if (part === 'dskTie') { const d = dskOf(loc.dsk); if (d) d.tie = !!value; }
    else if (part === 'mvSrc') { const mv = mvOf(loc.mv); const w = mv && (mv.windows || []).find((x) => x.index === loc.win); if (w) w.source = value; }
    else if (part === 'mvVu') { const mv = mvOf(loc.mv); const w = mv && (mv.windows || []).find((x) => x.index === loc.win); if (w) w.vu = !!value; }
    else if (part === 'mvSafe') { const mv = mvOf(loc.mv); const w = mv && (mv.windows || []).find((x) => x.index === loc.win); if (w) w.safeArea = !!value; }
    else if (part === 'mvSwap') { const mv = mvOf(loc.mv); if (mv) mv.swapped = !!value; }
    if (!liveSend) dirty = true;
  }
  function locOf(el) {
    return {
      me: el.dataset.me !== undefined && el.dataset.me !== '' ? Number(el.dataset.me) : undefined,
      ss: el.dataset.ss !== undefined && el.dataset.ss !== '' ? Number(el.dataset.ss) : undefined,
      index: el.dataset.key !== undefined && el.dataset.key !== '' ? Number(el.dataset.key) : el.dataset.box !== undefined && el.dataset.box !== '' ? Number(el.dataset.box) : undefined,
      dsk: el.dataset.dsk !== undefined && el.dataset.dsk !== '' ? Number(el.dataset.dsk) : undefined,
      mv: el.dataset.mv !== undefined && el.dataset.mv !== '' ? Number(el.dataset.mv) : undefined,
      win: el.dataset.win !== undefined && el.dataset.win !== '' ? Number(el.dataset.win) : undefined,
    };
  }
  function sendPart(part, loc, k, value) {
    if (!liveSend) { render(); return undefined; }
    const me = loc.me + 1;
    if (part === 'box') return commit(cmd('ssBox', { ss: loc.ss, box: loc.index, [k]: value }));
    if (part === 'art') return commit(cmd('ssProps', { ss: loc.ss, [k]: k === 'artOption' ? (value ? 1 : 0) : value }));
    if (part === 'border') return commit(cmd('ssBorder', { ss: loc.ss, [k]: value }));
    if (part === 'dve') return commit(cmd('uskDve', { me, key: loc.index, [k]: value }));
    if (part === 'mask') return commit(cmd('uskMask', { me, key: loc.index, [k]: value }));
    if (part === 'luma') return commit(cmd('uskLuma', { me, key: loc.index, [k]: value }));
    if (part === 'chroma') return commit(cmd('uskChroma', { me, key: loc.index, [k]: value }));
    if (part === 'pattern') return commit(cmd('uskPattern', { me, key: loc.index, [k]: value }));
    if (part === 'sources') return commit(cmd('uskSources', { me, key: loc.index, [k]: value }));
    if (part === 'type') return commit(cmd('uskType', { me, key: loc.index, flyEnabled: !!value }));
    if (part === 'dskSrc') return commit(cmd('dskSources', { key: loc.dsk, [k]: value }));
    if (part === 'dskGen') return commit(cmd('dskGeneral', { key: loc.dsk, [k]: value }));
    if (part === 'dskMask') return commit(cmd('dskMask', { key: loc.dsk, [k]: value }));
    if (part === 'dskRate') return commit(cmd('dskRate', { key: loc.dsk, rate: value }));
    if (part === 'dskTie') return commit(cmd('dskTie', { key: loc.dsk, on: !!value }));
    if (part === 'mvSrc') return commit(cmd('mvSource', { mv: loc.mv, window: loc.win, source: value }));
    if (part === 'mvVu') return commit(cmd('mvVu', { mv: loc.mv, window: loc.win, vu: !!value }));
    if (part === 'mvSafe') return commit(cmd('mvSafe', { mv: loc.mv, window: loc.win, safeArea: !!value }));
    if (part === 'mvSwap') return commit(cmd('mvProps', { mv: loc.mv, swapped: !!value }));
    return undefined;
  }

  function select(id) { sel = id; saveLs('cc.laySel', sel); render(); }
  function placeKeyAt(me, index, xUnit, yUnit) {
    const k = keyOf(me, index); if (!k || keyPlaced(k)) return;
    const makeDve = dveCount() > 0 && dveFree() > 0;
    const posX = Math.round(Math.max(-32, Math.min(32, xUnit)) * 1000);
    const posY = Math.round(Math.max(-18, Math.min(18, yUnit)) * 1000);
    k.placed = true;
    if (liveSend) k.onAir = true;
    if (makeDve) { k.type = 'dve'; k.flyEnabled = false; k.dve = { ...(k.dve || {}), positionX: posX, positionY: posY, sizeX: 500, sizeY: 500 }; }
    sel = `key:${me}:${index}`; saveLs('cc.laySel', sel);
    if (!liveSend) { dirty = true; render(); if (!makeDve && dveCount() > 0) toast('No DVE left, so this key fills the frame'); return; }
    let p = Promise.resolve();
    if (makeDve) p = cmd('uskType', { me: me + 1, key: index, type: 'dve', flyEnabled: false }).then(() => cmd('uskDve', { me: me + 1, key: index, positionX: posX, positionY: posY, sizeX: 500, sizeY: 500 }));
    p = p.then(() => cmd('uskOnAir', { me: me + 1, key: index, on: true }));
    if (!makeDve && dveCount() > 0) p = p.then(() => { toast('No DVE left, so this key fills the frame'); });
    commit(p);
  }
  function placeBoxAt(ss, index, xUnit, yUnit) {
    const b = boxOf(ss, index); if (!b || b.enabled) return;
    b.enabled = true;
    b.x = Math.round(Math.max(-48, Math.min(48, xUnit)) * 100);
    b.y = Math.round(Math.max(-27, Math.min(27, yUnit)) * 100);
    if (!(b.size >= 70)) b.size = 500;
    sel = `box:${ss}:${index}`; saveLs('cc.laySel', sel);
    if (!liveSend) { dirty = true; render(); return; }
    commit(cmd('ssBox', { ss, box: index, enabled: true, x: b.x, y: b.y, size: b.size }));
  }
  function placeDskAt(index) {
    const d = dskOf(index); if (!d || dskPlaced(d)) return;
    d.placed = true; d.tie = true;
    if (liveSend) d.onAir = true;
    sel = `dsk:${index}`; saveLs('cc.laySel', sel);
    if (!liveSend) { dirty = true; render(); return; }
    commit(cmd('dskTie', { key: index, on: true }).then(() => cmd('dskOnAir', { key: index, on: true })));
  }
  function release(p) {
    if (!p || !doc) return;
    if (p.kind === 'box') {
      const b = boxOf(p.ss, p.index); if (!b || !b.enabled) return;
      b.enabled = false;
      if (!liveSend) { dirty = true; render(); return; }
      commit(cmd('ssBox', { ss: p.ss, box: p.index, enabled: false }));
      return;
    }
    if (p.kind === 'dsk') {
      const d = dskOf(p.index); if (!d || !dskPlaced(d)) return;
      d.placed = false; d.onAir = false; d.tie = false;
      if (!liveSend) { dirty = true; render(); return; }
      commit(cmd('dskOnAir', { key: p.index, on: false }).then(() => cmd('dskTie', { key: p.index, on: false })));
      return;
    }
    if (p.kind === 'key') {
      const k = keyOf(p.me, p.index); if (!k || !keyPlaced(k)) return;
      const wasDve = k.type === 'dve'; const wasFly = !!k.flyEnabled; const prev = k.type;
      k.placed = false; k.onAir = false; k.flyEnabled = false;
      if (wasDve) k.type = 'luma';
      if (!liveSend) { dirty = true; render(); return; }
      let chain = cmd('uskOnAir', { me: p.me + 1, key: p.index, on: false });
      if (wasDve || wasFly) chain = chain.then(() => cmd('uskType', { me: p.me + 1, key: p.index, type: wasDve ? 'luma' : prev, flyEnabled: false }));
      commit(chain);
    }
  }

  function paintSave() {
    const mv = layTab === 'mv';
    $('#layTargetWrap').hidden = mv; $('#layFlyWrap').hidden = mv;
    const from = $('#layFlyFrom'); if (from && from.parentElement) from.parentElement.hidden = mv;
    $('#laySavePreset').hidden = mv; $('#laySaveSalvo').hidden = !mv;
    $('#layMacroNote').textContent = mv
      ? 'SAVE SALVO keeps this multiview in Control Center. SAVE MACRO writes the same routing as a Macro Desk macro and as Software Control XML. Recall loads a salvo onto the switcher.'
      : 'SAVE PRESET keeps this M/E, DSK and SuperSource look. Recall to Preview puts the background on preview and ties the placed keys so you can take it. Recall to Program cuts it on air. A macro cuts to the layout. It does not fly.';
    const box = $('#layRecall');
    if (mv) {
      const list = V.mvSalvos || [];
      box.innerHTML = list.map((p) => `<button type="button" class="btn mini" data-mvrecall="${esc(p.id)}">${esc(p.name)}</button>`).join('') || '<span class="note small">No salvos yet.</span>';
    } else {
      const list = V.layoutPresets || [];
      box.innerHTML = list.map((p) => `<span class="lay-presets"><b style="font-size:12px">${esc(p.name)}</b> <button type="button" class="btn mini" data-recall="${esc(p.id)}" data-target="preview">PREVIEW</button><button type="button" class="btn mini" data-recall="${esc(p.id)}" data-target="program">PROGRAM</button></span>`).join('') || '<span class="note small">No looks yet.</span>';
    }
    const fly = $('#layFlyFrom');
    if (fly && document.activeElement !== fly) {
      const cur = fly.value; const list = V.layoutPresets || [];
      fly.innerHTML = `<option value="">—</option>${list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}`;
      if ([...fly.options].some((o) => o.value === cur)) fly.value = cur;
    }
  }

  const menu = document.createElement('div');
  menu.id = 'layMenu'; menu.className = 'lay-menu'; menu.hidden = true;
  menu.innerHTML = '<button type="button" data-act="props">Properties</button><button type="button" data-act="front">Bring to front</button><button type="button" data-act="delete" class="danger">Delete</button>';
  document.body.appendChild(menu);
  function closeMenu() { menu.hidden = true; }
  function openMenu(x, y, id, placed, front) {
    menu.hidden = false; menu.dataset.id = id;
    menu.querySelector('[data-act=delete]').hidden = !placed;
    menu.querySelector('[data-act=front]').hidden = !front;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 180))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 130))}px`;
  }

  $('#pane-alayout').addEventListener('pointerdown', (e) => { if (e.target.closest('input, select, textarea')) holding = true; }, true);
  document.addEventListener('pointerup', () => { if (drag) return; if (!holding) return; holding = false; setTimeout(render, 40); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#layMenu')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  $('#layTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-laytab]'); if (!b) return;
    layTab = b.dataset.laytab; saveLs('cc.layTab', layTab); render();
  });
  $('#layBody').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !connected()) return;
    if (b.dataset.layvis !== undefined) {
      const i = Number(b.dataset.layvis);
      const shown = (doc.mes || []).filter((m) => meShown(m.me));
      if (meShown(i) && shown.length <= 1) { toast('Keep at least one M/E on the page'); return; }
      meVis[String(i)] = meShown(i) ? false : true; saveLs('cc.layMeVis', meVis); render(); return;
    }
    if (b.dataset.laysel) { select(b.dataset.laysel); return; }
    if (b.dataset.laygrid) { grids[b.dataset.laygrid] = !grids[b.dataset.laygrid]; saveLs('cc.layGrid', grids); render(); return; }
    if (b.dataset.layaspect !== undefined) { aspect = b.dataset.layaspect === '1'; saveLs('cc.layAspect', aspect); render(); return; }
    if (b.dataset.laylive !== undefined) { liveSend = b.dataset.laylive === '1'; saveLs('cc.layLive', liveSend); render(); return; }
    if (b.dataset.mvlay !== undefined) {
      const mv = mvOf(Number(b.dataset.mv)); if (!mv) return;
      mv.layout = Number(b.dataset.mvlay); if (!liveSend) dirty = true;
      if (!liveSend) { render(); return; }
      commit(cmd('mvProps', { mv: mv.index, layout: mv.layout })); return;
    }
    if (b.dataset.bool !== undefined) {
      const loc = locOf(b); const part = b.dataset.part; const k = b.dataset.k;
      let value = b.dataset.bool === '1';
      if (k === 'artOption') { const s = ssOf(loc.ss); value = !(s && s.art && s.art.artOption === 1); }
      patch(part, loc, k, value); sendPart(part, loc, k, value); return;
    }
    if (b.dataset.laytype) {
      const key = keyOf(Number(b.dataset.me), Number(b.dataset.key)); if (!key) return;
      key.type = b.dataset.laytype; key.placed = true; if (!liveSend) dirty = true;
      const p = cmd('uskType', { me: Number(b.dataset.me) + 1, key: key.index, type: key.type });
      if (!liveSend) { render(); return; }
      commit(p); return;
    }
    if (b.dataset.layair !== undefined) {
      const key = keyOf(Number(b.dataset.me), Number(b.dataset.layair)); if (!key) return;
      key.onAir = b.dataset.on === '1'; if (key.onAir) key.placed = true; if (!liveSend) dirty = true;
      const p = cmd('uskOnAir', { me: Number(b.dataset.me) + 1, key: key.index, on: key.onAir });
      if (!liveSend) { render(); return; }
      commit(p); return;
    }
    if (b.dataset.dskair !== undefined) {
      const d = dskOf(Number(b.dataset.dskair)); if (!d) return;
      d.onAir = b.dataset.on === '1'; if (d.onAir) d.placed = true; if (!liveSend) dirty = true;
      const p = cmd('dskOnAir', { key: d.index, on: d.onAir });
      if (!liveSend) { render(); return; }
      commit(p); return;
    }
    if (b.dataset.layfly) {
      const me = Number(b.dataset.me); const key = Number(b.dataset.key); const frame = b.dataset.frame;
      if (b.dataset.layfly === 'store') return run(api('POST', '/api/sys/atem/cmd/layoutApply', { layout: doc, store: frame })).then((r) => toast(`Key frame ${frame.toUpperCase()} stored${r && r.skipped && r.skipped.length ? ` · ${r.skipped[0].reason}` : ''}`));
      return cmd('uskFlyRun', { me: me + 1, key, frame }).then(() => toast(`Run to ${frame.toUpperCase()}`));
    }
  });
  $('#layBody').addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset || !t.dataset.part || !doc) return;
    const loc = locOf(t);
    const value = t.tagName === 'SELECT' || t.dataset.scale ? (t.dataset.scale ? Math.round(Number(t.value) * Number(t.dataset.scale)) : Number(t.value)) : t.value;
    if (t.dataset.scale && !Number.isFinite(value)) return;
    patch(t.dataset.part, loc, t.dataset.k, value);
    sendPart(t.dataset.part, loc, t.dataset.k, value);
    if (t.tagName === 'SELECT') t.blur();
  });
  $('#layBody').addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-layer], .lay-res-item'); if (!el || !doc) return;
    e.preventDefault();
    const id = el.dataset.layer || el.dataset.laysel;
    const p = parseId(id); if (!p || p.kind === 'mv' || p.kind === 'art') return;
    const item = p.kind === 'key' ? keyOf(p.me, p.index) : p.kind === 'box' ? boxOf(p.ss, p.index) : dskOf(p.index);
    const placed = p.kind === 'key' ? keyPlaced(item) : p.kind === 'box' ? boxPlaced(item) : dskPlaced(item);
    sel = id;
    openMenu(e.clientX, e.clientY, id, placed, placed && p.kind !== 'dsk');
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = menu.dataset.id; const act = b.dataset.act; const p = parseId(id); closeMenu();
    if (act === 'props') {
      sel = id; if (p && (p.kind === 'key' || p.kind === 'dsk')) layTab = 'me'; if (p && p.kind === 'box') layTab = 'ss';
      saveLs('cc.layTab', layTab); saveLs('cc.laySel', sel); render();
    } else if (act === 'front') { zTop[id] = (zSeq += 1); saveLs('cc.layZ', zTop); render(); }
    else if (act === 'delete') release(p);
  });

  if (window.CCDRAG) window.CCDRAG.attach($('#layBody'), {
    handle: '.lay-res-item',
    start(el) {
      if (!doc || el.classList.contains('used') || layTab === 'mv') return null;
      return { kind: el.dataset.kind, me: Number(el.dataset.me), ss: Number(el.dataset.ss), index: Number(el.dataset.index), label: el.dataset.label };
    },
    target(under, payload) {
      const r = under && under.closest('[data-layraster]'); if (!r) return null;
      const id = r.dataset.layraster || '';
      if (payload.kind === 'key' && id === `me:${payload.me}`) return r;
      if (payload.kind === 'dsk' && id === 'me:0') return r;
      if (payload.kind === 'box' && id === `ss:${payload.ss}`) return r;
      return null;
    },
    drop(raster, payload, e) {
      const box = raster.getBoundingClientRect();
      const px = (e.clientX - box.left) / Math.max(1, box.width);
      const py = (e.clientY - box.top) / Math.max(1, box.height);
      const x = px * 32 - 16; const y = 9 - py * 18;
      if (payload.kind === 'key') placeKeyAt(payload.me, payload.index, x, y);
      else if (payload.kind === 'box') placeBoxAt(payload.ss, payload.index, x, y);
      else placeDskAt(payload.index);
    },
    ghost(el, payload) { return payload.label || el.textContent; },
  });

  function rasterOf(el) { return el.closest('[data-layraster]'); }
  function layerEl(id) { return document.querySelector(`[data-layer="${id}"]`); }
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
    const p = parseId(id);
    if (p && p.kind === 'box') {
      for (const b of (ssOf(p.ss) || {}).boxes || []) {
        if (`box:${p.ss}:${b.index}` === id || !boxPlaced(b)) continue;
        const r = uncropped('box', b); const u = unitsOf(r.left, r.top, r.width, r.height);
        xs.push(u.x, u.x - 16 * u.sx, u.x + 16 * u.sx); ys.push(u.y, u.y - 9 * u.sy, u.y + 9 * u.sy);
      }
    }
    if (p && p.kind === 'key') {
      for (const k of (meOf(p.me) || {}).keys || []) {
        if (`key:${p.me}:${k.index}` === id || !positioned(k)) continue;
        const r = uncropped('key', k); const u = unitsOf(r.left, r.top, r.width, r.height);
        xs.push(u.x, u.x - 16 * u.sx, u.x + 16 * u.sx); ys.push(u.y, u.y - 9 * u.sy, u.y + 9 * u.sy);
      }
    }
    return { x: xs, y: ys };
  }
  function paintEl(id, kind, item) {
    const el = layerEl(id); if (!el) return;
    const r = kind === 'box' ? boxVisual(item) : keyVisual(item);
    el.style.left = `${r.left}%`; el.style.top = `${r.top}%`; el.style.width = `${Math.max(r.width, 0)}%`; el.style.height = `${Math.max(r.height, 0)}%`;
  }
  $('#layBody').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const layer = e.target.closest('[data-layer]');
    if (!layer || !doc) {
      const rast = e.target.closest('[data-layraster]');
      if (rast && layTab === 'ss') { select(`art:${rast.dataset.layraster.slice(3)}`); }
      if (rast && layTab === 'mv' && !layer) { const id = rast.dataset.layraster; select(`mv:${id.slice(3)}:0`); }
      return;
    }
    const id = layer.dataset.layer; const p = parseId(id); if (!p) return;
    sel = id; saveLs('cc.laySel', sel);
    if (p.kind === 'dsk' || p.kind === 'mv') { render(); return; }
    const item = p.kind === 'box' ? boxOf(p.ss, p.index) : keyOf(p.me, p.index);
    if (!item || (p.kind === 'key' && !positioned(item))) { render(); return; }
    const h = e.target.closest('[data-h]');
    const r = uncropped(p.kind, item);
    holding = true;
    drag = { id: e.pointerId, layer: id, kind: p.kind, item, me: p.me, ss: p.ss, mode: h ? 'resize' : 'move', edge: h ? h.dataset.h : '', x0: e.clientX, y0: e.clientY, rect: r, ratio: r.width / Math.max(0.01, r.height) };
    try { layer.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    document.querySelectorAll('#layBody .lay-box').forEach((n) => n.classList.toggle('sel', n.dataset.layer === id));
  });
  $('#layBody').addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const layer = layerEl(drag.layer); const box = layer && rasterOf(layer); if (!box) return;
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
    const fields = sent.kind === 'box' ? { x: sent.item.x, y: sent.item.y, size: sent.item.size } : { positionX: sent.item.dve.positionX, positionY: sent.item.dve.positionY, sizeX: sent.item.dve.sizeX, sizeY: sent.item.dve.sizeY };
    if (!liveSend) { dirty = true; render(); return; }
    const p = sent.kind === 'box' ? cmd('ssBox', { ss: sent.ss, box: sent.item.index, ...fields }) : cmd('uskDve', { me: sent.me + 1, key: sent.item.index, ...fields });
    commit(p);
  }
  $('#layBody').addEventListener('pointerup', endDrag);
  $('#layBody').addEventListener('pointercancel', endDrag);

  $('#layRead').addEventListener('click', () => { dirty = false; pull(true); toast(layTab === 'mv' ? 'Read the multiview' : 'Read from the switcher'); render(); });
  $('#layApply').addEventListener('click', () => {
    if (!connected()) return;
    if (layTab === 'mv') {
      if (!mvDoc) return;
      run(api('POST', '/api/sys/atem/cmd/mvApply', { multiviews: mvDoc })).then(() => { dirty = false; toast('Multiview applied'); });
      return;
    }
    if (!doc) return;
    run(api('POST', '/api/sys/atem/cmd/layoutApply', { layout: doc })).then((r) => {
      dirty = false;
      const skip = r && r.skipped && r.skipped.length ? ` · ${r.skipped.map((s) => s.reason).join('; ')}` : '';
      toast(`Layout applied${skip}`, !!(r && r.skipped && r.skipped.length));
    });
  });
  $('#laySavePreset').addEventListener('click', () => {
    if (!doc) return;
    const name = $('#layName').value.trim(); if (!name) return toast('Type a name', true);
    const target = $('#layTarget').value === 'program' ? 'program' : 'preview';
    run(api('POST', '/api/sys/atem/layout-presets', { name, layout: doc, target })).then(() => { toast(`Look “${name}” saved for ${target}`); S.refetch(); });
  });
  $('#laySaveSalvo').addEventListener('click', () => {
    if (!mvDoc) return;
    const name = $('#layName').value.trim(); if (!name) return toast('Type a name', true);
    run(api('POST', '/api/sys/atem/mv-salvos', { name, multiviews: mvDoc })).then(() => { toast(`Salvo “${name}” saved`); S.refetch(); });
  });
  $('#laySaveMacro').addEventListener('click', () => {
    const name = $('#layName').value.trim() || (layTab === 'mv' ? 'Multiview' : 'Layout');
    const slot = Number($('#laySlot').value);
    if (!(slot >= 1 && slot <= 100)) return toast('Macro slot is 1–100', true);
    if (layTab === 'mv') {
      if (!mvDoc) return;
      run(api('POST', '/api/sys/atem/mv-salvo-macro', { name, index: slot - 1, multiviews: mvDoc })).then((r) => { $('#layXml').value = r.xml || ''; toast(`Macro ${slot} “${name}” saved`); });
      return;
    }
    if (!doc) return;
    const mode = $('#layFly').value; const flyFrom = $('#layFlyFrom').value;
    if (mode === 'pair' && !flyFrom) return toast('Pick the preset that should become key frame A', true);
    const body = { name, index: slot - 1, layout: doc, store: mode || null };
    if (mode === 'pair') body.flyFromPreset = flyFrom;
    run(api('POST', '/api/sys/atem/layout-macro', body)).then((r) => {
      $('#layXml').value = r.xml || '';
      const skip = r.skipped && r.skipped.length ? ` · ${r.skipped[0].reason}` : '';
      toast(`Macro ${slot} “${name}” saved${skip}`);
    });
  });
  $('#layRecall').addEventListener('click', (e) => {
    const b = e.target.closest('[data-recall], [data-mvrecall]'); if (!b) return;
    if (b.dataset.mvrecall) return run(api('POST', '/api/sys/atem/cmd/mvSalvoRecall', { salvo: b.dataset.mvrecall })).then(() => { dirty = false; toast('Salvo recalled'); });
    const target = b.dataset.target === 'program' ? 'program' : 'preview';
    return run(api('POST', '/api/sys/atem/cmd/layoutRecall', { preset: b.dataset.recall, target })).then((r) => {
      dirty = false;
      const skip = r && r.skipped && r.skipped.length ? ` · ${r.skipped[0].reason}` : '';
      toast(target === 'program' ? `On air${skip}` : `On preview${skip}`);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (window.CC.getTab() !== 'alayout' || !doc || drag || layTab === 'mv' || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const step = e.shiftKey ? 1 : 0.1;
    const p = parseId(sel); if (!p || (p.kind !== 'box' && p.kind !== 'key')) return;
    const item = p.kind === 'box' ? boxOf(p.ss, p.index) : keyOf(p.me, p.index);
    if (!item || (p.kind === 'key' && !positioned(item))) return;
    let dx = 0; let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step; else if (e.key === 'ArrowUp') dy = step; else if (e.key === 'ArrowDown') dy = -step; else return;
    e.preventDefault();
    const r = uncropped(p.kind, item); const u = unitsOf(r.left, r.top, r.width, r.height);
    u.x += dx; u.y += dy; if (p.kind === 'box') u.sy = u.sx;
    const fields = writeGeom(p.kind, item, u);
    if (!liveSend) { dirty = true; render(); return; }
    const q = p.kind === 'box' ? cmd('ssBox', { ss: p.ss, box: item.index, ...fields }) : cmd('uskDve', { me: p.me + 1, key: item.index, ...fields });
    commit(q);
  });

  S.onRender((v, t) => { V = v; tab = t; if (tab === 'alayout') render(); });
})();
