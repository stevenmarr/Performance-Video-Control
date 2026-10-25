/* DECKS: pick a surface, see that page, put it on a Stream Deck the plugin reports.
   Deploy is POST /api/decks/deploy, which calls the Path C plugin. Companion is not this path. */
(() => {
  const root = document.querySelector('#deckRoot');
  if (!root || !window.CC) return;
  const { api, toast, run, esc } = window.CC;
  const note = document.querySelector('#deckPluginNote');
  const ORDER = ['xl', 'plusxl', 'plus', 'mk2', 'neo', 'mini'];
  let view = null;
  let selected = localStorage.getItem('cc.deck') || '';
  let surfaceId = localStorage.getItem('cc.deckSurface') || 'plusxl';
  let pageId = localStorage.getItem('cc.deckPage') || 'ptz-paint';
  let timer = null;
  let sig = '';

  const device = () => (view && view.devices || []).find((d) => d.id === selected) || null;
  const surfaceOf = (id) => (view && view.surfaces && view.surfaces[id]) || { cols: 8, rows: 4, label: 'Stream Deck', knobCols: [] };
  const library = () => ((view && view.library && view.library[surfaceId]) || []);

  function face(page, surface, big) {
    const cols = surface.cols || 8;
    const rows = surface.rows || 4;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = (page.keys || []).find((key) => key.row === r && key.col === c);
        cells.push(`<i class="deck-key${big ? ' big' : ''}${k && k.jump ? ' jump' : ''}" style="grid-column:${c + 1};grid-row:${r + 1}">${esc((k && k.label) || '')}${k && k.value && big ? `<b>${esc(k.value)}</b>` : ''}</i>`);
      }
    }
    const knobs = (surface.knobCols || []).length && big
      ? `<div class="deck-knobs" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${
        Array.from({ length: cols }, (_, c) => (surface.knobCols.includes(c) ? '<i class="deck-knob"></i>' : '<i></i>')).join('')
      }</div>`
      : '';
    return `${knobs}<div class="deck-mini${big ? ' deck-face' : ''}" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:repeat(${rows},${big ? '48px' : '18px'})">${cells.join('')}</div>`;
  }

  function pageById(id) {
    return library().find((p) => p.id === id) || null;
  }

  function render() {
    if (!view) { root.innerHTML = '<p class="note">Reading the plugin…</p>'; return; }
    const surfaces = view.surfaces || {};
    if (!surfaces[surfaceId]) surfaceId = ORDER.find((id) => surfaces[id]) || 'xl';
    const surface = surfaceOf(surfaceId);
    const lib = library();
    if (!lib.some((p) => p.id === pageId)) pageId = (lib.find((p) => p.id === 'ptz-paint') || lib[0] || {}).id || '';
    const shown = pageById(pageId);
    const plug = view.plugin || {};
    if (note) {
      note.textContent = plug.online
        ? `Plugin is running. ${view.devices.length} Stream Deck${view.devices.length === 1 ? '' : 's'}.`
        : `Plugin is not running${plug.error ? `: ${plug.error}` : ''}. The pages are still here.`;
    }
    const devs = view.devices || [];
    if (selected && !devs.some((d) => d.id === selected)) selected = '';
    const cur = device();
    const match = Boolean(cur && cur.surfaceId === surfaceId);
    const onStack = new Set((cur && cur.pages || []).map((p) => p.id));
    const options = ORDER.filter((id) => surfaces[id]).map((id) => `<option value="${esc(id)}"${id === surfaceId ? ' selected' : ''}>${esc(surfaces[id].label || id)}</option>`).join('');
    const pages = lib.map((p) => `<button type="button" class="deck-page${p.id === pageId ? ' on' : ''}" data-page="${esc(p.id)}">
      <b>${esc(p.title)}</b><small>${esc(p.system || '')}</small>
      <span class="deck-add" data-add="${esc(p.id)}" ${!match || !cur.online || onStack.has(p.id) ? 'hidden' : ''}>Add</span>
      ${onStack.has(p.id) && match ? '<small>On deck</small>' : ''}
    </button>`).join('');
    const devHtml = devs.map((d) => `<button type="button" class="deck-dev${d.id === selected ? ' on' : ''}${d.surfaceId === surfaceId ? '' : ' other'}" data-select="${esc(d.id)}">
      <b>${esc(d.name)}</b>
      <small>${esc(d.model)} · <span class="${d.online ? 'onl' : 'offl'}">${d.online ? 'ONLINE' : 'OFFLINE'}</span></small>
      <small>${(d.pages || []).length ? esc(d.pages.map((p) => p.title).join(' · ')) : 'No pages loaded'}${d.surfaceId === surfaceId ? '' : ' · different surface'}</small>
    </button>`).join('');
    const stack = !cur ? '' : (cur.pages || []).map((p, i) => `<li class="deck-row" draggable="true" data-i="${i}">
      <header><b>${esc(p.title || p.id)}</b><small>${p.missing ? 'Not on the desk' : esc(p.system || '')}</small></header>
      <span class="deck-acts">
        <button type="button" class="btn mini" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn mini" data-down="${i}" ${i === cur.pages.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn mini" data-remove="${esc(p.id)}">REMOVE</button>
      </span>
    </li>`).join('');
    const warns = (cur && cur.warnings || []).map((w) => `<li>${esc(w.message)}</li>`).join('');
    root.innerHTML = `
      <div class="deck-top">
        <label>Surface <select id="deckSurface" aria-label="Surface">${options}</select></label>
        <button type="button" class="btn" id="deckScan">Scan USB</button>
        <button type="button" class="btn primary" id="btnDeckPush" ${!cur || !cur.online || !(cur.pages || []).length ? 'disabled' : ''}>Push${cur ? ` to ${esc(cur.name)}` : ''}</button>
      </div>
      <div class="deck-layout">
        <section class="deck-lib">
          <div class="section-title">PAGES <small>${esc(surface.label)} · systems on the desk</small></div>
          <div class="deck-pages">${pages || '<p class="note small">Put a system on the desk to get pages for it.</p>'}</div>
        </section>
        <section class="deck-stage">
          <div class="section-title">${shown ? esc(shown.title) : 'PAGE'}</div>
          ${shown ? face(shown, surface, true) : '<p class="note small">No page for this surface.</p>'}
          ${cur && !match ? `<p class="note small">${esc(cur.name)} is a different surface. Change the dropdown to add pages to it.</p>` : ''}
          ${cur ? `<ol id="deckStack">${stack || '<li class="note small">Nothing on this deck yet. Add a page from the left.</li>'}</ol>` : '<p class="note small">No deck selected. The page above is what a push sends.</p>'}
          ${warns ? `<ul class="deck-warns">${warns}</ul>` : ''}
        </section>
        <aside class="deck-list">
          <div class="section-title">STREAM DECKS</div>
          ${devs.length ? devHtml : '<p class="note small">No Stream Deck is connected. Scan USB after the plugin is running. This page does not invent a deck.</p>'}
        </aside>
      </div>`;
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

  root.addEventListener('change', (ev) => {
    const sel = ev.target.closest('#deckSurface');
    if (!sel) return;
    surfaceId = sel.value;
    localStorage.setItem('cc.deckSurface', surfaceId);
    render();
  });

  root.addEventListener('click', (ev) => {
    const pageBtn = ev.target.closest('[data-page]');
    if (pageBtn && !ev.target.closest('[data-add]')) {
      pageId = pageBtn.dataset.page;
      localStorage.setItem('cc.deckPage', pageId);
      render();
      return;
    }
    const b = ev.target.closest('button');
    if (!b || !view) return;
    if (b.id === 'deckScan') {
      return run(api('POST', '/api/decks/refresh').then((next) => {
        view = next;
        sig = '';
        render();
        toast(next.plugin && next.plugin.online ? `${(next.devices || []).length} Stream Deck${(next.devices || []).length === 1 ? '' : 's'}` : `Plugin is not running${next.plugin && next.plugin.error ? `: ${next.plugin.error}` : ''}`);
      }));
    }
    if (b.dataset.select) {
      selected = b.dataset.select;
      localStorage.setItem('cc.deck', selected);
      render();
      return;
    }
    if (!selected) return;
    if (b.dataset.add || ev.target.closest('[data-add]')) {
      const id = (b.dataset.add) || ev.target.closest('[data-add]').dataset.add;
      pageId = id;
      localStorage.setItem('cc.deckPage', pageId);
      return run(save(ids().concat(id)));
    }
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
