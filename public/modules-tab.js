// MODULES tab. One generated view for every system in the module catalog:
// connection, status, buttons, variables and feedbacks. It does not lay out a surface.
(() => {
  const CC = window.CC;
  if (!CC) return;
  const $ = (s) => document.querySelector(s);
  const pane = document.createElement('section');
  pane.id = 'pane-modsys';
  pane.hidden = true;
  const main = document.querySelector('main');
  if (main) main.before(pane);
  else document.body.appendChild(pane);
  const sub = $('#tabsSub');
  const pages = ['library', 'connection', 'status', 'buttons', 'variables', 'feedbacks'];
  const labels = { library: 'LIBRARY', connection: 'CONNECTION', status: 'STATUS', buttons: 'BUTTONS', variables: 'VARIABLES', feedbacks: 'FEEDBACKS' };
  for (const id of pages) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab mod-sub';
    b.dataset.modpage = id;
    b.textContent = labels[id];
    b.addEventListener('click', () => { page = id; render(); });
    sub.appendChild(b);
  }
  let data = { systems: [], instances: [] };
  let systemId = '';
  let instanceId = '';
  let page = 'library';
  let theme = localStorage.getItem('cc.buttonTheme') === 'light' ? 'light' : 'dark';
  let armed = null;

  function esc(s) { return CC.esc ? CC.esc(s) : String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function sys() { return data.systems.find((s) => s.id === systemId) || null; }
  function inst() { return data.instances.find((i) => i.id === instanceId) || null; }

  async function load() {
    data = await CC.api('GET', '/api/modules');
    if (systemId && !sys()) systemId = '';
    if (instanceId && !inst()) instanceId = '';
    paintGroups();
    if (CC.getTab() === 'modsys') render();
  }

  function paintGroups() {
    document.querySelectorAll('.mod-inst').forEach((el) => el.remove());
    const host = document.querySelector('.tab-modules');
    for (const row of data.instances) {
      const system = data.systems.find((s) => s.id === row.system);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tgrp mod-inst' + (row.id === instanceId ? ' active' : '');
      b.dataset.modinst = row.id;
      b.innerHTML = `<i class="led ${row.status === 'online' ? 'ok' : 'off'}"></i>${esc((system && system.short) || row.name)}`;
      b.title = `${row.name}: ${row.status}`;
      b.addEventListener('click', () => {
        instanceId = row.id;
        systemId = row.system;
        page = 'status';
        CC.setTab('modsys');
        paintGroups();
        render();
      });
      if (host) host.before(b);
    }
  }

  function openSystem(id) {
    systemId = id;
    const rows = data.instances.filter((i) => i.system === id);
    instanceId = rows[0] ? rows[0].id : '';
    page = rows.length || (sys() && sys().nativeId) || (sys() && sys().status === 'not yet') ? 'status' : 'connection';
    if (sys() && (sys().nativeId || sys().status === 'not yet')) page = 'buttons';
    render();
  }

  async function preview(button, flags) {
    const res = await CC.api('POST', '/api/modules/preview', { system: button.system, action: button.action, theme, flags: flags || {} });
    return res.svg;
  }

  async function press(button) {
    if (button.confirmMode === 'body') {
      const now = Date.now();
      if (!armed || armed.id !== button.action || now - armed.at > 4000) {
        armed = { id: button.action, at: now };
        CC.toast('Press again to confirm');
        return;
      }
      armed = null;
    }
    const req = button.request;
    if (!req || !req.path) { CC.toast('This button has no command', true); return; }
    let path = req.path;
    const body = { ...(req.body || {}) };
    if (button.confirmMode === 'body') body.confirm = true;
    if (path.includes('INSTANCE')) {
      if (!instanceId) { CC.toast('Add a connection first', true); return; }
      path = path.replace('INSTANCE', encodeURIComponent(instanceId));
    }
    const res = await CC.api(req.method || 'POST', path, req.method === 'GET' ? undefined : body);
    if (res && res.pending) CC.toast('Press again to confirm');
    else CC.toast(`${button.name} sent`);
    await load();
  }

  function connectionForm(system, row) {
    const conn = (row && row.connection) || {};
    return `<form class="mod-form" data-modform="1">${system.connection.fields.map((f) => {
      const val = conn[f.id] != null ? conn[f.id] : f.default;
      if (f.type === 'boolean') return `<label>${esc(f.label)}<select name="${esc(f.id)}"><option value="false" ${val ? '' : 'selected'}>No</option><option value="true" ${val ? 'selected' : ''}>Yes</option></select></label>`;
      const type = f.secret ? 'password' : f.type === 'number' ? 'number' : 'text';
      return `<label>${esc(f.label)}<input name="${esc(f.id)}" type="${type}" value="${esc(val == null ? '' : val)}" autocomplete="off"></label>`;
    }).join('')}<div class="mod-head"><button class="btn primary" type="submit">${row ? 'SAVE' : 'ADD'}</button></div></form>`;
  }

  async function render() {
    if (CC.getTab() !== 'modsys') return;
    document.querySelectorAll('.mod-sub').forEach((b) => b.classList.toggle('active', b.dataset.modpage === page));
    const system = sys();
    const row = inst();
    const cats = [...new Set(data.systems.map((s) => s.category))];
    let html = `<div class="mod-head"><div class="section-title">MODULES <small>Buttons, variables and feedbacks. Not a surface page.</small></div>
      <button type="button" class="btn mini mod-theme" id="modTheme">${theme === 'light' ? 'LIGHT BUTTONS' : 'DARK BUTTONS'}</button></div>`;
    if (page === 'library' || !system) {
      html += `<div class="mod-cats">${cats.map((c) => `<button type="button" class="btn mini" data-cat="${esc(c)}">${esc(c.toUpperCase())}</button>`).join('')}</div>
        <div class="mod-list">${data.systems.map((s) => `<button type="button" class="mod-card" data-open="${esc(s.id)}"><i class="bar" style="background:${esc(s.bar)}"></i><b>${esc(s.short)}</b><small>${esc(s.label)} · ${s.counts.buttons} buttons · ${s.counts.variables} variables · ${s.counts.feedbacks} feedbacks · ${esc(s.status)}</small></button>`).join('')}</div>`;
      pane.innerHTML = html;
      wire();
      return;
    }
    html += `<div class="mod-head"><b>${esc(system.label)}</b><small>${esc(system.summary)}</small></div>`;
    if (system.docs && system.docs.url) html += `<p class="note small">Protocol: <a href="${esc(system.docs.url)}">${esc(system.docs.title || system.docs.url)}</a> · ${esc(system.docs.basis || 'official')}. ${esc(system.docs.note || '')}</p>`;
    if (page === 'connection') {
      if (system.nativeId || system.status === 'not yet' || !system.connection.fields.length) {
        html += `<p class="note">This system ${system.nativeId ? 'uses the connection already on the SYSTEMS page.' : 'has no connection to open yet.'}</p>`;
      } else {
        html += connectionForm(system, row);
        if (row) html += `<div class="mod-head"><button type="button" class="btn" id="modConnect">CONNECT</button><button type="button" class="btn" id="modDisconnect">DISCONNECT</button><button type="button" class="btn danger" id="modRemove">REMOVE</button></div>`;
      }
    } else if (page === 'status') {
      if (!row) html += '<p class="note">No connection yet. Open CONNECTION to add one.</p>';
      else html += `<p><span class="led ${row.status === 'online' ? 'ok' : 'off'}"></span> ${esc(row.status)}${row.error ? ` · ${esc(row.error)}` : ''}</p><p class="note small">Last answer ${row.lastSeen ? new Date(row.lastSeen).toLocaleTimeString() : '—'}</p>`;
    } else if (page === 'buttons') {
      html += `<div class="mod-keys ${theme}" id="modKeys"></div>`;
    } else if (page === 'variables') {
      const vars = (row && row.vars) || {};
      html += `<table class="mod-table"><thead><tr><th>Variable</th><th>Value</th></tr></thead><tbody>${system.variables.map((v) => `<tr><td><code>$(${esc(system.id)}:${esc(v.id)})</code><div class="note small">${esc(v.label)}</div></td><td>${esc(vars[v.id] == null ? '' : vars[v.id])}</td></tr>`).join('')}</tbody></table>`;
    } else if (page === 'feedbacks') {
      const flags = (row && row.flags) || {};
      html += `<table class="mod-table"><thead><tr><th>Feedback</th><th>State</th></tr></thead><tbody>${system.feedbacks.map((f) => `<tr><td>${esc(f.label)}<div class="note small">${esc(f.variable)} ${esc(f.op)} ${esc(f.value)}</div></td><td class="${flags[f.id] ? 'mod-on' : 'mod-off'}">${flags[f.id] ? 'ON' : 'OFF'}</td></tr>`).join('')}</tbody></table>`;
    }
    pane.innerHTML = html;
    wire();
    if (page === 'buttons') paintButtons(system, row);
  }

  function wire() {
    const themeBtn = $('#modTheme');
    if (themeBtn) themeBtn.addEventListener('click', () => { theme = theme === 'light' ? 'dark' : 'light'; localStorage.setItem('cc.buttonTheme', theme); render(); });
    pane.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSystem(b.dataset.open)));
    pane.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      pane.querySelectorAll('.mod-card').forEach((card) => {
        const system = data.systems.find((s) => s.id === card.dataset.open);
        card.hidden = system && system.category !== b.dataset.cat;
      });
    }));
    const form = pane.querySelector('[data-modform]');
    if (form) form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const connection = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        connection[el.name] = el.type === 'number' ? Number(el.value) : el.value === 'true' ? true : el.value === 'false' ? false : el.value;
      }
      const job = instanceId && inst() && inst().system === systemId
        ? CC.api('POST', `/api/modules/instances/${encodeURIComponent(instanceId)}/connection`, { connection })
        : CC.api('POST', '/api/modules/instances', { system: systemId, connection });
      CC.run(job.then((row) => { instanceId = row.id; return load(); }).then(() => CC.toast('Connection saved')));
    });
    const connect = $('#modConnect');
    if (connect) connect.addEventListener('click', () => CC.run(CC.api('POST', `/api/modules/instances/${encodeURIComponent(instanceId)}/connect`).then(() => load()).then(() => CC.toast('Connected'))));
    const disconnect = $('#modDisconnect');
    if (disconnect) disconnect.addEventListener('click', () => CC.run(CC.api('POST', `/api/modules/instances/${encodeURIComponent(instanceId)}/disconnect`).then(() => load())));
    const remove = $('#modRemove');
    if (remove) remove.addEventListener('click', () => CC.run(CC.api('DELETE', `/api/modules/instances/${encodeURIComponent(instanceId)}`).then(() => { instanceId = ''; page = 'library'; return load(); })));
  }

  async function paintButtons(system, row) {
    const host = $('#modKeys');
    if (!host) return;
    const flags = (row && row.flags) || {};
    const buttons = system.buttons || [];
    host.innerHTML = buttons.map((b, i) => `<button type="button" class="mod-key" data-i="${i}"><span class="art"></span><span>${esc(b.name)}</span></button>`).join('');
    await Promise.all(buttons.map(async (b, i) => {
      const el = host.querySelector(`[data-i="${i}"] .art`);
      if (!el) return;
      try { el.innerHTML = await preview(b, flags); } catch { el.textContent = b.text || b.name; }
    }));
    host.querySelectorAll('.mod-key').forEach((el) => el.addEventListener('click', () => {
      const button = buttons[Number(el.dataset.i)];
      CC.run(press(button));
    }));
  }

  function sync() {
    const on = CC.getTab() === 'modsys';
    pane.hidden = !on;
    if (on) {
      if (!data.systems.length) load().catch((e) => CC.toast(e.message, true));
      else render();
    }
  }
  window.addEventListener('cc:tab', sync);
  if (CC.getTab() === 'modsys') pane.hidden = false;
  load().then(sync).catch(() => {});
})();
