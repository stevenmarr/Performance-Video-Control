'use strict';
// 0.5.0 (Steven): "when i leave the presets tab and come back the presets are re ordered. also we need more presets
// buttons ... can any persistence be implemented so when i spin up a new instance the old configuration stays
// (every update you generate i have to re link the RS6 and re build the preset buttons)" and "update the app so
// the show file can be saved and restored". Browser-side checks are in ui.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');
const { Engine, API_VERSION } = require('../lib/engine');
const D = require('../lib/datadir');
const SH = require('../lib/shows');

const tmp = (p = 'rs6v5-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
async function withApp(opts, fn) {
  const ctx = await setup(opts);
  await ctx.engine.connect(); await ctx.engine.memoriesReady; if (ctx.engine.liveReady) await ctx.engine.liveReady;
  const server = createServer(ctx.engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  try { await fn(call, { ...ctx, base }); } finally { server.closeClients(); await new Promise((r) => server.close(r)); await ctx.teardown(); }
}
// device traffic other than the read-only subscription stream / gets
const writes = (mock) => mock.history.filter((h) => (h.proto === 'rest' && h.op !== 'GET') || (h.proto === 'awj' && h.op !== 'get' && h.path !== 'Subscriptions') || h.proto === 'state');

// ---------------- 1. persistence: data dir outside the app folder ----------------
test('default data dir per platform, overrides, mock stays separate', () => {
  assert.equal(D.defaultDataDir({ platform: 'darwin', home: '/Users/s' }), '/Users/s/Library/Application Support/RS6 Presets');
  assert.equal(D.defaultDataDir({ platform: 'linux', home: '/home/s', env: {} }), '/home/s/.config/rs6-presets');
  assert.equal(D.defaultDataDir({ platform: 'linux', home: '/home/s', env: { XDG_CONFIG_HOME: '/x' } }), '/x/rs6-presets');
  assert.equal(D.defaultDataDir({ platform: 'win32', home: 'C:\\U', env: { APPDATA: '/appdata' } }), path.join('/appdata', 'RS6 Presets'));
  const app = '/opt/rs6-presets';
  assert.deepEqual(D.resolveDataDir({ argData: '/d', env: { RS6_DATA_DIR: '/e' }, appDir: app }), { dir: '/d', source: '--data' });
  assert.deepEqual(D.resolveDataDir({ env: { RS6_DATA_DIR: '/e' }, appDir: app }), { dir: '/e', source: 'RS6_DATA_DIR' });
  assert.deepEqual(D.resolveDataDir({ env: {}, mock: true, appDir: app }), { dir: '/opt/rs6-presets/mock-data', source: 'mock' });
  assert.equal(D.resolveDataDir({ env: {}, appDir: app, platform: 'darwin', home: '/Users/s' }).source, 'default');
});

function fakeCopy(dir, { presets, settings, mtime } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), '// app');
  if (presets) fs.writeFileSync(path.join(dir, 'presets.json'), JSON.stringify({ version: 2, presets }));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  if (mtime) for (const f of ['presets.json', 'settings.json']) if (fs.existsSync(path.join(dir, f))) fs.utimesSync(path.join(dir, f), mtime, mtime);
}

