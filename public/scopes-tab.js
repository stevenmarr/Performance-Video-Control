// 0.12.0 PTZ → SCOPES tab: loads public/scopes.html in a frame the first time the tab opens, sizes it to the window,
// and tells it when the tab is hidden so the stream stops (camera stream slot + Pi bandwidth) and resumes on return.
(function () {
  'use strict';
  const frame = document.getElementById('scopesFrame'); if (!frame) return;
  const pane = document.getElementById('pane-pscopes');
  const fit = () => { if (pane.hidden) return; const top = frame.getBoundingClientRect().top; frame.style.height = `${Math.max(320, window.innerHeight - top - 10)}px`; };
  const post = (visible) => { try { frame.contentWindow && frame.contentWindow.postMessage({ type: 'scopes', visible }, location.origin); } catch { /* */ } };
  let open = false;
  window.addEventListener('cc:tab', (ev) => {
    const on = ev.detail === 'pscopes';
    if (on) { if (!frame.src) frame.src = '/scopes.html?embed=1'; else if (!open) post(true); requestAnimationFrame(fit); }
    else if (open) post(false);
    open = on;
  });
  window.addEventListener('resize', fit);
})();
