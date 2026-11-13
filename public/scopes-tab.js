// SCOPES tab loads public/scopes.html in a frame, sizes it, and posts visible/hidden
// so the stream stops when the operator leaves. Desktop Video, cameras, and test
// clips are chosen inside that page. Lightning is a mode there, not a tab.
// /#pscopes and /#lightning are rewritten to this tab in sys.js.
(function () {
  'use strict';
  const frame = document.getElementById('scopesFrame');
  if (!frame) return;
  const pane = document.getElementById('pane-scopes');
  const fit = () => {
    if (!pane || pane.hidden) return;
    const top = frame.getBoundingClientRect().top;
    frame.style.height = `${Math.max(320, window.innerHeight - top - 10)}px`;
  };
  const post = (visible) => {
    try { frame.contentWindow && frame.contentWindow.postMessage({ type: 'scopes', visible }, location.origin); } catch { /* */ }
  };
  let open = false;
  function show() {
    if (!frame.getAttribute('src')) frame.src = '/scopes.html?embed=1&prefer=live';
    else if (!open) post(true);
    requestAnimationFrame(fit);
    open = true;
  }
  window.addEventListener('cc:tab', (ev) => {
    if (ev.detail === 'scopes') show();
    else if (open) { post(false); open = false; }
  });
  window.addEventListener('resize', fit);
  if (document.body.classList.contains('tab-scopes')) show();
})();
