#!/usr/bin/env node
'use strict';
// Mac NDI sidecar for Lightning scopes. Receives an NDI source (macOS only) OR plays a
// fixture (--mock), and pushes Annex-B H.264 into Control Center's scopes relay.
// The app process never receives NDI. Do not run --ndi on a Raspberry Pi.
//
//   node tools/ndi-sidecar.js --mock --app http://127.0.0.1:8080
//   node tools/ndi-sidecar.js --ndi "SOURCE NAME" --app http://127.0.0.1:8080
//   node tools/ndi-sidecar.js --list
//
// --ndi needs ffmpeg built with libndi_newtek (NDI SDK), or RS6_NDI_RECV set to a
// helper executable that takes the source name as its only argument and writes
// Annex-B H.264 to stdout. RS6_NDI_FFMPEG overrides the ffmpeg binary.
const path = require('path');
const { spawn } = require('child_process');
const { loadFile } = require('../lib/scopes/sources');
const { connectIngest } = require('../lib/ndi/ingest-client');
const { hostRole, assertReceiveHost, isNdiId } = require('../lib/ndi/host');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function help() {
  console.log(`Usage:
  node tools/ndi-sidecar.js --mock [--app http://127.0.0.1:8080] [--file clip.h264] [--id sidecar-bars] [--name "SIDECAR BARS"] [--fps 30]
  node tools/ndi-sidecar.js --ndi "SOURCE NAME" [--app http://127.0.0.1:8080] [--id cam-a]
  node tools/ndi-sidecar.js --list

--mock   play an H.264 fixture (CI and machines with no NDI hardware)
--ndi    receive one NDI source on macOS and encode H.264 into the app
--list   ask ffmpeg to list NDI sources (macOS only)
--app    Control Center base URL (default http://127.0.0.1:8080)

The app accepts ingest from loopback unless it was started with RS6_NDI_INGEST_LAN=1.
NDI receive is refused on Linux and on a Raspberry Pi.`);
}

function slug(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const id = t || 'ndi';
  return id.startsWith('mock-') ? `src-${id.slice(5)}` : id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMock({ app, id, name, file, fps }) {
  const m = loadFile(file, fps ? { fps: Number(fps) } : {});
  const rate = Number(fps) || m.fps || 30;
  const cli = await connectIngest({ app, id, name, fps: rate });
  console.log(`Mock frames "${name}" (${id}) → ${app} at ${rate} fps`);
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

function ffmpegBin() { return process.env.RS6_NDI_FFMPEG || 'ffmpeg'; }

function runList() {
  assertReceiveHost();
  const child = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'info', '-f', 'libndi_newtek', '-find_sources', '1', '-i', 'dummy'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (e) => {
    if (e.code === 'ENOENT') console.error(`ffmpeg not found (${ffmpegBin()}). Install a build with libndi_newtek, or set RS6_NDI_FFMPEG.`);
    else console.error(e.message);
    process.exit(1);
  });
  child.on('close', (code) => process.exit(code === 0 ? 0 : 0));
}

async function runNdi({ app, id, name, source }) {
  assertReceiveHost();
  const cli = await connectIngest({ app, id, name, fps: 0 });
  console.log(`NDI receive "${source}" → ${app} as ${id}`);
  const child = process.env.RS6_NDI_RECV
    ? spawn(process.env.RS6_NDI_RECV, [source], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(ffmpegBin(), [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'libndi_newtek', '-i', source,
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-bf', '0', '-g', '15',
      '-f', 'h264', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { try { cli.sendBytes(d); } catch { /* socket closed */ } });
  child.stderr.on('data', (d) => process.stderr.write(d));
  const stop = () => { try { child.kill('SIGTERM'); } catch { /* */ } try { cli.close(); } catch { /* */ } process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  child.on('error', (e) => {
    if (e.code === 'ENOENT') console.error(process.env.RS6_NDI_RECV
      ? `RS6_NDI_RECV helper not found (${process.env.RS6_NDI_RECV}).`
      : `ffmpeg not found (${ffmpegBin()}). Build ffmpeg with libndi_newtek, or set RS6_NDI_RECV to a helper that writes Annex-B H.264 to stdout.`);
    else console.error(e.message);
    try { cli.close(); } catch { /* */ }
    process.exit(1);
  });
  child.on('close', (code) => {
    console.error(`NDI receiver exited (${code == null ? 'signal' : code}).`);
    try { cli.close(); } catch { /* */ }
    process.exit(code || 1);
  });
}

async function main() {
  if (arg('help', false) === true || process.argv.includes('-h')) { help(); return; }
  const role = hostRole();
  if (arg('list', false) === true) { runList(); return; }
  const ndiName = arg('ndi', null);
  const mock = arg('mock', false) === true;
  if (mock && ndiName) { console.error('Use either --mock or --ndi, not both.'); process.exit(1); }
  if (!mock && !ndiName) { help(); process.exit(1); }
  const app = String(arg('app', 'http://127.0.0.1:8080'));
  if (mock) {
    const file = String(arg('file', path.join(__dirname, '..', 'test', 'fixtures', 'scopes', 'bars.h264')));
    const name = String(arg('name', 'SIDECAR BARS'));
    const id = String(arg('id', slug(name)));
    if (!isNdiId(id) || id.startsWith('mock-')) { console.error(`Bad --id ${id} (use a-z 0-9 and hyphen; mock- is reserved for in-process fixtures).`); process.exit(1); }
    await runMock({ app, id, name, file, fps: arg('fps', '') });
    return;
  }
  if (!role.ndiReceiveAllowed) {
    try { assertReceiveHost(role); } catch (e) { console.error(e.message); process.exit(2); }
  }
  const source = String(ndiName);
  const name = String(arg('name', source));
  const id = String(arg('id', slug(name)));
  if (!isNdiId(id) || id.startsWith('mock-')) { console.error(`Bad --id ${id} (use a-z 0-9 and hyphen; mock- is reserved).`); process.exit(1); }
  await runNdi({ app, id, name, source });
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(e.code === 'NDI_HOST' ? 2 : 1); });

module.exports = { slug, assertReceiveHost };
