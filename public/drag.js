'use strict';
// 0.11.0 shared pointer-event drag helper (mouse, pen and touch): used by the ATEM ROUTER (drag a source onto an output),
// the ATEM AUDIO monitor (drag a channel strip into the monitor area) and the PTZ dashboard (drag panels to reorder).
// Mouse / pen: the drag starts once the pointer moves a few pixels. Touch: press and hold (≈250 ms) without moving,
// then drag — a quick swipe still scrolls the page. The click that follows a drag is swallowed.
//   CCDRAG.attach(root, { handle, start(el, e) → payload | null, target(elUnderPointer, payload) → drop el | null,
//                         drop(dropEl, payload, e), begin(payload), end(payload), ghost(el, payload) → html, hold, threshold })
(() => {
  let active = null; // the one drag in progress
  const css = document.createElement('style');
  css.textContent = '.cc-ghost{position:fixed;z-index:9999;pointer-events:none;transform:translate(-50%,-120%);padding:6px 10px;border-radius:8px;background:#d4a017;color:#111;font:800 13px/1.2 system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.5);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}'
    + 'body.cc-dragging,body.cc-dragging *{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important}.cc-drop-hover{outline:3px solid #ffd35c!important;outline-offset:1px}.cc-drag-src{opacity:.55}.cc-pending{transform:scale(.97);transition:transform .15s}';
  document.head.appendChild(css);
  const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
  function stop(commit, e) {
    const a = active; if (!a) return; active = null;
    clearTimeout(a.timer); window.removeEventListener('pointermove', a.move, true); window.removeEventListener('pointerup', a.up, true); window.removeEventListener('pointercancel', a.cancel, true);
    document.removeEventListener('keydown', a.key, true); document.removeEventListener('touchmove', a.touch, { capture: true }); document.removeEventListener('contextmenu', swallow, true);
    a.el.classList.remove('cc-pending', 'cc-drag-src');
    if (!a.dragging) return;
    if (a.ghost) a.ghost.remove(); document.body.classList.remove('cc-dragging');
    if (a.over) a.over.classList.remove('cc-drop-hover');
    // swallow the click the browser fires after pointerup on the dragged element
    window.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => window.removeEventListener('click', swallow, true), 60);
    try { if (commit && a.over) a.o.drop(a.over, a.payload, e); } finally { if (a.o.end) a.o.end(a.payload); }
  }
  function attach(root, o) {
    const hold = o.hold === undefined ? 250 : o.hold; const thr = o.threshold || 5;
    root.addEventListener('pointerdown', (e) => {
      if (active || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const el = e.target.closest(o.handle); if (!el || !root.contains(el)) return;
      if (e.target.closest('input,select,textarea') && !el.matches('input,select,textarea')) return;
      const payload = o.start(el, e); if (payload === null || payload === undefined) return;
      const touch = e.pointerType === 'touch';
      const a = active = { el, o, payload, x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false, over: null, ghost: null, timer: 0 };
      const begin = (x, y) => {
        a.dragging = true; el.classList.remove('cc-pending'); el.classList.add('cc-drag-src'); document.body.classList.add('cc-dragging');
        const g = document.createElement('div'); g.className = 'cc-ghost'; g.innerHTML = o.ghost ? o.ghost(el, payload) : el.textContent.trim(); document.body.appendChild(g); a.ghost = g;
        if (navigator.vibrate && touch) try { navigator.vibrate(15); } catch { /* ignore */ }
        if (o.begin) o.begin(payload); place(x, y);
      };
      const place = (x, y) => {
        a.ghost.style.left = `${x}px`; a.ghost.style.top = `${y}px`;
        const under = document.elementFromPoint(x, y); const t = under ? o.target(under, payload) : null;
        if (t !== a.over) { if (a.over) a.over.classList.remove('cc-drop-hover'); a.over = t || null; if (a.over) a.over.classList.add('cc-drop-hover'); }
        if (o.over) o.over(a.over, payload, x, y);
      };
      a.move = (ev) => {
        if (ev.pointerId !== a.id) return;
        const d = Math.hypot(ev.clientX - a.x, ev.clientY - a.y);
        if (!a.dragging) { if (touch) { if (d > 10) stop(false); return; } if (d < thr) return; begin(ev.clientX, ev.clientY); }
        ev.preventDefault(); place(ev.clientX, ev.clientY);
      };
      a.up = (ev) => { if (ev.pointerId === a.id) stop(true, ev); };
      a.cancel = (ev) => { if (ev.pointerId === a.id) stop(false, ev); };
      a.key = (ev) => { if (ev.key === 'Escape' && a.dragging) { ev.preventDefault(); stop(false, ev); } };
      a.touch = (ev) => { if (a.dragging) ev.preventDefault(); };
      window.addEventListener('pointermove', a.move, true); window.addEventListener('pointerup', a.up, true); window.addEventListener('pointercancel', a.cancel, true);
      document.addEventListener('keydown', a.key, true); document.addEventListener('touchmove', a.touch, { capture: true, passive: false });
      if (touch) { document.addEventListener('contextmenu', swallow, true); el.classList.add('cc-pending'); a.timer = setTimeout(() => { if (active === a && !a.dragging) begin(a.x, a.y); }, hold); }
    });
  }
  window.CCDRAG = { attach, active: () => !!(active && active.dragging) };
})();
