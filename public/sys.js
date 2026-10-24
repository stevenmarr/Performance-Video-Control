'use strict';
// Control Center (0.6.0, 0.7.0, 0.9.1): the SYSTEMS home page (dashboard + every connection setting) and the shared
// preset-switcher UI for E2 / PixelHue. Several systems stay on the desk at once; their tabs stay grouped in the
// bar. `active` is the system the open tab is driving. RS6 keeps its own tabs (public/app.js); ATEM and PTZ have
// theirs (public/atem.js, public/ptz.js), fed from here through window.CCSYS. State arrives as the `sys` event on the
// event stream app.js opens (window 'cc:sys'), and from GET /api/sys.
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
  const kind = () => (SYS && SYS.systems[SYS.active] ? SYS.systems[SYS.active].kind : 'rs6');
  const MONO = { rs6: 'AW', e2: 'EM', pixelhue: 'PH', atem: 'BM', ptz: 'PTZ', pixera: 'PX', millumin: 'ML' };
  const KIND_TABS = { rs6: ['presets', 'inputs', 'backup', 'audio', 'webrcs'], preset: ['xpresets', 'xcues', 'xsources', 'xstills', 'xbackup'], atem: ['atem', 'arouter', 'aaudio', 'akeys', 'amacros'], ptz: ['pctl', 'pcams', 'pscopes'], pixera: ['pxplay', 'pxcues'], millumin: ['mlcol', 'mllayer'], lightning: ['lightning'] };
  const HOME_TAB = { rs6: 'presets', preset: 'xpresets', atem: 'atem', ptz: 'pctl', pixera: 'pxplay', millumin: 'mlcol', lightning: 'lightning' };
  const TAB_KIND = Object.fromEntries(Object.entries(KIND_TABS).flatMap(([k, tabs]) => tabs.map((t) => [t, k])));
  const XTABS = KIND_TABS.preset;
  const RS6TABS = KIND_TABS.rs6;
  const listeners = [];
  const armed = () => (SYS && SYS.armed) || (SYS ? [SYS.active] : ['rs6']);
  const armedOf = (kindName) => armed().filter((k) => SYS.systems[k] && SYS.systems[k].kind === kindName);
  const HINTS = {
    recall: '<b>RECALL → PVW</b> · tap a tile to recall that preset to <b>Preview</b> on the destinations stored in it, then TAKE or CUT the selected destinations.',
    program: '<b>RECALL → PGM</b> · tap a tile to recall straight to <b>Program</b>, without a transition. The app asks first.',
    move: '<b>MOVE</b> · tap a tile, then another tile to <b>swap</b> them or an empty tile to <b>move</b> it. Only the app\'s layout changes.',
  };

  function statusOf(s) {
    if (!s) return { cls: 'off', txt: 'UNKNOWN' };
    const st = s.status || {};
    const conf = s.configured !== undefined ? s.configured : !!(s.connection && s.connection.host);
    if (!conf) return { cls: 'idle', txt: 'NOT CONFIGURED' };
    if (st.connected && s.key === 'ptz' && st.online < st.total) return { cls: 'warn', txt: `${st.online}/${st.total} ONLINE` };
    if (st.connected) return { cls: 'ok', txt: 'ONLINE' };
    return { cls: 'off', txt: 'OFFLINE' };
  }
  const ver = (v) => (v && typeof v === 'object' ? `${v.major}.${v.minor}.${v.patch}` : v || '');

  // ---------- 0.11.0 two-row navigation (docs/navigation.md) ----------
  // Row 1: ⌂ SYSTEMS + one button per system group on the desk, always in the same order (RS6, E2 / PIXELHUE,
  // ATEM, PTZ, PIXERA, MILLUMIN). Row 2: the pages of the selected group only. Each row scrolls sideways when
  // it does not fit, and the active button is kept in view.
  const GRP_ORDER = ['rs6', 'preset', 'atem', 'ptz', 'pixera', 'millumin', 'lightning'];
  const RANK = { off: 3, warn: 2, idle: 1, ok: 0 };
  const lastTabKey = (g) => `cc.lastTab.${g}`;
  function curGroup() { const t = CC.getTab(); return TAB_KIND[t] || 'home'; }
  function applyTabRows() {
    if (!SYS) return;
    const g = curGroup();
    document.body.dataset.tabgrp = g;
    document.querySelectorAll('#tabsSub .tab[data-sys], #tabsSub .tab-group').forEach((el) => {
      el.classList.toggle('grp-off', (el.dataset.sys || el.dataset.grp) !== g);
    });
    $('#tabsHomeNote').hidden = g !== 'home';
    for (const b of document.querySelectorAll('.tgrp[data-tabgrp]')) {
      const k = b.dataset.tabgrp; const list = armedOf(k);
      // Lightning is engineering (scopes), always on the desk — not a device to arm
      b.hidden = k === 'lightning' ? false : !list.length; b.classList.toggle('active', k === g);
      let worst = k === 'lightning' ? 'ok' : 'ok';
      if (k !== 'lightning') for (const s of list) { const c = statusOf(SYS.systems[s]).cls; if ((RANK[c] ?? 2) > (RANK[worst] ?? 0)) worst = c; }
      b.querySelector('.led').className = `led ${worst}`;
      if (k === 'preset') {
        const nm = list.map((s) => SYS.systems[s].short).join(' / ') || 'E2 / PIXELHUE';
        b.querySelector('.tgrp-nm').textContent = nm;
      }
      b.title = k === 'lightning' ? 'Lightning: engineering scopes (waveform, parade, vectorscope, false colour)' : (list.length ? `${list.map((s) => `${SYS.systems[s].label}: ${statusOf(SYS.systems[s]).txt}`).join(' · ')}` : '');
    }
    const act = document.querySelector('#tabsSub .tab.active:not(.grp-off)') ; const top = document.querySelector('#tabsTop .active');
    for (const el of [act, top]) if (el && el.scrollIntoView && el.parentElement.scrollWidth > el.parentElement.clientWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $('#tabsTop').addEventListener('click', (ev) => {
    const b = ev.target.closest('.tgrp[data-tabgrp]'); if (!b) return;
    const k = b.dataset.tabgrp;
    const vis = (t) => { const el = t && document.querySelector(`#tabsSub .tab[data-tab="${t}"][data-sys="${k}"]`); return el && !el.hidden ? el : null; };
    const el = vis(localStorage.getItem(lastTabKey(k))) || vis(HOME_TAB[k]) || [...document.querySelectorAll(`#tabsSub .tab[data-sys="${k}"]`)].find((x) => !x.hidden);
    if (el) el.click();
  });
  window.addEventListener('cc:tab', (ev) => { const g = TAB_KIND[ev.detail]; if (g) localStorage.setItem(lastTabKey(g), ev.detail); applyTabRows(); });

  // ---------- system switch / chrome ----------
  // One preset pane is shared by E2 and PixelHue, so that group shows the focused one when it is a preset
  // system, otherwise the first armed preset system that has the tab.
  function ownerOf(tabName, cap) {
    const kn = TAB_KIND[tabName];
    const list = armedOf(kn);
    if (!list.length) return null;
    if (kn !== 'preset') return list[0];
    const focused = SYS.systems[SYS.active] && SYS.systems[SYS.active].kind === 'preset' ? SYS.active : list[0];
    const has = (k) => { const c = (SYS.views && SYS.views[k] && SYS.views[k].capabilities) || (SYS.systems[k] && SYS.systems[k].capabilities) || {}; return !cap || c[cap]; };
    if (has(focused)) return focused;
    return list.find((k) => has(k)) || null;
  }
  function applyChrome() {
    const a = SYS.active; const sysInfo = SYS.systems[a]; const on = new Set(armed());
    for (const k of Object.keys(SYS.systems)) {
      document.body.classList.toggle(`sys-${k}`, k === a);
      document.body.classList.toggle(`arm-${k}`, on.has(k));
    }
    const knNow = TAB_KIND[CC.getTab()] || kind();
    for (const k of Object.keys(KIND_TABS)) document.body.classList.toggle(`kind-${k}`, k === knNow);
    document.body.classList.toggle('sys-x', isX());
    const st = statusOf(sysInfo);
    const badge = armed().map((k) => SYS.systems[k].short).join(' · ');
    $('#sysBadgeName').textContent = badge; $('#btnSystem').className = `sys-badge ${st.cls}`;
    $('#btnSystem').title = `On the desk: ${armed().map((k) => SYS.systems[k].label).join(', ')} · open: ${sysInfo.label} (${st.txt}) · tap for SYSTEMS`;
    document.querySelectorAll('.tab-group').forEach((g) => { g.hidden = !armedOf(g.dataset.grp).length; });
    document.querySelectorAll('.tab-group .grp-btn').forEach((b) => { b.hidden = !on.has(b.dataset.focus); b.classList.toggle('on', b.dataset.focus === a); });
    document.querySelectorAll('.tab[data-sys]').forEach((t) => {
      if (t.dataset.sys === 'lightning') { t.hidden = false; return; }
      const owner = ownerOf(t.dataset.tab, t.dataset.cap);
      t.hidden = !owner;
      if (owner) t.dataset.owner = owner;
    });
    document.querySelectorAll('.tab-group[data-grp=lightning]').forEach((g) => { g.hidden = false; });
    applyTabRows();
    document.querySelectorAll('.xsys').forEach((e) => { e.textContent = sysInfo.short; });
    const pillFor = () => {
      const tab = CC.getTab();
      if (tab === 'system' || !TAB_KIND[tab] || TAB_KIND[tab] === 'rs6') return null;
      const el = document.querySelector(`.tab[data-tab="${tab}"]`);
      return ownerOf(tab, el && el.dataset.cap) || a;
    };
    const pillSys = pillFor();
    const pillView = pillSys && pillSys !== 'rs6' ? ((SYS.views && SYS.views[pillSys]) || (pillSys === a ? V : null)) : null;
    const pillInfo = pillSys ? SYS.systems[pillSys] : sysInfo;
    if (pillView && pillInfo) {
      const c = $('#xconn'); const s = pillView.status || {};
      c.className = `pill x-only ${s.connected ? 'ok' : 'off'}`;
      const where = pillView.system === 'ptz' ? `${s.online || 0}/${s.total || 0} cameras` : esc(pillView.connection.host || '');
      const model = (s.info && s.info.model) || ''; const short = model.toUpperCase().startsWith(String(pillInfo.short).toUpperCase()) ? '' : pillInfo.short;
      c.innerHTML = (s.connected ? `${esc(short)} ${pillView.system === 'ptz' ? '' : `${esc(model)} ${esc(ver(s.info && s.info.version))} · `}${where}` : `${esc(pillInfo.short)} not connected${s.error ? ' · ' + esc(s.error).slice(0, 50) : ''}`) + (pillView.connection.mock ? '<span class="mock">MOCK</span>' : '');
      let last = '';
      if (pillView.kind === 'preset') last = pillView.lastRecalled ? `PVW: ${pillView.lastRecalled.number} · ${pillView.lastRecalled.name}` : 'PVW: —';
      else if (pillView.kind === 'atem' && pillView.inputs && pillView.inputs.length) { const nm = (id) => { const i = pillView.inputs.find((x) => x.id === id); return i ? i.long || i.short : '—'; }; last = `PGM ${nm(pillView.program)} · PVW ${nm(pillView.preview)}`; }
      else if (pillView.kind === 'ptz') { const c2 = (pillView.cameras || []).find((x) => x.id === pillView.selected); last = c2 ? `CAM: ${c2.name}` : 'CAM: —'; }
      else if (pillView.kind === 'pixera') { const t = (pillView.timelines || []).find((x) => x.selected); last = t ? `${t.name}: ${(t.transport || '—').toUpperCase()}` : 'TIMELINE: —'; }
      else if (pillView.kind === 'millumin') last = pillView.running ? `COL: ${pillView.columnName || pillView.column || '—'}` : 'COL: —';
      $('#xlast').textContent = last;
    }
    // a tab whose system left the desk goes home; a deep link to a system not yet armed brings it on
    const tab = CC.getTab(); const kn = TAB_KIND[tab];
    if (tab !== 'system' && kn && kn !== 'lightning' && !armedOf(kn).length) {
      if (!landed) return armForTab(tab);
      const home = armedOf('rs6').length ? 'presets' : (armed()[0] ? HOME_TAB[SYS.systems[armed()[0]].kind] : 'system');
      CC.setTab(home);
    } else if (kn) {
      const cur = document.querySelector(`.tab[data-tab="${tab}"]`);
      const homeEl = document.querySelector(`.tab[data-tab="${HOME_TAB[kn]}"]`);
      if (cur && cur.hidden) CC.setTab(homeEl && !homeEl.hidden ? HOME_TAB[kn] : 'system');
    }
    landed = true;
  }
  function armForTab(tab) {
    const kn = TAB_KIND[tab];
    const sys = kn === 'preset' ? 'e2' : Object.keys(SYS.systems).find((k) => SYS.systems[k].kind === kn);
    if (!sys || armed().includes(sys)) { landed = true; return; }
    run(api('POST', '/api/sys/active', { system: sys }).then((st) => { landed = true; onSys(st); }));
  }
  // Landing: the SYSTEMS page is home. A deep link (/#presets, /#xpresets, /#atem, ...) opens that tab instead.
  (() => {
    const h = decodeURIComponent((location.hash || '').replace(/^#\/?/, '').replace(/^tab=/, ''));
    if (h && document.querySelector(`.tab[data-tab="${h.replace(/[^\w-]/g, '')}"]`)) { window.__ccTabClicked = true; CC.setTab(h); } else CC.setTab('system');
  })();

  // ---------- dashboard (home): status + every connection setting ----------
  let density = localStorage.getItem('cc.density') || 'list'; // 0.11.0: dense LIST is the default
  let dashQ = ''; let dashSt = localStorage.getItem('cc.dashSt') || 'all';
  let groupSel = localStorage.getItem('cc.group') || 'all';
  const f = (name, label, type, val, ph, dis, extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" ${dis} ${extra}></label>`;
  function connForm(s) {
    const c = s.connection || {}; const dis = c.mock ? 'disabled' : '';
    const foot = (k) => `<div class="actions left">${c.simulator ? '<span class="note small">Simulator on 127.0.0.1. It is not saved. REMOVE FROM DESK to use a real address.</span>' : c.mock ? '<span class="note small">Mock mode: connected to the built-in mock, fixed.</span>' : '<button class="btn mini primary" value="save">SAVE &amp; CONNECT</button>'}
      <button type="button" class="btn mini" data-reconnect="${k}" ${s.configured ? '' : 'disabled'}>⟳ RECONNECT</button></div>`;
    if (s.key === 'rs6') {
      return `<form class="form conn-form" data-sys="rs6">
        <div class="row2">${f('host', 'RS6 IP address', 'text', c.host, 'RS6 IP', dis, 'autocomplete="off" spellcheck="false"')}<label>Control protocol<select name="protocol" ${dis}><option value="rest" ${c.protocol !== 'awj' ? 'selected' : ''}>REST</option><option value="awj" ${c.protocol === 'awj' ? 'selected' : ''}>AWJ</option></select></label></div>
        <div class="row2">${f('restPort', 'REST port', 'number', c.restPort, '80', dis, 'min="1" max="65535"')}${f('awjPort', 'AWJ port', 'number', c.awjPort, '10606', dis, 'min="1" max="65535"')}</div>
        <div class="actions left">${c.mock ? '<span class="note small">Mock mode: connected to the built-in mock RS6, fixed.</span>' : '<button class="btn mini primary" value="save">SAVE &amp; CONNECT</button>'}
        <button type="button" class="btn mini" data-rs6set="1">ALL RS6 SETTINGS…</button></div></form>`;
    }
    if (s.key === 'ptz') {
      const cams = c.cameras || []; const st = s.cameras || [];
      const rows = cams.map((x) => { const live = st.find((y) => y.id === x.id) || {}; return `<div class="cam-row" data-cam="${esc(x.id)}"><span class="led ${live.connected ? 'ok' : 'off'}"></span>
        <input name="name" value="${esc(x.name)}" maxlength="40" aria-label="Name"><input name="host" value="${esc(x.host)}" aria-label="IP" spellcheck="false"><input name="port" type="number" value="${esc(x.port)}" class="slot-in" aria-label="Port">
        <button type="button" class="btn mini" data-camsave="${esc(x.id)}">SAVE</button><button type="button" class="btn mini danger" data-camdel="${esc(x.id)}" title="Remove this camera">✕</button></div>`; }).join('');
      return `<div class="conn-form cams-form">${rows || '<div class="note small">No cameras yet.</div>'}
        <form class="cam-row add" data-camadd="1"><span class="led idle"></span><input name="name" placeholder="Name" maxlength="40"><input name="host" placeholder="IP address" spellcheck="false" autocomplete="off"><input name="port" type="number" placeholder="80" class="slot-in"><button class="btn mini primary">ADD</button></form>
        ${c.mock ? '<div class="note small">Mock mode: cameras must be local mocks (127.0.0.1).</div>' : ''}</div>`;
    }
    const extra = s.key === 'e2'
      ? f('operatorId', 'Operator (multi-op)', 'text', c.operatorId, 'none', dis, 'inputmode="numeric"') + f('transTime', 'TAKE time (frames)', 'text', c.transTime, 'device default', dis, 'inputmode="numeric"')
      : s.key === 'pixelhue' ? f('prefix', 'API path prefix', 'text', c.prefix, '/pixelhue', dis) + f('time', 'TAKE time (ms)', 'text', c.time, 'device default', dis, 'inputmode="numeric"')
        : f('me', 'M/E driven', 'number', c.me, '1', dis, 'min="1" max="4"') + '<span></span>';
    const defPort = { e2: 9999, pixelhue: 8088, atem: 9910, pixera: 1400, millumin: 5000 }[s.key];
    const hostPh = { e2: 'E2 host unit IP', atem: 'ATEM IP', pixera: 'Pixera IP', millumin: 'Millumin Mac IP' }[s.key] || 'switcher IP';
    const portLbl = s.key === 'atem' ? 'UDP port' : s.key === 'millumin' ? 'OSC port' : s.key === 'pixera' ? 'API port' : 'Port';
    return `<form class="form conn-form" data-sys="${s.key}">
      <div class="row2">${f('host', 'IP address', 'text', c.host, hostPh, dis, 'autocomplete="off" spellcheck="false"')}${f('port', portLbl, 'number', c.port, String(defPort), dis, 'min="1" max="65535"')}</div>
      ${s.key === 'atem' ? `<div class="row2">${extra}</div>` : s.key === 'pixera' || s.key === 'millumin' ? '' : `<div class="row2">${extra}</div>`}
      ${s.key === 'pixelhue' ? `<label class="chk"><input type="checkbox" name="swap" ${c.swap ? 'checked' : ''} ${dis}> Swap on TAKE / CUT (Program goes back to Preview)</label>` : ''}
      ${foot(s.key)}
    </form>`;
  }
  function statsOf(s) {
    const n = s.counts || {};
    const rows = s.kind === 'atem' ? [['SOURCES', n.sources], ['MACROS', n.macros], ['KEYS', n.keyers], ['AUX', n.aux]]
      : s.kind === 'ptz' ? [['CAMERAS', n.cameras], ['ONLINE', n.online], ['ON TALLY', n.tally], ['NAMED PRESETS', n.presets]]
        : s.kind === 'pixera' ? [['TIMELINES', n.timelines], ['PLAYING', n.playing], ['SELECTED', n.timeline ? 1 : 0], ['CUE', n.cue ? 1 : 0]]
          : s.kind === 'millumin' ? [['COLUMN', n.column ? 1 : 0], ['LAYER', n.layer ? 1 : 0], ['RUNNING', n.running], ['OPACITY', n.opacity == null ? null : 1]]
            : [['PRESETS', n.presets], ['DESTINATIONS', n.destinations], ['SOURCES', n.sources]].concat(s.key === 'e2' ? [['CUES', n.cues]] : []);
    return rows.map(([k, v]) => `<div class="stat"><b>${v ?? '—'}</b><span>${k}</span></div>`).join('');
  }
  function liveLine(s) {
    const n = s.counts || {};
    if (s.kind === 'atem' && n.program) return `<div class="live-line"><span class="lg pgm">PGM</span> ${esc(n.program)} <span class="lg pvw">PVW</span> ${esc(n.preview)}</div>`;
    if (s.kind === 'ptz' && (s.cameras || []).length) return `<div class="live-line cams">${s.cameras.map((c) => `<span class="cam-chip ${c.connected ? '' : 'off'} ${c.tally ? 'tally' : ''}"><span class="led ${c.connected ? 'ok' : 'off'}"></span>${esc(c.name)}</span>`).join('')}</div>`;
    if (s.kind === 'pixera' && n.timeline) return `<div class="live-line"><span class="lg pgm">${n.playing ? 'PLAY' : 'STOP'}</span> ${esc(n.timeline)}${n.cue ? ` · ${esc(n.cue)}` : ''}</div>`;
    if (s.kind === 'millumin' && n.column) return `<div class="live-line"><span class="lg ${n.running ? 'pgm' : 'pvw'}">${n.running ? 'RUN' : 'STOP'}</span> ${esc(String(n.column))}</div>`;
    return '';
  }
  function renderDash() {
    const clock = $('#dashClock'); if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const all = Object.values(SYS.systems); const sts = all.map(statusOf);
    $('#dashSummary').innerHTML = `<b>${all.length}</b> systems · <span class="ok">${sts.filter((x) => x.cls === 'ok').length} online</span> · <span class="off">${sts.filter((x) => x.cls === 'off' || x.cls === 'warn').length} offline / degraded</span> · <span class="idle">${sts.filter((x) => x.cls === 'idle').length} not configured</span>`;
    document.querySelectorAll('[data-density]').forEach((b) => b.classList.toggle('active', b.dataset.density === density));
    const card = (s) => {
      const st = statusOf(s); const active = SYS.active === s.key; const on = armed().includes(s.key); const info = (s.status && s.status.info) || {};
      const open = s.kind === 'atem' ? 'SWITCHER' : s.kind === 'ptz' ? 'PTZ CONTROL' : s.kind === 'pixera' ? 'TIMELINES' : s.kind === 'millumin' ? 'COLUMNS' : 'PRESETS';
      // Corner button: ADD TO DESK, or REMOVE FROM DESK once it is on the desk. Opening stays on the
      // tabs and on OPEN {home} → (that button keeps data-use so the desk tests still find one control).
      const head = on
        ? `<button type="button" class="btn mini danger" data-armoff="${s.key}">REMOVE FROM DESK</button>`
        : `<button type="button" class="btn mini primary" data-use="${s.key}">ADD TO DESK</button>`;
      const sim = !on && s.key !== 'rs6' && !(s.connection && s.connection.mock)
        ? `<button type="button" class="btn mini" data-sim="${s.key}">ADD TO DESK AS SIMULATOR</button>` : '';
      const actions = on
        ? `<button type="button" class="btn mini" data-use="${s.key}" data-open="${s.key}">OPEN ${open} →</button>`
        : sim;
      return `<article class="sys-card ${active ? 'active' : ''} ${on ? 'on-desk' : ''} ${st.cls}" data-card="${s.key}">
        <header><div class="mono">${MONO[s.key] || '?'}</div><div class="ttl"><div class="sys-grp">${esc(s.group || '')}</div><div class="nm">${esc(s.label)}</div>
          <div class="st"><span class="led ${st.cls}"></span>${st.txt}${info.model ? ` · ${esc(info.model)} ${esc(ver(info.version))}` : ''}${s.connection && s.connection.mock ? ' <span class="mock">MOCK</span>' : ''}</div></div>
          ${head}</header>
        ${s.status && s.status.error && (st.cls === 'off' || st.cls === 'warn') ? `<div class="err small">${esc(s.status.error).slice(0, 140)}</div>` : ''}
        <div class="stats">${statsOf(s)}</div>${liveLine(s)}
        ${actions ? `<div class="actions left">${actions}</div>` : ''}
        <details data-det="${s.key}" ${openDet.has(s.key) ? 'open' : ''}><summary>CONFIGURE</summary>${connForm(s)}</details>
      </article>`;
    };
    // 0.11.0 LIST: one dense line per system — LED, name, status, the key numbers, live line, actions; ⚙ expands CONFIGURE
    const row = (s) => {
      const st = statusOf(s); const active = SYS.active === s.key; const on = armed().includes(s.key); const info = (s.status && s.status.info) || {};
      const open = s.kind === 'atem' ? 'SWITCHER' : s.kind === 'ptz' ? 'PTZ' : s.kind === 'pixera' ? 'TIMELINES' : s.kind === 'millumin' ? 'COLUMNS' : 'PRESETS';
      const n = s.counts || {};
      const stats = (s.kind === 'atem' ? [['src', n.sources], ['macros', n.macros], ['keys', n.keyers]] : s.kind === 'ptz' ? [['cams', n.cameras], ['online', n.online], ['tally', n.tally]]
        : s.kind === 'pixera' ? [['timelines', n.timelines], ['playing', n.playing]] : s.kind === 'millumin' ? [['running', n.running]] : [['presets', n.presets], ['dests', n.destinations], ['src', n.sources]])
        .filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `<span><b>${v}</b> ${k}</span>`).join('');
      const live = s.kind === 'atem' && n.program ? `<span class="lg pgm">PGM</span> ${esc(n.program)} <span class="lg pvw">PVW</span> ${esc(n.preview)}`
        : s.kind === 'ptz' && (s.cameras || []).length ? s.cameras.slice(0, 6).map((c) => `<span class="cam-chip ${c.connected ? '' : 'off'} ${c.tally ? 'tally' : ''}"><span class="led ${c.connected ? 'ok' : 'off'}"></span>${esc(c.name)}</span>`).join('') + (s.cameras.length > 6 ? ` +${s.cameras.length - 6}` : '') : '';
      const host = s.connection && s.connection.host ? s.connection.host : '';
      const acts = on
        ? `<button type="button" class="btn mini" data-use="${s.key}" data-open="${s.key}" title="Open its tabs">OPEN ${open}</button><button type="button" class="btn mini danger" data-armoff="${s.key}" title="Remove from the desk">REMOVE</button>`
        : `<button type="button" class="btn mini primary" data-use="${s.key}" title="Add to the desk">ADD</button>${s.key !== 'rs6' && !(s.connection && s.connection.mock) ? `<button type="button" class="btn mini" data-sim="${s.key}" title="Add to the desk as a simulator (not saved)">SIM</button>` : ''}`;
      return `<article class="sys-card sys-line ${active ? 'active' : ''} ${on ? 'on-desk' : ''} ${st.cls}" data-card="${s.key}">
        <div class="row-main"><span class="led ${st.cls}" title="${esc(st.txt)}"></span><span class="mono">${MONO[s.key] || '?'}</span>
          <span class="row-nm" title="${esc(s.label)}"><b>${esc(s.short || s.label)}</b> <small>${esc(s.label)}${s.group ? ` · ${esc(s.group)}` : ''}</small></span>
          <span class="row-st ${st.cls}">${st.txt}${info.model ? ` · ${esc(info.model)}` : ''}${s.connection && s.connection.mock ? ' <span class="mock">MOCK</span>' : ''}${on ? ' <span class="desk-tag">DESK</span>' : ''}</span>
          <span class="row-stats">${stats}</span><span class="row-live">${live}${s.status && s.status.error && (st.cls === 'off' || st.cls === 'warn') ? `<span class="err-inline" title="${esc(s.status.error)}">${esc(s.status.error).slice(0, 60)}</span>` : ''}</span>
          <span class="row-host">${esc(host)}</span><span class="row-acts">${acts}</span></div>
        <details data-det="${s.key}" ${openDet.has(s.key) ? 'open' : ''}><summary title="Configure the connection">⚙</summary>${connForm(s)}</details>
      </article>`;
    };
    // one flowing grid (scales to many cards); group chips filter it; the active system always comes first
    const groups = SYS.groups || [{ name: 'Systems', systems: Object.keys(SYS.systems) }];
    if (groupSel !== 'all' && !groups.some((g) => g.name === groupSel)) groupSel = 'all';
    const chip = (key, label, n) => `<button class="mode ${groupSel === key ? 'active' : ''}" data-group="${esc(key)}" type="button">${esc(label)} <small>${n}</small></button>`;
    set($('#dashGroups'), 'groups', chip('all', 'ALL', all.length) + groups.map((g) => chip(g.name, g.name.toUpperCase(), g.systems.length)).join(''));
    const keys = (groupSel === 'all' ? groups.flatMap((g) => g.systems) : groups.find((g) => g.name === groupSel).systems).slice().sort((x, y) => (armed().includes(x) === armed().includes(y) ? (x === SYS.active ? -1 : y === SYS.active ? 1 : 0) : armed().includes(x) ? -1 : 1));
    // 0.11.0 search + status filter
    const q = dashQ.trim().toLowerCase();
    const stOk = (k) => { const x = SYS.systems[k]; const c = statusOf(x).cls; return dashSt === 'all' || (dashSt === 'online' && c === 'ok') || (dashSt === 'issues' && (c === 'off' || c === 'warn')) || (dashSt === 'desk' && armed().includes(k)) || (dashSt === 'idle' && c === 'idle'); };
    const qOk = (k) => { const x = SYS.systems[k]; return !q || `${x.key} ${x.short} ${x.label} ${x.group || ''} ${x.kind} ${statusOf(x).txt} ${(x.connection && x.connection.host) || ''} ${armed().includes(k) ? 'desk' : ''}`.toLowerCase().includes(q); };
    const base0 = groupSel === 'all' ? groups.flatMap((g) => g.systems) : groups.find((g) => g.name === groupSel).systems;
    const cnt = (f) => base0.filter((k) => SYS.systems[k] && qOk(k) && f(k)).length;
    const stChip = (k, l, f) => `<button class="mode ${dashSt === k ? 'active' : ''}" data-dashst="${k}" type="button">${l} <small>${cnt(f)}</small></button>`;
    set($('#dashStatus'), 'dst', stChip('all', 'ALL', () => true) + stChip('online', 'ONLINE', (k) => statusOf(SYS.systems[k]).cls === 'ok') + stChip('issues', 'ISSUES', (k) => ['off', 'warn'].includes(statusOf(SYS.systems[k]).cls)) + stChip('desk', 'ON DESK', (k) => armed().includes(k)) + stChip('idle', 'NOT SET UP', (k) => statusOf(SYS.systems[k]).cls === 'idle'));
    const shown = keys.filter((k) => SYS.systems[k] && qOk(k) && stOk(k));
    const cards = `<div class="sys-cards ${density}">${shown.map((k) => (density === 'list' ? row : card)(SYS.systems[k])).join('') || '<div class="note">No system matches the filter.</div>'}</div>`;
    // keep a focused connection form from being replaced while typing
    if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('#sysCards')) set($('#sysCards'), 'cards', cards);
    $('#sysPlannedWrap').hidden = !(SYS.planned || []).length;
    set($('#sysPlanned'), 'planned', (SYS.planned || []).map((p) => `<article class="sys-card planned"><header><div class="mono">${MONO[p.key] || '?'}</div><div class="ttl"><div class="nm">${esc(p.label)}</div><div class="st"><span class="led idle"></span>${esc(p.kind)} · NOT BUILT</div></div><span class="badge-stub">STUB</span></header><div class="note small">${esc(p.note)}</div></article>`).join(''));
  }
  const openDet = new Set(JSON.parse(localStorage.getItem('cc.conn') || '[]'));
  $('#sysCards').addEventListener('toggle', (ev) => { const d = ev.target; if (!d.dataset || !d.dataset.det) return; if (d.open) openDet.add(d.dataset.det); else openDet.delete(d.dataset.det); localStorage.setItem('cc.conn', JSON.stringify([...openDet])); }, true);
  $('#dashSearch').addEventListener('input', () => { dashQ = $('#dashSearch').value; renderDash(); });
  $('#dashStatus').addEventListener('click', (ev) => { const b = ev.target.closest('[data-dashst]'); if (!b) return; dashSt = b.dataset.dashst; localStorage.setItem('cc.dashSt', dashSt); renderDash(); });
  $('#dashGroups').addEventListener('click', (ev) => { const b = ev.target.closest('[data-group]'); if (!b) return; groupSel = b.dataset.group; localStorage.setItem('cc.group', groupSel); renderDash(); });
  document.querySelectorAll('[data-density]').forEach((b) => b.addEventListener('click', () => { density = b.dataset.density; localStorage.setItem('cc.density', density); html.cards = null; renderDash(); }));
  const camRow = (el) => ({ name: el.querySelector('[name=name]').value.trim(), host: el.querySelector('[name=host]').value.trim(), port: Number(el.querySelector('[name=port]').value) || 80 });
  $('#sysCards').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.armoff) return run(api('POST', '/api/sys/armed', { system: b.dataset.armoff, on: false }).then((st) => { onSys(st); toast(`${st.systems[b.dataset.armoff].short} left the desk`); }).catch((e) => toast(e.message, true)));
    if (b.dataset.sim === 'atem' && window.CCATEM) return window.CCATEM.pickModel(); // 0.10.0: choose the simulated model first
    if (b.dataset.sim) return run(api('POST', `/api/sys/${b.dataset.sim}/simulate`).then((st) => { onSys(st); toast(`${st.systems[b.dataset.sim].short} simulator is on the desk`); }).catch((e) => toast(e.message, true)));
    if (b.dataset.use) return run(api('POST', '/api/sys/active', { system: b.dataset.use }).then((st) => { onSys(st); if (b.dataset.open) CC.setTab(HOME_TAB[st.systems[b.dataset.use].kind]); else toast(`${st.systems[b.dataset.use].short} is on the desk`); }));
    if (b.dataset.open) { const k = SYS.systems[b.dataset.open].kind; return CC.setTab(HOME_TAB[k]); }
    if (b.dataset.rs6set) return $('#btnSettings').click();
    if (b.dataset.reconnect) return run(api('POST', `/api/sys/${b.dataset.reconnect}/connect`).then(() => toast('Connected')));
    if (b.dataset.camsave) { b.blur(); return run(api('POST', `/api/sys/ptz/cameras/${b.dataset.camsave}`, camRow(b.closest('.cam-row'))).then(() => toast('Camera saved')).finally(refetch)); }
    if (b.dataset.camdel) { const r = b.closest('.cam-row'); if (!confirm(`Remove camera "${r.querySelector('[name=name]').value}" from this system?`)) return; return run(api('DELETE', `/api/sys/ptz/cameras/${b.dataset.camdel}`).then(() => toast('Camera removed')).finally(refetch)); }
  });
  $('#sysCards').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fm = ev.target;
    if (fm.dataset.camadd) { const c = camRow(fm); if (document.activeElement) document.activeElement.blur(); return run(api('POST', '/api/sys/ptz/cameras', c).then(() => { fm.reset(); toast(`Added ${c.name || 'camera'}`); }).finally(refetch)); }
    const k = fm.dataset.sys; const b = {};
    if (document.activeElement) document.activeElement.blur();
    if (k === 'rs6') {
      b.host = fm.elements.host.value.trim(); b.protocol = fm.elements.protocol.value;
      for (const n of ['restPort', 'awjPort']) { const v = Number(fm.elements[n].value); if (v) b[n] = v; }
      return run(api('POST', '/api/settings', b).then(() => toast('RS6 connection saved')).finally(refetch));
    }
    for (const n of ['host', 'operatorId', 'transTime', 'prefix', 'time']) if (fm.elements[n]) b[n] = fm.elements[n].value.trim();
    if (fm.elements.port) b.port = Number(fm.elements.port.value) || undefined;
    if (fm.elements.me) b.me = Number(fm.elements.me.value) || 1;
    if (fm.elements.swap) b.swap = fm.elements.swap.checked;
    run(api('POST', `/api/sys/${k}/connection`, b).then(() => (b.host ? api('POST', `/api/sys/${k}/connect`) : null)).then((r) => toast(r ? 'Saved and connected' : 'Saved')).finally(refetch));
  });

  // ---------- presets ----------
  function renderPresets() {
    if (!V) return;
    if (V.presets) { const sel = new Set(V.selection || []); bailBadge($('#xBail'), V.followUp, V.presets.filter((p) => p.tally.pvw !== 'none' && (!p.dests || !sel.size || p.dests.some((d) => sel.has(d)))), xName); }
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
      const fu = p.followUpResolved ? V.presets.find((x) => x.key === p.followUpResolved) : null;
      const fuChip = fu ? `<span class="chip fu src-${p.bail.source}" title="Auto recall: bail to ${esc(fu.name)} (${p.bail.source === 'group' ? `group ${esc(p.bail.group)}` : p.bail.source === 'preset' ? 'set on this preset' : 'show default'})">↪ ${fu.tile}${p.bail.source === 'preset' ? '' : `<i>${p.bail.source === 'group' ? 'G' : 'D'}</i>`}</span>` : '';
      h += `<button class="${cls.join(" ")}" data-preset="${n}" data-key="${esc(p.key)}" title="${esc(V.short)} preset ${esc(num)} · ${esc(p.name)}${p.dests ? ' · ' + esc(p.dests.join(', ')) : ''}"><span class="tags">${tags.join('')}</span><span class="num">${n}${String(num) !== String(n) ? ` <small class="devnum">#${esc(num)}</small>` : ''}</span><span class="name">${esc(p.name)}</span><span class="chips">${fuChip}${chips}</span></button>`;
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
    if (mode === 'follow') return xFollow(p);
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
    applyChrome();
    const t = CC.getTab();
    if (t === 'system') renderDash();
    if (isX() && V && V.kind === 'preset') {
      if (t === 'xpresets') renderPresets(); else if (t === 'xsources') renderSources(); else if (t === 'xcues') renderCues(); else if (t === 'xstills') renderStills(); else if (t === 'xbackup') renderBackups();
    }
    for (const fn of listeners) { try { fn(V, t, SYS); } catch (e) { console.error(e); } }
  }
  function onSys(st) { if (!st || (SYS && st.rev < SYS.rev && st.active === SYS.active && JSON.stringify(st.armed) === JSON.stringify(SYS.armed))) return; SYS = st; V = st.view; renderAll(); }
  async function refetch() { try { onSys(await api('GET', '/api/sys')); } catch { /* the stream will bring it */ } }
  window.addEventListener('cc:sys', (e) => onSys(e.detail));
  // for public/atem.js and public/ptz.js
  // 0.11.0 AUTO RECALL / BAIL TO dialog, shared by RS6 PRESETS (public/app.js) and E2 / PixelHue PRESETS. o = { sys,
  // numeric (RS6 ids), presets: [{value, label}], dests: [keys], preset: {name, self, own, bail} | null,
  // cfg: {enabled, default, delayMs, groups}, note, save({preset, enabled, def, delayMs, groups}) → promise }
  let fuCtx = null; let fuGroups = [];
  const SRC_LABEL = { preset: 'this preset', group: 'group', default: 'show default' };
  const bailText = (b, nameOf) => (b && b.target ? `↪ ${esc(nameOf(b.target))} <small>(${b.source === 'group' ? `group “${esc(b.group)}”` : SRC_LABEL[b.source]})</small>` : `<span class="dimtxt">no auto recall${b && b.reason ? ` — ${esc(b.reason)}` : ''}</span>`);
  const fuOptList = (list, cur, first, self) => `${first}${list.filter((x) => String(x.value) !== String(self)).map((x) => `<option value="${esc(String(x.value))}" ${cur !== null && cur !== undefined && String(cur) === String(x.value) ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}`;
  function fuRenderGroups() {
    const o = fuCtx; const destBox = (g, gi) => (o.dests || []).map((d) => `<label class="fu-dest"><input type="checkbox" data-gdest="${gi}" value="${esc(d)}" ${g.dests.includes(d) ? 'checked' : ''}>${esc(d)}</label>`).join('');
    $('#fuGroups').innerHTML = fuGroups.map((g, gi) => `<div class="fu-group" data-g="${gi}">
      <div class="fu-ghead"><input class="fu-gname" data-gname="${gi}" value="${esc(g.name)}" maxlength="40"><label class="fu-gon"><input type="checkbox" data-gon="${gi}" ${g.enabled ? 'checked' : ''}> ON</label>
        <label>bail to <select data-gtarget="${gi}">${fuOptList(o.presets, g.target || null, `<option value="0" ${!g.target ? 'selected' : ''}>show default</option>`)}</select></label><button type="button" class="btn mini ghost" data-gdel="${gi}" title="Remove this group">×</button></div>
      <div class="fu-gbody"><label>presets <select multiple size="4" data-gpresets="${gi}">${o.presets.map((x) => `<option value="${esc(String(x.value))}" ${g.presets.map(String).includes(String(x.value)) ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
        ${o.dests && o.dests.length ? `<div class="fu-dests"><span class="modes-lbl">or every preset on</span>${destBox(g, gi)}</div>` : ''}</div></div>`).join('') || '<div class="note small">No groups.</div>';
  }
  function openFollowUp(o) {
    fuCtx = o; const c = o.cfg || {}; $('#fuSys').textContent = o.sys || '';
    $('#fuEnabled').checked = c.enabled !== false;
    $('#fuPresetRow').hidden = !o.preset;
    if (o.preset) {
      const own = o.preset.own || {};
      $('#fuPresetName').textContent = o.preset.name;
      $('#fuPState').value = own.enabled === true ? 'on' : own.enabled === false ? 'off' : 'inherit';
      $('#fuPTarget').innerHTML = fuOptList(o.presets, own.target || null, `<option value="__inherit" ${own.target ? '' : 'selected'}>inherit (group / show default)</option>`, o.preset.self);
      $('#fuPNow').innerHTML = `Now: ${bailText(o.preset.bail, o.nameOf)}`;
    }
    $('#fuDefault').innerHTML = fuOptList(o.presets, c.default || null, `<option value="0" ${!c.default ? 'selected' : ''}>none</option>`);
    $('#fuDelay').value = c.delayMs === undefined ? 1000 : c.delayMs; $('#fuDelayNote').textContent = o.note || '';
    fuGroups = JSON.parse(JSON.stringify(c.groups || [])); fuRenderGroups();
    $('#dlgFollowUp').returnValue = ''; $('#dlgFollowUp').showModal();
  }
  const fuVal = (v) => (fuCtx && fuCtx.numeric ? Number(v) : v);
  $('#fuAddGroup').addEventListener('click', () => { fuGroups.push({ name: `Group ${fuGroups.length + 1}`, enabled: true, target: 0, presets: [], dests: [] }); fuRenderGroups(); });
  $('#fuGroups').addEventListener('change', (e) => {
    const t = e.target; const d = t.dataset;
    if (d.gname !== undefined) fuGroups[d.gname].name = t.value;
    if (d.gon !== undefined) fuGroups[d.gon].enabled = t.checked;
    if (d.gtarget !== undefined) fuGroups[d.gtarget].target = t.value === '0' ? 0 : fuVal(t.value);
    if (d.gpresets !== undefined) fuGroups[d.gpresets].presets = [...t.selectedOptions].map((x) => fuVal(x.value));
    if (d.gdest !== undefined) { const g = fuGroups[d.gdest]; g.dests = t.checked ? [...new Set([...g.dests, t.value])] : g.dests.filter((x) => x !== t.value); }
  });
  $('#fuGroups').addEventListener('input', (e) => { if (e.target.dataset.gname !== undefined) fuGroups[e.target.dataset.gname].name = e.target.value; });
  $('#fuGroups').addEventListener('click', (e) => { const b = e.target.closest('[data-gdel]'); if (b) { fuGroups.splice(Number(b.dataset.gdel), 1); fuRenderGroups(); } });
  $('#dlgFollowUp').addEventListener('close', () => {
    if ($('#dlgFollowUp').returnValue !== 'save' || !fuCtx) return;
    let preset;
    if (fuCtx.preset) {
      const st = $('#fuPState').value; const tv = $('#fuPTarget').value;
      const own = {}; if (st === 'on') own.enabled = true; if (st === 'off') own.enabled = false; if (tv !== '__inherit') own.target = fuVal(tv);
      preset = Object.keys(own).length ? own : null;
    }
    const dv = $('#fuDefault').value;
    CC.run(fuCtx.save({ preset, enabled: $('#fuEnabled').checked, def: dv === '0' ? 0 : fuVal(dv), delayMs: Number($('#fuDelay').value), groups: fuGroups }).then(() => CC.toast('Auto recall saved')));
  });
  // the bail badge on a page head: universal switch, what a TAKE of the current Preview would bail to, a pending one
  function bailBadge(el, cfg, pvwList, nameOf) {
    if (!el) return;
    let h; let cls = 'btn mini bail-badge';
    if (!cfg || cfg.enabled === false) { h = '↪ AUTO RECALL <b>OFF</b>'; cls += ' off'; }
    else if (cfg.pending) { const to = cfg.pending.to.map((x) => (typeof x === 'object' && x ? x.name || x.key : nameOf(x))); h = `↪ next: <b>${esc(to.join(', '))}</b> → PVW`; cls += ' pending'; }
    else {
      const b = pvwList.map((p) => p.bail).filter((x) => x && x.target);
      h = b.length ? `↪ after TAKE: <b>${esc([...new Set(b.map((x) => nameOf(x.target)))].join(', '))}</b> <small>${b[0].source === 'group' ? `group ${esc(b[0].group)}` : SRC_LABEL[b[0].source]}</small>`
        : `↪ ON · default <b>${cfg.default ? esc(nameOf(cfg.default)) : 'none'}</b>`;
      cls += ' on';
    }
    set(el, `bail-${el.id}`, h); if (el.className !== cls) el.className = cls;
  }
  window.CCFU = { open: openFollowUp, badge: bailBadge, bailText };
  const xName = (k) => { const p = V && V.presets.find((x) => x.key === k); return p ? `${p.tile} · ${p.name}` : String(k); };
  const xFollow = (p) => {
    openFollowUp({ sys: V.short, presets: V.presets.slice().sort((a, b) => a.tile - b.tile).map((x) => ({ value: x.key, label: `${x.tile} · ${x.name}` })), dests: V.destinations.map((d) => d.key),
      preset: p ? { name: `${p.tile} · ${p.name}`, self: p.key, own: p.followUp, bail: p.bail } : null, cfg: V.followUp || {}, nameOf: xName,
      note: V.system === 'pixelhue' ? 'PixelHue: waits at least the transition time set on its connection.' : 'Set the wait to (at least) the transition time.',
      save: async ({ preset, enabled, def, delayMs, groups }) => {
        if (p) await api('POST', `${base()}/presets/${encodeURIComponent(p.key)}/followup`, { followUp: preset });
        await api('POST', `${base()}/followup`, { enabled, default: def || 0, delayMs, groups });
        return refetch();
      } });
  };
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-bail="x"]'); if (b && V && V.kind === 'preset') xFollow(null); });
  // 0.11.0 SAVE on the switcher pages (RS6 PRESETS, E2 / PixelHue PRESETS, ATEM SWITCHER): POST /api/sys/<sys>/save
  let saveSys = null;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-desksave]'); if (!b) return;
    saveSys = b.dataset.desksave === 'x' ? (V && V.system) || SYS.active : b.dataset.desksave;
    const st = window.CC.state && window.CC.state(); $('#dsName').textContent = `"${(st && st.show && st.show.name) || $('#showName').textContent}"`;
    const atem = saveSys === 'atem'; $('#dsStartupRow').hidden = !atem; $('#dsStartupNote').hidden = !atem; $('#dsStartup').checked = true;
    $('#dlgDeskSave').returnValue = ''; $('#dlgDeskSave').showModal();
  });
  $('#dlgDeskSave').addEventListener('close', () => {
    if ($('#dlgDeskSave').returnValue !== 'save' || !saveSys) return;
    const startup = saveSys === 'atem' && $('#dsStartup').checked;
    CC.run(CC.api('POST', `/api/sys/${saveSys}/save`, { startup }).then((r) => {
      CC.toast(`Saved show "${r.show.name}"${r.startup ? ' · ATEM startup state saved' : ''}${r.startupError ? ` · ${r.startupError}` : ''}`, !!r.startupError);
    }));
  });
  window.CCSYS = { onRender: (fn) => listeners.push(fn), view: () => V, state: () => SYS, refetch, set };
  window.addEventListener('cc:tab', () => setTimeout(renderAll, 0));
  // ⚙ Settings is the RS6 device dialog; with another system active it opens the SYSTEMS dashboard instead
  $('#btnSettings').addEventListener('click', (e) => { if (isX()) { e.stopImmediatePropagation(); CC.setTab('system'); } }, true);
  $('#btnSystem').addEventListener('click', () => CC.setTab('system'));
  setInterval(() => { if (CC.getTab() === 'system') { const c = $('#dashClock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } }, 1000);
  refetch();
})();
