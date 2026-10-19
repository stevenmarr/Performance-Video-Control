'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MockAquilon } = require('../lib/mock');
const { Engine } = require('../lib/engine');

process.env.RS6_QUIET = '1';

async function setup({ password = '', protocol = 'rest', awjReadback = true, autoTake = false, presetToggle = false, liveEnabled = false, pollMs = 1000, extra = {} } = {}) {
  const mock = new MockAquilon({ password });
  const restPort = await mock.startRest(0);
  const awjPort = await mock.startAwj(0);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6p-'));
  const engine = new Engine({ dataDir, settingsOverride: { host: '127.0.0.1', restPort, awjPort, password, protocol, awjReadback, autoTake, presetToggle, maxAux: 4, liveEnabled, pollMs, ...extra } });
  const teardown = async () => { engine.close(); await mock.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { mock, engine, dataDir, restPort, awjPort, teardown };
}

const restCalls = (mock, re) => mock.history.filter((h) => h.proto === 'rest' && re.test(h.path));
const awjCalls = (mock, re) => mock.history.filter((h) => h.proto === 'awj' && re.test(h.path));

const until = async (fn, ms = 3000, msg = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 15)); }
  throw new Error(`timed out waiting for ${msg}`);
};

module.exports = { setup, restCalls, awjCalls, until };
