// Lightning tab (and PTZ → SCOPES shortcut) loads public/scopes.html in a frame,
// sizes it, and posts visible/hidden so the stream stops when left.
// Lightning's own chrome picks an NDI ingest. TSL tallies are not on this tab.
(function () {
  'use strict';
  const frame = document.getElementById('scopesFrame'); if (!frame) return;
  const paneL = document.getElementById('pane-lightning');
  const paneP = document.getElementById('pane-pscopes');
  const hostP = document.getElementById('pscopesHost');
  const ndi = document.getElementById('lightningNdi');
  const btnNdi = document.getElementById('btnLightningNdi');
  const how = document.getElementById('ndiHow');
  const list = document.getElementById('ndiSources');
  const status = document.getElementById('ndiStatus');
  if (btnNdi && how) btnNdi.addEventListener('click', () => { how.hidden = !how.hidden; });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let selected = '';
  try { selected = localStorage.getItem('cc.scopes.src') || ''; } catch { /* */ }

  function highlight(key) {
    selected = key || '';
    if (!list) return;
    for (const b of list.querySelectorAll('.ndi-src')) b.setAttribute('aria-pressed', String(b.dataset.key === selected));
  }
  function select(key) {
    highlight(key);
    try { localStorage.setItem('cc.scopes.src', key); } catch { /* */ }
    if (!frame.getAttribute('src')) frame.src = `/scopes.html?embed=1&lightning=1&prefer=ndi&src=${encodeURIComponent(key)}`;
    else { try { frame.contentWindow.postMessage({ type: 'scopes', src: key }, location.origin); } catch { /* */ } }
  }
  async function refresh() {
    if (!list) return;
    let r; try { r = await fetch('/api/scopes/ndi').then((x) => x.json()); } catch { return; }
    const sources = r.sources || [];
    list.innerHTML = sources.map((s) => `<button type="button" class="btn mini ndi-src" data-key="${esc(s.key)}" data-ok="${s.ok ? '1' : '0'}" aria-pressed="${s.key === selected ? 'true' : 'false'}">${esc(s.label)}</button>`).join('')
      || '<span class="note small">No NDI source yet. Start the app with --mock for fixture frames, or run the Mac sidecar.</span>';
    if (status) {
      const side = r.sidecar ? `${r.sidecar} sidecar feed${r.sidecar === 1 ? '' : 's'}` : 'no sidecar connected';
      const host = r.pi ? 'This host looks like a Pi. NDI receive stays on a Mac.' : (r.ndiReceiveAllowed ? 'This Mac can run the receive sidecar.' : 'NDI receive runs on a Mac sidecar. This app only relays H.264.');
      status.textContent = `${side}. ${host} Ingest is ${r.ingest === 'lan' ? 'open to the LAN (RS6_NDI_INGEST_LAN).' : 'loopback only.'}`;
    }
  }
  if (list) list.addEventListener('click', (ev) => { const b = ev.target.closest('.ndi-src'); if (b) select(b.dataset.key); });
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || !ev.data || ev.data.type !== 'scopes-src') return;
    highlight(ev.data.src);
  });
  refresh();
  setInterval(refresh, 2000);

  const fit = () => {
    const pane = frame.closest('.pane');
    if (!pane || pane.hidden) return;
    const top = frame.getBoundingClientRect().top;
    frame.style.height = `${Math.max(320, window.innerHeight - top - 10)}px`;
  };
  const post = (visible) => { try { frame.contentWindow && frame.contentWindow.postMessage({ type: 'scopes', visible }, location.origin); } catch { /* */ } };
  let open = false;
  const isScopes = (t) => t === 'lightning' || t === 'pscopes';

  function place(tab) {
    if (tab === 'pscopes' && hostP && frame.parentElement !== hostP) hostP.appendChild(frame);
    if (tab === 'lightning' && paneL && frame.parentElement !== paneL) paneL.appendChild(frame);
    if (ndi) ndi.hidden = tab !== 'lightning';
  }

  window.addEventListener('cc:tab', (ev) => {
    const on = isScopes(ev.detail);
    if (on) {
      place(ev.detail);
      if (!frame.src) frame.src = `/scopes.html?embed=1${ev.detail === 'lightning' ? '&lightning=1&prefer=ndi' : ''}`;
      else if (!open) post(true);
      if (ev.detail === 'lightning') refresh();
      requestAnimationFrame(fit);
    } else if (open) post(false);
    open = on;
  });
  window.addEventListener('resize', fit);
})();
