'use strict';
// The tracking page talks to this. It keeps the settings file and the socket to the Mac app.
// A PTZ move that Control Center itself sends becomes an `override` message, so the tracker
// stops driving that camera instead of fighting the operator.
const { loadStore, saveStore, cleanSettings, cleanLink, withControl, nudge } = require('./settings');
const { TrackingBridge } = require('./bridge');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

class TrackingService {
  constructor({ dataDir, log = () => {}, cameras = () => [] } = {}) {
    this.log = log;
    this.camerasOf = cameras;
    this.store = loadStore(dataDir);
    this.bridge = new TrackingBridge({ log });
    this._bindBridge();
    this.bridge.configure(this.store.link);
    if (this.store.loaded) this.bridge.connect();
  }

  close() { this.bridge.close(); }

  view(instance) {
    const cameras = this.camerasOf(instance).map((cam) => {
      const key = `${instance}:${cam.id}`;
      const status = this.bridge.statusFor(key);
      return {
        id: cam.id,
        key,
        name: cam.name,
        host: cam.host,
        port: cam.port || 80,
        settings: this.store.cameras[key] || cleanSettings({}),
        status: status ? publicStatus(status) : { state: 'off', fps: 0, detections: [], lockedTarget: null, lastCommand: null, aim: null, velocity: null },
      };
    });
    const prefix = `${instance}:`;
    return { link: this.bridge.snapshot(), cameras, profiles: (this.store.profiles || []).filter((p) => p.cameraKey.startsWith(prefix)) };
  }

  setLink(body) {
    this.store.link = cleanLink(body);
    this.store.loaded = true;
    saveStore(this.store);
    this.bridge.close();
    this.bridge = new TrackingBridge({ log: this.log });
    this._bindBridge();
    this.bridge.configure(this.store.link);
    this.bridge.connect();
    this.log('info', `tracking: link ${this.store.link.host}:${this.store.link.port}`);
    return this.bridge.snapshot();
  }

  setSettings(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    const key = `${instance}:${cam.id}`;
    this.store.cameras[key] = cleanSettings(body);
    saveStore(this.store);
    this._push(instance, cam);
    return this.view(instance);
  }

  start(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    const key = `${instance}:${cam.id}`;
    this.store.cameras[key] = cleanSettings(body.settings ? body : (this.store.cameras[key] || {}));
    saveStore(this.store);
    this._requireLink();
    this._push(instance, cam);
    this.bridge.send({ v: 1, type: 'start', cameraId: key });
    this.log('info', `tracking: start ${cam.name}`);
    return this.view(instance);
  }

  stop(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    this._requireLink();
    this.bridge.send({ v: 1, type: 'stop', cameraId: `${instance}:${cam.id}` });
    this.log('info', `tracking: stop ${cam.name}`);
    return this.view(instance);
  }

  lock(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    const targetId = String(body.targetId || '').slice(0, 40);
    if (!targetId) throw err('Choose a person to lock');
    this._requireLink();
    this.bridge.send({ v: 1, type: 'lock', cameraId: `${instance}:${cam.id}`, targetId });
    return this.view(instance);
  }

  unlock(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    this._requireLink();
    this.bridge.send({ v: 1, type: 'unlock', cameraId: `${instance}:${cam.id}` });
    return this.view(instance);
  }

  resume(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    this._requireLink();
    this.bridge.send({ v: 1, type: 'resume', cameraId: `${instance}:${cam.id}` });
    return this.view(instance);
  }

  tune(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    const key = `${instance}:${cam.id}`;
    const param = String(body.param || '');
    if (!['deadZone', 'maxSpeed', 'smoothing', 'latencyMs', 'minConfidence'].includes(param)) throw err(`Unknown tracking control "${param}"`);
    this.store.cameras[key] = nudge(this.store.cameras[key] || {}, param, body.steps, !!body.reset);
    saveStore(this.store);
    this._push(instance, cam);
    return this.view(instance);
  }

