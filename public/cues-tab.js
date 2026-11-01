// CUES tab. Systems tree, cue grid, stack and RUN CUE, timeline split by the GO mark.
(function () {
  'use strict';
  const root = document.getElementById('pane-cues');
  if (!root) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let book = { cues: [], palette: [], running: null, stacked: false, machine: { state: 'idle', phase: null, cueId: null, error: null, locked: false } };
  let selected = 0;
  let picked = null;
  let filterText = '';
  let lastSig = '';
  let dragItem = null;
  let menu = null;
  const closed = new Set();

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || r.statusText);
    return j;
  }
  const cue = () => book.cues[selected] || null;
  const machine = () => book.machine || { state: 'idle', phase: null, cueId: null, error: null, locked: false };
  const locked = () => machine().state === 'running';

  function spanOf(c) {
    const actions = (c && c.actions) || [];
    const go = (c && c.goMs) || 0;
    const last = actions.reduce((m, a) => Math.max(m, a.atMs || 0), 0);
    return Math.max(10000, go + 2000, last + 1500);
  }

  function signature() {
    return JSON.stringify({
      m: book.machine, s: book.stacked, r: book.running,
      c: (book.cues || []).map((c) => ({ id: c.id, name: c.name, goMs: c.goMs, invalid: c.invalid, runState: c.runState, actions: c.actions })),
      p: (book.palette || []).map((g) => [g.label, (g.items || []).map((it) => it.label).join('|')]),
    });
  }

  function editing() {
    const a = document.activeElement;
    return !!(a && root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'));
  }

  function followMachine() {
    const id = machine().cueId;
    if (!id || machine().state === 'idle') return;
    const i = book.cues.findIndex((c) => c.id === id);
    if (i >= 0) selected = i;
  }

  function labelOf(a) {
    if (!a) return '';
    if (a.type === 'hires') return `${String(a.system || '').toUpperCase()} ${a.preset}`;
    if (a.type === 'ptz') return `${a.camera} ${a.preset}`;
    if (a.type === 'atem-macro') return `M${Number(a.macro) + 1}`;
    if (a.type === 'look') return `LOOK ${a.look}`;
    return a.type || 'action';
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  function paint(force) {
    const sig = signature();
    if (!force && sig === lastSig) { touchLive(); return; }
    if (!force && editing()) { touchLive(); return; }
    lastSig = sig;
    closeMenu();
    const c = cue();
    const m = machine();
    const q = filterText.trim().toLowerCase();
    const tree = (book.palette || []).map((g, gi) => {
      const items = (g.items || []).filter((it) => !q || String(it.label || '').toLowerCase().includes(q));
      const shut = closed.has(g.label);
      return `<section class="cc-sys"><button type="button" class="cc-sys-h" data-sys="${esc(g.label)}" aria-expanded="${shut ? 'false' : 'true'}">${shut ? '▸' : '▾'} ${esc(g.label)} <small>${items.length}</small></button>${shut ? '' : `<div class="cc-sys-items">${items.map((it, ii) => `<button type="button" class="cc-preset" draggable="true" data-pi="${gi}:${ii}">${esc(it.label)}</button>`).join('') || '<div class="note small">No presets</div>'}</div>`}</section>`;
    }).join('');
    const grid = (book.cues || []).map((row, i) => {
      const empty = !row.actions.length;
      const state = row.runState || 'idle';
      return `<button type="button" class="cc-cue ${i === selected ? 'on' : ''} ${empty ? 'empty' : 'armed'} ${state}" data-cue="${i}" data-state="${state}" draggable="false" title="${esc(row.name)}">${esc(`C${i + 1}`)}<b>${esc(row.name || 'Cue')}</b><small>${empty ? 'EMPTY' : `${row.actions.length} · ${state}`}</small></button>`;
    }).join('');
    const stack = (book.cues || []).map((row, i) => `<div class="cc-stack-row ${i === selected ? 'on' : ''}"><button type="button" data-cue="${i}"><b>${i + 1}</b> ${esc(row.name)}</button><button type="button" class="btn mini ghost" data-up="${i}" aria-label="Move up">↑</button><button type="button" class="btn mini ghost" data-down="${i}" aria-label="Move down">↓</button></div>`).join('');
    const span = spanOf(c);
    const goPct = c ? Math.min(98, (c.goMs / span) * 100) : 50;
    const actions = c ? c.actions.map((a) => {
      const left = Math.min(96, ((a.atMs || 0) / span) * 100);
      const side = a.section === 'post' ? 'post' : 'take';
      return `<button type="button" class="cc-act ${side} ${a.invalid ? 'bad' : ''} ${picked === a.id ? 'on' : ''} ${a.state || ''}" draggable="true" data-act="${esc(a.id)}" style="left:${left}%">${esc(labelOf(a))}<small>${esc(a.atMs || 0)} ms</small></button>`;
    }).join('') : '';
    const act = c && c.actions.find((a) => a.id === picked);
    const runDisabled = m.state !== 'loaded';
    const runLabel = m.state === 'running' ? 'LOCKED' : 'RUN CUE';
    const actEditor = !act ? '' : `<div class="cc-act-edit"><div class="section-title">ACTION</div>
      <p class="note small">${esc(labelOf(act))} · ${esc(act.section || 'take')}</p>
      <label>DELAY ms <input id="ccAt" type="number" min="0" step="100" value="${act.atMs || 0}"></label>
      <label>SECTION <select id="ccSection"><option value="take" ${act.section !== 'post' ? 'selected' : ''}>TAKE</option><option value="post" ${act.section === 'post' ? 'selected' : ''}>POST TAKE</option></select></label>
      ${act.type === 'hires' ? `<label>MODE <select id="ccMode"><option value="absolute" ${act.mode !== 'relative' ? 'selected' : ''}>ABSOLUTE</option><option value="relative" ${act.mode === 'relative' ? 'selected' : ''}>RELATIVE</option></select></label>
        <label>FOLLOW-UP <input id="ccFollow" value="${esc(act.followUp ? act.followUp.preset : '')}" placeholder="preset"></label>
        <label>FOLLOW DELAY <input id="ccFollowDelay" type="number" min="0" step="100" value="${act.followUp ? act.followUp.delayMs : 0}"></label>
        <label>BAIL <input id="ccBail" value="${esc(act.bail ? act.bail.preset : '')}" placeholder="preset"></label>` : ''}
      <button type="button" class="btn mini" id="ccApply">APPLY</button>
      <button type="button" class="btn mini danger" id="ccRemove">REMOVE</button></div>`;
    root.innerHTML = `<div class="cc-cues" data-state="${esc(m.state)}">
      <div class="cc-top">
        <aside class="cc-col" id="ccSystems" aria-label="Systems">
          <div class="section-title">SYSTEMS</div>
          <input id="ccFilter" type="search" placeholder="Filter presets" value="${esc(filterText)}" aria-label="Filter presets">
          <div class="cc-tree">${tree || '<div class="note">No systems.</div>'}</div>
        </aside>
        <div class="cc-col cc-board">
          <div class="section-title">CUES <small>Assigned cues load. Empty cues are grey. Right-click to program.</small></div>
          <div class="cc-grid" id="ccGrid">${grid || '<div class="note">No cues.</div>'}</div>
        </div>
        <aside class="cc-col cc-stack" aria-label="Cue stack">
          <div class="section-title">CUE STACK <span id="ccState" class="cc-state" data-state="${esc(m.state)}">${esc(String(m.state || 'idle').toUpperCase())}</span></div>
          <label class="cc-stack-toggle"><input type="checkbox" id="ccStacked" ${book.stacked ? 'checked' : ''}> Stacked cues</label>
          <button type="button" class="btn take cc-run" id="ccRun" ${runDisabled ? 'disabled' : ''}>${runLabel}</button>
          <button type="button" class="btn" id="ccAck" ${m.state === 'failed' ? '' : 'hidden'}>ACKNOWLEDGE</button>
          <p class="note small cc-error" id="ccError">${esc(m.error || '')}</p>
          <div class="cc-stack-list">${stack}</div>
          <div class="cc-props">
            <div class="section-title">PROPERTIES</div>
            ${c ? `<label>NAME <input id="ccName" value="${esc(c.name)}" aria-label="Cue name"></label>
              <label>GO POINT ms <input id="ccGoMs" type="number" min="0" step="100" value="${c.goMs || 0}" aria-label="GO point"></label>
              <p class="note small" id="ccPhase">${m.phase ? `Phase ${esc(m.phase)}` : (c.actions.length ? `${c.actions.length} on the timeline` : 'Nothing on this timeline')}</p>` : '<p class="note">No cue selected.</p>'}
            <div class="cc-prop-actions">
              <button type="button" class="btn mini" id="ccAdd">ADD CUE</button>
              <button type="button" class="btn mini" id="ccRename">RENAME</button>
              <button type="button" class="btn mini ghost" id="ccClear">CLEAR</button>
              <button type="button" class="btn mini danger" id="ccDelete">DELETE</button>
            </div>
            ${actEditor}
          </div>
        </aside>
      </div>
      <div class="cc-time-wrap" id="ccTimeline" data-span="${span}">
        <div class="cc-time-label"><span>TAKE</span><span>POST TAKE</span></div>
        <div class="cc-time" id="ccTime">
          <div class="cc-go" id="ccGo" style="left:${goPct}%" title="GO"></div>
          <div class="cc-head" id="ccHead" hidden></div>
          ${actions || '<div class="note cc-time-empty">Drag a preset onto the timeline. Left of the dotted line is TAKE. Right is POST TAKE.</div>'}
        </div>
      </div>
    </div>`;
    const tab = document.querySelector('[data-tab="cues"]');
    if (tab) { tab.dataset.cueState = m.state || 'idle'; }
    bind();
    touchLive();
  }

  function touchLive() {
    const m = machine();
    const pill = document.getElementById('ccState');
    if (pill) { pill.textContent = String(m.state || 'idle').toUpperCase(); pill.dataset.state = m.state || 'idle'; }
    const run = document.getElementById('ccRun');
    if (run) {
      run.disabled = m.state !== 'loaded';
      run.textContent = m.state === 'running' ? 'LOCKED' : 'RUN CUE';
    }
    const err = document.getElementById('ccError');
    if (err && !editing()) err.textContent = m.error || '';
    const phase = document.getElementById('ccPhase');
    if (phase && m.phase && !editing()) phase.textContent = `Phase ${m.phase}`;
    const rootState = root.querySelector('.cc-cues');
    if (rootState) rootState.dataset.state = m.state || 'idle';
    const tab = document.querySelector('[data-tab="cues"]');
    if (tab) tab.dataset.cueState = m.state || 'idle';
    tickPlayhead();
  }

  function tickPlayhead() {
    const el = document.getElementById('ccHead');
    const time = document.getElementById('ccTimeline');
    const run = book.running;
    if (!el || !time || !run || !run.startedAt) { if (el) el.hidden = true; return; }
    const span = Number(time.dataset.span) || 10000;
    const ms = Math.max(0, Date.now() - run.startedAt);
    el.hidden = false;
    el.style.left = `${Math.min(99, (ms / span) * 100)}%`;
  }

  function itemAt(key) {
    const [gi, ii] = String(key || '').split(':').map(Number);
    const group = (book.palette || [])[gi];
    if (!group) return null;
    const q = filterText.trim().toLowerCase();
    const items = (group.items || []).filter((it) => !q || String(it.label || '').toLowerCase().includes(q));
    return items[ii] || null;
  }

  function actionFrom(item, atMs, section) {
    if (!item || !item.type) return null;
    return { type: item.type, atMs, section, system: item.system, preset: item.preset, macro: item.macro, camera: item.camera, look: item.look, mode: 'absolute' };
  }

  async function saveCue(c, actions, extra) {
    await api('POST', '/api/master-cues', { id: c.id, name: (extra && extra.name) || c.name, goMs: extra && extra.goMs != null ? extra.goMs : c.goMs, actions });
    await load({ force: true });
  }

  function openMenu(x, y, index) {
    closeMenu();
    const row = book.cues[index];
    if (!row) return;
    menu = document.createElement('div');
    menu.className = 'cc-menu';
    menu.innerHTML = `<button type="button" data-m="edit">Edit</button><button type="button" data-m="rename">Rename</button><button type="button" data-m="clear">Clear</button><button type="button" data-m="delete">Delete</button>`;
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    document.body.appendChild(menu);
    menu.addEventListener('click', async (ev) => {
      const cmd = ev.target && ev.target.dataset && ev.target.dataset.m;
      closeMenu();
      if (!cmd) return;
      selected = index;
      picked = null;
      try {
        if (cmd === 'edit' || cmd === 'rename') { paint(true); const input = document.getElementById('ccName'); if (input) { input.focus(); input.select(); } return; }
        if (cmd === 'clear') { await api('POST', `/api/master-cues/${encodeURIComponent(row.id)}/clear`); await load({ force: true }); return; }
        if (cmd === 'delete') {
          if (!window.confirm(`Delete ${row.name}?`)) return;
          await api('DELETE', `/api/master-cues/${encodeURIComponent(row.id)}`);
          if (selected >= book.cues.length - 1) selected = Math.max(0, selected - 1);
          await load({ force: true });
        }
      } catch (e) { note(e.message); }
    });
  }

  function note(message) {
    const err = document.getElementById('ccError');
    if (err) err.textContent = message;
  }

  function bind() {
    root.querySelectorAll('[data-sys]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.sys;
      if (closed.has(key)) closed.delete(key); else closed.add(key);
      paint(true);
    }));
    const filter = document.getElementById('ccFilter');
    if (filter) filter.addEventListener('input', () => {
      filterText = filter.value;
      const pos = filter.selectionStart;
      paint(true);
      const again = document.getElementById('ccFilter');
      if (again) { again.focus(); if (pos != null) again.setSelectionRange(pos, pos); }
    });
    root.querySelectorAll('[data-cue]').forEach((b) => b.addEventListener('click', () => choose(Number(b.dataset.cue))));
    root.querySelectorAll('[data-cue]').forEach((b) => b.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openMenu(ev.clientX, ev.clientY, Number(b.dataset.cue));
    }));
    root.querySelectorAll('[data-cue]').forEach((b) => {
      b.addEventListener('dragover', (ev) => { ev.preventDefault(); });
      b.addEventListener('drop', (ev) => dropOnCue(ev, Number(b.dataset.cue)));
    });
    root.querySelectorAll('.cc-preset').forEach((el) => {
      el.addEventListener('dragstart', (ev) => {
        dragItem = itemAt(el.dataset.pi);
        ev.dataTransfer.setData('application/json', JSON.stringify(dragItem || {}));
        ev.dataTransfer.effectAllowed = 'copy';
      });
    });
    const move = async (i, dir) => {
      const ids = book.cues.map((c) => c.id);
      const j = i + dir;
      if (j < 0 || j >= ids.length) return;
      const [id] = ids.splice(i, 1);
      ids.splice(j, 0, id);
      book = await api('POST', '/api/master-cues/reorder', { ids });
      selected = j;
      paint(true);
    };
    root.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); move(Number(b.dataset.up), -1); }));
    root.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); move(Number(b.dataset.down), 1); }));
    const stacked = document.getElementById('ccStacked');
    if (stacked) stacked.addEventListener('change', async () => {
      try { book = await api('POST', '/api/master-cues/stacked', { on: stacked.checked }); paint(true); }
      catch (e) { note(e.message); }
    });
    const run = document.getElementById('ccRun');
    if (run) run.addEventListener('click', async () => {
      if (run.disabled || locked()) return;
      try { book = await api('POST', '/api/master-cues/run'); followMachine(); paint(true); }
      catch (e) { note(e.message); }
    });
    const ack = document.getElementById('ccAck');
    if (ack) ack.addEventListener('click', async () => {
      try { book = await api('POST', '/api/master-cues/ack'); followMachine(); paint(true); }
      catch (e) { note(e.message); }
    });
    const add = document.getElementById('ccAdd');
    if (add) add.addEventListener('click', async () => {
      try {
        await api('POST', '/api/master-cues', { name: `Cue ${book.cues.length + 1}`, actions: [] });
        await load({ force: true });
        selected = Math.max(0, book.cues.length - 1);
        paint(true);
      } catch (e) { note(e.message); }
    });
    const rename = document.getElementById('ccRename');
    if (rename) rename.addEventListener('click', () => saveFields());
    const name = document.getElementById('ccName');
    if (name) name.addEventListener('change', () => saveFields());
    const goMs = document.getElementById('ccGoMs');
    if (goMs) goMs.addEventListener('change', () => saveFields());
    const clear = document.getElementById('ccClear');
    if (clear) clear.addEventListener('click', async () => {
      const c = cue(); if (!c) return;
      try { await api('POST', `/api/master-cues/${encodeURIComponent(c.id)}/clear`); picked = null; await load({ force: true }); }
      catch (e) { note(e.message); }
    });
    const del = document.getElementById('ccDelete');
    if (del) del.addEventListener('click', async () => {
      const c = cue(); if (!c) return;
      if (!window.confirm(`Delete ${c.name}?`)) return;
      try {
        await api('DELETE', `/api/master-cues/${encodeURIComponent(c.id)}`);
        picked = null;
        if (selected >= book.cues.length - 1) selected = Math.max(0, selected - 1);
        await load({ force: true });
      } catch (e) { note(e.message); }
    });
    root.querySelectorAll('.cc-act').forEach((el) => {
      el.addEventListener('click', () => { picked = el.dataset.act; paint(true); });
      el.addEventListener('dragstart', (ev) => {
        dragItem = null;
        ev.dataTransfer.setData('text/cc-act', el.dataset.act);
        ev.dataTransfer.effectAllowed = 'move';
      });
    });
    const time = document.getElementById('ccTime');
    if (time) {
      time.addEventListener('dragover', (ev) => ev.preventDefault());
      time.addEventListener('drop', (ev) => dropOnTime(ev));
    }
    const apply = document.getElementById('ccApply');
    if (apply) apply.addEventListener('click', () => applyAction());
    const remove = document.getElementById('ccRemove');
    if (remove) remove.addEventListener('click', async () => {
      const c = cue(); if (!c) return;
      try { await saveCue(c, c.actions.filter((a) => a.id !== picked)); picked = null; }
      catch (e) { note(e.message); }
    });
  }

  async function choose(index) {
    if (locked()) return;
    selected = index;
    picked = null;
    const row = book.cues[index];
    paint(true);
    if (!row || !row.actions.length) return;
    try { book = await api('POST', `/api/master-cues/${encodeURIComponent(row.id)}/load`); followMachine(); paint(true); }
    catch (e) { note(e.message); }
  }

  async function saveFields() {
    const c = cue(); if (!c) return;
    const name = document.getElementById('ccName');
    const go = document.getElementById('ccGoMs');
    try {
      await saveCue(c, c.actions, { name: name ? name.value : c.name, goMs: go ? Number(go.value) : c.goMs });
    } catch (e) { note(e.message); }
  }

  async function dropOnCue(ev, index) {
    ev.preventDefault();
    ev.stopPropagation();
    const row = book.cues[index];
    if (!row) return;
    let item = dragItem;
    try { item = JSON.parse(ev.dataTransfer.getData('application/json') || '') || item; } catch { /* keep dragItem */ }
    if (!item || !item.type) return;
    const take = row.actions.filter((a) => a.section !== 'post');
    const last = take.reduce((m, a) => Math.max(m, a.atMs || 0), 0);
    const ceiling = row.goMs > 0 ? row.goMs - 100 : 0;
    const atMs = take.length ? Math.max(0, Math.min(ceiling, last + 500)) : 0;
    const action = actionFrom(item, atMs, 'take');
    if (!action) return;
    selected = index;
    try { await saveCue(row, row.actions.concat([action])); }
    catch (e) { note(e.message); }
  }

  async function dropOnTime(ev) {
    ev.preventDefault();
    const c = cue(); if (!c) return;
    const time = document.getElementById('ccTime');
    const rect = time.getBoundingClientRect();
    const span = spanOf(c);
    const atMs = Math.max(0, Math.round((((ev.clientX - rect.left) / Math.max(1, rect.width)) * span) / 100) * 100);
    const section = atMs >= (c.goMs || 0) ? 'post' : 'take';
    const moving = ev.dataTransfer.getData('text/cc-act');
    try {
      if (moving) {
        const actions = c.actions.map((a) => a.id === moving ? { ...a, atMs, section } : a);
        await saveCue(c, actions);
        return;
      }
      let item = dragItem;
      try { item = JSON.parse(ev.dataTransfer.getData('application/json') || '') || item; } catch { /* keep dragItem */ }
      const action = actionFrom(item, atMs, section);
      if (!action) return;
      await saveCue(c, c.actions.concat([action]));
    } catch (e) { note(e.message); }
  }

  async function applyAction() {
    const c = cue(); if (!c) return;
    const actions = c.actions.map((a) => {
      if (a.id !== picked) return a;
      const next = { ...a, atMs: Number((document.getElementById('ccAt') || {}).value) || 0 };
      const section = document.getElementById('ccSection');
      if (section) next.section = section.value === 'post' ? 'post' : 'take';
      if (a.type === 'hires') {
        const mode = document.getElementById('ccMode');
        const follow = (document.getElementById('ccFollow') || {}).value || '';
        const bail = (document.getElementById('ccBail') || {}).value || '';
        next.mode = mode ? mode.value : a.mode;
        next.followUp = follow.trim() ? { preset: follow.trim(), delayMs: Number((document.getElementById('ccFollowDelay') || {}).value) || 0, mode: 'absolute' } : null;
        next.bail = bail.trim() ? { preset: bail.trim() } : null;
      }
      return next;
    });
    try { await saveCue(c, actions); }
    catch (e) { note(e.message); }
  }

  async function load(opts) {
    const force = opts && opts.force;
    try { book = await api('GET', '/api/master-cues'); }
    catch (e) { note(e.message); return; }
    if (selected >= book.cues.length) selected = 0;
    if (locked()) followMachine();
    paint(!!force);
  }

  document.addEventListener('click', (ev) => { if (menu && !menu.contains(ev.target)) closeMenu(); });
  document.querySelectorAll('[data-tab="cues"]').forEach((b) => b.addEventListener('click', () => load({ force: true }).catch(() => {})));
  setInterval(() => { if (root.hidden) return; load().catch(() => {}); tickPlayhead(); }, 400);
  load().catch(() => paint(true));
})();