test('first start copies (never moves) the newest old copy: siblings, ~/Downloads, ~/Dropbox/Downloads', () => {
  const home = tmp();
  const old = path.join(home, 'Downloads', 'rs6-presets-main');
  const newest = path.join(home, 'Dropbox', 'Downloads', 'rs6-presets');
  const appDir = path.join(home, 'Dropbox', 'Downloads', 'rs6-presets 2'); // the new version, unzipped next to it
  fakeCopy(old, { presets: [{ number: 1, name: 'old' }], settings: { host: '10.0.0.1' }, mtime: new Date('2026-10-19T12:00:00Z') });
  fakeCopy(newest, { presets: [{ number: 1, name: 'new' }, { number: 7, name: 'seven' }], settings: { host: '10.0.0.2' }, mtime: new Date('2026-10-21T12:00:00Z') });
  fakeCopy(appDir, {});
  fakeCopy(path.join(home, 'Downloads', 'not-this'), { presets: [{ number: 1, name: 'x' }] }); // name doesn't match
  fs.mkdirSync(path.join(home, 'Downloads', 'rs6-presets-empty')); // no data: ignored
  const dataDir = D.defaultDataDir({ platform: 'darwin', home });
  const cands = D.legacyCandidates({ appDir, home }).sort();
  assert.deepEqual(cands, [old, newest].sort());
  const r = D.migrateLegacy({ dataDir, appDir, home });
  assert.equal(r.migrated, true); assert.equal(r.from, newest); assert.deepEqual(r.files, ['settings.json', 'presets.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'presets.json'))).presets[1].name, 'seven');
  assert.ok(fs.existsSync(path.join(newest, 'presets.json')), 'the old copy is left as it was');
  assert.ok(fs.existsSync(path.join(dataDir, 'migrated-from.json')));
  // second start: data dir has data -> nothing happens, even if an even newer copy appears
  fakeCopy(path.join(home, 'Downloads', 'rs6-presets-x'), { presets: [{ number: 1, name: 'newer' }], mtime: new Date('2026-10-22T12:00:00Z') });
  assert.equal(D.migrateLegacy({ dataDir, appDir, home }).migrated, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'presets.json'))).presets[0].name, 'new');
  // nothing to migrate
  const h2 = tmp(); assert.equal(D.migrateLegacy({ dataDir: path.join(h2, 'd'), appDir: path.join(h2, 'app'), home: h2 }).migrated, false);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(h2, { recursive: true, force: true });
});

test('a copy with presets beats a newer one with only settings', () => {
  const home = tmp();
  fakeCopy(path.join(home, 'Downloads', 'rs6-presets-a'), { presets: [{ number: 1, name: 'A' }], mtime: new Date('2026-10-01') });
  fakeCopy(path.join(home, 'Downloads', 'rs6-presets-b'), { settings: { host: 'b' }, mtime: new Date('2026-10-20') });
  const r = D.migrateLegacy({ dataDir: path.join(home, 'data'), appDir: path.join(home, 'app'), home });
  assert.equal(path.basename(r.from), 'rs6-presets-a');
  fs.rmSync(home, { recursive: true, force: true });
});

function freePort() { return new Promise((r) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
function waitHttp(url, ms = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => { const once = () => http.get(url, (r) => { r.resume(); resolve(); }).on('error', () => (Date.now() - t0 > ms ? reject(new Error('no server')) : setTimeout(once, 150))); once(); });
}
async function runApp(appDir, home, port) {
  const env = { ...process.env, HOME: home, RS6_QUIET: '1' }; delete env.RS6_DATA_DIR; delete env.XDG_CONFIG_HOME; delete env.APPDATA;
  const p = spawn(process.execPath, [path.join(appDir, 'server.js'), '--port', String(port), '--host', '127.0.0.1'], { env, stdio: 'ignore' });
  await waitHttp(`http://127.0.0.1:${port}/api/version`);
  return p;
}
const getJson = async (u) => (await fetch(u)).json();
const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill(); });

