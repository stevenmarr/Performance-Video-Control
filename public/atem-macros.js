// ATEM MACROS tab: operator, editor, and absolute memories.
(function () {
  'use strict';
  const root = document.getElementById('atemDesk');
  if (!root) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));
  let desk = { macros: [], memories: [], catalog: [], switcher: { inputs: [], macros: [], running: null }, recording: null, play: null };
  let mode = localStorage.getItem('cc.atemDeskMode') || 'op';
  let current = 0;
  let simOpen = false;
  let simAt = -1;

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || r.statusText);
    return j;
  }
  const macro = () => desk.macros[current] || null;
  const sourceName = (id) => {
    const row = (desk.switcher.inputs || []).find((i) => i.id === Number(id));
    return row ? row.long : (id == null ? '—' : String(id));
  };

  function setMode(next) {
    mode = next;
    localStorage.setItem('cc.atemDeskMode', mode);
    document.querySelectorAll('#atemDeskMode [data-admode]').forEach((b) => b.classList.toggle('on', b.dataset.admode === mode));
    paint();
  }

  function operator() {
    const run = desk.switcher.running || {};
    const info = document.getElementById('atemDeskInfo');
    if (info) {
      info.textContent = run.isRunning ? `running slot ${Number(run.macroIndex) + 1}${run.isWaiting ? ' · waiting' : ''}` : (desk.play && desk.play.waiting ? 'editor waiting' : 'operator, editor, and absolute memories');
    }
    return `<div class="ad-op">${desk.macros.map((m) => {
      const live = run.isRunning && run.macroIndex === m.index;
      return `<button type="button" class="preset ${live ? 'pvw running' : ''} ${m.index === (macro() && macro().index) ? 'on' : ''}" data-run="${m.index}">
        <span class="num">${m.index + 1}</span><span class="name">${esc(m.name)}</span>
        <span class="chips">${m.used ? '<span class="chip">USED</span>' : '<span class="chip">EMPTY</span>'}${m.steps.length ? `<span class="chip">${m.steps.length} STEPS</span>` : ''}</span>
      </button>`;
    }).join('') || '<div class="note">Sync to read the switcher pool, or add a macro in the editor.</div>'}
    <div class="ad-opbar">
      <button type="button" class="btn mini" id="adLoop">LOOP STEPS</button>
      <button type="button" class="btn mini" id="adPlay">PLAY STEPS</button>
    </div></div>`;
  }

  function editor() {
    const m = macro();
    const list = `<div class="ad-col"><div class="section-title">MACROS</div>
      ${desk.macros.map((row, i) => `<button type="button" class="cue-row ${i === current ? 'on' : ''}" data-pick="${i}"><b>${row.index + 1}</b><span>${esc(row.name)}</span></button>`).join('')}
      <div class="ad-opbar"><button type="button" class="btn mini" id="adAdd">ADD</button><button type="button" class="btn mini" id="adDup">DUPLICATE</button><button type="button" class="btn mini danger" id="adDel">DELETE</button></div>
    </div>`;
    const steps = m ? m.steps.map((s, i) => `<button type="button" class="cue-step ${i === simAt ? 'on' : ''}" data-step="${i}"><b>${i + 1}</b> ${esc(s.op)} ${s.userWait ? 'USER WAIT' : ''}${s.waitFrames ? ` ${s.waitFrames}f` : ''} ${esc(s.args && s.args.source != null ? sourceName(s.args.source) : '')}</button>`).join('') : '';
    const mid = `<div class="ad-col"><div class="section-title">STEPS ${m ? esc(m.name) : ''}</div>
      ${m ? `<input id="adName" value="${esc(m.name)}" aria-label="Macro name">` : ''}
      <div class="cue-steps">${steps || '<div class="note small">No steps. Add one from the inspector, or record.</div>'}</div>
      <div class="ad-opbar">
        <button type="button" class="btn mini" id="adRename">RENAME</button>
        <button type="button" class="btn mini" id="adRecord">RECORD</button>
        <button type="button" class="btn mini" id="adStopRec">STOP RECORD</button>
        <button type="button" class="btn mini" id="adWait">USER WAIT</button>
        <button type="button" class="btn mini" id="adSim">${simOpen ? 'HIDE SIM' : 'SIM'}</button>
        <button type="button" class="btn mini" id="adXmlOut">EXPORT XML</button>
        <button type="button" class="btn mini" id="adCommit">WRITE</button>
      </div>
      ${m && m.opaque ? '<p class="note">This slot is used on the switcher. Its steps cannot be read, so they will not be overwritten.</p>' : ''}
      ${m && m.conflict ? `<p class="note">Switcher says “${esc(m.conflict.switcherName)}”. App says “${esc(m.conflict.appName)}”.</p><div class="ad-opbar"><button type="button" class="btn mini" data-resolve="switcher">KEEP SWITCHER</button><button type="button" class="btn mini" data-resolve="app">KEEP APP</button><button type="button" class="btn mini" data-resolve="merge">MERGE</button></div>` : ''}
      <p class="note small">${esc(desk.protocol || '')} No show lock. Versions: ${(m && m.versions || []).length}.</p>
      ${(m && m.versions || []).slice(-5).map((v) => `<button type="button" class="btn mini ghost" data-restore="${esc(v.at)}">${esc(v.at)} ${esc(v.note || '')}</button>`).join(' ')}
      <textarea id="adXml" class="ad-sim" rows="4" placeholder="Paste a macro XML subset"></textarea>
      <button type="button" class="btn mini" id="adXmlIn">IMPORT XML</button>
      <div id="adSim" class="ad-sim" ${simOpen ? '' : 'hidden'}></div>
    </div>`;
    const groups = {};
    for (const op of desk.catalog || []) (groups[op.group] = groups[op.group] || []).push(op);
    const inputs = (desk.switcher.inputs || []).map((i) => `<option value="${i.id}">${esc(i.long)}</option>`).join('');
    const inspect = `<div class="ad-col"><div class="section-title">INSPECTOR</div>
      ${Object.entries(groups).map(([group, ops]) => `<details open><summary>${esc(group)}</summary>${ops.map((op) => `<button type="button" class="btn mini" data-addop="${op.op}" ${op.disabled ? 'disabled' : ''} title="${esc(op.reason || '')}">${esc(op.label)}</button>`).join(' ')}</details>`).join('')}
      <label class="cue-step">SOURCE <select id="adSource">${inputs || '<option value="1">1</option>'}</select></label>
      <label class="cue-step">M/E <input id="adMe" type="number" min="1" value="1"></label>
    </div>`;
    return `<div class="ad-edit">${list}${mid}${inspect}</div>`;
  }

  function memories() {
    return `<div class="ad-mem"><div class="ad-opbar"><button type="button" class="btn mini primary" id="adCapture">CAPTURE STATE</button></div>
      ${(desk.memories || []).map((m) => `<div class="cue-row"><b>${esc(m.name)}</b><span>${(m.state && m.state.mes || []).length} M/E</span>
        <button type="button" class="btn mini" data-recallmem="${m.id}">RECALL</button>
        <button type="button" class="btn mini ghost" data-delmem="${m.id}">DELETE</button></div>`).join('') || '<div class="note">A memory is the switcher as it is now: program, preview, keys, aux and Super Source. Recall puts those values back. It does not run a macro.</div>'}
    </div>`;
  }

  function paint() {
    root.innerHTML = mode === 'edit' ? editor() : mode === 'mem' ? memories() : operator();
    if (simOpen && mode === 'edit') refreshSim().catch(() => {});
  }

  async function load() {
    try { desk = await api('GET', '/api/atem-desk'); } catch { return; }
    if (current >= desk.macros.length) current = 0;
    paint();
  }

  async function refreshSim() {
    const m = macro();
    const box = document.getElementById('adSim');
    if (!m || !box) return;
    const sim = await api('GET', `/api/atem-desk/sim/${m.index}/${simAt}`);
    box.hidden = false;
    box.innerHTML = (sim.mes || []).map((me) => `<div>M/E ${me.index + 1} PGM ${esc(sourceName(me.program))} · PVW ${esc(sourceName(me.preview))}</div>`).join('') || '<div>No buses yet.</div>';
  }

  document.getElementById('atemDeskMode').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-admode]');
    if (b) setMode(b.dataset.admode);
  });
  document.getElementById('atemDeskSync').addEventListener('click', () => api('POST', '/api/atem-desk/sync').then((j) => { desk = j; paint(); }).catch(() => {}));
  document.getElementById('atemMacroStop').addEventListener('click', async () => {
    await api('POST', '/api/atem-desk/play/stop').catch(() => {});
    await fetch('/api/sys/atem/cmd/macroStop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    await load();
  });
  document.getElementById('atemMacroContinue').addEventListener('click', async () => {
    await api('POST', '/api/atem-desk/play/continue').catch(() => {});
    await fetch('/api/sys/atem/cmd/macroContinue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    await load();
  });

  root.addEventListener('click', async (ev) => {
    const run = ev.target.closest('[data-run]');
    if (run) {
      current = desk.macros.findIndex((m) => m.index === Number(run.dataset.run));
      await fetch('/api/sys/atem/cmd/macroRun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ macro: Number(run.dataset.run) }) });
      await load();
      return;
    }
    const pick = ev.target.closest('[data-pick]');
    if (pick) { current = Number(pick.dataset.pick); simAt = -1; paint(); return; }
    const step = ev.target.closest('[data-step]');
    if (step) { simAt = Number(step.dataset.step); simOpen = true; paint(); return; }
    const addOp = ev.target.closest('[data-addop]');
    if (addOp && macro()) {
      const m = macro();
      const source = Number((document.getElementById('adSource') || {}).value || 1);
      const me = Number((document.getElementById('adMe') || {}).value || 1);
      const op = addOp.dataset.addop;
      const args = {};
      if (['preview', 'program', 'aux', 'ssBox'].includes(op)) args.source = source;
      if (['preview', 'program', 'cut', 'auto', 'uskOnAir'].includes(op)) args.me = me;
      if (op === 'uskOnAir') { args.key = 0; args.on = true; }
      if (op === 'dskOnAir') { args.key = 0; args.on = true; }
      if (op === 'aux') args.aux = 0;
      if (op === 'ssBox') { args.ss = 0; args.box = 0; }
      if (op === 'wait') args.frames = 15;
      if (op === 'mixRate') args.rate = 30;
      m.steps.push({ op, args, waitFrames: op === 'wait' ? 15 : 0, userWait: op === 'userWait' });
      await api('POST', '/api/atem-desk/macros', m);
      await load();
      return;
    }
    if (ev.target.id === 'adAdd') { const row = await api('POST', '/api/atem-desk/macros/add', {}); desk.macros.push(row); current = desk.macros.length - 1; await load(); return; }
    if (ev.target.id === 'adDup' && macro()) { await api('POST', `/api/atem-desk/macros/${macro().index}/duplicate`); await load(); return; }
    if (ev.target.id === 'adDel' && macro()) { await api('DELETE', `/api/atem-desk/macros/${macro().index}`); current = 0; await load(); return; }
    if (ev.target.id === 'adRename' && macro()) {
      const m = macro();
      m.name = document.getElementById('adName').value.trim() || m.name;
      m.dirty = true;
      await api('POST', '/api/atem-desk/macros', m);
      await load();
      return;
    }
    if (ev.target.id === 'adRecord' && macro()) {
      await fetch('/api/sys/atem/cmd/macroRecord', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ macro: macro().index }) });
      await load();
      return;
    }
    if (ev.target.id === 'adStopRec') {
      await fetch('/api/sys/atem/cmd/macroStopRecord', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await load();
      return;
    }
    if (ev.target.id === 'adWait' && macro()) {
      const m = macro();
      m.steps.push({ op: 'userWait', args: {}, userWait: true, waitFrames: 0 });
      await api('POST', '/api/atem-desk/macros', m);
      await fetch('/api/sys/atem/cmd/macroUserWait', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      await load();
      return;
    }
    if (ev.target.id === 'adSim') { simOpen = !simOpen; paint(); return; }
    if (ev.target.id === 'adXmlOut') {
      const pack = await api('GET', '/api/atem-desk/xml');
      const box = document.getElementById('adXml');
      if (box) box.value = pack.xml || '';
      return;
    }
    if (ev.target.id === 'adXmlIn') {
      const box = document.getElementById('adXml');
      await api('POST', '/api/atem-desk/xml', { xml: box ? box.value : '' });
      await load();
      return;
    }
    if (ev.target.id === 'adCommit' && macro()) {
      try { await api('POST', `/api/atem-desk/macros/${macro().index}/commit`); } catch (e) { const info = document.getElementById('atemDeskInfo'); if (info) info.textContent = e.message; }
      await load();
      return;
    }
    const resolve = ev.target.closest('[data-resolve]');
    if (resolve && macro()) { await api('POST', `/api/atem-desk/macros/${macro().index}/resolve`, { choice: resolve.dataset.resolve }); await load(); return; }
    const restore = ev.target.closest('[data-restore]');
    if (restore && macro()) { await api('POST', `/api/atem-desk/macros/${macro().index}/restore`, { at: restore.dataset.restore }); await load(); return; }
    if (ev.target.id === 'adPlay' && macro()) { api('POST', `/api/atem-desk/macros/${macro().index}/play`, {}).then(load).catch(() => {}); return; }
    if (ev.target.id === 'adLoop' && macro()) { api('POST', `/api/atem-desk/macros/${macro().index}/play`, { loop: true }).then(load).catch(() => {}); return; }
    if (ev.target.id === 'adCapture') { await api('POST', '/api/atem-desk/memories', { name: `Memory ${desk.memories.length + 1}` }); await load(); return; }
    const recall = ev.target.closest('[data-recallmem]');
    if (recall) { await api('POST', `/api/atem-desk/memories/${recall.dataset.recallmem}/recall`); await load(); return; }
    const del = ev.target.closest('[data-delmem]');
    if (del) { await api('DELETE', `/api/atem-desk/memories/${del.dataset.delmem}`); await load(); }
  });

  document.querySelectorAll('[data-tab="amacros"]').forEach((b) => b.addEventListener('click', () => load().catch(() => {})));
  setMode(mode);
  load().catch(() => paint());
})();
