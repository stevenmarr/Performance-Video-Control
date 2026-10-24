#!/usr/bin/env node
'use strict';
// Mac NDI sidecar for Control Center Lightning scopes (0.20.0-dev).
//
// Receives one NDI source on a Mac and pushes H.264 access units into the app:
//   POST /api/scopes/ndi/register
//   POST /api/scopes/ndi/au          (Annex-B, one access unit per request)
// The app relays those bytes on the same WebSocket the camera RTSP → scopes path uses.
// The browser draws waveform / parade / vectorscope / false colour. Nothing here publishes
// scopes as an NDI output.
//
// The Raspberry Pi is the wrong host for NDI receive. --source and --list refuse to run
// when the machine is a Pi. The Control Center process never loads an NDI SDK.
//
// No NDI hardware (CI, demo):
//   node sidecar/ndi/ndi-sidecar.js --mock --app http://127.0.0.1:8080
// Real receive (Mac, ffmpeg built with an NDI demuxer, NDI runtime installed):
//   node sidecar/ndi/ndi-sidecar.js --source "CAM 1" --app http://127.0.0.1:8080
// Already-encoded Annex-B (a receiver you run yourself, or a fixture):
//   node sidecar/ndi/ndi-sidecar.js --frames-file clip.h264 --id cam --app http://127.0.0.1:8080

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('../../lib/scopes/h264');
const { toAnnexB } = require('../../lib/scopes/ndi-ingest');

const HELP = `Mac NDI sidecar — feeds Control Center Lightning scopes (ingest, not an NDI output).

  node sidecar/ndi/ndi-sidecar.js --mock --app http://127.0.0.1:8080
  node sidecar/ndi/ndi-sidecar.js --source "SOURCE NAME" --app http://HOST:PORT
  node sidecar/ndi/ndi-sidecar.js --frames-file clip.h264 --id lab --app http://127.0.0.1:8080
  node sidecar/ndi/ndi-sidecar.js --list

--mock            loop a built-in H.264 fixture (no NDI hardware, safe on any machine)
--frames-file     push an Annex-B .h264 file (CI stand-in for a receiver)
--source NAME     receive that NDI source via ffmpeg's NDI demuxer and encode H.264
--list            print whether ffmpeg can see an NDI demuxer (Mac). With --mock, print the mock source.
--app URL         Control Center base URL (default http://127.0.0.1:8080)
--id / --name     ingest id and label (default from the source name)
--count N         stop after N access units (mock / frames-file)
--pace MS         delay between access units (default: realtime, or 0 when --count is set)
--fixture PATH    fixture for --mock (default test/fixtures/scopes/bars.h264)

NDI receive (--source, --list) does not run on a Raspberry Pi.
`;

function isRaspberryPi() {
  if (process.env.PV_NDI_FORCE_PI === '1') return true;
  if (process.env.PV_NDI_FORCE_PI === '0') return false;
  for (const p of ['/proc/device-tree/model', '/sys/firmware/devicetree/base/model']) {
    try {
      if (/raspberry pi/i.test(fs.readFileSync(p, 'utf8').replace(/\0/g, ''))) return true;
    } catch { /* not this path */ }
  }
  return false;
}

