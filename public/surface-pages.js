'use strict';
// PAGES, under Control Devices. Draws a real surface grid. Read-only:
// no assign, no rename, no push. Placement editing is a later step.
(() => {
  const root = document.querySelector('#pagesRoot');
  if (!root || !window.CC) return;
  const { api, toast, run, esc } = window.CC;
  const ORDER = ['mini', 'mk2', 'neo', 'xl', 'plus', 'plusxl'];
  const SHORT = { mini: 'Mini', mk2: 'MK.2', neo: 'Neo', xl: 'XL', plus: '+', plusxl: '+ XL' };

  let view = null;
  let pages = [];
  let buttons = [];
  let pick = { kind: 'type', id: 'plusxl' };
  let pageId = '';
  let chosen = false;
  let previews = new Map();

  const surfaces = () => (view && view.surfaces) || {};
  const byButton = (id) => buttons.find((b) => b.id === id);

  function reported() {
    const plugin = ((view && view.devices) || []).filter((d) => d && d.id).map((d) => ({
      id: d.id,
      name: d.name || d.model || d.id,
      model: d.model || '',
      surfaceId: d.surfaceId || null,
      online: d.online !== false,
      source: 'plugin',
    }));
    const usb = ((view && view.control && view.control.devices) || [])
      .filter((d) => d && d.id && d.id !== 'preview' && d.transport !== 'preview')
      .map((d) => ({
        id: d.id,
        name: d.name || d.model || d.id,
        model: d.model || '',
        surfaceId: d.surfaceId || null,
        online: d.online !== false,
        source: 'usb',
      }));
    const known = ((view && view.known) || []).filter((d) => d && d.id && d.id !== 'preview').map((d) => ({
      id: d.id,
      name: d.name || d.id,
      model: d.model || '',
      surfaceId: d.surfaceId || null,
      online: false,
      source: 'stored',
    }));
    return { plugin, usb, known };
  }

  function selectedDevice() {
    if (pick.kind !== 'device') return null;
    const all = reported();
    return [...all.plugin, ...all.usb, ...all.known].find((d) => d.id === pick.id) || null;
  }

  function surfaceIdOf() {
    const device = selectedDevice();
    if (device) return device.surfaceId || null;
    return surfaces()[pick.id] ? pick.id : null;
  }

  function surfaceOf() {
    const id = surfaceIdOf();
    return id ? surfaces()[id] : null;
  }

  function pagesFor(surfaceId) {
    return pages.filter((p) => p.surface === surfaceId);
  }

  function sizeText(surface) {
    if (!surface) return 'size unknown';
    const knobs = (surface.knobCols || []).length;
    return `${surface.cols}×${surface.rows}${knobs ? ` · ${knobs} encoders` : ''}`;
  }

  function deviceButton(d) {
    const on = pick.kind === 'device' && pick.id === d.id;
    const surface = d.surfaceId ? surfaces()[d.surfaceId] : null;
    const where = d.source === 'usb' ? 'USB' : d.source === 'plugin' ? 'Plugin' : 'Stored';
    return `<button type="button" class="deck-page${on ? ' on' : ''}" data-device="${esc(d.id)}">
      <span><b>${esc(d.name)}</b><small>${esc(d.model || 'model unknown')} · ${esc(sizeText(surface))} · ${esc(where)}</small></span>
      <span class="pages-state ${d.online ? 'on' : 'off'}">${d.online ? 'online' : 'offline'}</span>
    </button>`;
  }

  function group(title, list) {
    const body = list.length ? list.map(deviceButton).join('') : '<p class="note small">None.</p>';
    return `<div class="pages-group"><div class="section-title">${title}</div>${body}</div>`;
  }

  function emptyArt(kind) {
    return `<div class="pages-empty" data-slot="${kind}">empty</div>`;
  }

  function placedArt(slot, kind) {
    if (!slot) return emptyArt(kind);
    const svg = previews.get(slot.buttonId);
    const cls = kind === 'encoder' ? 'pages-encoder' : kind === 'touch' ? 'pages-touch' : 'deck-key big art';
    return `<div class="${cls}">${svg || '…'}</div>`;
  }

  function boardHtml(surface, page) {
    const cols = surface.cols;
    const rows = surface.rows;
    const knobs = surface.knobCols || [];
    let strip = '';
    if (knobs.length) {
      const cells = [];
      for (let c = 0; c < cols; c++) {
        if (!knobs.includes(c)) {
          cells.push(`<div style="grid-column:${c + 1}"></div>`);
          continue;
        }
        const enc = page && (page.encoders || []).find((s) => s.col === c);
        const touch = page && (page.touch || []).find((s) => s.col === c);
        cells.push(`<div class="pages-slot" style="grid-column:${c + 1}">${placedArt(enc, 'encoder')}${placedArt(touch, 'touch')}</div>`);
      }
      strip = `<div class="pages-strip deck-strip" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cells.join('')}</div>`;
    }
    const keys = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const slot = page && (page.keys || []).find((s) => s.row === r && s.col === c);
        const body = slot ? (previews.get(slot.buttonId) || '…') : 'empty';
        keys.push(`<div class="deck-key big ${slot ? 'art' : 'empty'}" style="grid-column:${c + 1};grid-row:${r + 1}">${body}</div>`);
      }
    }
    const grid = `<div class="deck-mini deck-face" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:repeat(${rows},minmax(72px,1fr))">${keys.join('')}</div>`;
    return strip + grid;
  }

  function paint() {
    const all = reported();
    const device = selectedDevice();
    const surface = surfaceOf();
    const sid = surface && surface.id;
    const matching = sid ? pagesFor(sid) : [];
    if (pageId && !matching.some((p) => p.id === pageId)) pageId = '';
    if (!pageId && matching[0]) pageId = matching[0].id;
    const page = matching.find((p) => p.id === pageId) || null;
    const typeButtons = ORDER.filter((id) => surfaces()[id]).map((id) => {
      const on = !device && pick.kind === 'type' && pick.id === id;
      return `<button type="button" class="btn mini${on ? ' on' : ''}" data-type="${esc(id)}">${esc(SHORT[id] || surfaces()[id].label)}</button>`;
    }).join('');
    let heading = 'No device connected';
    let detail = 'Pick a surface type to lay out a page. This is not a connected deck.';
    if (device) {
      heading = device.name;
      detail = `${device.model || 'model unknown'} · ${sizeText(surface)} · ${device.online ? 'online' : 'offline'}`;
      if (!surface) detail += ' · Pick a surface type to preview a grid. That does not connect this deck.';
    } else if (surface) {
      heading = surface.label;
      detail = `${sizeText(surface)} · no device connected`;
    }
    const pageNote = !surface
      ? ''
      : (page
        ? `<div class="pages-pages">${matching.map((p) => `<button type="button" class="btn mini${p.id === page.id ? ' on' : ''}" data-page="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>`
        : '<p class="note small" id="pagesPlaceholder">No named page on this surface yet.</p>');
    const board = surface ? `<div class="pages-board">${boardHtml(surface, page)}</div>` : '';
    root.innerHTML = `<div class="pages-layout">
      <aside>
        ${group('Plugin', all.plugin)}
        ${group('USB', all.usb)}
        ${group('Known, offline', all.known)}
        <div class="pages-group">
          <div class="section-title">Surface type</div>
          <div class="surface-type">${typeButtons}</div>
        </div>
      </aside>
      <div>
        <div class="bl-head"><h2>${esc(heading)}</h2></div>
        <p class="note small">${esc(detail)}</p>
        ${pageNote}
        ${board}
      </div>
    </div>`;
  }

  async function fillPreviews() {
    const surface = surfaceOf();
    const matching = surface ? pagesFor(surface.id) : [];
    if (pageId && !matching.some((p) => p.id === pageId)) pageId = '';
    if (!pageId && matching[0]) pageId = matching[0].id;
    const page = matching.find((p) => p.id === pageId) || null;
    if (!page) return;
    const ids = new Set();
    for (const slot of [...(page.keys || []), ...(page.encoders || []), ...(page.touch || [])]) {
      if (slot && slot.buttonId) ids.add(slot.buttonId);
    }
    await Promise.all([...ids].filter((id) => !previews.has(id)).map(async (id) => {
      const button = byButton(id);
      if (!button) { previews.set(id, ''); return; }
      try {
        const drawn = await api('POST', '/api/buttons/preview', { button });
        previews.set(id, (drawn && drawn.svg) || '');
      } catch { previews.set(id, ''); }
    }));
  }

  async function load() {
    const [decks, pageView, lib] = await Promise.all([
      api('GET', '/api/decks'),
      api('GET', '/api/surface-pages'),
      api('GET', '/api/buttons'),
    ]);
    view = decks;
    pages = (pageView && pageView.pages) || [];
    buttons = (lib && lib.buttons) || [];
    const all = reported();
    const live = [...all.plugin, ...all.usb];
    if (!chosen && live[0]) pick = { kind: 'device', id: live[0].id };
    if (pick.kind === 'device' && ![...live, ...all.known].some((d) => d.id === pick.id)) {
      pick = live[0] ? { kind: 'device', id: live[0].id } : { kind: 'type', id: 'plusxl' };
    }
    await fillPreviews();
    paint();
  }

  root.addEventListener('click', (ev) => {
    const device = ev.target.closest('[data-device]');
    if (device) {
      chosen = true;
      pick = { kind: 'device', id: device.dataset.device };
      pageId = '';
      run(fillPreviews().then(paint));
      return;
    }
    const type = ev.target.closest('[data-type]');
    if (type) {
      chosen = true;
      pick = { kind: 'type', id: type.dataset.type };
      pageId = '';
      run(fillPreviews().then(paint));
      return;
    }
    const page = ev.target.closest('[data-page]');
    if (page) {
      pageId = page.dataset.page;
      run(fillPreviews().then(paint));
    }
  });

  window.addEventListener('cc:tab', (ev) => { if (ev.detail === 'pages') run(load().catch((e) => toast(e.message || 'Could not load pages'))); });
  if (window.CC.getTab && window.CC.getTab() === 'pages') run(load());
})();
