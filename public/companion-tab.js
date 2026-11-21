'use strict';
// COMPANION, a top-level tab (0.31.0). Control Center defines buttons (BUTTONS)
// and pages (PAGES). Companion, and Steven's fork with its page designs and page
// templates, assigns them to Stream Decks. This tab shows whether Companion is
// answering on host:port, whether the Control Center module (pvllc-control-center, or the
// legacy rs6-presets id) is
// installed and current, lets you SYNC CC buttons and pages into it, download a
// page as a .companionconfig, and opens Companion's own web UI.
// 0.34.0: Control Center runs Companion (COMPANION SERVICE card) and shows its UI at /companion/, same origin.
(() => {
  const root = document.querySelector('#companionRoot');
  if (!root || !window.CC) return;
  const { api, toast, run, esc } = window.CC;
  let view = null;
  let showFrame = localStorage.getItem('cc.companion.frame') !== '0';
  let frameUrl = '';

  function statusLine(v) {
    const s = v.status || {};
    if (!s.checked) return { cls: '', txt: 'Not checked yet' };
    if (!s.online) return { cls: 'off', txt: `Not answering at ${v.webUrl}${s.error ? ` · ${s.error}` : ''}` };
    if (!s.httpApi) return { cls: 'warn', txt: s.error || 'Companion is running; its HTTP API is off' };
    return { cls: 'ok', txt: `Companion is running at ${v.webUrl}` };
  }

  function moduleLine(v) {
    const s = v.status || {};
    const m = v.module;
    const conns = s.connections || [];
    const rows = [];
    if (s.checked && s.httpApi) {
      rows.push(conns.length
        ? conns.map((c) => `<div class="cmp-row"><i class="cmp-dot ${c.enabled ? 'ok' : 'warn'}"></i><b>${esc(c.label || c.id)}</b><small>${esc(c.moduleId || v.moduleId)}${c.legacy ? ' (old id)' : ''}${c.versionId ? ` · ${c.versionId === 'builtin' ? 'built-in copy' : c.versionId === 'dev' ? 'dev copy' : `imported v${esc(c.versionId)}`}` : ''} · ${c.enabled ? 'enabled' : 'disabled'}${c.status && c.status.category ? ` · ${esc(c.status.category)}` : ''}${c.status && c.status.message ? ` · ${esc(c.status.message)}` : ''}</small></div>`).join('')
        : `<p class="note small">No Control Center module connection in Companion. Install the Control Center module, then add a "Performance Video Control Center" connection pointing at this app.</p>`);
      if (conns.some((c) => c.legacy)) rows.push(`<p class="note small">A connection still uses the old module id rs6-presets. It runs the old rs6-presets code, which does not see CC buttons and pages. PV Companion moves it to the built-in Performance Video Control Center module at start-up; in stock Companion import module 0.13.0 or newer from <a href="${esc(v.moduleRepo)}/releases" target="_blank" rel="noopener">the releases page</a>, then edit the connection and change its module to Performance Video Control Center.</p>`);
    }
    // 0.33.0: the deck pages (CC deck: presets), or why there are none and how to turn them on
    if (window.CCAdvice) for (const a of window.CCAdvice.deckAdvice(v)) rows.push(`<div class="cmp-row cmp-advice"><i class="cmp-dot ${a.cls}"></i><small>${esc(a.text)}</small></div>`);
    if (m) {
      rows.push(`<div class="cmp-row"><i class="cmp-dot ${m.current ? (m.stale ? 'warn' : 'ok') : 'off'}"></i><b>Module ${esc(m.version || '?')}</b><small>${m.label ? `${esc(m.label)} · ` : ''}last seen ${esc(new Date(m.at).toLocaleTimeString())}${m.presets != null ? ` · ${m.presets} CC button presets` : ''}${m.deckPresets != null ? ` · ${m.deckPresets} deck presets` : ''}</small></div>`);
      if (!m.current) rows.push(`<p class="note small">This Control Center module is older than ${esc(v.moduleMinVersion)}. It cannot see CC buttons and pages. Update it from <a href="${esc(v.moduleRepo)}/releases" target="_blank" rel="noopener">the releases page</a>.</p>`);
      else if (m.stale) rows.push('<p class="note small">The module has not picked up the latest buttons and pages yet. It checks every few seconds; SYNC forces it.</p>');
    } else {
      rows.push(`<p class="note small">The Control Center module has not reported in. It needs version ${esc(v.moduleMinVersion)} or newer: <a href="${esc(v.moduleRepo)}/releases" target="_blank" rel="noopener">releases</a>.</p>`);
    }
    return rows.join('');
  }

  // 0.34.0: COMPANION SERVICE. Control Center starts PV Companion (yarn start:local in ~/companion), restarts it
  // if it stops, and stops it when Control Center stops. Or "Companion runs separately" (external mode).
  const SERVICE_DOT = { running: 'ok', adopted: 'ok', starting: 'warn', stopping: 'warn', unhealthy: 'warn', backoff: 'off', error: 'off', 'not-installed': 'off', stopped: 'off', external: '' };
  let logsOpen = false;
  let logSeq = 0;
  function serviceCard(v) {
    const s = v.service;
    if (!s) return '';
    const st = s.settings || {};
    const managed = !!s.managed;
    const facts = [
      s.pid ? `pid ${s.pid}` : '',
      s.uptimeSec ? `up ${s.uptimeSec >= 3600 ? `${Math.floor(s.uptimeSec / 3600)} h ${Math.floor((s.uptimeSec % 3600) / 60)} min` : s.uptimeSec >= 60 ? `${Math.floor(s.uptimeSec / 60)} min` : `${s.uptimeSec} s`}` : '',
      s.restarts ? `${s.restarts} restart${s.restarts === 1 ? '' : 's'}` : '',
      s.node && s.node.version ? `Node ${s.node.version}` : '',
      managed ? `port ${s.port}` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="cmp-card" id="cmpService"><h3>COMPANION SERVICE</h3>
      <div class="cmp-row"><i class="cmp-dot ${SERVICE_DOT[s.state] || ''}"></i><b>${esc(String(s.state || '').toUpperCase())}</b><small>${esc(facts)}</small><span class="spacer"></span>
        ${managed ? `<button type="button" class="btn mini" data-svc="restart">RESTART</button>${s.pid || s.state === 'backoff' || s.state === 'starting' ? '<button type="button" class="btn mini danger" data-svc="stop">STOP</button>' : '<button type="button" class="btn mini primary" data-svc="start">START</button>'}` : ''}</div>
      ${s.message ? `<p class="note small">${esc(s.message)}</p>` : ''}
      ${s.lastExit && managed && s.state !== 'running' ? `<p class="note small">Last exit: ${esc(s.lastExit.signal || `code ${s.lastExit.code}`)} after ${esc(s.lastExit.ranSec)} s.</p>` : ''}
      <div class="cmp-row"><label class="chk"><input type="checkbox" id="cmpSvcManaged"${managed ? ' checked' : ''}> <b>Run Companion inside Control Center</b></label></div>
      <details class="cmp-deck" id="cmpSvcSettings"><summary><b>Settings</b> <small>${esc(st.path || '~/companion')}</small></summary>
        <form id="cmpSvcForm">
          <div class="cmp-row"><label>Companion folder <input name="path" value="${esc(st.path || '')}" placeholder="~/companion" spellcheck="false" size="22"></label></div>
          <div class="cmp-row"><label>Config folder <input name="configDir" value="${esc(st.configDir || '')}" placeholder="~/companion-config" spellcheck="false" size="22"></label></div>
          <div class="cmp-row"><label>Port <input name="port" type="number" min="1" max="65535" value="${esc(st.port || 8000)}" style="width:6em"></label></div>
          <div class="cmp-row"><label>Node <input name="nodePath" value="${esc(st.nodePath || '')}" placeholder="automatic (Node 26.10+)" spellcheck="false" size="22"></label></div>
          <div class="cmp-row"><label>yarn <input name="yarnPath" value="${esc(st.yarnPath || '')}" placeholder="automatic" spellcheck="false" size="22"></label></div>
          <div class="cmp-row"><button class="btn mini primary">Save and restart</button></div>
          ${s.envOverrides && s.envOverrides.length ? `<p class="note small">Set in Control Center's environment (they win over these fields): ${esc(s.envOverrides.join(', '))}.</p>` : ''}
          <p class="note small">Control Center runs <code>yarn start:local</code> in the Companion folder, like Terminal does. Update Companion with <code>git pull</code> in that folder, then RESTART here.${s.node && s.node.path ? ` Using ${esc(s.node.path)}.` : ''}</p>
        </form></details>
      ${managed ? `<details class="cmp-deck" id="cmpSvcLogs"${logsOpen ? ' open' : ''}><summary><b>Log</b> <small>last lines from Companion</small></summary><pre class="cmp-log" id="cmpLog"></pre></details>` : ''}
    </div>`;
  }
  let logText = '';
  async function loadLogs() {
    if (!logsOpen) return;
    try {
      const r = await api('GET', `/api/companion/service/logs?since=${logSeq}&limit=400`);
      if (r.lines && r.lines.length) {
        logText = (logText + r.lines.map((l) => `${l.t.slice(11, 19)} ${l.stream === 'err' ? '!' : l.stream === 'cc' ? '>' : ' '} ${l.text}`).join('\n') + '\n').split('\n').slice(-600).join('\n');
        logSeq = r.seq;
      }
    } catch { /* the status card already says what is wrong */ }
    const pre = root.querySelector('#cmpLog');
    if (pre) { const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8; pre.textContent = logText; if (atEnd) pre.scrollTop = pre.scrollHeight; }
  }

  // 0.31.1: who opens the USB Stream Decks, Control Center or Companion.
  function decksCard(v) {
    const d = v.decks || { drive: false, setting: 'auto', companionUsed: false, released: 0 };
    const auto = d.setting === 'auto';
    const state = d.drive
      ? `Companion drives the Stream Decks. Control Center has closed its USB deck handles${d.released ? ` (${d.released} released)` : ''} and does not open decks.`
      : 'Control Center opens the USB Stream Decks (Control Devices tab). Companion cannot open a deck Control Center holds.';
    return `<div class="cmp-card"><h3>STREAM DECKS</h3>
      <div class="cmp-row"><label class="chk"><input type="checkbox" id="cmpDriveDecks"${d.drive ? ' checked' : ''}> <b>Let Companion drive Stream Decks</b></label>
        <span class="spacer"></span>${auto ? '<small>automatic</small>' : '<button type="button" class="btn mini" id="cmpDecksAuto" title="On once Companion is in use (the module reported in, or a check found its connection)">Automatic</button>'}</div>
      <div class="cmp-row"><i class="cmp-dot ${d.drive ? 'ok' : 'off'}"></i><small>${esc(state)}</small></div>
      <p class="note small">${auto ? `Automatic: ${d.companionUsed ? 'on, because Companion is in use with this app' : 'off until the Control Center module reports in or a check finds its connection'}. ` : ''}Turn it off to drive the decks from Control Center again; quit Companion (or disable its Stream Deck surface) first.</p>
    </div>`;
  }

  // The left column (status, module, decks, sync) is repainted freely. The right
  // column holds Companion's web UI in an iframe and is only rebuilt when what it
  // shows changes (address, online, Show here): replacing or moving an iframe
  // reloads Companion's UI back to its start page (Connections). 0.31.2.
  let frameKey = null;
  // 0.34.0: Companion's web UI comes through Control Center at /companion/ (same origin, one web app).
  const uiUrl = (v) => v.uiUrl || v.webUrl;
  function frameHtml(v) {
    const url = uiUrl(v);
    const online = !!(v.status && v.status.online);
    const frame = showFrame && online
      ? `<iframe class="cmp-frame" src="${esc(url)}" title="Companion web UI" referrerpolicy="no-referrer"></iframe>`
      : `<p class="note">${online ? 'Companion\'s web UI is hidden.' : 'Companion\'s web UI shows here once Companion answers.'} <a href="${esc(url)}" target="_blank" rel="noopener">Open ${esc(url)} in a new window</a>.</p>`;
    return `<div class="cmp-row"><b>COMPANION WEB UI</b><span class="spacer"></span>
          <label class="chk"><input type="checkbox" id="cmpFrame"${showFrame ? ' checked' : ''}> Show here</label>
          <a class="btn mini" href="${esc(url)}" target="_blank" rel="noopener">Open in a new window</a></div>
        ${frame}`;
  }
  function leftHtml(v) {
    const st = statusLine(v);
    const pages = (v.pages || []).map((p) => `<div class="cmp-row"><b>${esc(p.name)}</b><small>${esc(p.label || p.surface)}</small><span class="spacer"></span><a class="btn mini" href="/api/companion/pages/${esc(p.id)}/companionconfig" download>.companionconfig</a></div>`).join('') || '<p class="note small">No pages yet. Make one on PAGES.</p>';
    const managed = !!(v.service && v.service.managed);
    return `${serviceCard(v)}<div class="cmp-card"><h3>CONNECTION</h3>
          <div class="cmp-row"><i class="cmp-dot ${st.cls}"></i><span>${esc(st.txt)}</span></div>
          ${managed ? `<p class="note small">Control Center runs Companion itself on ${esc(v.webUrl)} and shows it here at ${esc(uiUrl(v))}. Host and port below are only used when Companion runs separately.</p>` : ''}
          <form class="cmp-row" id="cmpConfig"><label>Host <input name="host" value="${esc(v.config.host)}" autocomplete="off" spellcheck="false" size="14"></label>
            <label>Port <input name="port" type="number" min="1" max="65535" value="${esc(v.config.port)}" style="width:6em"></label>
            <button class="btn mini primary">Save</button></form>
          <p class="note small">Companion's web UI is on port 8000 unless you changed it. Use this Mac's address (127.0.0.1) when Companion runs here.${v.status && v.status.checkedAt ? ` Checked ${esc(new Date(v.status.checkedAt).toLocaleTimeString())}.` : ''}</p>
        </div>
        <div class="cmp-card"><h3>MODULE</h3>${moduleLine(v)}</div>
        ${decksCard(v)}
        <div class="cmp-card"><h3>SYNC</h3>
          <div class="cmp-row"><span>${v.counts.buttons} buttons · ${v.counts.pages} pages</span><span class="spacer"></span><button type="button" class="btn mini primary" id="btnCmpSync">SYNC TO COMPANION</button></div>
          <p class="note small">The module publishes every CC button and page as Companion presets (Presets → Performance Video Control Center). SYNC tells it to refresh now${v.syncedAt ? `; last SYNC ${esc(new Date(v.syncedAt).toLocaleString())}` : ''}. Revision ${esc(v.rev)}.</p>
          <p class="note small">A whole page can also go across as a file. Download it, then in Companion use Import / Export → Import, pick the page to replace, and map "cc" to your Control Center module connection.</p>
          <div class="cmp-pages">${pages}</div>
        </div>
        ${deckPagesCard(v)}
        ${userPagesCard(v)}`;
  }

  // 0.33.0: pages edited in PV Companion and saved back (Control Center pages → Save to User pages). Stored in this
  // app's data, so they are backed up with it. Download one to import it in any Companion.
  function userPagesCard(v) {
    const list = v.userPages || [];
    const rows = list.map((p) => `<div class="cmp-row"><b>${esc(p.name)}</b><small>${p.controls} buttons${p.originTitle ? ` · from ${esc(p.originTitle)}` : ''} · ${esc(new Date(p.updatedAt).toLocaleString())}</small><span class="spacer"></span>
        <a class="btn mini" href="/api/companion/user-pages/${encodeURIComponent(p.id)}/companionconfig" download>.companionconfig</a>
        <button type="button" class="btn mini danger" data-userdel="${esc(p.id)}">${userDelArmed === p.id ? 'PRESS AGAIN' : 'DELETE'}</button></div>`).join('');
    return `<div class="cmp-card"><h3>USER PAGES</h3>
          <p class="note small">Control Center pages you edited in PV Companion and saved there with "Save to User pages". The Control Center originals never change. PV Companion lists these under Control Center pages → User pages.</p>
          ${rows || '<p class="note small">None yet.</p>'}</div>`;
  }
  let userDelArmed = null;

  // 0.32.0: the Stream Deck pages Control Center draws (HOME, PTZ, ATEM, CONSOLE) as
  // Companion pages. "Whole deck" follows HOME / page keys like a USB deck; a single
  // page stays on that page. The module 0.12.0 draws them, knobs and touch strip too.
  function deckPagesCard(v) {
    const list = v.deckPages || [];
    if (!list.length) return '';
    const rows = list.map((s) => {
      const base = `/api/companion/deck/${encodeURIComponent(s.surface)}/companionconfig`;
      const pages = s.pages.map((p) => `<div class="cmp-row"><span>${esc(p.title)}</span><small>${esc(p.id)}</small><span class="spacer"></span><a class="btn mini" href="${base}?pin=${encodeURIComponent(p.id)}" download>.companionconfig</a></div>`).join('');
      return `<details class="cmp-deck"><summary><b>${esc(s.label)}</b> <small>${s.pages.length} pages</small></summary>
          <div class="cmp-row"><span>Whole deck (follows HOME and page keys)</span><span class="spacer"></span><a class="btn mini primary" href="${base}" download>.companionconfig</a></div>
          ${pages}</details>`;
    }).join('');
    return `<div class="cmp-card"><h3>DECK PAGES</h3>
          <p class="note small">The PTZ, ATEM, HOME and CONSOLE pages this app draws on a Stream Deck, with the + / + XL knobs and touch-strip readouts (R / B gain, iris, detail ...). Needs the Control Center module 0.12.0. In Companion: Import / Export → Import, pick the page to replace, and map "cc" to your Control Center module connection. They are also under Presets → CC deck.</p>
          ${rows}</div>`;
  }

  function paint() {
    if (!view) { root.innerHTML = '<p class="note">Loading…</p>'; frameKey = null; return; }
    const v = view;
    let left = root.querySelector('#cmpLeft');
    let right = root.querySelector('#cmpRight');
    if (!left || !right) {
      root.innerHTML = '<div class="cmp-grid"><div id="cmpLeft"></div><div id="cmpRight"></div></div>';
      left = root.querySelector('#cmpLeft');
      right = root.querySelector('#cmpRight');
      frameKey = null;
    }
    // Do not repaint while the host / port fields are being typed in.
    const ae = document.activeElement;
    const typing = ae && ae.tagName === 'INPUT' && ae.closest && (ae.closest('#cmpConfig') || ae.closest('#cmpSvcForm'));
    const settingsOpen = !!(root.querySelector('#cmpSvcSettings') && root.querySelector('#cmpSvcSettings').open);
    if (!typing) {
      left.innerHTML = leftHtml(v);
      if (settingsOpen && left.querySelector) { const d = left.querySelector('#cmpSvcSettings'); if (d) d.open = true; }
      if (logsOpen) loadLogs();
    }
    const key = JSON.stringify([uiUrl(v), v.webUrl, !!(v.status && v.status.online), showFrame]);
    if (key !== frameKey) { right.innerHTML = frameHtml(v); frameKey = key; }
    frameUrl = v.webUrl;
  }

  async function load(check) {
    view = await api('GET', '/api/companion');
    if (check || !view.status.checked) view = await api('POST', '/api/companion/check');
    paint();
  }

  root.addEventListener('submit', (ev) => {
    if (ev.target.id === 'cmpSvcForm') {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const body = {};
      for (const k of ['path', 'configDir', 'port', 'nodePath', 'yarnPath']) body[k] = f.get(k);
      run(api('POST', '/api/companion/service/config', body).then(() => load(true)).then(() => toast('Companion settings saved')));
      return;
    }
    if (ev.target.id !== 'cmpConfig') return;
    ev.preventDefault();
    const f = new FormData(ev.target);
    run((async () => {
      await api('POST', '/api/companion/config', { host: f.get('host'), port: f.get('port') });
      await load(true);
      toast('Companion address saved');
    })());
  });
  root.addEventListener('click', (ev) => {
    const svc = ev.target.closest && ev.target.closest('[data-svc]');
    if (svc) {
      const what = svc.dataset.svc;
      run(api('POST', `/api/companion/service/${what}`).then(() => load(false)).then(() => toast(what === 'stop' ? 'Companion stopped' : what === 'start' ? 'Companion starting' : 'Companion restarting')));
      return;
    }
    if (ev.target.id === 'cmpDecksAuto') {
      run(api('POST', '/api/companion/decks', { drive: 'auto' }).then((v) => { view = v; paint(); }));
    }
    const del = ev.target.closest && ev.target.closest('[data-userdel]');
    if (del) {
      const id = del.dataset.userdel;
      if (userDelArmed !== id) { userDelArmed = id; paint(); setTimeout(() => { if (userDelArmed === id) { userDelArmed = null; paint(); } }, 4000); return; }
      userDelArmed = null;
      run(api('DELETE', `/api/companion/user-pages/${encodeURIComponent(id)}`).then(() => load(false)).then(() => toast('User page deleted')));
      return;
    }
    if (ev.target.id === 'btnCmpSync') {
      run(api('POST', '/api/companion/sync').then(() => load(false)).then(() => toast('Sync sent. The module refreshes its presets.')));
    }
  });
  root.addEventListener('toggle', (ev) => {
    if (ev.target && ev.target.id === 'cmpSvcLogs') { logsOpen = ev.target.open; if (logsOpen) loadLogs(); }
  }, true);
  root.addEventListener('change', (ev) => {
    if (ev.target.id === 'cmpSvcManaged') {
      const mode = ev.target.checked ? 'managed' : 'external';
      run(api('POST', '/api/companion/service/config', { mode }).then(() => load(true)).then(() => toast(mode === 'managed' ? 'Control Center runs Companion now' : 'Companion runs separately now')));
      return;
    }
    if (ev.target.id === 'cmpDriveDecks') {
      const drive = ev.target.checked;
      run(api('POST', '/api/companion/decks', { drive }).then((v) => { view = v; paint(); toast(drive ? 'Stream Decks released to Companion' : 'Control Center drives the Stream Decks again'); }));
      return;
    }
    if (ev.target.id === 'cmpFrame') {
      showFrame = ev.target.checked;
      localStorage.setItem('cc.companion.frame', showFrame ? '1' : '0');
      paint();
    }
  });
  document.querySelector('#btnCmpCheck')?.addEventListener('click', () => run(load(true)));

  let timer = null;
  window.addEventListener('cc:tab', (ev) => {
    clearInterval(timer);
    if (ev.detail !== 'companion') return;
    run(load(true).catch((e) => { root.innerHTML = `<p class="note">${esc(e.message)}</p>`; frameKey = null; }));
    // Status only. paint() keeps the iframe unless the address, online state or Show here changed,
    // so the module's hello (every 30 s, new `at`) no longer reloads Companion's UI.
    timer = setInterval(() => {
      if (document.hidden || !window.CC.getTab || window.CC.getTab() !== 'companion') return;
      api('POST', '/api/companion/check').then((v) => {
        const svcKey = (x) => JSON.stringify(x && x.service ? [x.service.state, x.service.message, x.service.pid, x.service.restarts, x.service.mode] : null);
        const changed = !view || svcKey(v) !== svcKey(view) || v.status.online !== view.status.online || v.webUrl !== frameUrl || JSON.stringify(v.module) !== JSON.stringify(view.module) || JSON.stringify(v.decks) !== JSON.stringify(view.decks) || v.rev !== view.rev || JSON.stringify(v.userPages) !== JSON.stringify(view.userPages) || JSON.stringify(v.status.connections) !== JSON.stringify(view.status.connections);
        view = v;
        if (changed) paint();
        else if (logsOpen) loadLogs();
      }).catch(() => {});
    }, 10000);
  });
  if (window.CC.getTab && window.CC.getTab() === 'companion') run(load(true));
})();
