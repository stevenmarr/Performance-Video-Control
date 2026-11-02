'use strict';
// One path for an action: run it, time it out, record the result.
// A throw here is the action's result. It does not escape into another module.

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms} ms`);
      e.status = 504;
      reject(e);
    }, ms);
    Promise.resolve(promise).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function createDispatch(log) {
  const results = [];
  async function run({ module, instance, action, timeoutMs, run: fn }) {
    const t0 = Date.now();
    const name = action || 'action';
    try {
      const value = await withTimeout(Promise.resolve().then(fn), timeoutMs || 8000, `${module || 'core'}.${name}`);
      const row = { ok: true, module: module || 'core', instance: instance || null, action: name, ms: Date.now() - t0, t: new Date().toISOString() };
      results.push(row); if (results.length > 50) results.shift();
      return value;
    } catch (e) {
      const row = { ok: false, module: module || 'core', instance: instance || null, action: name, error: e.message || String(e), status: e.status || 500, ms: Date.now() - t0, t: new Date().toISOString() };
      results.push(row); if (results.length > 50) results.shift();
      if (log) log.write({ level: 'error', kind: 'action', msg: `${row.module}.${name} failed: ${row.error}`, instance: instance || null, action: name });
      throw e;
    }
  }
  return { run, withTimeout, recent: () => results.slice() };
}

module.exports = { createDispatch, withTimeout };
