// Hi-res cue stack. RS6, E2 and PixelHue only. The PRESETS tab.
(function () {
  'use strict';
  const list = document.getElementById('cueList');
  const editor = document.getElementById('cueEditor');
  if (!list || !editor) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));
  const SYSTEMS = [['rs6', 'RS6'], ['e2', 'E2'], ['pixelhue', 'PIXELHUE']];
  let book = { cues: [], index: 0, catalog: { rs6: [], e2: [], pixelhue: [] }, firing: null };
  let selected = 0;

  const cue = () => book.cues[selected] || null;

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || r.statusText);
    return j;
  }

  function options(system, current) {
    const rows = (book.catalog && book.catalog[system]) || [];
    const opts = rows.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('');
    const extra = current && !rows.some((p) => String(p.id) === String(current)) ? `<option value="${esc(current)}">${esc(current)}</option>` : '';
    return extra + opts;
  }

  function bailNote(system, preset) {
    const row = ((book.catalog && book.catalog[system]) || []).find((p) => String(p.id) === String(preset));
    if (!row || row.bail == null || row.bail === '' || row.bail === 0) return '';
    return `This preset already bails to ${row.bail} after TAKE on its own page.`;
  }

  function paintList() {
    list.innerHTML = book.cues.map((c, i) => `<button type="button" class="cue-row ${i === selected ? 'on' : ''}" data-i="${i}">
      <b>${i + 1}</b><span>${esc(c.name || 'Cue')}</span><small>${c.advance === 'auto' ? 'AUTO' : 'GO'} · ${c.steps.length}</small>
    </button>`).join('') || '<div class="note">No cues yet.</div>';
    const st = document.getElementById('cueStatus');
    if (st) {
      const firing = book.firing ? ` Firing ${book.firing.cue}, step ${book.firing.step}.` : '';
      st.textContent = `Cue ${book.cues.length ? selected + 1 : 0} of ${book.cues.length}.${firing} Operator GO is the default. Auto-advance runs the next cue after this one settles.`;
    }
  }

  function paintEditor() {
    const c = cue();
    if (!c) { editor.innerHTML = '<div class="note">Add a cue. Each step recalls one hi-res preset.</div>'; return; }
    const steps = c.steps.map((s, i) => `<div class="cue-step" data-step="${i}">
      <select data-field="system">${SYSTEMS.map(([id, label]) => `<option value="${id}" ${s.system === id ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <select data-field="mode"><option value="absolute" ${s.mode !== 'relative' ? 'selected' : ''}>ABSOLUTE</option><option value="relative" ${s.mode === 'relative' ? 'selected' : ''}>RELATIVE</option></select>
      ${s.mode === 'relative' ? `<input data-field="preset" value="${esc(s.preset)}" placeholder="+1" aria-label="Offset">` : `<select data-field="preset">${options(s.system, s.preset)}</select>`}
      <label>LAG <input data-field="lagMs" type="number" min="0" step="10" value="${s.lagMs || 0}"></label>
      <label>AT <input data-field="atMs" type="number" min="0" step="10" value="${s.atMs || 0}"></label>
      <button type="button" class="btn mini ghost" data-delstep="${i}">✕</button>
    </div>`).join('');
    const bail = c.bail || { system: 'rs6', preset: '' };
    editor.innerHTML = `<div class="cue-head">
      <input id="cueName" value="${esc(c.name)}" aria-label="Cue name">
      <select id="cueAdvance"><option value="go" ${c.advance !== 'auto' ? 'selected' : ''}>OPERATOR GO</option><option value="auto" ${c.advance === 'auto' ? 'selected' : ''}>AUTO-ADVANCE</option></select>
      <button type="button" class="btn mini" id="cueSave">SAVE</button>
      <button type="button" class="btn mini ghost" id="cueDup">DUPLICATE</button>
      <button type="button" class="btn mini danger" id="cueDel">DELETE</button>
    </div>
    <div class="cue-steps">${steps || '<div class="note small">No steps.</div>'}</div>
    <button type="button" class="btn mini" id="cueAddStep">ADD STEP</button>
    <div class="cue-bail">
      <span>BAIL TO</span>
      <select id="cueBailSys">${SYSTEMS.map(([id, label]) => `<option value="${id}" ${bail.system === id ? 'selected' : ''}>${label}</option>`).join('')}<option value="" ${c.bail ? '' : 'selected'}>NONE</option></select>
      <input id="cueBailPreset" value="${esc(bail.preset || '')}" placeholder="preset">
      <small>${esc(bailNote(c.steps[0] && c.steps[0].system, c.steps[0] && c.steps[0].preset))}</small>
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
      const val = (field) => row.querySelector(`[data-field="${field}"]`).value;
      return { ...c.steps[i], system: val('system'), mode: val('mode'), preset: val('preset'), lagMs: Number(val('lagMs')) || 0, atMs: Number(val('atMs')) || 0 };
    });
    const bailSys = document.getElementById('cueBailSys').value;
    const bailPreset = document.getElementById('cueBailPreset').value.trim();
    return {
      ...c,
      name: document.getElementById('cueName').value.trim() || c.name,
      advance: document.getElementById('cueAdvance').value,
      steps,
      bail: bailSys && bailPreset ? { system: bailSys, preset: bailPreset } : null,
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
    api('POST', '/api/cues/select', { index: selected }).then((j) => { book = { ...book, ...j }; paint(); }).catch(() => paint());
  });

  editor.addEventListener('click', async (ev) => {
    const c = cue();
    if (!c) return;
    if (ev.target.id === 'cueSave') { await persist(); return; }
    if (ev.target.id === 'cueAddStep') {
      c.steps.push({ system: 'rs6', preset: '1', mode: 'absolute', lagMs: 0, atMs: 0 });
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
  });

  document.getElementById('cueAdd').addEventListener('click', async () => {
    await api('POST', '/api/cues', { name: `Cue ${book.cues.length + 1}`, steps: [{ system: 'rs6', preset: '1', mode: 'absolute' }], advance: 'go' });
    selected = book.cues.length;
    await load();
  });
  document.getElementById('cueGo').addEventListener('click', async () => {
    await persist().catch(() => {});
    book = await api('POST', '/api/cues/go');
    selected = book.index || 0;
    paint();
  });
  document.getElementById('cueStop').addEventListener('click', async () => { book = await api('POST', '/api/cues/stop'); paint(); });
  document.getElementById('cueBack').addEventListener('click', async () => {
    if (selected <= 0) return;
    selected -= 1;
    book = await api('POST', '/api/cues/select', { index: selected });
    paint();
  });
  document.querySelectorAll('[data-tab="looks"]').forEach((b) => b.addEventListener('click', () => load().catch(() => {})));
  load().catch(() => paint());
})();
