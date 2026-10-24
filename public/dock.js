'use strict';
// 0.11.1 dockable / tiling workspace (vanilla JS, no dependencies), used by the PTZ CAMERA CONTROL dashboard.
//   * A responsive grid: 24 columns (≥ 1200 px wide), 12 (820–1199), 2 (< 820) and a single-column stack under 560 px;
//     rows are a fixed unit (--dk-row). Each breakpoint keeps its own layout, saved per install (CCPREFS
//     '<key>.dock.<bp>'); a layout equal to the built-in default is not stored.
//   * Move: drag a panel by its header (mouse / pen: drag; touch: press and hold, then drag). The panel follows the
//     pointer, a dashed placeholder shows where it lands (snapped to the grid); neighbours are pushed down and the
//     grid closes up (gravity), so panels never overlap. Esc cancels.
//   * Resize: the left / right / bottom edges and the two bottom corners, snapped to columns and rows.
//   * Collapse to the header (▾), pop out as a floating window (⧉, drag / resize freely, ⧉ again docks it), close (✕)
//     into the PANELS tray; a tray chip reopens the panel where it was.
//   * Keyboard, header focused: arrows move one column / row, Shift + arrows resize, Enter collapses, Delete closes.
//   * Named layouts (LAYOUT ▾): save the current layout of every breakpoint under a name, load, rename, delete; RESET
//     back to the default. Kept per install (CCPREFS '<key>.dockPresets').
//   * Motion safety: opts.canArrange() (the PTZ page: no control held) is checked before any move / resize / reflow;
//     while a panel is dragged, other pointers and keys are kept away from the page (Esc still reaches ALL STOP),
//     and nothing here talks to the server except the layout preference.
// CCDOCK.create(root, { key, panels: [{ id, title, minW, minH }] (minW in 24-column units), defaults: { xl, lg, md, sm }
//   (arrays of { id, x, y, w, h }), canArrange(), bar (element for the LAYOUT / tray controls), toast(msg, err) }) → api
(() => {
  const BPS = [{ id: 'xl', min: 1600, cols: 24, label: '≥ 1600 px · 24 columns' }, { id: 'lg', min: 1200, cols: 24, label: '1200–1599 px · 24 columns' },
    { id: 'md', min: 820, cols: 12, label: '820–1199 px · 12 columns' }, { id: 'sm', min: 0, cols: 2, label: '< 820 px · 2 columns (stack under 560 px)' }];
  const STACK_BELOW = 560; const ROW = 30; const GAP = 8; const HOLD = 300; const THRESHOLD = 4;
  const F_COLLAPSED = 1; const F_CLOSED = 2; const F_FLOAT = 4;
  const bpFor = (w) => BPS.find((b) => w >= b.min) || BPS[BPS.length - 1];
  const clone = (l) => l.map((it) => ({ ...it, f: it.f ? { ...it.f } : null }));
  const eh = (it) => (it.c ? 1 : it.h);
  const inGrid = (it) => !it.closed && !it.f;
  const xOver = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
  const hit = (a, b) => a !== b && a.id !== b.id && xOver(a, b) && a.y < b.y + eh(b) && b.y < a.y + eh(a);
  const byPos = (a, b) => a.y - b.y || a.x - b.x;
  // gravity: every panel rises until it meets one above it (never past one: the order in a column is kept)
  function compact(items) {
    const placed = [];
    for (const it of items.slice().sort(byPos)) {
      let { y } = it; if (y < 0) y = 0;
      while (y > 0 && !placed.some((p) => hit({ ...it, y: y - 1 }, p))) y--;
      while (placed.some((p) => hit({ ...it, y }, p))) y++;
      it.y = y; placed.push(it);
    }
    return items;
  }
  // one panel (id) put at box; the others keep their order and flow around it; then everything closes up
  function arrange(base, id, box) {
    const all = clone(base); const grid = all.filter(inGrid); const a = grid.find((x) => x.id === id);
    if (a) Object.assign(a, box);
    const placed = a ? [a] : []; const order = [];
    for (const o of grid.filter((x) => x !== a).sort(byPos)) {
      let y = 0; for (const p of order) if (xOver(p, o)) y = Math.max(y, p.y);
      while (placed.some((p) => hit({ ...o, y }, p))) y++;
      o.y = y; placed.push(o); order.push(o);
    }
    compact(grid);
    return all;
  }
  // "joy:0,0,4,17,0;lens:…" (flags: 1 collapsed, 2 closed, 4 floating + l,t,w,h in px)
  const enc = (l) => l.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((it) => `${it.id}:${[it.x, it.y, it.w, it.h, (it.c ? F_COLLAPSED : 0) | (it.closed ? F_CLOSED : 0) | (it.f ? F_FLOAT : 0)].concat(it.f ? [it.f.l, it.f.t, it.f.w, it.f.h].map(Math.round) : []).join(',')}`).join(';');
  function dec(s) {
    if (typeof s !== 'string' || !s) return null; const out = [];
    for (const part of s.split(';')) {
      const m = /^([\w-]{1,40}):([\d,-]+)$/.exec(part); if (!m) continue; const n = m[2].split(',').map(Number); if (n.length < 5 || n.some((v) => !Number.isFinite(v))) continue;
      out.push({ id: m[1], x: n[0], y: n[1], w: n[2], h: n[3], c: !!(n[4] & F_COLLAPSED), closed: !!(n[4] & F_CLOSED), f: n[4] & F_FLOAT && n.length >= 9 ? { l: n[5], t: n[6], w: n[7], h: n[8] } : null });
    }
    return out.length ? out : null;
  }

  function create(root, o) {
    const key = o.key; const PREF = (bp) => `${key}.dock.${bp}`; const PRESETS = `${key}.dockPresets`;
    const P = window.CCPREFS; const toast = o.toast || (() => {});
    const can = () => !o.canArrange || o.canArrange();
    const panels = new Map(); // id -> { el, head, title, minW, minH }
    const known = () => [...panels.keys()];
    let bp = bpFor(window.innerWidth); let stacked = false; let layout = []; let act = null; let pendingBp = false; let zTop = 40;

    // ---------- panels: header (title, collapse / float / close), resize handles, body ----------
    function adopt(el, def) {
      const id = def.id; el.dataset.panel = id; el.classList.add('dk-panel');
      const head = document.createElement('div'); head.className = 'dk-head'; head.tabIndex = 0;
      head.setAttribute('aria-label', `${def.title} panel — drag to move (touch: hold, then drag); arrow keys move, Shift + arrow keys resize, Enter collapses, Delete closes`);
      head.setAttribute('aria-roledescription', 'movable panel header');
      let t = el.firstElementChild && el.firstElementChild.classList.contains('section-title') ? el.firstElementChild : null;
      if (!t) { t = document.createElement('div'); t.className = 'section-title'; t.textContent = def.title; }
      head.innerHTML = '<span class="dk-grip" aria-hidden="true">⠿</span>';
      head.appendChild(t);
      head.insertAdjacentHTML('beforeend', `<span class="dk-btns"><button type="button" class="dk-b" data-dk="collapse" title="Collapse to the header / expand" aria-label="Collapse ${def.title}">▾</button><button type="button" class="dk-b" data-dk="float" title="Pop out as a floating window / dock it again" aria-label="Pop out ${def.title}">⧉</button><button type="button" class="dk-b" data-dk="close" title="Close into the PANELS tray" aria-label="Close ${def.title}">✕</button></span>`);
      const body = document.createElement('div'); body.className = 'dk-body';
      while (el.firstChild) body.appendChild(el.firstChild);
      el.appendChild(head); el.appendChild(body);
      for (const r of ['e', 'w', 's', 'se', 'sw']) { const h = document.createElement('i'); h.className = `dk-rz dk-rz-${r}`; h.dataset.rz = r; h.setAttribute('aria-hidden', 'true'); el.appendChild(h); }
      const badge = document.createElement('span'); badge.className = 'dk-size'; el.appendChild(badge);
      panels.set(id, { el, head, body, badge, title: def.title, minW: def.minW || 2, minH: def.minH || 4 });
    }
    for (const def of o.panels) { const el = root.querySelector(def.selector || `[data-panel="${def.id}"]`); if (el) adopt(el, def); }
    // panels another part of the app adds later (any .panel directly in root) join at the bottom
    for (const el of root.querySelectorAll(':scope > .panel:not(.dk-panel)')) {
      const id = el.dataset.panel || (/(?:^|\s)rcp-([\w-]+)/.exec(el.className) || [])[1] || `p${panels.size + 1}`;
      adopt(el, { id, title: ((el.querySelector('.section-title') || {}).textContent || id).trim().split('\n')[0].toUpperCase(), minW: 3, minH: 4 });
    }

    const colsOf = (b) => b.cols;
    const minW = (id, b = bp) => Math.max(1, Math.min(colsOf(b), Math.ceil(((panels.get(id) || {}).minW || 2) * colsOf(b) / 24)));
    const minH = (id) => (panels.get(id) || {}).minH || 4;
    function defaults(b) {
      const d = (o.defaults[b.id] || []).filter((it) => panels.has(it.id)).map((it) => ({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, c: false, closed: false, f: null }));
      let bottom = d.reduce((m, it) => Math.max(m, it.y + it.h), 0);
      for (const id of known()) if (!d.some((it) => it.id === id)) { const w = Math.max(minW(id, b), Math.ceil(b.cols / 2)); d.push({ id, x: 0, y: bottom, w, h: 12, c: false, closed: false, f: null }); bottom += 12; }
      return compact(d);
    }
    // a stored layout made valid for this breakpoint: known panels only, every panel present, sizes in range, no overlap
    function normal(l, b) {
      const def = defaults(b); const out = [];
      for (const id of known()) {
        const it = (l || []).find((x) => x.id === id) || def.find((x) => x.id === id);
        const w = Math.max(minW(id, b), Math.min(b.cols, Math.round(it.w) || 1)); const x = Math.max(0, Math.min(b.cols - w, Math.round(it.x) || 0));
        out.push({ id, x, y: Math.max(0, Math.round(it.y) || 0), w, h: Math.max(minH(id), Math.min(200, Math.round(it.h) || 1)), c: !!it.c, closed: !!it.closed, f: it.f ? { ...it.f } : null });
      }
      return compact(out.filter(inGrid)) && out;
    }
    const stored = (b) => normal(dec(P ? P.get(PREF(b.id), null) : null) || defaults(b), b);
    const isDefault = (l, b) => enc(normal(l, b)) === enc(normal(defaults(b), b));
    function persist() { if (!P) return; P.set(PREF(bp.id), isDefault(layout, bp) ? null : enc(layout)); }

    // ---------- render ----------
    function render() {
      const w = root.clientWidth || window.innerWidth;
      stacked = bp.id === 'sm' && w < STACK_BELOW;
      root.classList.toggle('dk-stacked', stacked); root.dataset.bp = bp.id;
      root.style.setProperty('--dk-cols', String(stacked ? 1 : bp.cols)); root.style.setProperty('--dk-row', `${ROW}px`); root.style.setProperty('--dk-gap', `${GAP}px`);
      let sy = 0; const order = stacked ? layout.filter(inGrid).slice().sort(byPos) : null;
      for (const it of layout) {
        const p = panels.get(it.id); if (!p) continue; const el = p.el;
        el.hidden = !!it.closed; el.classList.toggle('dk-collapsed', !!it.c); el.classList.toggle('dk-floating', !!it.f);
        p.head.querySelector('[data-dk=collapse]').textContent = it.c ? '▸' : '▾';
        p.head.querySelector('[data-dk=collapse]').setAttribute('aria-expanded', String(!it.c));
        p.head.querySelector('[data-dk=float]').classList.toggle('on', !!it.f);
        if (it.f) {
          const f = clampFloat(it.f); Object.assign(el.style, { gridColumn: '', gridRow: '', left: `${f.l}px`, top: `${f.t}px`, width: `${f.w}px`, height: it.c ? '' : `${f.h}px` });
        } else {
          Object.assign(el.style, { left: '', top: '', width: '', height: '', zIndex: '' });
          if (stacked) { const i = order.indexOf(it); const y0 = sy; sy += eh(it); el.style.gridColumn = '1 / span 1'; el.style.gridRow = `${y0 + 1} / span ${eh(it)}`; if (i < 0) el.style.gridRow = ''; }
          else { el.style.gridColumn = `${it.x + 1} / span ${it.w}`; el.style.gridRow = `${it.y + 1} / span ${eh(it)}`; }
        }
        el.dataset.box = `${it.x},${it.y},${it.w},${it.h}`;
      }
      renderBar();
      if (o.onLayout) o.onLayout(api);
    }
    function clampFloat(f) {
      const vw = window.innerWidth; const vh = window.innerHeight;
      const w = Math.max(220, Math.min(vw - 16, f.w)); const h = Math.max(120, Math.min(vh - 16, f.h));
      return { w, h, l: Math.max(8 - w + 120, Math.min(vw - 120, f.l)), t: Math.max(0, Math.min(vh - 40, f.t)) };
    }
    // the LAYOUT menu and the tray of closed panels
    let menuOpen = false;
    const bar = o.bar || null;
    if (bar) {
      bar.classList.add('dk-bar');
      bar.innerHTML = '<div class="dk-tray" role="toolbar" aria-label="Closed panels"></div><button type="button" class="btn mini dk-lay" aria-haspopup="true" aria-expanded="false"><span class="dk-lay-n">LAYOUT</span> ▾</button><div class="dk-menu" role="dialog" aria-label="Dashboard layout" hidden></div>';
      bar.querySelector('.dk-lay').addEventListener('click', () => { menuOpen = !menuOpen; renderBar(); if (menuOpen) { const i = bar.querySelector('.dk-menu input'); if (i) i.focus(); } });
      document.addEventListener('pointerdown', (e) => { if (menuOpen && !bar.contains(e.target)) { menuOpen = false; renderBar(); } });
      // Esc closes the menu (and still reaches the page: on the PTZ page Esc is ALL STOP)
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) { menuOpen = false; renderBar(); if (bar.contains(document.activeElement) || document.activeElement === document.body) bar.querySelector('.dk-lay').focus(); } });
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-dka]'); if (!b) return; const a = b.dataset.dka; const name = b.dataset.name;
        if (a === 'open') return reopen(b.dataset.id);
        if (a === 'toggle') { const it = layout.find((x) => x.id === b.dataset.id); if (it.closed) reopen(it.id, false); else close(it.id); const n = bar.querySelector(`.dk-menu input[data-id="${it.id}"]`); if (n) n.focus(); return undefined; }
        if (a === 'reset') return reset();
        if (a === 'save') { const inp = bar.querySelector('.dk-menu input[name=dkname]'); return savePreset(inp.value); }
        if (a === 'load') return loadPreset(name);
        if (a === 'rename') { const n = prompt('New name for this layout', name); if (n === null) return undefined; return renamePreset(name, n); }
        if (a === 'delete') { if (!confirm(`Delete the layout "${name}"?`)) return undefined; return deletePreset(name); }
        return undefined;
      });
      bar.addEventListener('submit', (e) => { e.preventDefault(); const inp = bar.querySelector('.dk-menu input[name=dkname]'); savePreset(inp.value); });
    }
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function presets() { const v = P ? P.get(PRESETS, {}) : {}; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    // the whole workspace (every breakpoint) as stored strings; the current breakpoint from memory
    function snapshot() { const s = {}; for (const b of BPS) { const l = b.id === bp.id ? layout : stored(b); if (!isDefault(l, b)) s[b.id] = enc(normal(l, b)); } return s; }
    function activeName() {
      const s = JSON.stringify(snapshot()); if (s === '{}') return 'DEFAULT';
      const hitp = Object.entries(presets()).find(([, v]) => JSON.stringify(Object.fromEntries(BPS.filter((b) => v[b.id]).map((b) => [b.id, enc(normal(dec(v[b.id]), b))]))) === s);
      return hitp ? hitp[0] : 'CUSTOM';
    }
    function renderBar() {
      if (!bar) return;
      const closed = layout.filter((it) => it.closed);
      const tray = bar.querySelector('.dk-tray'); tray.hidden = !closed.length;
      tray.innerHTML = closed.length ? `<span class="dk-tray-l">PANELS</span>${closed.map((it) => `<button type="button" class="dk-chip" data-dka="open" data-id="${esc(it.id)}" title="Reopen the ${esc(panels.get(it.id).title)} panel">＋ ${esc(panels.get(it.id).title)}</button>`).join('')}` : '';
      const name = activeName(); bar.querySelector('.dk-lay-n').textContent = name === 'DEFAULT' ? 'LAYOUT' : `LAYOUT: ${name}`;
      bar.querySelector('.dk-lay').classList.toggle('custom', name !== 'DEFAULT'); bar.querySelector('.dk-lay').setAttribute('aria-expanded', String(menuOpen));
      const m = bar.querySelector('.dk-menu'); m.hidden = !menuOpen; if (!menuOpen) return;
      const typed = (m.querySelector('input[name=dkname]') || {}).value || '';
      const ps = Object.keys(presets()).sort((a, b) => a.localeCompare(b));
      m.innerHTML = `<div class="dk-m-h">LAYOUT <small>${esc(bp.label)}${stacked ? ' · stacked' : ''}</small></div>
        <div class="dk-m-s">PANELS <small>uncheck to close into the tray</small></div><div class="dk-m-panels">${layout.map((it) => `<label class="dk-m-p"><input type="checkbox" data-dka="toggle" data-id="${esc(it.id)}" ${it.closed ? '' : 'checked'}>${esc(panels.get(it.id).title)}${it.f ? ' <small>floating</small>' : it.c ? ' <small>collapsed</small>' : ''}</label>`).join('')}</div>
        <div class="dk-m-s">SAVED LAYOUTS <small>every screen size, for this install</small></div>
        <div class="dk-m-list">${ps.length ? ps.map((n) => `<div class="dk-m-row ${n === name ? 'on' : ''}"><span class="dk-m-n">${esc(n)}</span><button type="button" class="btn mini" data-dka="load" data-name="${esc(n)}">LOAD</button><button type="button" class="btn mini" data-dka="rename" data-name="${esc(n)}">RENAME</button><button type="button" class="btn mini danger" data-dka="delete" data-name="${esc(n)}">DELETE</button></div>`).join('') : '<div class="note small">No saved layouts yet.</div>'}</div>
        <form class="dk-m-save"><input name="dkname" maxlength="40" placeholder="Name, e.g. Paint op" autocomplete="off" value="${esc(typed)}"><button type="submit" class="btn mini primary" data-dka="save">SAVE AS</button></form>
        <div class="dk-m-foot"><button type="button" class="btn mini" data-dka="reset" title="Every panel back to its default place and size, on every screen size">↺ RESET TO DEFAULT</button></div>`;
    }

    // ---------- operations ----------
    function commit(next, why) { layout = next; render(); persist(); if (why) toast(why); }
    function guard() { if (can()) return true; toast('Release the camera controls before rearranging the panels', true); return false; }
    function boxOf(id) { const it = layout.find((x) => x.id === id); return { x: it.x, y: it.y, w: it.w, h: it.h }; }
    function setItem(id, patch) { const l = clone(layout); Object.assign(l.find((x) => x.id === id), patch); return l; }
    function collapse(id, on) { if (!guard()) return; const it = layout.find((x) => x.id === id); const v = on === undefined ? !it.c : !!on; const l = setItem(id, { c: v }); commit(it.f ? l : arrange(l, id, boxOf(id))); }
    function close(id) { if (!guard()) return; const l = setItem(id, { closed: true }); compact(l.filter(inGrid)); commit(l, `${panels.get(id).title} closed — reopen it from the PANELS tray`); }
    function reopen(id, focus = true) { if (!guard()) return; const l = setItem(id, { closed: false }); commit(arrange(l, id, boxOf(id))); const p = panels.get(id); if (p && focus) p.head.focus({ preventScroll: true }); }
    function float(id) {
      if (!guard()) return; const it = layout.find((x) => x.id === id); const el = panels.get(id).el;
      if (it.f) { commit(arrange(setItem(id, { f: null }), id, boxOf(id))); return; }
      const r = el.getBoundingClientRect(); const l = setItem(id, { f: { l: Math.min(r.left + 24, window.innerWidth - r.width - 8), t: Math.max(8, Math.min(r.top + 24, window.innerHeight - 200)), w: r.width, h: Math.min(r.height, window.innerHeight - 40) } });
      compact(l.filter(inGrid)); commit(l); el.style.zIndex = String(++zTop);
    }
    function reset() { if (!guard()) return; if (P) for (const b of BPS) P.set(PREF(b.id), null); layout = defaults(bp); menuOpen = false; render(); toast('Dashboard layout reset to the default'); }
    function savePreset(raw) {
      const name = String(raw || '').trim().slice(0, 40); if (!name) { toast('Type a name for the layout', true); return; }
      const all = presets(); if (!all[name] && Object.keys(all).length >= 16) { toast('At most 16 saved layouts: delete one first', true); return; }
      if (all[name] && !confirm(`Replace the saved layout "${name}"?`)) return;
      const next = { ...all, [name]: snapshot() }; if (JSON.stringify(next).length > 8000) { toast('Too many saved layouts to keep: delete one first', true); return; }
      if (P) P.set(PRESETS, next); const i = bar && bar.querySelector('.dk-menu input[name=dkname]'); if (i) i.value = ''; renderBar(); toast(`Layout "${name}" saved`);
    }
    function loadPreset(name) {
      if (!guard()) return; const v = presets()[name]; if (!v) return;
      if (P) for (const b of BPS) P.set(PREF(b.id), v[b.id] && !isDefault(dec(v[b.id]), b) ? enc(normal(dec(v[b.id]), b)) : null);
      layout = normal(dec(v[bp.id]) || defaults(bp), bp); menuOpen = false; render(); toast(`Layout "${name}" loaded`);
    }
    function renamePreset(from, raw) {
      const to = String(raw || '').trim().slice(0, 40); const all = presets(); if (!to || !all[from] || to === from) return;
      if (all[to] && !confirm(`Replace the saved layout "${to}"?`)) return;
      const next = {}; for (const [k, v] of Object.entries(all)) if (k !== from) next[k] = v; next[to] = all[from];
      if (P) P.set(PRESETS, next); renderBar(); toast(`Layout renamed to "${to}"`);
    }
    function deletePreset(name) { const all = { ...presets() }; delete all[name]; if (P) P.set(PRESETS, Object.keys(all).length ? all : null); renderBar(); toast(`Layout "${name}" deleted`); }

    // ---------- pointer: move (header) and resize (edges / corners) ----------
    const metrics = () => { const r = root.getBoundingClientRect(); const cols = stacked ? 1 : bp.cols; const cw = (r.width - GAP * (cols - 1)) / cols; return { r, cols, px: cw + GAP, py: ROW + GAP, cw }; };
    function blockOthers(e) { if (act && e.pointerId !== act.id) { e.stopPropagation(); e.preventDefault(); } }
    function blockKeys(e) { if (!act || !act.on) return; if (e.key === 'Escape') { cancel(); return; } e.stopPropagation(); e.preventDefault(); }
    function noTouchScroll(e) { if (act && act.on) e.preventDefault(); }
    function listen(on) {
      const f = on ? 'addEventListener' : 'removeEventListener';
      window[f]('pointermove', onMove, true); window[f]('pointerup', onUp, true); window[f]('pointercancel', onCancel, true);
      window[f]('pointerdown', blockOthers, true); window[f]('keydown', blockKeys, true);
      document[f]('touchmove', noTouchScroll, on ? { capture: true, passive: false } : { capture: true });
      document[f]('contextmenu', swallowCtx, true);
    }
    function swallowCtx(e) { if (act) e.preventDefault(); }
    root.addEventListener('pointerdown', (e) => {
      if (act || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const rz = e.target.closest('.dk-rz'); const head = e.target.closest('.dk-head');
      if (!rz && (!head || e.target.closest('button,input,select,textarea,a,label'))) return;
      const el = (rz || head).closest('.dk-panel'); if (!el || !root.contains(el)) return;
      const id = el.dataset.panel; const it = layout.find((x) => x.id === id); if (!it) return;
      if (stacked && !it.f) return; // the narrow stack is not rearranged by dragging
      if (rz && it.c) return;
      if (!can()) { toast('Release the camera controls before rearranging the panels', true); return; }
      const touch = e.pointerType === 'touch';
      act = { id, el, mode: rz ? 'resize' : 'move', edge: rz ? rz.dataset.rz : null, pid: e.pointerId, id0: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, touch, base: clone(layout), it: { ...it, f: it.f ? { ...it.f } : null }, timer: 0 };
      act.id = e.pointerId; act.pid = id;
      listen(true);
      if (rz) { e.preventDefault(); try { rz.setPointerCapture(e.pointerId); } catch { /* */ } begin(e); }
      else if (touch) { el.classList.add('dk-pending'); act.timer = setTimeout(() => { if (act && !act.on) { if (can()) begin({ clientX: act.x0, clientY: act.y0 }); else stop(); } }, HOLD); }
    });
    function begin(e) {
      const a = act; a.on = true; a.el.classList.remove('dk-pending'); a.el.classList.add(a.mode === 'move' ? 'dk-moving' : 'dk-resizing');
      root.classList.add('dk-arranging'); document.body.classList.add('dk-busy', a.mode === 'move' ? 'dk-busy-move' : `dk-busy-rz-${a.edge}`);
      if (navigator.vibrate && a.touch) try { navigator.vibrate(15); } catch { /* */ }
      const r = a.el.getBoundingClientRect(); a.gx = e.clientX - r.left; a.gy = e.clientY - r.top; a.rect = { l: r.left, t: r.top, w: r.width, h: r.height };
      if (!a.it.f) { a.ph = document.createElement('div'); a.ph.className = 'dk-ph'; root.appendChild(a.ph); }
      if (a.it.f) a.el.style.zIndex = String(++zTop);
      step(e);
    }
    function onMove(e) {
      const a = act; if (!a || e.pointerId !== a.id) return;
      if (!a.on) {
        const d = Math.hypot(e.clientX - a.x0, e.clientY - a.y0);
        if (a.touch) { if (d > 10) stop(); return; } // a swipe before the hold: let the page scroll
        if (d < THRESHOLD) return;
        if (!can()) { stop(); return; }
        begin(e);
      }
      e.preventDefault(); step(e);
    }
    function step(e) {
      const a = act; if (!a || !a.on) return; const id = a.pid;
      const dx = e.clientX - a.x0; const dy = e.clientY - a.y0;
      if (a.it.f) { // floating: free pixels
        const f = { ...a.it.f };
        if (a.mode === 'move') { f.l += dx; f.t += dy; } else {
          if (a.edge.includes('e')) f.w = Math.max(220, a.it.f.w + dx); if (a.edge.includes('s')) f.h = Math.max(120, a.it.f.h + dy);
          if (a.edge.includes('w')) { const w = Math.max(220, a.it.f.w - dx); f.l = a.it.f.l + (a.it.f.w - w); f.w = w; }
        }
        layout = setItem(id, { f }); render(); a.el.style.zIndex = String(zTop); a.badge = `${Math.round(f.w)} × ${Math.round(f.h)} px`; badge(a); return;
      }
      const m = metrics(); let box;
      if (a.mode === 'move') {
        const left = e.clientX - a.gx - m.r.left; const top = e.clientY - a.gy - m.r.top;
        box = { x: Math.max(0, Math.min(m.cols - a.it.w, Math.round(left / m.px))), y: Math.max(0, Math.round(top / m.py)), w: a.it.w, h: a.it.h };
      } else {
        const cx = Math.round(dx / m.px); const cy = Math.round(dy / m.py); let { x, w, h } = a.it; const mw = minW(id);
        if (a.edge.includes('e')) w = Math.max(mw, Math.min(m.cols - x, a.it.w + cx));
        if (a.edge.includes('w')) { const nx = Math.max(0, Math.min(a.it.x + a.it.w - mw, a.it.x + cx)); w = a.it.w + (a.it.x - nx); x = nx; }
        if (a.edge.includes('s')) h = Math.max(minH(id), Math.min(200, a.it.h + cy));
        box = { x, y: a.it.y, w, h };
      }
      const k = `${box.x},${box.y},${box.w},${box.h}`;
      if (k !== a.k) { a.k = k; layout = arrange(a.base, id, box); render(); }
      const it = layout.find((x) => x.id === id);
      if (a.ph) { a.ph.style.gridColumn = `${it.x + 1} / span ${it.w}`; a.ph.style.gridRow = `${it.y + 1} / span ${eh(it)}`; }
      if (a.mode === 'move') { // the panel follows the pointer; the placeholder shows the snapped place
        const want = { l: e.clientX - a.gx, t: e.clientY - a.gy }; const at = { l: m.r.left + it.x * m.px, t: m.r.top + it.y * m.py };
        a.el.style.transform = `translate(${Math.round(want.l - at.l)}px, ${Math.round(want.t - at.t)}px)`;
      }
      a.badge = `${it.w} × ${it.h}`; badge(a);
    }
    function badge(a) { const p = panels.get(a.pid); if (p) { p.badge.textContent = a.badge || ''; p.badge.classList.toggle('on', a.on && a.mode === 'resize'); } }
    function onUp(e) { if (act && e.pointerId === act.id) stop(true); }
    function onCancel(e) { if (act && e.pointerId === act.id) cancel(); }
    function cancel() { const a = act; if (!a) return; if (a.on) layout = a.base; stop(false); render(); }
    function stop(ok) {
      const a = act; if (!a) return; act = null; clearTimeout(a.timer); listen(false);
      a.el.classList.remove('dk-pending', 'dk-moving', 'dk-resizing'); a.el.style.transform = ''; if (a.ph) a.ph.remove();
      root.classList.remove('dk-arranging'); document.body.classList.remove('dk-busy', 'dk-busy-move', ...['e', 'w', 's', 'se', 'sw'].map((x) => `dk-busy-rz-${x}`));
      const p = panels.get(a.pid); if (p) p.badge.classList.remove('on');
      if (a.on) { eatClick = performance.now() + 400; if (ok) { render(); persist(); } }
      if (pendingBp) checkBp();
    }
    let eatClick = 0;
    root.addEventListener('click', (e) => { if (performance.now() < eatClick && e.target.closest('.dk-head')) { e.stopPropagation(); e.preventDefault(); } eatClick = 0; }, true);
    // header buttons, double-click collapses, floating panels come to the front
    root.addEventListener('click', (e) => {
      const b = e.target.closest('.dk-head [data-dk]'); if (!b) return; const id = b.closest('.dk-panel').dataset.panel; e.stopPropagation();
      if (b.dataset.dk === 'collapse') collapse(id); else if (b.dataset.dk === 'float') float(id); else if (b.dataset.dk === 'close') close(id);
    });
    root.addEventListener('dblclick', (e) => { const h = e.target.closest('.dk-head'); if (!h || e.target.closest('button')) return; collapse(h.closest('.dk-panel').dataset.panel); });
    root.addEventListener('pointerdown', (e) => { const el = e.target.closest('.dk-panel.dk-floating'); if (el && !act) el.style.zIndex = String(++zTop); }, true);

    // ---------- keyboard on a focused header ----------
    function keyMove(id, dir, resize) {
      const it = layout.find((x) => x.id === id); if (!it) return; const cols = bp.cols;
      if (it.f) { const f = { ...it.f }; const s = 20; if (resize) { if (dir === 'L') f.w -= s; if (dir === 'R') f.w += s; if (dir === 'U') f.h -= s; if (dir === 'D') f.h += s; } else { if (dir === 'L') f.l -= s; if (dir === 'R') f.l += s; if (dir === 'U') f.t -= s; if (dir === 'D') f.t += s; } commit(setItem(id, { f: clampFloat(f) })); return; }
      if (stacked) return;
      const box = { x: it.x, y: it.y, w: it.w, h: it.h };
      if (resize) {
        if (dir === 'R') box.w = Math.min(cols - it.x, it.w + 1); if (dir === 'L') box.w = Math.max(minW(id), it.w - 1);
        if (dir === 'D') box.h = Math.min(200, it.h + 1); if (dir === 'U') box.h = Math.max(minH(id), it.h - 1);
        if (it.c && (dir === 'U' || dir === 'D')) return;
      } else if (dir === 'L') box.x = Math.max(0, it.x - 1); else if (dir === 'R') box.x = Math.min(cols - it.w, it.x + 1);
      else if (dir === 'U') { if (it.y === 0) return; box.y = it.y - 1; }
      else { // down: below the next panel under this one
        const below = layout.filter((x) => inGrid(x) && x.id !== id && xOver(x, it) && x.y >= it.y + eh(it)).sort(byPos)[0]; if (!below) return;
        box.y = it.y + eh(below);
      }
      commit(arrange(layout, id, box));
    }
    root.addEventListener('keydown', (e) => {
      const h = e.target.closest('.dk-head'); if (!h || e.target !== h) return; const id = h.closest('.dk-panel').dataset.panel;
      const dir = { ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D' }[e.key];
      if (dir) { e.preventDefault(); e.stopPropagation(); if (!e.repeat || can()) { if (guard()) keyMove(id, dir, e.shiftKey); } h.focus({ preventScroll: false }); return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); collapse(id); h.focus(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); close(id); }
    });
    root.addEventListener('keyup', (e) => { if (e.target.classList && e.target.classList.contains('dk-head') && /^Arrow/.test(e.key)) e.stopPropagation(); });

    // ---------- breakpoints, stored layouts arriving from the server ----------
    function checkBp() {
      const b = bpFor(window.innerWidth);
      if (b.id === bp.id) { pendingBp = false; const was = stacked; render(); if (was !== stacked) render(); return; }
      if (act || !can()) { pendingBp = true; return; } // never rearrange under a held control or a drag
      pendingBp = false; bp = b; layout = stored(bp); render();
    }
    let rt = 0; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(checkBp, 60); });
    setInterval(() => { if (pendingBp) checkBp(); }, 300);
    function reload() { if (act || !can()) { setTimeout(reload, 300); return; } layout = stored(bp); render(); }
    if (P) { P.ready.then(reload); P.on(reload); }
    layout = stored(bp); render();

    const api = {
      bp: () => bp.id, stacked: () => stacked, layout: () => clone(layout), busy: () => !!(act && act.on), activeName,
      move: (id, x, y) => commit(arrange(layout, id, { ...boxOf(id), x, y })), resize: (id, w, h) => commit(arrange(layout, id, { ...boxOf(id), w, h })),
      collapse, close, reopen, float, reset, savePreset, loadPreset, renamePreset, deletePreset, presets, enc: () => enc(layout),
      defaults: () => enc(defaults(bp)), breakpoints: BPS.map((b) => ({ ...b })),
    };
    return api;
  }
  window.CCDOCK = { create, _test: { compact, arrange, enc, dec, bpFor } };
})();
