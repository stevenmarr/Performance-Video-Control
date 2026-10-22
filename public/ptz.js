'use strict';
// 0.7.0 Panasonic PTZ tabs: PTZ CONTROL (hold-to-move pan / tilt pad, zoom and focus rockers, speeds, power,
// tally, iris / gain / shutter / white balance), CAM PRESETS (recall / store / rename on a tile grid) and CAMERAS
// (add / edit / remove, live status). Moves are hold-to-run: a move is repeated every 400 ms while held (the
// server stops the camera if the repeats stop), and STOP is sent on release, cancel, page blur and tab change.
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  let V = null; let pmode = 'recall'; let page = Number(localStorage.getItem('cc.ptzPage') || 1) || 1; const PAGE = 24;
  const cmd = (name, body = {}) => api('POST', `/api/sys/ptz/cmd/${name}`, { cam: V && V.selected, ...body });
  const sel = () => (V && V.cameras ? V.cameras.find((c) => c.id === V.selected) : null);

  // ---------- hold to run ----------
  let hold = null; // { kind, body, timer, cam }
  function startHold(kind, body) {
    endHold(false);
    const cam = V && V.selected; if (!cam) return;
    const fire = () => cmd(kind, { ...body, cam }).catch((e) => { toast(e.message, true); endHold(true); });
    hold = { kind, body, cam, timer: setInterval(fire, 400) }; fire();
    document.body.classList.add('ptz-moving');
  }
  function endHold(send = true) {
    if (!hold) return;
    clearInterval(hold.timer); const cam = hold.cam; hold = null;
    document.body.classList.remove('ptz-moving');
    if (send) api('POST', '/api/sys/ptz/cmd/stop', { cam }).catch((e) => toast(e.message, true));
  }
  const holdable = (root, attr, make) => {
    root.addEventListener('pointerdown', (ev) => {
      const b = ev.target.closest(`[${attr}]`); if (!b || !V || !V.selected) return;
      ev.preventDefault(); try { b.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
      b.classList.add('held'); startHold(...make(b));
      const up = () => { b.classList.remove('held'); endHold(true); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up); b.removeEventListener('lostpointercapture', up); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    });
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  holdable($('#ptzPad'), 'data-pt', (b) => { const [p, t] = b.dataset.pt.split(',').map(Number); return ['move', { pan: p, tilt: t }]; });
  holdable($('.ptz-lens'), 'data-zoom', (b) => ['zoom', { dir: Number(b.dataset.zoom) }]);
  holdable($('.ptz-lens'), 'data-focus', (b) => ['focus', { dir: Number(b.dataset.focus) }]);
  window.addEventListener('blur', () => endHold(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) endHold(true); });
  window.addEventListener('cc:tab', () => endHold(true));
  window.addEventListener('pagehide', () => { if (hold) navigator.sendBeacon && navigator.sendBeacon('/api/sys/ptz/cmd/stop', new Blob([JSON.stringify({ cam: hold.cam })], { type: 'application/json' })); });
  // arrow keys: hold to move, release to stop
  const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  document.addEventListener('keydown', (e) => {
    if (window.CC.getTab() !== 'pctl' || e.repeat || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
    if (KEYS[e.key]) { e.preventDefault(); startHold('move', { pan: KEYS[e.key][0], tilt: KEYS[e.key][1] }); }
    else if (e.key === '+' || e.key === '=') startHold('zoom', { dir: 1 }); else if (e.key === '-') startHold('zoom', { dir: -1 });
  });
  document.addEventListener('keyup', (e) => { if (KEYS[e.key] || ['+', '=', '-'].includes(e.key)) endHold(true); });
  $('#ptzPad').addEventListener('click', (ev) => { if (ev.target.closest('[data-home]')) run(cmd('home')); });

  // ---------- render ----------
  const strip = (id) => S.set($(id), id, (V.cameras || []).map((c) => `<button class="cam ${c.id === V.selected ? 'on' : ''} ${c.connected ? '' : 'off'} ${c.tally ? 'tally-r' : ''} ${c.tallyGreen ? 'tally-g' : ''}" data-cam="${esc(c.id)}" type="button">
      <span class="led ${c.connected ? 'ok' : 'off'}"></span><b>${esc(c.name)}</b><small>${esc(c.model || (c.connected ? '' : 'offline'))}${c.power === 'standby' ? ' · STANDBY' : ''}${c.lastPreset ? ` · P${c.lastPreset}` : ''}</small></button>`).join('') || '<div class="note">No cameras. Add them on ⌂ SYSTEMS or the CAMERAS tab.</div>');
  const seg = (id, on) => $(id).classList.toggle('active', !!on);
  const opts = (el, list, cur) => { const h = list.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join(''); if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; } if (document.activeElement !== el && cur !== undefined) el.value = cur; };
  function renderCtl() {
    strip('#ptzStrip');
    const c = sel(); const off = !c || !c.connected;
    document.querySelectorAll('#pane-pctl .ptz-body button, #pane-pctl .ptz-body input, #pane-pctl .ptz-body select').forEach((e) => { e.disabled = off; });
    for (const [k, id] of [['pt', '#spPt'], ['zoom', '#spZoom'], ['focus', '#spFocus']]) { const el = $(id); if (document.activeElement !== el) el.value = V.speeds[k]; $(`${id}V`).textContent = V.speeds[k]; }
    $('#ptzCamInfo').textContent = c ? `${c.name} · ${c.model || '?'}${c.version ? ` · fw ${c.version}` : ''} · ${c.host}${c.connected ? '' : ' · OFFLINE'}` : '';
    if (!c) return;
    seg('#ptzPowerOn', c.power === 'on'); seg('#ptzStandby', c.power === 'standby');
    $('#ptzTallyR').classList.toggle('active', !!c.tally); $('#ptzTallyG').classList.toggle('active', !!c.tallyGreen);
    seg('#ptzAF', c.autoFocus); seg('#ptzAutoIris', c.autoIris);
    const iris = $('#ptzIris'); if (document.activeElement !== iris && c.iris !== undefined) iris.value = c.iris; $('#ptzIrisV').textContent = c.autoIris ? 'AUTO' : (c.iris ?? '—'); iris.disabled = off || !!c.autoIris;
    opts($('#ptzGain'), V.gains, c.gain); opts($('#ptzShutter'), V.shutters, c.shutter); opts($('#ptzWb'), V.whiteBalances, c.wb);
  }
  function renderPresets() {
    strip('#ptzStrip2');
    const c = sel(); const names = (c && c.presetNames) || {};
    const pages = Math.ceil(V.presetCount / PAGE); if (page > pages) page = 1;
    S.set($('#ptzPager'), 'ptz-pager', Array.from({ length: pages }, (_, i) => { const lo = i * PAGE + 1; const hi = Math.min(V.presetCount, (i + 1) * PAGE); const used = Object.keys(names).filter((n) => n >= lo && n <= hi).length; return `<button class="pg ${page === i + 1 ? 'on' : ''}" data-page="${i + 1}">${lo}–${hi}${used ? `<small>${used}</small>` : ''}</button>`; }).join(''));
    let h = '';
    for (let n = (page - 1) * PAGE + 1; n <= Math.min(V.presetCount, page * PAGE); n++) {
      const nm = names[n]; const last = c && c.lastPreset === n;
      h += `<button class="preset ${nm ? '' : 'unnamed'} ${last ? 'pvw is-last' : ''}" data-cp="${n}" ${!c || !c.connected ? 'disabled' : ''}><span class="tags">${last ? '<span class="tag pvw">LAST</span>' : ''}</span><span class="num">${n}</span><span class="name">${esc(nm || '')}</span><span class="chips">${nm ? '' : '<span class="chip">not named</span>'}</span></button>`;
    }
    S.set($('#ptzGrid'), 'ptz-grid', h);
    document.querySelectorAll('[data-pmode]').forEach((b) => b.classList.toggle('active', b.dataset.pmode === pmode));
    $('#ptzModeHint').innerHTML = { recall: '<b>RECALL</b> · tap a tile: the selected camera moves to that preset.', store: '<b>STORE</b> · tap a tile: the camera\'s current position is saved there (asks first; overwrites).', rename: '<b>RENAME</b> · tap a tile to name it (names live in this app and the show file; the camera has no preset names).' }[pmode];
    $('#ptzGrid').className = `grid mode-${pmode === 'recall' ? 'recall' : 'save'}`;
  }
  function renderCams() {
    S.set($('#ptzCamList'), 'ptz-cams', (V.cameras || []).map((c) => `<div class="row cam-line ${c.connected ? '' : 'off'}" data-cam="${esc(c.id)}">
      <span class="led ${c.connected ? 'ok' : 'off'}"></span><span class="lbl">${esc(c.name)}<small>${esc(c.model || 'unknown model')}${c.title ? ` · ${esc(c.title)}` : ''} · ${esc(c.host)}:${esc(c.port)}${c.connected ? '' : ` · ${esc(c.error || 'offline')}`}</small></span>
      <span class="chip">${c.power ? esc(c.power.toUpperCase()) : '—'}</span>${c.tally ? '<span class="chip pgmc">TALLY</span>' : ''}<span class="spacer"></span>
      <button class="btn mini ${c.id === V.selected ? 'primary' : ''}" data-selcam="${esc(c.id)}">${c.id === V.selected ? 'SELECTED' : 'SELECT'}</button>
      <button class="btn mini" data-pw="${esc(c.id)}" data-on="${c.power === 'on' ? 0 : 1}" ${c.connected ? '' : 'disabled'}>${c.power === 'on' ? 'STANDBY' : 'POWER ON'}</button>
      <button class="btn mini" data-edit="${esc(c.id)}">EDIT</button><button class="btn mini danger" data-rm="${esc(c.id)}">REMOVE</button></div>`).join('') || '<div class="note">No cameras yet.</div>');
  }
  S.onRender((v, tab) => {
    V = v; if (!V || V.kind !== 'ptz') { endHold(true); return; }
    if (tab === 'pctl') renderCtl(); else if (tab === 'ppresets') renderPresets(); else if (tab === 'pcams') renderCams();
  });

  // ---------- events ----------
  const pickCam = (ev) => { const b = ev.target.closest('[data-cam]'); if (b && b.dataset.cam !== V.selected) { endHold(true); run(cmd('select', { cam: b.dataset.cam })); } };
  $('#ptzStrip').addEventListener('click', pickCam); $('#ptzStrip2').addEventListener('click', pickCam);
  for (const [id, k] of [['#spPt', 'pt'], ['#spZoom', 'zoom'], ['#spFocus', 'focus']]) {
    $(id).addEventListener('input', () => { $(`${id}V`).textContent = $(id).value; });
    $(id).addEventListener('change', () => run(cmd('speeds', { [k]: Number($(id).value) })));
  }
  $('#ptzAF').addEventListener('click', () => run(cmd('autoFocus', { on: !(sel() || {}).autoFocus })));
  $('#ptzOTAF').addEventListener('click', () => run(cmd('oneTouchAF').then(() => toast('One-touch AF'))));
  $('#ptzAutoIris').addEventListener('click', () => run(cmd('autoIris', { on: !(sel() || {}).autoIris })));
  $('#ptzIris').addEventListener('input', () => { $('#ptzIrisV').textContent = $('#ptzIris').value; });
  $('#ptzIris').addEventListener('change', () => run(cmd('iris', { value: Number($('#ptzIris').value) })));
  $('#ptzGain').addEventListener('change', () => run(cmd('gain', { value: $('#ptzGain').value })));
  $('#ptzShutter').addEventListener('change', () => run(cmd('shutter', { value: $('#ptzShutter').value })));
  $('#ptzWb').addEventListener('change', () => run(cmd('whiteBalance', { value: $('#ptzWb').value })));
  $('#ptzPowerOn').addEventListener('click', () => run(cmd('power', { on: true })));
  $('#ptzStandby').addEventListener('click', () => { const c = sel(); if (c && confirm(`Put ${c.name} in STANDBY?`)) run(cmd('power', { on: false })); });
  $('#ptzTallyR').addEventListener('click', () => run(cmd('tally', { on: !(sel() || {}).tally, color: 'red' })));
  $('#ptzTallyG').addEventListener('click', () => run(cmd('tally', { on: !(sel() || {}).tallyGreen, color: 'green' })));
  document.querySelectorAll('[data-pmode]').forEach((b) => b.addEventListener('click', () => { pmode = b.dataset.pmode; renderPresets(); }));
  $('#ptzPager').addEventListener('click', (ev) => { const b = ev.target.closest('[data-page]'); if (!b) return; page = Number(b.dataset.page); localStorage.setItem('cc.ptzPage', String(page)); renderPresets(); });
  $('#ptzGrid').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cp]'); if (!b || !V) return; const n = Number(b.dataset.cp); const c = sel(); if (!c) return;
    const nm = (c.presetNames || {})[n];
    if (pmode === 'recall') return run(cmd('recall', { preset: n }));
    if (pmode === 'store') { if (!confirm(`Store ${c.name}'s current position as preset ${n}${nm ? ` (overwrites "${nm}")` : ''}?`)) return; const name = prompt('Name for this preset', nm || `Preset ${n}`); if (name === null) return; return run(cmd('store', { preset: n, name }).then(() => toast(`Stored preset ${n}`))); }
    const name = prompt(`Name for ${c.name} preset ${n} (empty clears it)`, nm || ''); if (name === null) return; return run(cmd('rename', { preset: n, name: name.trim() }));
  });
  $('#ptzCamList').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return; const d = b.dataset;
    const c = d.selcam || d.pw || d.edit || d.rm; const cam = (V.cameras || []).find((x) => x.id === c);
    if (d.selcam) return run(cmd('select', { cam: c }));
    if (d.pw) { if (d.on === '0' && !confirm(`Put ${cam.name} in STANDBY?`)) return; return run(cmd('power', { cam: c, on: d.on === '1' })); }
    if (d.edit) { const name = prompt('Camera name', cam.name); if (name === null) return; const host = prompt('Camera IP address', cam.host); if (host === null) return; const port = prompt('HTTP port', String(cam.port)); if (port === null) return; return run(api('POST', `/api/sys/ptz/cameras/${c}`, { name, host, port: Number(port) || 80 }).then(() => toast('Camera saved'))); }
    if (d.rm) { if (!confirm(`Remove ${cam.name} from this system?`)) return; return run(api('DELETE', `/api/sys/ptz/cameras/${c}`).then(() => toast('Camera removed'))); }
    return undefined;
  });
  $('#ptzAdd').addEventListener('submit', (ev) => {
    ev.preventDefault(); const fm = ev.target; const body = { name: fm.elements.name.value.trim(), host: fm.elements.host.value.trim(), port: Number(fm.elements.port.value) || 80 };
    run(api('POST', '/api/sys/ptz/cameras', body).then(() => { fm.reset(); toast(`Added ${body.name || 'camera'}`); }).finally(S.refetch));
  });
})();
