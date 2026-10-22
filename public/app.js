'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let S = null; let gridHtml = ''; let destHtml = ''; let mode = 'recall'; let editing = null; let tab = 'presets';
  // 0.4.0: one line that says exactly what a tap on a tile does in each mode
  const HINTS = {
    recall: '<b>RECALL</b> · tap a tile to load it to <b>Preview</b> on its screens, then TAKE or CUT. Long-press or right-click a tile to rename it. With a mouse, drag a tile onto another to swap them.',
    edit: '<b>EDIT</b> · tap a tile to rename or renumber it, fix its memory slots, update, duplicate or delete it.',
    move: '<b>MOVE</b> · tap a tile, then tap another tile to <b>swap</b> them, or an empty tile to <b>move</b> it there. Companion buttons follow the tile number.',
    save: '<b>SAVE PVW → TILE</b> · light the screens above, then tap an empty tile (or a preset to overwrite): it stores the Screen memory each lit screen reports on <b>Preview</b>, plus a source snapshot. For Master / Multiviewer memories use the board.',
  };
  let moveSrc = null; // MOVE mode: the tile picked first
  // 0.5.0 preset pages: 0 = all tiles (scroll), else pages of 24 (a Stream Deck XL page)
  const PAGE = 24;
  let page = Number(localStorage.getItem('rs6.page') || 0) || 0;

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
    const av = $('#appVer');
    if (av && S.appVersion && av.textContent !== `v${S.appVersion}`) { av.textContent = `v${S.appVersion}`; av.title = `Control Center ${S.appVersion}`; }
    const c = $('#conn');
    const ver = S.system && S.system.version ? (typeof S.system.version === 'object' ? `${S.system.version.major}.${S.system.version.minor}.${S.system.version.patch}` : S.system.version) : '';
    c.className = 'pill rs6-only ' + (S.connected ? 'ok' : 'off');
    c.innerHTML = (S.connected ? `${esc(S.system.type || 'Aquilon')} ${esc(ver)} · ${esc(S.settings.host)}` : `Not connected${S.lastError ? ' · ' + esc(S.lastError).slice(0, 60) : ''}`) + (S.mock ? '<span class="mock">MOCK</span>' : '');
    if (S.show) {
      if ($('#showName').textContent !== S.show.name) $('#showName').textContent = S.show.name;
      $('#showDirty').hidden = !S.show.dirty;
      $('#btnShow').title = `Show "${S.show.name}"${S.show.dirty ? ' · unsaved changes (autosaved as the working state; SAVE to keep it in the library)' : ' · saved'} · click to save, open, download or upload shows`;
    }
    $('#last').textContent = S.lastRecalled ? `PVW: ${S.lastRecalled.number} · ${S.lastRecalled.name}` : 'PVW: —';
    const lv = S.live || {}; const lm = lv.lastMaster || {};
    const mref = (r) => (r ? `${r.id}${r.label ? ' ' + esc(r.label) : ''}` : '—');
    $('#master').innerHTML = lv.hasMemoryInfo ? `MASTER PGM <b>${mref(lm.program)}</b> · PVW <b>${mref(lm.preview)}</b>` : '';
    const lmEl = $('#liveMode');
    const modeTxt = { push: 'LIVE · PUSH', 'poll-awj': 'LIVE · AWJ POLL', 'poll-rest': 'LIVE · REST POLL', off: 'LIVE OFF' }[lv.mode || 'off'];
    lmEl.className = 'pill rs6-only ' + (lv.mode === 'push' ? 'live-push' : lv.mode && lv.mode !== 'off' ? 'live-poll' : 'live-off');
    lmEl.textContent = modeTxt; lmEl.title = lv.error || '';

    const row = $('#destRow');
    // 0.3.4: one column per board card: [ALL/CLEAR | MASTER] [screens + aux] [multiviewers]
    const nMv = (S.multiviewers || []).length;
    const cols = `repeat(${1 + S.destinations.length + nMv}, minmax(var(--colmin), 1fr))`;
    if ($('#screens').style.getPropertyValue('--cols') !== cols) $('#screens').style.setProperty('--cols', cols);
    const rowHtml = `<div class="dest ctlcell"><button class="ctl" data-ctl="all">ALL</button><button class="ctl" data-ctl="none">CLEAR</button></div>` + S.destinations.map((d) => `
      <button class="dest ${d.selected ? 'on' : ''}" data-dest="${d.key}">
        <span class="k">${d.kind === 'screen' ? 'SCREEN' : 'AUX'} ${d.id}</span>
        <span class="l">${esc(d.label)}</span>
        <span class="tl">${d.pgmPreset != null ? `<span class="p">PGM ${d.pgmPreset}</span>` : ''}${d.pvwPreset != null ? `<span class="v">PVW ${d.pvwPreset}</span>` : ''}</span>
        ${d.programMemory || d.previewMemory ? `<span class="mem"><span class="p">M${d.programMemory ? d.programMemory.id + ' ' + esc(d.programMemory.label) : '–'}</span> / <span class="v">M${d.previewMemory ? d.previewMemory.id + ' ' + esc(d.previewMemory.label) : '–'}</span></span>` : ''}
      </button>`).join('')
      + (nMv ? `<div class="dest mvcell" style="grid-column:span ${nMv}"><span class="k">MULTIVIEWER</span><span>memories only · no TAKE</span></div>` : '')
      + (S.destinations.length ? '' : '<div class="note" style="grid-column:2 / -1">No destinations yet. Check Settings and connect.</div>');
    // re-render only on change: replacing the tiles between pointerdown and pointerup would swallow the tap
    if (rowHtml !== destHtml) { destHtml = rowHtml; row.innerHTML = rowHtml; }

    const byNum = new Map(S.presets.map((p) => [p.number, p]));
    const maxN = Math.max(0, ...S.presets.map((p) => p.number));
    // 0.5.0: the tile count is a setting (24/48/72/96); presets above it still show. Tiles are ALWAYS laid out by
    // their number (tile n = preset n), never by list order.
    const tiles = Number(S.tileCount) || 48;
    const slots = Math.max(tiles, Math.ceil((maxN + (mode === 'save' || mode === 'move' ? 4 : 0)) / 8) * 8);
    const pages = Math.ceil(slots / PAGE);
    if (page > pages) page = 0;
    const pagerHtml = pages > 1 ? [`<button class="pg ${page === 0 ? 'on' : ''}" data-page="0">ALL</button>`].concat(Array.from({ length: pages }, (_, i) => {
      const lo = i * PAGE + 1; const hi = Math.min(slots, (i + 1) * PAGE); const used = S.presets.filter((p) => p.number >= lo && p.number <= hi).length;
      return `<button class="pg ${page === i + 1 ? 'on' : ''}" data-page="${i + 1}" title="${used} preset${used === 1 ? '' : 's'}">${lo}–${hi}${used ? `<small>${used}</small>` : ''}</button>`;
    })).join('') : '';
    const pg = $('#pager'); if (pg.dataset.h !== pagerHtml) { pg.dataset.h = pagerHtml; pg.innerHTML = pagerHtml; pg.hidden = !pagerHtml; }
    const from = page ? (page - 1) * PAGE + 1 : 1; const to = page ? Math.min(slots, page * PAGE) : slots;
    let html = '';
    if (moveSrc != null && !byNum.has(moveSrc)) moveSrc = null;
    for (let n = from; n <= to; n++) {
      const p = byNum.get(n);
      if (!p) { html += `<button class="preset empty" data-empty="${n}" data-drop-preset="${n}"><span class="num">${n}</span>${mode === 'save' ? '<span>+ save here</span>' : mode === 'move' && moveSrc != null ? '<span>move here</span>' : ''}</button>`; continue; }
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
      if (moveSrc === n) cls.push('move-src');
      const tip = p.autoName ? `Preset ${n} · automatic name from the device memory names · long-press or right-click to rename` : `Preset ${n} · long-press or right-click to rename`;
      html += `<button class="${cls.join(' ')}" data-preset="${n}" data-drop-preset="${n}" title="${esc(tip)}"><span class="tags">${tags.join('')}</span><span class="num">${n}</span><span class="name">${esc(p.name)}</span><span class="chips">${chips}</span></button>`;
    }
    if (html !== gridHtml) { gridHtml = html; $('#grid').innerHTML = html; }
    const gcls = `grid mode-${mode}${moveSrc != null ? ' has-src' : ''}`; if ($('#grid').className !== gcls) $('#grid').className = gcls;
    renderHint();

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
      // 0.4.0: only backups / groups that exist on the device now; groups by the name given in the Web RCS
      const grp = (x) => (x.group ? `<span class="badge grp" title="Member of backup group ${x.group}">${esc(x.groupLabel)}</span>` : '');
      const state = (x) => (x.active ? `<span class="badge warn">BACKUP ${esc(x.selected)} ON</span>` : '<span class="badge">PRIMARY</span>');
      const html = (sel, h) => { if ($(sel).dataset.h !== h) { $(sel).dataset.h = h; $(sel).innerHTML = h; } };
      html('#bkInputs', bk.inputs.length ? bk.inputs.map((i) => `<div class="row" data-bkrow="input/${i.number}"><span class="lbl">IN ${i.number} ${esc(i.label)} ${grp(i)}<small>B1: ${esc(i.slots[1] || 'NONE')} · B2: ${esc(i.slots[2] || 'NONE')} · ${state(i)}</small></span>${segs('input', i.number, i.selected)}${auto('input', i.number, i.auto)}</div>`).join('') : '<div class="empty-note">No input backups on the device.</div>');
      html('#bkBg', bk.backgrounds.length ? bk.backgrounds.map((b) => `<div class="row" data-bkrow="bg/${b.screen}/${b.set}"><span class="lbl">${b.screen} · Background set ${b.set} ${grp(b)}<small>B1: ${esc(b.slots[1] || 'NONE')} · B2: ${esc(b.slots[2] || 'NONE')} · ${state(b)}</small></span>${segs('bg', b.screen + '/' + b.set, b.selected)}${auto('bg', b.screen + '/' + b.set, b.auto)}</div>`).join('') : '<div class="empty-note">No background set backups on the device.</div>');
      html('#bkGroups', bk.groups.length ? bk.groups.map((g) => `<div class="row" data-bkrow="group/${g.group}"><span class="lbl"><span class="glabel">${esc(g.label)}</span>${g.customLabel ? `<span class="gnum">GROUP ${g.group}</span>` : ''}<small>${g.members.length ? esc(g.members.map((m) => m.label).join(' · ')) : 'no members'} · ${state(g)}</small></span>${segs('group', g.group, g.selected)}${auto('group', g.group, g.auto)}</div>`).join('') : '<div class="empty-note">No backup groups on the device.</div>');
    }
    if (tab === 'audio') {
      const au = lv.audio || { inputs: [], outputs: [] };
      const row = (dir, idKey, x) => `<div class="row"><span class="lbl">${dir === 'inputs' ? 'Input' : 'Output'} ${x[idKey]}</span>${x.channels.map((c) => `<button class="ch ${c.mute ? 'muted' : ''}" data-audio="${dir}" data-id="${x[idKey]}" data-ch="${c.channel}">${c.channel}${c.mute ? '<br>M' : ''}</button>`).join('')}</div>`;
      $('#audioIn').innerHTML = au.inputs.length ? au.inputs.map((x) => row('inputs', 'input', x)).join('') : '<div class="empty-note">No audio input channels found.</div>';
      $('#audioOut').innerHTML = au.outputs.length ? au.outputs.map((x) => row('outputs', 'output', x)).join('') : '<div class="empty-note">No audio output channels found.</div>';
    }
  }

  // ---------- 0.3.0: memory palette + board ----------
  const TYPE_NAMES = { screen: 'SCREEN / AUX', master: 'MASTER', multiviewer: 'MULTIVIEWER' };
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
        }).join('') : `<div class="grp-note">${t.type === 'multiviewer' && !cat.probe && !palAll
          ? 'No Multiviewer memories known: their names and validity aren\'t in the API guides. Turn on Settings › “Also probe undocumented memory paths”, or tick “show empty / unknown slots” to list all 50.'
          : palAll ? 'None found.' : 'None found. Tick “show empty / unknown slots” to list every slot.'}</div>`;
      const note = t.type === 'multiviewer' && !cat.probe && palAll && list.length ? '<div class="grp-note">Multiviewer validity isn\'t documented: every slot is listed as unknown. Settings › probe (inferred) reads names and validity.</div>' : '';
      return `<div class="grp-b">${note}${body}</div>`;
    }).join('');
    $('#palTabs').innerHTML = (cat.types || []).map((t) => `<button class="ptab ${t.type === palTab ? 'active' : ''}" data-ptab="${t.type}" title="${esc(t.note)}">${{ screen: 'SCREEN/AUX', master: 'MASTER', multiviewer: 'MV' }[t.type] || t.name}<span>${t.supported ? counts[t.type] : '–'}</span></button>`).join('');
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
    $('#btnStageSave').textContent = st.editing ? `SAVE BOARD TO ${st.editing}…` : 'SAVE BOARD AS PRESET…';
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
    $('#logLast').textContent = `${new Date(e.t).toLocaleTimeString()} ${e.msg}`; $('#logLast').className = `log-last ${e.level}`;
  }

  // ---------- live updates ----------
  // 0.3.4: robust event stream. Firefox closes an EventSource when the page goes into the back/forward cache
  // (navigate away, then Back) and doesn't reopen it on restore; a tab frozen in the background can also come
  // back with a stream that looks open but is dead. So: reconnect with backoff, reopen on pageshow(persisted),
  // visibilitychange, online; refetch the state on every resume; and a watchdog reopens the stream when no
  // event or heartbeat (the server sends `ping` every 10 s) arrived for WATCHDOG_MS.
  const WATCHDOG_MS = Number(window.RS6_WATCHDOG_MS) || 25000;
  const link = { es: null, lastMsg: 0, attempt: 0, retryT: null, state: 'connecting', since: Date.now() };
  window.__rs6link = link; // for diagnostics and tests
  function setLink(state, detail) {
    if (link.state !== state) { link.state = state; link.since = Date.now(); }
    const el = $('#link'); if (!el) return;
    const txt = { ok: 'APP LINK OK', connecting: 'CONNECTING…', reconnecting: `RECONNECTING${link.attempt > 1 ? ` (${link.attempt})` : ''}…`, offline: 'OFFLINE' }[state] || state;
    el.className = 'pill link ' + state; el.textContent = txt; el.title = detail || '';
    document.body.classList.toggle('link-down', state !== 'ok');
    const bn = $('#linkBanner');
    if (bn) { bn.hidden = state === 'ok'; $('#linkMsg').textContent = state === 'offline' ? 'This device is offline. Waiting for the network…' : `Lost the connection to the RS6 Presets app${detail ? ` (${detail})` : ''}. Reconnecting${link.attempt > 1 ? `, attempt ${link.attempt}` : ''}… The display may be out of date.`; }
  }
  function closeStream() { if (link.es) { link.es.onerror = null; link.es.onopen = null; try { link.es.close(); } catch { /* ignore */ } link.es = null; } }
  async function refetchState() {
    try { const st = await api('GET', '/api/state'); S = st; render(); link.lastMsg = Date.now(); return true; } catch { return false; }
  }
  function scheduleReconnect(why) {
    clearTimeout(link.retryT);
    link.attempt += 1;
    const delay = Math.min(15000, 500 * 2 ** Math.min(link.attempt - 1, 5)) + Math.floor(Math.random() * 250);
    setLink(navigator.onLine === false ? 'offline' : 'reconnecting', why);
    link.pending = true;
    link.retryT = setTimeout(() => openStream(why), delay);
  }
  function openStream(why) {
    clearTimeout(link.retryT); link.pending = false; closeStream(); link.openedAt = Date.now();
    if (navigator.onLine === false) { setLink('offline'); return; }
    if (link.state !== 'ok') setLink(link.attempt ? 'reconnecting' : 'connecting', why);
    const es = new EventSource('/api/events'); link.es = es;
    const alive = () => { link.lastMsg = Date.now(); if (link.state !== 'ok') { link.attempt = 0; setLink('ok'); } };
    es.onopen = alive;
    es.addEventListener('state', (ev) => { alive(); S = JSON.parse(ev.data); render(); });
    es.addEventListener('log', (ev) => { alive(); addLog(JSON.parse(ev.data)); });
    es.addEventListener('sys', (ev) => { alive(); window.dispatchEvent(new CustomEvent('cc:sys', { detail: JSON.parse(ev.data) })); });
    es.addEventListener('ping', alive);
    es.onerror = () => {
      if (link.es !== es) return;
      // CLOSED: the browser gave up (Firefox does after some errors) -> our own backoff. CONNECTING: the browser
      // is retrying itself; show it, and let the watchdog step in if that never succeeds.
      if (es.readyState === 2) scheduleReconnect('stream closed');
      else setLink('reconnecting', 'stream interrupted');
    };
  }
  function resume(why) {
    const stale = !link.es || link.es.readyState === 2 || Date.now() - link.lastMsg > WATCHDOG_MS / 2;
    if (stale) { link.attempt = 0; openStream(why); }
    refetchState();
  }
  window.addEventListener('pageshow', (e) => { if (e.persisted) { link.attempt = 0; openStream('restored from the back/forward cache'); refetchState(); } });
  window.addEventListener('pagehide', (e) => { if (e.persisted) { clearTimeout(link.retryT); closeStream(); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume('tab visible again'); });
  window.addEventListener('online', () => { link.attempt = 0; openStream('back online'); refetchState(); });
  window.addEventListener('offline', () => { setLink('offline'); });
  window.addEventListener('focus', () => { if (link.state !== 'ok' || Date.now() - link.lastMsg > WATCHDOG_MS) resume('window focused'); });
  setInterval(() => {
    if (document.visibilityState !== 'visible' || link.pending) return;
    if (Date.now() - Math.max(link.lastMsg, link.openedAt || 0) > WATCHDOG_MS) { scheduleReconnect(`no data for ${Math.round(WATCHDOG_MS / 1000)} s`); }
  }, Math.min(5000, Math.max(250, WATCHDOG_MS / 5)));
  function connectEvents() { openStream('start'); }

  // ---------- interactions ----------
  $('#destRow').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.dest) return run(api('POST', `/api/destinations/${b.dataset.dest}/toggle`));
    if (b.dataset.ctl === 'all') return run(api('POST', '/api/selection', { destinations: S.destinations.map((d) => d.key) }));
    if (b.dataset.ctl === 'none') return run(api('POST', '/api/selection', { destinations: [] }));
  });

  function renderHint() {
    const p = moveSrc != null && S && S.presets.find((x) => x.number === moveSrc);
    const h = mode === 'move' && p ? `<b>MOVE</b> · preset ${p.number} “${esc(p.name)}” picked. Tap where it goes: another tile swaps with it, an empty tile takes it. Tap it again (or Esc) to cancel.` : HINTS[mode];
    const el = $('#modeHint'); if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; el.className = `hint mode-hint m-${mode}`; }
  }
  let moveIdle = null;
  const MOVE_IDLE_MS = Number(window.RS6_MOVE_IDLE_MS) || 60000;
  function touchMove() { // MOVE mode ends by itself after a minute without a MOVE tap
    clearTimeout(moveIdle);
    if (mode === 'move') moveIdle = setTimeout(() => { if (mode === 'move') { setMode('recall'); toast('MOVE mode ended (idle): taps recall again'); } }, MOVE_IDLE_MS);
  }
  function setMode(m) {
    mode = m; moveSrc = null; touchMove();
    document.querySelectorAll('.mode[data-mode]').forEach((x) => x.classList.toggle('active', x.dataset.mode === m));
    render();
  }
  document.querySelectorAll('.mode[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#pager').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-page]'); if (!b) return;
    page = Number(b.dataset.page) || 0; localStorage.setItem('rs6.page', String(page)); render();
  });
  function swapTiles(a, b, undo = false) {
    touchMove();
    return run(api('POST', '/api/presets/swap', { a, b }).then((r) => {
      const msg = undo ? `Undone: ${a} ⇄ ${b}` : r.swapped ? `Swapped ${a} ⇄ ${b}` : `Moved ${a} → ${b}`;
      toast(msg);
      if (!undo) showUndo(msg, () => swapTiles(b, a, true));
    }));
  }
  // 0.5.0: every swap / move can be undone for a few seconds
  function showUndo(msg, fn) {
    const u = $('#undoBar'); u.innerHTML = `<span>${esc(msg)}</span><button class="btn mini" type="button">UNDO</button>`; u.hidden = false;
    u.querySelector('button').onclick = () => { u.hidden = true; clearTimeout(showUndo._t); fn(); };
    clearTimeout(showUndo._t); showUndo._t = setTimeout(() => { u.hidden = true; }, 8000);
  }

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
  // 0.4.0: drag a tile onto another tile to swap them, or onto an empty tile to move it. Mouse: in any mode,
  // after 6 px. Touch / pen: in MOVE mode (elsewhere a touch drag scrolls the page and a long-press renames).
  let tdrag = null; let tileDragDone = false;
  $('#grid').addEventListener('pointerdown', (ev) => {
    const b = ev.target.closest('[data-preset]'); if (!b || armed || ev.button > 0) return;
    if (ev.pointerType !== 'mouse' && mode !== 'move') return;
    tdrag = { n: Number(b.dataset.preset), el: b, x0: ev.clientX, y0: ev.clientY, id: ev.pointerId, started: false, hover: null };
  });
  const tileAt = (x, y) => { const el = document.elementFromPoint(x, y); const t = el && el.closest('#grid [data-drop-preset]'); return t; };
  function tdragMove(ev) {
    const d = tdrag; d.x = ev.clientX; d.y = ev.clientY;
    const g = $('#ghost'); g.style.left = `${d.x}px`; g.style.top = `${d.y}px`;
    const t = tileAt(d.x, d.y);
    if (d.hover && d.hover !== t) d.hover.classList.remove('swap-hover');
    if (t && Number(t.dataset.dropPreset) !== d.n) { t.classList.add('swap-hover'); d.hover = t; } else d.hover = null;
  }
  window.addEventListener('pointermove', (ev) => {
    const d = tdrag; if (!d || ev.pointerId !== d.id) return;
    if (!d.started) {
      if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < (ev.pointerType === 'mouse' ? 14 : 8)) return; // 0.5.0: a sloppy click is not a drag
      d.started = true; if (lp) { clearTimeout(lp.t); lp = null; }
      d.el.classList.add('dragsrc'); document.body.classList.add('dragging', 'tile-dragging');
      const p = S.presets.find((x) => x.number === d.n);
      const g = $('#ghost'); g.textContent = `⇄ ${d.n} · ${p ? p.name : ''}`; g.hidden = false;
      d.scroll = setInterval(() => { if (!tdrag || !tdrag.started) return; const h = window.innerHeight; const v = tdrag.y > h - 70 ? 14 : tdrag.y < 70 ? -14 : 0; if (v) window.scrollBy(0, v); }, 30);
    }
    ev.preventDefault(); tdragMove(ev);
  }, { passive: false });
  function tdragEnd(ev, cancel) {
    const d = tdrag; if (!d || (ev && ev.pointerId !== d.id)) return;
    tdrag = null;
    if (!d.started) return;
    clearInterval(d.scroll); d.el.classList.remove('dragsrc'); document.body.classList.remove('dragging', 'tile-dragging'); $('#ghost').hidden = true;
    if (d.hover) d.hover.classList.remove('swap-hover');
    tileDragDone = true; setTimeout(() => { tileDragDone = false; }, 0); // swallow the click that follows
    if (cancel) return;
    const t = tileAt(ev.clientX, ev.clientY); const to = t && Number(t.dataset.dropPreset);
    if (to && to !== d.n) { moveSrc = null; swapTiles(d.n, to); }
  }
  window.addEventListener('pointerup', (ev) => tdragEnd(ev, false));
  window.addEventListener('pointercancel', (ev) => tdragEnd(ev, true));
  document.addEventListener('touchmove', (e) => { if (tdrag && tdrag.started) e.preventDefault(); }, { passive: false });

  $('#grid').addEventListener('click', (ev) => {
    if (lpFired) { lpFired = false; ev.preventDefault(); return; } // the long-press already renamed
    if (tileDragDone) { ev.preventDefault(); return; } // a tile drag just ended: no recall
    const b = ev.target.closest('button'); if (!b) return;
    const n = Number(b.dataset.preset || b.dataset.empty);
    if (armed) { const m = armed; armed = null; palSig = ''; renderPalette(); applyArmed(); return assignPreset(n, m); }
    if (mode === 'move') {
      touchMove();
      if (moveSrc == null) { if (b.dataset.preset) { moveSrc = n; render(); } else toast('Tap a preset first, then where it goes'); return; }
      const from = moveSrc; moveSrc = null; render();
      if (from !== n) swapTiles(from, n);
      return;
    }
    if (mode === 'recall') { if (b.dataset.preset) run(api('POST', `/api/presets/${n}/recall`)); return; }
    if (mode === 'save') return openSave(n, !!b.dataset.preset);
    if (mode === 'edit' && b.dataset.preset) return openEdit(n);
  });

  // 0.4.0: INPUTS / BACKUP / AUDIO / WEB RCS hide everything that belongs to presets (screen tiles, TAKE / CUT,
  // the PVW line) and use the full width. body.tab-<name> drives the CSS.
  // 0.6.0: + the SYSTEMS dashboard and the shared E2 / PixelHue tabs (public/sys.js renders those)
  const TABS = ['presets', 'inputs', 'backup', 'audio', 'webrcs', 'system', 'xpresets', 'xcues', 'xsources', 'xstills', 'xbackup', 'atem', 'aaux', 'amacros', 'pctl', 'pcams'];
  function setTab(t) {
    tab = TABS.includes(t) ? t : 'presets';
    window.dispatchEvent(new CustomEvent('cc:tab', { detail: tab }));
    // 0.5.0 fix: MOVE (and SAVE) used to stay on across tab switches, so taps meant as RECALL on the way back
    // picked and moved tiles ("the presets are re ordered"). Leaving PRESETS always returns to RECALL.
    if (tab !== 'presets' && (mode === 'move' || mode === 'save')) setMode('recall');
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    for (const x of TABS) $(`#pane-${x}`).hidden = x !== tab;
    for (const x of TABS) document.body.classList.toggle(`tab-${x}`, x === tab);
    if (tab === 'webrcs') openRcs(false);
    render();
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { window.__ccTabClicked = true; setTab(b.dataset.tab); }));
  // A grouped tab whose system is on the desk but not the one in focus: focus it, without taking the others off.
  document.querySelector('nav.tabs').addEventListener('click', (ev) => {
    const tab = ev.target.closest('.tab[data-owner]'); const focus = ev.target.closest('[data-focus]');
    const sys = tab ? tab.dataset.owner : focus ? focus.dataset.focus : '';
    const st = window.CCSYS && window.CCSYS.state();
    if (!sys || !st || sys === 'preset' || sys === st.active || !(st.armed || []).includes(sys)) return;
    window.CC.run(window.CC.api('POST', '/api/sys/active', { system: sys }));
  });
  document.body.classList.add('tab-presets');
  // 0.6.0: shared helpers for public/sys.js
  window.CC = { setTab, getTab: () => tab, api, toast, run, esc };

  // ---------- 0.4.0 Web RCS pane ----------
  // The device's Web RCS is loaded straight from the device in an <iframe> (the RS6 sends no X-Frame-Options or
  // CSP frame-ancestors, and its WebSocket goes to the page's own host, so nothing needs proxying). The app
  // server checks the headers once per open (GET /api/webrcs); if a unit ever refuses framing, the pane says why
  // and offers a separate window instead.
  let rcs = { loaded: false, info: null, url: '' };
  const loop = (h) => /^(127\.|localhost$|\[?::1\]?$)/.test(h);
  function rcsUrlFor(u0) {
    const u = new URL(u0);
    // a Simulator on the app's own computer (127.0.0.1) is that computer's address for a tablet / another PC
    if (loop(u.hostname) && !loop(location.hostname)) u.hostname = location.hostname;
    return u.toString();
  }
  async function openRcs(force) {
    let info;
    try { info = await api('GET', '/api/webrcs'); } catch (e) { info = { url: '', error: e.message }; }
    rcs.info = info; rcs.url = info.url ? rcsUrlFor(info.url) : '';
    $('#rcsUrl').textContent = rcs.url ? `${rcs.url}${info.mock ? ' · mock placeholder' : ''}` : '';
    const st = $('#rcsStatus'); const blocked = $('#rcsBlocked');
    const mixed = location.protocol === 'https:' && rcs.url.startsWith('http:');
    if (info.framable === false || mixed) {
      blocked.hidden = false; $('#rcsWrap').hidden = true; st.className = 'rcs-status bad'; st.textContent = 'CAN\'T EMBED';
      blocked.innerHTML = `The device refuses to be shown inside another page (${esc(mixed ? 'this app is on HTTPS and the Web RCS is HTTP' : (info.blockedBy || []).join(', '))}). Open it next to the app instead: <button class="btn primary" data-rcs="side">⇱ Open side by side</button>`;
      return;
    }
    blocked.hidden = true; $('#rcsWrap').hidden = false;
    st.className = 'rcs-status ' + (info.reachable === false ? 'warn' : 'ok');
    st.textContent = info.reachable === false ? `APP CAN'T REACH IT (${(info.error || '').slice(0, 40)})` : 'EMBEDDED';
    st.title = info.reachable === false ? 'The app server could not reach the device web port; this browser may still reach it.' : `Headers checked: X-Frame-Options ${info.xFrameOptions || 'none'}, CSP frame-ancestors ${info.frameAncestors || 'none'}`;
    if (rcs.url && (force || !rcs.loaded || $('#rcsFrame').dataset.src !== rcs.url)) { $('#rcsFrame').src = rcs.url; $('#rcsFrame').dataset.src = rcs.url; rcs.loaded = true; }
  }
  function rcsSide() {
    if (!rcs.url) return;
    const sw = screen.availWidth || 1440; const sh = screen.availHeight || 900;
    const w = Math.max(640, Math.floor(sw / 2)); const left = (screen.availLeft || 0) + sw - w;
    const win = window.open(rcs.url, 'rs6webrcs', `popup=yes,width=${w},height=${sh},left=${left},top=${screen.availTop || 0}`);
    if (!win) toast('The browser blocked the pop-up: allow pop-ups for this page, or use ↗ New tab', true);
    else toast('Web RCS opened on the right half of the screen: put this window on the left half');
  }
  $('#rcsReload').addEventListener('click', () => openRcs(true));
  $('#rcsSide').addEventListener('click', () => rcsSide());
  $('#rcsTab').addEventListener('click', () => { if (rcs.url) window.open(rcs.url, '_blank', 'noopener'); });
  $('#rcsUnload').addEventListener('click', () => { $('#rcsFrame').src = 'about:blank'; $('#rcsFrame').dataset.src = ''; rcs.loaded = false; toast('Web RCS unloaded from the pane'); });
  $('#rcsBlocked').addEventListener('click', (e) => { if (e.target.dataset.rcs === 'side') rcsSide(); });
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
  const setLog = (open) => { $('#logwrap').classList.toggle('collapsed', !open); localStorage.setItem('rs6.logOpen', open ? '1' : ''); const box = $('#log'); if (open) box.scrollTop = box.scrollHeight; };
  $('#logToggle').addEventListener('click', (e) => { if (e.target.id !== 'logClear') setLog($('#logwrap').classList.contains('collapsed')); });
  setLog(!!localStorage.getItem('rs6.logOpen'));
  $('#logClear').addEventListener('click', () => { $('#log').innerHTML = ''; $('#logCount').textContent = ''; });

  // keyboard: Space/Enter = TAKE, C = CUT
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (tab !== 'presets') return; // 0.4.0: TAKE / CUT keys only where TAKE / CUT is shown (sys.js: xpresets)
    if (e.key === 'Escape' && moveSrc != null) { moveSrc = null; render(); return; }
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
    if (!S.selection.length) return toast('Light at least one screen above first: SAVE stores what the lit screens have on Preview', true);
    const p = S.presets.find((x) => x.number === n);
    const f = $('#formSave');
    $('#saveTitle').textContent = exists ? `Overwrite tile ${n} with what is on Preview?` : `Save Preview to tile ${n}`;
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
    f.elements.tileCount.value = String(s.tileCount || 48);
    $('#dataDirPath').textContent = (S && S.dataDir) || '';
    $('#dataDirMig').textContent = S && S.dataMigration && S.dataMigration.migrated ? `· copied from ${S.dataMigration.from} on first start` : '';
    f.elements.password.value = ''; f.elements.password.placeholder = s.passwordSet ? '•••••• (unchanged)' : 'none'; f.elements.clearPassword.checked = false;
    $('#mockNote').hidden = !s.mock;
    $('#dlgSettings').showModal();
  }
  $('#btnSettings').addEventListener('click', () => run(openSettings()));
  $('#dlgSettings').addEventListener('close', () => {
    if ($('#dlgSettings').returnValue !== 'save') return;
    const f = $('#formSettings'); const b = {};
    for (const k of ['host', 'protocol']) b[k] = f.elements[k].value.trim();
    for (const k of ['restPort', 'awjPort', 'maxScreens', 'maxAux', 'maxLayers', 'pollMs', 'maxInputs', 'screenMemoryLabels', 'tileCount']) b[k] = Number(f.elements[k].value);
    for (const k of ['https', 'awjReadback', 'presetToggle', 'liveEnabled', 'memoryProbe']) b[k] = f.elements[k].checked;
    if (f.elements.clearPassword.checked) b.password = ''; else if (f.elements.password.value) b.password = f.elements.password.value;
    run(api('POST', '/api/settings', b).then((st) => toast(st.connected ? 'Connected' : 'Saved, but not connected', !st.connected)));
  });
  // ---------- 0.5.0 show files ----------
  const fmtTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  async function openShows() {
    const r = await api('GET', '/api/shows');
    $('#shCurName').textContent = r.current.name;
    $('#shCurState').textContent = r.current.dirty ? '● unsaved changes' : r.current.inLibrary ? `saved ${fmtTime(r.current.savedAt)}` : '';
    $('#shDir').textContent = r.dir;
    const row = (x, bk) => `<div class="show-row ${!bk && x.id === r.current.id ? 'cur' : ''}" data-id="${esc(x.id)}" data-bk="${bk ? 1 : ''}">
      <div class="sh-main"><b>${esc(x.name || x.id)}</b><small>${x.error ? 'unreadable file' : `${x.presets ?? '?'} presets · ${x.tileCount || '?'} tiles${x.hasConnection ? ` · ${esc(x.host)}` : ''}${x.hasPassword ? ' · 🔑 password' : ''} · ${fmtTime(x.savedAt || x.modified)}`}</small></div>
      <button type="button" class="btn mini" data-sh="open">OPEN</button>
      ${bk ? '' : '<button type="button" class="btn mini" data-sh="rename">RENAME</button><button type="button" class="btn mini" data-sh="duplicate">DUPLICATE</button>'}
      <button type="button" class="btn mini" data-sh="download" title="Download the .rs6show file">⤓</button>
      <button type="button" class="btn mini danger" data-sh="delete">DELETE</button></div>`;
    $('#shList').innerHTML = r.shows.length ? r.shows.map((x) => row(x, false)).join('') : '<div class="note small">No saved shows yet. SAVE puts the current one here.</div>';
    $('#shBkList').innerHTML = r.backups.length ? r.backups.map((x) => row(x, true)).join('') : '<div class="note small">None yet.</div>';
    $('#shBackups').querySelector('summary').textContent = `Automatic backups (${r.backups.length}, made before a show is opened)`;
    if (!$('#dlgShows').open) $('#dlgShows').showModal();
  }
  $('#btnShow').addEventListener('click', () => run(openShows()));
  $('#btnSettingsShows').addEventListener('click', () => { $('#dlgSettings').close('cancel'); run(openShows()); });
  $('#shConn').addEventListener('change', () => { $('#shPass').disabled = !$('#shConn').checked; if (!$('#shConn').checked) $('#shPass').checked = false; $('#shPassWarn').hidden = !$('#shPass').checked; });
  $('#shPass').addEventListener('change', () => {
    if ($('#shPass').checked && !confirm('Include the Web RCS password in the show file?\n\nIt is stored in plain text: anyone who gets the file can read it.')) $('#shPass').checked = false;
    $('#shPassWarn').hidden = !$('#shPass').checked;
  });
  const saveOpts = () => ({ includeConnection: $('#shConn').checked, includePassword: $('#shConn').checked && $('#shPass').checked });
  $('#shSave').addEventListener('click', () => run(api('POST', '/api/shows/save', saveOpts()).then((r) => { toast(`Saved show "${r.name}"`); return openShows(); })));
  $('#shSaveAs').addEventListener('click', () => {
    const name = prompt('Save the show as:', S && S.show ? S.show.name : ''); if (name === null || !name.trim()) return;
    run(api('POST', '/api/shows/save', { ...saveOpts(), name: name.trim(), asNew: true }).then((r) => { toast(`Saved show "${r.name}"`); return openShows(); }));
  });
  $('#shNew').addEventListener('click', () => {
    if (!confirm(`Start a new, empty show?\n\nAll presets are cleared from the app (the RS6 is not touched). The current state "${S.show.name}" is backed up first${S.show.dirty ? ' (it has unsaved changes)' : ''}.`)) return;
    const name = prompt('Name of the new show:', 'Untitled show'); if (name === null) return;
    run(api('POST', '/api/shows/new', { name }).then((r) => { toast(`New show "${r.name}"`); return openShows(); }));
  });
  $('#shExport').addEventListener('click', () => {
    const o = saveOpts(); location.href = `/api/show/export?connection=${o.includeConnection ? 1 : 0}&password=${o.includePassword ? 1 : 0}`;
  });
  $('#shUpload').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (!file) return;
    const content = await file.text();
    run(api('POST', '/api/shows/upload', { content }).then(async (r) => {
      toast(`Added "${r.name}" to the library${r.migratedFrom ? ` (converted from ${r.migratedFrom})` : ''}`);
      await openShows();
      if (confirm(`Open "${r.name}" now?`)) await openShowFlow({ id: r.id });
    }));
  });
  // Open: confirm, ask about a different connection, open (app config only), then reconnect only if chosen.
  async function openShowFlow(ref) {
    const pv = await api('POST', '/api/shows/preview', ref);
    const cur = S && S.show;
    const lines = [`Open show "${pv.name}"? (${pv.presets} presets, ${pv.tileCount} tiles${pv.savedAt ? `, saved ${fmtTime(pv.savedAt)}` : ''})`,
      '', `It replaces the current show "${cur ? cur.name : ''}"${cur && cur.dirty ? ', which has UNSAVED changes' : ''}. A backup of the current state is made first.`,
      'Nothing is sent to the RS6.'];
    if (pv.warnings && pv.warnings.length) lines.push('', 'Notes: ' + pv.warnings.join('; '));
    if (!confirm(lines.join('\n'))) return;
    let applyConnection = false;
    if (pv.connectionDiffers && !(S && S.mock)) {
      applyConnection = confirm(`This show was saved for the device at ${pv.connection.host}:${pv.connection.restPort}; the app is set to ${pv.current.host}:${pv.current.restPort}.\n\nOK = switch to ${pv.connection.host} and reconnect\nCancel = keep the current connection`);
    }
    const r = await api('POST', '/api/shows/open', { ...ref, applyConnection });
    toast(`Opened "${r.name}"`);
    if (r.connectionChanged) await api('POST', '/api/connect');
    if ($('#dlgShows').open) await openShows();
  }
  $('#dlgShows').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sh]'); if (!b) return;
    const rowEl = b.closest('.show-row'); const id = rowEl.dataset.id; const bk = !!rowEl.dataset.bk; const act = b.dataset.sh;
    const name = rowEl.querySelector('b').textContent;
    if (act === 'open') return run(openShowFlow({ id, backup: bk }));
    if (act === 'download') { location.href = `/api/shows/${encodeURIComponent(id)}/file${bk ? '?backup=1' : ''}`; return; }
    if (act === 'rename') { const n = prompt('Rename show:', name); if (n === null || !n.trim()) return; return run(api('POST', `/api/shows/${encodeURIComponent(id)}/rename`, { name: n.trim() }).then(openShows)); }
    if (act === 'duplicate') { const n = prompt('Name of the copy:', `${name} copy`); if (n === null) return; return run(api('POST', `/api/shows/${encodeURIComponent(id)}/duplicate`, { name: n.trim() }).then(openShows)); }
    if (act === 'delete') { if (!confirm(`Delete ${bk ? 'the backup' : 'the show'} "${name}" from the library? This can't be undone.`)) return; return run(api('DELETE', `/api/shows/${encodeURIComponent(id)}${bk ? '?backup=1' : ''}`).then(openShows)); }
  });

  if (location.pathname === '/settings') run(openSettings());

  api('GET', '/api/log').then((l) => l.forEach(addLog)).catch(() => {});
  $('#btnReconnect').addEventListener('click', () => { link.attempt = 0; openStream('manual'); refetchState(); });
  connectEvents();
})();
