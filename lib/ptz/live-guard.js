'use strict';
// Red-tally live guard: which PTZ commands change the picture in a way that
// must not slip onto air. Preset recall already used this; the same hold/lock
// now covers ABB, AWB, bars, scene, menu, power, mode keys, and exposure
// long-press resets (SUGGESTIONS.md §2.4, TourBox exposure rule).

const GUARDED_OPS = new Set([
  'abb', 'awb', 'colorBars', 'colorBarsTone', 'colorBarsType', 'colorBarsSetup', 'colorBarsTitle',
  'scene', 'menu', 'power',
]);

const EXPOSURE_RESET = new Set(['iris', 'gain', 'shutterStep', 'ndFilter', 'pictureLevel']);

const GUARDED_COMMANDS = new Set(['recall', 'paintLoad', 'copyPaint', 'scene']);

function isGuardedOp(opId, { reset } = {}) {
  const id = String(opId || '');
  if (GUARDED_OPS.has(id)) return true;
  if (reset && EXPOSURE_RESET.has(id)) return true;
  return false;
}

function isGuardedCommand(name, body = {}) {
  const cmd = String(name || '');
  if (GUARDED_COMMANDS.has(cmd)) return true;
  if (cmd === 'op' || cmd === 'step') return isGuardedOp(body.op);
  if (cmd === 'reset') return isGuardedOp(body.op, { reset: true });
  if (cmd === 'power') return true;
  return false;
}

function isLive(camSt) {
  return !!(camSt && (camSt.tally || (camSt.data && camSt.data.tally) || camSt.tallyRed));
}

// Same hold / lock / off contract as preset recall.
function refuseLive(label, guard, { confirmed, action } = {}) {
  const g = guard || { mode: 'hold', holdMs: 600 };
  const recall = action === 'recall';
  const what = recall ? 'recall' : (action || 'this action');
  if (g.mode === 'lock') {
    const locked = recall ? 'preset recall from the deck is locked' : `${what} from the deck is locked`;
    const e = new Error(`PTZ ${label} is live (red tally): ${locked} (live guard LOCK)`);
    e.status = 423;
    return e;
  }
  if (g.mode === 'hold' && !confirmed) {
    const key = recall ? 'preset key' : 'key';
    const e = new Error(`PTZ ${label} is live (red tally): hold the ${key} ${g.holdMs} ms to ${what} (live guard HOLD)`);
    e.status = 423;
    return e;
  }
  return null;
}

// Exposure long-press reset is a hard block on a live camera, not hold-to-confirm.
function blockExposureReset(label) {
  const e = new Error(`PTZ ${label} is live (red tally): exposure reset is blocked`);
  e.status = 423;
  return e;
}

module.exports = { GUARDED_OPS, EXPOSURE_RESET, GUARDED_COMMANDS, isGuardedOp, isGuardedCommand, isLive, refuseLive, blockExposureReset };

