/* Help tips. Reads the title (or data-tip) already on a control and shows it
   at once on hover or keyboard focus. Does not change what the control does.
   The title attribute is put back as soon as the tip hides, so the page source
   and any later reader still see it. */
(function () {
  'use strict';
  let tip = null;
  let host = null;
  let timer = null;
  let stashed = null;

  function node() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'cc-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  function textOf(el) {
    if (!el || !el.getAttribute) return '';
    return (el.getAttribute('data-tip') || el.getAttribute('title') || '').trim();
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    if (stashed) {
      stashed.el.setAttribute('title', stashed.title);
      stashed = null;
    }
    host = null;
    if (tip) tip.hidden = true;
  }

  function place(el) {
    const text = textOf(el);
    if (!text) return;
    if (el.getAttribute('title')) {
      stashed = { el: el, title: el.getAttribute('title') };
      el.removeAttribute('title');
    }
    const box = node();
    box.textContent = text;
    box.hidden = false;
    const r = el.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  function fromEvent(ev) {
    const t = ev.target;
    if (!t || !t.closest) return null;
    return t.closest('[title], [data-tip]');
  }

  document.addEventListener('pointerover', (ev) => {
    const el = fromEvent(ev);
    if (!el || el === host) return;
    hide();
    host = el;
    timer = setTimeout(() => { if (host === el) place(el); }, 280);
  });
  document.addEventListener('pointerout', (ev) => {
    if (!host) return;
    const to = ev.relatedTarget;
    if (to && host.contains && host.contains(to)) return;
    hide();
  });
  document.addEventListener('focusin', (ev) => {
    const el = fromEvent(ev);
    if (!el) return;
    hide();
    host = el;
    place(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
  document.addEventListener('scroll', hide, true);

  window.CCUI = {
    empty: function (msg) {
      return '<div class="cc-empty" role="status">' + String(msg == null ? '' : msg) + '</div>';
    },
    status: function (kind, label) {
      const k = kind === 'ok' || kind === 'warn' || kind === 'bad' ? kind : 'idle';
      return '<span class="cc-status cc-status-' + k + '">' + String(label == null ? '' : label) + '</span>';
    }
  };
})();