test('a new version in a new folder starts with the old presets and settings, and keeps them after that', async () => {
  const home = tmp();
  const copyApp = (dst) => { fs.mkdirSync(dst, { recursive: true }); for (const x of ['server.js', 'package.json', 'lib', 'public']) fs.cpSync(path.join(__dirname, '..', x), path.join(dst, x), { recursive: true }); };
  const v4 = path.join(home, 'Dropbox', 'Downloads', 'rs6-presets');
  copyApp(v4);
  // what 0.4.0 left in its own folder; host points at nothing (port 9) so no device is contacted
  fs.writeFileSync(path.join(v4, 'settings.json'), JSON.stringify({ host: '127.0.0.1', restPort: 9, awjPort: 9, liveEnabled: false, password: 'secret' }));
  fs.writeFileSync(path.join(v4, 'presets.json'), JSON.stringify({ version: 2, presets: [{ number: 3, name: 'GFX CLN', destinations: ['S1'], memories: { S1: 4 } }, { number: 17, name: 'DEMO2/IMAG', destinations: ['S2'], memories: { S2: 5 } }] }));
  const v5 = path.join(home, 'Dropbox', 'Downloads', 'rs6-presets 2');
  copyApp(v5);
  const port = await freePort();
  let p = await runApp(v5, home, port);
  try {
    const st = await getJson(`http://127.0.0.1:${port}/api/state`);
    const dataDir = D.defaultDataDir({ home });
    assert.equal(st.dataDir, dataDir);
    assert.ok(!dataDir.startsWith(v5));
    assert.deepEqual(st.presets.map((x) => [x.number, x.name]), [[3, 'GFX CLN'], [17, 'DEMO2/IMAG']]);
    assert.equal(st.settings.restPort, 9); assert.equal(st.settings.passwordSet, true);
    assert.equal(st.settings.password, undefined, 'the password never goes to browsers');
    assert.equal(st.dataMigration.from, v4);
    const log = await getJson(`http://127.0.0.1:${port}/api/log`);
    assert.ok(log.some((e) => e.msg.includes(`copied settings.json + presets.json from ${v4}`)), 'the import is logged');
    assert.ok(fs.existsSync(path.join(v4, 'presets.json')));
    // change something, then "update" again: a third folder, the 0.5.0 copy deleted
    await fetch(`http://127.0.0.1:${port}/api/presets/swap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 3, b: 4 }) });
    await stop(p);
    fs.rmSync(v5, { recursive: true, force: true });
    const v6 = path.join(home, 'Downloads', 'rs6-presets-0.6.0'); copyApp(v6);
    p = await runApp(v6, home, port);
    const st2 = await getJson(`http://127.0.0.1:${port}/api/state`);
    assert.deepEqual(st2.presets.map((x) => x.number), [4, 17], 'the moved tile is still moved: the data dir was used, not the old copy');
    assert.equal(st2.settings.passwordSet, true);
  } finally { await stop(p).catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); }
});

test('working state (selection, board) is autosaved and comes back after a restart', async () => {
  const ctx = await setup();
  try {
    await ctx.engine.connect();
    ctx.engine.setSelection(['S2', 'A1']);
    ctx.engine.staging.memories = { S1: 10 };
    ctx.engine.changed();
    ctx.engine.close();
    const e2 = new Engine({ dataDir: ctx.dataDir, settingsOverride: { host: '127.0.0.1', restPort: ctx.restPort, awjPort: ctx.awjPort, liveEnabled: false } });
    assert.deepEqual([...e2.selection].sort(), ['A1', 'S2']);
    assert.deepEqual(e2.staging.memories, { S1: 10 });
    e2.close();
  } finally { await ctx.teardown(); }
});

// ---------------- 3. tile count ----------------
test('tile count: 48 by default, 24/48/72/96 accepted, anything else falls back; slots up to 96+ work', async () => {
  await withApp({}, async (call, { engine }) => {
    let st = (await call('GET', '/api/state')).json;
    assert.equal(st.tileCount, 48); assert.equal(st.settings.tileCount, 48);
    for (const n of [24, 72, 96]) { await call('POST', '/api/settings', { tileCount: n }); assert.equal((await call('GET', '/api/state')).json.tileCount, n); }
    await call('POST', '/api/settings', { tileCount: 50 }); assert.equal(engine.settings.tileCount, 48);
    await call('POST', '/api/settings', { tileCount: '72' }); assert.equal(engine.settings.tileCount, 72);
    await engine.savePreset({ number: 96, name: 'Last', destinations: ['S1'], memories: { S1: 1 } });
    assert.equal((await call('POST', '/api/presets/swap', { a: 96, b: 95 })).status, 200);
    assert.equal((await call('POST', '/api/presets/swap', { a: 95, b: 120 })).status, 200);
    st = (await call('GET', '/api/state')).json;
    assert.deepEqual(st.presets.map((p) => p.number), [120]);
  });
});

