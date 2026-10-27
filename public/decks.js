/* Control Devices: Stream Decks owned over USB. Home picks one system.
   Press is POST /api/decks/press. Scan is POST /api/decks/refresh. Companion is not this path. */
(() => {
  const root = document.querySelector('#deckRoot');
  if (!root || !window.CC) return;
  const { api, toast, run, esc } = window.CC;
  const note = document.querySelector('#deckPluginNote');
  let view = null;
  let selected = localStorage.getItem('cc.deckUsb') || '';

  const devices = () => (view && view.control && view.control.devices) || [];
  const device = () => devices().find((d) => d.id === selected) || devices()[0] || null;

  function grid(face, columns, rows) {
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const k = (face.keys || []).find((key) => key.row === r && key.col === c);
        const tone = (k && k.tone) || 'blank';
        cells.push(`<button type="button" class="deck-key big tone-${esc(tone)}" data-col="${c}" data-row="${r}" style="grid-column:${c + 1};grid-row:${r + 1}"><small>${esc((k && k.caption) || '')}</small>${esc((k && k.label) || '')}</button>`);
      }
    }
    return `<div class="deck-mini deck-face" style="grid-template-columns:repeat(${columns},minmax(0,1fr));grid-template-rows:repeat(${rows},54px)">${cells.join('')}</div>`;
  }

  function render() {
    const control = (view && view.control) || { devices: [], driver: {} };
    const driver = control.driver || {};
    const live = (control.devices || []).filter((d) => d.transport === 'usb');
    if (note) {
      note.textContent = !driver.installed
        ? (driver.error || 'USB driver is not installed.')
        : (live.length
          ? `${live.length} Stream Deck${live.length === 1 ? '' : 's'} on USB. Home picks the system. The top left key comes back.`
          : 'No Stream Deck on USB yet. The grid is the + XL layout. Quit the Elgato Stream Deck app, then scan.');
    }
    const list = devices();
    if (selected && !list.some((d) => d.id === selected)) selected = '';
    const cur = device();
    if (cur) selected = cur.id;
    const cards = list.map((d) => `<button type="button" class="deck-dev${d.id === selected ? ' on' : ''}" data-select="${esc(d.id)}">
      <b>${esc(d.name || d.model || 'Stream Deck')}</b>
      <small>${esc(d.model || '')} · ${d.online === false ? 'OFFLINE' : 'USB'}</small>
      <small>${esc(d.face ? d.face.title : 'HOME')}${d.face && d.face.pages > 1 ? ` · ${d.face.page + 1}/${d.face.pages}` : ''}</small>
    </button>`).join('');
    const face = cur && cur.face;
    const surface = cur && view.surfaces ? view.surfaces[cur.surfaceId] : null;
    const cols = (surface && surface.cols) || (cur && cur.columns) || 5;
    const rows = (surface && surface.rows) || (cur && cur.rows) || 3;
    root.innerHTML = `<section class="deck-lib">
        <div class="section-title">STREAM DECKS</div>
        <div class="deck-devs">${cards || '<p class="note small">Nothing is connected over USB.</p>'}</div>
      </section>
      <section class="deck-stage">
        <div class="section-title">${face ? esc(face.title) : 'HOME'}</div>
        ${face ? grid(face, cols, rows) : '<p class="note small">Scan USB after the Elgato app is quit.</p>'}
      </section>
      <section>
        <div class="section-title">THIS PAGE</div>
        <p class="note small">${face && face.system ? 'One system fills this deck. Home returns to the device list.' : 'Pick a system. RS6, E2 and Pixelhue memories load the stored look onto preview. They do not toggle a key.'}</p>
        ${face && face.dials && face.dials.length ? `<p class="note small">Knobs, from the left: ${face.dials.map((d) => esc(d.op)).join(', ')}.</p>` : ''}
      </section>`;
  }

  async function load() {
    view = await api('GET', '/api/decks');
    render();
  }

  document.querySelector('#btnDeckScan')?.addEventListener('click', () => run(api('POST', '/api/decks/refresh').then((v) => { view = v; render(); toast('Scanned USB'); })));

  root.addEventListener('click', (ev) => {
    const sel = ev.target.closest('[data-select]');
    if (sel) {
      selected = sel.dataset.select;
      localStorage.setItem('cc.deckUsb', selected);
      render();
      return;
    }
    const key = ev.target.closest('[data-col]');
    const cur = device();
    if (!key || !cur) return;
    run(api('POST', '/api/decks/press', { deviceId: cur.id, col: Number(key.dataset.col), row: Number(key.dataset.row) }).then((r) => {
      if (r && r.face && view && view.control) {
        const d = view.control.devices.find((x) => x.id === cur.id);
        if (d) d.face = r.face;
        render();
      } else return load();
    }));
  });

  load().catch((e) => { if (note) note.textContent = e.message; });
  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 3000);
})();
