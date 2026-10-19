'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let S = null; let mode = 'recall'; let editing = null; let tab = 'presets';
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
    const lv = S.live || {}; const lm = lv.lastMaster || {};
    const mref = (r) => (r ? `${r.id}${r.label ? ' ' + esc(r.label) : ''}` : '—');
    $('#master').innerHTML = lv.hasMemoryInfo ? `MASTER PGM <b>${mref(lm.program)}</b> · PVW <b>${mref(lm.preview)}</b>` : '';
    const lmEl = $('#liveMode');
    const modeTxt = { push: 'LIVE · PUSH', 'poll-awj': 'LIVE · AWJ POLL', 'poll-rest': 'LIVE · REST POLL', off: 'LIVE OFF' }[lv.mode || 'off'];
    lmEl.className = 'pill ' + (lv.mode === 'push' ? 'live-push' : lv.mode && lv.mode !== 'off' ? 'live-poll' : 'live-off');
    lmEl.textContent = modeTxt; lmEl.title = lv.error || '';

    const row = $('#destRow');
    row.innerHTML = S.destinations.map((d) => `
      <button class="dest ${d.selected ? 'on' : ''}" data-dest="${d.key}">
        <span class="k">${d.kind === 'screen' ? 'SCREEN' : 'AUX'} ${d.id}</span>
        <span class="l">${esc(d.label)}</span>
        <span class="tl">${d.pgmPreset != null ? `<span class="p">PGM ${d.pgmPreset}</span>` : ''}${d.pvwPreset != null ? `<span class="v">PVW ${d.pvwPreset}</span>` : ''}</span>
        ${d.programMemory || d.previewMemory ? `<span class="mem"><span class="p">M${d.programMemory ? d.programMemory.id + ' ' + esc(d.programMemory.label) : '–'}</span> / <span class="v">M${d.previewMemory ? d.previewMemory.id + ' ' + esc(d.previewMemory.label) : '–'}</span></span>` : ''}
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

    renderLive();
    const a = $('#btnAuto'); a.classList.toggle('on', S.autoTake); a.innerHTML = `AUTO TAKE<br><b>${S.autoTake ? 'ON' : 'OFF'}</b>`;
    $('#btnTake').disabled = $('#btnCut').disabled = !S.selection.length;
  }

  function renderLive() {
    const lv = S.live || {};
    if (tab === 'inputs') {
      const ins = (lv.inputs || []).filter((i) => i.isEnabled !== false || i.label);
      $('#inputsGrid').innerHTML = ins.length ? ins.map((i) => {
        const cls = ['inp']; if (i.onProgram) cls.push('pgm'); if (i.onPreview) cls.push('pvw'); if (i.isEnabled === false) cls.push('dis');
        const b = [];
        if (i.onProgram) b.push('<span class="badge red">PGM</span>'); if (i.onPreview) b.push('<span class="badge green">PVW</span>');
        if (i.freeze) b.push('<span class="badge blue">FROZEN</span>');
        if (i.isEnabled === false) b.push('<span class="badge warn">DISABLED</span>'); else if (i.isAvailable === false) b.push('<span class="badge warn">NO SIGNAL</span>');
        if (i.backup && i.backup.active) b.push(`<span class="badge warn">BKP ${esc(i.backup.selected)}</span>`);
        if (i.capability) b.push(`<span class="badge">${esc(i.capability)}</span>`);
        const where = [i.programOn.length ? 'PGM ' + i.programOn.join(',') : '', i.previewOn.length ? 'PVW ' + i.previewOn.join(',') : ''].filter(Boolean).join(' · ');
        return `<div class="${cls.join(' ')}"><span class="num">IN ${i.number}</span><span class="name">${esc(i.label || 'Input ' + i.number)}</span><span class="badges">${b.join('')}</span><span class="where">${where}</span>
          <button class="frz ${i.freeze ? 'on' : ''}" data-freeze="${i.number}">${i.freeze ? 'UNFREEZE' : 'FREEZE'}</button></div>`;
      }).join('') : '<div class="empty-note">No input data (live state needs the device connection).</div>';
    }
    if (tab === 'backup') {
      const bk = lv.backup || { inputs: [], backgrounds: [], groups: [] };
      const segs = (kind, id, sel) => ['NONE', '1', '2'].map((sl) => `<button class="seg bk ${String(sel) === sl ? 'on' : ''}" data-bk="${kind}" data-id="${id}" data-slot="${sl}">${sl === 'NONE' ? 'PRIMARY' : 'BACKUP ' + sl}</button>`).join('');
      const auto = (kind, id, on) => `<button class="seg ${on ? 'on' : ''}" data-bkmode="${kind}" data-id="${id}" data-auto="${on ? 0 : 1}">AUTO ${on ? 'ON' : 'OFF'}</button>`;
      $('#bkInputs').innerHTML = bk.inputs.length ? bk.inputs.map((i) => `<div class="row"><span class="lbl">IN ${i.number} ${esc(i.label)}<small>B1: ${esc(i.slots[1] || 'NONE')} · B2: ${esc(i.slots[2] || 'NONE')}</small></span>${segs('input', i.number, i.selected)}${auto('input', i.number, i.auto)}</div>`).join('') : '<div class="empty-note">No input backups configured.</div>';
      const bgs = bk.backgrounds.filter((b) => b.active || b.auto || Object.values(b.slots || {}).some((x) => x && x !== 'NONE'));
      $('#bkBg').innerHTML = bgs.length ? bgs.map((b) => `<div class="row"><span class="lbl">${b.screen} · Background set ${b.set}<small>B1: ${esc(b.slots[1] || 'NONE')} · B2: ${esc(b.slots[2] || 'NONE')}</small></span>${segs('bg', b.screen + '/' + b.set, b.selected)}${auto('bg', b.screen + '/' + b.set, b.auto)}</div>`).join('') : '<div class="empty-note">No background set backups configured.</div>';
      $('#bkGroups').innerHTML = bk.groups.length ? bk.groups.map((g) => `<div class="row"><span class="lbl">Group ${g.group}<small>${g.active ? 'backup ' + g.selected + ' active' : 'primary'}</small></span>${segs('group', g.group, g.selected)}${auto('group', g.group, g.auto)}</div>`).join('') : '<div class="empty-note">No backup groups found.</div>';
    }
    if (tab === 'audio') {
      const au = lv.audio || { inputs: [], outputs: [] };
      const row = (dir, idKey, x) => `<div class="row"><span class="lbl">${dir === 'inputs' ? 'Input' : 'Output'} ${x[idKey]}</span>${x.channels.map((c) => `<button class="ch ${c.mute ? 'muted' : ''}" data-audio="${dir}" data-id="${x[idKey]}" data-ch="${c.channel}">${c.channel}${c.mute ? '<br>M' : ''}</button>`).join('')}</div>`;
      $('#audioIn').innerHTML = au.inputs.length ? au.inputs.map((x) => row('inputs', 'input', x)).join('') : '<div class="empty-note">No audio input channels found.</div>';
      $('#audioOut').innerHTML = au.outputs.length ? au.outputs.map((x) => row('outputs', 'output', x)).join('') : '<div class="empty-note">No audio output channels found.</div>';
    }
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

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    for (const t of ['presets', 'inputs', 'backup', 'audio']) $(`#pane-${t}`).hidden = t !== tab;
    render();
  }));
  $('.main').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.freeze) return run(api('POST', `/api/inputs/${b.dataset.freeze}/freeze`, {}));
    if (b.dataset.audio) return run(api('POST', `/api/audio/${b.dataset.audio}/${b.dataset.id}/channels/${b.dataset.ch}/mute`, {}));
    const base = { input: (id) => `/api/inputs/${id}/backup`, bg: (id) => `/api/backgrounds/${id}/backup`, group: (id) => `/api/groups/${id}/backup` };
    if (b.dataset.bk) return run(api('POST', base[b.dataset.bk](b.dataset.id), { slot: b.dataset.slot }));
    if (b.dataset.bkmode) return run(api('POST', base[b.dataset.bkmode](b.dataset.id) + '/mode', { auto: b.dataset.auto === '1' }));
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
    const dv = (k) => S.destinations.find((x) => x.key === k) || {};
    container.innerHTML = dests.map((d) => {
      const pv = dv(d).previewMemory;
      return `<label>${d} · ${esc(label(d))}${pv ? ` <small>(PVW now: ${pv.id} ${esc(pv.label)})</small>` : ''}<input type="number" min="1" max="1000" list="memList" name="slot_${d}" placeholder="auto / sources" value="${memories && memories[d] ? memories[d] : ''}"></label>`;
    }).join('');
    loadMemList();
  }
  async function loadMemList() {
    try {
      const m = await api('GET', '/api/memories');
      $('#memList').innerHTML = Object.entries(m.screen || {}).map(([n, l]) => `<option value="${n}">${n} · ${esc(l)}</option>`).join('');
    } catch { /* no live data */ }
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
    for (const k of ['host', 'restPort', 'awjPort', 'protocol', 'maxScreens', 'maxAux', 'maxLayers', 'pollMs', 'maxInputs', 'screenMemoryLabels']) f.elements[k].value = s[k];
    for (const k of ['https', 'awjReadback', 'presetToggle', 'liveEnabled']) f.elements[k].checked = !!s[k];
    f.elements.password.value = ''; f.elements.password.placeholder = s.passwordSet ? '•••••• (unchanged)' : 'none'; f.elements.clearPassword.checked = false;
    $('#mockNote').hidden = !s.mock;
    $('#dlgSettings').showModal();
  }
  $('#btnSettings').addEventListener('click', () => run(openSettings()));
  $('#dlgSettings').addEventListener('close', () => {
    if ($('#dlgSettings').returnValue !== 'save') return;
    const f = $('#formSettings'); const b = {};
    for (const k of ['host', 'protocol']) b[k] = f.elements[k].value.trim();
    for (const k of ['restPort', 'awjPort', 'maxScreens', 'maxAux', 'maxLayers', 'pollMs', 'maxInputs', 'screenMemoryLabels']) b[k] = Number(f.elements[k].value);
    for (const k of ['https', 'awjReadback', 'presetToggle', 'liveEnabled']) b[k] = f.elements[k].checked;
    if (f.elements.clearPassword.checked) b.password = ''; else if (f.elements.password.value) b.password = f.elements.password.value;
    run(api('POST', '/api/settings', b).then((st) => toast(st.connected ? 'Connected' : 'Saved, but not connected', !st.connected)));
  });
  if (location.pathname === '/settings') run(openSettings());

  api('GET', '/api/log').then((l) => l.forEach(addLog)).catch(() => {});
  connectEvents();
})();