  saveProfile(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) throw err('A profile needs a name');
    const key = `${instance}:${cam.id}`;
    const settings = cleanSettings(this.store.cameras[key] || {});
    const list = this.store.profiles || [];
    const existing = list.find((p) => p.cameraKey === key && p.name.toLowerCase() === name.toLowerCase());
    const entry = { id: existing ? existing.id : `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, name, cameraKey: key, settings, at: new Date().toISOString() };
    this.store.profiles = (existing ? list.map((p) => (p.id === existing.id ? entry : p)) : [...list, entry]).slice(-24);
    saveStore(this.store);
    this.log('info', `tracking: saved profile "${name}" for ${cam.name}`);
    return this.view(instance);
  }

  loadProfile(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    const key = `${instance}:${cam.id}`;
    const entry = (this.store.profiles || []).find((p) => p.cameraKey === key && (p.id === body.id || p.name === body.name));
    if (!entry) throw err('No tracking profile by that name', 404);
    this.store.cameras[key] = cleanSettings(entry.settings);
    saveStore(this.store);
    this._push(instance, cam);
    this.log('info', `tracking: loaded profile "${entry.name}" on ${cam.name}`);
    return this.view(instance);
  }

  deleteProfile(instance, id) {
    const before = (this.store.profiles || []).length;
    this.store.profiles = (this.store.profiles || []).filter((p) => !(p.id === id && p.cameraKey.startsWith(`${instance}:`)));
    if (this.store.profiles.length === before) throw err('No tracking profile by that id', 404);
    saveStore(this.store);
    return this.view(instance);
  }

  reset(instance, body) {
    const cam = this._cam(instance, body.cam || body.cameraId);
    const key = `${instance}:${cam.id}`;
    const prev = this.store.cameras[key] || {};
    this.store.cameras[key] = cleanSettings({ feel: 'medium', preset: 'medium', detect: prev.detect, source: prev.source, streamUrl: prev.streamUrl, zoomEnabled: false });
    saveStore(this.store);
    this._push(instance, cam);
    return this.view(instance);
  }

  // camId null means every camera on the instance (ALL STOP).
  operatorMove(instance, camId, command) {
    const ids = camId ? [String(camId)] : this.camerasOf(instance).map((c) => c.id);
    for (const id of ids) {
      this.bridge.send({ v: 1, type: 'override', cameraId: `${instance}:${id}`, reason: 'operator', command: String(command || 'move') });
    }
  }

  _cam(instance, id) {
    const cam = this.camerasOf(instance).find((c) => c.id === String(id || ''));
    if (!cam) throw err(`No camera "${id || ''}"`, 404);
    if (!cam.host) throw err(`${cam.name} has no IP address`, 409);
    return cam;
  }

  _requireLink() {
    if (!this.bridge.connected) throw err('Tracker is not connected. Set the Mac address on the Tracking page.', 409);
  }

  _bindBridge() {
    this.bridge.onRemoteSettings = (cameraId, settings) => {
      if (!/^[\w-]+:[\w-]+$/.test(String(cameraId || ''))) return;
      const clean = cleanSettings(settings || {});
      if (JSON.stringify(this.store.cameras[cameraId] || null) === JSON.stringify(clean)) return;
      this.store.cameras[cameraId] = clean;
      this.store.loaded = true;
      saveStore(this.store);
    };
  }

  _push(instance, cam) {
    const key = `${instance}:${cam.id}`;
    const settings = withControl(this.store.cameras[key], cam);
    this.bridge.send({ v: 1, type: 'settings.set', cameraId: key, settings });
  }
}

function publicStatus(msg) {
  return {
    state: msg.state || 'off',
    fps: msg.fps || 0,
    detections: Array.isArray(msg.detections) ? msg.detections : [],
    lockedTarget: msg.lockedTarget || null,
    lastCommand: msg.lastCommand || null,
    aim: msg.aim || null,
    velocity: msg.velocity || null,
  };
}

module.exports = { TrackingService };
