// Master cues. Persistent top tab. Palette, timeline, inspector.
(function () {
  'use strict';
  const root = document.getElementById('pane-cues');
  if (!root) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let book = { cues: [], palette: [], running: null };
  let selected = 0;
  let picked = null;
  let searchCaret = null;
  const SPAN = 10000;

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || r.statusText);
    return j;
  }
  const cue = () => book.cues[selected] || null;

  function paint() {
    const c = cue();
    const q = (document.getElementById('mcSearch') || {}).value || '';
    const needle = q.trim().toLowerCase();
    const palette = (book.palette || []).map((g) => {
      const items = (g.items || []).filter((it) => !needle || String(it.label || '').toLowerCase().includes(needle));
      if (!items.length) return '';
      return `<section><h3>${esc(g.label)}</h3>${items.map((it) => `<button type="button" class="mc-item" draggable="true" data-item="${esc(JSON.stringify(it))}">${esc(it.label)}</button>`).join('')}</section>`;
    }).join('');
    const actions = c ? c.actions.map((a) => {
      const left = Math.min(98, (a.offsetMs / SPAN) * 100);
      return `<button type="button" class="mc-act ${a.invalid ? 'bad' : ''} ${picked === a.id ? 'on' : ''} ${a.state || ''}" draggable="true" data-act="${a.id}" style="left:${left}%">${esc(a.offsetMs)}ms ${esc(a.type === 'hires' ? a.preset : a.type === 'ptz' ? a.camera : 'M' + (Number(a.macro) + 1))}<small>${esc(a.state || '')}</small></button>`;
    }).join('') : '';
    const act = c && c.actions.find((a) => a.id === picked);
    const inspect = !act ? '<div class="note">Select an action.</div>' : `<label>OFFSET ms <input id="mcOffset" type="number" min="0" step="100" value="${act.offsetMs || 0}"></label>
      ${act.type === 'hires' ? `<p class="note small">${esc(act.system)} ${esc(act.mode)} ${esc(act.preset)}</p>
        <label>MODE <select id="mcMode"><option value="absolute" ${act.mode !== 'relative' ? 'selected' : ''}>ABSOLUTE</option><option value="relative" ${act.mode === 'relative' ? 'selected' : ''}>RELATIVE</option></select></label>
        <label>FOLLOW-UP <input id="mcFollow" value="${esc(act.followUp ? act.followUp.preset : '')}" placeholder="preset"></label>
        <label>FOLLOW DELAY <input id="mcFollowDelay" type="number" min="0" step="100" value="${act.followUp ? act.followUp.delayMs : 0}"></label>
        <label>BAIL <input id="mcBail" value="${esc(act.bail ? act.bail.preset : '')}" placeholder="preset"></label>` : ''}
      <button type="button" class="btn mini" id="mcApply">APPLY</button>
      <button type="button" class="btn mini danger" id="mcRemove">REMOVE</button>
      ${act.invalid ? '<p class="note">This item is missing on the device. GO is blocked.</p>' : ''}`;
    root.innerHTML = `<div class="looks-wrap mc-home">
      <div class="board-head">
        <div class="section-title">CUES <small>One click. Offsets snap to 0.1 s.</small></div>
        <span class="spacer"></span>
        <button type="button" class="btn" id="mcGo" ${c && c.invalid ? 'disabled' : ''}>GO</button>
        <button type="button" class="btn danger" id="mcStop">STOP</button>
      </div>
      <div class="mc-layout">
        <div class="mc-list">${book.cues.map((row, i) => `<div class="cue-row ${i === selected ? 'on' : ''} ${row.invalid ? 'bad' : ''}"><button type="button" data-cue="${i}"><b>${i + 1}</b><span>${esc(row.name)}</span></button><button type="button" class="btn mini ghost" data-up="${i}">↑</button><button type="button" class="btn mini ghost" data-down="${i}">↓</button></div>`).join('')}</div>
        <div class="mc-main">
          <div class="cue-head">${c ? `<input id="mcName" value="${esc(c.name)}" aria-label="Cue name"><button type="button" class="btn mini" id="mcRename">RENAME</button><button type="button" class="btn mini" id="mcDup">DUPLICATE</button><button type="button" class="btn mini ghost" id="mcClear">CLEAR</button>` : ''}</div>
          <div id="mcTime" class="mc-time">${actions || '<div class="note">Drag a saved item onto the timeline.</div>'}</div>
          <p class="note small" id="mcStatus">${book.running ? `Running ${book.running.id}` : 'Pending actions show on the timeline. STOP cancels the ones that have not fired, including a hi-res follow-up.'}</p>
        </div>
        <div class="mc-side">
          <input id="mcSearch" placeholder="Search palette" value="${esc(q)}" aria-label="Search palette">
          <div class="mc-palette">${palette || '<div class="note">Nothing saved under that name.</div>'}</div>
          <div class="mc-inspect">${inspect}</div>
        </div>
      </div>
    </div>`;
    bind();
    if (searchCaret != null) {
      const again = document.getElementById('mcSearch');
      if (again) {
        again.focus();
        const at = Math.min(searchCaret, again.value.length);
        try { again.setSelectionRange(at, at); } catch { /* number inputs have no caret */ }
      }
      searchCaret = null;
    }
  }

  function bind() {
    const search = document.getElementById('mcSearch');
    if (search) search.addEventListener('input', () => { searchCaret = search.selectionStart; paint(); });
    root.querySelectorAll('[data-cue]').forEach((b) => b.addEventListener('click', () => { selected = Number(b.dataset.cue); picked = null; paint(); }));
    const move = async (i, dir) => {
      const ids = book.cues.map((c) => c.id);
      const j = i + dir;
      if (j < 0 || j >= ids.length) return;
      const [id] = ids.splice(i, 1);
      ids.splice(j, 0, id);
      book = await api('POST', '/api/master-cues/reorder', { ids });
      selected = j;
      paint();
    };
    root.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.up), -1)));
    root.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.down), 1)));
    const go = document.getElementById('mcGo');
    if (go) go.addEventListener('click', async () => {
      const c = cue(); if (!c) return;
      try { book = await api('POST', `/api/master-cues/${encodeURIComponent(c.id)}/go`); paint(); }
      catch (e) { const st = document.getElementById('mcStatus'); if (st) st.textContent = e.message; }
    });
    const stop = document.getElementById('mcStop');
    if (stop) stop.addEventListener('click', async () => { book = await api('POST', '/api/master-cues/stop'); paint(); });
    const rename = document.getElementById('mcRename');
    if (rename) rename.addEventListener('click', async () => {
      const c = cue(); if (!c) return;
      await api('POST', '/api/master-cues', { id: c.id, name: document.getElementById('mcName').value });
      await load();
    });
    const dup = document.getElementById('mcDup');
    if (dup) dup.addEventListener('click', async () => { const c = cue(); if (!c) return; await api('POST', `/api/master-cues/${encodeURIComponent(c.id)}/duplicate`); await load(); });
    const clear = document.getElementById('mcClear');
    if (clear) clear.addEventListener('click', async () => { const c = cue(); if (!c) return; await api('POST', `/api/master-cues/${encodeURIComponent(c.id)}/clear`); await load(); });
    root.querySelectorAll('.mc-item').forEach((el) => {
      el.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('application/json', el.dataset.item); });
    });
    root.querySelectorAll('.mc-act').forEach((el) => {
      el.addEventListener('click', () => { picked = el.dataset.act; paint(); });
      el.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/mc-act', el.dataset.act); });
    });
    const time = document.getElementById('mcTime');
    if (time) {
      time.addEventListener('dragover', (ev) => ev.preventDefault());
      time.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        const c = cue(); if (!c) return;
        const rect = time.getBoundingClientRect();
        const offsetMs = Math.max(0, Math.round((((ev.clientX - rect.left) / Math.max(1, rect.width)) * SPAN) / 100) * 100);
        const moving = ev.dataTransfer.getData('text/mc-act');
        if (moving) {
          const actions = c.actions.map((a) => a.id === moving ? { ...a, offsetMs } : a);
          await api('POST', '/api/master-cues', { id: c.id, actions });
          await load();
          return;
        }
        let item = null;
        try { item = JSON.parse(ev.dataTransfer.getData('application/json') || elData(ev)); } catch { item = null; }
        if (!item || !item.type) return;
        const action = { type: item.type, offsetMs, system: item.system, preset: item.preset, macro: item.macro, camera: item.camera, mode: 'absolute' };
        await api('POST', '/api/master-cues', { id: c.id, actions: c.actions.concat([action]) });
        await load();
      });
    }
    const apply = document.getElementById('mcApply');
    if (apply) apply.addEventListener('click', async () => {
      const c = cue(); if (!c) return;
      const actions = c.actions.map((a) => {
        if (a.id !== picked) return a;
        const next = { ...a, offsetMs: Number(document.getElementById('mcOffset').value) || 0 };
        if (a.type === 'hires') {
          const mode = document.getElementById('mcMode');
          const follow = document.getElementById('mcFollow').value.trim();
          const bail = document.getElementById('mcBail').value.trim();
          next.mode = mode ? mode.value : a.mode;
          next.followUp = follow ? { preset: follow, delayMs: Number(document.getElementById('mcFollowDelay').value) || 0, mode: 'absolute' } : null;
          next.bail = bail ? { preset: bail } : null;
        }
        return next;
      });
      await api('POST', '/api/master-cues', { id: c.id, actions });
      await load();
    });
    const remove = document.getElementById('mcRemove');
    if (remove) remove.addEventListener('click', async () => {
      const c = cue(); if (!c) return;
      await api('POST', '/api/master-cues', { id: c.id, actions: c.actions.filter((a) => a.id !== picked) });
      picked = null;
      await load();
    });
  }
  function elData() { return ''; }

  async function load() {
    const keep = (document.getElementById('mcSearch') || {}).value || '';
    book = await api('GET', '/api/master-cues');
    if (selected >= book.cues.length) selected = 0;
    paint();
    const search = document.getElementById('mcSearch');
    if (search && keep) { search.value = keep; search.dispatchEvent(new Event('input')); }
  }
  document.querySelectorAll('[data-tab="cues"]').forEach((b) => b.addEventListener('click', () => load().catch(() => {})));
  load().catch(() => paint());
})();
