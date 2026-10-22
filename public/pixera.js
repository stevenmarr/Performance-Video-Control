'use strict';
// 0.9.4 AV Stumpfl Pixera tabs: TIMELINES (play / pause / stop / toggle per timeline) and CUES (next / previous cue,
// apply a cue by name). State comes from public/sys.js (window.CCSYS); every action is POST /api/sys/pixera/cmd/<name>.
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  let V = null;
  const cmd = (name, body = {}) => run(api('POST', `/api/sys/pixera/cmd/${name}`, body));
  const live = () => V && V.kind === 'pixera' && V.status && V.status.connected;
  const selected = () => (V && V.timelines || []).find((t) => t.selected) || (V && V.timelines || [])[0] || null;

  function renderTimelines() {
    const off = !live();
    const info = (V && V.status && V.status.info) || {};
    $('#pxInfo').textContent = off ? (V && V.status && V.status.error ? `not connected · ${V.status.error}` : 'not connected · set its IP on ⌂ SYSTEMS')
      : `${info.model || 'Pixera'}${info.version ? ` · API ${info.version}` : ''} · ${(V.timelines || []).length} timeline${V.timelines.length === 1 ? '' : 's'}`;
    const rows = (V.timelines || []).map((t) => `<div class="media-row ${t.selected ? 'on' : ''}" data-px="${t.handle}">
      <button class="tl-name" data-pxsel="${t.handle}" type="button"><b>${esc(t.name)}</b><small>${t.fps ? `${t.fps} fps` : 'timeline'} · handle ${t.handle}</small></button>
      <span class="tl-state">${esc(t.transport || '—')}${t.cue ? ` · ${esc(t.cue)}` : ''}</span>
      <span class="tl-transport"><button class="btn mini ${t.transport === 'play' ? 'primary' : ''}" data-pxmode="play" data-px="${t.handle}" type="button">▶</button>
        <button class="btn mini ${t.transport === 'pause' ? 'primary' : ''}" data-pxmode="pause" data-px="${t.handle}" type="button">❚❚</button>
        <button class="btn mini ${t.transport === 'stop' ? 'primary' : ''}" data-pxmode="stop" data-px="${t.handle}" type="button">■</button>
        <button class="btn mini" data-pxmode="toggle" data-px="${t.handle}" type="button">⏯</button></span></div>`).join('');
    S.set($('#pxList'), 'px-list', rows || `<div class="note">${off ? 'Not connected. Set the Pixera IP on ⌂ SYSTEMS (API port 1400).' : 'Pixera reports no timelines.'}</div>`);
  }
  function renderCues() {
    const tl = selected();
    $('#pxCueInfo').textContent = tl ? tl.name : 'no timeline selected';
    S.set($('#pxCueTl'), 'px-cuetl', (V.timelines || []).map((t) => `<button class="mode ${tl && tl.handle === t.handle ? 'active' : ''}" data-pxsel="${t.handle}" type="button">${esc(t.name)}</button>`).join(''));
    $('#pxCueNow').textContent = tl ? `Now: ${tl.transport || '—'}${tl.cue ? ` · last cue ${tl.cue}` : ''}` : '';
    for (const id of ['#pxPrev', '#pxNext']) $(id).disabled = !tl;
    const fm = $('#pxApply'); if (tl && document.activeElement !== fm.elements.timeline && !fm.elements.timeline.value) fm.elements.timeline.placeholder = tl.name;
  }
  S.onRender((v, tab) => {
    V = v; if (!V || V.kind !== 'pixera') return;
    if (tab === 'pxplay') renderTimelines(); else if (tab === 'pxcues') renderCues();
  });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('#pane-pxplay button, #pane-pxcues button'); if (!b) return;
    if (b.dataset.pxsel !== undefined) { if (live()) cmd('select', { handle: Number(b.dataset.pxsel) }); return; }
    if (!live()) return;
    if (b.dataset.pxmode) return cmd('transport', { handle: Number(b.dataset.px), mode: b.dataset.pxmode });
    if (b.id === 'pxNext' || b.id === 'pxPrev') { const tl = selected(); if (!tl) return; return cmd(b.id === 'pxNext' ? 'nextCue' : 'prevCue', { handle: tl.handle, ignore: $('#pxIgnore').checked }); }
    return undefined;
  });
  $('#pxRefresh').addEventListener('click', () => { if (live()) cmd('refresh'); });
  $('#pxApply').addEventListener('submit', (ev) => {
    ev.preventDefault(); if (!live()) return;
    const fm = ev.target; const timeline = fm.elements.timeline.value.trim(); const cue = fm.elements.cue.value.trim();
    if (!timeline || !cue) return toast('A cue needs a timeline name and a cue name', true);
    const body = { timeline, cue }; const blend = fm.elements.blend.value; if (blend !== '') body.blend = Number(blend);
    cmd('applyCue', body).then(() => { fm.elements.cue.value = ''; });
  });
})();
