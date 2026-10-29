// Hi-res cue stack. One switcher: RS6, E2 or PixelHue. The PRESETS tab.
(function () {
  'use strict';
  const list = document.getElementById('cueList');
  const editor = document.getElementById('cueEditor');
  if (!list || !editor) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));
  const SYSTEMS = [['rs6', 'RS6'], ['e2', 'E2'], ['pixelhue', 'PIXELHUE']];
  let book = { cues: [], index: 0, system: 'rs6', catalog: { rs6: [], e2: [], pixelhue: [] }, firing: null, link: { connected: false, state: 'offline' } };
  let selected = 0;

  const cue = () => book.cues[selected] || null;
  const sys = () => book.system || 'rs6';

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || r.statusText);
    return j;
  }

  function rows() { return (book.catalog && book.catalog[sys()]) || []; }

  function options(current) {
    const listRows = rows();
    const opts = listRows.map((p) => `<option value="${esc(p.id)}" ${String(p.id) === String(current) ? 'selected' : ''}>${esc(p.label || p.name || p.id)}</option>`).join('');
    const extra = current && !listRows.some((p) => String(p.id) === String(current)) ? `<option value="${esc(current)}" selected>${esc(current)}</option>` : '';
    return extra + opts;
  }

  function presetField(current, invalid) {
    const connected = book.link && book.link.connected;
    if (!connected && !rows().length) return '<span class="note">No switcher connected.</span>';
    return `<select data-field="preset" class="${invalid ? 'bad' : ''}">${options(current)}</select>`;
  }

  function paintList() {
    list.innerHTML = book.cues.map((c, i) => `<button type="button" class="cue-row ${i === selected ? 'on' : ''} ${c.invalid ? 'bad' : ''}" data-i="${i}">
      <b>${i + 1}</b><span>${esc(c.name || 'Cue')}</span><small>${c.invalid ? 'INVALID' : (c.advance === 'auto' ? 'AUTO' : 'GO')} · ${c.steps.length}</small>
    </button>`).join('') || '<div class="note">No cues yet. Choose the switcher, then add a cue.</div>';
    const st = document.getElementById('cueStatus');
    if (st) {
      const link = book.link || {};
      const firing = book.firing ? ` Firing ${book.firing.cue}, step ${book.firing.step}.` : '';
      const state = link.state || (link.connected ? 'connected' : 'offline');
      st.textContent = `${(sys() || '').toUpperCase()} ${state}${link.simulator ? ' · simulator' : ''}.${firing} GO loads preview. TAKE is yours. Relative changes only the layers stored in that preset.`;
    }
    const go = document.getElementById('cueGo');
    if (go) go.disabled = !!(cue() && cue().invalid);
  }

  function paintEditor() {
    const c = cue();
    const link = book.link || {};
    const head = `<div class="cue-link">
      <label>SWITCHER <select id="cueSystem">${SYSTEMS.map(([id, label]) => `<option value="${id}" ${sys() === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <span class="pill ${link.connected ? 'ok' : 'off'}">${esc(link.state || 'offline')}</span>
      <button type="button" class="btn mini" id="cueConnect">${link.connected ? 'RECONNECT' : 'CONNECT'}</button>
      ${sys() === 'rs6' ? '<span class="note">RS6 has no simulator.</span>' : `<button type="button" class="btn mini" id="cueSim">${link.simulator ? 'SIMULATOR ON' : 'USE SIMULATOR'}</button>`}
    </div>`;
    if (!c) { editor.innerHTML = head + '<div class="note">Add a cue. Presets come from this switcher only. ATEM is not on this page.</div>'; return; }
    const steps = c.steps.map((s, i) => `<div class="cue-step ${s.invalid ? 'bad' : ''}" data-step="${i}">
      <select data-field="mode"><option value="absolute" ${s.mode !== 'relative' ? 'selected' : ''}>ABSOLUTE</option><option value="relative" ${s.mode === 'relative' ? 'selected' : ''}>RELATIVE</option></select>
      ${presetField(s.preset, s.invalid)}
      <label>LAG <input data-field="lagMs" type="number" min="0" step="100" value="${s.lagMs || 0}"></label>
      <label>AT <input data-field="atMs" type="number" min="0" step="100" value="${s.atMs || 0}"></label>
      <button type="button" class="btn mini ghost" data-delstep="${i}">✕</button>
      ${s.invalid ? '<span class="note">Missing on the switcher.</span>' : ''}
    </div>`).join('');
    const follow = c.followUp || { preset: '', delayMs: 1000, mode: 'absolute' };
    const bail = c.bail || { preset: '' };
    editor.innerHTML = `${head}<div class="cue-head">
      <input id="cueName" value="${esc(c.name)}" aria-label="Cue name">
      <select id="cueAdvance"><option value="go" ${c.advance !== 'auto' ? 'selected' : ''}>OPERATOR GO</option><option value="auto" ${c.advance === 'auto' ? 'selected' : ''}>AUTO-ADVANCE</option></select>
      <button type="button" class="btn mini" id="cueSave">SAVE</button>
      <button type="button" class="btn mini ghost" id="cueDup">DUPLICATE</button>
      <button type="button" class="btn mini danger" id="cueDel">DELETE</button>
    </div>
    <p class="note small">Absolute loads the whole look to preview. Relative writes only the layers stored in that preset and leaves every other layer alone. It does not step to the next number. E2 and PixelHue recall that preset's own destinations.</p>
    <div class="cue-steps">${steps || '<div class="note small">No steps.</div>'}</div>
    <button type="button" class="btn mini" id="cueAddStep">ADD STEP</button>
    <div class="cue-bail">
      <span>FOLLOW-UP</span>
      ${rows().length || (book.link && book.link.connected) ? `<select id="cueFollow">${options(follow.preset)}<option value="" ${follow.preset ? '' : 'selected'}>NONE</option></select>` : '<span class="note">No switcher connected.</span>'}
      <label>DELAY <input id="cueFollowDelay" type="number" min="0" step="100" value="${follow.delayMs || 0}"> ms</label>
    </div>
    <div class="cue-bail">
      <span>BAIL</span>
      ${rows().length || (book.link && book.link.connected) ? `<select id="cueBailPreset">${options(bail.preset)}<option value="" ${c.bail ? '' : 'selected'}>NONE</option></select>` : '<span class="note">No switcher connected.</span>'}
      <small>After this look is taken to program, bail loads into preview and is not taken. It replaces the switcher-page bail for that take.</small>
    </div>`;
  }

  function paint() { paintList(); paintEditor(); }

  async function load() {
    book = await api('GET', '/api/cues');
    if (selected >= book.cues.length) selected = Math.max(0, book.cues.length - 1);
    paint();
  }

  function draft() {
    const c = cue();
    if (!c) return null;
    const steps = [...editor.querySelectorAll('.cue-step')].map((row, i) => {
      const field = row.querySelector('[data-field="preset"]');
      const mode = row.querySelector('[data-field="mode"]');
      return { ...c.steps[i], system: sys(), mode: mode ? mode.value : 'absolute', preset: field ? field.value : c.steps[i].preset, lagMs: Number(row.querySelector('[data-field="lagMs"]').value) || 0, atMs: Number(row.querySelector('[data-field="atMs"]').value) || 0 };
    });
    const followEl = document.getElementById('cueFollow');
    const followPreset = followEl ? followEl.value.trim() : '';
    const bailEl = document.getElementById('cueBailPreset');
    const bailPreset = bailEl ? bailEl.value.trim() : '';
    return {
      ...c,
      name: document.getElementById('cueName').value.trim() || c.name,
      advance: document.getElementById('cueAdvance').value,
      steps,
      followUp: followPreset ? { preset: followPreset, delayMs: Number(document.getElementById('cueFollowDelay').value) || 0, mode: 'absolute' } : null,
      bail: bailPreset ? { system: sys(), preset: bailPreset } : null,
    };
  }

  async function persist() {
    const body = draft();
    if (!body) return;
    await api('POST', '/api/cues', body);
    await load();
  }

  list.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-i]');
    if (!row) return;
    selected = Number(row.dataset.i);
    api('POST', '/api/cues/select', { index: selected }).then((j) => { book = { ...book, ...j, catalog: book.catalog }; paint(); }).catch(() => paint());
  });

  editor.addEventListener('click', async (ev) => {
    try {
      if (ev.target.id === 'cueSystem') return;
      if (ev.target.id === 'cueConnect') {
        const st = document.getElementById('cueStatus');
        if (st) st.textContent = `${sys().toUpperCase()} connecting.`;
        if (sys() === 'rs6') await api('POST', '/api/connect');
        else await api('POST', `/api/sys/${sys()}/connect`);
        await load();
        return;
      }
      if (ev.target.id === 'cueSim') {
        if (sys() === 'rs6') return;
        await api('POST', `/api/sys/${sys()}/simulate`);
        await api('POST', `/api/sys/${sys()}/connect`).catch(() => {});
        await load();
        return;
      }
      const c = cue();
      if (!c) return;
      if (ev.target.id === 'cueSave') { await persist(); return; }
      if (ev.target.id === 'cueAddStep') {
        const first = rows()[0];
        c.steps.push({ system: sys(), preset: first ? String(first.id) : '1', mode: 'absolute', lagMs: 0, atMs: 0 });
        await api('POST', '/api/cues', { ...c });
        await load();
        return;
      }
      if (ev.target.id === 'cueDel') { await api('DELETE', `/api/cues/${encodeURIComponent(c.id)}`); await load(); return; }
      if (ev.target.id === 'cueDup') {
        const copy = { ...c, id: '', name: `${c.name} copy`, steps: c.steps.map((s) => ({ ...s, id: '' })) };
        await api('POST', '/api/cues', copy);
        selected = book.cues.length;
        await load();
        return;
      }
      const del = ev.target.closest('[data-delstep]');
      if (del) {
        c.steps.splice(Number(del.dataset.delstep), 1);
        await api('POST', '/api/cues', c);
        await load();
      }
    } catch (e) { const st = document.getElementById('cueStatus'); if (st) st.textContent = e.message; }
  });

  editor.addEventListener('change', (ev) => {
    if (ev.target.id !== 'cueSystem') return;
    api('POST', '/api/cues/system', { system: ev.target.value }).then((j) => { book = { ...book, ...j, catalog: book.catalog }; paint(); }).catch((e) => { const st = document.getElementById('cueStatus'); if (st) st.textContent = e.message; });
  });

  document.getElementById('cueAdd').addEventListener('click', async () => {
    const first = rows()[0];
    await api('POST', '/api/cues', { name: `Cue ${book.cues.length + 1}`, steps: [{ system: sys(), preset: first ? String(first.id) : '1', mode: 'absolute' }], advance: 'go' });
    selected = book.cues.length;
    await load();
  });
  document.getElementById('cueGo').addEventListener('click', async () => {
    try {
      await persist().catch(() => {});
      book = await api('POST', '/api/cues/go');
      selected = book.index || 0;
      paint();
    } catch (e) { const st = document.getElementById('cueStatus'); if (st) st.textContent = e.message; }
  });
  document.getElementById('cueStop').addEventListener('click', async () => { book = await api('POST', '/api/cues/stop'); paint(); });
  document.getElementById('cueBack').addEventListener('click', async () => {
    book = await api('POST', '/api/cues/back');
    selected = book.index || 0;
    paint();
  });
  document.querySelectorAll('[data-tab="looks"]').forEach((b) => b.addEventListener('click', () => load().catch(() => {})));
  load().catch(() => paint());
})();
