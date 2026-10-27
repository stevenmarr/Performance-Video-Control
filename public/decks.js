/* Control Devices: each USB Stream Deck has its own system.
   A Plus can sit on RS6 while a + XL sits on PTZ. */
(() => {
  const root = document.querySelector('#deckRoot');
  if (!root || !window.CC) return;
  const { api, toast, run, esc } = window.CC;
  const note = document.querySelector('#deckPluginNote');
  let view = null;

  const devices = () => (view && view.control && view.control.devices) || [];

  function grid(device, face, columns, rows) {
    const knobs = (face.dials || []).filter((d) => d.svg).map((d) => `<div class="deck-knob-art">${d.svg}</div>`).join('');
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const k = (face.keys || []).find((key) => key.row === r && key.col === c);
        cells.push(`<button type="button" class="deck-key art" data-device="${esc(device.id)}" data-col="${c}" data-row="${r}" style="grid-column:${c + 1};grid-row:${r + 1}">${(k && k.svg) || ''}</button>`);
      }
    }
    const strip = knobs ? `<div class="deck-strip">${knobs}</div>` : '';
    return `${strip}<div class="deck-mini deck-face" style="grid-template-columns:repeat(${columns},minmax(0,1fr));grid-template-rows:repeat(${rows},minmax(72px,1fr))">${cells.join('')}</div>`;
  }

  function picks(device) {
    const armed = (view && view.desk && view.desk.armed) || [];
    const current = device.face && device.face.system;
    const ids = [''].concat(armed);
    return `<div class="deck-pick">${ids.map((id) => {
      const on = (id || null) === (current || null);
      const label = id ? id.toUpperCase() : 'HOME';
      return `<button type="button" class="btn mini${on ? ' on' : ''}" data-assign="${esc(device.id)}" data-system="${esc(id)}">${label}</button>`;
    }).join('')}</div>`;
  }

  function render() {
    const control = (view && view.control) || { devices: [], driver: {} };
    const driver = control.driver || {};
    const live = (control.devices || []).filter((d) => d.transport === 'usb');
    if (note) {
      note.textContent = !driver.installed
        ? (driver.error || 'USB driver is not installed.')
        : (live.length
          ? `${live.length} Stream Deck${live.length === 1 ? '' : 's'} on USB. Each one keeps its own system.`
          : 'No Stream Deck on USB yet. This preview is one deck. A second deck would sit beside it with its own system.');
    }
    const cards = devices().map((d) => {
      const surface = view.surfaces ? view.surfaces[d.surfaceId] : null;
      const cols = (surface && surface.cols) || d.columns || 5;
      const rows = (surface && surface.rows) || d.rows || 3;
      const face = d.face;
      const title = face ? face.title : 'HOME';
      return `<article class="deck-one">
        <div class="section-title">${esc(d.name || d.model || 'Stream Deck')} <small>${esc(d.model || '')} · ${title}${face && face.pages > 1 ? ` · ${face.page + 1}/${face.pages}` : ''}${d.paintError ? ` · ${esc(d.paintError)}` : ''}</small></div>
        ${picks(d)}
        ${face ? grid(d, face, cols, rows) : '<p class="note small">Scan USB after the Elgato app is quit.</p>'}
      </article>`;
    }).join('');
    root.innerHTML = cards || '<p class="note small">Nothing is connected over USB.</p>';
  }

  async function load() {
    view = await api('GET', '/api/decks');
    render();
  }

  document.querySelector('#btnDeckScan')?.addEventListener('click', () => run(api('POST', '/api/decks/refresh').then((v) => { view = v; render(); toast('Scanned USB'); })));

  root.addEventListener('click', (ev) => {
    const assign = ev.target.closest('[data-assign]');
    if (assign) {
      const deviceId = assign.dataset.assign;
      const system = assign.dataset.system || null;
      run(api('POST', '/api/decks/assign', { deviceId, system: system || null }).then((r) => {
        const d = devices().find((x) => x.id === deviceId);
        if (d && r && r.face) d.face = r.face;
        render();
      }));
      return;
    }
    const key = ev.target.closest('[data-col]');
    if (!key) return;
    const deviceId = key.dataset.device;
    run(api('POST', '/api/decks/press', { deviceId, col: Number(key.dataset.col), row: Number(key.dataset.row) }).then((r) => {
      const d = devices().find((x) => x.id === deviceId);
      if (d && r && r.face) { d.face = r.face; render(); } else return load();
    }));
  });

  load().catch((e) => { if (note) note.textContent = e.message; });
  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 3000);
})();
