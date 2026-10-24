// Lightning tab (and PTZ → SCOPES shortcut) loads public/scopes.html in a frame.
// Lightning's job is NDI ingest → the existing WebGL scopes. The frame is sized here,
// and visible/hidden stops the stream when the operator leaves the tab.
(function () {
  'use strict';
  const frame = document.getElementById('scopesFrame'); if (!frame) return;
  const paneL = document.getElementById('pane-lightning');
  const paneP = document.getElementById('pane-pscopes');
  const hostP = document.getElementById('pscopesHost');
  const ndi = document.getElementById('lightningNdi');
  const btnNdi = document.getElementById('btnLightningNdi');
  const sel = document.getElementById('ndiSource');
  const status = document.getElementById('ndiStatus');
  const btnUse = document.getElementById('btnNdiUse');
  if (btnNdi && ndi) btnNdi.addEventListener('click', () => { ndi.hidden = !ndi.hidden; });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const fit = () => {
    const pane = frame.closest('.pane');
    if (!pane || pane.hidden) return;
    const top = frame.getBoundingClientRect().top;
    frame.style.height = `${Math.max(320, window.innerHeight - top - 10)}px`;
  };
  const post = (msg) => { try { frame.contentWindow && frame.contentWindow.postMessage({ type: 'scopes', ...msg }, location.origin); } catch { /* */ } };
  let open = false;
  let poll = null;
  const isScopes = (t) => t === 'lightning' || t === 'pscopes';

  async function refreshNdi() {
    if (!sel) return;
    let j;
    try { j = await (await fetch('/api/scopes/ndi')).json(); } catch (e) { if (status) status.textContent = 'NDI list unavailable'; return; }
    const cur = sel.value;
    const list = j.sources || [];
    sel.innerHTML = list.map((s) => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('') || '<option value="">No NDI source yet</option>';
    if (list.some((s) => s.key === cur)) sel.value = cur;
    else if (list[0]) sel.value = list[0].key;
    if (status) {
      if (!list.length) status.textContent = 'Waiting for the Mac sidecar';
      else if (list.some((s) => s.mock)) status.textContent = 'Mock frame source (no NDI hardware)';
      else status.textContent = `${list.length} NDI ingest${list.length === 1 ? '' : 's'}`;
    }
  }

  function useFeed() {
    const key = sel && sel.value;
    if (!key) return;
    const q = `/scopes.html?embed=1&lightning=1&prefer=ndi&src=${encodeURIComponent(key)}`;
    if (!frame.getAttribute('src')) frame.src = q;
    else post({ src: key, visible: true });
  }
  if (btnUse) btnUse.addEventListener('click', useFeed);

  function place(tab) {
    if (tab === 'pscopes' && hostP && frame.parentElement !== hostP) hostP.appendChild(frame);
    if (tab === 'lightning' && paneL && frame.parentElement !== paneL) paneL.appendChild(frame);
  }

  window.addEventListener('cc:tab', (ev) => {
    const on = isScopes(ev.detail);
    const lightning = ev.detail === 'lightning';
    if (on) {
      place(ev.detail);
      if (!frame.getAttribute('src')) frame.src = `/scopes.html?embed=1${lightning ? '&lightning=1&prefer=ndi' : ''}`;
      else if (!open) post({ visible: true });
      requestAnimationFrame(fit);
    } else if (open) post({ visible: false });
    open = on;
    clearInterval(poll); poll = null;
    if (lightning) { refreshNdi(); poll = setInterval(refreshNdi, 2000); }
  });
  window.addEventListener('resize', fit);
})();
