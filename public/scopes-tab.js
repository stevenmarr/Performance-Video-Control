// SCOPES tab (and the PTZ → SCOPES shortcut) loads public/scopes.html in a frame,
// sizes it, and posts visible/hidden so the stream stops when left.
// The picker lists mock fixtures and sidecar-pushed NDI feeds. It does not discover NDI.
// Lightning is a mode inside the scopes page, not this tab. TSL tallies are on SYSTEMS.
(function () {
  'use strict';
  const frame = document.getElementById('scopesFrame'); if (!frame) return;
  const paneS = document.getElementById('pane-scopes');
  const hostP = document.getElementById('pscopesHost');
  const ndi = document.getElementById('scopesNdi');
  const mockEl = document.getElementById('ndiMock');
  const sideEl = document.getElementById('ndiSide');
  const status = document.getElementById('ndiStatus');
  const cmds = document.getElementById('ndiCmds');
  const btnRefresh = document.getElementById('btnNdiRefresh');

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let selected = '';
  try { selected = localStorage.getItem('cc.scopes.src') || ''; } catch { /* */ }
  if (cmds) {
    cmds.textContent = `node tools/ndi-sidecar.js --list
node tools/ndi-sidecar.js --ndi "NAME" --app ${location.origin}
node tools/ndi-sidecar.js --mock --app ${location.origin}`;
  }

  function highlight(key) {
    selected = key || '';
    for (const b of document.querySelectorAll('#scopesNdi .ndi-src')) b.setAttribute('aria-pressed', String(b.dataset.key === selected));
  }
  function select(key) {
    highlight(key);
    try { localStorage.setItem('cc.scopes.src', key); } catch { /* */ }
    if (!frame.getAttribute('src')) frame.src = `/scopes.html?embed=1&prefer=ndi&src=${encodeURIComponent(key)}`;
    else { try { frame.contentWindow.postMessage({ type: 'scopes', src: key }, location.origin); } catch { /* */ } }
  }
  function buttons(sources) {
    return sources.map((s) => `<button type="button" class="btn mini ndi-src" data-key="${esc(s.key)}" data-via="${esc(s.via || '')}" data-ok="${s.ok ? '1' : '0'}" aria-pressed="${s.key === selected ? 'true' : 'false'}">${esc(s.label)}</button>`).join('');
  }
  async function refresh() {
    if (!mockEl || !sideEl) return;
    let r; try { r = await fetch('/api/scopes/ndi').then((x) => x.json()); } catch { return; }
    const sources = r.sources || [];
    const mocks = sources.filter((s) => s.via === 'mock');
    const sides = sources.filter((s) => s.via === 'sidecar');
    mockEl.innerHTML = mocks.length ? buttons(mocks) : (r.mock
      ? '<p class="ndi-empty">--mock is on, but no fixture clips were found next to the app.</p>'
      : '<p class="ndi-empty">No fixture clips in this list. They appear only when the app is started with <code>node server.js --mock</code>. This list cannot invent one.</p>');
    sideEl.innerHTML = sides.length ? buttons(sides) : `<p class="ndi-empty">No sidecar is pushing a feed. On a Mac, <code>node tools/ndi-sidecar.js --list</code> prints discovered names, then <code>--ndi "NAME"</code> receives one. A name you have not received does not show up here.</p>`;
    if (status) {
      const mockLine = r.mock ? `Mock mode: ${mocks.length} fixture${mocks.length === 1 ? '' : 's'} listed.` : 'Mock mode is off, so fixture clips are not listed.';
      const sideLine = sides.some((s) => s.ok) ? `${sides.filter((s) => s.ok).length} sidecar feed${sides.filter((s) => s.ok).length === 1 ? '' : 's'} connected.` : 'No sidecar is connected.';
      const host = r.pi ? 'This host looks like a Pi. NDI receive stays on a Mac.' : (r.ndiReceiveAllowed ? 'This Mac can run the receive sidecar.' : 'NDI receive runs on a Mac sidecar. This app only relays H.264.');
      status.textContent = `${mockLine} ${sideLine} ${host} Ingest is ${r.ingest === 'lan' ? 'open to the LAN (RS6_NDI_INGEST_LAN).' : 'loopback only.'} This list is not an NDI finder.`;
    }
  }
  if (ndi) ndi.addEventListener('click', (ev) => { const b = ev.target.closest('.ndi-src'); if (b) select(b.dataset.key); });
  if (btnRefresh) btnRefresh.addEventListener('click', () => { refresh(); });
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
  const isScopes = (t) => t === 'scopes' || t === 'pscopes';

  function place(tab) {
    if (tab === 'pscopes' && hostP && frame.parentElement !== hostP) hostP.appendChild(frame);
    if (tab === 'scopes' && paneS && frame.parentElement !== paneS) paneS.appendChild(frame);
    if (ndi) ndi.hidden = tab !== 'scopes';
  }

  function show(tab) {
    place(tab);
    if (!frame.getAttribute('src')) frame.src = `/scopes.html?embed=1${tab === 'scopes' ? '&prefer=ndi' : ''}`;
    else if (!open) post(true);
    if (tab === 'scopes') refresh();
    requestAnimationFrame(fit);
    open = true;
  }
  window.addEventListener('cc:tab', (ev) => {
    if (isScopes(ev.detail)) show(ev.detail);
    else if (open) { post(false); open = false; }
  });
  window.addEventListener('resize', fit);
  // sys.js may have selected the tab before this file loaded (a /#scopes or /#lightning deep link).
  if (document.body.classList.contains('tab-scopes')) show('scopes');
  else if (document.body.classList.contains('tab-pscopes')) show('pscopes');
})();
