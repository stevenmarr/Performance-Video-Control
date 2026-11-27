'use strict';
// NETWORK TEST step for the provision wizard.
// 1. Throughput check from this host (the Pi) to each camera.
// 2. Pull every camera's H.264 at once at stepped bitrates (8 / 12 / 20 / ~30 Mbps).
// 3. Measure loss, jitter and decoder stalls.
// 4. Recommend the highest clean setting that still has headroom. Never apply it here.
const { H264_STEPS } = require('./house-profile');

const DEFAULT_UNTIL_TESTED = { kbps: 20480, resolution: 1920, framerate: 60, label: 'H.264 1080/59.94p at 20 Mbps' };

const LIMITS = Object.freeze({
  lossPct: 0.5,
  jitterMs: 40,
  stalls: 0,
  headroomRatio: 1.25, // want at least 25% spare throughput vs (bitrate × camera count)
});

function failedSample(s) {
  if (!s) return 'no sample';
  if (s.error) return s.error;
  if (Number(s.lossPct) > LIMITS.lossPct) return `loss ${s.lossPct}%`;
  if (Number(s.jitterMs) > LIMITS.jitterMs) return `jitter ${s.jitterMs} ms`;
  if (Number(s.decoderStalls) > LIMITS.stalls) return `${s.decoderStalls} decoder stall(s)`;
  return null;
}

function stepResult(step, samples) {
  const reasons = (samples || []).map((s) => ({ cam: s.cam || s.id || s.ip, reason: failedSample(s) })).filter((x) => x.reason);
  return { ...step, ok: reasons.length === 0, reasons, samples };
}

function recommend(stepResults, { throughputMbps, cameraCount } = {}) {
  const passing = (stepResults || []).filter((s) => s.ok);
  if (!passing.length) {
    return { ...DEFAULT_UNTIL_TESTED, reason: 'No step stayed clean. Leaving the 20 Mbps default until the network is fixed and the test is run again.', applied: false, atCeiling: false };
  }
  // Highest passing step that still leaves headroom vs measured aggregate throughput.
  const need = (kbps) => (kbps / 1000) * (cameraCount || 1) * LIMITS.headroomRatio;
  let pick = passing[0];
  for (const s of passing) {
    if (throughputMbps == null || throughputMbps >= need(s.kbps)) pick = s;
  }
  const lastPass = passing[passing.length - 1];
  const atCeiling = pick.kbps === lastPass.kbps && lastPass === stepResults[stepResults.length - 1] && lastPass.ok;
  return {
    kbps: pick.kbps,
    requestedMbps: pick.requestedMbps,
    resolution: 1920,
    framerate: 60,
    label: `H.264 1080/59.94p at ${pick.kbps / 1000} Mbps` + (pick.note ? ` (${pick.note})` : ''),
    reason: atCeiling
      ? `The top test step stayed clean. Recommended ${pick.kbps / 1000} Mbps; there is no higher legal step to use as headroom.`
      : `Highest clean step with headroom: ${pick.kbps / 1000} Mbps.`,
    atCeiling,
    applied: false,
  };
}

async function run({ cameras, steps = H264_STEPS, throughput, pullAll, now = Date.now() } = {}) {
  const cams = cameras || [];
  const thru = [];
  let minMbps = Infinity;
  for (const cam of cams) {
    if (typeof throughput !== 'function') { thru.push({ cam: cam.id || cam.ip, skipped: true }); continue; }
    const t = await throughput(cam);
    thru.push({ cam: cam.id || cam.ip, ...t });
    if (Number(t && t.mbps) > 0) minMbps = Math.min(minMbps, t.mbps);
  }
  if (minMbps === Infinity) minMbps = null;

  const stepResults = [];
  for (const step of steps) {
    let samples = [];
    if (typeof pullAll === 'function') samples = await pullAll(cams, step) || [];
    else samples = cams.map((c) => ({ cam: c.id || c.ip, error: 'no pull function' }));
    stepResults.push(stepResult(step, samples));
  }
  const rec = recommend(stepResults, { throughputMbps: minMbps, cameraCount: cams.length });
  return {
    at: now,
    cameras: cams.map((c) => c.id || c.ip),
    throughput: thru,
    steps: stepResults,
    recommendation: rec,
    defaultUntilTested: DEFAULT_UNTIL_TESTED,
  };
}

module.exports = { DEFAULT_UNTIL_TESTED, LIMITS, H264_STEPS, failedSample, stepResult, recommend, run };
