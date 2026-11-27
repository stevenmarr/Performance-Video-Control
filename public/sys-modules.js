'use strict';
// 0.33.0: the module systems on SYSTEMS (the MODULES tab is gone). Control Center has two kinds of control module:
// the native systems (RS6, E2, PixelHue, ATEM, PTZ, Pixera, Millumin, Videohub, HyperDeck, Mitti; public/sys.js owns
// their desk cards) and the protocol modules ModuleDesk opens (vMix, OBS, QLab, grandMA3 ... lib/modules). This file
// loads the second kind, draws their AVAILABLE rows and desk cards, and the BUTTONS · VARIABLES · FEEDBACKS section
// every desk card has (what MODULES showed). Companion modules with no Control Center module ("not yet") are not listed.
(() => {
  const CC = window.CC;
  if (!CC) return;
  const { api, toast, run, esc } = CC;
  let lite = null; // { systems: [...] } from GET /api/modules/lite
  let desk = []; // module instances
  const detail = new Map(); // system id -> full system (connection fields, buttons, variables, feedbacks)
  const svgCache = new Map();
  let theme = localStorage.getItem('cc.buttonTheme') === 'light' ? 'light' : 'dark';
  let armed = null; // a confirm button waiting for its second press
  let removeArmed = null;
  const CAT = { switcher: 'Production switchers', camera: 'Cameras', playback: 'Media servers', router: 'Routers', recorder: 'Recorders', audio: 'Audio', lighting: 'Lighting', display: 'Displays and projectors', processor: 'Processors', graphics: 'Graphics', led: 'LED', utility: 'Utility', show: 'Show control', generic: 'Generic protocols', tally: 'Tally', monitor: 'Monitors' };
  const groupOf = (s) => CAT[s.category] || (s.category ? s.category[0].toUpperCase() + s.category.slice(1) : 'Other');
  const mono = (s) => String(s.short || s.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';
  const emit = () => window.dispatchEvent(new CustomEvent('cc:mods'));

  async function load() {
    const r = await api('GET', '/api/modules/lite');
    lite = { systems: r.systems || [] };
    desk = r.instances || [];
    for (const i of desk) ensureDetail(i.system);
    emit();
  }
  async function refresh() {
    try { const r = await api('GET', '/api/modules/instances'); const next = r.instances || []; if (JSON.stringify(next) !== JSON.stringify(desk)) { desk = next; emit(); } } catch { /* next tick */ }
  }
  function ensureDetail(id) {
    if (!id || detail.has(id)) return detail.get(id) || null;
    detail.set(id, null);
    api('GET', `/api/modules/systems/${encodeURIComponent(id)}${theme === 'light' ? '?theme=light' : ''}`).then((s) => { detail.set(id, s); emit(); }).catch(() => detail.delete(id));
    return null;
  }
  setInterval(() => { if (CC.getTab() === 'system' && desk.length && !document.hidden) refresh(); }, 3000);

  const systems = () => (lite ? lite.systems.filter((s) => !s.nativeId) : []);
  const nativeEntry = (type) => (lite ? lite.systems.find((s) => s.nativeId === type) : null) || null;
  const sysOf = (id) => (lite ? lite.systems.find((s) => s.id === id) : null) || null;
  const countOf = (id) => desk.filter((i) => i.system === id).length;
  function configured(i) { const c = i.connection || {}; return !!(c.host || (c.server && c.port)); }
  function statusOf(i) {
    if (!configured(i)) return { cls: 'idle', txt: 'NOT SET UP' };
    if (i.status === 'online') return { cls: 'ok', txt: 'ONLINE' };
    if (i.status === 'connecting') return { cls: 'warn', txt: 'CONNECTING' };
    return { cls: 'off', txt: i.error ? 'OFFLINE' : 'CONFIGURED' };
  }
  const onDeskLine = (n) => (n ? `<span class="led ok"></span>${n} ON DESK` : '<span class="led idle"></span>NOT ON DESK');

  function palRow(s) {
    const n = countOf(s.id);
    return `<article class="sys-card avail mod-avail ${n ? 'has' : 'idle'}" data-card="mod:${esc(s.id)}" data-pal="mod:${esc(s.id)}" draggable="true" title="${esc(s.label)}${s.manufacturer ? ` · ${esc(s.manufacturer)}` : ''}. ${esc(s.summary || '')} Drag onto the desk, or ADD.">
      <div class="mono" style="border-color:${esc(s.bar || '')}">${esc(mono(s))}</div>
      <div class="nm">${esc(s.short || s.label)}</div>
      <div class="st">${onDeskLine(n)}</div>
      <div class="sys-acts"><button type="button" class="btn mini primary" data-modadd="${esc(s.id)}">ADD</button></div>
    </article>`;
  }

  function field(f, conn) {
    const val = conn[f.id] != null ? conn[f.id] : f.default;
    const name = esc(f.id);
    if (f.type === 'boolean') return `<label>${esc(f.label)}<select name="${name}"><option value="false" ${val ? '' : 'selected'}>No</option><option value="true" ${val ? 'selected' : ''}>Yes</option></select></label>`;
    if (f.secret) return `<label>${esc(f.label)}<input name="${name}" type="password" value="" placeholder="${conn[f.id] ? 'saved, leave blank to keep' : ''}" autocomplete="off"></label>`;
    return `<label>${esc(f.label)}<input name="${name}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(val == null ? '' : val)}" autocomplete="off" spellcheck="false"></label>`;
  }
  function form(i, full) {
    if (!full) return '<p class="note small">Loading the connection settings…</p>';
    const conn = i.connection || {};
    return `<form class="form conn-form mod-form" data-modform="${esc(i.id)}">
      <label>Name on the desk<input name="__name" type="text" value="${esc(i.name || '')}" maxlength="40"></label>
      ${(full.connection.fields || []).map((f) => field(f, conn)).join('')}
      <div class="actions left"><button class="btn mini primary" type="submit">SAVE &amp; CONNECT</button></div></form>`;
  }
  // BUTTONS · VARIABLES · FEEDBACKS: what MODULES showed for one system, now on its desk card
  function panelDetails(systemId, instId, key) {
    const s = sysOf(systemId);
    if (!s) return '';
    const c = s.counts || {};
    return `<details data-det="${esc(key)}" data-modpanel="${esc(systemId)}" data-modinst="${esc(instId || '')}"><summary>BUTTONS · VARIABLES · FEEDBACKS <span class="cfg-sum">${c.buttons || 0} / ${c.variables || 0} / ${c.feedbacks || 0}</span></summary><div class="mod-panel"></div></details>`;
  }

  function instRow(i, openDet) {
    const s = sysOf(i.system) || { id: i.system, short: i.system, label: i.label || i.system };
    const full = ensureDetail(i.system);
    const st = statusOf(i);
    const c = i.connection || {};
    const addr = c.host ? `${c.host}${c.port ? `:${c.port}` : ''}` : c.server && c.port ? `listening on ${c.port}` : 'no address';
    const isOpen = (k) => (openDet && openDet.has(k) ? 'open' : '');
    const online = i.status === 'online' || i.status === 'connecting';
    const rmLabel = removeArmed === i.id ? 'PRESS AGAIN TO REMOVE' : 'REMOVE FROM DESK';
    const vars = Object.keys(i.vars || {}).length;
    return `<article class="sys-card on-desk mod-desk ${st.cls}" data-modcard="${esc(i.id)}">
      <header><div class="mono" style="border-color:${esc(s.bar || '')}">${esc(mono(s))}</div><div class="ttl"><div class="sys-grp">${esc(groupOf(s))}</div><div class="nm">${esc(i.name || s.short)}</div>
        <div class="st"><span class="led ${st.cls}"></span>${st.txt} · ${esc(s.label)} module</div></div></header>
      ${i.error && st.cls !== 'ok' ? `<div class="err small">${esc(i.error).slice(0, 140)}</div>` : ''}
      <div class="sys-acts">${configured(i) ? `<button type="button" class="btn mini" data-modlink="${esc(i.id)}" data-on="${online ? '0' : '1'}">${online ? 'DISCONNECT' : 'CONNECT'}</button>` : ''}<button type="button" class="btn mini danger" data-modrm="${esc(i.id)}">${rmLabel}</button></div>
      <div class="stats"><div class="stat"><b>${vars}</b><span>VARIABLES</span></div><div class="stat"><b>${i.lastSeen ? esc(new Date(i.lastSeen).toLocaleTimeString()) : '—'}</b><span>LAST ANSWER</span></div></div>
      ${full && full.docs && full.docs.url ? `<p class="note small">Protocol: <a href="${esc(full.docs.url)}" target="_blank" rel="noopener">${esc(full.docs.title || full.docs.url)}</a>${full.docs.basis ? ` · ${esc(full.docs.basis)}` : ''}</p>` : ''}
      <details data-det="mod:${esc(i.id)}" ${isOpen(`mod:${i.id}`) || (!configured(i) ? 'open' : '')}><summary>CONFIGURE <span class="cfg-sum">${esc(addr)}</span></summary>${form(i, full)}</details>
      ${panelDetails(i.system, i.id, `modp:${i.id}`).replace('<details ', `<details ${isOpen(`modp:${i.id}`)} `)}
    </article>`;
  }
  // the same section on a native desk card (its buttons use the SYSTEMS connection)
  function nativePanel(type, instId, openDet) {
    const s = nativeEntry(type);
    if (!s) return '';
    const key = `modp:${instId}`;
    return panelDetails(s.id, '', key).replace('<details ', `<details ${openDet && openDet.has(key) ? 'open' : ''} `);
  }

  async function preview(system, button, flags) {
    const k = `${system.id}|${button.action}|${theme}|${JSON.stringify(flags || {})}`;
    if (svgCache.has(k)) return svgCache.get(k);
    const res = await api('POST', '/api/modules/preview', { system: system.id, action: button.action, theme, flags: flags || {} });
    if (svgCache.size > 600) svgCache.clear();
    svgCache.set(k, res.svg);
    return res.svg;
  }
  async function paintPanel(det) {
    const host = det.querySelector('.mod-panel');
    if (!host) return;
    const sysId = det.dataset.modpanel; const instId = det.dataset.modinst;
    const full = detail.get(sysId) || null;
    if (!full) { host.innerHTML = '<p class="note small">Loading…</p>'; ensureDetail(sysId); return; }
    const row = instId ? desk.find((i) => i.id === instId) : null;
    const flags = (row && row.flags) || {};
    const vars = (row && row.vars) || {};
    const buttons = full.buttons || [];
    const declared = new Set((full.variables || []).map((v) => v.id));
    const extraIds = Object.keys(vars).filter((id) => !declared.has(id)).sort();
    const varRows = (full.variables || []).map((v) => `<tr><td><code>$(${esc(full.id)}:${esc(v.id)})</code><div class="note small">${esc(v.label)}</div></td><td>${esc(vars[v.id] == null ? '' : vars[v.id])}</td></tr>`).concat(extraIds.map((id) => `<tr><td><code>$(${esc(full.id)}:${esc(id)})</code><div class="note small">Control</div></td><td>${esc(vars[id] == null ? '' : vars[id])}</td></tr>`)).join('') || '<tr><td colspan="2" class="note small">None.</td></tr>';
    const sig = JSON.stringify([sysId, instId, theme, flags, vars]);
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    host.innerHTML = `<div class="mod-head"><small>${esc(full.summary || '')}</small><button type="button" class="btn mini mod-theme" data-modtheme="1">${theme === 'light' ? 'LIGHT BUTTONS' : 'DARK BUTTONS'}</button></div>
      <div class="section-title">BUTTONS <small>Tap to send. They also appear as Companion presets.</small></div>
      <div class="mod-keys ${theme}">${buttons.map((b, n) => `<button type="button" class="mod-key" data-modkey="${n}"><span class="art"></span><span>${esc(b.name)}</span></button>`).join('') || '<p class="note small">No buttons.</p>'}</div>
      <div class="section-title">VARIABLES</div>
      <table class="mod-table"><thead><tr><th>Variable</th><th>Value</th></tr></thead><tbody>${varRows}</tbody></table>
      <div class="section-title">FEEDBACKS</div>
      <table class="mod-table"><thead><tr><th>Feedback</th><th>State</th></tr></thead><tbody>${(full.feedbacks || []).map((f) => `<tr><td>${esc(f.label)}<div class="note small">${esc(f.variable)} ${esc(f.op)} ${esc(f.value)}</div></td><td class="${flags[f.id] ? 'mod-on' : 'mod-off'}">${row ? (flags[f.id] ? 'ON' : 'OFF') : '—'}</td></tr>`).join('') || '<tr><td colspan="2" class="note small">None.</td></tr>'}</tbody></table>`;
    await Promise.all(buttons.map(async (b, n) => {
      const el = host.querySelector(`[data-modkey="${n}"] .art`);
      if (!el) return;
      try { el.innerHTML = await preview(full, b, flags); } catch { el.textContent = b.text || b.name; }
    }));
  }
  function paintOpen(root) { (root || document).querySelectorAll('details[data-modpanel][open]').forEach((d) => paintPanel(d)); }

  async function press(det, n) {
    const full = detail.get(det.dataset.modpanel);
    const button = full && full.buttons[n];
    if (!button) return;
    if (button.confirmMode === 'body') {
      const now = Date.now();
      if (!armed || armed.id !== button.action || now - armed.at > 4000) { armed = { id: button.action, at: now }; toast('Press again to confirm'); return; }
      armed = null;
    }
    const req = button.request;
    if (!req || !req.path) { toast('This button has no command', true); return; }
    let path = req.path;
    const body = { ...(req.body || {}) };
    if (button.confirmMode === 'body') body.confirm = true;
    if (path.includes('INSTANCE')) {
      if (!det.dataset.modinst) { toast('Add this system to the desk first', true); return; }
      path = path.replace('INSTANCE', encodeURIComponent(det.dataset.modinst));
    }
    const res = await api(req.method || 'POST', path, req.method === 'GET' ? undefined : body);
    toast(res && res.pending ? 'Press again to confirm' : `${button.name} sent`);
    await refresh();
  }

  function add(id) {
    const s = sysOf(id);
    return run(api('POST', '/api/modules/instances', { system: id }).then(async () => { await refresh(); toast(`${(s && s.short) || id} added to the desk. Set its address under CONFIGURE.`); }));
  }

  // events inside #sysCards (public/sys.js calls this from its own handlers)
  function onClick(ev) {
    const b = ev.target.closest('button');
    if (!b) return false;
    if (b.dataset.modadd) { add(b.dataset.modadd); return true; }
    if (b.dataset.modlink) {
      const on = b.dataset.on === '1';
      run(api('POST', `/api/modules/instances/${encodeURIComponent(b.dataset.modlink)}/${on ? 'connect' : 'disconnect'}`).then(refresh).then(() => toast(on ? 'Connecting' : 'Disconnected')));
      return true;
    }
    if (b.dataset.modrm) {
      const id = b.dataset.modrm;
      if (removeArmed !== id) { removeArmed = id; emit(); setTimeout(() => { if (removeArmed === id) { removeArmed = null; emit(); } }, 4000); return true; }
      removeArmed = null;
      run(api('DELETE', `/api/modules/instances/${encodeURIComponent(id)}`).then(refresh).then(() => toast('Removed from the desk')));
      return true;
    }
    if (b.dataset.modtheme) {
      theme = theme === 'light' ? 'dark' : 'light'; localStorage.setItem('cc.buttonTheme', theme);
      document.querySelectorAll('.mod-panel').forEach((h) => { h.dataset.sig = ''; });
      paintOpen(); return true;
    }
    if (b.dataset.modkey != null) {
      const det = b.closest('details[data-modpanel]');
      if (det) run(press(det, Number(b.dataset.modkey)));
      return true;
    }
    return false;
  }
  function onSubmit(ev) {
    const fm = ev.target.closest('[data-modform]');
    if (!fm) return false;
    ev.preventDefault();
    const id = fm.dataset.modform;
    const connection = {}; let name = '';
    for (const el of fm.elements) {
      if (!el.name) continue;
      if (el.name === '__name') { name = el.value.trim(); continue; }
      if (el.type === 'password' && !el.value) continue;
      connection[el.name] = el.type === 'number' ? Number(el.value) : el.value === 'true' ? true : el.value === 'false' ? false : el.value.trim();
    }
    if (document.activeElement) document.activeElement.blur();
    const body = { connection }; if (name) body.name = name;
    run(api('POST', `/api/modules/instances/${encodeURIComponent(id)}/connection`, body)
      .then((row) => (row.connection && (row.connection.host || (row.connection.server && row.connection.port)) ? api('POST', `/api/modules/instances/${encodeURIComponent(id)}/connect`).catch((e) => toast(e.message, true)) : null))
      .then(refresh).then(() => toast('Connection saved')));
    return true;
  }
  function onDrop(type) {
    if (!String(type).startsWith('mod:')) return false;
    add(type.slice(4));
    return true;
  }
  function onToggle(det) { if (det.dataset && det.dataset.modpanel && det.open) paintPanel(det); }

  window.CCMOD = {
    load, refresh, ready: () => !!lite, systems, nativeEntry, sysOf, countOf, groupOf, instances: () => desk.slice(),
    statusOf, palRow, instRow, nativePanel, paintOpen, onClick, onSubmit, onDrop, onToggle,
  };
  load().catch(() => { lite = { systems: [] }; emit(); });
})();
