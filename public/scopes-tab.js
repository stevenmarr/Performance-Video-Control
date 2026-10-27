// SCOPES tab (and the PTZ → SCOPES shortcut) loads public/scopes.html in a frame,
// sizes it, and posts visible/hidden so the stream stops when left.
// Desktop Video is the live source. Empty legacy NDI is omitted. No mock-fixture group.
// Lightning is a mode inside the scopes page. TSL tallies are on the ATEM page.
(function () {
  'use strict';
  const frame = document.getElementById('scopesFrame'); if (!frame) return;
  const paneS = document.getElementById('pane-scopes');
  const hostP = document.getElementById('pscopesHost');
  const ndi = document.getElementById('scopesNdi');
  const deckEl = document.getElementById('ndiDeck');
  const sideEl = document.getElementById('ndiSide');
  const sideBlock = document.getElementById('ndiSideBlock');
  const status = document.getElementById('ndiStatus');
  const cmds = document.getElementById('ndiCmds');
  const btnRefresh = document.getElementById('btnNdiRefresh');

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let selected = '';
  try { selected = localStorage.getItem('cc.scopes.src') || ''; } catch { /* */ }
  if (cmds) {
    cmds.textContent = `node tools/decklink-sidecar.js --list
node tools/decklink-sidecar.js --device 0 --app ${location.origin}`;
  }

  function highlight(key) {
    selected = key || '';
    for (const b of document.querySelectorAll('#scopesNdi .ndi-src')) b.setAttribute('aria-pressed', String(b.dataset.key === selected));
  }
  function select(key) {
    highlight(key);
    try { localStorage.setItem('cc.scopes.src', key); } catch { /* */ }
    if (!frame.getAttribute('src')) frame.src = `/scopes.html?embed=1&prefer=live&src=${encodeURIComponent(key)}`;
    else { try { frame.contentWindow.postMessage({ type: 'scopes', src: key }, location.origin); } catch { /* */ } }
  }
  function buttons(sources) {
    return sources.map((s) => `<button type="button" class="btn mini ndi-src" data-key="${esc(s.key)}" data-via="${esc(s.via || '')}" data-ok="${s.ok ? '1' : '0'}" aria-pressed="${s.key === selected ? 'true' : 'false'}">${esc(s.label)}</button>`).join('');
  }
  async function refresh() {
    if (!deckEl) return;
    let r; try { r = await fetch('/api/scopes/ndi').then((x) => x.json()); } catch { return; }
    const sources = (r.sources || []).filter((s) => s.via !== 'mock' && !String(s.key || '').startsWith('ndi:mock-'));
    const decks = sources.filter((s) => s.via === 'decklink');
    const sides = sources.filter((s) => s.via === 'sidecar');
    deckEl.innerHTML = decks.length
      ? buttons(decks)
      : '<p class="ndi-empty">No Desktop Video input on this Mac. Build the helper once, then this list fills itself.</p>';
    if (sideBlock) sideBlock.hidden = !sides.length;
    if (sideEl) sideEl.innerHTML = sides.length ? buttons(sides) : '';
    if (status) {
      const nOk = decks.filter((s) => s.ok).length;
      const deckLine = nOk ? `${nOk} Desktop Video input${nOk === 1 ? '' : 's'}.` : (r.decklinkError || 'No Desktop Video input.');
      const sideOk = sides.filter((s) => s.ok).length;
      const sideLine = sides.length ? (sideOk ? ` ${sideOk} legacy NDI feed connected.` : ' A legacy NDI sidecar is listed but not sending.') : '';
      const host = r.pi
        ? 'This host looks like a Pi. Desktop Video capture stays on a Mac.'
        : (r.decklinkReceiveAllowed ? 'This Mac can run the Desktop Video sidecar.' : 'Desktop Video capture runs on a Mac sidecar. This app only relays H.264.');
      status.textContent = `${deckLine}${sideLine} ${host} Ingest is ${r.ingest === 'lan' ? 'open to the LAN (RS6_NDI_INGEST_LAN).' : 'loopback only.'}`;
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
    if (!frame.getAttribute('src')) frame.src = `/scopes.html?embed=1${tab === 'scopes' ? '&prefer=live' : ''}`;
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
