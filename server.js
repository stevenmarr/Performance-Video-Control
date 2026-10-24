#!/usr/bin/env node
'use strict';
// Performance Video Control Center. One desk for the show systems (RS6, E2, PixelHue, ATEM, PTZ, Pixera, Millumin).
// Usage: node server.js [--port 8080] [--host 0.0.0.0] [--data <dir>]
// --mock starts built-in simulators for tests. It is not the desk path, and it does not add NDI fixture sources.
const path = require('path');
const os = require('os');
const { Engine } = require('./lib/engine');
const { createServer } = require('./lib/server');
const { MockAquilon } = require('./lib/mock');
const { resolveDataDir, migrateLegacy } = require('./lib/datadir');
const { SystemManager } = require('./lib/systems');
const { MockE2 } = require('./lib/mocks/e2');
const { MockAtem } = require('./lib/mocks/atem');
const { MockPTZ } = require('./lib/mocks/ptz');
const { MockPixera } = require('./lib/mocks/pixera');
const { MockMillumin } = require('./lib/mocks/millumin');
const { MockPixelHue } = require('./lib/mocks/pixelhue');

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
  // 0.6.0: E2 / PixelHue. In mock mode both get a built-in mock on 127.0.0.1 and their connection is fixed.
  const sysOverrides = {}; const sysMocks = [];
  if (mock) {
    const e2 = new MockE2(); const ph = new MockPixelHue();
    sysOverrides.e2 = { host: '127.0.0.1', port: await e2.start(0) };
    sysOverrides.pixelhue = { host: '127.0.0.1', port: await ph.start(0), prefix: '/pixelhue' };
    sysMocks.push(e2, ph);
    console.log(`MOCK E2 JSON-RPC http://127.0.0.1:${sysOverrides.e2.port}  MOCK PixelHue http://127.0.0.1:${sysOverrides.pixelhue.port}/pixelhue`);
    // 0.7.0: a mock ATEM (UDP) and three mock Panasonic cameras (HTTP), all on 127.0.0.1
    // 0.10.0: --atem-model <key> picks the mock's model profile (GET /api/sys/atem/models), default the TVS HD8 ISO
    const atem = new MockAtem({ model: arg('atem-model', undefined) || undefined }); sysOverrides.atem = { host: '127.0.0.1', port: await atem.start(0), me: 1 }; sysMocks.push(atem);
    const cams = [['Cam 1 Wide', 'AW-UE150'], ['Cam 2 Stage', 'AW-UE100'], ['Cam 3 Lectern', 'AW-HE130']];
    sysOverrides.ptz = { cameras: [] };
    for (const [i, [name, model]] of cams.entries()) { const m = new MockPTZ({ model, title: name.toUpperCase().replace(/\s+/g, '-'), auth: model === 'AW-UE150' ? 'digest' : null }); sysOverrides.ptz.cameras.push({ id: `cam${i + 1}`, name, host: '127.0.0.1', port: await m.start(0) }); sysMocks.push(m); }
    console.log(`MOCK ATEM udp 127.0.0.1:${sysOverrides.atem.port}  MOCK PTZ cameras ${sysOverrides.ptz.cameras.map((c) => c.port).join(', ')}`);
    // 0.9.4: a mock Pixera (TCP JSON-RPC) and a mock Millumin (UDP OSC), both on 127.0.0.1
    const pixera = new MockPixera(); sysOverrides.pixera = { host: '127.0.0.1', port: await pixera.start(0) }; sysMocks.push(pixera);
    const millumin = new MockMillumin(); sysOverrides.millumin = { host: '127.0.0.1', port: await millumin.start(0) }; sysMocks.push(millumin);
    console.log(`MOCK Pixera tcp 127.0.0.1:${sysOverrides.pixera.port}  MOCK Millumin osc 127.0.0.1:${sysOverrides.millumin.port}`);
  }
  const systems = new SystemManager({ dataDir, engine, overrides: sysOverrides });
  const server = createServer(engine, systems);
  // Video scopes: H.264 relay (WebSocket /api/scopes/ws) + /api/scopes/*.
  // This process never receives DeckLink or NDI (not on a Pi, not in-process).
  // A Mac sidecar pushes H.264 to /api/scopes/ndi/ingest. Live video is Desktop Video.
  // --mock does not add NDI fixture sources.
  const scopes = require('./lib/scopes/service').attachScopes(server, { systems, dataDir, mock, log: (lv, m) => engine.log(lv, m) });
  server.listen(port, bind, async () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`Control Center: http://localhost:${port}${ips.map((ip) => `  http://${ip}:${port}`).join('')}`);
    console.log(`Data dir: ${dataDir}`);
    await engine.connect();
    if (mock && engine.presets.length === 0 && arg('seed', true) !== 'false') await seed(engine);
  });

  const shutdown = async () => { await scopes.close(); server.closeClients(); server.close(); await systems.close(); for (const m of sysMocks) await m.stop(); engine.close(); if (device) await device.stop(); process.exit(0); };
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
