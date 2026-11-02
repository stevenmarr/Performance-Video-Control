'use strict';
// Structured log. The old text log (engine.log) stays. This ring is the
// state-transition history and the core action results, for /api/health and
// /api/core/transitions. CC_LOG_JSON=1 also prints one JSON object per line.

const MAX = 500;

function createLog() {
  const events = [];
  function write(entry) {
    const e = { t: new Date().toISOString(), ...entry };
    if (e.msg) e.msg = String(e.msg).slice(0, 400);
    events.push(e);
    if (events.length > MAX) events.shift();
    if (process.env.CC_LOG_JSON === '1' && process.env.RS6_QUIET !== '1') {
      try { console.log(JSON.stringify(e)); } catch { /* ignore */ }
    }
    return e;
  }
  return {
    write,
    recent(n = 50, filter) {
      const list = filter ? events.filter(filter) : events;
      return list.slice(-n);
    },
    transitions(n = 50) {
      return events.filter((e) => e.kind === 'transition').slice(-n);
    },
  };
}

module.exports = { createLog };