// ---------------- 4. API version ----------------
test('GET /api/version and apiVersion in the state', async () => {
  await withApp({}, async (call) => {
    const v = (await call('GET', '/api/version')).json;
    assert.equal(v.app, 'rs6-presets'); assert.equal(v.apiVersion, API_VERSION); assert.equal(v.apiVersion, 9);
    assert.equal(v.appVersion, require('../package.json').version);
    for (const f of ['swap', 'tileCount', 'shows', 'longpoll']) assert.ok(v.features.includes(f), f);
    assert.deepEqual(v.tileCounts, [24, 48, 72, 96]);
    // 0.11.0: additive features, API stays 9
    assert.equal(require('../package.json').version, '0.11.0');
    for (const f of ['uiPrefs', 'deskSave', 'followUp', 'followUpGroups', 'atemMuteAll', 'atemDeskZero']) assert.ok(v.features.includes(f), f);
    const st = (await call('GET', '/api/state')).json;
    assert.equal(st.apiVersion, 9); for (const f of ['atem', 'ptz', 'sysLongpoll', 'sysViews', 'ptzCatalog', 'companionGateway']) assert.ok(v.features.includes(f), f); assert.equal(st.appVersion, v.appVersion);
  });
});

// ---------------- 6. show files ----------------
const seed = async (engine) => {
  await engine.savePreset({ number: 1, name: 'Walk-in', destinations: ['S1', 'S2'], memories: { S1: 1, S2: 2 } });
  await engine.savePreset({ number: 7, name: 'Keynote', destinations: ['S1'], memories: { S1: 10 } });
  engine.assignToPreset(12, { target: 'master', type: 'master', slot: 3 });
};

test('show round trip: save, change everything, open restores presets at their tiles, selection, tile count, settings', async () => {
  await withApp({}, async (call, { engine, mock, dataDir }) => {
    await seed(engine);
    await call('POST', '/api/settings', { tileCount: 72, autoTake: true });
    engine.setSelection(['S2']);
    const before = (await call('GET', '/api/state')).json;
    assert.equal(before.show.name, 'Untitled show'); assert.equal(before.show.dirty, true);
    const saved = (await call('POST', '/api/shows/save', { name: 'Conference Day 1' })).json;
    assert.equal(saved.id, 'Conference Day 1');
    const file = path.join(dataDir, 'shows', 'Conference Day 1.rs6show');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(j.format, 'rs6-presets-show'); assert.equal(j.version, 2, '0.6.0: show format 2'); assert.equal(j.system, 'rs6'); assert.equal(j.tileCount, 72);
    assert.deepEqual(j.presets.map((p) => p.number), [1, 7, 12]);
    assert.equal(j.presets[2].master.slot, 3, 'Master coverage is in the preset');
    assert.deepEqual(j.selection, ['S2']); assert.equal(j.settings.autoTake, true);
    assert.equal(j.connection, null, 'no connection by default');
    assert.doesNotMatch(JSON.stringify(j), /password/i);
    let st = (await call('GET', '/api/state')).json;
    assert.equal(st.show.name, 'Conference Day 1'); assert.equal(st.show.dirty, false);
    // change everything
    await call('POST', '/api/presets/swap', { a: 1, b: 2 });
    await call('DELETE', '/api/presets/7');
    await call('POST', '/api/settings', { tileCount: 24, autoTake: false });
    engine.setSelection(['A1']);
    st = (await call('GET', '/api/state')).json;
    assert.equal(st.show.dirty, true);
    // open it again: nothing is sent to the device (first let the reconnect after the settings change finish)
    await engine.memoriesReady; await new Promise((r) => setTimeout(r, 100));
    mock.history.length = 0;
    const r = (await call('POST', '/api/shows/open', { id: 'Conference Day 1' })).json;
    assert.equal(r.connectionChanged, false); assert.ok(r.backupId);
    assert.deepEqual(mock.history, [], 'opening a show sends nothing at all to the RS6');
    st = (await call('GET', '/api/state')).json;
    assert.deepEqual(st.presets.map((p) => [p.number, p.name]), [[1, 'Walk-in'], [7, 'Keynote'], [12, st.presets[2].name]]);
    assert.equal(st.tileCount, 72); assert.equal(st.autoTake, true); assert.deepEqual(st.selection, ['S2']);
    assert.equal(st.show.dirty, false); assert.equal(st.show.name, 'Conference Day 1');
    // the automatic backup holds the state before opening
    const lib = (await call('GET', '/api/shows')).json;
    assert.equal(lib.shows.length, 1); assert.equal(lib.backups.length, 1);
    const bk = JSON.parse((await call('GET', `/api/shows/${encodeURIComponent(lib.backups[0].id)}/file?backup=1`)).text);
    assert.deepEqual(bk.presets.map((p) => p.number), [2, 12]); assert.equal(bk.tileCount, 24);
    assert.match(bk.name, /before opening Conference Day 1/);
  });
});

