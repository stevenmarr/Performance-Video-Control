#!/usr/bin/env node
'use strict';
// Mac Desktop Video sidecar for Scopes. Captures a DeckLink input (macOS only) OR pushes a
// fixture file (--mock, for tests), and sends Annex-B H.264 into Control Center's scopes relay.
// The app process never talks to Desktop Video. Do not run --device on a Raspberry Pi.
//
//   node tools/decklink-sidecar.js --list
//   node tools/decklink-sidecar.js --device 0 --app http://127.0.0.1:8080
//   node tools/decklink-sidecar.js --device 0 --mode 1080p5994 --name "DECKLINK 1" --id decklink-0
//   node tools/decklink-sidecar.js --mock --app http://127.0.0.1:8080
//
// --device needs tools/native/decklink-recv (built on a Mac against the DeckLink SDK) or
// RS6_DECKLINK_RECV pointing at that helper. The helper writes Annex-B H.264 to stdout.
// --mock is a test push of a fixture file. It is not a DeckLink input and it is not listed
// until this process is connected.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadFile } = require('../lib/scopes/sources');
const { connectIngest } = require('../lib/ndi/ingest-client');
const { hostRole, assertDeckLinkHost, isNdiId } = require('../lib/ndi/host');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function help() {
  console.log(`Usage:
  node tools/decklink-sidecar.js --list
  node tools/decklink-sidecar.js --device 0 [--app http://127.0.0.1:8080] [--mode auto|1080p5994] [--connection auto|SDI|HDMI] [--id decklink-0] [--name "DECKLINK 1"]
  node tools/decklink-sidecar.js --mock [--app http://127.0.0.1:8080] [--file clip.h264] [--id side-bars] [--name "SIDE BARS"] [--fps 30]

--list    print Desktop Video devices (macOS, needs decklink-recv)
--device  capture that device index and push H.264 into Control Center
--mock    push an H.264 fixture for tests (no DeckLink). Not a picker fixture by itself.
--app     Control Center base URL (default http://127.0.0.1:8080)

The app accepts ingest from loopback unless it was started with RS6_NDI_INGEST_LAN=1.
Desktop Video capture is refused on Linux and on a Raspberry Pi.`);
}

function slug(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const id = t || 'decklink';
  return id.startsWith('mock-') ? `src-${id.slice(5)}` : id;
}

function helperPath() {
  return process.env.RS6_DECKLINK_RECV || path.join(__dirname, 'native', 'decklink-recv', 'build', 'decklink-recv');
}

function missingHelperMessage(bin) {
  return [
    `Desktop Video helper is not built (${bin}).`,
    'Build it once on this Mac:',
    '  cd tools/native/decklink-recv && make',
    'The SDK stays at ~/deck-link-sdk/Blackmagic DeckLink SDK 16.0.',
    'This process does not link Desktop Video. Control Center only relays H.264.',
  ].join('\n');
}

function assertHelperPresent(bin = helperPath()) {
  if (bin && fs.existsSync(bin)) return bin;
  const err = new Error(missingHelperMessage(bin));
  err.code = 'DECKLINK_HELPER';
  throw err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMock({ app, id, name, file, fps }) {
  const m = loadFile(file, fps ? { fps: Number(fps) } : {});
  const rate = Number(fps) || m.fps || 30;
  const cli = await connectIngest({ app, id, name, fps: rate });
  console.log(`Fixture frames "${name}" (${id}) → ${app} at ${rate} fps`);
  let n = 0; const t0 = Date.now(); const period = 1000 / rate;
  let stopped = false;
  const stop = () => { stopped = true; try { cli.close(); } catch { /* */ } process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  while (!stopped) {
    cli.sendAu(m.aus[n % m.aus.length].nals);
    n++;
    const wait = t0 + n * period - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

function spawnHelper(bin, args, cli) {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (cli) child.stdout.on('data', (d) => { try { cli.sendBytes(d); } catch { /* socket closed */ } });
  else child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (e) => {
    if (e.code === 'ENOENT') console.error(missingHelperMessage(bin));
    else console.error(e.message);
    if (cli) { try { cli.close(); } catch { /* */ } }
    process.exit(1);
  });
  return child;
}

function runList() {
  assertDeckLinkHost();
  const bin = assertHelperPresent();
  const child = spawnHelper(bin, ['--list'], null);
  child.on('close', (code) => process.exit(code === 0 ? 0 : code || 1));
}

async function runDevice({ app, id, name, device, mode, connection }) {
  assertDeckLinkHost();
  const bin = assertHelperPresent();
  const cli = await connectIngest({
    app, id, name, fps: 0,
    hello: { kind: 'decklink', device: String(device), mode: mode || 'auto', connection: connection || 'auto' },
  });
  console.log(`Desktop Video device ${device} → ${app} as ${id}`);
  const args = ['--device', String(device), '--mode', mode || 'auto'];
  if (connection && connection !== true) args.push('--connection', String(connection));
  const child = spawnHelper(bin, args, cli);
  const stop = () => { try { child.kill('SIGTERM'); } catch { /* */ } try { cli.close(); } catch { /* */ } process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  child.on('close', (code) => {
    console.error(`Desktop Video helper exited (${code == null ? 'signal' : code}).`);
    try { cli.close(); } catch { /* */ }
    process.exit(code || 1);
  });
}

async function main() {
  if (arg('help', false) === true || process.argv.includes('-h')) { help(); return; }
  const list = arg('list', false) === true;
  const mock = arg('mock', false) === true;
  const device = arg('device', null);
  const modes = [list, mock, device != null && device !== false].filter(Boolean).length;
  if (modes > 1) { console.error('Use one of --list, --device, or --mock.'); process.exit(1); }
  if (list) { runList(); return; }
  if (!mock && (device == null || device === false)) { help(); process.exit(1); }
  const app = String(arg('app', 'http://127.0.0.1:8080'));
  if (mock) {
    const file = String(arg('file', path.join(__dirname, '..', 'test', 'fixtures', 'scopes', 'bars.h264')));
    const name = String(arg('name', 'SIDE BARS'));
    const id = String(arg('id', slug(name)));
    if (!isNdiId(id) || id.startsWith('mock-')) { console.error(`Bad --id ${id} (use a-z 0-9 and hyphen; mock- is reserved).`); process.exit(1); }
    await runMock({ app, id, name, file, fps: arg('fps', '') });
    return;
  }
  if (!/^\d+$/.test(String(device))) { console.error('--device needs the index from --list (0, 1, …).'); process.exit(1); }
  const role = hostRole();
  if (!role.decklinkReceiveAllowed) {
    try { assertDeckLinkHost(role); } catch (e) { console.error(e.message); process.exit(2); }
  }
  const name = String(arg('name', `DECKLINK ${device}`));
  const id = String(arg('id', `decklink-${device}`));
  if (!isNdiId(id) || id.startsWith('mock-')) { console.error(`Bad --id ${id} (use a-z 0-9 and hyphen; mock- is reserved).`); process.exit(1); }
  const mode = arg('mode', 'auto');
  const connection = arg('connection', 'auto');
  await runDevice({
    app, id, name, device: String(device),
    mode: mode === true ? 'auto' : String(mode),
    connection: connection === true ? 'auto' : String(connection),
  });
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(e.code === 'DECKLINK_HOST' || e.code === 'NDI_HOST' ? 2 : 1); });

module.exports = { slug, helperPath, missingHelperMessage, assertHelperPresent, assertDeckLinkHost };