function ndiDemuxer(text) {
  for (const line of String(text || '').split('\n')) {
    if (/libndi_newtek/.test(line)) return 'libndi_newtek';
    const m = /^\s*D[ES.]?\s+(\S+)\s+.*\bNDI\b/i.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** Argv for a Mac ffmpeg NDI receive → Annex-B H.264 on stdout. No shell. */
function receivePlan({ ffmpeg, demuxers, source }) {
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found on PATH. NDI receive runs on a Mac, not inside the Control Center app.' };
  const demuxer = ndiDemuxer(demuxers);
  if (!demuxer) return { ok: false, reason: 'ffmpeg has no NDI demuxer (libndi_newtek or ndi). Install the NDI runtime and an ffmpeg build with it. The Pi app does not receive NDI.' };
  if (!source || /[\u0000\r\n]/.test(source) || source.length > 200) return { ok: false, reason: 'NDI source name is empty or invalid' };
  const argv = [
    ffmpeg, '-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-f', demuxer, '-i', source, '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-g', '30', '-f', 'h264', 'pipe:1',
  ];
  return { ok: true, demuxer, argv };
}

function probeFfmpeg() {
  const bin = process.env.FFMPEG || 'ffmpeg';
  const r = spawnSync(bin, ['-hide_banner', '-demuxers'], { encoding: 'utf8', timeout: 8000 });
  if (r.error || r.status !== 0) return { ffmpeg: '', demuxers: '' };
  return { ffmpeg: bin, demuxers: `${r.stdout || ''}\n${r.stderr || ''}` };
}

/** Pull complete NALs out of an Annex-B byte stream. The tail (no following start code yet) stays buffered. */
function feedAnnex(state, chunk, onNal) {
  const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.buf = state.buf && state.buf.length ? Buffer.concat([state.buf, piece]) : Buffer.from(piece);
  const buf = state.buf;
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1))) starts.push(i);
  }
  if (starts.length < 2) {
    if (buf.length > 8 * 1024 * 1024) state.buf = buf.subarray(buf.length - 1024 * 1024);
    return 0;
  }
  let n = 0;
  for (let s = 0; s < starts.length - 1; s++) {
    const sc = buf[starts[s] + 2] === 1 ? 3 : 4;
    let end = starts[s + 1];
    while (end > starts[s] + sc && buf[end - 1] === 0) end--;
    if (end > starts[s] + sc) { onNal(Buffer.from(buf.subarray(starts[s] + sc, end))); n++; }
  }
  state.buf = Buffer.from(buf.subarray(starts[starts.length - 1]));
  return n;
}

function flushAnnex(state, onNal) {
  if (!state.buf || !state.buf.length) return 0;
  const nals = H.splitAnnexB(state.buf);
  for (const nal of nals) onNal(Buffer.from(nal));
  state.buf = Buffer.alloc(0);
  return nals.length;
}

function parseArgs(argv) {
  const o = {
    help: false, mock: false, list: false, source: '', app: 'http://127.0.0.1:8080',
    id: '', name: '', count: 0, pace: null, fixture: '', framesFile: '',
  };
  const take = (i, flag) => {
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--mock') o.mock = true;
    else if (a === '--list') o.list = true;
    else if (a === '--source') { o.source = take(i, a); i++; }
    else if (a === '--app') { o.app = take(i, a); i++; }
    else if (a === '--id') { o.id = take(i, a); i++; }
    else if (a === '--name') { o.name = take(i, a); i++; }
    else if (a === '--count') { o.count = Number(take(i, a)); i++; }
    else if (a === '--pace') { o.pace = Number(take(i, a)); i++; }
    else if (a === '--fixture') { o.fixture = take(i, a); i++; }
    else if (a === '--frames-file') { o.framesFile = take(i, a); i++; }
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(o.count) || o.count < 0) throw new Error('--count must be >= 0');
  if (o.pace != null && (!Number.isFinite(o.pace) || o.pace < 0)) throw new Error('--pace must be >= 0');
  return o;
}

function request(method, url, { headers = {}, body = null } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('--app must be http or https');
  const lib = u.protocol === 'https:' ? https : http;
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (res.statusCode >= 400) reject(new Error((json && json.error) || text || `HTTP ${res.statusCode}`));
        else resolve(json);
      });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(name) {
  const s = String(name || 'ndi').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return s || 'ndi';
}

