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

  function familyOf(id) {
    const m = String(id || '').match(/^(rs6|e2|pixelhue|atem|ptz|pixera|millumin|videohub|hyperdeck|mitti)(?:-[a-z0-9]{4,12})?$/);
    return m ? m[1] : '';
  }
  function rowOf(a) {
    if (!a) return 'other';
    if (a.instance && familyOf(a.instance)) return String(a.instance);
    if ((a.type === 'hires' || a.type === 'look') && familyOf(a.system)) return String(a.system);
    if (a.type === 'atem-macro') return 'atem';
    if (a.type === 'ptz') return 'ptz';
    if (a.type === 'look') return 'look';
    return a.type || 'other';
  }
  function rowName(key) {
    const g = (book.palette || []).find((x) => x && (x.id === key || x.device === key));
    if (g && g.label && g.type !== 'look') return g.label;
    const known = { rs6: 'RS6', e2: 'E2', pixelhue: 'PIXELHUE', atem: 'ATEM', ptz: 'PTZ', pixera: 'PIXERA', millumin: 'MILLUMIN', look: 'LOOKS' };
    if (known[key]) return known[key];
    const fam = familyOf(key);
    if (fam && known[fam] && key !== fam) return `${known[fam]} ${key}`;
    return String(key).toUpperCase();
  }
  function rowsFor(c) {
    const keys = new Set();
    const cueTypes = new Set(['rs6', 'e2', 'pixelhue', 'atem', 'ptz']);
    for (const g of book.palette || []) {
      const id = g && (g.id || g.device);
      const type = (g && g.type) || familyOf(id);
      if (cueTypes.has(type)) keys.add(id);
    }
    for (const a of (c && c.actions) || []) keys.add(rowOf(a));
    const order = ['rs6', 'e2', 'pixelhue', 'atem', 'ptz', 'pixera', 'millumin', 'look'];
    const rank = (key) => {
      const fam = familyOf(key);
      const i = order.indexOf(fam || key);
      return i < 0 ? 99 : i;
    };
    return [...keys].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
  }
  function stepCount(c, section) {
    const list = ((c && c.actions) || []).filter((a) => (a.section || 'take') === section);
    if (!list.length) return 1;
    return list.reduce((m, a) => Math.max(m, (a.step || 0) + 1), 1);
  }
  function panelHtml(c, section) {
    const rows = c ? rowsFor(c) : [];
    const n = c ? stepCount(c, section) : 1;
    const heads = Array.from({ length: n }, (_, i) => `<span class="cc-step-h">${i + 1}</span>`).join('');
    const lanes = rows.map((key) => {
      const cells = Array.from({ length: n }, (_, step) => {
        const items = ((c && c.actions) || []).filter((a) => rowOf(a) === key && (a.section || 'take') === section && a.step === step);
        const body = items.map((a) => `<button type="button" class="cc-act ${a.invalid ? 'bad' : ''} ${picked === a.id ? 'on' : ''} ${a.state || ''}" draggable="true" data-act="${esc(a.id)}">${esc(labelOf(a))}${a.offsetMs ? `<i class="cc-off">+${esc(a.offsetMs)}</i>` : ''}</button>`).join('');
        return `<div class="cc-cell" data-section="${section}" data-step="${step}" data-row="${esc(key)}">${body}</div>`;
      }).join('');
      return `<div class="cc-lane" style="--n:${n}"><span class="cc-row-name">${esc(rowName(key))}</span>${cells}</div>`;
    }).join('');
    return `<div class="cc-panel" data-panel="${section}" data-steps="${n}"><div class="cc-step-heads" style="--n:${n}"><span></span>${heads}</div>${lanes || '<div class="note small cc-time-empty">Drop a preset here.</div>'}</div>`;
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
    if (a.type === 'hires') return familyOf(a.system) && a.system !== familyOf(a.system) ? String(a.preset) : `${String(familyOf(a.system) || a.system || '').toUpperCase()} ${a.preset}`;
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
      const shut = closed.has(g.id || g.label);
      return `<section class="cc-sys"><button type="button" class="cc-sys-h" data-sys="${esc(g.id || g.label)}" aria-expanded="${shut ? 'false' : 'true'}">${shut ? '▸' : '▾'} ${esc(g.label)} <small>${items.length}</small></button>${shut ? '' : `<div class="cc-sys-items">${items.map((it, ii) => `<button type="button" class="cc-preset" draggable="true" data-pi="${gi}:${ii}">${esc(it.label)}</button>`).join('') || '<div class="note small">No presets</div>'}</div>`}</section>`;
    }).join('');
    const grid = (book.cues || []).map((row, i) => {
      const empty = !row.actions.length;
      const state = row.runState || 'idle';
      return `<button type="button" class="cc-cue ${i === selected ? 'on' : ''} ${empty ? 'empty' : 'armed'} ${state}" data-cue="${i}" data-state="${state}" draggable="false" title="${esc(row.name)}">${esc(`C${i + 1}`)}<b>${esc(row.name || 'Cue')}</b><small>${empty ? 'EMPTY' : `${row.actions.length} · ${state}`}</small></button>`;
    }).join('');
    const stack = (book.cues || []).map((row, i) => `<div class="cc-stack-row ${i === selected ? 'on' : ''}"><button type="button" data-cue="${i}"><b>${i + 1}</b> ${esc(row.name)}</button><button type="button" class="btn mini ghost" data-up="${i}" aria-label="Move up">↑</button><button type="button" class="btn mini ghost" data-down="${i}" aria-label="Move down">↓</button></div>`).join('');
    const act = c && c.actions.find((a) => a.id === picked);
    const runDisabled = m.state !== 'loaded';
    const runLabel = m.state === 'running' ? 'LOCKED' : 'RUN CUE';
    const actEditor = !act ? '' : `<div class="cc-act-edit"><div class="section-title">ACTION</div>
      <p class="note small">${esc(labelOf(act))} · ${esc(act.section || 'take')} · step ${(act.step || 0) + 1}</p>
      <label>OFFSET ms <input id="ccAt" type="number" min="0" step="10" value="${act.offsetMs || 0}"></label>
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
          <p class="note small cc-error" id="ccError">${esc(m.error || '')}</p>
          <div class="cc-stack-list">${stack}</div>
          <div class="cc-props">
            <div class="section-title">PROPERTIES</div>
            ${c ? `<label>NAME <input id="ccName" value="${esc(c.name)}" aria-label="Cue name"></label>
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
      <div class="cc-time-wrap" id="ccTimeline">
        <section class="cc-half" aria-label="Take">${panelHtml(c, 'take')}</section>
        <div class="cc-go-break" id="ccGo" title="GO"><span>GO</span></div>
        <section class="cc-half" aria-label="Post take">${panelHtml(c, 'post')}</section>
      </div>
      <div class="cc-run-corner">
        <button type="button" class="btn" id="ccAck" ${m.state === 'failed' ? '' : 'hidden'}>ACKNOWLEDGE</button>
        <button type="button" class="btn take cc-run" id="ccRun" ${runDisabled ? 'disabled' : ''}>${runLabel}</button>
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

  function tickPlayhead() { /* steps are an order, not a clock */ }

  function itemAt(key) {
    const [gi, ii] = String(key || '').split(':').map(Number);
    const group = (book.palette || [])[gi];
    if (!group) return null;
    const q = filterText.trim().toLowerCase();
    const items = (group.items || []).filter((it) => !q || String(it.label || '').toLowerCase().includes(q));
    return items[ii] || null;
  }

  function actionFrom(item, section, step) {
    if (!item || !item.type) return null;
    return { type: item.type, section, step, offsetMs: 0, system: item.system, preset: item.preset, macro: item.macro, camera: item.camera, look: item.look, mode: 'absolute', instance: item.instance || '' };
  }
  function clash(actions, item, ignoreId) {
    const key = rowOf(item);
    return (actions || []).some((a) => a.id !== ignoreId && (a.section || 'take') === item.section && a.step === item.step && rowOf(a) === key);
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
      el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); openActMenu(ev.clientX, ev.clientY, el.dataset.act); });
      el.addEventListener('dragstart', (ev) => {
        dragItem = null;
        ev.dataTransfer.setData('text/cc-act', el.dataset.act);
        ev.dataTransfer.effectAllowed = 'move';
      });
    });
    root.querySelectorAll('.cc-cell').forEach((cell) => {
      cell.addEventListener('dragover', (ev) => { ev.preventDefault(); cell.classList.add('hot'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('hot'));
      cell.addEventListener('drop', (ev) => { cell.classList.remove('hot'); dropOnCell(ev, cell); });
    });
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
    try { await saveCue(c, c.actions, { name: name ? name.value : c.name }); }
    catch (e) { note(e.message); }
  }

  function targetStep(ev, cell) {
    const section = cell.dataset.section === 'post' ? 'post' : 'take';
    const step = Number(cell.dataset.step) || 0;
    const rect = cell.getBoundingClientRect();
    const frac = rect.width ? (ev.clientX - rect.left) / rect.width : 0.5;
    if (frac < 0.22) return { section, step, insert: true };
    if (frac > 0.78) return { section, step: step + 1, insert: true };
    return { section, step, insert: false };
  }

  function applyMove(actions, id, dest) {
    const list = actions.map((a) => ({ ...a }));
    const item = list.find((a) => a.id === id);
    if (!item) return { actions: list, error: 'No such action' };
    let at = dest.step;
    if (dest.insert) {
      for (const a of list) if (a !== item && (a.section || 'take') === dest.section && a.step >= at) a.step += 1;
    }
    const trial = { ...item, section: dest.section, step: at };
    if (clash(list.filter((a) => a !== item), trial, id)) return { actions, error: `${rowName(rowOf(trial))} already fires in this step` };
    item.section = dest.section;
    item.step = at;
    return { actions: list, error: null };
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
    const step = take.reduce((m, a) => Math.max(m, (a.step || 0) + 1), 0);
    const action = actionFrom(item, 'take', step);
    if (!action) return;
    selected = index;
    try { await saveCue(row, row.actions.concat([action])); }
    catch (e) { note(e.message); }
  }

  async function dropOnCell(ev, cell) {
    ev.preventDefault();
    ev.stopPropagation();
    const c = cue(); if (!c) return;
    const dest = targetStep(ev, cell);
    const moving = ev.dataTransfer.getData('text/cc-act');
    try {
      if (moving) {
        const moved = applyMove(c.actions, moving, dest);
        if (moved.error) { note(moved.error); return; }
        await saveCue(c, moved.actions);
        return;
      }
      let item = dragItem;
      try { item = JSON.parse(ev.dataTransfer.getData('application/json') || '') || item; } catch { /* keep dragItem */ }
      let actions = c.actions.map((a) => ({ ...a }));
      let step = dest.step;
      if (dest.insert) {
        for (const a of actions) if ((a.section || 'take') === dest.section && a.step >= step) a.step += 1;
      }
      const action = actionFrom(item, dest.section, step);
      if (!action) return;
      if (clash(actions, action)) { note(`${rowName(rowOf(action))} already fires in this step`); return; }
      await saveCue(c, actions.concat([action]));
    } catch (e) { note(e.message); }
  }

  function openActMenu(x, y, id) {
    closeMenu();
    const c = cue();
    const act = c && c.actions.find((a) => a.id === id);
    if (!act) return;
    picked = id;
    menu = document.createElement('div');
    menu.className = 'cc-menu';
    menu.innerHTML = `<label class="cc-off-edit">OFFSET ms<input id="ccOffset" type="number" min="0" step="10" value="${act.offsetMs || 0}"></label><button type="button" data-m="offset">Set offset</button><button type="button" data-m="remove">Remove</button>`;
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    document.body.appendChild(menu);
    const input = menu.querySelector('#ccOffset');
    if (input) { input.focus(); input.select(); }
    menu.addEventListener('click', async (ev) => {
      const cmd = ev.target && ev.target.dataset && ev.target.dataset.m;
      if (!cmd) return;
      const offset = Number((menu.querySelector('#ccOffset') || {}).value) || 0;
      closeMenu();
      try {
        if (cmd === 'offset') {
          await saveCue(c, c.actions.map((a) => a.id === id ? { ...a, offsetMs: offset } : a));
          return;
        }
        if (cmd === 'remove') { picked = null; await saveCue(c, c.actions.filter((a) => a.id !== id)); }
      } catch (e) { note(e.message); }
    });
  }

  async function applyAction() {
    const c = cue(); if (!c) return;
    let blocked = '';
    const actions = c.actions.map((a) => {
      if (a.id !== picked) return a;
      const next = { ...a, offsetMs: Number((document.getElementById('ccAt') || {}).value) || 0 };
      const section = document.getElementById('ccSection');
      if (section) next.section = section.value === 'post' ? 'post' : 'take';
      if (clash(c.actions, next, a.id)) { blocked = `${rowName(rowOf(next))} already fires in this step`; return a; }
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
    if (blocked) { note(blocked); return; }
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
