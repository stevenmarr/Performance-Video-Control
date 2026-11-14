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
  let liveTimer = null;
  let snapAt = 0;
  let built = '';

  const selected = () => (view && view.cameras || []).find((c) => c.id === camId) || (view && view.cameras[0]) || null;

  const pct = (n) => Math.round(Number(n) * 1000) / 10;
  function field(name, label, value, attrs, hint, group) {
    return `<label class="track-field" title="${esc(hint || '')}">${label}<input data-k="${name}" data-group="${group || ''}" value="${esc(value)}" ${attrs || ''}><small>${esc(hint || '')}</small></label>`;
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
        <div class="section-title">REACTION</div>
        <div class="modes" id="trackFeel">
          ${[['lecture', 'SLOW / LECTURE'], ['medium', 'MEDIUM'], ['sports', 'FAST / SPORTS'], ['custom', 'CUSTOM']].map(([id, label]) => `<button type="button" class="mode ${s.feel === id ? 'active' : ''}" data-feel="${id}">${label}</button>`).join('')}
        </div>
        <div class="section-title">SHOT</div>
        <div class="modes" id="trackPreset">
          ${['wide', 'medium', 'close', 'custom'].map((p) => `<button type="button" class="mode ${s.preset === p ? 'active' : ''}" data-preset="${p}">${p.toUpperCase()}</button>`).join('')}
        </div>
        <div class="modes" id="trackDetect">
          <button type="button" class="mode ${s.detect !== 'face' ? 'active' : ''}" data-detect="body">BODY</button>
          <button type="button" class="mode ${s.detect === 'face' ? 'active' : ''}" data-detect="face">FACE</button>
        </div>
        <div class="section-title">SENSITIVITY</div>
        <div class="track-grid">
          ${field('deadX', 'Dead zone, pan', pct(d.x ?? 0.045), 'data-scale="100" type="number" min="0" max="40" step="0.5"', 'percent of the picture, each side, before pan starts', 'feel')}
          ${field('deadY', 'Dead zone, tilt', pct(d.y ?? 0.05), 'data-scale="100" type="number" min="0" max="40" step="0.5"', 'percent of the picture, up and down, before tilt starts', 'feel')}
          ${field('deadSize', 'Dead zone, zoom', pct(d.size ?? 0.06), 'data-scale="100" type="number" min="0" max="40" step="0.5"', 'percent of subject size the zoom will ignore', 'feel')}
          ${field('minConfidence', 'Confidence', pct(s.minConfidence ?? 0.4), 'data-scale="100" type="number" min="0" max="100" step="5"', 'percent. Boxes below this are ignored', 'feel')}
          ${field('minSubject', 'Smallest subject', pct(s.minSubject ?? 0.08), 'data-scale="100" type="number" min="0" max="80" step="1"', 'percent of the picture height. Smaller than this is not a person', 'feel')}
          ${field('lostHoldMs', 'Hold after a loss', s.lostHoldMs ?? 1200, 'type="number" min="0" max="10000" step="100"', 'milliseconds to wait before searching again or stopping', 'feel')}
          ${field('hysteresis', 'Stickiness', s.hysteresis ?? 1.85, 'type="number" min="1.05" max="3" step="0.05"', 'how far past the dead zone a settled axis must be pushed to move again', 'feel')}
          ${field('jitter', 'Jitter filter', s.jitter ?? 0.35, 'type="number" min="0" max="0.95" step="0.05"', '0 is raw. Near 1, a one-frame twitch is ignored', 'feel')}
          ${field('drift', 'Drift ignore', pct(s.drift ?? 0.035), 'data-scale="100" type="number" min="0" max="100" step="0.5"', 'percent of the picture per second that still counts as standing still', 'feel')}
        </div>
        <div class="section-title">REACTION TIME</div>
        <div class="track-grid">
          ${field('latencyMs', 'Delay', s.latencyMs ?? 180, 'type="number" min="0" max="2000" step="10"', 'milliseconds of picture delay the aim steps forward by', 'feel')}
          ${field('speedPan', 'Pan speed cap', sp.pan ?? 18, 'type="number" min="1" max="49" step="1"', '1–49, the camera’s own scale. 49 is as fast as the head goes', 'feel')}
          ${field('speedTilt', 'Tilt speed cap', sp.tilt ?? 14, 'type="number" min="1" max="49" step="1"', '1–49, same scale as pan', 'feel')}
          ${field('speedZoom', 'Zoom speed cap', sp.zoom ?? 8, 'type="number" min="1" max="49" step="1"', '1–49. Zoom stays off until ZOOM FOLLOWS is on', 'feel')}
          ${field('accelPan', 'Pan acceleration', (s.maxAccel || {}).pan ?? 70, 'type="number" min="1" max="500" step="1"', 'speed counts per second while speeding up', 'feel')}
          ${field('accelTilt', 'Tilt acceleration', (s.maxAccel || {}).tilt ?? 60, 'type="number" min="1" max="500" step="1"', 'speed counts per second while speeding up', 'feel')}
          ${field('accelZoom', 'Zoom acceleration', (s.maxAccel || {}).zoom ?? 30, 'type="number" min="1" max="500" step="1"', 'speed counts per second while speeding up', 'feel')}
          ${field('decelPan', 'Pan deceleration', (s.maxDecel || {}).pan ?? 90, 'type="number" min="1" max="500" step="1"', 'speed counts per second while slowing down', 'feel')}
          ${field('decelTilt', 'Tilt deceleration', (s.maxDecel || {}).tilt ?? 80, 'type="number" min="1" max="500" step="1"', 'speed counts per second while slowing down', 'feel')}
          ${field('decelZoom', 'Zoom deceleration', (s.maxDecel || {}).zoom ?? 40, 'type="number" min="1" max="500" step="1"', 'speed counts per second while slowing down', 'feel')}
          ${field('smoothPan', 'Pan smoothing', (s.axisSmoothing || {}).pan ?? s.smoothing ?? 0.45, 'type="number" min="0" max="1" step="0.05"', '0 snaps, 1 is a slow ease. Low-pass on the speed', 'feel')}
          ${field('smoothTilt', 'Tilt smoothing', (s.axisSmoothing || {}).tilt ?? s.smoothing ?? 0.5, 'type="number" min="0" max="1" step="0.05"', '0 snaps, 1 is a slow ease', 'feel')}
          ${field('smoothZoom', 'Zoom smoothing', (s.axisSmoothing || {}).zoom ?? s.smoothing ?? 0.55, 'type="number" min="0" max="1" step="0.05"', '0 snaps, 1 is a slow ease', 'feel')}
          ${field('gainPan', 'Pan response', (s.gain || {}).pan ?? 8, 'type="number" min="0.5" max="20" step="0.5"', 'higher reaches the speed cap sooner once they leave the dead zone', 'feel')}
          ${field('gainTilt', 'Tilt response', (s.gain || {}).tilt ?? 8, 'type="number" min="0.5" max="20" step="0.5"', 'higher reaches the speed cap sooner', 'feel')}
          ${field('gainZoom', 'Zoom response', (s.gain || {}).zoom ?? 6, 'type="number" min="0.5" max="20" step="0.5"', 'higher reaches the speed cap sooner', 'feel')}
          ${field('gentle', 'Gentle band', pct(s.gentle ?? 0.05), 'data-scale="100" type="number" min="0" max="50" step="0.5"', 'percent of the picture past the dead zone that stays on the slow cap. 0 is one curve', 'feel')}
          ${field('fast', 'Fast ramp', pct(s.fast ?? 0.12), 'data-scale="100" type="number" min="0" max="80" step="0.5"', 'percent of the picture spent climbing from the slow cap to the full cap', 'feel')}
          ${field('gentlePan', 'Gentle pan cap', (s.gentleSpeed || {}).pan ?? 6, 'type="number" min="1" max="49" step="1"', 'camera speed while they are only just outside the dead zone', 'feel')}
          ${field('gentleTilt', 'Gentle tilt cap', (s.gentleSpeed || {}).tilt ?? 5, 'type="number" min="1" max="49" step="1"', 'camera speed while they are only just outside the dead zone', 'feel')}
          ${field('gentleZoom', 'Gentle zoom cap', (s.gentleSpeed || {}).zoom ?? 3, 'type="number" min="1" max="49" step="1"', 'camera speed while the size is only just off', 'feel')}
        </div>
        <div class="section-title">FRAMING</div>
        <div class="track-grid">
          ${field('headroom', 'Headroom', pct(f.headroom ?? 0.12), 'data-scale="100" type="number" min="0" max="45" step="0.5"', 'percent of the picture left empty above them', 'shot')}
          ${field('subjectHeight', 'Subject size', pct(f.subjectHeight ?? 0.55), 'data-scale="100" type="number" min="5" max="95" step="1"', 'how tall they should be, percent of the picture', 'shot')}
          ${field('anchorX', 'Horizontal', pct(f.anchorX ?? 0.5), 'data-scale="100" type="number" min="10" max="90" step="1"', 'where they sit, left to right. 50 is the centre', 'shot')}
          ${field('lead', 'Lead room', pct(f.lead ?? 0.08), 'data-scale="100" type="number" min="0" max="30" step="0.5"', 'percent of the picture left empty in the direction they are walking', 'shot')}
          ${field('overrideResumeMs', 'Resume after a stick', s.overrideResumeMs ?? 2000, 'type="number" min="0" max="30000" step="100"', 'milliseconds after you let go before tracking takes over again', '')}
        </div>
        <div class="modes">
          <button type="button" class="mode ${s.lostAction === 'stop' ? 'active' : ''}" id="trackLostStop">STOP WHEN LOST</button>
          <button type="button" class="mode ${s.zoomEnabled ? 'active' : ''}" id="trackZoom">ZOOM FOLLOWS</button>
          <button type="button" class="mode ${s.source === 'jpeg' ? 'active' : ''}" id="trackJpeg">JPEG POLL</button>
        </div>
        <div class="modes">
          <button class="btn mini primary" type="button" id="trackApply">APPLY</button>
          <button class="btn mini" type="button" id="trackReset">RESET TO MEDIUM</button>
        </div>
        <div class="section-title">THIS CAMERA</div>
        <div class="track-link">
          <input id="trackProfileName" placeholder="Profile name" maxlength="40">
          <button class="btn mini" type="button" id="trackProfileSave">SAVE</button>
        </div>
        <div class="modes" id="trackProfiles"></div>
        <p class="note small">Changes apply while tracking is running. A joystick, preset or stop pauses it. Speeds are the UE150 scale, 1 to 49. A Stream Deck encoder can nudge sensitivity or speed: actions ptz.trackSensitivity and ptz.trackSpeed, or dials named trackSens and trackSpeed.</p>
      </div>
      <div class="panel track-view">
        <div class="section-title">PREVIEW <small>tap a box to lock. Boxes are from the tracker. The still is the camera snapshot.</small></div>
        <div class="track-stage" id="trackStage">
          <img alt="" id="trackImg">
          <div id="trackGuides"></div>
          <div id="trackBoxes"></div>
          <span class="snap-na" id="trackNa">No snapshot yet</span>
        </div>
      </div>
    </div>`;
  }

  function readForm() {
    const cam = selected();
    const s = { ...(cam && cam.settings) };
    const num = (k) => { const el = root.querySelector(`[data-k="${k}"]`); return Number(el.value) / Number(el.dataset.scale || 1); };
    s.framing = { headroom: num('headroom'), subjectHeight: num('subjectHeight'), anchorX: num('anchorX'), lead: num('lead') };
    s.deadZone = { x: num('deadX'), y: num('deadY'), size: num('deadSize') };
    s.maxSpeed = { pan: num('speedPan'), tilt: num('speedTilt'), zoom: num('speedZoom') };
    s.maxAccel = { pan: num('accelPan'), tilt: num('accelTilt'), zoom: num('accelZoom') };
    s.maxDecel = { pan: num('decelPan'), tilt: num('decelTilt'), zoom: num('decelZoom') };
    s.gentleSpeed = { pan: num('gentlePan'), tilt: num('gentleTilt'), zoom: num('gentleZoom') };
    s.gain = { pan: num('gainPan'), tilt: num('gainTilt'), zoom: num('gainZoom') };
    s.axisSmoothing = { pan: num('smoothPan'), tilt: num('smoothTilt'), zoom: num('smoothZoom') };
    s.smoothing = s.axisSmoothing.pan;
    s.gentle = num('gentle');
    s.fast = num('fast');
    s.hysteresis = num('hysteresis');
    s.jitter = num('jitter');
    s.drift = num('drift');
    s.minConfidence = num('minConfidence');
    s.minSubject = num('minSubject');
    s.latencyMs = num('latencyMs');
    s.lostHoldMs = num('lostHoldMs');
    s.overrideResumeMs = num('overrideResumeMs');
    const feelBtn = root.querySelector('#trackFeel .mode.active');
    s.feel = feelBtn ? feelBtn.dataset.feel : (s.feel || 'custom');
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
    const vel = st.velocity || st.lastCommand || {};
    const signed = (n) => { const v = Math.round(Number(n) || 0); return v > 0 ? `+${v}` : String(v); };
    root.querySelector('#trackCmd').textContent = `Pan ${signed(vel.pan)}   Tilt ${signed(vel.tilt)}   Zoom ${signed(vel.zoom)}    camera speed, −49 to +49, 0 is stop`;
    const guides = root.querySelector('#trackGuides');
    if (guides && cam.settings) {
      const fr = cam.settings.framing || {};
      const aim = st.aim || { centerX: fr.anchorX || 0.5, top: fr.headroom || 0.12, height: fr.subjectHeight || 0.55 };
      const dz = cam.settings.deadZone || { x: 0.045, y: 0.05 };
      const fw = (aim.height || 0.55) * 0.45;
      const place = (x, y, w, h) => `left:${(x * 100).toFixed(2)}%;top:${(y * 100).toFixed(2)}%;width:${Math.max(0, w * 100).toFixed(2)}%;height:${Math.max(0, h * 100).toFixed(2)}%`;
      const cy = aim.top + aim.height / 2;
      guides.innerHTML = `<div class="track-guide frame" style="${place(aim.centerX - fw / 2, aim.top, fw, aim.height)}"></div><div class="track-guide dead" style="${place(aim.centerX - dz.x, cy - dz.y, dz.x * 2, dz.y * 2)}"></div>`;
    }
    const prof = root.querySelector('#trackProfiles');
    if (prof) {
      const rows = (view.profiles || []).filter((p) => p.cameraKey === `${ptzId()}:${cam.id}`);
      const html = rows.map((p) => `<button type="button" class="mode" data-profile="${esc(p.id)}">${esc(p.name)}</button>`).join('') || '<span class="note small">No saved profile for this camera.</span>';
      if (prof.dataset.h !== html) { prof.dataset.h = html; prof.innerHTML = html; }
    }
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
    const feel = ev.target.closest('[data-feel]');
    if (feel) {
      root.querySelectorAll('#trackFeel .mode').forEach((b) => b.classList.toggle('active', b === feel));
      post('/settings', { settings: { ...readForm(), feel: feel.dataset.feel } }).catch((e) => toast(e.message, true));
      return;
    }
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
      const body = { settings: readForm() };
      if ([...root.querySelectorAll('[data-group="shot"]')].some((el) => el.dataset.dirty === '1')) body.settings.preset = 'custom';
      if ([...root.querySelectorAll('[data-group="feel"]')].some((el) => el.dataset.dirty === '1')) body.settings.feel = 'custom';
      post('/settings', body).then(() => toast('Tracking settings saved')).catch((e) => toast(e.message, true));
      return;
    }
    if (ev.target.id === 'trackReset') { post('/reset', {}).then(() => toast('Reset to Medium')).catch((e) => toast(e.message, true)); return; }
    if (ev.target.id === 'trackProfileSave') {
      const name = root.querySelector('#trackProfileName').value.trim();
      post('/profile', { name }).then(() => toast(`Saved “${name}”`)).catch((e) => toast(e.message, true));
      return;
    }
    const profile = ev.target.closest('[data-profile]');
    if (profile) { post('/profile/load', { id: profile.dataset.profile }).then(() => toast('Profile loaded')).catch((e) => toast(e.message, true)); return; }
    const run = (path, body) => post(path, body).catch((e) => toast(e.message, true));
    if (ev.target.id === 'trackStart') { run('/start', { settings: readForm() }); return; }
    if (ev.target.id === 'trackStop') { run('/stop', {}); return; }
    if (ev.target.id === 'trackResume') { run('/resume', {}); return; }
    if (ev.target.id === 'trackUnlock') { run('/unlock', {}); return; }
    const box = ev.target.closest('[data-target]');
    if (box) run('/lock', { targetId: box.dataset.target });
  });
  root.addEventListener('input', (ev) => {
    if (!ev.target.dataset || !ev.target.dataset.k) return;
    ev.target.dataset.dirty = '1';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      const body = { settings: readForm() };
      if (ev.target.dataset.group === 'shot') body.settings.preset = 'custom';
      if (ev.target.dataset.group === 'feel') body.settings.feel = 'custom';
      post('/settings', body).catch((e) => toast(e.message, true));
    }, 250);
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
