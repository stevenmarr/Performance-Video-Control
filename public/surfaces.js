'use strict';
// SURFACES tab (designer Phase B). One top tab with sub-tabs PAGES · BUTTONS · DEVICES · TOURBOX · SELF-TEST.
// The working editors already exist as their own scripts: public/surface-pages.js (PAGES, #pagesRoot),
// public/button-library.js (BUTTONS, #buttonRoot), public/decks.js (DEVICES, #deckRoot) and public/tourbox.js
// (the TourBox card). This file only moves each editor's pane into its sub-tab and tells it when it is shown.
// v0.39.1: 0.39.0 shipped a stub Page Builder here (fake keys; its apply route is a no-op) and never told
// the real editors they were visible, because they only listen for the old top-level tabs 'buttons' / 'pages'.
(() => {
  const root = document.querySelector('#pane-surfaces');
  if (!root || !window.CC) return;

  const subNav = document.querySelector('#surfacesSub');
  const panes = {
    pages: document.querySelector('#surfacesPages'),
    buttons: document.querySelector('#surfacesButtons'),
    devices: document.querySelector('#surfacesDevices'),
    tourbox: document.querySelector('#surfacesTourbox'),
    selftest: document.querySelector('#surfacesSelftest'),
  };
  // sub-tab -> the old pane whose contents (and listeners) move into it
  const OLD = { pages: '#pane-pages', buttons: '#pane-buttons', devices: '#pane-decks' };

  let currentSub = 'pages';

  function adopt(kind) {
    const target = panes[kind];
    if (!target || target.dataset.moved) return;
    if (kind === 'tourbox') {
      // The TourBox card (tourbox.js) is built into CAMERA CONTROL; the SURFACES sub-tab hosts the same card.
      const card = document.querySelector('#tbxPanel');
      if (!card) return;
      target.innerHTML = '';
      target.append(card);
    } else {
      const old = document.querySelector(OLD[kind] || '#none');
      if (!old) return;
      target.innerHTML = '';
      target.append(...old.childNodes);
      old.hidden = true;
    }
    target.dataset.moved = '1';
  }

  function showSub(which) {
    if (!panes[which]) which = 'pages';
    currentSub = which;
    for (const [k, el] of Object.entries(panes)) if (el) el.hidden = k !== which;
    subNav.querySelectorAll('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.surfaces === which));
    adopt(which);
    // the editors load their data when this fires (the old top-level 'cc:tab' names no longer exist)
    window.dispatchEvent(new CustomEvent('cc:surfaces', { detail: which }));
  }

  // SELF-TEST: reads GET /api/companion/selftest. Nothing is pressed: it counts every deck-page key and knob
  // Companion can place, and lists the first ones that have no function or no handler.
  const { api, esc } = window.CC;
  function paintSelftest(r) {
    const t = r.totals || {};
    const lines = (r.problems || []).slice(0, 40).map((p) => `<li><b>${esc(p.kind)}</b> ${esc(p.where)}${p.detail ? ` — ${esc(p.detail)}` : ''}</li>`).join('');
    const warn = (r.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
    panes.selftest.querySelector('#selftestOut').innerHTML = `
      <p class="note">${esc(String(t.keys || 0))} keys: ${esc(String(t.working || 0))} work, ${esc(String(t.navigation || 0))} navigate, ${esc(String(t.labelOnly || 0))} label only, ${esc(String(t.noHandler || 0))} with no handler, ${esc(String(t.blank || 0))} blank. ${esc(String(t.knobs || 0))} knobs, ${esc(String(t.knobsUnbound || 0))} not wired.</p>
      ${warn ? `<p class="note">Blocking buttons now:</p><ul>${warn}</ul>` : ''}
      ${lines ? `<p class="note">First problems:</p><ul class="note small">${lines}</ul>` : '<p class="note">No problems found.</p>'}`;
  }
  async function runSelftest() {
    const out = panes.selftest.querySelector('#selftestOut');
    out.textContent = 'Checking…';
    try { paintSelftest(await api('GET', '/api/companion/selftest')); } catch (e) { out.textContent = e.message || 'Self-test failed'; }
  }
  panes.selftest.addEventListener('click', (ev) => { if (ev.target.closest('#selftestRun')) runSelftest(); });

  subNav.addEventListener('click', (ev) => {
    const b = ev.target.closest('.subtab');
    if (b) showSub(b.dataset.surfaces);
  });

  window.addEventListener('cc:tab', (ev) => { if (ev.detail === 'surfaces') showSub(currentSub); });

  panes.selftest.insertAdjacentHTML('beforeend', '<p><button type="button" class="btn mini primary" id="selftestRun">RUN SELF-TEST</button></p><div id="selftestOut"></div>');

  // Initial: put every editor where its sub-tab is, so each is wired before it is first shown.
  for (const k of ['buttons', 'devices', 'tourbox', 'pages']) adopt(k);
  showSub('pages');
})();
