'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let S = null; let gridHtml = ''; let destHtml = ''; let mode = 'recall'; let editing = null; let tab = 'presets';
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
    const rowHtml = S.destinations.map((d) => `
      <button class="dest ${d.selected ? 'on' : ''}" data-dest="${d.key}">
        <span class="k">${d.kind === 'screen' ? 'SCREEN' : 'AUX'} ${d.id}</span>
        <span class="l">${esc(d.label)}</span>
        <span class="tl">${d.pgmPreset != null ? `<span class="p">PGM ${d.pgmPreset}</span>` : ''}${d.pvwPreset != null ? `<span class="v">PVW ${d.pvwPreset}</span>` : ''}</span>
        ${d.programMemory || d.previewMemory ? `<span class="mem"><span class="p">M${d.programMemory ? d.programMemory.id + ' ' + esc(d.programMemory.label) : '–'}</span> / <span class="v">M${d.previewMemory ? d.previewMemory.id + ' ' + esc(d.previewMemory.label) : '–'}</span></span>` : ''}
      </button>`).join('') + `<button class="dest ctl" data-ctl="all">ALL</button><button class="dest ctl" data-ctl="none">CLEAR</button>`
      + (S.destinations.length ? '' : '<div class="note">No destinations yet. Check Settings and connect.</div>');
    // re-render only on change: replacing the tiles between pointerdown and pointerup would swallow the tap
    if (rowHtml !== destHtml) { destHtml = rowHtml; row.innerHTML = rowHtml; }

    const byNum = new Map(S.presets.map((p) => [p.number, p]));
    const maxN = Math.max(0, ...S.presets.map((p) => p.number));
    const slots = Math.max(24, Math.ceil((maxN + (mode === 'save' ? 4 : 0)) / 8) * 8);
    let html = '';
    for (let n = 1; n <= slots; n++) {
      const p = byNum.get(n);
      if (!p) { html += `<button class="preset empty" data-empty="${n}" data-drop-preset="${n}"><span class="num">${n}</span>${mode === 'save' ? '<span>+ save here</span>' : ''}</button>`; continue; }
      const cls = ['preset']; const tags = [];
      if (p.tally.pgm !== 'none') { if (p.tally.pgm === 'full') cls.push('pgm'); tags.push(`<span class="tag pgm ${p.tally.pgm === 'partial' ? 'part' : ''}">PGM</span>`); }
      if (p.tally.pvw !== 'none') { if (p.tally.pvw === 'full') cls.push('pvw'); tags.push(`<span class="tag pvw ${p.tally.pvw === 'partial' ? 'part' : ''}">PVW</span>`); }
      if (p.lastRecalled) cls.push('is-last');
      const chips = (p.master ? `<span class="chip mst" title="Master memory ${p.master.slot} ${esc(memName('master', p.master.slot))} → ${esc((p.master.dests || []).join(', '))}">M:${p.master.slot}</span>` : '') + p.destinations.map((d) => {
        const ok = p.memories[d] || p.hasSources[d];
        return `<span class="chip ${ok ? '' : 'warn'}" title="${esc(label(d))}${p.memories[d] ? ' · ' + esc(memName('screen', p.memories[d])) : ''}">${d}${p.memories[d] ? ':' + p.memories[d] : ''}</span>`;
      }).join('') + Object.entries(p.mvMemories || {}).map(([k, v]) => `<span class="chip mvc" title="Multiviewer ${k.slice(1)} · ${esc(memName('multiviewer', v))}">MV${k.slice(1)}:${v}</span>`).join('')
        || '<span class="chip warn">empty</span>';
      if (p.autoName) cls.push('auto');
      const tip = p.autoName ? `Preset ${n} · automatic name from the device memory names · long-press or right-click to rename` : `Preset ${n} · long-press or right-click to rename`;
      html += `<button class="${cls.join(' ')}" data-preset="${n}" data-drop-preset="${n}" title="${esc(tip)}"><span class="tags">${tags.join('')}</span><span class="num">${n}</span><span class="name">${esc(p.name)}</span><span class="chips">${chips}</span></button>`;
    }
    if (html !== gridHtml) { gridHtml = html; $('#grid').innerHTML = html; }

    renderPalette(); renderBoard(); applyArmed();
    renderLive();
    const a = $('#btnAuto'); a.classList.toggle('on', S.autoTake); a.innerHTML = `AUTO TAKE<br><b>${S.autoTake ? 'ON' : 'OFF'}</b>`;
    const tg = S.transitionTargets || S.selection;
    $('#btnTake').disabled = $('#btnCut').disabled = !tg.length;
    const tgTxt = tg.length ? tg.join(' · ') : 'nothing selected';
    // only touch the buttons when the text changes, so a press is never interrupted by a re-render
    if ($('#btnTake').dataset.tg !== tgTxt) { $('#btnTake').dataset.tg = tgTxt; $('#btnTake').innerHTML = `TAKE<small>${esc(tgTxt)}</small>`; $('#btnCut').innerHTML = `CUT<small>${esc(tgTxt)}</small>`; }
    const xt = $('#xtargets'); xt.textContent = tg.length ? `TAKE / CUT → ${tg.join(', ')}` : 'TAKE / CUT → nothing selected'; xt.classList.toggle('none', !tg.length);
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

  // ---------- 0.3.0: memory palette + board ----------
  const TYPE_NAMES = { screen: 'SCREEN / AUX', master: 'MASTER', multiviewer: 'MULTIVIEWER', layer: 'LAYER' };
  const ACCEPT = { screen: (k) => /^[SA]\d+$/.test(k), master: (k) => k === 'master', multiviewer: (k) => /^M\d+$/.test(k) };
  let palTab = localStorage.getItem('rs6.palTab') || 'screen';
  let boardHtml = '';
  let palAll = false; let palQuery = ''; let palCat = null; let palSig = ''; let armed = null;
  const memIndex = () => { const ix = {}; const c = (palAll && palCat) || (S && S.memories) || { items: {} }; for (const [t, l] of Object.entries(c.items || {})) for (const i of l) ix[`${t}:${i.slot}`] = i; if (S && S.memories) for (const [t, l] of Object.entries(S.memories.items || {})) for (const i of l) ix[`${t}:${i.slot}`] = i; return ix; };
  function memName(type, slot) { const i = memIndex()[`${type}:${slot}`]; return i ? i.label : ''; }
  const memTxt = (type, slot) => { const n = memName(type, slot); return `${slot}${n ? ' · ' + n : ''}`; };

  async function loadPalAll() { try { palCat = await api('GET', '/api/memories/catalog?all=1'); } catch { palCat = null; } palSig = ''; renderPalette(); }

  function renderPalette() {
    const cat = (palAll && palCat) || S.memories || { types: [], items: {}, import: {} };
    const sig = JSON.stringify([cat.items, cat.import, palQuery, palAll, palTab, armed && armed.key]);
    if (sig === palSig) return; palSig = sig;
    const q = palQuery.trim().toLowerCase();
    let total = 0; const counts = {};
    const lists = {};
    for (const t of cat.types || []) { lists[t.type] = (cat.items[t.type] || []).filter((i) => !q || String(i.slot) === q || (i.label || '').toLowerCase().includes(q)); counts[t.type] = lists[t.type].length; }
    const html = (cat.types || []).filter((t) => t.type === palTab).map((t) => {
      const list = lists[t.type]; total += list.length;
      const body = !t.supported ? `<div class="grp-note">${esc(t.note)}</div>`
        : list.length ? list.map((i) => {
          const cls = ['mem']; if (i.onProgram.length) cls.push('pgm'); if (i.onPreview.length) cls.push('pvw'); if (i.status !== 'valid') cls.push('empty');
          if (armed && armed.key === `${i.type}:${i.slot}`) cls.push('armed');
          const tl = (i.onProgram.length ? `<span class="tag pgm" title="on Program: ${esc(i.onProgram.join(', '))}">${i.type === 'master' ? 'PGM' : esc(i.onProgram.join(','))}</span>` : '')
            + (i.onPreview.length ? `<span class="tag pvw" title="on Preview: ${esc(i.onPreview.join(', '))}">${i.type === 'master' ? 'PVW' : esc(i.onPreview.join(','))}</span>` : '');
          const why = { device: 'valid (isValid probe, inferred path)', label: 'has a name (assumed valid; validity is not documented)', loaded: 'reported as loaded by the device' }[i.evidence] || i.status;
          return `<div class="${cls.join(' ')}" data-mtype="${i.type}" data-slot="${i.slot}" title="${esc(TYPE_NAMES[i.type])} ${i.slot} · ${esc(why)}${i.seenOn.length ? ' · seen on ' + esc(i.seenOn.join(', ')) : ''}"><span class="s">${i.slot}</span><span class="nm">${i.label ? esc(i.label) : `<i>${i.status === 'valid' ? 'unnamed' : i.status}</i>`}</span><span class="tl">${tl}</span></div>`;
        }).join('') : '<div class="grp-note">None found.</div>';
      const note = t.type === 'multiviewer' && !cat.probe ? '<div class="grp-note">Multiviewer memory names and validity are not documented: all 50 slots are listed. Settings › probe (inferred) reads them.</div>' : '';
      return `<div class="grp-b">${note}${body}</div>`;
    }).join('');
    $('#palTabs').innerHTML = (cat.types || []).map((t) => `<button class="ptab ${t.type === palTab ? 'active' : ''}" data-ptab="${t.type}" title="${esc(t.note)}">${{ screen: 'SCREEN/AUX', master: 'MASTER', multiviewer: 'MV', layer: 'LAYER' }[t.type] || t.name}<span>${t.supported ? counts[t.type] : '–'}</span></button>`).join('');
    $('#palList').innerHTML = html || '<div class="empty-note">No memories imported yet.</div>';
    $('#palCount').textContent = total ? `${total}` : '';
    const im = cat.import || {}; const f = $('#palFoot');
    f.className = 'pal-foot' + (im.error ? ' err' : '');
    f.textContent = im.error ? im.error : im.at ? `Imported ${new Date(im.at).toLocaleTimeString()} · ${cat.probe ? 'labels + isValid probe' : 'labels only (validity not documented)'}` : 'Not imported yet (needs the AWJ connection).';
  }

  function renderBoard() {
    const st = S.staging || { memories: {}, mvMemories: {}, master: null };
    const lv = S.live || {}; const lm = lv.lastMaster || {};
    const memLine = (m, cls, tag) => `<div class="${cls}">${tag} ${m ? 'M' + m.id + ' ' + esc(m.label || '') : '—'}</div>`;
    const slotBox = (key, type, slot) => slot
      ? `<div class="drop set">${type === 'master' ? 'Master' : type === 'multiviewer' ? 'MV mem' : 'Mem'} ${esc(memTxt(type, slot))}<button class="x" data-unstage="${key}" title="Remove">×</button></div>`
      : `<div class="drop">drop ${type === 'screen' ? 'Screen' : type === 'master' ? 'Master' : 'Multiviewer'} memory</div>`;
    const mp = st.master;
    let html = `<div class="card master" data-drop="master" data-accept="master">
      <span class="k">MASTER</span><span class="l">Master memory</span>
      <div class="lv">${memLine(lm.program, 'p', 'PGM')}${memLine(lm.preview, 'v', 'PVW')}</div>
      ${slotBox('master', 'master', mp && mp.slot)}
      ${mp ? `<div class="mdests" title="Screens this Master memory covers (for TAKE/tally; not readable from the device)">${S.destinations.map((d) => `<button class="${mp.dests.includes(d.key) ? 'on' : ''}" data-mdest="${d.key}">${d.key}</button>`).join('')}</div>` : ''}
    </div>`;
    for (const d of S.destinations) {
      const slot = st.memories[d.key];
      const cls = ['card']; if (d.previewMemory && slot && d.previewMemory.id === slot) cls.push('live-pvw'); if (d.programMemory && slot && d.programMemory.id === slot) cls.push('live-pgm');
      if (d.selected) cls.push('sel');
      html += `<div class="${cls.join(' ')}" data-drop="${d.key}" data-accept="screen" data-seltoggle="${d.key}" title="Tap to ${d.selected ? 'remove from' : 'add to'} the TAKE / CUT selection">
        ${d.selected ? '<span class="xt">TAKE</span>' : ''}<span class="k">${d.kind === 'screen' ? 'SCREEN' : 'AUX'} ${d.id}</span><span class="l">${esc(d.label)}</span>
        <div class="lv">${memLine(d.programMemory, 'p', 'PGM')}${memLine(d.previewMemory, 'v', 'PVW')}</div>
        ${slotBox(d.key, 'screen', slot)}</div>`;
    }
    for (const m of S.multiviewers || []) {
      html += `<div class="card mv" data-drop="${m.key}" data-accept="multiviewer"><span class="k">MULTIVIEWER ${m.id}</span><span class="l">${esc(m.label)}</span><div class="lv"><div>no readback</div></div>${slotBox(m.key, 'multiviewer', st.mvMemories[m.key])}</div>`;
    }
    if (html !== boardHtml) { boardHtml = html; $('#board').innerHTML = html; }
    const n = Object.keys(st.memories).length + Object.keys(st.mvMemories).length + (st.master ? 1 : 0);
    $('#btnStageLoad').disabled = $('#btnStageSave').disabled = $('#btnStageClear').disabled = !n;
    $('#btnStageSave').textContent = st.editing ? `SAVE TO ${st.editing}…` : 'SAVE AS PRESET…';
  }

  // armed = memory picked by a tap (click-to-assign fallback)
  function applyArmed() {
    const box = $('#armed');
    document.querySelectorAll('.ok-target,.no-target').forEach((e) => e.classList.remove('ok-target', 'no-target'));
    if (drag && drag.started) markTargets(drag.mem);
    if (!armed) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<b>${esc(TYPE_NAMES[armed.type])} ${esc(memTxt(armed.type, armed.slot))}</b> picked · tap a ${armed.type === 'screen' ? 'screen / aux' : armed.type === 'master' ? 'MASTER' : 'multiviewer'} card or a preset <span class="spacer"></span><button class="btn mini" data-unarm="1">Cancel</button>`;
    markTargets(armed);
  }
  function markTargets(mem) {
    document.querySelectorAll('[data-drop]').forEach((el) => el.classList.add(ACCEPT[mem.type](el.dataset.drop) ? 'ok-target' : 'no-target'));
  }
  const arm = (mem) => { armed = armed && armed.key === mem.key ? null : mem; palSig = ''; renderPalette(); applyArmed(); };

  function stageTo(target, mem) {
    if (!ACCEPT[mem.type](target)) return toast(`A ${TYPE_NAMES[mem.type]} memory cannot go on ${target}`, true);
    return run(api('POST', '/api/stage', { target, type: mem.type, slot: mem.slot }).then(() => toast(`${target === 'master' ? 'MASTER' : target} ← ${TYPE_NAMES[mem.type]} ${memTxt(mem.type, mem.slot)}`)));
  }
  function targetsFor(type) {
    if (type === 'master') return [{ key: 'master', label: 'Master memory' }];
    if (type === 'multiviewer') return (S.multiviewers || []).map((m) => ({ key: m.key, label: `${m.key} ${m.label}` }));
    return S.destinations.map((d) => ({ key: d.key, label: `${d.key} ${d.label}` }));
  }
  function assignPreset(n, mem) {
    const ts = targetsFor(mem.type);
    if (!ts.length) return toast('No compatible target on this device', true);
    const go = (target) => run(api('POST', `/api/presets/${n}/assign`, { target, type: mem.type, slot: mem.slot }).then((p) => toast(`Preset ${p.number} · ${p.name}: ${target === 'master' ? 'Master' : target} ← ${memTxt(mem.type, mem.slot)}${p.autoName ? ' · long-press to rename' : ''}`)));
    if (ts.length === 1) return go(ts[0].key);
    const info = memIndex()[mem.key] || { seenOn: [] };
    $('#pickTitle').textContent = `Preset ${n}: put ${TYPE_NAMES[mem.type]} ${memTxt(mem.type, mem.slot)} on…`;
    $('#pickNote').textContent = info.seenOn && info.seenOn.length ? `Green = where the device last reported this memory (${info.seenOn.join(', ')}).` : 'Pick the destination for this memory in the preset.';
    $('#pickList').innerHTML = ts.map((t) => `<button class="btn ${info.seenOn && info.seenOn.includes(t.key) ? 'hint' : ''}" value="${t.key}">${esc(t.label)}</button>`).join('');
    const dlg = $('#dlgPick'); dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue && dlg.returnValue !== 'cancel') go(dlg.returnValue); };
    dlg.showModal();
  }
  function dropOn(el, mem) {
    if (!el) return false;
    if (el.dataset.drop) { stageTo(el.dataset.drop, mem); return true; }
    if (el.dataset.dropPreset) { assignPreset(Number(el.dataset.dropPreset), mem); return true; }
    return false;
  }
  const memFromEl = (it) => ({ type: it.dataset.mtype, slot: Number(it.dataset.slot), key: `${it.dataset.mtype}:${it.dataset.slot}` });

  // Pointer-event drag: mouse drags after 6 px; touch/pen after a 200 ms hold (so the list still scrolls).
  let drag = null;
  const dropTargetAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest('[data-drop],[data-drop-preset]'); };
  function startDrag(d, x, y) {
    d.started = true; d.el.classList.add('dragsrc'); document.body.classList.add('dragging');
    const g = $('#ghost'); g.textContent = `${TYPE_NAMES[d.mem.type]} ${memTxt(d.mem.type, d.mem.slot)}`; g.hidden = false;
    markTargets(d.mem); moveDrag(x, y);
    // edge auto-scroll so preset tiles below the fold can be reached mid-drag
    d.scroll = setInterval(() => {
      if (!drag || !drag.started) return;
      const y0 = drag.y; const h = window.innerHeight; const v = y0 > h - 70 ? 14 : y0 < 70 ? -14 : 0;
      if (v) { window.scrollBy(0, v); moveDrag(drag.x, drag.y); }
    }, 30);
    if (navigator.vibrate) try { navigator.vibrate(10); } catch { /* ignore */ }
  }
  function moveDrag(x, y) {
    drag.x = x; drag.y = y;
    const g = $('#ghost'); g.style.left = `${x}px`; g.style.top = `${y}px`;
    const t = dropTargetAt(x, y);
    if (drag.hover && drag.hover !== t) drag.hover.classList.remove('hover');
    if (t && (!t.dataset.drop || ACCEPT[drag.mem.type](t.dataset.drop))) { t.classList.add('hover'); drag.hover = t; } else drag.hover = null;
  }
  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer); clearInterval(drag.scroll);
    if (drag.started) { drag.el.classList.remove('dragsrc'); document.body.classList.remove('dragging'); $('#ghost').hidden = true; if (drag.hover) drag.hover.classList.remove('hover'); applyArmed(); }
    drag = null;
  }
  $('#palList').addEventListener('pointerdown', (e) => {
    const it = e.target.closest('.mem'); if (!it || e.button > 0) return;
    drag = { el: it, mem: memFromEl(it), x0: e.clientX, y0: e.clientY, id: e.pointerId, pt: e.pointerType, started: false };
    if (e.pointerType !== 'mouse') { const d = drag; d.timer = setTimeout(() => { if (drag === d) startDrag(d, d.x0, d.y0); }, 200); }
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dist = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
    if (!drag.started) {
      if (drag.pt === 'mouse' && dist > 6) startDrag(drag, e.clientX, e.clientY);
      else if (drag.pt !== 'mouse' && dist > 10) endDrag(); // it was a scroll
      return;
    }
    e.preventDefault(); moveDrag(e.clientX, e.clientY);
  }, { passive: false });
  window.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    if (d.started) { const t = dropTargetAt(e.clientX, e.clientY); endDrag(); armed = null; dropOn(t, d.mem); palSig = ''; renderPalette(); applyArmed(); }
    else { endDrag(); arm(d.mem); } // plain tap: pick it for click-to-assign
  });
  window.addEventListener('pointercancel', () => endDrag());
  // stop the page scrolling under a touch drag
  document.addEventListener('touchmove', (e) => { if (drag && drag.started) e.preventDefault(); }, { passive: false });

  $('#palTabs').addEventListener('click', (e) => {
    const g = e.target.closest('[data-ptab]'); if (!g) return;
    palTab = g.dataset.ptab; localStorage.setItem('rs6.palTab', palTab); palSig = ''; renderPalette();
  });
  $('#palSearch').addEventListener('input', (e) => { palQuery = e.target.value; palSig = ''; renderPalette(); });
  $('#palAll').addEventListener('change', (e) => { palAll = e.target.checked; if (palAll) loadPalAll(); else { palSig = ''; renderPalette(); } });
  $('#btnMemRefresh').addEventListener('click', () => run(api('POST', '/api/memories/refresh').then((c) => { toast(`Imported ${Object.values(c.items).reduce((a, l) => a + l.length, 0)} memories`); if (palAll) loadPalAll(); })));
  const setPal = (show) => { $('#pane-presets').classList.toggle('pal-hidden', !show); $('#btnPalShow').hidden = show; localStorage.setItem('rs6.palHidden', show ? '' : '1'); };
  $('#btnPalHide').addEventListener('click', () => setPal(false));
  $('#btnPalShow').addEventListener('click', () => setPal(true));
  if (localStorage.getItem('rs6.palHidden')) setPal(false);
  $('#armed').addEventListener('click', (e) => { if (e.target.dataset.unarm) { armed = null; palSig = ''; renderPalette(); applyArmed(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armed) { armed = null; palSig = ''; renderPalette(); applyArmed(); } });

  $('#board').addEventListener('click', (e) => {
    const x = e.target.closest('[data-unstage]');
    if (x) return run(api('POST', '/api/stage', { target: x.dataset.unstage, slot: null }));
    const md = e.target.closest('[data-mdest]');
    if (md && S.staging.master) {
      const ds = new Set(S.staging.master.dests); if (ds.has(md.dataset.mdest)) ds.delete(md.dataset.mdest); else ds.add(md.dataset.mdest);
      return run(api('POST', '/api/stage', { target: 'master', type: 'master', slot: S.staging.master.slot, dests: [...ds] }));
    }
    const card = e.target.closest('[data-drop]');
    if (card && armed) { const m = armed; armed = null; palSig = ''; stageTo(card.dataset.drop, m); renderPalette(); applyArmed(); return; }
    // No memory picked: a screen / aux card is a selection toggle, like the destination tiles above.
    const sc = e.target.closest('[data-seltoggle]');
    if (sc) return run(api('POST', `/api/destinations/${sc.dataset.seltoggle}/toggle`));
  });
  const setBoard = (show) => { $('#board').classList.toggle('collapsed', !show); $('#btnBoardToggle').textContent = show ? '▾' : '▸'; localStorage.setItem('rs6.boardHidden', show ? '' : '1'); };
  $('#btnBoardToggle').addEventListener('click', () => setBoard($('#board').classList.contains('collapsed')));
  if (localStorage.getItem('rs6.boardHidden')) setBoard(false);
  $('#btnStageLoad').addEventListener('click', () => run(api('POST', '/api/stage/load', {}).then((r) => toast(`Loaded to PVW: ${r.done.join(', ') || 'nothing'}`, !!r.failed.length))));
  $('#btnStageClear').addEventListener('click', () => run(api('DELETE', '/api/stage')));
  $('#btnStageSave').addEventListener('click', () => {
    const st = S.staging; const f = $('#formStage');
    const n = st.editing || (Math.max(0, ...S.presets.map((p) => p.number)) + 1);
    const p = S.presets.find((x) => x.number === n);
    f.elements.number.value = n; f.elements.name.value = p && !p.autoName ? p.customName : (st.suggestedName || '');
    const parts = [];
    if (st.master) parts.push(`Master ${memTxt('master', st.master.slot)} (covers ${st.master.dests.join(', ') || 'none'})`);
    for (const [d, v] of Object.entries(st.memories)) parts.push(`${d} ← ${memTxt('screen', v)}`);
    for (const [k, v] of Object.entries(st.mvMemories)) parts.push(`${k} ← MV ${memTxt('multiviewer', v)}`);
    $('#stageSummary').innerHTML = parts.map(esc).join('<br>');
    $('#dlgStage').showModal();
  });
  $('#dlgStage').addEventListener('close', () => {
    if ($('#dlgStage').returnValue !== 'save') return;
    const f = $('#formStage');
    run(api('POST', '/api/stage/save', { number: Number(f.elements.number.value), name: f.elements.name.value }).then((p) => toast(`Saved ${p.number} · ${p.name}`)));
  });

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

  // 0.3.3: rename a preset with a long-press (touch or mouse) or a right-click on its tile.
  function renamePreset(n) {
    const p = S.presets.find((x) => x.number === n); if (!p) return;
    const v = prompt(`Name for preset ${n}\n(leave empty for the automatic name: "${p.derivedName || 'Preset ' + n}")`, p.autoName ? p.name : p.customName);
    if (v === null) return;
    run(api('PUT', `/api/presets/${n}`, { name: v }).then((r) => toast(`Preset ${r.number} · ${r.name}${r.autoName ? ' (automatic)' : ''}`)));
  }
  let lp = null; let lpFired = false;
  $('#grid').addEventListener('pointerdown', (ev) => {
    const b = ev.target.closest('[data-preset]'); lpFired = false; if (!b || armed || ev.button > 0) return;
    const x0 = ev.clientX, y0 = ev.clientY; clearTimeout(lp && lp.t);
    lp = { x0, y0, t: setTimeout(() => { lpFired = true; lp = null; renamePreset(Number(b.dataset.preset)); }, 600) };
  });
  const lpCancel = (ev) => { if (lp && (ev.type !== 'pointermove' || Math.hypot(ev.clientX - lp.x0, ev.clientY - lp.y0) > 10)) { clearTimeout(lp.t); lp = null; } };
  for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) $('#grid').addEventListener(t, lpCancel);
  $('#grid').addEventListener('contextmenu', (ev) => {
    const b = ev.target.closest('[data-preset]'); if (!b) return;
    ev.preventDefault(); if (lpFired) return; if (lp) { clearTimeout(lp.t); lp = null; } renamePreset(Number(b.dataset.preset));
  });
  $('#grid').addEventListener('click', (ev) => {
    if (lpFired) { lpFired = false; ev.preventDefault(); return; } // the long-press already renamed
    const b = ev.target.closest('button'); if (!b) return;
    const n = Number(b.dataset.preset || b.dataset.empty);
    if (armed) { const m = armed; armed = null; palSig = ''; renderPalette(); applyArmed(); return assignPreset(n, m); }
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
    f.elements.number.value = n; f.elements.name.value = p && !p.autoName ? p.customName : '';
    const nameEl = f.elements.name; nameEl.dataset.auto = p && !p.autoName ? '' : '1';
    nameEl.oninput = () => { nameEl.dataset.auto = ''; };
    slotInputs($('#saveSlots'), S.selection, null);
    const suggest = () => { if (!nameEl.dataset.auto) return; api('POST', '/api/presets/suggest-name', { memories: readSlots(f, S.selection), destinations: S.selection }).then((r) => { if (nameEl.dataset.auto) nameEl.value = r.name; }).catch(() => {}); };
    $('#saveSlots').oninput = suggest; suggest();
    $('#dlgSave').showModal();
    // Pre-fill slots with what the device reports on Preview (AWJ readback), if enabled.
    api('POST', '/api/capture', { destinations: S.selection }).then((c) => {
      for (const [d, v] of Object.entries(c.memories || {})) { const i = f.elements[`slot_${d}`]; if (i && !i.value) i.value = v; }
      suggest();
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
    $('#editNameHint').textContent = p.autoName ? `Name is automatic (from the device memory names: "${p.derivedName || '—'}"). Type a name to fix it.` : `Automatic name would be "${p.derivedName || '—'}". Clear the name to go back to it.`;
    slotInputs($('#editSlots'), p.destinations, p.memories);
    f.elements.master.value = p.master ? p.master.slot : '';
    const md = p.master ? p.master.dests : S.destinations.map((d) => d.key);
    $('#editMasterDests').innerHTML = S.destinations.map((d) => `<label><input type="checkbox" name="mdest_${d.key}" ${md.includes(d.key) ? 'checked' : ''}> ${d.key}</label>`).join('');
    $('#editMvWrap').hidden = !(S.multiviewers || []).length;
    $('#editMv').innerHTML = (S.multiviewers || []).map((m) => `<label>${m.key} · ${esc(m.label)}<input type="number" min="1" max="50" name="mv_${m.key}" placeholder="none" value="${(p.mvMemories || {})[m.key] || ''}"></label>`).join('');
    $('#dlgEdit').showModal();
  }
  $('#dlgEdit').addEventListener('close', () => {
    if ($('#dlgEdit').returnValue !== 'save' || !editing) return;
    const f = $('#formEdit');
    const ms = Number(f.elements.master.value);
    const master = ms ? { slot: ms, dests: S.destinations.map((d) => d.key).filter((k) => f.elements[`mdest_${k}`] && f.elements[`mdest_${k}`].checked) } : null;
    const mvMemories = {}; for (const m of S.multiviewers || []) { const v = Number(f.elements[`mv_${m.key}`] && f.elements[`mv_${m.key}`].value); if (v) mvMemories[m.key] = v; }
    run(api('PUT', `/api/presets/${editing.number}`, { name: f.elements.name.value, newNumber: Number(f.elements.number.value), memories: readSlots(f, editing.destinations), master, mvMemories }).then(() => toast('Saved')));
  });
  $('#formEdit').querySelector('.btn-grid').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b || !editing) return;
    const n = editing.number; const act = b.dataset.act;
    if (act === 'delete' && !confirm(`Delete preset ${n} "${editing.name}"?`)) return;
    if (act === 'overwrite' && !confirm(`Overwrite preset ${n} with the current selection (${S.selection.join(', ') || 'none'})?`)) return;
    if (act === 'board') { $('#dlgEdit').close('cancel'); return run(api('POST', `/api/stage/from/${n}`).then(() => toast(`Preset ${n} is on the board: change it, then SAVE TO ${n}`))); }
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
    for (const k of ['https', 'awjReadback', 'presetToggle', 'liveEnabled', 'memoryProbe']) f.elements[k].checked = !!s[k];
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
    for (const k of ['https', 'awjReadback', 'presetToggle', 'liveEnabled', 'memoryProbe']) b[k] = f.elements[k].checked;
    if (f.elements.clearPassword.checked) b.password = ''; else if (f.elements.password.value) b.password = f.elements.password.value;
    run(api('POST', '/api/settings', b).then((st) => toast(st.connected ? 'Connected' : 'Saved, but not connected', !st.connected)));
  });
  if (location.pathname === '/settings') run(openSettings());

  api('GET', '/api/log').then((l) => l.forEach(addLog)).catch(() => {});
  connectEvents();
})();
