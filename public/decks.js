/* DECKS: connected Stream Decks, the page library for systems on the desk, and Push.
   Deploy is POST /api/decks/deploy, which calls the Path C plugin. Companion is not this path. */
(() => {
  const root = document.querySelector('#deckRoot');
  if (!root || !window.CC) return;
  const { api, toast, run, esc } = window.CC;
  const note = document.querySelector('#deckPluginNote');
  let view = null;
  let selected = localStorage.getItem('cc.deck') || '';
  let timer = null;
  let sig = '';

  const device = () => (view && view.devices || []).find((d) => d.id === selected) || null;
  const surfaceOf = (id) => (view && view.surfaces && view.surfaces[id]) || { cols: 8, rows: 4, label: 'Stream Deck' };

  function mini(page, surface) {
    const cols = surface.cols || 5;
    const rows = surface.rows || 3;
    const cells = (page.keys || []).map((k) => `<i class="deck-key${k.jump ? ' jump' : ''}" style="grid-column:${k.col + 1};grid-row:${k.row + 1}">${esc(k.label || '')}</i>`).join('');
    return `<div class="deck-mini" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:repeat(${rows},18px)">${cells}</div>`;
  }

  function pageById(surfaceId, id) {
    const list = (view && view.library && view.library[surfaceId]) || [];
    return list.find((p) => p.id === id) || null;
  }

  function render() {
    if (!view) { root.innerHTML = '<p class="note">Reading the Path C plugin…</p>'; return; }
    const plug = view.plugin || {};
    if (note) {
      note.textContent = plug.online
        ? `Path C plugin ${plug.url} · ${view.devices.length} Stream Deck${view.devices.length === 1 ? '' : 's'}`
        : `Path C plugin is not running at ${plug.url}. ${plug.error || ''} Start com.performancevideo.control. This page does not invent a deck.`;
    }
    const devs = view.devices || [];
    if (!devs.length) selected = '';
    else if (!devs.some((d) => d.id === selected)) selected = devs[0].id;
    const cur = device();
    const surfaceId = cur ? cur.surfaceId : 'xl';
    const surface = surfaceOf(surfaceId);
    const lib = (view.library && view.library[surfaceId]) || [];
    const onStack = new Set((cur && cur.pages || []).map((p) => p.id));
    const devHtml = devs.map((d) => `<button type="button" class="deck-dev${d.id === selected ? ' on' : ''}" data-select="${esc(d.id)}">
      <b>${esc(d.name)}</b>
      <small>${esc(d.model)} · <span class="${d.online ? 'onl' : 'offl'}">${d.online ? 'ONLINE' : 'OFFLINE'}</span></small>
      <small>${(d.pages || []).length ? esc(d.pages.map((p) => p.title).join(' · ')) : 'No pages loaded'}</small>
    </button>`).join('');
    const stackHtml = !cur ? '' : (cur.pages || []).map((p, i) => {
      const full = pageById(cur.surfaceId, p.id);
      return `<li class="deck-row" draggable="true" data-i="${i}">
        ${full ? mini(full, surface) : '<div class="deck-mini"></div>'}
        <header><b>${esc(p.title || p.id)}</b><small>${p.missing ? 'Not in the library' : esc(p.system || '')}</small></header>
        <span class="deck-acts">
          <button type="button" class="btn mini" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn mini" data-down="${i}" ${i === cur.pages.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn mini" data-remove="${esc(p.id)}">REMOVE</button>
        </span>
      </li>`;
    }).join('');
    const warns = (cur && cur.warnings || []).map((w) => `<li>${esc(w.message)}</li>`).join('');
    const cards = lib.map((p) => `<article class="deck-card">
      <header><span>${esc(p.title)}</span><button type="button" class="btn mini" data-add="${esc(p.id)}" ${!cur || !cur.online || onStack.has(p.id) ? 'disabled' : ''}>${onStack.has(p.id) ? 'ON STACK' : 'ADD'}</button></header>
      ${mini(p, surface)}
    </article>`).join('');
    const typing = document.activeElement && document.activeElement.id === 'deckPluginUrl';
    const urlVal = typing ? document.activeElement.value : (plug.url || '');
    root.innerHTML = `
      <aside class="deck-list">
        <div class="section-title">STREAM DECKS</div>
        ${devs.length ? devHtml : '<p class="note small">No Stream Deck is connected. The list is whatever the Path C plugin reports.</p>'}
        <form class="deck-url" id="deckUrlForm"><input id="deckPluginUrl" value="${esc(urlVal)}" spellcheck="false" aria-label="Path C plugin URL"><button class="btn mini" type="submit">USE</button></form>
      </aside>
      <section class="deck-stack">
        <div class="section-title">${cur ? esc(cur.name) : 'PAGE STACK'}</div>
        ${cur ? `<ol id="deckStack">${stackHtml || '<li class="note small">No pages on this deck yet. Add one from the library.</li>'}</ol>
          ${warns ? `<ul class="deck-warns">${warns}</ul>` : ''}
          <button type="button" class="btn primary" id="btnDeckPush" ${!cur.online || !(cur.pages || []).length ? 'disabled' : ''}>PUSH TO ${esc(cur.name)}</button>` : '<p class="note small">Select a connected Stream Deck. The library on the right is sized to that surface. With no deck connected it stays at XL.</p>'}
      </section>
      <section class="deck-lib">
        <div class="section-title">PAGE LIBRARY <small>${esc(surface.label)} · systems on the desk</small></div>
        <div class="deck-lib-grid">${cards || '<p class="note small">Put a system on the desk to get pages for it.</p>'}</div>
      </section>`;
    if (typing) { const el = document.querySelector('#deckPluginUrl'); if (el) el.focus(); }
  }

  async function load() {
    const next = await api('GET', '/api/decks');
    const snap = JSON.stringify({ p: next.plugin, d: next.devices, a: next.desk });
    view = next;
    if (snap === sig && root.childElementCount) return;
    sig = snap;
    render();
  }

  function ids() {
    const d = device();
    return (d && d.pages || []).map((p) => p.id);
  }

  async function save(pages) {
    await api('POST', '/api/decks/stack', { deviceId: selected, pages });
    sig = '';
    await load();
  }

  function arm(on) {
    clearInterval(timer); timer = null;
    if (!on) return;
    run(load());
    timer = setInterval(() => run(load()), 2000);
  }

  window.addEventListener('cc:tab', (ev) => arm(ev.detail === 'decks'));
  if (document.body.classList.contains('tab-decks')) arm(true);

  document.querySelector('#btnDeckAll').addEventListener('click', () => run(api('POST', '/api/decks/deploy-all').then((r) => {
    const n = (r.deployed || []).length;
    toast(n ? `Pushed ${n} Stream Deck${n === 1 ? '' : 's'}` : 'Nothing to push');
    sig = '';
    return load();
  })));

  root.addEventListener('submit', (ev) => {
    const form = ev.target.closest('#deckUrlForm');
    if (!form) return;
    ev.preventDefault();
    const url = form.querySelector('input').value.trim();
    run(api('POST', '/api/decks/plugin', { url }).then(() => api('POST', '/api/decks/refresh')).then((next) => { view = next; sig = ''; render(); toast('Plugin address saved'); }));
  });

  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || !view) return;
    if (b.dataset.select) {
      selected = b.dataset.select;
      localStorage.setItem('cc.deck', selected);
      sig = '';
      render();
      return;
    }
    if (!selected) return;
    if (b.dataset.add) return run(save(ids().concat(b.dataset.add)));
    if (b.dataset.remove) return run(save(ids().filter((id) => id !== b.dataset.remove)));
    if (b.dataset.up != null && b.dataset.up !== '') {
      const i = Number(b.dataset.up);
      const pages = ids();
      if (i <= 0) return;
      [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
      return run(save(pages));
    }
    if (b.dataset.down != null && b.dataset.down !== '') {
      const i = Number(b.dataset.down);
      const pages = ids();
      if (i >= pages.length - 1) return;
      [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
      return run(save(pages));
    }
    if (b.id === 'btnDeckPush') {
      return run(api('POST', '/api/decks/deploy', { deviceId: selected }).then((r) => {
        const w = (r.warnings || []).map((x) => x.message).join(' ');
        toast(w ? `Pushed. ${w}` : 'Pushed to the Stream Deck');
        sig = '';
        return load();
      }));
    }
  });

  let dragFrom = null;
  root.addEventListener('dragstart', (ev) => {
    const row = ev.target.closest('[data-i]');
    if (!row) return;
    dragFrom = Number(row.dataset.i);
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(dragFrom));
  });
  root.addEventListener('dragover', (ev) => { if (ev.target.closest('[data-i]')) ev.preventDefault(); });
  root.addEventListener('drop', (ev) => {
    const row = ev.target.closest('[data-i]');
    if (!row || dragFrom == null) return;
    ev.preventDefault();
    const to = Number(row.dataset.i);
    const pages = ids();
    const [item] = pages.splice(dragFrom, 1);
    pages.splice(to, 0, item);
    dragFrom = null;
    run(save(pages));
  });
})();
