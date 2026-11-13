'use strict';
// The tracking page talks to this. It keeps the settings file and the socket to the Mac app.
// A PTZ move that Control Center itself sends becomes an `override` message, so the tracker
// stops driving that camera instead of fighting the operator.
const { loadStore, saveStore, cleanSettings, cleanLink, withControl } = require('./settings');
const { TrackingBridge } = require('./bridge');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

class TrackingService {
  constructor({ dataDir, log = () => {}, cameras = () => [] } = {}) {
    this.log = log;
    this.camerasOf = cameras;
    this.store = loadStore(dataDir);
    this.bridge = new TrackingBridge({ log });
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
        status: status ? publicStatus(status) : { state: 'off', fps: 0, detections: [], lockedTarget: null, lastCommand: null },
      };
    });
    return { link: this.bridge.snapshot(), cameras };
  }

  setLink(body) {
    this.store.link = cleanLink(body);
    this.store.loaded = true;
    saveStore(this.store);
    this.bridge.close();
    this.bridge = new TrackingBridge({ log: this.log });
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
  };
}

module.exports = { TrackingService };
