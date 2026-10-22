'use strict';
// 0.6.0 Control Center: the SYSTEMS dashboard and the shared switcher UI for every system behind the common driver
// interface (E2 / PixelHue today). RS6 keeps its own tabs (public/app.js). State arrives as the `sys` event on the
// same event stream app.js opens (window 'cc:sys'), and from GET /api/sys.
(() => {
  const $ = (s) => document.querySelector(s);
  const CC = window.CC;
  const { api, toast, run, esc } = CC;
  const PAGE = 24;
  let SYS = null; let V = null; let mode = 'recall'; let moveSrc = null; let page = Number(localStorage.getItem('cc.xpage') || 0) || 0;
  let landed = false; const html = {};
  const set = (el, key, h) => { if (html[key] !== h) { html[key] = h; el.innerHTML = h; } };
  const base = () => `/api/sys/${SYS.active}`;
  const isX = () => SYS && SYS.active !== 'rs6';
  const MONO = { rs6: 'AW', e2: 'EM', pixelhue: 'PH', atem: 'AT', ptz: 'PTZ' };
  const XTABS = ['xpresets', 'xcues', 'xsources', 'xstills', 'xbackup'];
  const RS6TABS = ['presets', 'inputs', 'backup', 'audio', 'webrcs'];
  const HINTS = {
    recall: '<b>RECALL → PVW</b> · tap a tile to recall that preset to <b>Preview</b> on the destinations stored in it, then TAKE or CUT the selected destinations.',
    program: '<b>RECALL → PGM</b> · tap a tile to recall straight to <b>Program</b>, without a transition. The app asks first.',
    move: '<b>MOVE</b> · tap a tile, then another tile to <b>swap</b> them or an empty tile to <b>move</b> it. Only the app\'s layout changes.',
  };

  function statusOf(s) {
    if (!s) return { cls: 'off', txt: 'UNKNOWN' };
    const st = s.status || {};
    const conf = s.key === 'rs6' ? !!(s.connection && s.connection.host) : !!(s.connection && s.connection.host);
    if (!conf) return { cls: 'idle', txt: 'NOT CONFIGURED' };
    if (st.connected) return { cls: 'ok', txt: 'ONLINE' };
    return { cls: 'off', txt: 'OFFLINE' };
  }
  const ver = (v) => (v && typeof v === 'object' ? `${v.major}.${v.minor}.${v.patch}` : v || '');

  // ---------- system switch / chrome ----------
  function applyChrome() {
    const a = SYS.active; const sysInfo = SYS.systems[a];
    for (const k of ['rs6', 'e2', 'pixelhue']) document.body.classList.toggle(`sys-${k}`, k === a);
    document.body.classList.toggle('sys-x', isX());
    const st = statusOf(sysInfo);
    $('#sysBadgeName').textContent = sysInfo.short; $('#btnSystem').className = `sys-badge ${st.cls}`;
    $('#btnSystem').title = `${sysInfo.label} · ${st.txt} · tap for the SYSTEMS dashboard`;
    document.querySelectorAll('.xsys').forEach((e) => { e.textContent = sysInfo.short; });
    if (isX() && V) {
      const caps = V.capabilities || {};
      document.querySelectorAll('.tab.x-only').forEach((t) => { t.hidden = !caps[t.dataset.cap]; });
      const c = $('#xconn'); const s = V.status || {};
      c.className = `pill x-only ${s.connected ? 'ok' : 'off'}`;
      c.innerHTML = (s.connected ? `${esc(sysInfo.short)} ${esc((s.info && s.info.model) || '')} ${esc(ver(s.info && s.info.version))} · ${esc(V.connection.host)}` : `${esc(sysInfo.short)} not connected${s.error ? ' · ' + esc(s.error).slice(0, 50) : V.connection.host ? '' : ' · set its IP on SYSTEMS'}`) + (V.connection.mock ? '<span class="mock">MOCK</span>' : '');
      $('#xlast').textContent = V.lastRecalled ? `PVW: ${V.lastRecalled.number} · ${V.lastRecalled.name}` : 'PVW: —';
    }
    // the current tab must belong to the active system
    const tab = CC.getTab();
    if (isX() && RS6TABS.includes(tab)) CC.setTab('xpresets');
    else if (!isX() && XTABS.includes(tab)) CC.setTab('presets');
    else if (isX() && V && XTABS.includes(tab)) { const t = document.querySelector(`.tab[data-tab=${tab}]`); if (t && t.hidden) CC.setTab('xpresets'); }
    if (!landed) { // landing: the dashboard when the selected system is not online, else straight to its presets
      landed = true;
      if (!window.__ccTabClicked && statusOf(sysInfo).cls !== 'ok') CC.setTab('system');
    }
  }

  // ---------- dashboard ----------
  function connForm(s) {
    const c = s.connection || {}; const dis = c.mock ? 'disabled' : '';
    if (s.key === 'rs6') {
      return `<div class="conn-ro"><span>Host <b>${esc(c.host || '—')}</b></span><span>REST <b>${esc(c.restPort)}</b></span><span>AWJ <b>${esc(c.awjPort)}</b></span><span>via <b>${esc((c.protocol || 'rest').toUpperCase())}</b></span></div>
        <div class="actions left"><button type="button" class="btn mini" data-rs6set="1">RS6 CONNECTION &amp; SETTINGS…</button></div>`;
    }
    const f = (name, label, type, val, ph, extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" ${dis} ${extra}></label>`;
    const extra = s.key === 'e2'
      ? f('operatorId', 'Operator (multi-op)', 'text', c.operatorId, 'none', 'inputmode="numeric"') + f('transTime', 'TAKE time (frames)', 'text', c.transTime, 'device default', 'inputmode="numeric"')
      : f('prefix', 'API path prefix', 'text', c.prefix, '/pixelhue') + f('time', 'TAKE time (ms)', 'text', c.time, 'device default', 'inputmode="numeric"');
    return `<form class="form conn-form" data-sys="${s.key}">
      <div class="row2">${f('host', 'IP address', 'text', c.host, s.key === 'e2' ? 'E2 host unit IP' : 'switcher IP', 'autocomplete="off" spellcheck="false"')}${f('port', 'Port', 'number', c.port, s.key === 'e2' ? '9999' : '8088', 'min="1" max="65535"')}</div>
      <div class="row2">${extra}</div>
      ${s.key === 'pixelhue' ? `<label class="chk"><input type="checkbox" name="swap" ${c.swap ? 'checked' : ''} ${dis}> Swap on TAKE / CUT (Program goes back to Preview)</label>` : ''}
      <div class="actions left">${c.mock ? '<span class="note small">Mock mode: connected to the built-in mock, fixed.</span>' : '<button class="btn mini primary" value="save">SAVE &amp; CONNECT</button>'}
      <button type="button" class="btn mini" data-reconnect="${s.key}" ${c.host ? '' : 'disabled'}>⟳ RECONNECT</button></div>
    </form>`;
  }
  function renderDash() {
    const clock = $('#dashClock'); if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cards = Object.values(SYS.systems).map((s) => {
      const st = statusOf(s); const active = SYS.active === s.key; const info = (s.status && s.status.info) || {}; const n = s.counts || {};
      const stats = [['PRESETS', n.presets], ['DESTINATIONS', n.destinations], ['SOURCES', n.sources]].concat(s.key === 'e2' ? [['CUES', n.cues]] : [])
        .map(([k, v]) => `<div class="stat"><b>${v ?? '—'}</b><span>${k}</span></div>`).join('');
      return `<article class="sys-card ${active ? 'active' : ''} ${st.cls}" data-card="${s.key}">
        <header><div class="mono">${MONO[s.key]}</div><div class="ttl"><div class="nm">${esc(s.label)}</div>
          <div class="st"><span class="led ${st.cls}"></span>${st.txt}${info.model ? ` · ${esc(info.model)} ${esc(ver(info.version))}` : ''}${s.connection && s.connection.mock ? ' <span class="mock">MOCK</span>' : ''}</div></div>
          ${active ? '<span class="badge-active">ACTIVE</span>' : `<button type="button" class="btn mini primary" data-use="${s.key}">USE THIS SYSTEM</button>`}</header>
        ${s.status && s.status.error && st.cls === 'off' ? `<div class="err small">${esc(s.status.error).slice(0, 140)}</div>` : ''}
        <div class="stats">${stats}</div>
        ${active ? `<div class="actions left"><button type="button" class="btn mini" data-open="${s.key}">OPEN PRESETS →</button></div>` : ''}
        <details ${!s.connection || !s.connection.host ? 'open' : ''}><summary>Connection</summary>${connForm(s)}</details>
      </article>`;
    }).join('');
    // keep a focused connection form from being replaced while typing
    if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('#sysCards')) set($('#sysCards'), 'cards', cards);
    set($('#sysPlanned'), 'planned', (SYS.planned || []).map((p) => `<article class="sys-card planned"><header><div class="mono">${MONO[p.key] || '?'}</div><div class="ttl"><div class="nm">${esc(p.label)}</div><div class="st"><span class="led idle"></span>${esc(p.kind)} · NOT BUILT</div></div><span class="badge-stub">STUB</span></header><div class="note small">${esc(p.note)}</div></article>`).join(''));
  }
  $('#sysCards').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.use) return run(api('POST', '/api/sys/active', { system: b.dataset.use }).then((st) => { onSys(st); toast(`Now driving: ${st.systems[st.active].label}`); }));
    if (b.dataset.open) return CC.setTab(b.dataset.open === 'rs6' ? 'presets' : 'xpresets');
    if (b.dataset.rs6set) return $('#btnSettings').click();
    if (b.dataset.reconnect) return run(api('POST', `/api/sys/${b.dataset.reconnect}/connect`).then(() => toast('Connected')));
  });
  $('#sysCards').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target; const k = f.dataset.sys; const b = {};
    for (const n of ['host', 'operatorId', 'transTime', 'prefix', 'time']) if (f.elements[n]) b[n] = f.elements[n].value.trim();
    if (f.elements.port) b.port = Number(f.elements.port.value) || undefined;
    if (f.elements.swap) b.swap = f.elements.swap.checked;
    if (document.activeElement) document.activeElement.blur();
    run(api('POST', `/api/sys/${k}/connection`, b).then(() => (b.host ? api('POST', `/api/sys/${k}/connect`) : null)).then((r) => toast(r ? 'Saved and connected' : 'Saved')).finally(refetch));
  });

  // ---------- presets ----------
  function renderPresets() {
    if (!V) return;
    const dims = $('#xDim').checked;
    const nd = V.destinations.length;
    const cols = `repeat(${1 + nd}, minmax(var(--colmin), 1fr))`;
    if ($('#xdestRow').style.getPropertyValue('--cols') !== cols) { $('#xdestRow').style.setProperty('--cols', cols); $('#xdestRow').style.gridTemplateColumns = cols; }
    set($('#xdestRow'), 'dest', `<div class="dest ctlcell"><button class="ctl" data-ctl="all">ALL</button><button class="ctl" data-ctl="none">CLEAR</button></div>` + V.destinations.map((d) => `
      <button class="dest ${d.selected ? 'on' : ''}" data-dest="${d.key}" title="${esc(d.label)}${d.size ? ' · ' + d.size : ''}">
        <span class="k">${d.kind === 'screen' ? 'SCREEN' : 'AUX'} ${d.key.slice(1)}</span><span class="l">${esc(d.label)}</span>
        <span class="tl">${d.pgmPreset ? `<span class="p">PGM ${esc(d.pgmPreset.number)}</span>` : ''}${d.pvwPreset ? `<span class="v">PVW ${esc(d.pvwPreset.number)}</span>` : ''}</span></button>`).join('')
      + (nd ? '' : `<div class="note" style="grid-column:2 / -1">${V.status.connected ? 'The device reports no destinations.' : 'Not connected. Set the connection on ⌂ SYSTEMS.'}</div>`));
    const maxT = Math.max(0, ...V.presets.map((p) => p.tile));
    const slots = Math.max(V.tileCount || 48, Math.ceil((maxT + (mode === 'move' ? 4 : 0)) / 8) * 8);
    const pages = Math.ceil(slots / PAGE); if (page > pages) page = 0;
    const pagerHtml = pages > 1 ? [`<button class="pg ${page === 0 ? 'on' : ''}" data-page="0">ALL</button>`].concat(Array.from({ length: pages }, (_, i) => {
      const lo = i * PAGE + 1; const hi = Math.min(slots, (i + 1) * PAGE); const used = V.presets.filter((p) => p.tile >= lo && p.tile <= hi).length;
      return `<button class="pg ${page === i + 1 ? 'on' : ''}" data-page="${i + 1}">${lo}–${hi}${used ? `<small>${used}</small>` : ''}</button>`;
    })).join('') : '';
    const pg = $('#xpager'); set(pg, 'pager', pagerHtml); pg.hidden = !pagerHtml;
    const byTile = new Map(V.presets.map((p) => [p.tile, p]));
    const from = page ? (page - 1) * PAGE + 1 : 1; const to = page ? Math.min(slots, page * PAGE) : slots;
    const label = (k) => { const d = V.destinations.find((x) => x.key === k); return d ? d.label : k; };
    let h = '';
    for (let n = from; n <= to; n++) {
      const p = byTile.get(n);
      if (!p) { h += `<button class="preset empty" data-empty="${n}"><span class="num">${n}</span>${mode === 'move' && moveSrc != null ? '<span>move here</span>' : ''}</button>`; continue; }
      const cls = ['preset']; const tags = [];
      if (p.tally.pgm !== 'none') { if (p.tally.pgm === 'full') cls.push('pgm'); tags.push(`<span class="tag pgm ${p.tally.pgm === 'partial' ? 'part' : ''}">PGM</span>`); }
      if (p.tally.pvw !== 'none') { if (p.tally.pvw === 'full') cls.push('pvw'); tags.push(`<span class="tag pvw ${p.tally.pvw === 'partial' ? 'part' : ''}">PVW</span>`); }
      if (p.lastRecalled) cls.push('is-last'); if (dims && p.dim) cls.push('dim'); if (moveSrc === n) cls.push('move-src'); if (p.locked) cls.push('locked');
      const chips = p.dests ? (p.dests.map((d) => `<span class="chip ${d[0] === 'A' ? 'aux' : ''}" title="${esc(label(d))}">${d}</span>`).join('') || '<span class="chip warn">no destinations</span>') : '<span class="chip">destinations unknown</span>';
      const num = p.sno && !/\.00$/.test(p.sno) ? p.sno : p.number;
      h += `<button class="${cls.join(" ")}" data-preset="${n}" data-key="${esc(p.key)}" title="${esc(V.short)} preset ${esc(num)} · ${esc(p.name)}${p.dests ? ' · ' + esc(p.dests.join(', ')) : ''}"><span class="tags">${tags.join('')}</span><span class="num">${n}${String(num) !== String(n) ? ` <small class="devnum">#${esc(num)}</small>` : ''}</span><span class="name">${esc(p.name)}</span><span class="chips">${chips}</span></button>`;
    }
    set($('#xgrid'), 'grid', h);
    const g = `grid mode-${mode === 'program' ? 'recall' : mode}${moveSrc != null ? ' has-src' : ''}`; if ($('#xgrid').className !== g) $('#xgrid').className = g;
    $('#xmodeHint').innerHTML = HINTS[mode] + (V.capabilities.armDestinations ? ' <span class="small">E2: the selected destinations are <b>armed</b> on the processor; TAKE / CUT run on the armed ones.</span>' : '');
    document.querySelectorAll('[data-xmode]').forEach((b) => b.classList.toggle('active', b.dataset.xmode === mode));
    const tg = V.selection; const txt = tg.length ? tg.join(' · ') : 'nothing selected';
    for (const [id, w] of [['#xTake', 'TAKE'], ['#xCut', 'CUT']]) { const b = $(id); b.disabled = !tg.length || !V.status.connected; if (b.dataset.tg !== txt) { b.dataset.tg = txt; b.innerHTML = `${w}<small>${esc(txt)}</small>`; } }
    const a = $('#xAuto'); a.classList.toggle('on', V.autoTake); a.innerHTML = `AUTO TAKE<br><b>${V.autoTake ? 'ON' : 'OFF'}</b>`;
    const xt = $('#xtargetsX'); xt.textContent = tg.length ? `TAKE / CUT → ${tg.join(', ')}` : 'TAKE / CUT → nothing selected'; xt.classList.toggle('none', !tg.length);
  }
  $('#xdestRow').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b || !V) return;
    if (b.dataset.dest) return run(api('POST', `${base()}/destinations/${b.dataset.dest}/toggle`));
    if (b.dataset.ctl) return run(api('POST', `${base()}/selection`, { destinations: b.dataset.ctl === 'all' ? V.destinations.map((d) => d.key) : [] }));
  });
  document.querySelectorAll('[data-xmode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.xmode; moveSrc = null; renderPresets(); }));
  $('#xDim').addEventListener('change', () => { localStorage.setItem('cc.xdim', $('#xDim').checked ? '1' : '0'); renderPresets(); });
  $('#xDim').checked = localStorage.getItem('cc.xdim') !== '0';
  $('#xpager').addEventListener('click', (ev) => { const b = ev.target.closest('[data-page]'); if (!b) return; page = Number(b.dataset.page); localStorage.setItem('cc.xpage', String(page)); renderPresets(); });
  $('#xgrid').addEventListener('click', (ev) => {
    const b = ev.target.closest('button.preset'); if (!b || !V) return;
    const n = Number(b.dataset.preset || b.dataset.empty);
    if (mode === 'move') {
      if (moveSrc == null) { if (b.dataset.preset) { moveSrc = n; renderPresets(); } return; }
      if (moveSrc === n) { moveSrc = null; renderPresets(); return; }
      const a = moveSrc; moveSrc = null;
      return run(api('POST', `${base()}/presets/swap`, { a, b: n }).then((r) => toast(r.swapped ? `Swapped ${a} ⇄ ${n}` : `Moved ${a} → ${n}`)));
    }
    if (!b.dataset.key) return;
    const p = V.presets.find((x) => x.key === b.dataset.key);
    if (mode === 'program' && !confirm(`Recall "${p.name}" straight to PROGRAM on ${p.dests ? p.dests.join(', ') : 'its destinations'}? This goes live without a transition.`)) return;
    run(api('POST', `${base()}/presets/${encodeURIComponent(p.key)}/recall`, { target: mode === 'program' ? 'program' : 'preview' }));
  });
  $('#xTake').addEventListener('click', () => run(api('POST', `${base()}/take`)));
  $('#xCut').addEventListener('click', () => run(api('POST', `${base()}/cut`)));
  $('#xAuto').addEventListener('click', () => run(api('POST', `${base()}/autotake`, {})));
  $('#xRefresh').addEventListener('click', () => run(api('POST', `${base()}/refresh`).then(() => toast('Refreshed'))));
  document.addEventListener('keydown', (e) => {
    if (!isX() || CC.getTab() !== 'xpresets' || document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'Escape' && moveSrc != null) { moveSrc = null; renderPresets(); return; }
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); run(api('POST', `${base()}/take`)); }
    if (e.key === 'c' || e.key === 'C') run(api('POST', `${base()}/cut`));
  });

  // ---------- sources / cues / stills / backups ----------
  let auxSel = localStorage.getItem('cc.aux') || '';
  function renderSources() {
    if (!V) return;
    const caps = V.capabilities; const aux = V.destinations.filter((d) => d.kind === 'aux');
    if (auxSel && !aux.some((a) => a.key === auxSel)) auxSel = '';
    $('#xsrcHint').textContent = caps.auxRoute ? 'pick an aux, then tap a source to put it on that aux Preview · FRZ freezes the input' : 'inputs reported by the device (read-only in its API)';
    set($('#xauxBar'), 'auxbar', caps.auxRoute && aux.length ? `<span class="modes-lbl">ROUTE TO AUX</span>${aux.map((a) => `<button class="mode ${auxSel === a.key ? 'active' : ''}" data-aux="${a.key}">${a.key} · ${esc(a.label)}</button>`).join('')}<button class="mode ${auxSel ? '' : 'active'}" data-aux="">OFF</button>` : '');
    set($('#xsrcGrid'), 'src', (V.sources || []).map((s) => `<div class="inp xinp ${s.frozen ? "frozen" : ""} ${s.status && s.status !== "ok" ? "nosig" : ""}">
        <button class="in-main" data-src="${s.id}" ${caps.auxRoute && auxSel ? '' : 'disabled'} title="${caps.auxRoute && auxSel ? `Put ${esc(s.name)} on ${auxSel} Preview` : esc(s.name)}"><span class="num">${s.kind === 'still' ? 'STILL' : s.kind === 'dest' ? 'DEST' : 'IN'} ${s.id + (V.system === 'e2' ? 1 : 0)}</span><span class="name">${esc(s.name)}</span><span class="chips"><span class="chip ${s.status && s.status !== 'ok' ? 'warn' : ''}">${esc(s.status || '—')}</span>${s.size ? `<span class="chip">${esc(s.size)}</span>` : ''}</span></button>
        ${caps.freeze && s.kind === 'input' ? `<button class="frz ${s.frozen ? "on" : ""}" data-frz="${s.inputCfg >= 0 ? s.inputCfg : s.id}" data-on="${s.frozen ? 0 : 1}">${s.frozen ? 'FROZEN' : 'FRZ'}</button>` : ''}</div>`).join('') || '<div class="note">No sources reported.</div>');
  }
  $('#xauxBar').addEventListener('click', (ev) => { const b = ev.target.closest('[data-aux]'); if (!b) return; auxSel = b.dataset.aux; localStorage.setItem('cc.aux', auxSel); renderSources(); });
  $('#xsrcGrid').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.frz !== undefined) return run(api('POST', `${base()}/freeze`, { kind: 'input', id: Number(b.dataset.frz), on: b.dataset.on === '1' }));
    if (b.dataset.src !== undefined && auxSel) return run(api('POST', `${base()}/aux/${auxSel}/source`, { source: Number(b.dataset.src), target: 'preview' }).then(() => toast(`Source → ${auxSel} PVW`)));
  });
  function renderCues() {
    set($('#xcuesList'), 'cues', (V.cues || []).map((c) => `<div class="row"><span class="lbl">${esc(c.name)}<small>Cue ${esc(c.number)}</small></span><span class="spacer"></span>
      <button class="btn mini primary" data-cue="${c.id}" data-act="play">▶ PLAY</button><button class="btn mini" data-cue="${c.id}" data-act="pause">❚❚ PAUSE</button><button class="btn mini" data-cue="${c.id}" data-act="stop">■ STOP</button></div>`).join('') || '<div class="note">No cues on the device.</div>');
  }
  $('#xcuesList').addEventListener('click', (ev) => { const b = ev.target.closest('[data-cue]'); if (b) run(api('POST', `${base()}/cues/${b.dataset.cue}/${b.dataset.act}`).then(() => toast(`Cue ${b.dataset.act}`))); });
  function renderStills() {
    const inputs = (V.sources || []).filter((s) => s.kind === 'input');
    set($('#xstillInput'), 'stillin', inputs.map((s) => `<option value="${s.id}">${s.id + 1} · ${esc(s.name)}</option>`).join(''));
    set($('#xstillsList'), 'stills', (V.stills || []).map((s) => `<div class="row"><span class="lbl">${esc(s.name)}<small>Still ${s.id + 1}${s.size ? ' · ' + esc(s.size) : ''}</small></span><span class="spacer"></span><button class="btn mini danger" data-delstill="${s.id}">DELETE</button></div>`).join('') || '<div class="note">The still store is empty.</div>');
  }
  $('#xstillTake').addEventListener('click', () => {
    const slot = Number($('#xstillSlot').value); const input = Number($('#xstillInput').value);
    if (!slot) return toast('Enter the still slot number', true);
    const ex = (V.stills || []).find((s) => s.id === slot - 1);
    if (!confirm(`Capture input ${input + 1} into still ${slot}${ex ? ` (overwrites "${ex.name}")` : ''}?`)) return;
    run(api('POST', `${base()}/stills/take`, { input, file: slot - 1 }).then(() => toast('Still captured')));
  });
  $('#xstillsList').addEventListener('click', (ev) => { const b = ev.target.closest('[data-delstill]'); if (!b) return; const s = V.stills.find((x) => x.id === Number(b.dataset.delstill)); if (confirm(`Delete still "${s ? s.name : b.dataset.delstill}" from the device?`)) run(api('DELETE', `${base()}/stills/${b.dataset.delstill}`).then(() => toast('Deleted'))); });
  function renderBackups() {
    set($('#xbkList'), 'bk', (V.backups || []).map((x) => {
      const btn = (slot, txt) => `<button class="btn mini seg ${x.active === slot ? 'on' : ''}" data-bk="${x.id}" data-slot="${slot}">${txt}</button>`;
      return `<div class="row"><span class="lbl">${esc(x.name)}<small>Input ${x.id + 1}</small></span>${btn(-1, 'PRIMARY')}${x.backups.map((b) => btn(b.id, `B${b.id + 1} · ${esc(b.name || (b.stillId != null ? `Still ${b.stillId + 1}` : `In ${(b.inputId ?? 0) + 1}`))}`)).join('')}</div>`;
    }).join('') || '<div class="note">No input has a backup configured on the device.</div>');
  }
  $('#xbkList').addEventListener('click', (ev) => { const b = ev.target.closest('[data-bk]'); if (b) run(api('POST', `${base()}/backups/${b.dataset.bk}`, { slot: Number(b.dataset.slot) })); });

  // ---------- state ----------
  function renderAll() {
    if (!SYS) return;
    applyChrome(); renderDash();
    if (isX() && V) {
      const t = CC.getTab();
      if (t === 'xpresets') renderPresets(); else if (t === 'xsources') renderSources(); else if (t === 'xcues') renderCues(); else if (t === 'xstills') renderStills(); else if (t === 'xbackup') renderBackups();
    }
  }
  function onSys(st) { if (!st || (SYS && st.rev < SYS.rev && st.active === SYS.active)) return; SYS = st; V = st.view; renderAll(); }
  async function refetch() { try { onSys(await api('GET', '/api/sys')); } catch { /* the stream will bring it */ } }
  window.addEventListener('cc:sys', (e) => onSys(e.detail));
  window.addEventListener('cc:tab', () => setTimeout(renderAll, 0));
  // ⚙ Settings is the RS6 device dialog; with another system active it opens the SYSTEMS dashboard instead
  $('#btnSettings').addEventListener('click', (e) => { if (isX()) { e.stopImmediatePropagation(); CC.setTab('system'); } }, true);
  $('#btnSystem').addEventListener('click', () => CC.setTab('system'));
  setInterval(() => { if (CC.getTab() === 'system') { const c = $('#dashClock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } }, 1000);
  refetch();
})();
