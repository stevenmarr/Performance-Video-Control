#!/usr/bin/env node
'use strict';
require('./lib/decks/jpeg-guard').installJpegGuard();
// Performance Video Control Center. One desk for the show systems (RS6, E2, PixelHue, ATEM, PTZ, Pixera, Millumin).
// Usage: node server.js [--port 8080] [--host 0.0.0.0] [--data <dir>] [--no-companion]
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
    const vaultMod = require('./lib/ptz-provision/vault');
    const mockAdmin = vaultMod.writeGenerated(dataDir);
    const cams = [['Cam 1 Wide', 'AW-UE150'], ['Cam 2 Stage', 'AW-UE100'], ['Cam 3 Lectern', 'AW-HE130']];
    sysOverrides.ptz = { cameras: [] };
    for (const [i, [name, model]] of cams.entries()) {
      const auth = model === 'AW-UE150' ? { auth: 'digest', user: mockAdmin.user, pass: mockAdmin.pass } : { auth: null };
      const m = new MockPTZ({ model, title: name.toUpperCase().replace(/\s+/g, '-'), ...auth });
      sysOverrides.ptz.cameras.push({ id: `cam${i + 1}`, name, host: '127.0.0.1', port: await m.start(0) });
      sysMocks.push(m);
    }
    console.log(`MOCK ATEM udp 127.0.0.1:${sysOverrides.atem.port}  MOCK PTZ cameras ${sysOverrides.ptz.cameras.map((c) => c.port).join(', ')}`);
    // 0.9.4: a mock Pixera (TCP JSON-RPC) and a mock Millumin (UDP OSC), both on 127.0.0.1
    const pixera = new MockPixera(); sysOverrides.pixera = { host: '127.0.0.1', port: await pixera.start(0) }; sysMocks.push(pixera);
    const millumin = new MockMillumin(); sysOverrides.millumin = { host: '127.0.0.1', port: await millumin.start(0) }; sysMocks.push(millumin);
    console.log(`MOCK Pixera tcp 127.0.0.1:${sysOverrides.pixera.port}  MOCK Millumin osc 127.0.0.1:${sysOverrides.millumin.port}`);
  }
  const systems = new SystemManager({ dataDir, engine, overrides: sysOverrides });
  // 0.34.0: Control Center runs PV Companion (~/companion, yarn start:local) and serves it at /companion/.
  // Not in --mock (tests, demos) unless CC_COMPANION_MODE=managed. --no-companion or CC_COMPANION_MODE=external
  // keeps using a Companion started some other way.
  const { CompanionSupervisor } = require('./lib/companion/supervisor');
  const runCompanion = !process.argv.includes('--no-companion') && (!mock || process.env.CC_COMPANION_MODE === 'managed');
  const companionSupervisor = runCompanion ? new CompanionSupervisor({ dataDir }) : null;
  if (companionSupervisor) companionSupervisor.on('state', (st) => engine.log(st.state === 'error' || st.state === 'backoff' || st.state === 'not-installed' ? 'warn' : 'info', `Companion: ${st.state}${st.message ? ` · ${st.message}` : ''}`));
  const server = createServer(engine, systems, { companionSupervisor });
  require('./lib/listen').listen(server, port, bind, async () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`Control Center: http://localhost:${port}${ips.map((ip) => `  http://${ip}:${port}`).join('')}`);
    console.log(`Data dir: ${dataDir}`);
    if (server.decks) server.decks.startUsb();
    if (server.atemPanel) server.atemPanel.start(); // opens the ATEM Micro Panel only if it is enabled (ATEM page card)
    if (server.tourbox) server.tourbox.start(); // opens the TourBox NEO only if it is enabled (CAMERA CONTROL card)
    if (systems.os) systems.os.ready();
    if (companionSupervisor) { companionSupervisor.start(); console.log(`Companion: ${companionSupervisor.managed ? `started by Control Center (web UI http://localhost:${port}/companion/)` : 'runs separately (external mode)'}`); }
    if (engine.settings.mock || systems.configured('rs6')) await engine.connect();
    if (mock && engine.presets.length === 0 && arg('seed', true) !== 'false') await seed(engine);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 0.34.0: stop Companion first (SIGTERM to its process group, SIGKILL after 10 s)
    if (companionSupervisor) { try { await companionSupervisor.stop(); } catch (e) { console.error(`Stopping Companion: ${e.message}`); } }
    if (server.atemPanel) { try { await server.atemPanel.stop(); } catch { /* already stopped */ } }
    if (server.tourbox) { try { await server.tourbox.stop(); } catch { /* already stopped */ } }
    if (server.decks) {
      server.decks.stopUsb();
      try { await server.decks.usb.close(); } catch { /* already closed */ }
    }
    server.closeClients(); server.close(); await systems.close(); for (const m of sysMocks) await m.stop(); engine.close(); if (device) await device.stop(); process.exit(0);
  };
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
