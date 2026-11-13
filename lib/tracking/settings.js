'use strict';
// PTZ auto-tracking settings. The numbers match TrackingSettings in apps/ptz-tracker-mac
// (Sources/TrackingCore/Settings.swift). Control Center stores them; the Mac app clamps again on receipt.
// Speeds are the camera's own scale: 1 is a creep, 49 is full, the same range as #PTS / #Z.
const { readJson, writeJsonAtomic } = require('../store');
const path = require('path');

const PRESETS = {
  wide: { subjectHeight: 0.38, headroom: 0.16, anchorX: 0.5, lead: 0.06 },
  medium: { subjectHeight: 0.55, headroom: 0.12, anchorX: 0.5, lead: 0.08 },
  close: { subjectHeight: 0.78, headroom: 0.08, anchorX: 0.5, lead: 0.05 },
};

// Reaction, not shot size. Lecture waits. Sports commits. Medium is the show default.
const FEELS = {
  lecture: {
    deadZone: { x: 0.08, y: 0.09, size: 0.1 },
    maxSpeed: { pan: 10, tilt: 8, zoom: 4 },
    maxAccel: { pan: 28, tilt: 22, zoom: 12 },
    maxDecel: { pan: 40, tilt: 32, zoom: 16 },
    gentleSpeed: { pan: 3, tilt: 2, zoom: 2 },
    gain: { pan: 5, tilt: 5, zoom: 4 },
    axisSmoothing: { pan: 0.72, tilt: 0.75, zoom: 0.8 },
    smoothing: 0.72,
    latencyMs: 240,
    lostHoldMs: 2000,
    lostAction: 'reacquire',
    minConfidence: 0.35,
    minSubject: 0.1,
    gentle: 0.08,
    fast: 0.2,
    hysteresis: 2.2,
    jitter: 0.7,
    drift: 0.06,
  },
  medium: {
    deadZone: { x: 0.045, y: 0.05, size: 0.06 },
    maxSpeed: { pan: 18, tilt: 14, zoom: 8 },
    maxAccel: { pan: 70, tilt: 60, zoom: 30 },
    maxDecel: { pan: 90, tilt: 80, zoom: 40 },
    gentleSpeed: { pan: 6, tilt: 5, zoom: 3 },
    gain: { pan: 8, tilt: 8, zoom: 6 },
    axisSmoothing: { pan: 0.45, tilt: 0.5, zoom: 0.55 },
    smoothing: 0.45,
    latencyMs: 180,
    lostHoldMs: 1200,
    lostAction: 'reacquire',
    minConfidence: 0.4,
    minSubject: 0.08,
    gentle: 0.05,
    fast: 0.12,
    hysteresis: 1.85,
    jitter: 0.35,
    drift: 0.035,
  },
  sports: {
    deadZone: { x: 0.025, y: 0.03, size: 0.04 },
    maxSpeed: { pan: 36, tilt: 28, zoom: 16 },
    maxAccel: { pan: 160, tilt: 130, zoom: 70 },
    maxDecel: { pan: 200, tilt: 170, zoom: 90 },
    gentleSpeed: { pan: 12, tilt: 10, zoom: 6 },
    gain: { pan: 12, tilt: 12, zoom: 10 },
    axisSmoothing: { pan: 0.18, tilt: 0.22, zoom: 0.3 },
    smoothing: 0.18,
    latencyMs: 100,
    lostHoldMs: 600,
    lostAction: 'reacquire',
    minConfidence: 0.5,
    minSubject: 0.05,
    gentle: 0.02,
    fast: 0.06,
    hysteresis: 1.3,
    jitter: 0.15,
    drift: 0.015,
  },
};

const DEFAULT_LINK = { host: '127.0.0.1', port: 8765 };
const AXIS = ['pan', 'tilt', 'zoom'];

function defaults() {
  return {
    detect: 'body',
    preset: 'medium',
    feel: 'medium',
    framing: { ...PRESETS.medium },
    ...cloneFeel('medium'),
    zoomEnabled: false,
    autoLock: true,
    redetectEvery: 8,
    source: 'mjpeg',
    streamUrl: '',
    overrideResumeMs: 2000,
  };
}

function cloneFeel(name) {
  const src = FEELS[name] || FEELS.medium;
  return {
    deadZone: { ...src.deadZone },
    maxSpeed: { ...src.maxSpeed },
    maxAccel: { ...src.maxAccel },
    maxDecel: { ...src.maxDecel },
    gentleSpeed: { ...src.gentleSpeed },
    gain: { ...src.gain },
    axisSmoothing: { ...src.axisSmoothing },
    smoothing: src.smoothing,
    latencyMs: src.latencyMs,
    lostHoldMs: src.lostHoldMs,
    lostAction: src.lostAction,
    minConfidence: src.minConfidence,
    minSubject: src.minSubject,
    gentle: src.gentle,
    fast: src.fast,
    hysteresis: src.hysteresis,
    jitter: src.jitter,
    drift: src.drift,
  };
}