async function register(app, id, name) {
  const base = String(app).replace(/\/+$/, '');
  const out = await request('POST', `${base}/api/scopes/ndi/register`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
  console.log(`ingest ${out.key} → ${base}`);
  return base;
}

async function postAu(base, id, nals, pts) {
  const body = toAnnexB(nals);
  await request('POST', `${base}/api/scopes/ndi/au?id=${encodeURIComponent(id)}`, {
    headers: { 'Content-Type': 'application/octet-stream', 'x-ndi-pts': String(pts) },
    body,
  });
}

async function pushLoaded(app, id, name, loaded, { count, pace }) {
  const base = await register(app, id, name);
  const step = pace == null ? Math.max(1, Math.round(1000 / (loaded.fps || 30))) : pace;
  const n = count > 0 ? count : Infinity;
  let i = 0;
  while (i < n) {
    if (stopped) break;
    const au = loaded.aus[i % loaded.aus.length];
    const pts = Math.round((i * 1e6) / (loaded.fps || 30));
    await postAu(base, id, au.nals, pts);
    i++;
    if (i < n && step > 0) await sleep(step);
    else if (i < n) await new Promise((r) => setImmediate(r));
  }
  console.log(`pushed ${i} access unit${i === 1 ? '' : 's'}`);
}

let stopped = false;
let child = null;

async function pushFfmpeg(app, id, name, plan) {
  const base = await register(app, id, name);
  child = spawn(plan.argv[0], plan.argv.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
  const state = { buf: Buffer.alloc(0) };
  let chain = Promise.resolve();
  let n = 0;
  const asm = new H.AccessUnitAssembler((au) => {
    const pts = Math.round((n * 1e6) / 30);
    n++;
    chain = chain.then(() => postAu(base, id, au.nals, pts));
  });
  child.stdout.on('data', (chunk) => { feedAnnex(state, chunk, (nal) => asm.push(nal)); });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => { if (code && !stopped) reject(new Error(`ffmpeg exited ${code}`)); else resolve(); });
  });
  await finished;
  flushAnnex(state, (nal) => asm.push(nal));
  asm.flush();
  await chain;
  console.log(`pushed ${n} access unit${n === 1 ? '' : 's'}`);
}

function defaultFixture() {
  return path.join(__dirname, '..', '..', 'test', 'fixtures', 'scopes', 'bars.h264');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) { console.log(HELP); return; }
  if (args.list && args.mock && !args.framesFile && !args.source) {
    console.log('mock\tNDI Mock bars\t(no hardware)');
    return;
  }
  const modes = [args.mock, !!args.framesFile, !!args.source, args.list].filter(Boolean);
  if (modes.length !== 1) throw new Error('choose one of --mock, --frames-file, --source, or --list');
  const receive = !!args.source || args.list;
  if (receive && isRaspberryPi()) {
    console.error('NDI receive is not supported on Raspberry Pi. Run this sidecar on a Mac. Control Center on the Pi only relays frames the sidecar pushes.');
    process.exit(3);
  }
  if (args.list) {
    if (args.mock) { console.log('mock\tNDI Mock bars\t(no hardware)'); return; }
    const probe = probeFfmpeg();
    const plan = receivePlan({ ...probe, source: 'list' });
    if (!plan.ok) { console.error(plan.reason); process.exit(2); }
    console.log(`ffmpeg ${probe.ffmpeg} demuxer ${plan.demuxer}`);
    console.log('Pass --source "NAME" to receive one NDI source and push it to Control Center.');
    return;
  }
  let id = args.id;
  let name = args.name;
  if (args.mock) {
    id = id || 'mock-sidecar';
    name = name || 'Mock sidecar';
    const file = args.fixture || defaultFixture();
    const { loadFile } = require('../../lib/scopes/sources');
    const loaded = loadFile(file);
    const pace = args.pace == null && args.count > 0 ? 0 : args.pace;
    await pushLoaded(args.app, id, name, loaded, { count: args.count, pace });
    return;
  }
  if (args.framesFile) {
    id = id || slug(path.basename(args.framesFile, path.extname(args.framesFile)));
    name = name || path.basename(args.framesFile);
    const { loadFile } = require('../../lib/scopes/sources');
    const loaded = loadFile(args.framesFile);
    const pace = args.pace == null && args.count > 0 ? 0 : args.pace;
    await pushLoaded(args.app, id, name, loaded, { count: args.count, pace });
    return;
  }
  id = id || slug(args.source);
  name = name || args.source;
  const plan = receivePlan({ ...probeFfmpeg(), source: args.source });
  if (!plan.ok) { console.error(plan.reason); process.exit(2); }
  console.log(`receive ${JSON.stringify(args.source)} via ffmpeg -f ${plan.demuxer} (H.264 encode on this Mac)`);
  await pushFfmpeg(args.app, id, name, plan);
}

if (require.main === module) {
  process.on('SIGINT', () => { stopped = true; if (child) child.kill('SIGINT'); });
  process.on('SIGTERM', () => { stopped = true; if (child) child.kill('SIGTERM'); });
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = {
  isRaspberryPi, ndiDemuxer, receivePlan, feedAnnex, flushAnnex, parseArgs, HELP,
};
