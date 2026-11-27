'use strict';
// Deck help mode (designer Phase C, Q9): hold SYSTEM, then press any key.
// The key sends nothing. Short press of SYSTEM still opens the page-set
// chooser. Help mode ends on a short SYSTEM press, a page change, or
// CONSOLE LOCK. Hold time is 800 ms, matching the signed-off long press.

const HELP_HOLD_MS = 800;

function fresh(now = 0) {
  return { helpMode: false, systemDownAt: null, lastHelp: '', enteredAt: now };
}

function helpLine(key) {
  const k = key && typeof key === 'object' ? key : { label: String(key || '') };
  const name = String(k.label || k.name || k.title || 'Key').trim() || 'Key';
  const parts = [name];
  if (k.caption) parts[0] = `${name} · ${k.caption}`;
  const jobs = [];
  if (k.press || (k.do && k.do.press)) jobs.push(`press ${describe(k.press || k.do.press)}`);
  if (k.hold || (k.do && k.do.hold)) jobs.push(`hold ${describe(k.hold || k.do.hold)}`);
  if (k.turn || (k.do && k.do.turn)) jobs.push(`turn ${describe(k.turn || k.do.turn)}`);
  if (!jobs.length && k.help) jobs.push(String(k.help));
  if (!jobs.length && k.nav === 'home') jobs.push('press returns to HOME');
  if (!jobs.length && k.nav === 'chooser') jobs.push('press opens the page-set chooser · hold 800 ms for help');
  if (!jobs.length && k.nav === 'system') jobs.push(`press opens ${k.system || 'this system'}`);
  if (!jobs.length && k.action) jobs.push('press runs its action');
  if (k.guard) jobs.push(`guard: ${k.guard}`);
  if (jobs.length) parts.push(jobs.join(' · '));
  else parts.push('no action on this key');
  return parts.join(' — ');
}

function describe(step) {
  if (!step) return '';
  if (typeof step === 'string') return step;
  const verb = step.verb || step.action || '';
  const cap = step.cap || step.to || '';
  return [verb, cap].filter(Boolean).join(' ') || 'acts';
}

function idleStrip() {
  return 'Press a key for what it does · SYSTEM to leave';
}

function stripText(state) {
  if (!state || !state.helpMode) return '';
  return state.lastHelp || idleStrip();
}

function onSystemDown(state, now) {
  const s = state && typeof state === 'object' ? { ...state } : fresh(now);
  s.systemDownAt = Number(now) || 0;
  return s;
}

function onSystemUp(state, now, holdMs = HELP_HOLD_MS) {
  const s = state && typeof state === 'object' ? { ...state } : fresh(now);
  const down = Number(s.systemDownAt);
  const held = Number.isFinite(down) ? Math.max(0, (Number(now) || 0) - down) : 0;
  s.systemDownAt = null;
  if (s.helpMode) {
    return { ...fresh(now), action: 'exit', send: false };
  }
  const limit = Number(holdMs);
  const ms = Number.isFinite(limit) && limit > 0 ? limit : HELP_HOLD_MS;
  if (held >= ms) {
    return { helpMode: true, systemDownAt: null, lastHelp: idleStrip(), enteredAt: now, action: 'enter', send: false };
  }
  return { ...s, helpMode: false, lastHelp: '', action: 'chooser', send: true };
}

function onKey(state, key, now) {
  const s = state && typeof state === 'object' ? { ...state } : fresh(now);
  if (!s.helpMode) return { ...s, action: 'pass', send: true };
  const role = key && (key.role || key.nav);
  const label = key && String(key.label || '').toUpperCase();
  if (role === 'system-menu' || role === 'chooser' || label === 'SYSTEM') {
    return { ...fresh(now), action: 'exit', send: false };
  }
  const line = helpLine(key);
  return { ...s, lastHelp: line, action: 'describe', send: false, help: line };
}

function onPageChange(state, now) {
  return { ...fresh(now), action: 'exit', send: false, reason: 'page-change' };
}

function onConsoleLock(state, now) {
  return { ...fresh(now), action: 'exit', send: false, reason: 'console-lock' };
}

module.exports = {
  HELP_HOLD_MS, fresh, helpLine, stripText, idleStrip,
  onSystemDown, onSystemUp, onKey, onPageChange, onConsoleLock,
};
