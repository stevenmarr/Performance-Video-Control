'use strict';
// PAGES, under Control Devices. Names a page for one surface type and assigns
// library buttons onto keys, encoders, and touch segments. Push sends the
// selected page to an online Path C deck. It does not open a second deploy path.
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
  let armed = '';
  let held = null;
  let confirmDelete = false;
  let confirmPush = false;
  let notice = '';

  const surfaces = () => (view && view.surfaces) || {};
  const byButton = (id) => buttons.find((b) => b.id === id);
  const ELEMENT = { button: 'Key', encoder: 'Encoder', 'touch-segment': 'Touch' };

  function reported() {
    const plugin = ((view && view.devices) || []).filter((d) => d && d.id).map((d) => ({
      id: d.id,
      name: d.name || d.model || d.id,
      model: d.model || '',
      surfaceId: d.surfaceId || null,
      online: d.online !== false,
      source: 'plugin',
      warnings: d.warnings || [],
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

  function emptyArt(kind, label) {
    return `<div class="pages-empty" data-slot="${kind}">${esc(label || 'empty')}</div>`;
  }

  function placedArt(slot, kind, label) {
    if (!slot) return emptyArt(kind, label);
    const svg = previews.get(slot.buttonId);
    const cls = kind === 'encoder' ? 'pages-encoder' : kind === 'touch' ? 'pages-touch' : 'deck-key big art';
    return `<div class="${cls}">${svg || '…'}</div>`;
  }

  function slotButton(kind, row, col, page) {
    const list = kind === 'key' ? (page && page.keys) : kind === 'encoder' ? (page && page.encoders) : (page && page.touch);
    const slot = list && list.find((s) => (kind === 'key' ? s.row === row && s.col === col : s.col === col));
    const label = kind === 'key' ? `${row + 1}·${col + 1}` : kind === 'encoder' ? 'enc' : 'touch';
    const title = kind === 'key' ? `Row ${row + 1}, column ${col + 1}` : kind === 'encoder' ? `Encoder column ${col + 1}` : `Touch column ${col + 1}`;
    const on = held && held.kind === kind && held.col === col && (kind !== 'key' || held.row === row);
    const cls = kind === 'key'
      ? `deck-key big ${slot ? 'art' : 'empty'}${on ? ' on' : ''}`
      : `pages-hit${on ? ' on' : ''}`;
    const body = kind === 'key'
      ? (slot ? (previews.get(slot.buttonId) || '…') : esc(label))
      : placedArt(slot, kind, label);
    const rowAttr = kind === 'key' ? ` data-row="${row}"` : '';
    return `<button type="button" class="${cls}" draggable="${slot ? 'true' : 'false'}" data-kind="${kind}" data-col="${col}"${rowAttr} title="${esc(title)}">${body}</button>`;
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
        cells.push(`<div class="pages-slot" style="grid-column:${c + 1}">${slotButton('encoder', 0, c, page)}${slotButton('touch', 0, c, page)}</div>`);
      }
      strip = `<div class="pages-strip deck-strip" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cells.join('')}</div>`;
    }
    const keys = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        keys.push(slotButton('key', r, c, page).replace('class="', `style="grid-column:${c + 1};grid-row:${r + 1}" class="`));
      }
    }
    const grid = `<div class="deck-mini deck-face" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:repeat(${rows},minmax(72px,1fr))">${keys.join('')}</div>`;
    return strip + grid;
  }

  function syncPage() {
    const surface = surfaceOf();
    const matching = surface ? pagesFor(surface.id) : [];
    if (pageId && !matching.some((p) => p.id === pageId)) pageId = '';
    if (!pageId && matching[0]) pageId = matching[0].id;
    return matching.find((p) => p.id === pageId) || null;
  }

  function paint() {
    const all = reported();
    const device = selectedDevice();
    const surface = surfaceOf();
    const page = syncPage();
    const sid = surface && surface.id;
    const matching = sid ? pagesFor(sid) : [];
    const typeButtons = ORDER.filter((id) => surfaces()[id]).map((id) => {
      const on = pick.kind === 'type' && pick.id === id && (!device || (page && page.surface === id));
      return `<button type="button" class="btn mini${on ? ' on' : ''}" data-type="${esc(id)}">${esc(SHORT[id] || surfaces()[id].label)}</button>`;
    }).join('');
    const saved = pages.length
      ? pages.map((p) => `<button type="button" class="deck-page${p.id === (page && page.id) ? ' on' : ''}" data-saved="${esc(p.id)}"><span><b>${esc(p.name)}</b><small>${esc(SHORT[p.surface] || p.surface)}</small></span></button>`).join('')
      : '<p class="note small">None yet.</p>';
    let heading = page ? page.name : 'No device connected';
    let detail = 'Pick a surface type to lay out a page. This is not a connected deck.';
    if (page && surface) {
      detail = `${surface.label} · saved for this surface type, not one deck`;
    } else if (device) {
      heading = device.name;
      detail = `${device.model || 'model unknown'} · ${sizeText(surface)} · ${device.online ? 'online' : 'offline'}`;
      if (!surface) detail += ' · Pick a surface type to lay out a page. That does not connect this deck.';
    } else if (surface) {
      heading = surface.label;
      detail = `${sizeText(surface)} · no device connected`;
    }
    const controls = surface ? `<div class="bl-fields">
      <label>New page<input id="pageNew" placeholder="Show ATEM" autocomplete="off"></label>
      <label class="bl-row" style="align-self:end"><button type="button" class="btn" data-create>Create</button></label>
      ${page ? `<label>Name<input id="pageName" value="${esc(page.name)}" autocomplete="off"></label>
        <label class="bl-row" style="align-self:end"><button type="button" class="btn" data-rename>Rename</button></label>
        <label class="bl-row" style="align-self:end">${confirmDelete
          ? `<button type="button" class="btn" data-do-delete>Delete page</button><button type="button" class="btn" data-cancel-delete>Cancel</button>`
          : `<button type="button" class="btn" data-ask-delete>Delete</button>`}</label>` : ''}
    </div>
    <p class="note small">${page ? (matching.length === 1 ? 'This is the only saved page for this size.' : `${matching.length} saved pages for this size.`) : 'No named page on this surface yet. The grid below is empty.'}</p>` : '';
    const library = surface ? `<div class="section-title">Library</div><div class="pages-lib">${buttons.length ? buttons.map((b) => `<button type="button" class="btn mini${armed === b.id ? ' on' : ''}" draggable="true" data-lib="${esc(b.id)}">${esc(b.name)} <small>${esc(ELEMENT[b.element] || b.element)}</small></button>`).join('') : '<p class="note small">No library buttons yet. Create them on Buttons.</p>'}</div>
    <p class="note small">${armed ? `Placing ${esc(byButton(armed) ? byButton(armed).name : 'button')}. Click a matching slot, or drag it.` : held ? 'Moving. Click another slot, or clear this one.' : 'Select a button, then a slot. Drag works the same way. Click a filled slot to move it.'}</p>
    ${held ? '<button type="button" class="btn" data-clear>Clear slot</button>' : ''}` : '';
    const slots = page ? ((page.keys || []).length + (page.encoders || []).length + (page.touch || []).length) : 0;
    const canPush = !!(page && device && device.source === 'plugin');
    const warnText = device && device.warnings && device.warnings.length ? device.warnings.map((w) => w.message).join(' ') : '';
    const push = !page ? '' : `<div class="bl-row">
      ${canPush ? `<button type="button" class="btn" data-push>${confirmPush ? 'Push anyway' : 'Push'}</button>` : ''}
      <span class="note small">${canPush
        ? (device.online ? `Push “${esc(page.name)}” to ${esc(device.name)}. A surface type is not a deck.` : `${esc(device.name)} is offline. Push will be refused.`)
        : 'Select an online Path C deck to push. A surface type is not a connected deck.'}</span>
    </div>
    ${warnText ? `<p class="note small">${esc(warnText)}</p>` : ''}
    ${canPush && !slots ? '<p class="note small">This page has no buttons. Push will be refused.</p>' : ''}`;
    const board = surface ? `<div class="pages-board">${boardHtml(surface, page)}</div>
      <p class="note small">Built-in pages on Devices stay there. Row 1 is the top. On + XL, row 4 column 9 is the bottom-right key. Nothing is pushed.</p>` : '';
    root.innerHTML = `<div class="pages-layout">
      <aside>
        ${group('Plugin', all.plugin)}
        ${group('USB', all.usb)}
        ${group('Known, offline', all.known)}
        <div class="pages-group">
          <div class="section-title">Surface type</div>
          <div class="surface-type">${typeButtons}</div>
        </div>
        <div class="pages-group">
          <div class="section-title">Saved pages</div>
          ${saved}
        </div>
      </aside>
      <div>
        <div class="bl-head"><h2>${esc(heading)}</h2></div>
        <p class="note small">${esc(detail)}</p>
        ${controls}
        ${library}
        ${push}
        ${notice ? `<p class="note small" role="status">${esc(notice)}</p>` : ''}
        ${board}
      </div>
    </div>`;
  }

  async function fillPreviews() {
    const page = syncPage();
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

  function slotsOf(page) {
    const copy = (list) => (list || []).map((s) => ({ ...s }));
    return { keys: copy(page.keys), encoders: copy(page.encoders), touch: copy(page.touch) };
  }

  function dropSlot(slots, slot) {
    if (slot.kind === 'key') slots.keys = slots.keys.filter((s) => !(s.row === slot.row && s.col === slot.col));
    else if (slot.kind === 'encoder') slots.encoders = slots.encoders.filter((s) => s.col !== slot.col);
    else slots.touch = slots.touch.filter((s) => s.col !== slot.col);
    return slots;
  }

  function putSlot(slots, slot, buttonId) {
    dropSlot(slots, slot);
    if (slot.kind === 'key') slots.keys.push({ buttonId, row: slot.row, col: slot.col });
    else if (slot.kind === 'encoder') slots.encoders.push({ buttonId, col: slot.col });
    else slots.touch.push({ buttonId, col: slot.col });
    return slots;
  }

  function occupant(page, slot) {
    if (!page) return null;
    if (slot.kind === 'key') return (page.keys || []).find((s) => s.row === slot.row && s.col === slot.col) || null;
    if (slot.kind === 'encoder') return (page.encoders || []).find((s) => s.col === slot.col) || null;
    return (page.touch || []).find((s) => s.col === slot.col) || null;
  }

  function readSlot(el) {
    const kind = el.dataset.kind;
    const col = Number(el.dataset.col);
    if (kind === 'key') return { kind, row: Number(el.dataset.row), col };
    return { kind, col };
  }

  function sameSlot(a, b) {
    if (!a || !b || a.kind !== b.kind || a.col !== b.col) return false;
    return a.kind !== 'key' || a.row === b.row;
  }

  function assertFit(button, slot) {
    const surface = surfaceOf();
    const want = slot.kind === 'key' ? 'button' : slot.kind === 'encoder' ? 'encoder' : 'touch-segment';
    if (button.element !== want) {
      const got = button.element === 'button' ? 'key' : button.element === 'touch-segment' ? 'touch segment' : button.element;
      const need = slot.kind === 'key' ? 'key' : slot.kind === 'encoder' ? 'encoder' : 'touch segment';
      const article = (w) => (/^[aeiou]/.test(w) ? 'an' : 'a');
      throw new Error(`${button.name} is ${article(got)} ${got}, not ${article(need)} ${need}`);
    }
    if (slot.kind !== 'key' && !(surface && (surface.knobCols || []).includes(slot.col))) {
      throw new Error(`Column ${slot.col + 1} has no encoder on this surface`);
    }
  }

  function slotLabel(slot) {
    if (slot.kind === 'key') return `row ${slot.row + 1}, column ${slot.col + 1}`;
    if (slot.kind === 'encoder') return `encoder column ${slot.col + 1}`;
    return `touch column ${slot.col + 1}`;
  }

  async function saveSlots(page, slots, message) {
    const saved = await api('PUT', `/api/surface-pages/${page.id}`, slots);
    const i = pages.findIndex((p) => p.id === saved.id);
    if (i >= 0) pages[i] = saved;
    notice = message;
    armed = '';
    held = null;
    await fillPreviews();
    paint();
  }

  async function place(buttonId, slot, from) {
    const page = syncPage();
    if (!page) { notice = 'Create a page before assigning a button.'; paint(); return; }
    const button = byButton(buttonId);
    if (!button) { notice = 'That button is not in the library.'; paint(); return; }
    assertFit(button, slot);
    const slots = slotsOf(page);
    if (from) dropSlot(slots, from);
    putSlot(slots, slot, button.id);
    const verb = from ? 'Moved' : 'Placed';
    await saveSlots(page, slots, `${verb} ${button.name} on ${slotLabel(slot)}.`);
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

  function readDrag(ev) {
    const raw = (ev.dataTransfer && ev.dataTransfer.getData('text/plain')) || '';
    if (!raw.startsWith('{"from":')) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  root.addEventListener('click', (ev) => {
    const device = ev.target.closest('[data-device]');
    if (device) {
      chosen = true;
      pick = { kind: 'device', id: device.dataset.device };
      pageId = '';
      armed = '';
      held = null;
      confirmDelete = false;
      confirmPush = false;
      run(fillPreviews().then(paint));
      return;
    }
    const type = ev.target.closest('[data-type]');
    if (type) {
      chosen = true;
      pick = { kind: 'type', id: type.dataset.type };
      pageId = '';
      armed = '';
      held = null;
      confirmDelete = false;
      confirmPush = false;
      run(fillPreviews().then(paint));
      return;
    }
    const saved = ev.target.closest('[data-saved]');
    if (saved) {
      const next = pages.find((p) => p.id === saved.dataset.saved);
      if (!next) return;
      chosen = true;
      const deviceNow = selectedDevice();
      if (!deviceNow || deviceNow.surfaceId !== next.surface) pick = { kind: 'type', id: next.surface };
      pageId = next.id;
      armed = '';
      held = null;
      confirmDelete = false;
      confirmPush = false;
      run(fillPreviews().then(paint));
      return;
    }
    const pageBtn = ev.target.closest('[data-page]');
    if (pageBtn) {
      pageId = pageBtn.dataset.page;
      armed = '';
      held = null;
      confirmDelete = false;
      confirmPush = false;
      run(fillPreviews().then(paint));
      return;
    }
    const libBtn = ev.target.closest('[data-lib]');
    if (libBtn) {
      held = null;
      armed = armed === libBtn.dataset.lib ? '' : libBtn.dataset.lib;
      paint();
      return;
    }
    if (ev.target.closest('[data-create]')) {
      const surface = surfaceOf();
      const name = ((root.querySelector('#pageNew') || {}).value || '').trim();
      if (!surface) { toast('Pick a surface type first.', true); return; }
      if (!name) { toast('A name is required', true); return; }
      run((async () => {
        const made = await api('POST', '/api/surface-pages', { name, surface: surface.id });
        pages.push(made);
        pageId = made.id;
        notice = `Saved “${made.name}”. Nothing was pushed.`;
        confirmDelete = false;
      confirmPush = false;
        paint();
      })());
      return;
    }
    if (ev.target.closest('[data-rename]')) {
      const page = syncPage();
      const name = ((root.querySelector('#pageName') || {}).value || '').trim();
      if (!page) return;
      run((async () => {
        const saved = await api('POST', `/api/surface-pages/${page.id}/rename`, { name });
        const i = pages.findIndex((p) => p.id === saved.id);
        if (i >= 0) pages[i] = saved;
        notice = `Renamed to “${saved.name}”.`;
        paint();
      })());
      return;
    }
    if (ev.target.closest('[data-ask-delete]')) { confirmDelete = true; paint(); return; }
    if (ev.target.closest('[data-cancel-delete]')) { confirmDelete = false; confirmPush = false; paint(); return; }
    if (ev.target.closest('[data-push]')) {
      const page = syncPage();
      const target = selectedDevice();
      if (!page) { toast('Create a page before pushing.', true); return; }
      if (!target || target.source !== 'plugin') { toast('Select an online Path C deck. A surface type is not a connected deck.', true); return; }
      const filled = ((page.keys || []).length + (page.encoders || []).length + (page.touch || []).length);
      if (!filled) { toast('This page has no buttons.', true); return; }
      if (target.warnings && target.warnings.length && !confirmPush) {
        confirmPush = true;
        notice = target.warnings.map((w) => w.message).join(' ');
        paint();
        return;
      }
      confirmPush = false;
      run((async () => {
        const result = await api('POST', '/api/decks/deploy', { deviceId: target.id, pageId: page.id });
        const extra = result.warnings && result.warnings.length ? ` ${result.warnings[0].message}` : '';
        notice = `Pushed “${page.name}” to ${target.name}.${extra}`;
        await load();
      })());
      return;
    }
    if (ev.target.closest('[data-do-delete]')) {
      const page = syncPage();
      if (!page) return;
      run((async () => {
        await api('DELETE', `/api/surface-pages/${page.id}`);
        pages = pages.filter((p) => p.id !== page.id);
        pageId = '';
        confirmDelete = false;
      confirmPush = false;
        notice = `Deleted “${page.name}”. The buttons are still in the library.`;
        paint();
      })());
      return;
    }
    if (ev.target.closest('[data-clear]')) {
      const page = syncPage();
      if (!page || !held) return;
      const slots = dropSlot(slotsOf(page), held);
      run(saveSlots(page, slots, 'Slot cleared.'));
      return;
    }
    const hit = ev.target.closest('[data-kind]');
    if (!hit) return;
    const slot = readSlot(hit);
    const page = syncPage();
    if (!page) { notice = 'Create a page before assigning a button.'; paint(); return; }
    if (armed) {
      run(place(armed, slot, null));
      return;
    }
    if (held) {
      if (sameSlot(held, slot)) { held = null; paint(); return; }
      const from = occupant(page, held);
      if (!from) { held = null; paint(); return; }
      run(place(from.buttonId, slot, held));
      return;
    }
    const filled = occupant(page, slot);
    if (filled) { held = slot; paint(); }
  });

  root.addEventListener('dragstart', (ev) => {
    const libBtn = ev.target.closest('[data-lib]');
    const hit = ev.target.closest('[data-kind]');
    if (libBtn) {
      ev.dataTransfer.setData('text/plain', JSON.stringify({ from: 'library', buttonId: libBtn.dataset.lib }));
      ev.dataTransfer.effectAllowed = 'copy';
      return;
    }
    if (hit && hit.getAttribute('draggable') === 'true') {
      const page = syncPage();
      const slot = readSlot(hit);
      const filled = occupant(page, slot);
      if (!filled) return;
      ev.dataTransfer.setData('text/plain', JSON.stringify({ from: 'slot', buttonId: filled.buttonId, slot }));
      ev.dataTransfer.effectAllowed = 'move';
    }
  });

  root.addEventListener('dragover', (ev) => {
    if (ev.target.closest('[data-kind]')) ev.preventDefault();
  });

  root.addEventListener('drop', (ev) => {
    const hit = ev.target.closest('[data-kind]');
    if (!hit) return;
    ev.preventDefault();
    const payload = readDrag(ev);
    if (!payload || !payload.buttonId) return;
    const slot = readSlot(hit);
    run(place(payload.buttonId, slot, payload.from === 'slot' ? payload.slot : null));
  });

  window.addEventListener('cc:tab', (ev) => { if (ev.detail === 'pages') run(load().catch((e) => toast(e.message || 'Could not load pages'))); });
  if (window.CC.getTab && window.CC.getTab() === 'pages') run(load());
})();
