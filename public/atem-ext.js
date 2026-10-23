'use strict';
// 0.10.0 Blackmagic ATEM: ROUTER (every routable output with its live source; tap one for a dialog of the sources it
// takes), AUDIO (classic and Fairlight mixer strips, master, monitor / headphones, Fairlight audio routing incl. MADI),
// DVE / SS / KEYS (upstream keys per M/E, downstream keys, SuperSource boxes with a 16:9 preview and layouts) and the
// simulator model picker. State comes from public/sys.js (window.CCSYS); actions are POST /api/sys/atem/cmd/<name>.
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  let V = null; let tab = '';
  const cmd = (name, body = {}) => run(api('POST', `/api/sys/atem/cmd/${name}`, body));
  const live = () => V && V.kind === 'atem' && V.status && V.status.connected;
  const src = (id) => (V.sources || []).find((x) => x.id === id);
  const sname = (id) => { const x = src(id); return x ? x.long : id === undefined || id === null ? '—' : String(id); };
  const sshort = (id) => { const x = src(id); return x ? x.short : '—'; };
  // 0.11.0 long names first; .nm-s (the short name) only shows where the layout is too narrow (style.css)
  const nmH = (long, short) => `<span class="nm-l">${esc(long || short || '—')}</span><span class="nm-s">${esc(short || long || '—')}</span>`;
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const KIND_LABEL = { input: 'INPUTS', direct: 'DIRECT', internal: 'BLACK / BARS / COLOR', media: 'MEDIA', supersource: 'SUPERSOURCE', cleanfeed: 'CLEAN FEED', me: 'M/E OUT', aux: 'AUX', mv: 'MULTIVIEW', mask: 'KEY MASKS', other: 'OTHER' };
  const off = (msg) => `<div class="note">${msg || 'Not connected · put an ATEM (or its simulator) on the desk on ⌂ SYSTEMS.'}</div>`;
  // re-render a pane only when no control in it is being used (a slider being dragged, a number being typed)
  let holding = false;
  document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('#pane-aaudio input, #pane-akeys input')) holding = true; }, true);
  document.addEventListener('pointerup', () => { if (holding) { holding = false; setTimeout(render, 30); } }, true);
  const busy = (pane) => { const a = document.activeElement; return holding || (a && pane.contains(a) && /INPUT|SELECT/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'range'); };

  // ---------- model picker ----------
  let models = null; let pick = null;
  async function pickModel() {
    try { models = await api('GET', '/api/sys/atem/models'); } catch (e) { return toast(e.message, true); }
    pick = models.simulator || ls('cc.atemModel', models.default);
    renderModels(); $('#dlgAtemModel').showModal();
  }
  function renderModels() {
    const fam = {}; for (const m of models.models) (fam[m.family] = fam[m.family] || []).push(m);
    $('#amList').innerHTML = Object.entries(fam).map(([f, list]) => `<div class="am-fam"><div class="modes-lbl">${esc(f.toUpperCase())}</div><div class="am-grid">${list.map((m) => `
      <button type="button" class="am-card ${m.key === pick ? 'active' : ''}" data-model="${m.key}"><b>${esc(m.name.replace(/^ATEM /, ''))}</b>
      <span>${m.mes} M/E · ${m.inputs} in · ${m.keyers} USK · ${m.dsk} DSK · ${m.dve} DVE${m.superSources ? ` · ${m.superSources} SS` : ''}</span>
      <span>${m.aux} aux · ${m.multiviewers} MV · ${m.mediaPlayers} MP · <em class="${m.audio}">${m.audio === 'fairlight' ? 'Fairlight' : 'classic'} ${m.audioInputs}${m.madi ? ' + MADI' : ''}</em></span>
      ${models.simulator === m.key ? '<span class="chip">RUNNING</span>' : ''}</button>`).join('')}</div></div>`).join('');
    const p = models.models.find((m) => m.key === pick);
    $('#amNotes').innerHTML = p && p.notes.length ? `<b>${esc(p.name)} — spec notes</b><ul>${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  }
  $('#amList').addEventListener('click', (e) => { const b = e.target.closest('[data-model]'); if (!b) return; pick = b.dataset.model; renderModels(); });
  $('#amList').addEventListener('dblclick', (e) => { if (e.target.closest('[data-model]')) $('#amStart').click(); });
  $('#amStart').addEventListener('click', () => {
    save('cc.atemModel', pick); $('#dlgAtemModel').close();
    run(api('POST', '/api/sys/atem/simulate', { model: pick }).then(() => { toast(`ATEM simulator: ${(models.models.find((m) => m.key === pick) || {}).name}`); S.refetch(); }).catch((e) => toast(e.message, true)));
  });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-simmodel]')) pickModel(); });

  // ---------- ROUTER ----------
  let arGroup = ls('cc.arGroup', 'all'); let dlgOut = null; let arKind = 'all'; let arQ = '';
  const accepts = (o) => (x) => (o.accepts === 'aux' ? x.sa & 1 : o.accepts === 'mv' ? x.sa & 2 : o.accepts.startsWith('me:') ? x.ma & (1 << Number(o.accepts.slice(3))) : false);
  function renderRouter() {
    const el = $('#arGroups');
    $('.atem-simmodel').hidden = !(V.connection && (V.connection.simulator || V.connection.mock));
    $('#arPalette').hidden = !live();
    if (!live()) { S.set(el, 'ar', off()); S.set($('#arFilter'), 'arf', ''); return; }
    const outs = V.outputs || [];
    $('#arInfo').textContent = `${V.profile ? V.profile.name : V.product} · ${outs.filter((o) => o.group === 'aux').length} aux / SDI · ${(V.multiviewers || []).length} multiview · drag a source onto an output, or tap an output to pick its source`;
    const groups = [['all', 'ALL'], ['aux', 'AUX / SDI'], ['mv', 'MULTIVIEW']].filter(([g]) => g === 'all' || outs.some((o) => o.group === g));
    if (!groups.some(([g]) => g === arGroup)) arGroup = 'all';
    S.set($('#arFilter'), 'arf', groups.map(([g, l]) => `<button type="button" class="mode ${arGroup === g ? 'active' : ''}" data-argroup="${g}">${l}</button>`).join(''));
    const sec = (title, list) => (list.length ? `<div class="section-title">${title}</div><div class="ar-grid">${list.map((o) => `
      <button type="button" class="ar-out ${o.group} ${o.routable === false ? 'fixed' : ''}" data-out="${esc(o.key)}" title="${esc(o.label)}: ${esc(o.sourceName || '—')}">
        <span class="ar-lbl">${esc(o.label)}</span><b>${nmH(o.sourceName, o.sourceShort)}</b>${o.routable === false ? '<span class="chip">FIXED</span>' : ''}</button>`).join('')}</div>` : '');
    const want = (g) => arGroup === 'all' || arGroup === g;
    let h = '';
    if (want('aux')) h += sec('AUX / SDI OUTPUTS', outs.filter((o) => o.group === 'aux'));
    if (want('mv')) for (const mv of V.multiviewers || []) h += sec(`MULTIVIEW ${(V.multiviewers || []).length > 1 ? mv.index + 1 : ''} <small>${mv.windows.length} windows</small>`, outs.filter((o) => o.group === 'mv' && o.mv === mv.index));
    S.set(el, 'ar', h || off('This ATEM reports no routable outputs.'));
    renderPalette(); markTargets();
    if (dlgOut && $('#dlgAtemRoute').open) renderRouteDialog();
  }
  function renderRouteDialog() {
    const o = (V.outputs || []).find((x) => x.key === dlgOut); if (!o) { $('#dlgAtemRoute').close(); return; }
    $('#arTitle').textContent = `Route to ${o.label}`;
    $('#arNote').innerHTML = `Now: <b>${esc(o.sourceName || '—')}</b>${o.routable === false ? ' · this window is fixed on this model' : ''} · tap a source to route it`;
    const valid0 = (V.sources || []).filter(accepts(o));
    // 0.11.0: media player key signals and key masks only under ADVANCED
    const advList = valid0.filter((x) => x.adv); const valid = valid0.filter((x) => !x.adv);
    const kinds = [...new Set(valid.map((x) => x.kind))];
    if (arKind !== 'all' && !kinds.includes(arKind)) arKind = 'all';
    S.set($('#arKinds'), 'ark', [['all', `ALL ${valid.length}`], ...kinds.map((k) => [k, `${KIND_LABEL[k] || k.toUpperCase()} ${valid.filter((x) => x.kind === k).length}`])]
      .map(([k, l]) => `<button type="button" class="mode ${arKind === k ? 'active' : ''}" data-kind="${k}">${esc(l)}</button>`).join(''));
    const q = arQ.trim().toLowerCase();
    const list = valid.filter((x) => (arKind === 'all' || x.kind === arKind) && (!q || `${x.long} ${x.short} ${x.id}`.toLowerCase().includes(q)));
    const srcBtn = (x) => `<button type="button" class="src ${x.id === o.source ? 'on-aux current' : ''}" data-routesrc="${x.id}" draggable="false" title="${esc(x.long)} · ${esc(x.short)} (${x.id})"><b>${nmH(x.long, x.short)}</b></button>`;
    S.set($('#arSources'), 'ars', list.map(srcBtn).join('') || '<div class="note">No matching source.</div>');
    const advQ = advList.filter((x) => !q || `${x.long} ${x.short} ${x.id}`.toLowerCase().includes(q));
    const ad = $('#arAdv'); ad.hidden = !advList.length; if (ad.open !== arAdvOpen) ad.open = arAdvOpen;
    $('#arAdvSum').textContent = `ADVANCED · ${advList.length} key / mask sources${advList.some((x) => x.id === o.source) ? ' · current source is here' : ''}`;
    S.set($('#arAdvList'), 'arad', advQ.map(srcBtn).join('') || '<div class="note small">No matching source.</div>');
  }
  $('#arFilter').addEventListener('click', (e) => { const b = e.target.closest('[data-argroup]'); if (!b) return; arGroup = b.dataset.argroup; save('cc.arGroup', arGroup); renderRouter(); });
  // 0.11.0 source palette: drag a source (or an output tile, to copy its source) onto an output; or tap a source to arm
  // it and tap outputs to route it (Esc / tap it again to disarm). The click → dialog flow on an output still works.
  let palKind = ls('cc.arPalKind', 'all'); let palAdv = !!ls('cc.arPalAdv', false); let armed = null; let dragSrc = null;
  $('#arPalAdv').checked = palAdv;
  const canRoute = (o, id) => { const x = src(id); return !!(o && x && o.routable !== false && accepts(o)(x)); };
  function renderPalette() {
    const all = (V.sources || []).filter((x) => (x.sa & 3) && (palAdv || !x.adv));
    const kinds = [...new Set(all.map((x) => x.kind))]; if (palKind !== 'all' && !kinds.includes(palKind)) palKind = 'all';
    S.set($('#arPalKinds'), 'arpk', [['all', 'ALL'], ...kinds.map((k) => [k, KIND_LABEL[k] || k.toUpperCase()])].map(([k, l]) => `<button type="button" class="mode mini ${palKind === k ? 'active' : ''}" data-palkind="${k}">${esc(l)}</button>`).join(''));
    const q = ($('#arPalSearch').value || '').trim().toLowerCase();
    const list = all.filter((x) => (palKind === 'all' || x.kind === palKind) && (!q || `${x.long} ${x.short} ${x.id}`.toLowerCase().includes(q)));
    S.set($('#arPalList'), 'arpl', list.map((x) => `<button type="button" class="ar-chip ${x.adv ? 'adv' : ''} ${armed === x.id ? 'armed' : ''}" data-dragsrc="${x.id}" title="${esc(x.long)} · ${esc(x.short)} (${x.id}) · drag onto an output">${nmH(x.long, x.short)}</button>`).join('') || '<div class="note small">No matching source.</div>');
    const ar = $('#arArmed'); ar.hidden = armed === null; if (armed !== null) ar.innerHTML = `<b>${esc(sname(armed))}</b> armed · tap outputs to route it · <button type="button" class="btn mini" data-disarm>DONE</button>`;
  }
  function markTargets() {
    const id = dragSrc !== null ? dragSrc : armed;
    document.querySelectorAll('#arGroups .ar-out[data-out]').forEach((b) => {
      const o = id === null ? null : V.outputs.find((x) => x.key === b.dataset.out);
      b.classList.toggle('drop-ok', id !== null && canRoute(o, id)); b.classList.toggle('drop-no', id !== null && !canRoute(o, id));
    });
  }
  const routeTo = (key, id) => {
    const o = V.outputs.find((x) => x.key === key); if (!canRoute(o, id)) { toast(`${o ? o.label : 'That output'} can't take ${sname(id)}`, true); return; }
    if (o.source === id) return;
    cmd('route', { output: key, source: id }).then(() => toast(`${o.label} ← ${sname(id)}`));
  };
  $('#arPalSearch').addEventListener('input', () => renderPalette());
  $('#arPalAdv').addEventListener('change', () => { palAdv = $('#arPalAdv').checked; save('cc.arPalAdv', palAdv); renderPalette(); });
  $('#arPalette').addEventListener('click', (e) => {
    const k = e.target.closest('[data-palkind]'); if (k) { palKind = k.dataset.palkind; save('cc.arPalKind', palKind); return renderPalette(); }
    if (e.target.closest('[data-disarm]')) { armed = null; renderPalette(); return markTargets(); }
    const c = e.target.closest('[data-dragsrc]'); if (!c) return undefined;
    const id = Number(c.dataset.dragsrc); armed = armed === id ? null : id; renderPalette(); return markTargets();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armed !== null && tab === 'arouter' && !document.querySelector('dialog[open]')) { armed = null; renderPalette(); markTargets(); } });
  const dragOpts = {
    start: (el) => {
      if (!live()) return null;
      if (el.dataset.dragsrc) return Number(el.dataset.dragsrc);
      const o = V.outputs.find((x) => x.key === el.dataset.out); return o && Number.isFinite(o.source) ? o.source : null;
    },
    target: (under) => { const b = under.closest('#arGroups .ar-out[data-out]'); return b && b.classList.contains('drop-ok') ? b : null; },
    drop: (b, id) => routeTo(b.dataset.out, id),
    begin: (id) => { dragSrc = id; markTargets(); },
    end: () => { dragSrc = null; markTargets(); },
    ghost: (el, id) => `→ ${esc(sname(id))}`,
  };
  window.CCDRAG.attach($('#arPalette'), { ...dragOpts, handle: '[data-dragsrc]' });
  window.CCDRAG.attach($('#arGroups'), { ...dragOpts, handle: '.ar-out[data-out]' });
  $('#arGroups').addEventListener('click', (e) => {
    const b = e.target.closest('[data-out]'); if (!b || !live()) return;
    const o = V.outputs.find((x) => x.key === b.dataset.out); if (o && o.routable === false) return toast(`${o.label} is fixed on this model`, true);
    if (armed !== null) return routeTo(o.key, armed);
    dlgOut = b.dataset.out; arKind = 'all'; arQ = ''; $('#arSearch').value = ''; renderRouteDialog(); $('#dlgAtemRoute').showModal(); $('#arSearch').focus();
  });
  $('#arKinds').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (!b) return; arKind = b.dataset.kind; renderRouteDialog(); });
  $('#arSearch').addEventListener('input', () => { arQ = $('#arSearch').value; renderRouteDialog(); });
  $('#arSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const f = $('#arSources [data-routesrc]'); if (f) f.click(); } });
  let arAdvOpen = !!ls('cc.arAdv', false);
  $('#arAdv').addEventListener('toggle', () => { arAdvOpen = $('#arAdv').open; save('cc.arAdv', arAdvOpen); });
  const pickSrc = (e) => {
    const b = e.target.closest('[data-routesrc]'); if (!b || !live()) return;
    const o = V.outputs.find((x) => x.key === dlgOut);
    cmd('route', { output: dlgOut, source: Number(b.dataset.routesrc) }).then(() => { $('#dlgAtemRoute').close(); toast(`${o ? o.label : 'Output'} ← ${sname(Number(b.dataset.routesrc))}`); });
  };
  $('#arSources').addEventListener('click', pickSrc); $('#arAdvList').addEventListener('click', pickSrc);

  // ---------- AUDIO ----------
  let auKind = ls('cc.auKind', 'all');
  const auKindOf = (x) => (x.id < 1000 ? 'video' : x.id >= 1501 && x.id < 1600 ? 'madi' : x.id >= 2001 && x.id < 2100 ? 'media' : 'analog');
  const AU_LABEL = { all: 'ALL', video: 'VIDEO INPUTS', analog: 'ANALOG', madi: 'MADI', media: 'MEDIA PLAYERS' };
  const db = (v) => (v === null || v === undefined ? '—' : !Number.isFinite(v) ? '-∞' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}`);
  const fader = (op, extra, v, min, max) => `<div class="au-fader"><input type="range" min="${min}" max="${max}" step="0.5" value="${Number.isFinite(v) ? v : min}" data-au="${op}" data-field="fader" ${extra} orient="vertical"><output>${db(v)} dB</output></div>`;
  function renderAudio() {
    const pane = $('#pane-aaudio'); if (busy(pane)) return;
    if (!live() || !V.audio) { S.set($('#auStrips'), 'au', off(live() ? 'This ATEM reports no audio mixer.' : '')); S.set($('#auRouting'), 'aur', ''); S.set($('#auFilter'), 'auf', ''); $('#auInfo').textContent = ''; return; }
    const a = V.audio; const fl = a.type === 'fairlight'; const max = fl ? 10 : 6;
    $('#auInfo').innerHTML = `<span class="chip au-type ${a.type}">${fl ? 'FAIRLIGHT' : 'CLASSIC'}</span> ${esc(V.profile ? V.profile.name : V.product)} · ${a.inputs.length} inputs${a.madi && a.madi.inputs ? ` · MADI ${a.madi.inputs} in / ${a.madi.outputs} out` : ''}`;
    const kinds = ['all', ...['video', 'analog', 'madi', 'media'].filter((k) => a.inputs.some((x) => auKindOf(x) === k))];
    if (!kinds.includes(auKind)) auKind = 'all';
    S.set($('#auFilter'), 'auf', kinds.map((k) => `<button type="button" class="mode ${auKind === k ? 'active' : ''}" data-aukind="${k}">${AU_LABEL[k]}</button>`).join(''));
    const strips = a.inputs.filter((x) => auKind === 'all' || auKindOf(x) === auKind).map((x) => `
      <div class="au-strip ${x.muted ? 'muted' : ''} ${x.mix}" data-in="${x.id}">
        <div class="au-name" title="${esc(x.name)} (${x.id})">${esc(x.name)}</div><div class="au-port">${esc(x.port || '')}</div>
        <div class="au-mix">${['on', 'off', 'afv'].filter((m) => x.supported.includes(m)).map((m) => `<button type="button" class="mode ${x.mix === m ? `active m-${m}` : ''}" data-au="mix" data-v="${m}">${m.toUpperCase()}</button>`).join('')}</div>
        ${fader('input', '', x.fader, -60, max)}
        ${fl ? `<label class="au-trim">GAIN <input type="number" step="0.5" min="-100" max="6" value="${Number(x.gain).toFixed(1)}" data-au="input" data-field="gain"> dB</label>` : ''}
        <label class="au-bal">BAL <input type="range" min="-100" max="100" step="5" value="${x.balance}" data-au="input" data-field="balance"><output>${x.balance === 0 ? 'C' : x.balance < 0 ? `L${-x.balance}` : `R${x.balance}`}</output></label>
        <div class="au-btns"><button type="button" class="mode ${x.muted ? 'onair' : ''}" data-au="mute">${x.muted ? 'MUTED' : 'MUTE'}</button><button type="button" class="mode ${x.solo ? 'active' : ''}" data-au="solo" data-v="${x.solo ? 0 : 1}">SOLO</button></div>
      </div>`).join('');
    const m = a.master; const mo = a.monitor;
    const master = `<div class="au-strip master"><div class="au-name">MASTER</div><div class="au-port">PGM</div><div class="au-mix"><button type="button" class="mode ${m.followFadeToBlack ? 'active' : ''}" data-au="ftb" data-v="${m.followFadeToBlack ? 0 : 1}">AFV FTB</button></div>${fader('master', '', m.fader, -60, max)}</div>`;
    const mon = mo ? `<div class="au-strip monitor"><div class="au-name">${fl ? 'MONITOR / PHONES' : 'MONITOR'}</div><div class="au-port">${mo.solo ? `SOLO ${esc((a.inputs.find((i) => i.id === mo.soloSource) || {}).name || '')}` : ''}</div>
      <div class="au-mix"><button type="button" class="mode ${mo.mute ? 'onair' : ''}" data-au="monmute" data-v="${mo.mute ? 0 : 1}">${mo.mute ? 'MUTED' : 'MUTE'}</button>${fl ? '' : `<button type="button" class="mode ${mo.dim ? 'active' : ''}" data-au="mondim" data-v="${mo.dim ? 0 : 1}">DIM</button>`}</div>
      ${fader('monitor', '', mo.gain, -60, 6)}${mo.solo ? '<div class="au-btns"><button type="button" class="mode" data-au="solooff">SOLO OFF</button></div>' : ''}</div>` : '';
    S.set($('#auStrips'), 'au', `<div class="au-scroll">${strips}</div><div class="au-fixed">${master}${mon}</div>`);
    if (!a.routing) { S.set($('#auRouting'), 'aur', fl ? '' : '<div class="note small">Classic audio mixer: no audio routing (inputs follow their video input).</div>'); return; }
    const opts = a.routing.sources.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    const grp = {}; for (const o of a.routing.outputs) { const g = o.madi ? 'MADI OUT' : o.name.replace(/\s+\d+(\/\d+)?$/, '').replace(/\s+\d+$/, '').toUpperCase(); (grp[g] = grp[g] || []).push(o); }
    const openG = new Set(ls('cc.auRoutes', ['MADI OUT']));
    S.set($('#auRouting'), 'aur', `<div class="section-title">AUDIO ROUTING <small>Fairlight · ${a.routing.outputs.length} output channel pairs · ${a.routing.sources.length} sources</small></div>${Object.entries(grp).map(([g, list]) => `
      <details class="au-route" data-rg="${esc(g)}" ${openG.has(g) ? 'open' : ''}><summary>${esc(g)} <small>${list.length}</small></summary><div class="au-rgrid">${list.map((o) => `
        <label class="au-rrow"><span>${esc(o.name)}</span><select data-route="${o.id}">${opts.replace(`value="${o.source}"`, `value="${o.source}" selected`)}</select></label>`).join('')}</div></details>`).join('')}`);
  }
  $('#auFilter').addEventListener('click', (e) => { const b = e.target.closest('[data-aukind]'); if (!b) return; auKind = b.dataset.aukind; save('cc.auKind', auKind); renderAudio(); });
  $('#pane-aaudio').addEventListener('input', (e) => { const t = e.target; if (t.type === 'range' && t.nextElementSibling) { const v = Number(t.value); t.nextElementSibling.textContent = t.dataset.field === 'balance' ? (v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`) : `${db(v)} dB`; } });
  $('#pane-aaudio').addEventListener('change', (e) => {
    const t = e.target; if (!live()) return;
    if (t.dataset.route) { cmd('audioRoute', { output: Number(t.dataset.route), source: Number(t.value) }); return t.blur(); }
    const op = t.dataset.au; if (!op) return; const v = Number(t.value); const st = t.closest('[data-in]'); const id = st ? Number(st.dataset.in) : 0;
    if (op === 'input') cmd('audioInput', { input: id, [t.dataset.field]: v });
    if (op === 'master') cmd('audioMaster', { fader: v });
    if (op === 'monitor') cmd('audioMonitor', { gain: v });
    if (t.type !== 'number') t.blur();
  });
  $('#pane-aaudio').addEventListener('toggle', (e) => { const d = e.target; if (!d.dataset || !d.dataset.rg) return; const s = new Set(ls('cc.auRoutes', ['MADI OUT'])); if (d.open) s.add(d.dataset.rg); else s.delete(d.dataset.rg); save('cc.auRoutes', [...s]); }, true);
  $('#pane-aaudio').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-au]'); if (!b || !live()) return; const strip = b.closest('[data-in]'); const id = strip ? Number(strip.dataset.in) : null; const op = b.dataset.au;
    if (op === 'mix') return cmd('audioInput', { input: id, mix: b.dataset.v });
    if (op === 'mute') return cmd('audioMute', { input: id, mute: 'toggle' });
    if (op === 'solo') return cmd('audioSolo', { input: id, on: b.dataset.v === '1' });
    if (op === 'solooff') return cmd('audioSolo', { on: false });
    if (op === 'ftb') return cmd('audioMaster', { followFadeToBlack: b.dataset.v === '1' });
    if (op === 'monmute') return cmd('audioMonitor', { mute: b.dataset.v === '1' });
    if (op === 'mondim') return cmd('audioMonitor', { dim: b.dataset.v === '1' });
    return undefined;
  });

  // ---------- DVE / SS / KEYS ----------
  const ME = window.CCATEMME; let akMe = ME ? ME.get() : Number(ls('cc.akMe', 0)); let ssSel = Number(ls('cc.ssSel', 0)); let boxSel = Number(ls('cc.boxSel', 0)); let withSrc = !!ls('cc.ssWithSrc', false);
  const num = (op, ids, k, v, scale, step, min, max, label) => `<label class="ak-num">${label}<input type="number" step="${step}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} value="${v === undefined || v === null ? '' : +(v / scale).toFixed(3)}" data-op="${op}" data-ids='${JSON.stringify(ids)}' data-k="${k}" data-scale="${scale}"></label>`;
  const chk = (op, ids, k, v, label) => `<button type="button" class="mode mini ${v ? 'active' : ''}" data-op="${op}" data-ids='${JSON.stringify(ids)}' data-k="${k}" data-bool="${v ? 0 : 1}">${label}</button>`;
  const sel = (op, ids, k, v, list, label) => `<label class="ak-sel">${label}<select data-op="${op}" data-ids='${JSON.stringify(ids)}' data-k="${k}">${list.map((x) => `<option value="${x.id}" ${x.id === v ? 'selected' : ''} title="${esc(x.short)}">${esc(x.long)}</option>`).join('')}</select></label>`;
  const PATTERNS = ['Left-right bar', 'Top-bottom bar', 'H barn door', 'V barn door', 'Corners in four', 'Rect iris', 'Diamond iris', 'Circle iris', 'Top-left box', 'Top-right box', 'Bottom-right box', 'Bottom-left box', 'Top centre box', 'Right centre box', 'Bottom centre box', 'Left centre box', 'Top-left diagonal', 'Top-right diagonal'];
  function dvePreview(d, fill) {
    if (!d) return '';
    const w = d.sizeX / 10; const h = d.sizeY / 10; const l = (d.positionX + 16000) / 320; const t = (9000 - d.positionY) / 180;
    return `<div class="ak-screen"><div class="ak-dve" style="width:${w}%;height:${h}%;left:${l - w / 2}%;top:${t - h / 2}%;transform:rotate(${d.rotation / 10}deg);${d.borderEnabled ? 'outline:2px solid #ffd35c;' : ''}"><span>${esc(sshort(fill))}</span></div></div>`;
  }
  function uskCard(m, k) {
    const ids = { me: m + 1, key: k.index }; const keySrc = (V.sources || []).filter((x) => x.sa & 16); const anySrc = V.sources || [];
    const p = V.profile || {}; const hasDve = (V.dves && V.dves.count) || p.dve;
    let body = '';
    if (k.type === 'luma' && k.luma) body = `${chk('uskLuma', ids, 'preMultiplied', k.luma.preMultiplied, 'PRE-MULT')}${num('uskLuma', ids, 'clip', k.luma.clip, 10, 1, 0, 100, 'CLIP %')}${num('uskLuma', ids, 'gain', k.luma.gain, 10, 1, 0, 100, 'GAIN %')}${chk('uskLuma', ids, 'invert', k.luma.invert, 'INVERT')}`;
    if (k.type === 'chroma' && k.chroma) body = `${num('uskChroma', ids, 'hue', k.chroma.hue, 10, 1, 0, 359.9, 'HUE °')}${num('uskChroma', ids, 'gain', k.chroma.gain, 10, 1, 0, 100, 'GAIN %')}${num('uskChroma', ids, 'ySuppress', k.chroma.ySuppress, 10, 1, 0, 100, 'Y SUPP %')}${num('uskChroma', ids, 'lift', k.chroma.lift, 10, 1, 0, 100, 'LIFT %')}${chk('uskChroma', ids, 'narrow', k.chroma.narrow, 'NARROW')}`;
    if (k.type === 'pattern' && k.pattern) body = `<label class="ak-sel">PATTERN<select data-op="uskPattern" data-ids='${JSON.stringify(ids)}' data-k="style">${PATTERNS.map((n, i) => `<option value="${i}" ${i === k.pattern.style ? 'selected' : ''}>${n}</option>`).join('')}</select></label>${num('uskPattern', ids, 'size', k.pattern.size, 100, 1, 0, 100, 'SIZE %')}${num('uskPattern', ids, 'symmetry', k.pattern.symmetry, 100, 1, 0, 100, 'SYMM %')}${num('uskPattern', ids, 'softness', k.pattern.softness, 100, 1, 0, 100, 'SOFT %')}${num('uskPattern', ids, 'positionX', k.pattern.positionX, 10000, 0.01, 0, 1, 'X')}${num('uskPattern', ids, 'positionY', k.pattern.positionY, 10000, 0.01, 0, 1, 'Y')}${chk('uskPattern', ids, 'invert', k.pattern.invert, 'INVERT')}`;
    const dveOn = k.type === 'dve' || k.flyEnabled;
    const dve = dveOn && k.dve ? `<div class="ak-dvebox">${dvePreview(k.dve, k.fill)}<div class="ak-params">${num('uskDve', ids, 'positionX', k.dve.positionX, 1000, 0.1, -32, 32, 'POS X')}${num('uskDve', ids, 'positionY', k.dve.positionY, 1000, 0.1, -18, 18, 'POS Y')}
      ${num('uskDve', ids, 'sizeX', k.dve.sizeX, 1000, 0.01, 0, 99, 'SIZE X')}${num('uskDve', ids, 'sizeY', k.dve.sizeY, 1000, 0.01, 0, 99, 'SIZE Y')}${num('uskDve', ids, 'rotation', k.dve.rotation, 10, 1, -3600, 3600, 'ROT °')}
      ${chk('uskDve', ids, 'borderEnabled', k.dve.borderEnabled, 'BORDER')}${num('uskDve', ids, 'borderOuterWidth', k.dve.borderOuterWidth, 100, 0.01, 0, 16, 'B OUT')}${num('uskDve', ids, 'borderInnerWidth', k.dve.borderInnerWidth, 100, 0.01, 0, 16, 'B IN')}${num('uskDve', ids, 'borderHue', k.dve.borderHue, 10, 1, 0, 359.9, 'B HUE')}
      ${chk('uskDve', ids, 'shadowEnabled', k.dve.shadowEnabled, 'SHADOW')}${num('uskDve', ids, 'lightSourceDirection', k.dve.lightSourceDirection, 10, 1, 0, 359.9, 'LIGHT °')}${num('uskDve', ids, 'rate', k.dve.rate, 1, 1, 1, 250, 'RATE fr')}</div></div>
      ${k.canFlyKey || k.type === 'dve' ? `<div class="ak-fly"><span class="modes-lbl">FLY KEY</span>${['a', 'b'].map((f) => `<button type="button" class="mode mini" data-fly="store" data-frame="${f}" data-ids='${JSON.stringify(ids)}'>STORE ${f.toUpperCase()}${k.fly && k.fly[f === 'a' ? 'isASet' : 'isBSet'] ? ' ✓' : ''}</button>`).join('')}
        ${['a', 'b', 'full', 'infinite'].map((f) => `<button type="button" class="mode mini ${k.fly && k.fly.runningToKeyFrame === { a: 1, b: 2, full: 3, infinite: 4 }[f] ? 'running' : ''}" data-fly="run" data-frame="${f}" data-ids='${JSON.stringify(ids)}' ${(f === 'a' && !(k.fly && k.fly.isASet)) || (f === 'b' && !(k.fly && k.fly.isBSet)) ? 'disabled' : ''}>RUN ${f.toUpperCase()}</button>`).join('')}</div>` : ''}` : '';
    const mk = k.mask || {};
    return `<div class="ak-card ${k.onAir ? 'onair' : ''}"><div class="ak-head"><b>KEY ${k.index + 1}</b><button type="button" class="mode ${k.onAir ? 'onair' : ''}" data-uskon="${k.index}" data-on="${k.onAir ? 0 : 1}">${k.onAir ? 'ON AIR' : 'OFF'}</button>
      <span class="seg-row">${['luma', 'chroma', 'pattern', 'dve'].map((t) => `<button type="button" class="mode mini ${k.type === t ? 'active' : ''}" data-usktype="${t}" data-key="${k.index}" ${t === 'dve' && !hasDve ? 'disabled title="No DVE on this model"' : ''}>${t.toUpperCase()}</button>`).join('')}</span>
      ${k.canFlyKey && k.type !== 'dve' ? chk('uskType', ids, 'flyEnabled', k.flyEnabled, 'FLY') : ''}</div>
      <div class="ak-row">${sel('uskSources', ids, 'fill', k.fill, keySrc, 'FILL')}${k.type === 'luma' ? sel('uskSources', ids, 'cut', k.cut, anySrc, 'KEY') : ''}</div>
      <div class="ak-row ak-params">${body}</div>${dve}
      <div class="ak-row ak-params"><span class="modes-lbl">MASK</span>${chk('uskMask', ids, 'enabled', mk.enabled, 'ON')}${num('uskMask', ids, 'top', mk.top, 1000, 0.1, -9, 9, 'T')}${num('uskMask', ids, 'bottom', mk.bottom, 1000, 0.1, -9, 9, 'B')}${num('uskMask', ids, 'left', mk.left, 1000, 0.1, -16, 16, 'L')}${num('uskMask', ids, 'right', mk.right, 1000, 0.1, -16, 16, 'R')}</div></div>`;
  }
  function dskCard(k) {
    const ids = { key: k.index }; const mk = k.mask || {};
    return `<div class="ak-card dsk ${k.onAir ? 'onair' : ''}"><div class="ak-head"><b>DSK ${k.index + 1}</b><button type="button" class="mode ${k.tie ? 'active' : ''}" data-dsktie="${k.index}" data-on="${k.tie ? 0 : 1}">TIE</button>
      <button type="button" class="mode ${k.onAir ? 'onair' : ''}" data-dskcut="${k.index}" data-on="${k.onAir ? 0 : 1}">${k.onAir ? 'ON AIR' : 'CUT'}</button><button type="button" class="mode ${k.inTransition ? 'running' : ''}" data-dskauto="${k.index}">AUTO</button>
      ${num('dskRate', ids, 'rate', k.rate, 1, 1, 1, 250, 'RATE fr')}</div>
      <div class="ak-row">${sel('dskSources', ids, 'fill', k.fill, V.sources || [], 'FILL')}${sel('dskSources', ids, 'cut', k.cut, V.sources || [], 'KEY')}</div>
      <div class="ak-row ak-params">${chk('dskGeneral', ids, 'preMultiply', k.preMultiply, 'PRE-MULT')}${num('dskGeneral', ids, 'clip', k.clip, 10, 1, 0, 100, 'CLIP %')}${num('dskGeneral', ids, 'gain', k.gain, 10, 1, 0, 100, 'GAIN %')}${chk('dskGeneral', ids, 'invert', k.invert, 'INVERT')}</div>
      <div class="ak-row ak-params"><span class="modes-lbl">MASK</span>${chk('dskMask', ids, 'enabled', mk.enabled, 'ON')}${num('dskMask', ids, 'top', mk.top, 1000, 0.1, -9, 9, 'T')}${num('dskMask', ids, 'bottom', mk.bottom, 1000, 0.1, -9, 9, 'B')}${num('dskMask', ids, 'left', mk.left, 1000, 0.1, -16, 16, 'L')}${num('dskMask', ids, 'right', mk.right, 1000, 0.1, -16, 16, 'R')}</div></div>`;
  }
  function boxRect(b) {
    const w = b.size / 1000 * 100; const h = b.size / 1000 * 100; const cx = (b.x + 1600) / 3200 * 100; const cy = (900 - b.y) / 1800 * 100;
    let l = cx - w / 2; let t = cy - h / 2; let ww = w; let hh = h;
    if (b.cropped) { const ct = b.cropTop / 18000; const cb = b.cropBottom / 18000; const cl = b.cropLeft / 32000; const cr = b.cropRight / 32000; t += hh * ct; l += ww * cl; hh *= Math.max(0, 1 - ct - cb); ww *= Math.max(0, 1 - cl - cr); }
    return `left:${l}%;top:${t}%;width:${ww}%;height:${hh}%`;
  }
  function ssPanel() {
    const list = V.superSources || []; if (!list.length) return '<div class="section-title">SUPERSOURCE</div><div class="note small">This model has no SuperSource.</div>';
    if (ssSel >= list.length) ssSel = 0; const ss = list[ssSel]; if (boxSel >= ss.boxes.length) boxSel = 0; const b = ss.boxes[boxSel] || {};
    const ids = { ss: ssSel, box: boxSel }; const sids = { ss: ssSel }; const boxSrc = (V.sources || []).filter((x) => x.sa & 8); const artSrc = (V.sources || []).filter((x) => x.sa & 4);
    const pr = ss.props || {}; const bd = ss.border || {};
    const art = (V.sources || []).find((x) => x.id === pr.artFillSource);
    const prev = `<div class="ss-screen ${pr.artOption === 1 ? 'art-fg' : ''}"><div class="ss-art">${esc(art ? art.short : '')} ART</div>${ss.boxes.map((x) => (x.enabled ? `<div class="ss-box ${x.index === boxSel ? 'sel' : ''}" data-box="${x.index}" style="${boxRect(x)};z-index:${10 - x.index};${bd.borderEnabled ? 'outline:2px solid #ffd35c;' : ''}"><b>${x.index + 1}</b><span>${esc(sshort(x.source))}</span></div>` : '')).join('')}</div>`;
    const lay = (V.ssLayouts || []).map((l) => `<span class="ss-lay"><button type="button" class="mode mini" data-sslayout="${esc(l.id)}" title="${esc(l.name)}">${esc(l.name)}</button>${l.builtIn ? '' : `<button type="button" class="mode mini danger" data-ssdel="${esc(l.id)}" title="Delete ${esc(l.name)}">×</button>`}</span>`).join('');
    return `<div class="section-title">SUPERSOURCE <small>${list.length > 1 ? list.map((x) => `<button type="button" class="mode mini ${x.index === ssSel ? 'active' : ''}" data-ss="${x.index}">SS ${x.index + 1}</button>`).join('') : ''}</small></div>
      <div class="ss-wrap"><div>${prev}<div class="ss-boxbar">${ss.boxes.map((x) => `<button type="button" class="mode mini ${x.index === boxSel ? 'active' : ''} ${x.enabled ? '' : 'dim'}" data-box="${x.index}" title="${esc(sshort(x.source))}">BOX ${x.index + 1} · ${esc(sname(x.source))}</button>`).join('')}</div>
        <div class="ss-layouts"><span class="modes-lbl">LAYOUTS</span>${lay}<button type="button" class="mode mini ${withSrc ? 'active' : ''}" data-sswith="${withSrc ? 0 : 1}" title="Recall the sources stored in a saved layout too">WITH SOURCES</button><button type="button" class="btn mini primary" data-sssave>SAVE CURRENT…</button></div></div>
      <div class="ss-ctl"><div class="ak-head"><b>BOX ${boxSel + 1}</b>${chk('ssBox', ids, 'enabled', b.enabled, b.enabled ? 'ENABLED' : 'DISABLED')}</div>
        <div class="ak-row">${sel('ssBox', ids, 'source', b.source, boxSrc, 'SOURCE')}</div>
        <div class="ak-row ak-params">${num('ssBox', ids, 'x', b.x, 100, 0.1, -48, 48, 'X')}${num('ssBox', ids, 'y', b.y, 100, 0.1, -27, 27, 'Y')}${num('ssBox', ids, 'size', b.size, 1000, 0.01, 0.07, 1, 'SIZE')}</div>
        <div class="ak-row ak-params">${chk('ssBox', ids, 'cropped', b.cropped, 'CROP')}${num('ssBox', ids, 'cropTop', b.cropTop, 1000, 0.1, 0, 18, 'T')}${num('ssBox', ids, 'cropBottom', b.cropBottom, 1000, 0.1, 0, 18, 'B')}${num('ssBox', ids, 'cropLeft', b.cropLeft, 1000, 0.1, 0, 32, 'L')}${num('ssBox', ids, 'cropRight', b.cropRight, 1000, 0.1, 0, 32, 'R')}</div>
        <div class="ak-head"><b>ART</b><span class="seg-row"><button type="button" class="mode mini ${pr.artOption !== 1 ? 'active' : ''}" data-op="ssProps" data-ids='${JSON.stringify(sids)}' data-k="artOption" data-val="0">BACKGROUND</button><button type="button" class="mode mini ${pr.artOption === 1 ? 'active' : ''}" data-op="ssProps" data-ids='${JSON.stringify(sids)}' data-k="artOption" data-val="1">FOREGROUND</button></span></div>
        <div class="ak-row">${sel('ssProps', sids, 'artFillSource', pr.artFillSource, artSrc, 'FILL')}${sel('ssProps', sids, 'artCutSource', pr.artCutSource, V.sources || [], 'KEY')}</div>
        <div class="ak-row ak-params">${chk('ssProps', sids, 'artPreMultiplied', pr.artPreMultiplied, 'PRE-MULT')}${num('ssProps', sids, 'artClip', pr.artClip, 10, 1, 0, 100, 'CLIP %')}${num('ssProps', sids, 'artGain', pr.artGain, 10, 1, 0, 100, 'GAIN %')}${chk('ssProps', sids, 'artInvertKey', pr.artInvertKey, 'INVERT')}</div>
        <div class="ak-head"><b>BORDER</b>${chk('ssBorder', sids, 'borderEnabled', bd.borderEnabled, bd.borderEnabled ? 'ON' : 'OFF')}</div>
        <div class="ak-row ak-params">${num('ssBorder', sids, 'borderOuterWidth', bd.borderOuterWidth, 100, 0.01, 0, 16, 'OUT')}${num('ssBorder', sids, 'borderInnerWidth', bd.borderInnerWidth, 100, 0.01, 0, 16, 'IN')}${num('ssBorder', sids, 'borderHue', bd.borderHue, 10, 1, 0, 359.9, 'HUE')}${num('ssBorder', sids, 'borderSaturation', bd.borderSaturation, 10, 1, 0, 100, 'SAT')}${num('ssBorder', sids, 'borderLuma', bd.borderLuma, 10, 1, 0, 100, 'LUMA')}</div></div></div>`;
  }
  function renderKeys() {
    const pane = $('#pane-akeys'); if (busy(pane)) return;
    if (!live()) { S.set($('#akUsk'), 'aku', off()); S.set($('#akDsk'), 'akd', ''); S.set($('#akSs'), 'aks', ''); S.set($('#akMe'), 'akm', ''); $('#akInfo').textContent = ''; return; }
    const mes = V.mixEffects || []; if (ME) akMe = ME.get(); if (akMe >= mes.length) akMe = 0;
    $('#akInfo').textContent = `${V.profile ? V.profile.name : V.product} · ${mes.reduce((n, m) => n + m.keyers.length, 0)} upstream keys · ${(V.dsk || []).length} DSK · DVE ${V.dves ? `${V.dves.inUse} of ${V.dves.count} in use` : '—'} · ${(V.superSources || []).length} SuperSource`;
    S.set($('#akMe'), 'akm', mes.length > 1 ? `<span class="modes-lbl">M/E</span>${mes.map((m) => `<button type="button" class="mode ${m.index === akMe ? 'active' : ''}" data-akme="${m.index}" title="Upstream keys of M/E ${m.index + 1}${m.keyers.some((k) => k.onAir) ? ' · a key is on air' : ''}">M/E ${m.index + 1}${m.keyers.some((k) => k.onAir) ? ' <span class="dot-air">●</span>' : ''}</button>`).join('')}` : '');
    const me = mes[akMe] || { keyers: [] };
    S.set($('#akUsk'), 'aku', `<div class="section-title">UPSTREAM KEYS <small>${mes.length > 1 ? `M/E ${akMe + 1}` : ''}</small></div><div class="ak-grid">${me.keyers.map((k) => uskCard(akMe, k)).join('') || '<div class="note small">No upstream keys.</div>'}</div>`);
    S.set($('#akDsk'), 'akd', `<div class="section-title">DOWNSTREAM KEYS</div><div class="ak-grid">${(V.dsk || []).map(dskCard).join('') || '<div class="note small">No downstream keys.</div>'}</div>`);
    S.set($('#akSs'), 'aks', ssPanel());
  }
  const send = (op, ids, k, val) => cmd(op, { ...ids, [k]: val });
  $('#akMe').addEventListener('click', (e) => { const b = e.target.closest('[data-akme]'); if (!b) return; akMe = Number(b.dataset.akme); if (ME) ME.set(akMe); else save('cc.akMe', akMe); renderKeys(); });
  $('#pane-akeys').addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset.op || !live()) return; const ids = JSON.parse(t.dataset.ids);
    if (t.tagName === 'SELECT') { send(t.dataset.op, ids, t.dataset.k, Number(t.value)); return t.blur(); }
    const v = Number(t.value); if (!Number.isFinite(v)) return undefined;
    return send(t.dataset.op, ids, t.dataset.k, Math.round(v * Number(t.dataset.scale)));
  });
  $('#pane-akeys').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });
  $('#pane-akeys').addEventListener('focusout', () => setTimeout(render, 50));
  $('#pane-akeys').addEventListener('click', (e) => {
    const b = e.target.closest('button,[data-box]'); if (!b || !live()) return; const d = b.dataset;
    if (d.bool !== undefined && d.op) return send(d.op, JSON.parse(d.ids), d.k, d.bool === '1');
    if (d.val !== undefined && d.op) return send(d.op, JSON.parse(d.ids), d.k, Number(d.val));
    if (d.uskon !== undefined) return cmd('uskOnAir', { me: akMe + 1, key: Number(d.uskon), on: d.on === '1' });
    if (d.usktype) return cmd('uskType', { me: akMe + 1, key: Number(d.key), type: d.usktype });
    if (d.fly) { const ids = JSON.parse(d.ids); return cmd(d.fly === 'store' ? 'uskFlyStore' : 'uskFlyRun', { ...ids, frame: d.frame }); }
    if (d.dsktie !== undefined) return cmd('dskTie', { key: Number(d.dsktie), on: d.on === '1' });
    if (d.dskcut !== undefined) return cmd('dskOnAir', { key: Number(d.dskcut), on: d.on === '1' });
    if (d.dskauto !== undefined) return cmd('dskAuto', { key: Number(d.dskauto) });
    if (d.ss !== undefined) { ssSel = Number(d.ss); save('cc.ssSel', ssSel); return renderKeys(); }
    if (d.box !== undefined) { boxSel = Number(d.box); save('cc.boxSel', boxSel); return renderKeys(); }
    if (d.sswith !== undefined) { withSrc = d.sswith === '1'; save('cc.ssWithSrc', withSrc); return renderKeys(); }
    if (d.sslayout) return cmd('ssLayoutRecall', { ss: ssSel, layout: d.sslayout, withSources: withSrc }).then(() => toast('SuperSource layout recalled'));
    if (d.ssdel) { if (!confirm('Delete this SuperSource layout?')) return undefined; return run(api('DELETE', `/api/sys/atem/ss-layouts/${encodeURIComponent(d.ssdel)}`).then(() => { toast('Layout deleted'); S.refetch(); })); }
    if (d.sssave !== undefined) { const name = prompt('Save the current SuperSource boxes (with their sources) as layout:'); if (!name) return undefined; return run(api('POST', '/api/sys/atem/ss-layouts', { name, ss: ssSel }).then(() => { toast(`Layout "${name}" saved`); S.refetch(); })); }
    return undefined;
  });

  function render() {
    if (!V || V.kind !== 'atem') return;
    if (tab === 'arouter') renderRouter(); else if (tab === 'aaudio') renderAudio(); else if (tab === 'akeys') renderKeys();
  }
  S.onRender((v, t) => { V = v; tab = t; render(); });
  window.CCATEM = { pickModel };
})();
