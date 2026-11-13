'use strict';
// PTZ TRACKING. The Mac app does the vision and the motion. This page is the settings and the lock.
// The still is the camera snapshot Control Center already proxies. The boxes come from the tracker and can
// lead that still by a fraction of a second. Tap a box to lock that person.
(() => {
  const { api, toast, esc } = window.CC;
  const root = document.querySelector('#trackRoot');
  if (!root) return;
  const ptzId = () => (window.CCSYS && window.CCSYS.familyTarget && window.CCSYS.familyTarget('ptz')) || 'ptz';
  let view = null;
  let camId = null;
  let timer = null;
  let snapAt = 0;
  let built = '';

  const selected = () => (view && view.cameras || []).find((c) => c.id === camId) || (view && view.cameras[0]) || null;

  function field(name, label, value, attrs) {
    return `<label class="track-field">${label}<input data-k="${name}" value="${esc(value)}" ${attrs || ''}></label>`;
  }

  function shell(cam) {
    const s = (cam && cam.settings) || {};
    const f = s.framing || {};
    const d = s.deadZone || {};
    const sp = s.maxSpeed || {};
    const link = (view && view.link) || {};
    return `<div class="track-layout">
      <div class="panel track-side">
        <div class="section-title">TRACKER <small>${link.connected ? 'connected' : 'not connected'}</small></div>
        <div class="track-link">
          <input id="trackHost" placeholder="Mac IP" value="${esc(link.host || '127.0.0.1')}" spellcheck="false" autocomplete="off">
          <input id="trackPort" type="number" min="1" max="65535" value="${esc(link.port || 8765)}">
          <button class="btn mini" type="button" id="trackSaveLink">SAVE LINK</button>
        </div>
        <p class="note small" id="trackLinkErr">${esc(link.error || (link.connected ? `Protocol ${link.protocol || 1}` : 'The menu-bar app listens on port 8765.'))}</p>
        <div class="cam-strip" id="trackCams"></div>
        <div class="track-run">
          <b id="trackState">${esc((cam && cam.status && cam.status.state) || 'off')}</b>
          <span id="trackFps"></span>
          <button class="btn mini primary" type="button" id="trackStart">START</button>
          <button class="btn mini" type="button" id="trackStop">STOP</button>
          <button class="btn mini" type="button" id="trackResume">RESUME</button>
          <button class="btn mini" type="button" id="trackUnlock">UNLOCK</button>
        </div>
        <p class="note small" id="trackCmd"></p>
        <div class="section-title">SHOT</div>
        <div class="modes" id="trackPreset">
          ${['wide', 'medium', 'close', 'custom'].map((p) => `<button type="button" class="mode ${s.preset === p ? 'active' : ''}" data-preset="${p}">${p.toUpperCase()}</button>`).join('')}
        </div>
        <div class="modes" id="trackDetect">
          <button type="button" class="mode ${s.detect !== 'face' ? 'active' : ''}" data-detect="body">BODY</button>
          <button type="button" class="mode ${s.detect === 'face' ? 'active' : ''}" data-detect="face">FACE</button>
        </div>
        <div class="track-grid">
          ${field('headroom', 'Headroom', f.headroom ?? 0.12, 'type="number" min="0" max="0.45" step="0.01"')}
          ${field('subjectHeight', 'Subject size', f.subjectHeight ?? 0.55, 'type="number" min="0.05" max="0.95" step="0.01"')}
          ${field('anchorX', 'Horizontal', f.anchorX ?? 0.5, 'type="number" min="0.1" max="0.9" step="0.01"')}
          ${field('lead', 'Lead room', f.lead ?? 0.08, 'type="number" min="0" max="0.3" step="0.01"')}
          ${field('deadX', 'Dead zone X', d.x ?? 0.045, 'type="number" min="0" max="0.4" step="0.005"')}
          ${field('deadY', 'Dead zone Y', d.y ?? 0.05, 'type="number" min="0" max="0.4" step="0.005"')}
          ${field('deadSize', 'Size zone', d.size ?? 0.06, 'type="number" min="0" max="0.4" step="0.005"')}
          ${field('speedPan', 'Max pan', sp.pan ?? 18, 'type="number" min="1" max="49" step="1"')}
          ${field('speedTilt', 'Max tilt', sp.tilt ?? 14, 'type="number" min="1" max="49" step="1"')}
          ${field('speedZoom', 'Max zoom', sp.zoom ?? 8, 'type="number" min="1" max="49" step="1"')}
          ${field('smoothing', 'Smoothing', s.smoothing ?? 0.45, 'type="number" min="0" max="1" step="0.05"')}
          ${field('latencyMs', 'Latency ms', s.latencyMs ?? 180, 'type="number" min="0" max="2000" step="10"')}
          ${field('lostHoldMs', 'Lost hold ms', s.lostHoldMs ?? 1200, 'type="number" min="0" max="10000" step="100"')}
          ${field('overrideResumeMs', 'Resume ms', s.overrideResumeMs ?? 2000, 'type="number" min="0" max="30000" step="100"')}
        </div>
        <div class="modes">
          <button type="button" class="mode ${s.lostAction === 'stop' ? 'active' : ''}" id="trackLostStop">STOP WHEN LOST</button>
          <button type="button" class="mode ${s.zoomEnabled ? 'active' : ''}" id="trackZoom">ZOOM FOLLOWS</button>
          <button type="button" class="mode ${s.source === 'jpeg' ? 'active' : ''}" id="trackJpeg">JPEG POLL</button>
        </div>
        <button class="btn mini primary" type="button" id="trackApply">APPLY</button>
        <p class="note small">A joystick, preset or stop on this camera pauses tracking, then it resumes. JPEG poll uses the snapshot the camera already serves, if the MJPEG address is wrong.</p>
      </div>
      <div class="panel track-view">
        <div class="section-title">PREVIEW <small>tap a box to lock. Boxes are from the tracker. The still is the camera snapshot.</small></div>
        <div class="track-stage" id="trackStage">
          <img alt="" id="trackImg">
          <div id="trackBoxes"></div>
          <span class="snap-na" id="trackNa">No snapshot yet</span>
        </div>
      </div>
    </div>`;
  }

  function readForm() {
    const cam = selected();
    const s = { ...(cam && cam.settings) };
    const num = (k) => Number(root.querySelector(`[data-k="${k}"]`).value);
    s.framing = { headroom: num('headroom'), subjectHeight: num('subjectHeight'), anchorX: num('anchorX'), lead: num('lead') };
    s.deadZone = { x: num('deadX'), y: num('deadY'), size: num('deadSize') };
    s.maxSpeed = { pan: num('speedPan'), tilt: num('speedTilt'), zoom: num('speedZoom') };
    s.smoothing = num('smoothing');
    s.latencyMs = num('latencyMs');
    s.lostHoldMs = num('lostHoldMs');
    s.overrideResumeMs = num('overrideResumeMs');
    const presetBtn = root.querySelector('#trackPreset .mode.active');
    s.preset = presetBtn ? presetBtn.dataset.preset : s.preset;
    const detectBtn = root.querySelector('#trackDetect .mode.active');
    s.detect = detectBtn ? detectBtn.dataset.detect : s.detect;
    s.lostAction = root.querySelector('#trackLostStop').classList.contains('active') ? 'stop' : 'reacquire';
    s.zoomEnabled = root.querySelector('#trackZoom').classList.contains('active');
    s.source = root.querySelector('#trackJpeg').classList.contains('active') ? 'jpeg' : 'mjpeg';
    return s;
  }

  function paintLive() {
    const cam = selected();
    if (!cam || !root.querySelector('#trackState')) return;
    const st = cam.status || {};
    root.querySelector('#trackState').textContent = (st.state || 'off').toUpperCase();
    root.querySelector('#trackFps').textContent = st.fps ? `${Number(st.fps).toFixed(1)} fps` : '';
    const cmd = st.lastCommand;
    root.querySelector('#trackCmd').textContent = cmd ? `Last ${cmd.panTilt || ''}  pan ${cmd.pan}  tilt ${cmd.tilt}${cmd.zoom ? `  zoom ${cmd.zoom}` : ''}` : '';
    const link = view.link || {};
    const err = root.querySelector('#trackLinkErr');
    if (document.activeElement !== root.querySelector('#trackHost')) {
      err.textContent = link.error || (link.connected ? `Connected. Protocol ${link.protocol || 1}.` : 'The menu-bar app listens on port 8765.');
    }
    const cams = root.querySelector('#trackCams');
    const html = (view.cameras || []).map((c) => `<button type="button" class="mode ${c.id === cam.id ? 'active' : ''}" data-cam="${esc(c.id)}">${esc(c.name)}</button>`).join('');
    if (cams.dataset.h !== html) { cams.dataset.h = html; cams.innerHTML = html; }
    const boxes = root.querySelector('#trackBoxes');
    const dets = (st.detections || []).filter((d) => !d.missing);
    boxes.innerHTML = dets.map((d) => {
      const locked = d.id === st.lockedTarget;
      return `<button type="button" class="track-box ${locked ? 'locked' : ''}" data-target="${esc(d.id)}" style="left:${(d.x * 100).toFixed(2)}%;top:${(d.y * 100).toFixed(2)}%;width:${(d.w * 100).toFixed(2)}%;height:${(d.h * 100).toFixed(2)}%"><span>${esc(d.id)}</span></button>`;
    }).join('');
  }

  async function refresh() {
    if (window.CC.getTab() !== 'ptrack') return;
    try { view = await api('GET', `/api/sys/${ptzId()}/tracking`); } catch (e) { return; }
    if (!camId || !(view.cameras || []).some((c) => c.id === camId)) camId = view.cameras[0] && view.cameras[0].id;
    const cam = selected();
    const key = cam ? `${cam.id}:${JSON.stringify(cam.settings)}:${(view.link || {}).connected}` : 'none';
    const editing = root.contains(document.activeElement) && document.activeElement.matches('input');
    if (!editing && built !== key) { built = key; root.innerHTML = shell(cam); }
    paintLive();
    if (cam && Date.now() - snapAt > 800) {
      snapAt = Date.now();
      const img = root.querySelector('#trackImg');
      const na = root.querySelector('#trackNa');
      if (img) {
        const next = new Image();
        next.onload = () => { img.src = next.src; na.hidden = true; };
        next.onerror = () => { na.hidden = false; na.textContent = 'No snapshot from this camera'; };
        next.src = `/api/sys/${ptzId()}/cameras/${encodeURIComponent(cam.id)}/snapshot?t=${Date.now()}`;
      }
    }
  }

  function post(path, body) {
    return api('POST', `/api/sys/${ptzId()}/tracking${path}`, { cam: camId, ...body }).then((v) => { view = v; built = ''; return refresh(); });
  }

  root.addEventListener('click', (ev) => {
    const camBtn = ev.target.closest('[data-cam]');
    if (camBtn) { camId = camBtn.dataset.cam; built = ''; refresh(); return; }
    const preset = ev.target.closest('[data-preset]');
    if (preset) { root.querySelectorAll('#trackPreset .mode').forEach((b) => b.classList.toggle('active', b === preset)); return; }
    const detect = ev.target.closest('[data-detect]');
    if (detect) { root.querySelectorAll('#trackDetect .mode').forEach((b) => b.classList.toggle('active', b === detect)); return; }
    if (ev.target.id === 'trackLostStop' || ev.target.id === 'trackZoom' || ev.target.id === 'trackJpeg') { ev.target.classList.toggle('active'); return; }
    if (ev.target.id === 'trackSaveLink') {
      api('POST', `/api/sys/${ptzId()}/tracking/link`, { host: root.querySelector('#trackHost').value.trim(), port: Number(root.querySelector('#trackPort').value) })
        .then(() => toast('Link saved'))
        .catch((e) => toast(e.message, true));
      return;
    }
    if (ev.target.id === 'trackApply') {
      const framingKeys = ['headroom', 'subjectHeight', 'anchorX', 'lead'];
      const touched = framingKeys.some((k) => root.querySelector(`[data-k="${k}"]`).dataset.dirty === '1');
      const body = { settings: readForm() };
      if (touched) body.settings.preset = 'custom';
      post('/settings', body).then(() => toast('Tracking settings saved')).catch((e) => toast(e.message, true));
      return;
    }
    const run = (path, body) => post(path, body).catch((e) => toast(e.message, true));
    if (ev.target.id === 'trackStart') { run('/start', { settings: readForm() }); return; }
    if (ev.target.id === 'trackStop') { run('/stop', {}); return; }
    if (ev.target.id === 'trackResume') { run('/resume', {}); return; }
    if (ev.target.id === 'trackUnlock') { run('/unlock', {}); return; }
    const box = ev.target.closest('[data-target]');
    if (box) run('/lock', { targetId: box.dataset.target });
  });
  root.addEventListener('input', (ev) => {
    if (ev.target.dataset && ev.target.dataset.k) ev.target.dataset.dirty = '1';
  });

  function arm() {
    if (timer) return;
    timer = setInterval(refresh, 300);
    refresh();
  }
  function disarm() { if (timer) clearInterval(timer); timer = null; }
  window.addEventListener('cc:tab', (ev) => { if (ev.detail === 'ptrack') arm(); else disarm(); });
  if (window.CC.getTab() === 'ptrack') arm();
})();
