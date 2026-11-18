'use strict';
// COMPANION, a top-level tab (0.31.0). Control Center defines buttons (BUTTONS)
// and pages (PAGES). Companion, and Steven's fork with its page designs and page
// templates, assigns them to Stream Decks. This tab shows whether Companion is
// answering on host:port, whether the Control Center module (pvllc-control-center, or the
// legacy rs6-presets id) is
// installed and current, lets you SYNC CC buttons and pages into it, download a
// page as a .companionconfig, and opens Companion's own web UI.
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
        ? conns.map((c) => `<div class="cmp-row"><i class="cmp-dot ${c.enabled ? 'ok' : 'warn'}"></i><b>${esc(c.label || c.id)}</b><small>${esc(c.moduleId || v.moduleId)}${c.legacy ? ' (old id)' : ''} · ${c.enabled ? 'enabled' : 'disabled'}${c.status && c.status.category ? ` · ${esc(c.status.category)}` : ''}${c.status && c.status.message ? ` · ${esc(c.status.message)}` : ''}</small></div>`).join('')
        : `<p class="note small">No Control Center module connection in Companion. Install the Control Center module, then add a "Performance Video Control Center" connection pointing at this app.</p>`);
      if (conns.some((c) => c.legacy)) rows.push(`<p class="note small">A connection still uses the old module id rs6-presets. It runs the old rs6-presets code, which does not see CC buttons and pages. PV Companion moves it to the built-in Performance Video Control Center module at start-up; in stock Companion import module 0.11.0 or newer from <a href="${esc(v.moduleRepo)}/releases" target="_blank" rel="noopener">the releases page</a>, then edit the connection and change its module to Performance Video Control Center.</p>`);
    }
    if (m) {
      rows.push(`<div class="cmp-row"><i class="cmp-dot ${m.current ? (m.stale ? 'warn' : 'ok') : 'off'}"></i><b>Module ${esc(m.version || '?')}</b><small>${m.label ? `${esc(m.label)} · ` : ''}last seen ${esc(new Date(m.at).toLocaleTimeString())}${m.presets != null ? ` · ${m.presets} presets` : ''}</small></div>`);
      if (!m.current) rows.push(`<p class="note small">This Control Center module is older than ${esc(v.moduleMinVersion)}. It cannot see CC buttons and pages. Update it from <a href="${esc(v.moduleRepo)}/releases" target="_blank" rel="noopener">the releases page</a>.</p>`);
      else if (m.stale) rows.push('<p class="note small">The module has not picked up the latest buttons and pages yet. It checks every few seconds; SYNC forces it.</p>');
    } else {
      rows.push(`<p class="note small">The Control Center module has not reported in. It needs version ${esc(v.moduleMinVersion)} or newer: <a href="${esc(v.moduleRepo)}/releases" target="_blank" rel="noopener">releases</a>.</p>`);
    }
    return rows.join('');
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
  function frameHtml(v) {
    const url = v.webUrl;
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
    return `<div class="cmp-card"><h3>CONNECTION</h3>
          <div class="cmp-row"><i class="cmp-dot ${st.cls}"></i><span>${esc(st.txt)}</span></div>
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
        </div>`;
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
    const typing = ae && ae.tagName === 'INPUT' && ae.closest && ae.closest('#cmpConfig');
    if (!typing) left.innerHTML = leftHtml(v);
    const key = JSON.stringify([v.webUrl, !!(v.status && v.status.online), showFrame]);
    if (key !== frameKey) { right.innerHTML = frameHtml(v); frameKey = key; }
    frameUrl = v.webUrl;
  }

  async function load(check) {
    view = await api('GET', '/api/companion');
    if (check || !view.status.checked) view = await api('POST', '/api/companion/check');
    paint();
  }

  root.addEventListener('submit', (ev) => {
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
    if (ev.target.id === 'cmpDecksAuto') {
      run(api('POST', '/api/companion/decks', { drive: 'auto' }).then((v) => { view = v; paint(); }));
    }
    if (ev.target.id === 'btnCmpSync') {
      run(api('POST', '/api/companion/sync').then(() => load(false)).then(() => toast('Sync sent. The module refreshes its presets.')));
    }
  });
  root.addEventListener('change', (ev) => {
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
        const changed = !view || v.status.online !== view.status.online || v.webUrl !== frameUrl || JSON.stringify(v.module) !== JSON.stringify(view.module) || JSON.stringify(v.decks) !== JSON.stringify(view.decks) || v.rev !== view.rev;
        view = v;
        if (changed) paint();
      }).catch(() => {});
    }, 10000);
  });
  if (window.CC.getTab && window.CC.getTab() === 'companion') run(load(true));
})();
