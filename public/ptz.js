'use strict';
// 0.8.0 Panasonic PTZ: CAMERA CONTROL, one dashboard laid out like an AW-RP150 / RP60 joystick controller plus an
// AW-RCP paint panel, and CAMERAS (add / edit / remove, command reference).
//   * The controls come from the camera's command catalog (GET /api/sys/ptz/cameras/:id/catalog): what its model
//     series supports, per the Companion module's series table plus the UE150 / HE145 spec extras. Every catalog
//     command has a control here; nothing a camera lacks is offered.
//   * Motion is proportional and hold-to-run: the joystick's pan and tilt speeds grow with the distance from the
//     centre (dead zone + curve), the zoom / focus rockers likewise. Per axis only one request is in flight and
//     only changed speeds are sent; a keep-alive every 400 ms re-arms the server's dead-man (the camera gets no
//     traffic from it). Release, cancel, lost capture, window blur, page hide, tab change and Esc all stop.
(() => {
  const $ = (s) => document.querySelector(s);
  const { api, toast, run, esc } = window.CC;
  const S = window.CCSYS;
  let V = null; let pmode = 'recall'; let page = Number(localStorage.getItem('cc.ptzPage') || 1) || 1; const PAGE = 20;
  let paintTab = localStorage.getItem('cc.ptzPaint') || 'wb';
  const cats = new Map(); const catLoading = new Set(); let built = ''; const local = {}; const thumbVer = {};
  const camId = () => V && V.selected;
  const sel = () => (V && V.cameras ? V.cameras.find((c) => c.id === V.selected) : null);
  const cmd = (name, body = {}) => api('POST', `/api/sys/ptz/cmd/${name}`, { cam: camId(), ...body });
  const catOf = (c) => (c ? cats.get(c.series) : null);
  const has = (id) => { const k = catOf(sel()); return !!(k && k.ops.some((o) => o.id === id)); };

  // ---------- motion: one controller per axis ----------
  let kaTimer = null; let motionCam = null; const held = { pt: false, zoom: false, focus: false };
  const anyHeld = () => held.pt || held.zoom || held.focus;
  function keepAlive() {
    if (anyHeld() && !kaTimer) kaTimer = setInterval(() => { if (motionCam) api('POST', '/api/sys/ptz/cmd/keepalive', { cam: motionCam }).catch(() => {}); }, 400);
    if (!anyHeld() && kaTimer) { clearInterval(kaTimer); kaTimer = null; }
    document.body.classList.toggle('ptz-moving', anyHeld());
  }
  function axis(name) {
    const st = { inflight: false, pending: null, stop: false, cam: null };
    const route = name === 'pt' ? 'move' : name;
    const pump = () => {
      if (st.inflight) return;
      if (st.stop) {
        st.stop = false; st.inflight = true;
        api('POST', '/api/sys/ptz/cmd/stop', { cam: st.cam, axes: [name] }).catch((e) => toast(e.message, true)).finally(() => { st.inflight = false; pump(); });
        return;
      }
      if (!st.pending) return;
      const b = st.pending; st.pending = null; st.inflight = true;
      api('POST', `/api/sys/ptz/cmd/${route}`, { ...b, cam: st.cam, speed: true })
        .catch((e) => { toast(e.message, true); release(name); })
        .finally(() => { st.inflight = false; setTimeout(pump, 45); });
    };
    return {
      set(body, cam) { st.cam = cam; st.pending = body; held[name] = true; motionCam = cam; keepAlive(); pump(); },
      stop() { if (!held[name] && !st.pending && !st.inflight) return; st.pending = null; st.stop = true; held[name] = false; pump(); if (!anyHeld()) motionCam = null; keepAlive(); },
    };
  }
  const AX = { pt: axis('pt'), zoom: axis('zoom'), focus: axis('focus') };
  const curve = (n, dz = 0.08) => (n < dz ? 0 : Math.pow((n - dz) / (1 - dz), 1.6));
  function release(name) {
    AX[name].stop();
    if (name === 'pt') { $('#ptzPuck').style.transform = ''; $('#ptzJoyCmd').textContent = 'P 0 · T 0'; $('#ptzJoy').classList.remove('held'); }
    else { const r = $(name === 'zoom' ? '#ptzZoomR' : '#ptzFocusR'); r.querySelector('.rk-thumb').style.transform = ''; r.classList.remove('held'); }
  }
  function releaseAll(reason) {
    const cam = motionCam; const was = anyHeld();
    for (const k of Object.keys(AX)) release(k);
    if (was && cam) api('POST', '/api/sys/ptz/cmd/stop', { cam }).catch(() => {});
    if (was && reason) console.info(`PTZ stop: ${reason}`);
  }
  const canMove = () => { const c = sel(); return !!(c && c.connected && c.power !== 'standby'); };
  // joystick
  const joy = $('#ptzJoy'); const puck = $('#ptzPuck'); let joyPtr = null; let lastPT = '';
  function joyAt(ev) {
    const r = joy.getBoundingClientRect(); const R = r.width / 2 - puck.offsetWidth / 2;
    let dx = ev.clientX - (r.left + r.width / 2); let dy = ev.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy); if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
    puck.style.transform = `translate(${dx}px, ${dy}px)`;
    const n = Math.min(1, d / R); const max = Number(V.speeds.pt) || 25; const mag = curve(n) * max;
    const pan = d ? Math.round((mag * dx) / Math.min(d, R)) : 0; const tilt = d ? Math.round((-mag * dy) / Math.min(d, R)) : 0;
    const key = `${pan},${tilt}`; if (key === lastPT) return; lastPT = key;
    $('#ptzJoyCmd').textContent = `P ${pan > 0 ? '+' : ''}${pan} · T ${tilt > 0 ? '+' : ''}${tilt}`;
    AX.pt.set({ pan, tilt }, camId());
  }
  joy.addEventListener('pointerdown', (ev) => {
    if (!canMove() || joyPtr !== null) return; ev.preventDefault();
    joyPtr = ev.pointerId; try { joy.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
    joy.classList.add('held'); lastPT = ''; joyAt(ev);
  });
  joy.addEventListener('pointermove', (ev) => { if (ev.pointerId === joyPtr) joyAt(ev); });
  const joyEnd = (ev) => { if (ev.pointerId !== joyPtr) return; joyPtr = null; lastPT = ''; release('pt'); };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) joy.addEventListener(t, joyEnd);
  // rockers (spring-loaded vertical sliders)
  for (const [id, name] of [['#ptzZoomR', 'zoom'], ['#ptzFocusR', 'focus']]) {
    const el = $(id); const track = el.querySelector('.rk-track'); const thumb = el.querySelector('.rk-thumb'); let ptr = null; let last = null;
    const at = (ev) => {
      const r = track.getBoundingClientRect(); const half = (r.height - thumb.offsetHeight) / 2;
      let dy = ev.clientY - (r.top + r.height / 2); dy = Math.max(-half, Math.min(half, dy));
      thumb.style.transform = `translateY(${dy}px)`;
      const v = -dy / half; const max = Number(V.speeds[name]) || 25; const sp = Math.sign(v) * Math.round(curve(Math.abs(v)) * max);
      if (sp === last) return; last = sp; AX[name].set({ value: sp }, camId());
    };
    track.addEventListener('pointerdown', (ev) => { if (!canMove() || ptr !== null) return; if (name === 'focus' && !has('focus')) return; ev.preventDefault(); ptr = ev.pointerId; try { track.setPointerCapture(ev.pointerId); } catch { /* */ } el.classList.add('held'); last = null; at(ev); });
    track.addEventListener('pointermove', (ev) => { if (ev.pointerId === ptr) at(ev); });
    const end = (ev) => { if (ev.pointerId !== ptr) return; ptr = null; last = null; release(name); };
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(t, end);
  }
  window.addEventListener('blur', () => releaseAll('window blur'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll('page hidden'); });
  window.addEventListener('cc:tab', () => releaseAll('tab change'));
  window.addEventListener('pagehide', () => { if (anyHeld() && motionCam && navigator.sendBeacon) navigator.sendBeacon('/api/sys/ptz/cmd/stop', new Blob([JSON.stringify({ cam: motionCam })], { type: 'application/json' })); });
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('#pane-pctl .joy, #pane-pctl .rock')) e.preventDefault(); });
  // keys: arrows pan / tilt at max speed, + / - zoom, Esc = all stop
  const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }; const down = new Set();
  const keyPT = () => { let p = 0; let t = 0; for (const k of down) if (KEYS[k]) { p += KEYS[k][0]; t += KEYS[k][1]; } const m = Number(V.speeds.pt) || 25; if (!p && !t) release('pt'); else AX.pt.set({ pan: Math.sign(p) * m, tilt: Math.sign(t) * m }, camId()); };
  document.addEventListener('keydown', (e) => {
    if (window.CC.getTab() !== 'pctl' || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { releaseAll('Esc'); run(cmd('stopAll')); return; }
    if (e.repeat || !canMove()) { if (KEYS[e.key]) e.preventDefault(); return; }
    if (KEYS[e.key]) { e.preventDefault(); down.add(e.key); keyPT(); }
    else if (e.key === '+' || e.key === '=') AX.zoom.set({ value: Number(V.speeds.zoom) || 25 }, camId()); else if (e.key === '-') AX.zoom.set({ value: -(Number(V.speeds.zoom) || 25) }, camId());
  });
  document.addEventListener('keyup', (e) => { if (KEYS[e.key]) { down.delete(e.key); if (V) keyPT(); } else if (['+', '=', '-'].includes(e.key)) release('zoom'); });
  $('#ptzAllStop').addEventListener('click', () => { releaseAll('ALL STOP'); run(cmd('stopAll').then(() => toast('All cameras stopped'))); });

  // ---------- catalog controls ----------
  const SLOTS = {
    lens: ['focusMode', 'oneTouchAF'],
    iris: ['iris', 'irisMode'],
    exposure: ['gain', 'superGain', 'ndFilter', 'shutter', 'shutterMode', 'shutterStepDown', 'shutterStep', 'shutterStepUp', 'synchroDown', 'synchro', 'synchroUp', 'masterPed', 'pedestal'],
    preset: ['presetScope', 'presetSpeedMode', 'presetSpeed', 'presetTime'],
    system: ['power', 'tallyRed', 'tallyGreen', 'scene', 'install', 'sdRec'],
    menu: ['menu', 'menuUp', 'menuLeft', 'menuEnter', 'menuRight', 'menuDown', 'menuCancel'],
  };
  const PAINT = [
    ['wb', 'WHITE', ['wbMode', 'awb', 'abb', 'colorTemp', 'varTempDown', 'varTemp', 'varTempUp', 'rGain', 'bGain']],
    ['paint', 'PAINT', ['rGain', 'bGain', 'rPed', 'gPed', 'bPed']],
    ['detail', 'DETAIL', ['detail', 'masterDetail', 'skinDetail', 'skinEffect']],
    ['gamma', 'GAMMA · KNEE', ['gammaMode', 'gamma', 'kneeMode', 'kneePoint', 'kneeSlope']],
    ['matrix', 'MATRIX', ['matrixType', 'adaptiveMatrix', 'matrixRG', 'matrixRB', 'matrixGR', 'matrixGB', 'matrixBR', 'matrixBG']],
    ['chroma', 'CHROMA', ['chromaLevel', 'chromaPhase']],
    ['bars', 'BARS', ['colorBars', 'colorBarsSetup', 'colorBarsTitle', 'colorBarsTone', 'colorBarsType']],
  ];
  const NOT_CTL = new Set(['move', 'zoom', 'focus', 'stop', 'recall', 'store', 'presetName', 'thumbnail', 'speeds', 'keepalive', 'home']);
  const SHORT = { focusMode: 'FOCUS', oneTouchAF: 'PUSH AF', irisMode: 'IRIS', iris: 'IRIS', superGain: 'SUPER GAIN', ndFilter: 'ND', shutterMode: 'SHUTTER', shutterStep: 'STEP', shutterStepUp: 'STEP +', shutterStepDown: 'STEP −',
    synchro: 'SYNCHRO', synchroUp: 'SYN +', synchroDown: 'SYN −', masterPed: 'M.PED', pedestal: 'M.PED', wbMode: 'WB', awb: 'AWB ▶', abb: 'ABB ▶', varTemp: 'VAR K', varTempUp: 'K +', varTempDown: 'K −', colorTemp: 'COLOR TEMP',
    rGain: 'R GAIN', bGain: 'B GAIN', rPed: 'R PED', gPed: 'G PED', bPed: 'B PED', detail: 'DETAIL', masterDetail: 'M.DTL', skinDetail: 'SKIN DTL', skinEffect: 'SKIN EFF', gammaMode: 'GAMMA MODE', gamma: 'GAMMA',
    kneeMode: 'KNEE', kneePoint: 'K.POINT', kneeSlope: 'K.SLOPE', matrixType: 'MATRIX', adaptiveMatrix: 'ADAPTIVE', matrixRG: 'R-G', matrixRB: 'R-B', matrixGR: 'G-R', matrixGB: 'G-B', matrixBR: 'B-R', matrixBG: 'B-G',
    chromaLevel: 'CHROMA', chromaPhase: 'PHASE', presetScope: 'RECALL SCOPE', presetSpeedMode: 'SPEED / TIME', presetSpeed: 'SPEED', presetTime: 'TIME', power: 'POWER', tallyRed: 'RED TALLY', tallyGreen: 'GREEN TALLY',
    scene: 'SCENE', install: 'INSTALL', sdRec: 'SD REC', colorBars: 'BARS', colorBarsSetup: 'SETUP', colorBarsTitle: 'TITLE', colorBarsTone: 'TONE', colorBarsType: 'TYPE', menu: 'MENU',
    menuUp: '▲', menuDown: '▼', menuLeft: '◀', menuRight: '▶', menuEnter: 'ENTER', menuCancel: 'CANCEL' };
  const TG = { focusMode: ['AF', 'MF'], irisMode: ['AUTO', 'MANUAL'], power: ['ON', 'STANDBY'] };
  const FMT = { varTemp: (v) => `${Math.round(v)}K`, gamma: (v) => (v / 100).toFixed(2), kneePoint: (v) => `${Number(v).toFixed(2)}%`, chromaLevel: (v) => (v <= -100 ? 'OFF' : `${v > 0 ? '+' : ''}${v}%`), synchro: (v) => `${Number(v).toFixed(1)}`, iris: (v) => String(v) };
  const fmt = (o, v) => (v === undefined || v === null || Number.isNaN(v) ? '—' : FMT[o.id] ? FMT[o.id](v) : (o.range && o.range.min < 0 && v > 0 ? `+${v}` : String(v)));
  const ARC = (f) => { const a0 = 135; const a = a0 + 270 * Math.max(0, Math.min(1, f)); const p = (deg) => { const r = (deg * Math.PI) / 180; return `${50 + 40 * Math.cos(r)} ${50 + 40 * Math.sin(r)}`; }; return `M ${p(a0)} A 40 40 0 ${a - a0 > 180 ? 1 : 0} 1 ${p(a)}`; };
  function ctlHtml(o) {
    const lbl = SHORT[o.id] || o.label.toUpperCase(); const t = `title="${esc(`${o.label} · ${o.src === 'spec' ? 'Panasonic spec' : 'Companion module'}: ${o.ref}`)}"`;
    if (o.type === 'button') return `<button class="btn mini ctl-b ${/^menu/.test(o.id) ? `mn ${o.id}` : ''} ${['awb', 'abb'].includes(o.id) ? 'exec' : ''}" data-op="${o.id}" data-type="button" type="button" ${t}>${esc(lbl)}</button>`;
    if (o.type === 'toggle') return `<button class="mode ctl-t tg-${o.id}" data-op="${o.id}" data-type="toggle" type="button" ${t}><small>${esc(lbl)}</small><b>—</b></button>`;
    if (o.type === 'list') {
      if (o.options.length <= 7 && o.id !== 'gain') return `<div class="ctl-seg" data-op="${o.id}" data-type="list" ${t}><span class="lbl">${esc(lbl)}</span><div class="segb">${o.options.map(([v, l]) => `<button class="mode" data-v="${esc(v)}" type="button">${esc(l)}</button>`).join('')}</div></div>`;
      return `<label class="ctl-sel" ${t}><span class="lbl">${esc(lbl)}</span><select data-op="${o.id}" data-type="list"><option value="" disabled>—</option>${o.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>`;
    }
    const big = o.id === 'iris' ? 'big' : '';
    return `<div class="knob ${big}" data-op="${o.id}" data-type="range" tabindex="0" ${t}><svg viewBox="0 0 100 100" aria-hidden="true"><path class="trk" d="${ARC(1)}"/><path class="val" d="${ARC(0)}"/></svg><b>—</b><span class="kl">${esc(lbl)}</span>
      <span class="kb"><button data-step="-1" type="button">−</button><button data-step="1" type="button">+</button></span></div>`;
  }
  function slot(name, ids, k) {
    const ops = ids.map((id) => k.ops.find((o) => o.id === id)).filter(Boolean);
    if (name === 'menu') {
      const g = (id) => { const o = ops.find((x) => x.id === id); return o ? ctlHtml(o) : '<span></span>'; };
      return ops.length ? `<div class="menu-pad">${g('menu')}<div class="cross"><span></span>${g('menuUp')}<span></span>${g('menuLeft')}${g('menuEnter')}${g('menuRight')}<span></span>${g('menuDown')}<span></span></div>${g('menuCancel')}</div>` : '';
    }
    return ops.map(ctlHtml).join('');
  }
  function build(c, k) {
    const sid = c.series; const used = new Set();
    for (const el of document.querySelectorAll('#pane-pctl [data-slot]')) {
      const name = el.dataset.slot; if (name === 'paint') continue;
      const ids = SLOTS[name]; ids.forEach((i) => used.add(i));
      let h = slot(name, ids, k);
      if (name === 'system') { const rest = k.ops.filter((o) => !NOT_CTL.has(o.id) && !Object.values(SLOTS).flat().includes(o.id) && !PAINT.some(([, , l]) => l.includes(o.id))); if (rest.length) h += `<div class="sub">OTHER</div>${rest.map(ctlHtml).join('')}`; }
      el.innerHTML = h || `<div class="note small">Not available on the ${esc(sid)} series.</div>`;
    }
    const tabs = PAINT.map(([id, l, ids]) => [id, l, ids.filter((i) => k.ops.some((o) => o.id === i))]);
    if (!tabs.some(([id, , l]) => id === paintTab && l.length)) { const f = tabs.find(([, , l]) => l.length); paintTab = f ? f[0] : 'wb'; }
    $('#ptzPaintTabs').innerHTML = tabs.map(([id, l, ids]) => `<button class="ptab ${id === paintTab ? 'on' : ''}" data-ptab="${id}" ${ids.length ? '' : 'disabled title="not on this model"'} type="button">${l}</button>`).join('');
    const pane = document.querySelector('#pane-pctl [data-slot=paint]');
    pane.innerHTML = tabs.map(([id, , ids]) => `<div class="ptab-pane ${id === paintTab ? '' : 'hide'}" data-pane="${id}">${ids.length ? slot(id, ids, k) : `<div class="note small">Not available on the ${esc(sid)} series (these are UE150 / HE145 spec commands).</div>`}</div>`).join('');
    $('#spPt').closest('.joy-foot').querySelector('[data-op=home]').hidden = !k.ops.some((o) => o.id === 'home');
    $('#ptzFocusR').classList.toggle('na', !k.ops.some((o) => o.id === 'focus'));
  }
  $('#ptzPaintTabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-ptab]'); if (!b || b.disabled) return; paintTab = b.dataset.ptab; localStorage.setItem('cc.ptzPaint', paintTab); document.querySelectorAll('#ptzPaintTabs .ptab').forEach((x) => x.classList.toggle('on', x === b)); document.querySelectorAll('#pane-pctl .ptab-pane').forEach((p) => p.classList.toggle('hide', p.dataset.pane !== paintTab)); });

  // value of one op: a value just set here wins for 2.5 s (the camera's echo arrives with the next status read)
  const valOf = (c, id) => { const l = local[`${c.id}:${id}`]; if (l && (l.drag || Date.now() - l.at < 2500)) return l.v; return (c.values || {})[id]; };
  function update(c, k) {
    const off = !c.connected;
    for (const el of document.querySelectorAll('#pane-pctl [data-op]')) {
      const id = el.dataset.op; const o = k.ops.find((x) => x.id === id); if (!o) continue;
      const v = valOf(c, id);
      if (el.dataset.type === 'toggle') { el.classList.toggle('active', v === true); el.querySelector('b').textContent = v === undefined ? '—' : (TG[id] ? TG[id][v ? 0 : 1] : v ? 'ON' : 'OFF'); }
      else if (el.dataset.type === 'list' && el.tagName === 'SELECT') { if (document.activeElement !== el) { el.value = v === undefined ? '' : String(v); if (el.value !== String(v ?? '')) el.value = ''; } }
      else if (el.dataset.type === 'list') el.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('active', String(v) === b.dataset.v));
      else if (el.dataset.type === 'range') {
        const r = o.range; const n = v === undefined ? null : Number(v);
        el.querySelector('b').textContent = fmt(o, n);
        el.querySelector('.val').setAttribute('d', ARC(n === null ? 0 : (n - r.min) / (r.max - r.min)));
        el.classList.toggle('centre', r.centre !== undefined && n === r.centre);
      }
      const lock = off || (id === 'iris' && valOf(c, 'irisMode') === true) || (/^menu./.test(id) && valOf(c, 'menu') === false && false);
      el.classList.toggle('dis', !!lock); if ('disabled' in el) el.disabled = !!lock; el.querySelectorAll('button,select').forEach((b) => { b.disabled = !!lock; });
    }
  }
  const pend = {};
  function send(id, value, { now = false } = {}) {
    const c = sel(); if (!c) return; const key = `${c.id}:${id}`;
    const p = pend[key] || (pend[key] = { t: null, last: 0 });
    p.value = value;
    const go = () => { p.t = null; p.last = Date.now(); cmd('op', { cam: c.id, op: id, value: p.value }).catch((e) => { toast(e.message, true); delete local[key]; renderCtl(); }); };
    const wait = 130 - (Date.now() - p.last);
    if (now || wait <= 0) { clearTimeout(p.t); go(); } else if (!p.t) p.t = setTimeout(go, wait);
  }
  const setLocal = (id, v, drag = false) => { const c = sel(); if (c) local[`${c.id}:${id}`] = { v, at: Date.now(), drag }; };
  const opDef = (id) => { const k = catOf(sel()); return k && k.ops.find((o) => o.id === id); };
  const pane = $('#pane-pctl');
  pane.addEventListener('click', (ev) => {
    const kb = ev.target.closest('.knob [data-step]');
    if (kb) { const el = kb.closest('.knob'); const o = opDef(el.dataset.op); const c = sel(); if (!o || !c) return; const cur = Number(valOf(c, o.id) ?? o.range.centre ?? o.range.min); const v = Math.max(o.range.min, Math.min(o.range.max, cur + Number(kb.dataset.step) * o.range.step)); setLocal(o.id, v); renderCtl(); send(o.id, v, { now: true }); return; }
    const b = ev.target.closest('[data-op]'); if (!b || b.disabled || b.classList.contains('dis')) return;
    const id = b.dataset.op; const c = sel(); if (!c) return;
    if (id === 'home') return run(cmd('op', { op: 'home' }).then(() => toast('Home')));
    const t = b.dataset.type;
    if (t === 'button') { if (['awb', 'abb'].includes(id)) toast(`${id.toUpperCase()} running on ${c.name}`); return run(cmd('op', { op: id })); }
    if (t === 'toggle') {
      const on = !(valOf(c, id) === true);
      if (id === 'power' && !on && !confirm(`Put ${c.name} in STANDBY?`)) return undefined;
      setLocal(id, on); renderCtl(); return run(cmd('op', { op: id, value: on }).catch((e) => { delete local[`${c.id}:${id}`]; renderCtl(); throw e; }));
    }
    if (t === 'list' && b.tagName !== 'SELECT') { const v = ev.target.closest('[data-v]'); if (!v) return; setLocal(id, v.dataset.v); renderCtl(); return run(cmd('op', { op: id, value: v.dataset.v })); }
    return undefined;
  });
  pane.addEventListener('change', (ev) => { const s = ev.target.closest('select[data-op]'); if (!s) return; setLocal(s.dataset.op, s.value); run(cmd('op', { op: s.dataset.op, value: s.value })); });
  // knob drag (vertical: 200 px = the full range), wheel, keys; double-click returns to centre
  let kd = null;
  pane.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest('.knob'); if (!el || ev.target.closest('[data-step]') || el.classList.contains('dis')) return;
    const o = opDef(el.dataset.op); const c = sel(); if (!o || !c) return; ev.preventDefault();
    kd = { el, o, y: ev.clientY, v0: Number(valOf(c, o.id) ?? o.range.centre ?? o.range.min), id: ev.pointerId }; try { el.setPointerCapture(ev.pointerId); } catch { /* */ }
    el.classList.add('drag');
  });
  pane.addEventListener('pointermove', (ev) => {
    if (!kd || ev.pointerId !== kd.id) return; const r = kd.o.range;
    let v = kd.v0 + ((kd.y - ev.clientY) / 200) * (r.max - r.min); v = Math.round(v / r.step) * r.step; v = Math.max(r.min, Math.min(r.max, Number(v.toFixed(2))));
    const c = sel(); if (valOf(c, kd.o.id) === v) return; setLocal(kd.o.id, v, true); renderCtl(); send(kd.o.id, v);
  });
  const kEnd = (ev) => { if (!kd || ev.pointerId !== kd.id) return; const { o, el } = kd; kd = null; el.classList.remove('drag'); const c = sel(); const l = c && local[`${c.id}:${o.id}`]; if (l && l.drag) { l.drag = false; l.at = Date.now(); send(o.id, l.v, { now: true }); } };
  pane.addEventListener('pointerup', kEnd); pane.addEventListener('pointercancel', kEnd);
  pane.addEventListener('wheel', (ev) => { const el = ev.target.closest('.knob'); if (!el || el.classList.contains('dis')) return; const o = opDef(el.dataset.op); const c = sel(); if (!o || !c) return; ev.preventDefault(); const cur = Number(valOf(c, o.id) ?? o.range.centre ?? o.range.min); const v = Math.max(o.range.min, Math.min(o.range.max, Number((cur + (ev.deltaY < 0 ? 1 : -1) * o.range.step * (ev.shiftKey ? 10 : 1)).toFixed(2)))); setLocal(o.id, v); renderCtl(); send(o.id, v); }, { passive: false });
  pane.addEventListener('dblclick', (ev) => { const el = ev.target.closest('.knob'); if (!el || el.classList.contains('dis')) return; const o = opDef(el.dataset.op); if (!o || o.range.centre === undefined) return; setLocal(o.id, o.range.centre); renderCtl(); send(o.id, o.range.centre, { now: true }); });

  // ---------- render ----------
  const strip = () => S.set($('#ptzStrip'), 'ptzStrip', (V.cameras || []).map((c) => `<button class="cam ${c.id === V.selected ? 'on' : ''} ${c.connected ? '' : 'off'} ${c.tally ? 'tally-r' : ''} ${c.tallyGreen ? 'tally-g' : ''}" data-cam="${esc(c.id)}" type="button">
      <span class="tl"><i class="r ${c.tally ? 'on' : ''}"></i><i class="g ${c.tallyGreen ? 'on' : ''}"></i></span><b>${esc(c.name)}</b><small>${esc(c.model || (c.connected ? '' : 'offline'))}${c.power === 'standby' ? ' · STANDBY' : ''}${c.lastPreset ? ` · P${c.lastPreset}` : ''}${c.moving ? ' · MOVING' : ''}</small></button>`).join('') || '<div class="note">No cameras. Add them on ⌂ SYSTEMS or the CAMERAS tab.</div>');
  const deg = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}°`);
  const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);
  function readout(c) {
    const p = c.pos || {}; const e = c.lastError && Date.now() - c.lastError.at < 60000 ? c.lastError : null;
    S.set($('#ptzRead'), 'ptzRead', `<span class="rd"><small>MODEL</small><b>${esc(c.model || '—')}</b></span><span class="rd"><small>SERIES</small><b>${esc(c.series || '—')}</b></span>${c.version ? `<span class="rd"><small>FW</small><b>${esc(c.version)}</b></span>` : ''}
      <span class="rd"><small>PAN</small><b>${deg(p.pan)}</b></span><span class="rd"><small>TILT</small><b>${deg(p.tilt)}</b></span><span class="rd"><small>ZOOM</small><b>${pct(p.zoom)}</b></span><span class="rd"><small>FOCUS</small><b>${pct(p.focus)}</b></span><span class="rd"><small>IRIS</small><b>${pct(p.iris)}${c.autoIris ? ' A' : ''}</b></span>
      <span class="rd"><small>POWER</small><b class="${c.power === 'on' ? 'okc' : 'warnc'}">${esc((c.power || '—').toUpperCase())}</b></span><span class="rd ${c.error || (c.camError) ? 'err' : ''}"><small>STATUS</small><b>${c.connected ? (c.error ? esc(c.error) : 'OK') : esc(c.error || 'OFFLINE')}</b></span>
      ${e ? `<span class="rd err"><small>LAST REFUSAL</small><b>${esc(e.cmd)} → ${esc(e.reply)}</b></span>` : ''}<span class="spacer"></span><span class="rd dim"><small>HOST</small><b>${esc(c.host)}:${esc(c.port)}</b></span>`);
    $('#ptzZoomV').textContent = pct(p.zoom); $('#ptzFocusV').textContent = pct(p.focus);
  }
  function renderPresets(c, k) {
    const names = (c && c.presetNames) || {}; const pages = Math.ceil(V.presetCount / PAGE); if (page > pages) page = 1;
    S.set($('#ptzPager'), 'ptzPager', Array.from({ length: pages }, (_, i) => { const lo = i * PAGE + 1; const hi = Math.min(V.presetCount, (i + 1) * PAGE); const used = Object.keys(names).filter((n) => n >= lo && n <= hi).length; return `<button class="pg ${page === i + 1 ? 'on' : ''}" data-page="${i + 1}" type="button">${lo}–${hi}${used ? `<small>${used}</small>` : ''}</button>`; }).join(''));
    const thumbs = !!(k && k.ops.some((o) => o.id === 'thumbnail')); const off = !c || !c.connected;
    let h = '';
    for (let n = (page - 1) * PAGE + 1; n <= Math.min(V.presetCount, page * PAGE); n++) {
      const nm = names[n]; const last = c && c.lastPreset === n;
      const img = thumbs && c && (nm || last) ? `<img alt="" loading="lazy" src="/api/sys/ptz/cameras/${encodeURIComponent(c.id)}/thumbnail/${n}?v=${thumbVer[`${c.id}:${n}`] || 1}">` : '';
      h += `<button class="thumb ${nm ? '' : 'unnamed'} ${last ? 'is-last' : ''} ${img ? '' : 'noimg'}" data-cp="${n}" ${off ? 'disabled' : ''} type="button">${img}<span class="ph">${n}</span><span class="cap"><b>${n}</b>${esc(nm || '')}</span>${last ? '<span class="tag">LAST</span>' : ''}</button>`;
    }
    S.set($('#ptzGrid'), 'ptzGrid', h);
    $('#ptzGrid').className = `thumbs mode-${pmode}`;
    document.querySelectorAll('[data-pmode]').forEach((b) => b.classList.toggle('active', b.dataset.pmode === pmode));
    $('#ptzPresetHint').textContent = { recall: 'tap: move the camera to that preset', store: 'tap: save the current position there (asks first)', rename: `tap: name it${c && c.series === 'UE150' ? ' (also saved on the camera)' : ''}` }[pmode];
  }
  $('#ptzGrid').addEventListener('error', (ev) => { if (ev.target.tagName === 'IMG') ev.target.closest('.thumb').classList.add('noimg'); }, true);
  $('#ptzGrid').addEventListener('load', (ev) => { if (ev.target.tagName === 'IMG') ev.target.closest('.thumb').classList.remove('noimg'); }, true);

  function renderCtl() {
    if (!V) return;
    strip();
    const c = sel();
    for (const [k, id] of [['pt', '#spPt'], ['zoom', '#spZoom'], ['focus', '#spFocus']]) { const el = $(id); if (document.activeElement !== el) el.value = V.speeds[k]; $(`${id}V`).textContent = V.speeds[k]; }
    pane.classList.toggle('cam-off', !c || !c.connected);
    if (!c) { S.set($('#ptzRead'), 'ptzRead', ''); return; }
    readout(c);
    const k = catOf(c);
    if (!k) { if (!catLoading.has(c.series)) { catLoading.add(c.series); api('GET', `/api/sys/ptz/cameras/${encodeURIComponent(c.id)}/catalog`).then((x) => { cats.set(x.series, x); }).catch((e) => toast(e.message, true)).finally(() => { catLoading.delete(c.series); renderCtl(); }); } return; }
    const key = `${c.id}|${c.series}|${k.ops.length}`;
    if (built !== key) { build(c, k); built = key; }
    update(c, k);
    renderPresets(c, k);
  }
  function renderCams() {
    S.set($('#ptzCamList'), 'ptz-cams', (V.cameras || []).map((c) => `<div class="row cam-line ${c.connected ? '' : 'off'}" data-cam="${esc(c.id)}">
      <span class="led ${c.connected ? 'ok' : 'off'}"></span><span class="lbl">${esc(c.name)}<small>${esc(c.model || 'unknown model')} · series ${esc(c.series)}${c.title ? ` · ${esc(c.title)}` : ''} · ${esc(c.host)}:${esc(c.port)}${c.connected ? '' : ` · ${esc(c.error || 'offline')}`}</small></span>
      <span class="chip">${c.power ? esc(c.power.toUpperCase()) : '—'}</span>${c.tally ? '<span class="chip pgmc">TALLY</span>' : ''}<span class="spacer"></span>
      <label class="ctl-sel mini" title="Model series used for the command set ('auto' = from the camera's model)"><select data-series="${esc(c.id)}"><option value="">series: auto</option>${(V.seriesList || []).map((s) => `<option value="${esc(s)}" ${c.series === s && c.seriesOverride ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <button class="btn mini ${c.id === V.selected ? 'primary' : ''}" data-selcam="${esc(c.id)}" type="button">${c.id === V.selected ? 'SELECTED' : 'SELECT'}</button>
      <button class="btn mini" data-edit="${esc(c.id)}" type="button">EDIT</button><button class="btn mini danger" data-rm="${esc(c.id)}" type="button">REMOVE</button></div>`).join('') || '<div class="note">No cameras yet.</div>');
    const c = sel(); const k = catOf(c);
    if (c && !k && !catLoading.has(c.series)) { catLoading.add(c.series); api('GET', `/api/sys/ptz/cameras/${encodeURIComponent(c.id)}/catalog`).then((x) => cats.set(x.series, x)).catch(() => {}).finally(() => { catLoading.delete(c.series); renderCams(); }); }
    S.set($('#ptzRef'), 'ptz-ref', c && k ? `<div class="note small">${esc(c.name)} · ${esc(c.model || '?')} · series ${esc(k.series)} · ${k.ops.length} commands. Sources: ${esc(k.sources.module)}; ${esc(k.sources.spec)}.</div>`
      + k.ops.map((o) => `<div class="row ref-row"><span class="chip ${o.src === 'spec' ? 'spec' : o.src === 'app' ? '' : 'mod'}">${o.src === 'spec' ? 'SPEC' : o.src === 'app' ? 'APP' : 'MODULE'}</span><span class="lbl">${esc(o.label)}<small>${esc(o.id)} · ${esc(o.group)}${o.type ? ` · ${esc(o.type)}` : ''}${o.range ? ` ${o.range.min}..${o.range.max}` : ''}${o.options ? ` · ${o.options.length} values` : ''}</small></span><span class="ref-src">${esc(o.ref)}</span></div>`).join('') : '');
  }
  S.onRender((v, tab) => {
    V = v; if (!V || V.kind !== 'ptz') { releaseAll(); return; }
    if (tab === 'pctl') renderCtl(); else if (tab === 'pcams') renderCams();
  });
  // fast readouts for the camera being driven: every 500 ms while moving, every 2 s otherwise
  let lastRead = 0; let reading = false;
  setInterval(async () => {
    if (!V || V.kind !== 'ptz' || window.CC.getTab() !== 'pctl' || document.hidden || reading) return;
    const c = sel(); if (!c) return;
    if (!anyHeld() && !c.moving && Date.now() - lastRead < 2000) return;
    reading = true; lastRead = Date.now();
    try { const x = await api('GET', `/api/sys/ptz/cameras/${encodeURIComponent(c.id)}/status`); const i = V.cameras.findIndex((y) => y.id === x.id); if (i >= 0) { V.cameras[i] = x; renderCtl(); } } catch { /* the stream will bring it */ } finally { reading = false; }
  }, 500);

  // ---------- events ----------
  $('#ptzStrip').addEventListener('click', (ev) => { const b = ev.target.closest('[data-cam]'); if (b && b.dataset.cam !== V.selected) { releaseAll('camera change'); run(cmd('select', { cam: b.dataset.cam })); } });
  for (const [id, k] of [['#spPt', 'pt'], ['#spZoom', 'zoom'], ['#spFocus', 'focus']]) {
    $(id).addEventListener('input', () => { $(`${id}V`).textContent = $(id).value; V.speeds[k] = Number($(id).value); });
    $(id).addEventListener('change', () => run(cmd('speeds', { [k]: Number($(id).value) })));
  }
  document.querySelectorAll('[data-pmode]').forEach((b) => b.addEventListener('click', () => { pmode = b.dataset.pmode; renderCtl(); }));
  $('#ptzPager').addEventListener('click', (ev) => { const b = ev.target.closest('[data-page]'); if (!b) return; page = Number(b.dataset.page); localStorage.setItem('cc.ptzPage', String(page)); renderCtl(); });
  $('#ptzGrid').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cp]'); if (!b || !V) return; const n = Number(b.dataset.cp); const c = sel(); if (!c) return;
    const nm = (c.presetNames || {})[n];
    if (pmode === 'recall') return run(cmd('recall', { preset: n }));
    if (pmode === 'store') {
      if (!confirm(`Store ${c.name}'s current position as preset ${n}${nm ? ` (overwrites "${nm}")` : ''}?`)) return undefined;
      const name = prompt('Name for this preset', nm || `Preset ${n}`); if (name === null) return undefined;
      return run(cmd('store', { preset: n, name }).then(() => { thumbVer[`${c.id}:${n}`] = Date.now(); toast(`Stored preset ${n}`); }));
    }
    const name = prompt(`Name for ${c.name} preset ${n} (empty clears it)`, nm || ''); if (name === null) return undefined;
    return run(cmd('rename', { preset: n, name: name.trim() }));
  });
  $('#ptzCamList').addEventListener('change', (ev) => { const s = ev.target.closest('[data-series]'); if (!s) return; run(api('POST', `/api/sys/ptz/cameras/${s.dataset.series}`, { series: s.value }).then(() => { cats.clear(); built = ''; toast('Camera series saved'); })); });
  $('#ptzCamList').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return; const d = b.dataset;
    const c = d.selcam || d.edit || d.rm; const cam = (V.cameras || []).find((x) => x.id === c);
    if (d.selcam) return run(cmd('select', { cam: c }));
    if (d.edit) { const name = prompt('Camera name', cam.name); if (name === null) return undefined; const host = prompt('Camera IP address', cam.host); if (host === null) return undefined; const port = prompt('HTTP port', String(cam.port)); if (port === null) return undefined; return run(api('POST', `/api/sys/ptz/cameras/${c}`, { name, host, port: Number(port) || 80 }).then(() => toast('Camera saved'))); }
    if (d.rm) { if (!confirm(`Remove ${cam.name} from this system?`)) return undefined; return run(api('DELETE', `/api/sys/ptz/cameras/${c}`).then(() => toast('Camera removed'))); }
    return undefined;
  });
  $('#ptzAdd').addEventListener('submit', (ev) => {
    ev.preventDefault(); const fm = ev.target; const body = { name: fm.elements.name.value.trim(), host: fm.elements.host.value.trim(), port: Number(fm.elements.port.value) || 80 };
    run(api('POST', '/api/sys/ptz/cameras', body).then(() => { fm.reset(); toast(`Added ${body.name || 'camera'}`); }).finally(S.refetch));
  });
  window.CCPTZ = { releaseAll, held: () => ({ ...held }) };
})();
