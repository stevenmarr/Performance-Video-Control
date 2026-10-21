#!/usr/bin/env node
'use strict';
// RS6 Presets: E2-style destination-aware presets for Analog Way Aquilon RS6, built from the memories on the device.
// Usage: node server.js [--mock] [--port 8080] [--host 0.0.0.0] [--data <dir>]
const path = require('path');
const os = require('os');
const { Engine } = require('./lib/engine');
const { createServer } = require('./lib/server');
const { MockAquilon } = require('./lib/mock');
const { resolveDataDir, migrateLegacy } = require('./lib/datadir');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  const mock = !!arg('mock', false) || process.env.RS6_MOCK === '1';
  const port = Number(arg('port', process.env.PORT || 8080));
  const bind = arg('host', process.env.HOST || '0.0.0.0');
  // 0.5.0: data lives in a per-user folder outside the app folder (lib/datadir.js), so updates keep it.
  const where = resolveDataDir({ argData: arg('data', null), mock, appDir: __dirname });
  const dataDir = where.dir;
  let migration = { migrated: false };
  if (where.source === 'default') {
    try { migration = migrateLegacy({ dataDir, appDir: __dirname }); } catch (e) { migration = { migrated: false, error: e.message }; console.error(`Data migration failed: ${e.message}`); }
  }

  let settingsOverride = {};
  let device = null;
  if (mock) {
    device = new MockAquilon({ password: process.env.RS6_MOCK_PASSWORD || '' });
    const restPort = await device.startRest(0);
    const awjPort = await device.startAwj(0);
    settingsOverride = { mock: true, host: '127.0.0.1', restPort, awjPort, https: false, password: process.env.RS6_MOCK_PASSWORD || '' };
    console.log(`MOCK device running: REST http://127.0.0.1:${restPort}  AWJ tcp 127.0.0.1:${awjPort}`);
  }

  const engine = new Engine({ dataDir, settingsOverride, dataInfo: { source: where.source, migration } });
  if (migration.migrated) engine.log('info', `First start of this version: copied ${migration.files.join(' + ')} from ${migration.from} (the old copy was left as it was)`);
  else if (where.source === 'default' && migration.reason === 'no older copy found') engine.log('info', 'First start: no older copy with presets found; starting empty');
  if (mock) {
    const origUpdate = engine.updateSettings.bind(engine);
    engine.updateSettings = (patch) => { origUpdate({ ...patch, ...settingsOverride }); };
  }
  const server = createServer(engine);
  server.listen(port, bind, async () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`RS6 Presets UI: http://localhost:${port}${ips.map((ip) => `  http://${ip}:${port}`).join('')}`);
    console.log(`Data dir: ${dataDir}`);
    await engine.connect();
    if (mock && engine.presets.length === 0 && arg('seed', true) !== 'false') await seed(engine);
  });

  const shutdown = async () => { server.closeClients(); server.close(); engine.close(); if (device) await device.stop(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

// Demo content for mock mode only: mimics Screen memories already saved on the device.
async function seed(engine) {
  const demo = [
    [1, 'Walk-in', ['S1', 'S2', 'S3'], { S1: 1, S2: 2, S3: 2 }],
    [2, 'Keynote Full', ['S1'], { S1: 10 }],
    // 0.3.3: '' = automatic name, derived from the device memory names (e.g. "IMAG L + IMAG R")
    [3, '', ['S2', 'S3'], { S2: 11, S3: 12 }],
    [4, 'Panel 4-up', ['S1', 'S2', 'S3'], { S1: 20, S2: 21, S3: 21 }],
    [5, '', ['S4'], { S4: 30 }],
    [6, '', ['A1'], { A1: 40 }],
    [7, '', ['A2'], { A2: 41 }],
    [8, 'Awards Stinger', ['S1', 'S2', 'S3', 'S4'], { S1: 50, S2: 51, S3: 51, S4: 52 }],
  ];
  for (const [number, name, destinations, memories] of demo) await engine.savePreset({ number, name, destinations, memories });
  // 0.3.0 combined presets built from the imported memories (what the board / drag-assign produces)
  const combo = [
    [9, '', [['S1', 'screen', 10], ['S2', 'screen', 32], ['S3', 'screen', 33]]],
    [10, 'Panel Master + MV', [['master', 'master', 3], ['S4', 'screen', 30], ['M1', 'multiviewer', 2]]],
    [11, '', [['master', 'master', 1]]],
    [12, '', [['master', 'master', 4]]],
  ];
  for (const [number, name, items] of combo) for (const [target, type, slot] of items) engine.assignToPreset(number, { target, type, slot, name });
  engine.log('info', 'Mock mode: seeded demo presets');
}

main().catch((e) => { console.error(e); process.exit(1); });
