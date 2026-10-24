// 0.12.0 / 0.13.0-dev: Lightning tab (and PTZ → SCOPES shortcut) loads public/scopes.html in a frame,
// sizes it, and posts visible/hidden so the stream stops when left.
(function () {
  'use strict';
  const frame = document.getElementById('scopesFrame'); if (!frame) return;
  const paneL = document.getElementById('pane-lightning');
  const paneP = document.getElementById('pane-pscopes');
  const hostP = document.getElementById('pscopesHost');
  const ndi = document.getElementById('lightningNdi');
  const btnNdi = document.getElementById('btnLightningNdi');
  if (btnNdi && ndi) btnNdi.addEventListener('click', () => { ndi.hidden = !ndi.hidden; });

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
  }

  window.addEventListener('cc:tab', (ev) => {
    const on = isScopes(ev.detail);
    if (on) {
      place(ev.detail);
      if (!frame.src) frame.src = '/scopes.html?embed=1' + (ev.detail === 'lightning' ? '&lightning=1' : '');
      else if (!open) post(true);
      requestAnimationFrame(fit);
    } else if (open) post(false);
    open = on;
  });
  window.addEventListener('resize', fit);
})();
