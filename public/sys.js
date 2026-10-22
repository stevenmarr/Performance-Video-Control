'use strict';
// Control Center (0.6.0, 0.7.0): the SYSTEMS home page (dashboard + every connection setting) and the shared
// preset-switcher UI for E2 / PixelHue. RS6 keeps its own tabs (public/app.js); ATEM and PTZ have theirs
// (public/atem.js, public/ptz.js), fed from here through window.CCSYS. State arrives as the `sys` event on the
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
  const MONO = { rs6: 'AW', e2: 'EM', pixelhue: 'PH', atem: 'BM', ptz: 'PTZ' };
  const KIND_TABS = { rs6: ['presets', 'inputs', 'backup', 'audio', 'webrcs'], preset: ['xpresets', 'xcues', 'xsources', 'xstills', 'xbackup'], atem: ['atem', 'aaux', 'amacros'], ptz: ['pctl', 'ppresets', 'pcams'] };
  const HOME_TAB = { rs6: 'presets', preset: 'xpresets', atem: 'atem', ptz: 'pctl' };
  const XTABS = KIND_TABS.preset;
  const RS6TABS = KIND_TABS.rs6;
  const listeners = [];
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

  // ---------- system switch / chrome ----------
  function applyChrome() {
    const a = SYS.active; const sysInfo = SYS.systems[a];
    for (const k of Object.keys(SYS.systems)) document.body.classList.toggle(`sys-${k}`, k === a);
    for (const k of Object.keys(KIND_TABS)) document.body.classList.toggle(`kind-${k}`, k === kind());
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
      const where = V.system === 'ptz' ? `${s.online || 0}/${s.total || 0} cameras` : esc(V.connection.host || '');
      const model = (s.info && s.info.model) || ''; const short = model.toUpperCase().startsWith(String(sysInfo.short).toUpperCase()) ? '' : sysInfo.short; // "ATEM ATEM ..." -> "ATEM ..."
      c.innerHTML = (s.connected ? `${esc(short)} ${V.system === 'ptz' ? '' : `${esc(model)} ${esc(ver(s.info && s.info.version))} · `}${where}` : `${esc(sysInfo.short)} not connected${s.error ? ' · ' + esc(s.error).slice(0, 50) : ''}`) + (V.connection.mock ? '<span class="mock">MOCK</span>' : '');
      let last = '';
      if (V.kind === 'preset') last = V.lastRecalled ? `PVW: ${V.lastRecalled.number} · ${V.lastRecalled.name}` : 'PVW: —';
      else if (V.kind === 'atem' && V.inputs && V.inputs.length) { const nm = (id) => { const i = V.inputs.find((x) => x.id === id); return i ? i.short : '—'; }; last = `PGM ${nm(V.program)} · PVW ${nm(V.preview)}`; }
      else if (V.kind === 'ptz') { const c2 = (V.cameras || []).find((x) => x.id === V.selected); last = c2 ? `CAM: ${c2.name}` : 'CAM: —'; }
      $('#xlast').textContent = last;
    }
    // the current tab must belong to the active system
    const tab = CC.getTab(); const k = kind();
    if (tab !== 'system' && !KIND_TABS[k].includes(tab)) CC.setTab(HOME_TAB[k]);
    else if (isX() && V && KIND_TABS[k].includes(tab)) { const t = document.querySelector(`.tab[data-tab=${tab}]`); if (t && t.hidden) CC.setTab(HOME_TAB[k]); }
    landed = true;
  }
  // Landing: the SYSTEMS page is home. A deep link (/#presets, /#xpresets, /#atem, ...) opens that tab instead.
  (() => {
    const h = decodeURIComponent((location.hash || '').replace(/^#\/?/, '').replace(/^tab=/, ''));
    if (h && document.querySelector(`.tab[data-tab="${h.replace(/[^\w-]/g, '')}"]`)) { window.__ccTabClicked = true; CC.setTab(h); } else CC.setTab('system');
  })();

  // ---------- dashboard (home): status + every connection setting ----------
  let density = localStorage.getItem('cc.density') || 'cards';
  let groupSel = localStorage.getItem('cc.group') || 'all';
  const f = (name, label, type, val, ph, dis, extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" ${dis} ${extra}></label>`;
  function connForm(s) {
    const c = s.connection || {}; const dis = c.mock ? 'disabled' : '';
    const foot = (k) => `<div class="actions left">${c.mock ? '<span class="note small">Mock mode: connected to the built-in mock, fixed.</span>' : '<button class="btn mini primary" value="save">SAVE &amp; CONNECT</button>'}
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
    const defPort = { e2: 9999, pixelhue: 8088, atem: 9910 }[s.key];
    return `<form class="form conn-form" data-sys="${s.key}">
      <div class="row2">${f('host', 'IP address', 'text', c.host, s.key === 'e2' ? 'E2 host unit IP' : s.key === 'atem' ? 'ATEM IP' : 'switcher IP', dis, 'autocomplete="off" spellcheck="false"')}${f('port', s.key === 'atem' ? 'UDP port' : 'Port', 'number', c.port, String(defPort), dis, 'min="1" max="65535"')}</div>
      <div class="row2">${extra}</div>
      ${s.key === 'pixelhue' ? `<label class="chk"><input type="checkbox" name="swap" ${c.swap ? 'checked' : ''} ${dis}> Swap on TAKE / CUT (Program goes back to Preview)</label>` : ''}
      ${foot(s.key)}
    </form>`;
  }
  function statsOf(s) {
    const n = s.counts || {};
    const rows = s.kind === 'atem' ? [['SOURCES', n.sources], ['MACROS', n.macros], ['KEYS', n.keyers], ['AUX', n.aux]]
      : s.kind === 'ptz' ? [['CAMERAS', n.cameras], ['ONLINE', n.online], ['ON TALLY', n.tally], ['NAMED PRESETS', n.presets]]
        : [['PRESETS', n.presets], ['DESTINATIONS', n.destinations], ['SOURCES', n.sources]].concat(s.key === 'e2' ? [['CUES', n.cues]] : []);
    return rows.map(([k, v]) => `<div class="stat"><b>${v ?? '—'}</b><span>${k}</span></div>`).join('');
  }
  function liveLine(s) {
    const n = s.counts || {};
    if (s.kind === 'atem' && n.program) return `<div class="live-line"><span class="lg pgm">PGM</span> ${esc(n.program)} <span class="lg pvw">PVW</span> ${esc(n.preview)}</div>`;
    if (s.kind === 'ptz' && (s.cameras || []).length) return `<div class="live-line cams">${s.cameras.map((c) => `<span class="cam-chip ${c.connected ? '' : 'off'} ${c.tally ? 'tally' : ''}"><span class="led ${c.connected ? 'ok' : 'off'}"></span>${esc(c.name)}</span>`).join('')}</div>`;
    return '';
  }
  function renderDash() {
    const clock = $('#dashClock'); if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const all = Object.values(SYS.systems); const sts = all.map(statusOf);
    $('#dashSummary').innerHTML = `<b>${all.length}</b> systems · <span class="ok">${sts.filter((x) => x.cls === 'ok').length} online</span> · <span class="off">${sts.filter((x) => x.cls === 'off' || x.cls === 'warn').length} offline / degraded</span> · <span class="idle">${sts.filter((x) => x.cls === 'idle').length} not configured</span>`;
    document.querySelectorAll('[data-density]').forEach((b) => b.classList.toggle('active', b.dataset.density === density));
    const card = (s) => {
      const st = statusOf(s); const active = SYS.active === s.key; const info = (s.status && s.status.info) || {};
      return `<article class="sys-card ${active ? 'active' : ''} ${st.cls}" data-card="${s.key}">
        <header><div class="mono">${MONO[s.key] || '?'}</div><div class="ttl"><div class="sys-grp">${esc(s.group || '')}</div><div class="nm">${esc(s.label)}</div>
          <div class="st"><span class="led ${st.cls}"></span>${st.txt}${info.model ? ` · ${esc(info.model)} ${esc(ver(info.version))}` : ''}${s.connection && s.connection.mock ? ' <span class="mock">MOCK</span>' : ''}</div></div>
          ${active ? '<span class="badge-active">ACTIVE</span>' : `<button type="button" class="btn mini primary" data-use="${s.key}">USE THIS SYSTEM</button>`}</header>
        ${s.status && s.status.error && (st.cls === 'off' || st.cls === 'warn') ? `<div class="err small">${esc(s.status.error).slice(0, 140)}</div>` : ''}
        <div class="stats">${statsOf(s)}</div>${liveLine(s)}
        ${active ? `<div class="actions left"><button type="button" class="btn mini" data-open="${s.key}">OPEN ${s.kind === 'atem' ? 'SWITCHER' : s.kind === 'ptz' ? 'PTZ CONTROL' : 'PRESETS'} →</button></div>` : ''}
        <details data-det="${s.key}" ${openDet.has(s.key) || !s.configured ? 'open' : ''}><summary>Connection${s.key === 'ptz' ? ' · cameras' : ''}</summary>${connForm(s)}</details>
      </article>`;
    };
    // one flowing grid (scales to many cards); group chips filter it; the active system always comes first
    const groups = SYS.groups || [{ name: 'Systems', systems: Object.keys(SYS.systems) }];
    if (groupSel !== 'all' && !groups.some((g) => g.name === groupSel)) groupSel = 'all';
    const chip = (key, label, n) => `<button class="mode ${groupSel === key ? 'active' : ''}" data-group="${esc(key)}" type="button">${esc(label)} <small>${n}</small></button>`;
    set($('#dashGroups'), 'groups', chip('all', 'ALL', all.length) + groups.map((g) => chip(g.name, g.name.toUpperCase(), g.systems.length)).join(''));
    const keys = (groupSel === 'all' ? groups.flatMap((g) => g.systems) : groups.find((g) => g.name === groupSel).systems).slice().sort((x, y) => (x === SYS.active ? -1 : y === SYS.active ? 1 : 0));
    const cards = `<div class="sys-cards ${density}">${keys.map((k) => card(SYS.systems[k])).join('')}</div>`;
    // keep a focused connection form from being replaced while typing
    if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('#sysCards')) set($('#sysCards'), 'cards', cards);
    $('#sysPlannedWrap').hidden = !(SYS.planned || []).length;
    set($('#sysPlanned'), 'planned', (SYS.planned || []).map((p) => `<article class="sys-card planned"><header><div class="mono">${MONO[p.key] || '?'}</div><div class="ttl"><div class="nm">${esc(p.label)}</div><div class="st"><span class="led idle"></span>${esc(p.kind)} · NOT BUILT</div></div><span class="badge-stub">STUB</span></header><div class="note small">${esc(p.note)}</div></article>`).join(''));
  }
  const openDet = new Set(JSON.parse(localStorage.getItem('cc.det') || '[]'));
  $('#sysCards').addEventListener('toggle', (ev) => { const d = ev.target; if (!d.dataset || !d.dataset.det) return; if (d.open) openDet.add(d.dataset.det); else openDet.delete(d.dataset.det); localStorage.setItem('cc.det', JSON.stringify([...openDet])); }, true);
  $('#dashGroups').addEventListener('click', (ev) => { const b = ev.target.closest('[data-group]'); if (!b) return; groupSel = b.dataset.group; localStorage.setItem('cc.group', groupSel); renderDash(); });
  document.querySelectorAll('[data-density]').forEach((b) => b.addEventListener('click', () => { density = b.dataset.density; localStorage.setItem('cc.density', density); html.cards = null; renderDash(); }));
  const camRow = (el) => ({ name: el.querySelector('[name=name]').value.trim(), host: el.querySelector('[name=host]').value.trim(), port: Number(el.querySelector('[name=port]').value) || 80 });
  $('#sysCards').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.use) return run(api('POST', '/api/sys/active', { system: b.dataset.use }).then((st) => { onSys(st); toast(`Now driving: ${st.systems[st.active].label}`); }));
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
    applyChrome();
    const t = CC.getTab();
    if (t === 'system') renderDash();
    if (isX() && V && V.kind === 'preset') {
      if (t === 'xpresets') renderPresets(); else if (t === 'xsources') renderSources(); else if (t === 'xcues') renderCues(); else if (t === 'xstills') renderStills(); else if (t === 'xbackup') renderBackups();
    }
    for (const fn of listeners) { try { fn(V, t, SYS); } catch (e) { console.error(e); } }
  }
  function onSys(st) { if (!st || (SYS && st.rev < SYS.rev && st.active === SYS.active)) return; SYS = st; V = st.view; renderAll(); }
  async function refetch() { try { onSys(await api('GET', '/api/sys')); } catch { /* the stream will bring it */ } }
  window.addEventListener('cc:sys', (e) => onSys(e.detail));
  // for public/atem.js and public/ptz.js
  window.CCSYS = { onRender: (fn) => listeners.push(fn), view: () => V, state: () => SYS, refetch, set };
  window.addEventListener('cc:tab', () => setTimeout(renderAll, 0));
  // ⚙ Settings is the RS6 device dialog; with another system active it opens the SYSTEMS dashboard instead
  $('#btnSettings').addEventListener('click', (e) => { if (isX()) { e.stopImmediatePropagation(); CC.setTab('system'); } }, true);
  $('#btnSystem').addEventListener('click', () => CC.setTab('system'));
  setInterval(() => { if (CC.getTab() === 'system') { const c = $('#dashClock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } }, 1000);
  refetch();
})();
