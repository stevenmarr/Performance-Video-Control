'use strict';
// Per-module isolation. A TypeError in one driver is counted. After three in a
// row the supervisor asks the desk to close that driver and start again.
// A normal "device did not answer" error is not a crash. It does not restart
// the process, and it does not touch the next module.

function createSupervisor(log) {
  const faults = new Map();
  const restarts = new Map();
  const api = {
    limit: 3,
    onRestart: () => {},
    faults: (id) => faults.get(id) || 0,
    restarts: (id) => (id ? (restarts.get(id) || 0) : [...restarts.entries()]),
    async run(id, label, fn, opts = {}) {
      try {
        const value = await fn();
        // A poll that returns is a healthy module. A connect that returns does
        // not erase poll crashes: the next poll is what proves it is well.
        if (opts.recover !== false && faults.get(id)) faults.set(id, 0);
        return value;
      } catch (e) {
        const crash = e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError;
        if (crash) {
          const n = (faults.get(id) || 0) + 1;
          faults.set(id, n);
          if (log) log.write({ level: 'error', kind: 'fault', msg: `${id} ${label} crashed (${n}): ${e.message}`, instance: id });
          if (n >= api.limit) {
            faults.set(id, 0);
            restarts.set(id, (restarts.get(id) || 0) + 1);
            try { api.onRestart(id, e); } catch (err) {
              if (log) log.write({ level: 'error', kind: 'fault', msg: `${id} restart failed: ${err.message}`, instance: id });
            }
          }
        }
        throw e;
      }
    },
  };
  return api;
}

module.exports = { createSupervisor };
