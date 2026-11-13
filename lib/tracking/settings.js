'use strict';
// PTZ auto-tracking settings. The numbers match TrackingSettings in apps/ptz-tracker-mac
// (Sources/TrackingCore/Settings.swift). Control Center stores them; the Mac app clamps again on receipt.
const { readJson, writeJsonAtomic } = require('../store');
const path = require('path');

const PRESETS = {
  wide: { subjectHeight: 0.38, headroom: 0.16, anchorX: 0.5, lead: 0.06 },
  medium: { subjectHeight: 0.55, headroom: 0.12, anchorX: 0.5, lead: 0.08 },
  close: { subjectHeight: 0.78, headroom: 0.08, anchorX: 0.5, lead: 0.05 },
};

const DEFAULT_LINK = { host: '127.0.0.1', port: 8765 };

function defaults() {
  return {
    detect: 'body',
    preset: 'medium',
    framing: { ...PRESETS.medium },
    deadZone: { x: 0.045, y: 0.05, size: 0.06 },
    maxSpeed: { pan: 18, tilt: 14, zoom: 8 },
    maxAccel: { pan: 70, tilt: 60, zoom: 30 },
    smoothing: 0.45,
    latencyMs: 180,
    lostHoldMs: 1200,
    lostAction: 'reacquire',
    overrideResumeMs: 2000,
    zoomEnabled: false,
    autoLock: true,
    redetectEvery: 8,
    minConfidence: 0.4,
    source: 'mjpeg',
    streamUrl: '',
  };
}

const unit = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback; };
const span = (v, lo, hi, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };

function cleanSettings(input) {
  const src = input && input.settings && typeof input.settings === 'object' ? input.settings : (input || {});
  const base = defaults();
  const preset = PRESETS[src.preset] ? src.preset : (src.preset === 'custom' ? 'custom' : base.preset);
  const framingIn = src.framing || {};
  let framing = {
    subjectHeight: span(framingIn.subjectHeight, 0.05, 0.95, base.framing.subjectHeight),
    headroom: span(framingIn.headroom, 0, 0.45, base.framing.headroom),
    anchorX: span(framingIn.anchorX, 0.1, 0.9, base.framing.anchorX),
    lead: span(framingIn.lead, 0, 0.3, base.framing.lead),
  };
  if (preset !== 'custom') framing = { ...PRESETS[preset] };
  const dead = src.deadZone || {};
  const speed = src.maxSpeed || {};
  const accel = src.maxAccel || {};
  const streamUrl = typeof src.streamUrl === 'string' ? src.streamUrl.trim().slice(0, 500) : '';
  return {
    detect: src.detect === 'face' ? 'face' : 'body',
    preset,
    framing,
    deadZone: {
      x: span(dead.x, 0, 0.4, base.deadZone.x),
      y: span(dead.y, 0, 0.4, base.deadZone.y),
      size: span(dead.size, 0, 0.4, base.deadZone.size),
    },
    maxSpeed: {
      pan: span(speed.pan, 1, 49, base.maxSpeed.pan),
      tilt: span(speed.tilt, 1, 49, base.maxSpeed.tilt),
      zoom: span(speed.zoom, 1, 49, base.maxSpeed.zoom),
    },
    maxAccel: {
      pan: span(accel.pan, 1, 500, base.maxAccel.pan),
      tilt: span(accel.tilt, 1, 500, base.maxAccel.tilt),
      zoom: span(accel.zoom, 1, 500, base.maxAccel.zoom),
    },
    smoothing: unit(src.smoothing, base.smoothing),
    latencyMs: span(src.latencyMs, 0, 2000, base.latencyMs),
    lostHoldMs: span(src.lostHoldMs, 0, 10000, base.lostHoldMs),
    lostAction: src.lostAction === 'stop' ? 'stop' : 'reacquire',
    overrideResumeMs: span(src.overrideResumeMs, 0, 30000, base.overrideResumeMs),
    zoomEnabled: !!src.zoomEnabled,
    autoLock: src.autoLock === undefined ? true : !!src.autoLock,
    redetectEvery: Math.round(span(src.redetectEvery, 1, 60, base.redetectEvery)),
    minConfidence: unit(src.minConfidence, base.minConfidence),
    source: src.source === 'jpeg' ? 'jpeg' : 'mjpeg',
    streamUrl: /^https?:\/\//i.test(streamUrl) ? streamUrl : '',
  };
}

function cleanLink(input) {
  const host = String((input && input.host) || DEFAULT_LINK.host).trim().slice(0, 200);
  const port = Math.round(Number(input && input.port));
  return {
    host: host || DEFAULT_LINK.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LINK.port,
  };
}

function fileFor(dataDir) { return path.join(dataDir, 'ptz-tracking.json'); }

function loadStore(dataDir) {
  const file = fileFor(dataDir);
  const raw = readJson(file, null);
  if (!raw || typeof raw !== 'object') return { version: 1, link: { ...DEFAULT_LINK }, cameras: {}, file, loaded: false };
  const cameras = {};
  const src = raw.cameras && typeof raw.cameras === 'object' ? raw.cameras : {};
  for (const [key, value] of Object.entries(src)) {
    if (!/^[\w-]+:[\w-]+$/.test(key)) continue;
    cameras[key] = cleanSettings(value);
  }
  return { version: 1, link: cleanLink(raw.link), cameras, file, loaded: true };
}

function saveStore(store) {
  writeJsonAtomic(store.file, { version: 1, link: store.link, cameras: store.cameras });
}

// The address the Mac opens. JPEG uses the snapshot CGI this app already proxies; MJPEG is the live stream.
function streamFor(cam, settings) {
  if (settings.streamUrl) return settings.streamUrl;
  const host = String(cam.host || '');
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const origin = `http://${h}:${cam.port || 80}`;
  if (settings.source === 'jpeg') return `${origin}/cgi-bin/camera?resolution=640`;
  return `${origin}/cgi-bin/mjpeg?resolution=640&framerate=15`;
}

// Attached on the wire only. The password stays out of ptz-tracking.json and out of GET answers.
function withControl(settings, cam) {
  const user = cam.user || 'admin';
  const password = typeof cam.pass === 'string' ? cam.pass : '12345';
  return { ...settings, control: { host: cam.host, port: cam.port || 80, user, password, streamUrl: streamFor(cam, settings) } };
}

module.exports = { defaults, PRESETS, DEFAULT_LINK, cleanSettings, cleanLink, loadStore, saveStore, streamFor, withControl, fileFor };