test('password: excluded by default, with the connection only on request, never in the state', async () => {
  await withApp({ password: 'pw123' }, async (call, { engine }) => {
    await seed(engine);
    await call('POST', '/api/shows/save', { name: 'A' });
    await call('POST', '/api/shows/save', { name: 'B', asNew: true, includeConnection: true });
    await call('POST', '/api/shows/save', { name: 'C', asNew: true, includeConnection: true, includePassword: true });
    await call('POST', '/api/shows/save', { name: 'D', asNew: true, includePassword: true }); // password without connection: ignored
    const read = async (id) => JSON.parse((await call('GET', `/api/shows/${id}/file`)).text);
    assert.equal((await read('A')).connection, null);
    const b = await read('B'); assert.equal(b.connection.host, '127.0.0.1'); assert.equal(b.connection.password, undefined);
    assert.doesNotMatch(JSON.stringify(b), /pw123/);
    assert.equal((await read('C')).connection.password, 'pw123');
    assert.doesNotMatch(JSON.stringify(await read('D')), /pw123/);
    const ex = await call('GET', '/api/show/export');
    assert.match(ex.headers.get('content-disposition'), /attachment; filename="D\.rs6show"/); // named after the current show
    assert.doesNotMatch(ex.text, /pw123/);
    assert.doesNotMatch((await call('GET', '/api/show/export?password=1')).text, /pw123/, 'password needs the connection too');
    assert.match((await call('GET', '/api/show/export?connection=1&password=1')).text, /pw123/);
    assert.doesNotMatch(JSON.stringify((await call('GET', '/api/state')).json), /pw123/);
    assert.doesNotMatch(JSON.stringify((await call('GET', '/api/shows')).json), /pw123/);
    // the backups made before opening never carry the password either
    await call('POST', '/api/shows/open', { id: 'A' });
    const lib = (await call('GET', '/api/shows')).json;
    assert.doesNotMatch((await call('GET', `/api/shows/${encodeURIComponent(lib.backups[0].id)}/file?backup=1`)).text, /pw123/);
  });
});

test('a show for another device: preview says so; the connection changes only when asked, without connecting', async () => {
  await withApp({}, async (call, { engine, mock }) => {
    await seed(engine);
    const other = { format: 'rs6-presets-show', version: 1, name: 'Other venue', tileCount: 48, presets: [{ number: 5, name: 'X', destinations: ['S1'], memories: { S1: 2 } }], connection: { host: '10.9.9.9', restPort: 80, awjPort: 10606, https: false, protocol: 'rest' } };
    const pv = (await call('POST', '/api/shows/preview', { content: JSON.stringify(other) })).json;
    assert.equal(pv.connectionDiffers, true); assert.equal(pv.connection.host, '10.9.9.9'); assert.equal(pv.presets, 1);
    let r = (await call('POST', '/api/shows/open', { content: JSON.stringify(other) })).json;
    assert.equal(r.connectionChanged, false); assert.equal(engine.settings.host, '127.0.0.1');
    mock.history.length = 0;
    r = (await call('POST', '/api/shows/open', { content: JSON.stringify(other), applyConnection: true })).json;
    assert.equal(r.connectionChanged, true); assert.equal(engine.settings.host, '10.9.9.9'); assert.equal(engine.settings.restPort, 80);
    assert.deepEqual(writes(mock), []);
    assert.equal(engine.connected, false, 'not connected until the user chooses to reconnect');
    const st = (await call('GET', '/api/state')).json;
    assert.equal(st.show.dirty, true, 'an uploaded show is unsaved until saved into the library');
    assert.deepEqual(st.presets.map((p) => p.number), [5]);
  });
});