const unit = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback; };
const span = (v, lo, hi, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };
const axis = (src, fallback, lo, hi) => Object.fromEntries(AXIS.map((k) => [k, span(src && src[k], lo, hi, fallback[k])]));

function cleanSettings(input) {
  const src = input && input.settings && typeof input.settings === 'object' ? input.settings : (input || {});
  const base = defaults();
  const preset = PRESETS[src.preset] ? src.preset : (src.preset === 'custom' ? 'custom' : base.preset);
  const namedFeel = src.feel === 'lecture' || src.feel === 'medium' || src.feel === 'sports' || src.feel === 'custom';
  const touched = src.deadZone || src.maxSpeed || src.maxAccel || src.smoothing != null || src.latencyMs != null || src.lostHoldMs != null || src.lostAction || src.minConfidence != null;
  const feel = namedFeel ? src.feel : (touched ? 'custom' : 'medium');
  const table = feel === 'custom' ? null : cloneFeel(feel);
  const from = table || src;
  const framingIn = src.framing || {};
  let framing = {
    subjectHeight: span(framingIn.subjectHeight, 0.05, 0.95, base.framing.subjectHeight),
    headroom: span(framingIn.headroom, 0, 0.45, base.framing.headroom),
    anchorX: span(framingIn.anchorX, 0.1, 0.9, base.framing.anchorX),
    lead: span(framingIn.lead, 0, 0.3, base.framing.lead),
  };
  if (preset !== 'custom') framing = { ...PRESETS[preset] };
  const dead = from.deadZone || {};
  const speed = from.maxSpeed || {};
  const accel = from.maxAccel || {};
  const decel = from.maxDecel || accel;
  const gentleSpeed = from.gentleSpeed || {};
  const gain = from.gain || {};
  const axisSmoothing = from.axisSmoothing || {};
  const streamUrl = typeof src.streamUrl === 'string' ? src.streamUrl.trim().slice(0, 500) : '';
  const smoothing = unit(from.smoothing, base.smoothing);
  return {
    detect: src.detect === 'face' ? 'face' : 'body',
    preset,
    feel,
    framing,
    deadZone: {
      x: span(dead.x, 0, 0.4, base.deadZone.x),
      y: span(dead.y, 0, 0.4, base.deadZone.y),
      size: span(dead.size, 0, 0.4, base.deadZone.size),
    },
    maxSpeed: axis(speed, base.maxSpeed, 1, 49),
    maxAccel: axis(accel, base.maxAccel, 1, 500),
    maxDecel: axis(decel, base.maxDecel, 1, 500),
    gentleSpeed: axis(gentleSpeed, base.gentleSpeed, 1, 49),
    gain: axis(gain, base.gain, 0.5, 20),
    axisSmoothing: {
      pan: unit(axisSmoothing.pan, smoothing),
      tilt: unit(axisSmoothing.tilt, smoothing),
      zoom: unit(axisSmoothing.zoom, smoothing),
    },
    smoothing,
    latencyMs: span(from.latencyMs, 0, 2000, base.latencyMs),
    lostHoldMs: span(from.lostHoldMs, 0, 10000, base.lostHoldMs),
    lostAction: from.lostAction === 'stop' ? 'stop' : 'reacquire',
    overrideResumeMs: span(src.overrideResumeMs, 0, 30000, base.overrideResumeMs),
    zoomEnabled: src.zoomEnabled === undefined ? !!base.zoomEnabled : !!src.zoomEnabled,
    autoLock: src.autoLock === undefined ? true : !!src.autoLock,
    redetectEvery: Math.round(span(src.redetectEvery, 1, 60, base.redetectEvery)),
    minConfidence: unit(from.minConfidence, base.minConfidence),
    minSubject: span(from.minSubject, 0, 0.8, base.minSubject),
    gentle: span(from.gentle, 0, 0.5, base.gentle),
    fast: span(from.fast, 0, 0.8, base.fast),
    hysteresis: span(from.hysteresis, 1.05, 3, base.hysteresis),
    jitter: span(from.jitter, 0, 0.95, base.jitter),
    drift: span(from.drift, 0, 1, base.drift),
    source: src.source === 'jpeg' ? 'jpeg' : 'mjpeg',
    streamUrl: /^https?:\/\//i.test(streamUrl) ? streamUrl : '',
  };
}

