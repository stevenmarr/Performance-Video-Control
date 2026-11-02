'use strict';
// Connection state machine for one device (or one camera under a PTZ system).
//
// States, in the order an operator should picture them:
//   disconnected → connecting → connected → degraded → reconnecting → failed
//
// `disconnected` is idle: no address yet, or the operator held the link.
// `connecting` is the first handshake, or a retry that has not succeeded before.
// `connected` means the driver says the device is answering.
// `degraded` means it is up, but only partly (one of three cameras, a slow switcher).
// `reconnecting` is the backoff wait after a drop. The link is not up.
// `failed` means the retry budget is spent. A later tick still tries again,
// so a device that comes back on its own does not stay dead.
//
// This is a plain table, same idea as lib/cue-machine.js. No XState. The app
// has no control-path dependencies, and a table you can read top to bottom is
// easier to trust on a show than an actor framework.
//
// send() returns the same object when the event is ignored. Callers use that
// as the "nothing happened" check. History is a short ring of real transitions.

const STATES = ['disconnected', 'connecting', 'connected', 'degraded', 'reconnecting', 'failed'];

function createConnection(opts = {}) {
  return {
    state: 'disconnected',
    context: {
      attempt: 0,
      nextAt: 0,
      backoffMs: 0,
      lastError: null,
      everConnected: false,
      reason: null,
      baseMs: clamp(opts.baseMs, 50, 60000, 1000),
      capMs: clamp(opts.capMs, 200, 120000, 30000),
      maxAttempts: clamp(opts.maxAttempts, 1, 50, 8),
    },
    history: [],
  };
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function backoff(ctx) {
  const step = Math.max(1, ctx.attempt);
  return Math.min(ctx.capMs, Math.round(ctx.baseMs * (2 ** (step - 1))));
}

function pushHistory(machine, entry) {
  const history = machine.history.concat(entry);
  return history.length > 40 ? history.slice(history.length - 40) : history;
}

// event.type: start, retry, up, degrade, drop, down, stop
function step(machine, event, now = Date.now()) {
  const current = machine || createConnection();
  const type = event && event.type;
  const from = current.state;
  const ctx = { ...current.context };
  let to = from;
  let changed = false;

  const go = (next) => { to = next; changed = next !== from; };

  if (type === 'stop') {
    if (from === 'disconnected' && !ctx.lastError && ctx.attempt === 0) return { machine: current, changed: false, from, to: from, event: type };
    ctx.attempt = 0; ctx.nextAt = 0; ctx.backoffMs = 0; ctx.reason = 'held'; ctx.lastError = null;
    go('disconnected');
  } else if (type === 'start') {
    if (from === 'disconnected' || from === 'failed') { ctx.reason = null; go('connecting'); }
  } else if (type === 'retry') {
    if (from === 'reconnecting') { ctx.reason = null; go('connecting'); }
  } else if (type === 'up') {
    if (from === 'connecting' || from === 'reconnecting' || from === 'degraded' || from === 'connected') {
      const was = from;
      ctx.attempt = 0; ctx.nextAt = 0; ctx.backoffMs = 0; ctx.lastError = null; ctx.reason = null; ctx.everConnected = true;
      to = 'connected';
      changed = was !== 'connected';
    }
  } else if (type === 'degrade') {
    const reason = event.reason ? String(event.reason).slice(0, 160) : 'partial';
    if (from === 'connected' || from === 'degraded' || from === 'connecting') {
      ctx.everConnected = true;
      changed = from !== 'degraded' || ctx.reason !== reason;
      ctx.reason = reason;
      to = 'degraded';
    }
  } else if (type === 'drop' || type === 'down') {
    if (from === 'connected' || from === 'degraded' || from === 'connecting' || from === 'reconnecting') {
      ctx.attempt += 1;
      ctx.backoffMs = backoff(ctx);
      ctx.nextAt = now + ctx.backoffMs;
      ctx.lastError = event.error ? String(event.error).slice(0, 200) : ctx.lastError;
      ctx.reason = ctx.lastError;
      to = ctx.attempt >= ctx.maxAttempts ? 'failed' : 'reconnecting';
      if (to === 'failed') { ctx.backoffMs = ctx.capMs; ctx.nextAt = now + ctx.capMs; }
      changed = true;
    }
  }

  if (!changed) return { machine: current, changed: false, from, to: from, event: type || '' };
  const next = {
    state: to,
    context: ctx,
    history: pushHistory(current, { t: new Date(now).toISOString(), from, to, event: type, error: ctx.lastError || null }),
  };
  return { machine: next, changed: true, from, to, event: type };
}

// The old dashboard words. The web UI still reads `link`.
function legacyLink(machine) {
  if (!machine) return 'offline';
  const ever = machine.context && machine.context.everConnected;
  switch (machine.state) {
    case 'connecting': return ever ? 'reconnecting' : 'connecting';
    case 'connected':
    case 'degraded': return 'ok';
    case 'reconnecting': return 'reconnecting';
    case 'failed': return 'offline';
    default: return 'offline';
  }
}

// True when a reconnecting or failed machine is allowed to try again.
function due(machine, now = Date.now()) {
  if (!machine) return false;
  if (machine.state !== 'reconnecting' && machine.state !== 'failed') return false;
  const at = machine.context && machine.context.nextAt;
  return !at || now >= at;
}

module.exports = { STATES, createConnection, step, legacyLink, due, backoff };
