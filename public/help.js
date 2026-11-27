'use strict';
// In-app help UI (designer Phase C). Tour only starts from Help drawer or Settings → Replay tour.
// F1 or ? HELP button opens the 420px drawer.

(function () {
  const DRAWER_W = 420;

  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
  }

  async function api(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  let tips = {};
  let tours = [];
  let articles = [];

  async function loadHelp() {
    try {
      const idx = await api('/api/help/index');
      tips = idx.tips || {};
      tours = idx.tours || [];
      articles = idx.articles || [];
    } catch (e) { console.warn('help load failed', e); }
  }

  function ensureDrawer() {
    if ($('#helpDrawer')) return;
    const d = document.createElement('aside');
    d.id = 'helpDrawer';
    d.className = 'help-drawer';
    d.hidden = true;
    d.innerHTML = `
      <header class="help-head">
        <strong>? HELP</strong>
        <button type="button" class="btn mini ghost" id="helpClose" aria-label="Close">✕</button>
      </header>
      <nav class="help-nav">
        <button type="button" data-sec="tab">THIS TAB</button>
        <button type="button" data-sec="search">SEARCH</button>
        <button type="button" data-sec="manual">MANUAL</button>
        <button type="button" data-sec="new">WHAT'S NEW</button>
        <button type="button" data-sec="tour" class="tour-go">TOUR ▶</button>
      </nav>
      <div class="help-body" id="helpBody"></div>
    `;
    document.body.appendChild(d);
    $('#helpClose').onclick = closeHelp;
    $$('.help-nav button').forEach((b) => b.onclick = () => showSection(b.dataset.sec));
  }

  function openHelp() {
    ensureDrawer();
    const d = $('#helpDrawer');
    d.hidden = false;
    d.style.width = DRAWER_W + 'px';
    showSection('tab');
  }

  function closeHelp() {
    const d = $('#helpDrawer');
    if (d) d.hidden = true;
  }

  function showSection(sec) {
    const body = $('#helpBody');
    if (!body) return;
    if (sec === 'tour') { startTour(); return; }
    if (sec === 'search') {
      body.innerHTML = `<input id="helpSearch" type="search" placeholder="Search help…" autofocus><div id="helpHits"></div>`;
      $('#helpSearch').oninput = async (e) => {
        const q = e.target.value.trim();
        if (!q) { $('#helpHits').innerHTML = ''; return; }
        try {
          const { hits } = await api('/api/help/search?q=' + encodeURIComponent(q));
          $('#helpHits').innerHTML = hits.map((h) => `<div class="hit" data-id="${esc(h.id)}">${esc(h.title)} <small>${esc(h.tab)}</small></div>`).join('') || '<em>No hits</em>';
          $$('.hit').forEach((el) => el.onclick = () => openArticle(el.dataset.id));
        } catch { $('#helpHits').textContent = 'Search failed'; }
      };
      return;
    }
    if (sec === 'manual') {
      body.innerHTML = `<p><a href="/help" target="_blank">Open the full manual</a></p><ul>${articles.map((a) => `<li><a href="#" data-id="${esc(a.id)}">${esc(a.title)}</a></li>`).join('')}</ul>`;
      $$('a[data-id]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openArticle(a.dataset.id); });
      return;
    }
    if (sec === 'new') {
      body.innerHTML = '<p>What\'s new is in the release notes. The tour never starts by itself.</p>';
      return;
    }
    // THIS TAB
    const tab = document.querySelector('.tab.on, .tab.active, [aria-selected="true"]') || document.querySelector('.tab');
    const name = tab ? tab.textContent.trim() : 'this tab';
    body.innerHTML = `<h3>${esc(name)}</h3><p>Tips for the current view. Press TOUR ▶ for the guided tour (it only starts from here).</p>`;
  }

  async function openArticle(id) {
    try {
      const a = await api('/api/help/' + encodeURIComponent(id));
      $('#helpBody').innerHTML = `<h2>${esc(a.title)}</h2>${a.html || ''}`;
    } catch { $('#helpBody').textContent = 'Article not found'; }
  }

  // Tips: ? on [data-help]
  function attachTips() {
    $$('[data-help]').forEach((el) => {
      if (el.querySelector('.help-tip')) return;
      const key = el.dataset.help;
      const tip = tips[key] || tips['core.' + key] || tips['tour.start'];
      if (!tip) return;
      const q = document.createElement('button');
      q.type = 'button';
      q.className = 'help-tip';
      q.textContent = '?';
      q.title = tip;
      q.onclick = (e) => { e.stopPropagation(); openArticle(key.replace(/\./g, '-')); };
      el.style.position = el.style.position || 'relative';
      el.appendChild(q);
    });
  }

  // Tour
  let tourStep = -1;
  let tourData = null;

  async function startTour() {
    closeHelp();
    try {
      const list = await api('/api/help/tours');
      if (list.autoStart !== false) console.warn('tour autoStart should be false');
      tourData = await api('/api/help/tours/getting-started');
      if (!tourData || !tourData.steps) return;
      tourStep = 0;
      showStep();
    } catch (e) { console.warn('tour start failed', e); }
  }

  function showStep() {
    removeTour();
    if (!tourData || tourStep < 0 || tourStep >= tourData.steps.length) return;
    const step = tourData.steps[tourStep];
    const target = document.querySelector(step.select) || document.body;
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const r = target.getBoundingClientRect();
    Object.assign(spot.style, {
      position: 'fixed', left: (r.left - 8) + 'px', top: (r.top - 8) + 'px',
      width: (r.width + 16) + 'px', height: (r.height + 16) + 'px',
      boxShadow: '0 0 0 9999px rgba(0,0,0,.55)', border: '2px solid #4da3ff', borderRadius: '8px',
      pointerEvents: 'none', zIndex: 9998,
    });
    document.body.appendChild(spot);
    const card = document.createElement('div');
    card.className = 'tour-card';
    card.innerHTML = `<strong>${esc(step.title)}</strong><p>Step ${tourStep + 1} of ${tourData.steps.length}</p>
      <button type="button" id="tourNext">${tourStep + 1 === tourData.steps.length ? 'Done' : 'Next'}</button>
      <button type="button" id="tourSkip">Skip</button>`;
    Object.assign(card.style, {
      position: 'fixed', zIndex: 9999, background: 'var(--panel)', border: '1px solid var(--line)',
      padding: '12px', borderRadius: '8px', maxWidth: '280px',
      left: Math.min(r.right + 12, window.innerWidth - 300) + 'px',
      top: Math.max(12, r.top) + 'px',
    });
    document.body.appendChild(card);
    $('#tourNext').onclick = () => { tourStep++; if (tourStep >= tourData.steps.length) removeTour(); else showStep(); };
    $('#tourSkip').onclick = removeTour;
  }

  function removeTour() {
    $$('.tour-spot, .tour-card').forEach((el) => el.remove());
  }

  // F1 and button
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') { e.preventDefault(); openHelp(); }
  });

  function wire() {
    const btn = $('#btnHelp');
    if (btn) btn.onclick = openHelp;
    // Settings → Replay tour: look for a settings panel later; for now expose window.CCHelp
    window.CCHelp = { open: openHelp, startTour, replay: startTour };
    loadHelp().then(attachTips);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
