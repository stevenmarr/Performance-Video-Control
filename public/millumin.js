'use strict';
// 0.9.4 Millumin tabs: COLUMNS (launch / stop / next / previous, play / pause, go to time, fullscreen, test card)
// and LAYER (select a layer, start / pause / stop its media, opacity). Millumin speaks OSC only, so the page shows
// the last command sent; a column name appears when Millumin's "send feedback" is on. Every action is
// POST /api/sys/millumin/cmd/<name>.
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  let V = null;
  const cmd = (name, body = {}) => run(api('POST', `/api/sys/millumin/cmd/${name}`, body));
  const live = () => V && V.kind === 'millumin' && V.status && V.status.connected;
  const arg = (v) => (/^\d+$/.test(v) ? Number(v) : v);

  function render() {
    const off = !live();
    $('#mlInfo').textContent = off ? (V && V.status && V.status.error ? `not connected · ${V.status.error}` : 'not connected · set its IP on ⌂ SYSTEMS (OSC port 5000)') : 'OSC · feedback updates the column when Millumin sends it';
    const col = V.columnName || (V.column != null ? V.column : '—');
    S.set($('#mlNow'), 'ml-now', off ? '' : `<span class="lg ${V.running ? 'pgm' : 'pvw'}">${V.running ? 'RUN' : 'STOP'}</span> ${esc(String(col))}${V.board != null ? ` · ${esc(String(V.board))}` : ''}`);
    $('#mlLayerNow').textContent = off ? 'Not connected.' : `Layer ${V.layer == null ? '—' : V.layer}${V.media != null ? ` · media ${V.media}` : ''}${V.opacity != null ? ` · opacity ${V.opacity}` : ''}${V.fullscreen ? ' · fullscreen' : ''}${V.testCard ? ' · test card' : ''}`;
    document.querySelectorAll('#pane-mlcol [data-ml], #pane-mllayer [data-ml]').forEach((b) => { b.disabled = off; });
  }
  S.onRender((v, tab) => { V = v; if (!V || V.kind !== 'millumin') return; if (tab === 'mlcol' || tab === 'mllayer') render(); });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('#pane-mlcol [data-ml], #pane-mllayer [data-ml]'); if (!b || !live()) return;
    cmd(b.dataset.ml);
  });
  $('#mlLaunch').addEventListener('submit', (ev) => {
    ev.preventDefault(); if (!live()) return;
    const v = ev.target.elements.column.value.trim(); if (!v) return toast('Name a column, or give its index', true);
    cmd(ev.submitter && ev.submitter.value === 'toggle' ? 'launchOrStopColumn' : 'launchColumn', { value: arg(v) });
  });
  $('#mlTime').addEventListener('submit', (ev) => {
    ev.preventDefault(); if (!live()) return;
    const n = Number(ev.target.elements.time.value); if (!Number.isFinite(n) || n < 0) return toast('Time is seconds, 0 or more', true);
    cmd('goToTime', { value: n });
  });
  $('#mlLayer').addEventListener('submit', (ev) => {
    ev.preventDefault(); if (!live()) return;
    const which = ev.submitter && ev.submitter.value;
    const v = ev.target.elements[which].value.trim(); if (!v) return toast(`Give a ${which} index or name`, true);
    cmd(which === 'board' ? 'selectBoard' : 'selectLayer', { value: arg(v) });
  });
  $('#mlMedia').addEventListener('submit', (ev) => {
    ev.preventDefault(); if (!live()) return;
    const v = ev.target.elements.media.value.trim();
    cmd('startMedia', v ? { value: arg(v) } : {});
  });
  $('#mlOpacity').addEventListener('submit', (ev) => {
    ev.preventDefault(); if (!live()) return;
    const n = Number(ev.target.elements.opacity.value); if (!(n >= 0 && n <= 1)) return toast('Opacity is 0 to 1', true);
    cmd('opacity', { value: n });
  });
})();
