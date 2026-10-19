'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let S = null; let mode = 'recall'; let editing = null;
  const HINTS = {
    recall: 'Tap a preset to load it to Preview on its destinations.',
    save: 'Light the destinations to include, then tap an empty slot (or a preset to overwrite).',
    edit: 'Tap a preset to rename, renumber, fix slots, update, duplicate or delete.',
  };

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 4000 : 1800); }
  const run = (p) => p.catch((e) => toast(e.message, true));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = (k) => { const d = S && S.destinations.find((x) => x.key === k); return d ? d.label : k; };

  // ---------- render ----------
  function render() {
    if (!S) return;
    const c = $('#conn');
    const ver = S.system && S.system.version ? (typeof S.system.version === 'object' ? `${S.system.version.major}.${S.system.version.minor}.${S.system.version.patch}` : S.system.version) : '';
    c.className = 'pill ' + (S.connected ? 'ok' : 'off');
    c.innerHTML = (S.connected ? `${esc(S.system.type || 'Aquilon')} ${esc(ver)} · ${esc(S.settings.host)}` : `Not connected${S.lastError ? ' · ' + esc(S.lastError).slice(0, 60) : ''}`) + (S.mock ? '<span class="mock">MOCK</span>' : '');
    $('#last').textContent = S.lastRecalled ? `PVW: ${S.lastRecalled.number} · ${S.lastRecalled.name}` : 'PVW: —';

    const row = $('#destRow');
    row.innerHTML = S.destinations.map((d) => `
      <button class="dest ${d.selected ? 'on' : ''}" data-dest="${d.key}">
        <span class="k">${d.kind === 'screen' ? 'SCREEN' : 'AUX'} ${d.id}</span>
        <span class="l">${esc(d.label)}</span>
        <span class="tl">${d.pgmPreset != null ? `<span class="p">PGM ${d.pgmPreset}</span>` : ''}${d.pvwPreset != null ? `<span class="v">PVW ${d.pvwPreset}</span>` : ''}</span>
      </button>`).join('') + `<button class="dest ctl" data-ctl="all">ALL</button><button class="dest ctl" data-ctl="none">CLEAR</button>`;
    if (!S.destinations.length) row.insertAdjacentHTML('afterbegin', '<div class="note">No destinations yet. Check Settings and connect.</div>');

    const byNum = new Map(S.presets.map((p) => [p.number, p]));
    const maxN = Math.max(0, ...S.presets.map((p) => p.number));
    const slots = Math.max(24, Math.ceil((maxN + (mode === 'save' ? 4 : 0)) / 8) * 8);
    let html = '';
    for (let n = 1; n <= slots; n++) {
      const p = byNum.get(n);
      if (!p) { html += `<button class="preset empty" data-empty="${n}"><span class="num">${n}</span>${mode === 'save' ? '<span>+ save here</span>' : ''}</button>`; continue; }
      const cls = ['preset']; const tags = [];
      if (p.tally.pgm !== 'none') { if (p.tally.pgm === 'full') cls.push('pgm'); tags.push(`<span class="tag pgm ${p.tally.pgm === 'partial' ? 'part' : ''}">PGM</span>`); }
      if (p.tally.pvw !== 'none') { if (p.tally.pvw === 'full') cls.push('pvw'); tags.push(`<span class="tag pvw ${p.tally.pvw === 'partial' ? 'part' : ''}">PVW</span>`); }
      if (p.lastRecalled) cls.push('is-last');
      const chips = p.destinations.map((d) => {
        const ok = p.memories[d] || p.hasSources[d];
        return `<span class="chip ${ok ? '' : 'warn'}" title="${esc(label(d))}">${d}${p.memories[d] ? ':' + p.memories[d] : ''}</span>`;
      }).join('');
      html += `<button class="${cls.join(' ')}" data-preset="${n}"><span class="tags">${tags.join('')}</span><span class="num">${n}</span><span class="name">${esc(p.name)}</span><span class="chips">${chips}</span></button>`;
    }
    $('#grid').innerHTML = html;

    const a = $('#btnAuto'); a.classList.toggle('on', S.autoTake); a.innerHTML = `AUTO TAKE<br><b>${S.autoTake ? 'ON' : 'OFF'}</b>`;
    $('#btnTake').disabled = $('#btnCut').disabled = !S.selection.length;
  }

  function addLog(e) {
    const el = document.createElement('div'); el.className = `e ${e.level}`;
    el.innerHTML = `<span class="t">${new Date(e.t).toLocaleTimeString()}</span> ${esc(e.msg)}`;
    const box = $('#log'); const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    box.appendChild(el); while (box.children.length > 400) box.firstChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
    $('#logCount').textContent = `${box.children.length} lines`;
  }

  // ---------- live updates ----------
  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (ev) => { S = JSON.parse(ev.data); render(); });
    es.addEventListener('log', (ev) => addLog(JSON.parse(ev.data)));
    es.onerror = () => { $('#conn').className = 'pill off'; $('#conn').textContent = 'App server unreachable…'; };
  }

  // ---------- interactions ----------
  $('#destRow').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.dest) return run(api('POST', `/api/destinations/${b.dataset.dest}/toggle`));
    if (b.dataset.ctl === 'all') return run(api('POST', '/api/selection', { destinations: S.destinations.map((d) => d.key) }));
    if (b.dataset.ctl === 'none') return run(api('POST', '/api/selection', { destinations: [] }));
  });

  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('active', x === b));
    $('#modeHint').textContent = HINTS[mode]; render();
  }));

  $('#grid').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const n = Number(b.dataset.preset || b.dataset.empty);
    if (mode === 'recall') { if (b.dataset.preset) run(api('POST', `/api/presets/${n}/recall`)); return; }
    if (mode === 'save') return openSave(n, !!b.dataset.preset);
    if (mode === 'edit' && b.dataset.preset) return openEdit(n);
  });

  $('#btnTake').addEventListener('click', () => run(api('POST', '/api/take')));
  $('#btnCut').addEventListener('click', () => run(api('POST', '/api/cut')));
  $('#btnAuto').addEventListener('click', () => run(api('POST', '/api/autotake', {})));
  $('#logToggle').addEventListener('click', (e) => { if (e.target.id !== 'logClear') $('#logwrap').classList.toggle('collapsed'); });
  $('#logClear').addEventListener('click', () => { $('#log').innerHTML = ''; $('#logCount').textContent = ''; });

  // keyboard: Space/Enter = TAKE, C = CUT
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); run(api('POST', '/api/take')); }
    if (e.key === 'c' || e.key === 'C') run(api('POST', '/api/cut'));
  });

  // ---------- save ----------
  function slotInputs(container, dests, memories) {
    container.innerHTML = dests.map((d) => `<label>${d} · ${esc(label(d))}<input type="number" min="1" max="1000" name="slot_${d}" placeholder="auto / sources" value="${memories && memories[d] ? memories[d] : ''}"></label>`).join('');
  }
  function readSlots(form, dests) {
    const m = {}; for (const d of dests) { const v = form.elements[`slot_${d}`] && form.elements[`slot_${d}`].value; if (v) m[d] = Number(v); } return m;
  }
  function openSave(n, exists) {
    if (!S.selection.length) return toast('Light at least one destination first', true);
    const p = S.presets.find((x) => x.number === n);
    const f = $('#formSave');
    $('#saveTitle').textContent = exists ? `Overwrite preset ${n}?` : `Save preset ${n}`;
    $('#saveDests').innerHTML = `Destinations: <b>${S.selection.map((d) => `${d} ${esc(label(d))}`).join(', ')}</b>`;
    f.elements.number.value = n; f.elements.name.value = p ? p.name : `Preset ${n}`;
    slotInputs($('#saveSlots'), S.selection, null);
    $('#dlgSave').showModal();
    // Pre-fill slots with what the device reports on Preview (AWJ readback), if enabled.
    api('POST', '/api/capture', { destinations: S.selection }).then((c) => {
      for (const [d, v] of Object.entries(c.memories || {})) { const i = f.elements[`slot_${d}`]; if (i && !i.value) i.value = v; }
    }).catch(() => {});
  }
  $('#dlgSave').addEventListener('close', () => {
    if ($('#dlgSave').returnValue !== 'save') return;
    const f = $('#formSave');
    run(api('POST', '/api/presets', { number: Number(f.elements.number.value), name: f.elements.name.value, destinations: S.selection, memories: readSlots(f, S.selection) }).then((p) => toast(`Saved ${p.number} · ${p.name}`)));
  });

  // ---------- edit ----------
  async function openEdit(n) {
    const p = await api('GET', `/api/presets/${n}`).catch((e) => toast(e.message, true)); if (!p) return;
    editing = p;
    const f = $('#formEdit');
    $('#editTitle').textContent = `Preset ${p.number}`;
    f.elements.number.value = p.number; f.elements.name.value = p.name;
    slotInputs($('#editSlots'), p.destinations, p.memories);
    $('#dlgEdit').showModal();
  }
  $('#dlgEdit').addEventListener('close', () => {
    if ($('#dlgEdit').returnValue !== 'save' || !editing) return;
    const f = $('#formEdit');
    run(api('PUT', `/api/presets/${editing.number}`, { name: f.elements.name.value, newNumber: Number(f.elements.number.value), memories: readSlots(f, editing.destinations) }).then(() => toast('Saved')));
  });
  $('#formEdit').querySelector('.btn-grid').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b || !editing) return;
    const n = editing.number; const act = b.dataset.act;
    if (act === 'delete' && !confirm(`Delete preset ${n} "${editing.name}"?`)) return;
    if (act === 'overwrite' && !confirm(`Overwrite preset ${n} with the current selection (${S.selection.join(', ') || 'none'})?`)) return;
    const p = act === 'update' ? api('POST', `/api/presets/${n}/update`, {})
      : act === 'overwrite' ? api('POST', `/api/presets/${n}/update`, { useSelection: true })
      : act === 'duplicate' ? api('POST', `/api/presets/${n}/duplicate`, {})
      : api('DELETE', `/api/presets/${n}`);
    $('#dlgEdit').close('cancel');
    run(p.then((r) => toast(act === 'duplicate' ? `Duplicated to ${r.number}` : `${act[0].toUpperCase() + act.slice(1)} done`)));
  });

  // ---------- settings ----------
  async function openSettings() {
    const s = await api('GET', '/api/settings');
    const f = $('#formSettings');
    for (const k of ['host', 'restPort', 'awjPort', 'protocol', 'maxScreens', 'maxAux', 'maxLayers']) f.elements[k].value = s[k];
    for (const k of ['https', 'awjReadback', 'presetToggle']) f.elements[k].checked = !!s[k];
    f.elements.password.value = ''; f.elements.password.placeholder = s.passwordSet ? '•••••• (unchanged)' : 'none'; f.elements.clearPassword.checked = false;
    $('#mockNote').hidden = !s.mock;
    $('#dlgSettings').showModal();
  }
  $('#btnSettings').addEventListener('click', () => run(openSettings()));
  $('#dlgSettings').addEventListener('close', () => {
    if ($('#dlgSettings').returnValue !== 'save') return;
    const f = $('#formSettings'); const b = {};
    for (const k of ['host', 'protocol']) b[k] = f.elements[k].value.trim();
    for (const k of ['restPort', 'awjPort', 'maxScreens', 'maxAux', 'maxLayers']) b[k] = Number(f.elements[k].value);
    for (const k of ['https', 'awjReadback', 'presetToggle']) b[k] = f.elements[k].checked;
    if (f.elements.clearPassword.checked) b.password = ''; else if (f.elements.password.value) b.password = f.elements.password.value;
    run(api('POST', '/api/settings', b).then((st) => toast(st.connected ? 'Connected' : 'Saved, but not connected', !st.connected)));
  });
  if (location.pathname === '/settings') run(openSettings());

  api('GET', '/api/log').then((l) => l.forEach(addLog)).catch(() => {});
  connectEvents();
})();
