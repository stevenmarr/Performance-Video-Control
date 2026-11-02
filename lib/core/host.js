'use strict';
// Guarded Pi power. Two steps: the first press arms, the second press (or a
// body of { confirm: 'SHUTDOWN' }) runs it. Safe mode and panel lock refuse.
// The command is not spawned unless CC_HOST_POWER=1. Tests leave that unset.

const { spawn } = require('child_process');

function token() {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 6).toUpperCase() || 'CONFIRM';
}

function defaultRunner(kind) {
  const cmd = kind === 'reboot' ? 'reboot' : 'poweroff';
  return new Promise((resolve, reject) => {
    const child = spawn('systemctl', [cmd], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ ok: true, cmd }) : reject(Object.assign(new Error(`systemctl ${cmd} exited ${code}`), { status: 500 }))));
  });
}

function createHost(log) {
  const pending = new Map();
  let runner = defaultRunner;
  const api = {
    setRunner(fn) { runner = fn; },
    pending() {
      const now = Date.now();
      for (const [k, v] of pending) if (v.until < now) pending.delete(k);
      const row = [...pending.values()][0];
      return row ? { cmd: row.cmd, confirm: row.token, until: row.until } : null;
    },
    cancel() { pending.clear(); return { pending: null }; },
    powerArmed() { return process.env.CC_HOST_POWER === '1'; },
    // Returns { pending: true } when armed, or { done: true } when executed.
    request(kind, input = {}) {
      const word = kind === 'reboot' ? 'REBOOT' : 'SHUTDOWN';
      const now = Date.now();
      const cur = pending.get(kind);
      const confirm = input.confirm;
      const matched = cur && now <= cur.until && (confirm === cur.token || confirm === word || confirm === true);
      const bare = cur && now <= cur.until && (confirm == null || confirm === '') && (now - cur.at >= 250);
      if (!matched && !bare) {
        const row = { cmd: kind, token: token(), at: now, until: now + 8000 };
        pending.set(kind, row);
        for (const key of pending.keys()) if (key !== kind) pending.delete(key);
        if (log) log.write({ level: 'warn', kind: 'power', msg: `${word} armed. Press again within 8s to confirm.` });
        return { pending: true, confirm: row.token, word, until: row.until };
      }
      pending.delete(kind);
      if (process.env.CC_HOST_POWER !== '1') {
        const e = new Error('Pi power control is not armed. Set CC_HOST_POWER=1 on the show machine.');
        e.status = 409;
        throw e;
      }
      if (log) log.write({ level: 'warn', kind: 'power', msg: `${word} confirmed` });
      return { done: true, kind, run: () => runner(kind) };
    },
  };
  return api;
}

module.exports = { createHost };
