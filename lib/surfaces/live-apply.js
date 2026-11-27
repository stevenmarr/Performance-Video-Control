'use strict';
// Page edits go live on the decks right away (designer Phase B, Q5).
// There is no SYNC step and no confirm gate. A page change mid-gesture is
// deferred until release; the value layer still updates.

const { placeCcPages } = require('./companion-pages');

function planApply({
  usb = null,
  companionPages = [],
  existingCompanionPages = [],
  midGesture = false,
  onProgram = false,
} = {}) {
  const companion = placeCcPages(existingCompanionPages, companionPages);
  const warnings = [];
  if (onProgram) {
    warnings.push({
      code: 'ON_PROGRAM',
      text: 'A target is on air: the edit still went through. The page will not change mid-gesture.',
    });
  }
  if (midGesture) {
    warnings.push({
      code: 'MID_GESTURE',
      text: 'A turn or hold is in progress: the page stays put until release. Values still update.',
    });
  }
  return {
    immediate: true,
    sync: false,
    deferPageChange: !!midGesture,
    usb,
    companion,
    warnings,
  };
}

function applyPlan(plan, hooks = {}) {
  const out = { usb: null, companion: null, deferred: false };
  if (!plan) return out;
  if (plan.deferPageChange) {
    out.deferred = true;
    if (typeof hooks.paintValues === 'function') hooks.paintValues(plan);
    return out;
  }
  if (typeof hooks.paintUsb === 'function') out.usb = hooks.paintUsb(plan.usb);
  if (typeof hooks.writeCompanion === 'function') out.companion = hooks.writeCompanion(plan.companion);
  return out;
}

module.exports = { planApply, applyPlan };