test('migration: old presets.json (v1, v2, bare list) and a config export open as shows', () => {
  const v1 = { version: 1, presets: [{ number: 2, name: 'A', destinations: ['S1'], memories: { S1: 3 } }] };
  let r = SH.parseShow(JSON.stringify(v1));
  assert.match(r.migratedFrom, /presets\.json \(file version 1\)/); assert.deepEqual(r.show.presets.map((p) => p.number), [2]);
  assert.equal(r.show.tileCount, 48); assert.equal(r.show.connection, null);
  r = SH.parseShow([{ number: 60, name: 'B' }]);
  assert.equal(r.migratedFrom, 'presets list'); assert.equal(r.show.tileCount, 72, 'raised to fit preset 60');
  r = SH.parseShow({ settings: { host: '10.0.0.5', restPort: 80, autoTake: true, tileCount: 96 }, presets: [{ number: 1, name: 'C' }] });
  assert.equal(r.migratedFrom, 'config export'); assert.equal(r.show.tileCount, 96); assert.equal(r.show.settings.autoTake, true);
  assert.equal(r.show.connection.host, '10.0.0.5'); assert.equal(r.show.settings.host, undefined, 'connection is kept apart');
  // tile count below the highest preset is raised, with a note
  r = SH.parseShow({ format: 'rs6-presets-show', version: 1, tileCount: 24, presets: [{ number: 30 }] });
  assert.equal(r.show.tileCount, 48); assert.match(r.warnings.join(), /raised to 48/);
});

test('bad files are refused with a plain message; bad presets are skipped with a note', async () => {
  const bad = [
    ['', /empty/], ['{nope', /invalid JSON/], ['42', /Not a show/], [JSON.stringify({ hello: 1 }), /no "format"/],
    [JSON.stringify({ format: 'something-else', version: 1, presets: [] }), /Not an RS6 Presets show/],
    [JSON.stringify({ format: 'rs6-presets-show', version: 9, presets: [] }), /newer RS6 Presets.*version 9/],
    [JSON.stringify({ format: 'rs6-presets-show', version: 'x', presets: [] }), /Unknown show file version/],
    [JSON.stringify({ format: 'rs6-presets-show', version: 1 }), /no "presets" list/],
  ];
  for (const [txt, re] of bad) assert.throws(() => SH.parseShow(txt), (e) => e.status === 400 && re.test(e.message), txt);
  const r = SH.parseShow({ format: 'rs6-presets-show', version: 1, presets: [{ number: 1, name: 'a' }, { number: 1, name: 'dup' }, { number: 0 }, { number: 10000 }, null, { number: 'x' }], settings: { autoTake: 'yes', pollMs: 500, bogus: 1, password: 'x', host: 'h' } });
  assert.deepEqual(r.show.presets.map((p) => [p.number, p.name]), [[1, 'a']]);
  assert.equal(r.warnings.length, 6);
  assert.deepEqual(r.show.settings, { pollMs: 500 }, 'unknown / wrong-type / connection / password settings dropped');
  await withApp({}, async (call, { engine }) => {
    await seed(engine);
    const before = JSON.stringify(engine.presets);
    for (const [txt] of bad) {
      const res = await call('POST', '/api/shows/open', { content: txt });
      assert.equal(res.status, 400, txt); assert.ok(res.json.error);
    }
    assert.equal(JSON.stringify(engine.presets), before, 'a bad file changes nothing');
    assert.equal((await call('POST', '/api/shows/upload', { content: '{nope' })).status, 400);
    assert.equal((await call('GET', '/api/shows')).json.backups.length, 0, 'no backup made for a refused file');
  });
});

