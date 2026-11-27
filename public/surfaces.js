'use strict';
// SURFACES tab (designer Phase B). Merges BUTTONS / PAGES / Control Devices.
// Sub-tabs: PAGES (Page Builder) · BUTTONS · DEVICES · TOURBOX · SELF-TEST.
// Page edits go live immediately via planApply / placeCcPages. No SYNC step.
// The UI never shows Companion page numbers.
(() => {
  const root = document.querySelector('#pane-surfaces');
  if (!root || !window.CC) return;
  const { api, toast, run, esc } = window.CC;

  const subNav = document.querySelector('#surfacesSub');
  const panes = {
    pages: document.querySelector('#surfacesPages'),
    buttons: document.querySelector('#surfacesButtons'),
    devices: document.querySelector('#surfacesDevices'),
    tourbox: document.querySelector('#surfacesTourbox'),
    selftest: document.querySelector('#surfacesSelftest'),
  };

  let currentSub = 'pages';
  let pages = [];
  let selectedPageId = '';
  let history = [];
  let historyIndex = -1;
  let lastApply = null;
  let midGesture = false;

  function showSub(which) {
    currentSub = which;
    for (const [k, el] of Object.entries(panes)) {
      if (el) el.hidden = k !== which;
    }
    subNav.querySelectorAll('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.surfaces === which));
    if (which === 'buttons' && !panes.buttons.dataset.moved) moveOld('buttons');
    if (which === 'devices' && !panes.devices.dataset.moved) moveOld('devices');
    if (which === 'pages') renderBuilder();
  }

  function moveOld(kind) {
    if (kind === 'buttons') {
      const old = document.querySelector('#pane-buttons');
      if (old && panes.buttons) {
        panes.buttons.innerHTML = '';
        panes.buttons.append(...old.childNodes);
        panes.buttons.dataset.moved = '1';
        old.hidden = true;
      }
    }
    if (kind === 'devices') {
      const old = document.querySelector('#pane-decks');
      if (old && panes.devices) {
        panes.devices.innerHTML = '';
        panes.devices.append(...old.childNodes);
        panes.devices.dataset.moved = '1';
        old.hidden = true;
      }
    }
  }

  function zoneFor(col, row, cols = 9) {
    // Simple zone overlay matching the brief: NAV / TARGET / FUNCTIONS / STATUS
    if (row === 0) return 'NAV';
    if (row === 3) return 'STATUS';
    if (col < 3) return 'TARGET';
    return 'FUNCTIONS';
  }

  function renderBuilder() {
    const page = pages.find((p) => p.id === selectedPageId) || pages[0] || null;
    selectedPageId = page ? page.id : '';
    const cols = 9;
    const rows = 4;
    const keys = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const zone = zoneFor(c, r, cols);
        const label = page && page.keys && page.keys[r * cols + c] ? page.keys[r * cols + c] : '';
        keys.push(`<div class="sd-key zone-${zone.toLowerCase()}" data-col="${c}" data-row="${r}" title="${zone}">${esc(label || '')}<span class="zone-tag">${zone}</span></div>`);
      }
    }
    const strips = Array.from({ length: 6 }, (_, i) => `<div class="sd-strip" data-strip="${i}" title="Strip ${i + 1}">STRIP ${i + 1}</div>`).join('');
    const knobs = Array.from({ length: 6 }, (_, i) => `<div class="sd-knob" data-knob="${i}" title="Knob ${i + 1}"></div>`).join('');

    panes.pages.innerHTML = `
      <div class="builder-toolbar">
        <label>Page <input id="builderPageName" value="${esc(page ? (page.name || page.title || page.id) : '')}" placeholder="Page name"></label>
        <label>Device <select id="builderDevice"><option value="streamdeck-xl">Stream Deck + XL</option><option value="streamdeck-plus">Stream Deck +</option></select></label>
        <button type="button" class="btn mini" id="builderUndo" ${historyIndex <= 0 ? 'disabled' : ''}>Undo</button>
        <button type="button" class="btn mini" id="builderVersions">VERSIONS</button>
        <span class="live-pill" id="liveOnDeck">LIVE ON DECK</span>
      </div>
      <div class="builder-main">
        <aside class="page-tree">
          <div class="section-title">Page set</div>
          <ul id="pageTree">${pages.map((p) => `<li data-page="${esc(p.id)}" class="${p.id === selectedPageId ? 'active' : ''}">${esc(p.name || p.id)}</li>`).join('')}</ul>
          <button type="button" class="btn mini" id="builderNewPage">New page</button>
        </aside>
        <div class="builder-canvas">
          <div class="sd-face" aria-label="Stream Deck + XL to scale (9 × 4 keys)">
            <div class="sd-keys">${keys.join('')}</div>
            <div class="sd-strips">${strips}</div>
            <div class="sd-knobs">${knobs}</div>
          </div>
          <div class="what-changed" id="whatChanged">
            <div class="section-title">WHAT CHANGED</div>
            <pre>${lastApply ? esc(JSON.stringify(lastApply, null, 2)) : 'No apply yet. Edits go live immediately.'}</pre>
          </div>
        </div>
      </div>
    `;
    wireBuilder();
  }

  function pushHistory(state) {
    history = history.slice(0, historyIndex + 1);
    history.push(JSON.parse(JSON.stringify(state)));
    historyIndex = history.length - 1;
  }

  async function applyLive(reason) {
    const page = pages.find((p) => p.id === selectedPageId);
    if (!page) return;
    const body = {
      usb: { slot: 'r1c1', from: reason || 'edit', to: page.name || page.id },
      companionPages: [{ id: page.id, title: page.name || page.id, keys: page.keys || [] }],
      existingCompanionPages: [],
      midGesture,
      onProgram: false,
    };
    try {
      const plan = await api('POST', '/api/surfaces/apply', body);
      lastApply = plan;
      toast(plan.deferPageChange ? 'Values updated; page change deferred' : 'Live on deck');
      renderBuilder();
    } catch (e) {
      toast(e.message || 'Apply failed');
    }
  }

  function wireBuilder() {
    const name = document.querySelector('#builderPageName');
    if (name) name.addEventListener('change', () => {
      const p = pages.find((x) => x.id === selectedPageId);
      if (p) { p.name = name.value; pushHistory(pages); applyLive('rename'); }
    });
    document.querySelector('#builderUndo')?.addEventListener('click', () => {
      if (historyIndex > 0) {
        historyIndex--;
        pages = JSON.parse(JSON.stringify(history[historyIndex]));
        applyLive('undo');
      }
    });
    document.querySelector('#builderNewPage')?.addEventListener('click', async () => {
      const id = `page.${Date.now().toString(36)}`;
      pages.push({ id, name: 'New page', keys: [] });
      selectedPageId = id;
      pushHistory(pages);
      await applyLive('new page');
    });
    document.querySelector('#pageTree')?.addEventListener('click', (ev) => {
      const li = ev.target.closest('[data-page]');
      if (li) { selectedPageId = li.dataset.page; renderBuilder(); }
    });
    document.querySelectorAll('.sd-key').forEach((key) => {
      key.addEventListener('dragover', (ev) => { ev.preventDefault(); key.classList.add('over'); });
      key.addEventListener('dragleave', () => key.classList.remove('over'));
      key.addEventListener('drop', (ev) => {
        ev.preventDefault();
        key.classList.remove('over');
        const zone = zoneFor(Number(key.dataset.col), Number(key.dataset.row));
        const buttonId = ev.dataTransfer.getData('text/plain') || 'dropped';
        if (zone === 'NAV' && !buttonId.startsWith('nav.')) {
          toast(`Refused: ${buttonId} is not a NAV button`);
          return;
        }
        const p = pages.find((x) => x.id === selectedPageId);
        if (p) {
          if (!p.keys) p.keys = [];
          const idx = Number(key.dataset.row) * 9 + Number(key.dataset.col);
          p.keys[idx] = buttonId;
          pushHistory(pages);
          applyLive(`drop ${buttonId}`);
        }
      });
    });
    // Fake draggable library items for the demo
    document.querySelectorAll('.sd-key').forEach((k) => k.draggable = true);
  }

  async function loadPages() {
    try {
      const view = await api('GET', '/api/surface-pages');
      pages = (view && view.pages) || [];
      if (!pages.length) pages = [{ id: 'core.home', name: 'HOME', keys: [] }];
      selectedPageId = pages[0].id;
      pushHistory(pages);
    } catch {
      pages = [{ id: 'core.home', name: 'HOME', keys: [] }];
      selectedPageId = 'core.home';
    }
    if (currentSub === 'pages') renderBuilder();
  }

  subNav?.addEventListener('click', (ev) => {
    const b = ev.target.closest('.subtab');
    if (b) showSub(b.dataset.surfaces);
  });

  window.addEventListener('cc:tab', (ev) => {
    if (ev.detail === 'surfaces') {
      showSub(currentSub);
      loadPages();
    }
  });

  // Initial
  showSub('pages');
  loadPages().catch(() => {});
})();
