// LOOKS: the same memory grid on RS6, E2, Pixelhue and ATEM.
// Recall loads the preset onto preview, then forces each key to the stored on or off.
(function () {
  'use strict';
  const grid = document.getElementById('looksGrid');
  if (!grid) return;
  const SLOTS = 16;
  const KEYS = [
    { id: '0', label: 'KEY 1' }, { id: '1', label: 'KEY 2' }, { id: '2', label: 'KEY 3' }, { id: '3', label: 'KEY 4' },
    { id: 'dsk0', label: 'DSK 1' }, { id: 'dsk1', label: 'DSK 2' },
  ];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));
  const HIRES = [
    { id: 'rs6', label: 'RS6' },
    { id: 'e2', label: 'E2' },
    { id: 'pixelhue', label: 'PIXELHUE' },
  ];
  let system = localStorage.getItem('cc.looksSystem') || 'rs6';
  let looks = [];
  let armed = [];

  function card(n) {
    const id = `${system}-${n}`;
    const look = looks.find((l) => l.id === id);
    const keys = KEYS.map((k) => {
      const saved = look && (look.keys || []).find((x) => x.id === k.id);
      const on = !!(saved && saved.on);
      return `<button type="button" class="look-key ${on ? 'on' : ''}" data-key="${k.id}" data-slot="${n}" aria-pressed="${on ? 'true' : 'false'}">${esc(k.label)} ${on ? 'ON' : 'OFF'}</button>`;
    }).join('');
    return `<article class="look-card ${look ? 'filled' : ''}" data-slot="${n}">
      <header><span class="num">${n}</span><input data-name="${n}" value="${esc(look ? look.name : '')}" placeholder="Look ${n}" aria-label="Look ${n} name"></header>
      <label class="look-preset">PRESET <input data-preset="${n}" value="${esc(look ? look.preset : n)}" inputmode="numeric" aria-label="Preset for look ${n}"></label>
      <div class="look-keys">${keys}</div>
      <div class="look-acts">
        <button type="button" class="btn mini" data-save="${n}">STORE</button>
        <button type="button" class="btn mini primary" data-recall="${n}" ${look ? '' : 'disabled'}>RECALL</button>
      </div>
    </article>`;
  }

  function paint() {
    grid.innerHTML = Array.from({ length: SLOTS }, (_, i) => card(i + 1)).join('');
  }

  function paintSystems() {
    const bar = document.getElementById('looksSystems');
    if (!bar) return;
    const onDesk = HIRES.filter((s) => armed.includes(s.id));
    const list = onDesk.length ? onDesk : HIRES;
    bar.innerHTML = list.map((s) => `<button type="button" class="btn mini${s.id === system ? ' on' : ''}" data-looksys="${s.id}">${s.label}</button>`).join('');
  }

  async function load() {
    try {
      const sys = await fetch('/api/sys').then((r) => r.json());
      armed = sys.armed || [];
    } catch { armed = []; }
    const hi = HIRES.map((s) => s.id).filter((id) => armed.includes(id));
    if (hi.length && !hi.includes(system)) system = hi[0];
    localStorage.setItem('cc.looksSystem', system);
    paintSystems();
    const r = await fetch(`/api/looks?system=${encodeURIComponent(system)}`);
    const j = await r.json();
    looks = j.looks || [];
    paint();
  }

  function draft(n) {
    const name = grid.querySelector(`[data-name="${n}"]`);
    const preset = grid.querySelector(`[data-preset="${n}"]`);
    const keys = [...grid.querySelectorAll(`.look-key[data-slot="${n}"]`)].map((b) => ({
      id: b.dataset.key,
      label: b.textContent.replace(/\s+(ON|OFF)$/, ''),
      on: b.classList.contains('on'),
    }));
    return { id: `${system}-${n}`, name: name ? name.value.trim() : `Look ${n}`, system, preset: preset ? preset.value.trim() : String(n), keys };
  }

  grid.addEventListener('click', async (ev) => {
    const key = ev.target.closest('.look-key');
    if (key) {
      key.classList.toggle('on');
      const on = key.classList.contains('on');
      key.setAttribute('aria-pressed', on ? 'true' : 'false');
      key.textContent = `${key.textContent.replace(/\s+(ON|OFF)$/, '')} ${on ? 'ON' : 'OFF'}`;
      return;
    }
    const save = ev.target.closest('[data-save]');
    const recall = ev.target.closest('[data-recall]');
    if (!save && !recall) return;
    const n = Number((save || recall).dataset.save || (save || recall).dataset.recall);
    const body = draft(n);
    if (save) {
      const r = await fetch('/api/looks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) return;
      await load();
      return;
    }
    await fetch('/api/looks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await fetch(`/api/looks/${encodeURIComponent(body.id)}/recall`, { method: 'POST' });
    await load();
  });

  document.getElementById('looksSystems')?.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-looksys]');
    if (!b) return;
    system = b.dataset.looksys;
    localStorage.setItem('cc.looksSystem', system);
    load().catch(() => paint());
  });
  document.querySelectorAll('[data-tab="looks"]').forEach((b) => b.addEventListener('click', () => setTimeout(load, 30)));
  load().catch(() => paint());
})();
