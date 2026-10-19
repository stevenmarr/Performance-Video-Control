'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MockAquilon } = require('../lib/mock');
const { Engine } = require('../lib/engine');

process.env.RS6_QUIET = '1';

async function setup({ password = '', protocol = 'rest', awjReadback = true, autoTake = false, presetToggle = false } = {}) {
  const mock = new MockAquilon({ password });
  const restPort = await mock.startRest(0);
  const awjPort = await mock.startAwj(0);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs6p-'));
  const engine = new Engine({ dataDir, settingsOverride: { host: '127.0.0.1', restPort, awjPort, password, protocol, awjReadback, autoTake, presetToggle, maxAux: 4 } });
  const teardown = async () => { engine.device.close(); await mock.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { mock, engine, dataDir, restPort, awjPort, teardown };
}

const restCalls = (mock, re) => mock.history.filter((h) => h.proto === 'rest' && re.test(h.path));
const awjCalls = (mock, re) => mock.history.filter((h) => h.proto === 'awj' && re.test(h.path));

module.exports = { setup, restCalls, awjCalls };
