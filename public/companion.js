'use strict';
// 0.9.0 SYSTEMS › COMPANION PAGES: pick Stream Deck surfaces and download .companionconfig files with ready-made pages
(function () {
  const $ = (s) => document.querySelector(s);
  const box = $('#ccPages'); if (!box) return;
  const picked = new Set(JSON.parse(localStorage.getItem('ccSurfaces') || '["xl"]'));
  let info = null;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const msg = (t, err) => { const m = $('#ccMsg'); m.textContent = t || ''; m.classList.toggle('err', !!err); };

  // a little picture of the surface: keys, then the touch strip and knobs under their columns
  function shape(s) {
    const cells = [];
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) cells.push('<i></i>');
    if (s.knobs) {
      const kc = s.id === 'plusxl' ? [0, 2, 3, 5, 6, 8] : [0, 1, 2, 3];
      for (const cls of ['strip', 'knob']) for (let c = 0; c < s.cols; c++) cells.push(`<i class="${kc.includes(c) ? cls : 'none'}"></i>`);
    }
    return `<div class="cc-grid" style="grid-template-columns:repeat(${s.cols},10px)">${cells.join('')}</div>`;
  }

  function render() {
    const el = $('#ccSurfaces');
    if (!info) { el.innerHTML = ''; return; }
    el.innerHTML = info.surfaces.map((s) => `<label class="cc-surface${picked.has(s.id) ? ' on' : ''}" data-id="${esc(s.id)}">
      <input type="checkbox" ${picked.has(s.id) ? 'checked' : ''}>
      <div><div class="cc-name">${esc(s.label)}</div>
      <div class="cc-meta">${s.cols}×${s.rows} keys${s.knobs ? `, touch strip, ${s.knobs} knobs` : ''} · ${s.pages.length} pages</div>
      ${s.warnings.length ? `<div class="cc-meta">${s.warnings.map(esc).join('<br>')}</div>` : ''}
      ${shape(s)}</div></label>`).join('');
    el.querySelectorAll('.cc-surface').forEach((card) => card.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) picked.add(card.dataset.id); else picked.delete(card.dataset.id);
      localStorage.setItem('ccSurfaces', JSON.stringify([...picked])); card.classList.toggle('on', e.target.checked);
    }));
    msg(info.systems.length ? `Systems: ${info.systems.map((s) => s.toUpperCase()).join(', ')}` : 'No configured system yet', !info.systems.length);
  }

  async function load() {
    try {
      const r = await fetch('/api/companion/pages', { cache: 'no-store' });
      info = await r.json(); if (!r.ok) throw new Error(info.error || r.statusText);
      render();
    } catch (e) { msg(`Could not read the page plan: ${e.message}`, true); }
  }

  async function download() {
    const list = info ? info.surfaces.map((s) => s.id).filter((id) => picked.has(id)) : [];
    if (!list.length) { msg('Tick at least one surface', true); return; }
    const q = new URLSearchParams();
    const host = $('#ccHost').value.trim(); const port = $('#ccPort').value.trim(); const label = $('#ccLabel').value.trim();
    if (host) q.set('host', host); if (port) q.set('port', port); if (label) q.set('label', label);
    const groups = $('#ccCombined').checked ? [list] : list.map((x) => [x]);
    try {
      for (const g of groups) {
        const p = new URLSearchParams(q); p.set('surfaces', g.join(',')); if (g.length > 1) p.set('combined', '1');
        const r = await fetch(`/api/companion/pages/file?${p}`, { cache: 'no-store' });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
        const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'control-center.companionconfig';
        const url = URL.createObjectURL(await r.blob());
        const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      msg(`Downloaded ${groups.length} file${groups.length > 1 ? 's' : ''}`);
    } catch (e) { msg(`Download failed: ${e.message}`, true); }
  }

  const h = location.hostname;
  $('#ccHost').value = h === 'localhost' || h === '' ? '127.0.0.1' : h;
  $('#ccPort').value = location.port || (location.protocol === 'https:' ? '443' : '80');
  $('#ccDownload').addEventListener('click', download);
  $('#ccRefresh').addEventListener('click', load);
  document.querySelectorAll('[data-tab="system"], #btnSystem').forEach((b) => b.addEventListener('click', () => setTimeout(load, 50)));
  load();
})();