test('library: upload, rename, duplicate, delete, download; ids cannot escape the folder', async () => {
  await withApp({}, async (call, { engine, dataDir }) => {
    await seed(engine);
    const up = (await call('POST', '/api/shows/upload', { content: JSON.stringify({ format: 'rs6-presets-show', version: 1, name: 'Gala / Night', presets: [{ number: 3, name: 'Z' }] }) })).json;
    assert.equal(up.id, 'Gala Night');
    const up2 = (await call('POST', '/api/shows/upload', { content: JSON.stringify({ version: 2, presets: [] }), name: 'Gala / Night' })).json;
    assert.equal(up2.id, 'Gala Night (2)');
    assert.equal((await call('POST', '/api/shows/Gala%20Night/rename', { name: 'Gala Evening' })).json.id, 'Gala Evening');
    assert.equal((await call('POST', '/api/shows/Gala%20Evening/duplicate', { name: 'Gala Rehearsal' })).json.id, 'Gala Rehearsal');
    let lib = (await call('GET', '/api/shows')).json;
    assert.deepEqual(lib.shows.map((s) => s.id).sort(), ['Gala Evening', 'Gala Night (2)', 'Gala Rehearsal']);
    assert.equal(lib.shows.find((s) => s.id === 'Gala Rehearsal').presets, 1);
    const dl = await call('GET', '/api/shows/Gala%20Rehearsal/file');
    assert.match(dl.headers.get('content-disposition'), /Gala Rehearsal\.rs6show/);
    assert.equal(JSON.parse(dl.text).name, 'Gala Rehearsal');
    assert.equal((await call('DELETE', '/api/shows/Gala%20Night%20(2)')).status, 200);
    assert.equal((await call('DELETE', '/api/shows/nope')).status, 404);
    for (const id of ['..%2Fsettings', '.hidden', 'a%2Fb', '%2E%2E%5Csettings']) assert.equal((await call('GET', `/api/shows/${id}/file`)).status, 400, id);
    assert.ok([400, 404].includes((await call('GET', '/api/shows/%2E%2E/file')).status)); // URL parsing already drops ..
    lib = (await call('GET', '/api/shows')).json;
    assert.equal(lib.shows.length, 2); assert.equal(lib.dir, path.join(dataDir, 'shows'));
    // backups are capped
    for (let i = 0; i < 33; i++) engine.library.backup(engine.buildShow({ name: `b${i}` }));
    assert.equal(engine.library.list(true).length, 30);
  });
});

test('New show clears presets after a backup; dirty dot follows changes', async () => {
  await withApp({}, async (call, { engine, mock }) => {
    await seed(engine);
    await call('POST', '/api/shows/save', { name: 'Keep' });
    assert.equal((await call('GET', '/api/state')).json.show.dirty, false);
    await call('POST', '/api/presets/swap', { a: 1, b: 3 });
    assert.equal((await call('GET', '/api/state')).json.show.dirty, true);
    await call('POST', '/api/presets/swap', { a: 3, b: 1 });
    assert.equal((await call('GET', '/api/state')).json.show.dirty, false, 'back to the saved content = clean');
    mock.history.length = 0;
    const r = (await call('POST', '/api/shows/new', { name: 'Fresh' })).json;
    assert.ok(r.backupId); assert.deepEqual(mock.history, []);
    const st = (await call('GET', '/api/state')).json;
    assert.equal(st.presets.length, 0); assert.equal(st.show.name, 'Fresh');
    // Save after rename keeps the same file; Save with a different name = save as
    await call('POST', '/api/shows/save', {});
    await call('POST', '/api/shows/save', { name: 'Fresh 2' });
    assert.deepEqual((await call('GET', '/api/shows')).json.shows.map((s) => s.id).sort(), ['Fresh', 'Fresh 2', 'Keep']);
  });
});
