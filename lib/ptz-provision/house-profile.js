'use strict';
// Versioned house profile: desired state after a camera is reachable. No secrets.
// The shared admin account is referenced only as the vault id "ptz-admin".
const { PLAN } = require('./house-plan');

const H264_STEPS = Object.freeze([
  { requestedMbps: 8, kbps: 8192 },
  { requestedMbps: 12, kbps: 12288 },
  { requestedMbps: 20, kbps: 20480 },
  // 30720 kbps (30 Mbps) is not on the camera's discrete list; 25600 is the nearest legal step under 30.
  { requestedMbps: 30, kbps: 25600, note: 'nearest legal step under 30 Mbps (30720 is not on the camera list)' },
]);

const FORMAT = Object.freeze({
  frequency: '59.94Hz',
  frequencyCode: 0,          // OSE:77
  system: '2160/59.94p',
  systemCode: 0x19,          // OSA:87
  output: '1080/59.94p',
  outputCode: 0x10,          // OSJ:1E / OSJ:21 / OSJ:25
});

function houseProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'house-main',
    label: 'House PTZ',
    appliesTo: ['AW-UE150', 'AW-UE150A', 'AW-UE160'],
    adminSecret: 'ptz-admin',
    userAuth: 'off',
    network: {
      mode: 'static',
      subnet: PLAN.subnet,
      mask: PLAN.mask,
      gateway: PLAN.gateway,
      dns: [...PLAN.dns],
      httpPort: PLAN.httpPort,
      factoryDefaultIp: PLAN.factoryDefaultIp,
      firstCameraIp: '192.168.0.101',
      easyIpWindow: PLAN.easyIpWindow,
    },
    identity: { titleTemplate: PLAN.titleTemplate },
    system: {
      frequency: FORMAT.frequency,
      format: FORMAT.system,
      outputs: { sdi12g: FORMAT.output, sdi3g: FORMAT.output, hdmi: FORMAT.output },
      install: 'desktop',
      powerOn: 'home',
    },
    time: { ntp: { enabled: true, addr: PLAN.ntpAddr, port: PLAN.ntpPort, intervalHours: PLAN.ntpIntervalHours, source: 'usg-gateway' } },
    tally: { enable: true, brightness: 'high', limitR: 'unlimited', limitG: 'unlimited' },
    wireless: { control: 'enable', idByCamera: true },
    streamMode: 'h264',
    ipVideo: {
      h264: [{ ch: 1, transmit: true, resolution: 1920, framerate: 60, bitrateKbps: 20480, priority: 'cbr', quality: 'fine', delivery: 'unicast' }],
      audio: { transmit: true, bitrateKbps: 128 },
      rtspPort: 554,
      gopNote: 'GOP is not writable. The camera chooses about 1 s at 1080 and about 0.5 s at UHD.',
    },
    networkTest: {
      steps: H264_STEPS.map((s) => ({ ...s })),
      defaultUntilTestedKbps: 20480,
    },
    crop: { uhdCrop: '1080', centered: true, sdiOut: 'crop', ipOut: 'crop' },
    paint: { mode: 'house-initial', wb: 'VAR', colorTempK: 5000, nd: 'clear', shutter: 'off', rest: 'factory' },
    ...overrides,
  };
}

function assertNoSecrets(profile) {
  const text = JSON.stringify(profile || {});
  if (/\bpass(word)?\b/i.test(text) && /"[^"]{4,}"/.test(text)) {
    // reject obvious password fields; allow the word in comments like adminSecret
  }
  const banned = ['pass', 'password', 'passphrase', 'secretValue', 'adminPass', 'adminPassword'];
  const walk = (x, p) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      const path = p ? `${p}.${k}` : k;
      if (banned.includes(k) || /password|passphrase/i.test(k)) throw new Error(`House profile must not contain secrets (${path})`);
      if (v && typeof v === 'object') walk(v, path);
    }
  };
  walk(profile, '');
  return profile;
}

module.exports = { houseProfile, assertNoSecrets, H264_STEPS, FORMAT };