// One encoder detent. `reset` puts that control back to the Medium feel.
function nudge(settings, param, steps, reset) {
  const current = cleanSettings({ ...(settings || {}), feel: 'custom' });
  const base = defaults();
  const n = Math.max(-20, Math.min(20, Math.round(Number(steps) || 0)));
  if (reset) {
    if (param === 'deadZone') current.deadZone = { ...base.deadZone };
    else if (param === 'maxSpeed') current.maxSpeed = { ...base.maxSpeed };
    else if (param === 'smoothing') { current.smoothing = base.smoothing; current.axisSmoothing = { ...base.axisSmoothing }; }
    else if (param === 'latencyMs') current.latencyMs = base.latencyMs;
    else if (param === 'minConfidence') current.minConfidence = base.minConfidence;
    else return current;
    return cleanSettings(current);
  }
  if (!n) return current;
  if (param === 'deadZone') {
    current.deadZone = { x: current.deadZone.x + n * 0.005, y: current.deadZone.y + n * 0.005, size: current.deadZone.size + n * 0.005 };
  } else if (param === 'maxSpeed') {
    current.maxSpeed = { pan: current.maxSpeed.pan + n, tilt: current.maxSpeed.tilt + n, zoom: current.maxSpeed.zoom };
  } else if (param === 'smoothing') {
    current.smoothing += n * 0.05;
    current.axisSmoothing = { pan: current.smoothing, tilt: current.smoothing, zoom: current.smoothing };
  } else if (param === 'latencyMs') current.latencyMs += n * 20;
  else if (param === 'minConfidence') current.minConfidence += n * 0.05;
  else return current;
  return cleanSettings(current);
}

function cleanLink(input) {
  const host = String((input && input.host) || DEFAULT_LINK.host).trim().slice(0, 200);
  const port = Math.round(Number(input && input.port));
  return {
    host: host || DEFAULT_LINK.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LINK.port,
  };
}

function cleanProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 40);
  const cameraKey = String(raw.cameraKey || '');
  if (!name || !/^[\w-]+:[\w-]+$/.test(cameraKey)) return null;
  const id = /^[\w-]{1,40}$/.test(String(raw.id || '')) ? String(raw.id) : '';
  return { id, name, cameraKey, settings: cleanSettings({ ...(raw.settings || {}), feel: (raw.settings && raw.settings.feel) || 'custom' }), at: typeof raw.at === 'string' ? raw.at : '' };
}

function fileFor(dataDir) { return path.join(dataDir, 'ptz-tracking.json'); }

function loadStore(dataDir) {
  const file = fileFor(dataDir);
  const raw = readJson(file, null);
  if (!raw || typeof raw !== 'object') return { version: 2, link: { ...DEFAULT_LINK }, cameras: {}, profiles: [], file, loaded: false };
  const cameras = {};
  const src = raw.cameras && typeof raw.cameras === 'object' ? raw.cameras : {};
  for (const [key, value] of Object.entries(src)) {
    if (!/^[\w-]+:[\w-]+$/.test(key)) continue;
    cameras[key] = cleanSettings(value);
  }
  const profiles = [];
  for (const row of Array.isArray(raw.profiles) ? raw.profiles : []) {
    const cleaned = cleanProfile(row);
    if (cleaned && cleaned.id) profiles.push(cleaned);
    if (profiles.length >= 24) break;
  }
  return { version: 2, link: cleanLink(raw.link), cameras, profiles, file, loaded: true };
}

function saveStore(store) {
  writeJsonAtomic(store.file, { version: 2, link: store.link, cameras: store.cameras, profiles: store.profiles || [] });
}

function streamFor(cam, settings) {
  if (settings.streamUrl) return settings.streamUrl;
  const host = String(cam.host || '');
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const origin = `http://${h}:${cam.port || 80}`;
  if (settings.source === 'jpeg') return `${origin}/cgi-bin/camera?resolution=640`;
  return `${origin}/cgi-bin/mjpeg?resolution=640&framerate=15`;
}

function withControl(settings, cam) {
  const user = cam.user || 'admin';
  const password = typeof cam.pass === 'string' ? cam.pass : '12345';
  return { ...settings, control: { host: cam.host, port: cam.port || 80, user, password, streamUrl: streamFor(cam, settings) } };
}

module.exports = { defaults, PRESETS, FEELS, DEFAULT_LINK, cleanSettings, nudge, cleanLink, cleanProfile, loadStore, saveStore, streamFor, withControl, fileFor };
