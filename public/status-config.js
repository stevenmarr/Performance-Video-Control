'use strict';
// Layout editor. Saves tiles to Control Center. Does not talk to show gear.
(function () {
  const TYPES = [
    ['clock', 'Clock'],
    ['countdown', 'Countdown'],
    ['timer', 'Time remaining'],
    ['text', 'Text'],
    ['tally', 'Tally'],
    ['online', 'Online / offline'],
    ['preset', 'Preset (standby and program)'],
  ];
  const $ = (id) => document.getElementById(id);
  let layouts = [];
  let sources = [];
  let draft = null;
  let selected = null;
  let saved = '';
  let drag = null;
  let previewTimer = null;

  const typeSelect = $('tileType');
  for (const [id, label] of TYPES) typeSelect.appendChild(new Option(label, id));
  const addList = $('addList');
  for (const [id, label] of TYPES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => addTile(id));
    addList.appendChild(button);
  }

  function plain(layout) {
    return JSON.stringify({
      name: layout.name, timeZone: layout.timeZone, hour12: layout.hour12 !== false,
      tiles: (layout.tiles || []).map((tile) => {
        const out = {};
        for (const [key, value] of Object.entries(tile)) if (!key.startsWith('_')) out[key] = value;
        return out;
      }),
    });
  }

  function dirty() {
    return !!draft && plain(draft) !== saved;
  }

  function setLine(text, warn) {
    $('statusLine').innerHTML = '';
    $('statusLine').textContent = text;
    if (warn) $('statusLine').classList.add('warn-overlap');
    else $('statusLine').classList.remove('warn-overlap');
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Could not save (${res.status})`);
    return json;
  }

  function fillPick() {
    const pick = $('layoutPick');
    const current = draft && draft.id;
    pick.textContent = '';
    for (const layout of layouts) pick.appendChild(new Option(layout.name, layout.id));
    if (current) pick.value = current;
  }

  function fillSources() {
    const select = $('tileSource');
    const current = select.value;
    select.textContent = '';
    const groups = new Map();
    for (const source of sources) {
      if (!groups.has(source.group)) groups.set(source.group, []);
      groups.get(source.group).push(source);
    }
    for (const [name, rows] of groups) {
      const group = document.createElement('optgroup');
      group.label = name;
      for (const row of rows) {
        const value = row.kind === 'system' ? `system:${row.system || row.id}` : row.kind;
        group.appendChild(new Option(row.label, value));
      }
      select.appendChild(group);
    }
    if (current) select.value = current;
  }

  function sourceValue(source) {
    const src = source || {};
    if (src.kind === 'system') return `system:${src.system || ''}`;
    return src.kind || 'system';
  }

  function readSource(value) {
    if (value && value.startsWith('system:')) return { kind: 'system', system: value.slice(7), variable: $('tileVar').value.trim(), at: $('tileAt').value.trim() };
    return { kind: value || 'system', system: '', variable: $('tileVar').value.trim(), at: $('tileAt').value.trim() };
  }

  function loadDraft(layout) {
    draft = JSON.parse(JSON.stringify(layout));
    saved = plain(draft);
    selected = draft.tiles[0] ? draft.tiles[0].id : null;
    $('layoutName').value = draft.name;
    $('timeZone').value = draft.timeZone;
    $('hour12').value = draft.hour12 === false ? '24' : '12';
    $('watch').href = `/status?layout=${encodeURIComponent(draft.name)}`;
    $('download').href = `/api/status/layouts/${encodeURIComponent(draft.id)}/export`;
    fillPick();
    paint();
    showInspector();
    preview();
  }

  function paint() {
    const grid = $('grid');
    grid.textContent = '';
    const rows = Math.max(8, ...draft.tiles.map((tile) => tile.row + tile.h), 1);
    grid.style.gridTemplateRows = `repeat(${rows}, var(--row))`;
    for (const tile of draft.tiles) {
      const node = StatusView.renderTile({ ...tile, primary: tile._primary || '', secondary: tile._secondary || '', note: tile._note || '', items: tile._items || [], kicker: tile._kicker || '', warn: tile._warn || 'none', live: !!tile._live });
      if (tile.id === selected) node.classList.add('selected');
      const handle = document.createElement('div');
      handle.className = 'resize';
      handle.title = 'Resize';
      node.appendChild(handle);
      node.addEventListener('pointerdown', (ev) => onPointerDown(ev, tile, ev.target === handle));
      grid.appendChild(node);
    }
    const overlap = StatusGrid.overlaps(draft.tiles);
    if (overlap) setLine('Two tiles sit on the same square. Drag one off the other, then save.', true);
    else if (dirty()) setLine('Not saved yet. The wall does not change until you press Save.');
    else setLine('Saved. Open the wall to see this layout with no controls. Drag a tile to move it. Drag the corner to resize it.');
  }

  function showInspector() {
    const tile = draft.tiles.find((row) => row.id === selected);
    $('inspector').hidden = !tile;
    $('inspectorEmpty').hidden = !!tile;
    if (!tile) return;
    $('inspectorTitle').textContent = 'THIS TILE';
    $('tileLabel').value = tile.label || '';
    $('tileType').value = tile.type;
    fillSources();
    $('tileSource').value = sourceValue(tile.source);
    if ($('tileSource').value !== sourceValue(tile.source)) $('tileSource').value = 'system:';
    $('tileVar').value = (tile.source && tile.source.variable) || '';
    $('tileAt').value = (tile.source && tile.source.at) || '';
    $('countMode').value = tile.countMode === 'remaining' ? 'remaining' : 'until';
    $('fontSize').value = tile.fontSize;
    $('sizePreset').value = ['28', '48', '72', '120'].includes(String(tile.fontSize)) ? String(tile.fontSize) : '';
    $('color').value = toColorInput(tile.color, '#d9dee5');
    $('background').value = toColorInput(tile.background, '#14181d');
    $('amberSec').value = tile.warn.amberSec;
    $('redSec').value = tile.warn.redSec;
    const kind = (tile.source && tile.source.kind) || '';
    $('varRow').hidden = kind !== 'companion';
    $('atRow').hidden = tile.type !== 'countdown' || kind === 'companion';
    $('modeRow').hidden = !(tile.type === 'countdown' && kind === 'companion');
    syncRows();
  }

  function syncRows() {
    const tile = draft && draft.tiles.find((row) => row.id === selected);
    if (!tile) return;
    const kind = (tile.source && tile.source.kind) || '';
    $('varRow').hidden = kind !== 'companion';
    $('atRow').hidden = tile.type !== 'countdown' || kind === 'companion';
    $('modeRow').hidden = !(tile.type === 'countdown' && kind === 'companion');
    $('warnRow').hidden = tile.type !== 'countdown' && tile.type !== 'timer';
  }

  function toColorInput(value, fallback) {
    return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : fallback;
  }

  function applyInspector() {
    const tile = draft.tiles.find((row) => row.id === selected);
    if (!tile) return;
    tile.label = $('tileLabel').value.trim();
    tile.type = $('tileType').value;
    tile.source = readSource($('tileSource').value);
    tile.countMode = $('countMode').value === 'remaining' ? 'remaining' : 'until';
    tile.fontSize = Math.max(12, Math.min(200, Number($('fontSize').value) || 48));
    const box = StatusGrid.clampTile(tile);
    tile.col = box.col; tile.row = box.row; tile.w = box.w; tile.h = box.h;
    tile.warn = { amberSec: Math.max(0, Number($('amberSec').value) || 0), redSec: Math.max(0, Number($('redSec').value) || 0) };
    paint();
    syncRows();
    schedulePreview();
  }

  function onPointerDown(ev, tile, resize) {
    if (ev.button != null && ev.button !== 0) return;
    selected = tile.id;
    const start = cellOf(ev);
    drag = { id: tile.id, resize, col: tile.col, row: tile.row, w: tile.w, h: tile.h, grabCol: start.col - tile.col, grabRow: start.row - tile.row };
    for (const node of document.querySelectorAll('.ed-grid .st-tile')) node.classList.toggle('selected', node.dataset.id === tile.id);
    ev.currentTarget.setPointerCapture(ev.pointerId);
    ev.currentTarget.addEventListener('pointermove', onPointerMove);
    ev.currentTarget.addEventListener('pointerup', onPointerUp);
    showInspector();
  }

  function onPointerMove(ev) {
    if (!drag) return;
    const tile = draft.tiles.find((row) => row.id === drag.id);
    if (!tile) return;
    const cell = cellOf(ev);
    if (drag.resize) {
      tile.col = drag.col;
      tile.row = drag.row;
      tile.w = cell.col - drag.col + 1;
      tile.h = cell.row - drag.row + 1;
    } else {
      tile.col = cell.col - drag.grabCol;
      tile.row = cell.row - drag.grabRow;
    }
    const box = StatusGrid.clampTile(tile);
    tile.col = box.col; tile.row = box.row; tile.w = box.w; tile.h = box.h;
    ev.currentTarget.style.gridColumn = `${tile.col + 1} / span ${tile.w}`;
    ev.currentTarget.style.gridRow = `${tile.row + 1} / span ${tile.h}`;
  }

  function onPointerUp(ev) {
    drag = null;
    ev.currentTarget.removeEventListener('pointermove', onPointerMove);
    ev.currentTarget.removeEventListener('pointerup', onPointerUp);
    paint();
    schedulePreview();
  }

  function cellOf(ev) {
    const grid = $('grid');
    const rect = grid.getBoundingClientRect();
    const gap = 10;
    const colW = (rect.width - gap * 11) / 12;
    const rowH = 88;
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    return {
      col: Math.max(0, Math.min(11, Math.floor(x / (colW + gap)))),
      row: Math.max(0, Math.min(24, Math.floor(y / (rowH + gap)))),
    };
  }

  function addTile(type) {
    const gap = StatusGrid.firstGap(draft.tiles);
    const id = `t${Math.random().toString(36).slice(2, 8)}`;
    const source = type === 'clock' ? { kind: 'clock', system: '', variable: '', at: '' }
      : type === 'countdown' ? { kind: 'countdown', system: '', variable: '', at: '19:00' }
      : { kind: 'system', system: 'atem', variable: '', at: '' };
    draft.tiles.push({
      id, type, label: TYPES.find((row) => row[0] === type)[1],
      ...gap, fontSize: type === 'clock' ? 96 : type === 'countdown' || type === 'timer' ? 84 : 42,
      color: '', background: '', warn: { amberSec: 30, redSec: 10 }, source, countMode: 'until', timeZone: '', hour12: null,
    });
    selected = id;
    paint();
    schedulePreview();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 250);
  }

  async function preview() {
    if (!draft || drag) return;
    try {
      const board = await api('POST', '/api/status/preview', payload());
      const byId = new Map((board.tiles || []).map((tile) => [tile.id, tile]));
      let changed = false;
      for (const tile of draft.tiles) {
        const live = byId.get(tile.id);
        if (!live) continue;
        const next = JSON.stringify([live.primary, live.secondary, live.note, live.kicker, live.warn, live.live, live.items]);
        if (tile._sig !== next) changed = true;
        tile._sig = next;
        tile._primary = live.primary; tile._secondary = live.secondary; tile._note = live.note;
        tile._items = live.items; tile._kicker = live.kicker; tile._warn = live.warn; tile._live = live.live;
      }
      if (changed && !drag) paint();
    } catch (e) {
      setLine(e.message, true);
    }
  }

  function payload() {
    return {
      id: draft.id, name: $('layoutName').value.trim() || draft.name,
      timeZone: $('timeZone').value.trim() || 'America/Chicago',
      hour12: $('hour12').value !== '24',
      notes: draft.notes !== false, editLink: draft.editLink !== false,
      tiles: draft.tiles.map((tile) => ({
        id: tile.id, type: tile.type, label: tile.label, col: tile.col, row: tile.row, w: tile.w, h: tile.h,
        fontSize: tile.fontSize, color: tile.color, background: tile.background, warn: tile.warn,
        source: tile.source, countMode: tile.countMode, timeZone: tile.timeZone || '', hour12: tile.hour12,
      })),
    };
  }

  async function save() {
    try {
      const layout = await api('PUT', `/api/status/layouts/${encodeURIComponent(draft.id)}`, payload());
      const i = layouts.findIndex((row) => row.id === draft.id);
      if (i >= 0) layouts[i] = layout;
      loadDraft(layout);
      setLine(`Saved “${layout.name}”. The wall is /status?layout=${encodeURIComponent(layout.name)}`);
    } catch (e) {
      setLine(e.message, true);
    }
  }

  async function boot() {
    const [list, sourceBody] = await Promise.all([
      api('GET', '/api/status/layouts'),
      api('GET', '/api/status/sources'),
    ]);
    layouts = list.layouts || [];
    sources = sourceBody.sources || [];
    const want = new URLSearchParams(location.search).get('layout');
    const found = layouts.find((row) => want && (row.name.toLowerCase() === want.toLowerCase() || row.id === want)) || layouts[0];
    if (found) loadDraft(found);
  }

  $('layoutPick').addEventListener('change', async () => {
    if (dirty() && !confirm('This layout is not saved. Throw away the changes?')) {
      $('layoutPick').value = draft.id;
      return;
    }
    const next = layouts.find((row) => row.id === $('layoutPick').value);
    if (next) loadDraft(JSON.parse(JSON.stringify(next)));
  });
  $('save').addEventListener('click', save);
  $('newLayout').addEventListener('click', async () => {
    try {
      const layout = await api('POST', '/api/status/layouts', { name: 'New layout', timeZone: $('timeZone').value });
      layouts.push(layout);
      loadDraft(layout);
    } catch (e) { setLine(e.message, true); }
  });
  $('duplicate').addEventListener('click', async () => {
    try {
      const layout = await api('POST', '/api/status/layouts', { copyFrom: draft.id });
      layouts.push(layout);
      loadDraft(layout);
    } catch (e) { setLine(e.message, true); }
  });
  $('remove').addEventListener('click', async () => {
    if (!confirm(`Delete the layout “${draft.name}”? The wall that uses it will not find it.`)) return;
    try {
      await api('DELETE', `/api/status/layouts/${encodeURIComponent(draft.id)}`);
      layouts = layouts.filter((row) => row.id !== draft.id);
      loadDraft(layouts[0]);
    } catch (e) { setLine(e.message, true); }
  });
  $('removeTile').addEventListener('click', () => {
    draft.tiles = draft.tiles.filter((row) => row.id !== selected);
    selected = draft.tiles[0] ? draft.tiles[0].id : null;
    paint();
    schedulePreview();
  });
  for (const id of ['tileLabel', 'tileType', 'tileSource', 'tileVar', 'tileAt', 'countMode', 'fontSize', 'amberSec', 'redSec']) {
    $(id).addEventListener('input', applyInspector);
    $(id).addEventListener('change', applyInspector);
  }
  $('sizePreset').addEventListener('change', () => {
    if ($('sizePreset').value) $('fontSize').value = $('sizePreset').value;
    applyInspector();
  });
  $('color').addEventListener('input', () => {
    const tile = draft.tiles.find((row) => row.id === selected);
    if (tile) tile.color = $('color').value;
    paint();
  });
  $('background').addEventListener('input', () => {
    const tile = draft.tiles.find((row) => row.id === selected);
    if (tile) tile.background = $('background').value;
    paint();
  });
  $('clearColor').addEventListener('click', () => {
    const tile = draft.tiles.find((row) => row.id === selected);
    if (!tile) return;
    tile.color = '';
    tile.background = '';
    paint();
  });
  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files && $('importFile').files[0];
    if (!file) return;
    try {
      const body = JSON.parse(await file.text());
      const result = await api('POST', '/api/status/import', body);
      layouts = result.layouts;
      loadDraft(layouts[layouts.length - 1]);
      setLine('Loaded the file. The layouts are saved on this Control Center.');
    } catch (e) {
      setLine(e.message || 'That file is not a status layout.', true);
    }
    $('importFile').value = '';
  });
  function touchLayout() {
    if (!draft) return;
    const name = $('layoutName').value.trim();
    if (name) draft.name = name;
    draft.timeZone = $('timeZone').value.trim() || 'America/Chicago';
    draft.hour12 = $('hour12').value !== '24';
    $('watch').href = `/status?layout=${encodeURIComponent(draft.name)}`;
    if (!StatusGrid.overlaps(draft.tiles)) setLine(dirty() ? 'Not saved yet. The wall does not change until you press Save.' : 'Saved. Open the wall to see this layout with no controls.');
    schedulePreview();
  }
  $('hour12').addEventListener('change', touchLayout);
  $('timeZone').addEventListener('input', touchLayout);
  $('layoutName').addEventListener('input', touchLayout);

  boot().catch((e) => setLine(e.message, true));
})();
