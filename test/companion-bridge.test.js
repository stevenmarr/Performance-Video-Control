'use strict';
// 0.31.0 COMPANION tab: CC buttons and pages go to Companion through the module
// (GET /api/companion/buttons, POST .../run, hello, sync) or as a page export.
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ButtonLibrary } = require('../lib/decks/button-library');
const { CompanionBridge, semverAtLeast } = require('../lib/companion/bridge');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-companion-'));

function sample(data) {
  const lib = new ButtonLibrary({ dataDir: data });
  const cut = lib.createButton({ name: 'CUT', role: 'hot', text: 'CUT', actions: { press: [{ action: 'atem.cut' }] } });
  const iris = lib.createButton({ name: 'Iris', role: 'toggle', element: 'encoder', text: 'IRIS', actions: { turn: [{ action: 'ptz.iris' }], push: [{ action: 'ptz.iris' }] } });
  const seg = lib.createButton({ name: 'Iris value', role: 'info', element: 'touch-segment', text: 'IRIS', actions: { touch: [{ action: 'nav.home' }] } });
  const page = lib.createPage({ name: 'Show ATEM', surface: 'plusxl', keys: [{ row: 3, col: 8, buttonId: cut.id }], encoders: [{ col: 2, buttonId: iris.id }], touch: [{ col: 2, buttonId: seg.id }] });
  return { lib, cut, iris, seg, page };
}

test('the buttons model lists every CC button and page, with the + XL strip and knobs below the keys', () => {
  const data = dir();
  const { lib, cut, page } = sample(data);
  const bridge = new CompanionBridge({ dataDir: data, buttons: lib, appVersion: '0.31.0', apiVersion: 9 });
  const model = bridge.buttonsModel();
  assert.equal(model.moduleId, 'rs6-presets');
  assert.equal(model.buttons.length, 3);
  const b = model.buttons.find((x) => x.id === cut.id);
  assert.deepEqual(b.events, ['press']);
  assert.match(b.look.bgcolor, /^#/);
  const p = model.pages.find((x) => x.id === page.id);
  assert.equal(p.layout.rows, 4);
  assert.equal(p.layout.touchRow, 4);
  assert.equal(p.layout.encoderRow, 5);
  assert.deepEqual(p.layout.knobCols, [0, 2, 3, 5, 6, 8]);
  assert.equal(p.layout.companionLayout, 'streamdeck-plus-xl');
  const rev = model.rev;
  assert.equal(bridge.buttonsModel().rev, rev, 'rev is stable');
  bridge.sync();
  assert.notEqual(bridge.buttonsModel().rev, rev, 'SYNC changes rev');
  const rev2 = bridge.rev();
  lib.renamePage(page.id, 'Show ATEM 2');
  assert.notEqual(bridge.rev(), rev2, 'a page edit changes rev');
  fs.rmSync(data, { recursive: true, force: true });
});

test('a page export is a Companion version 6 page with keys on top, then touch, then encoders', () => {
  const data = dir();
  const { lib, cut, iris, seg, page } = sample(data);
  const bridge = new CompanionBridge({ dataDir: data, buttons: lib });
  const out = bridge.companionConfig(page.id);
  assert.equal(out.name, 'Show ATEM.companionconfig');
  const j = JSON.parse(out.body);
  assert.equal(j.version, 6);
  assert.equal(j.type, 'page');
  assert.equal(j.page.surfaceLayout, 'streamdeck-plus-xl');
  assert.deepEqual(j.page.gridSize, { minColumn: 0, maxColumn: 8, minRow: 0, maxRow: 5 });
  const conn = Object.keys(j.instances)[0];
  assert.equal(j.instances[conn].moduleId, 'rs6-presets');
  const key = j.page.controls[3][8];
  assert.equal(key.type, 'button');
  assert.equal(key.steps[0].action_sets.down[0].action, 'cc_button_run');
  assert.equal(key.steps[0].action_sets.down[0].instance, conn);
  assert.deepEqual(key.steps[0].action_sets.down[0].options, { button: cut.id, event: 'press', delta: '' });
  assert.equal(key.feedbacks[0].type, 'cc_button_look');
  assert.equal(key.feedbacks[0].instance_id, conn);
  assert.equal(typeof key.style.bgcolor, 'number');
  const touch = j.page.controls[4][2];
  assert.equal(touch.steps[0].action_sets.down[0].options.button, seg.id);
  const knob = j.page.controls[5][2];
  assert.equal(knob.options.rotaryActions, true);
  assert.equal(knob.steps[0].action_sets.rotate_left[0].options.delta, '-1');
  assert.equal(knob.steps[0].action_sets.rotate_right[0].options.button, iris.id);
  assert.equal(knob.steps[0].action_sets.down[0].options.event, 'push');
  assert.equal(j.page.controls[0], undefined, 'nothing is drawn above the keys');
  assert.doesNotMatch(out.body, /secret|password/i);
  fs.rmSync(data, { recursive: true, force: true });
});

test('runButton runs the event through the deck action path; hello records the module version', async () => {
  const data = dir();
  const { lib, cut, iris, seg } = sample(data);
  const calls = [];
  const decks = { runAction: async (req) => { calls.push(req); return { ok: true }; } };
  const bridge = new CompanionBridge({ dataDir: data, buttons: lib, decks });
  const r = await bridge.runButton(cut.id, {});
  assert.equal(r.ok, true);
  assert.equal(r.event, 'press');
  assert.equal(calls[0].path, '/api/sys/atem/cmd/cut');
  const t = await bridge.runButton(iris.id, { event: 'turn', delta: -2 });
  assert.equal(t.event, 'turn');
  assert.equal(calls[1].body.steps, -2);
  const s = await bridge.runButton(seg.id, {});
  assert.equal(s.ran[0].skipped, 'No route for this action yet');
  await assert.rejects(() => bridge.runButton(cut.id, { event: 'explode' }), (e) => e.status === 400);
  assert.equal(bridge.view().module, null);
  bridge.hello({ moduleVersion: '0.9.9', label: 'cc' });
  assert.equal(bridge.view().module.current, false);
  bridge.hello({ moduleVersion: '0.10.0', label: 'cc', rev: bridge.rev() });
  assert.equal(bridge.view().module.current, true);
  assert.equal(bridge.view().module.stale, false);
  assert.ok(semverAtLeast('1.0.0', '0.10.0'));
  assert.ok(!semverAtLeast('0.8.1', '0.10.0'));
  fs.rmSync(data, { recursive: true, force: true });
});

test('config is host and port only, saved to companion.json; check tells Companion, HTTP API off, and offline apart', async () => {
  const data = dir();
  const lib = new ButtonLibrary({ dataDir: data });
  let mode = 'api';
  const fake = http.createServer((req, res) => {
    res.setHeader('X-App', 'Bitfocus Companion');
    if (req.url === '/api/connections' && mode === 'api') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ id: 'c1', label: 'cc', moduleId: 'rs6-presets', enabled: true, status: { category: 'good' } }, { id: 'c2', label: 'atem', moduleId: 'bmd-atem', enabled: true }]));
    }
    res.statusCode = mode === 'api' ? 200 : 404;
    res.end('<html><title>Bitfocus Companion</title></html>');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  try {
    const bridge = new CompanionBridge({ dataDir: data, buttons: lib });
    assert.equal(bridge.view().config.port, 8000);
    assert.equal(bridge.view().webUrl, 'http://127.0.0.1:8000');
    assert.throws(() => bridge.setConfig({ host: 'bad host!', port: 1 }), (e) => e.status === 400);
    assert.throws(() => bridge.setConfig({ host: '127.0.0.1', port: 70000 }), (e) => e.status === 400);
    bridge.setConfig({ host: '127.0.0.1', port });
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'companion.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['host', 'port', 'syncSeq', 'syncedAt']);
    let v = await bridge.check();
    assert.equal(v.status.online, true);
    assert.equal(v.status.httpApi, true);
    assert.deepEqual(v.status.connections.map((c) => c.label), ['cc']);
    mode = 'noapi';
    v = await bridge.check();
    assert.equal(v.status.online, true);
    assert.equal(v.status.httpApi, false);
    assert.match(v.status.error, /HTTP API is off/);
    fake.close();
    bridge.setConfig({ host: '127.0.0.1', port });
    v = await bridge.check();
    assert.equal(v.status.online, false);
    const again = new CompanionBridge({ dataDir: data, buttons: lib });
    assert.equal(again.view().config.port, port);
  } finally {
    fake.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('HTTP: /api/companion routes, the page export download, and copy / reorder pages', async () => {
  const data = dir();
  const { Engine } = require('../lib/engine');
  const { createServer } = require('../lib/server');
  const engine = new Engine({ dataDir: data });
  const server = createServer(engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  try {
    const b = JSON.parse((await call('POST', '/api/buttons', { name: 'CUT', role: 'hot', text: 'CUT', actions: { press: [{ action: 'atem.cut' }] } })).text);
    const p = JSON.parse((await call('POST', '/api/surface-pages', { name: 'Show', surface: 'xl', keys: [{ row: 0, col: 0, buttonId: b.id }] })).text);
    const view = JSON.parse((await call('GET', '/api/companion')).text);
    assert.equal(view.counts.pages, 1);
    assert.equal(view.moduleId, 'rs6-presets');
    const model = JSON.parse((await call('GET', '/api/companion/buttons')).text);
    assert.equal(model.buttons[0].id, b.id);
    const hello = JSON.parse((await call('POST', '/api/companion/hello', { moduleVersion: '0.10.0', label: 'cc', rev: model.rev })).text);
    assert.equal(hello.rev, model.rev);
    const synced = JSON.parse((await call('POST', '/api/companion/sync', {})).text);
    assert.notEqual(synced.rev, model.rev);
    const file = await call('GET', `/api/companion/pages/${p.id}/companionconfig`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /Show\.companionconfig/);
    assert.equal(JSON.parse(file.text).type, 'page');
    const ran = JSON.parse((await call('POST', `/api/companion/buttons/${b.id}/run`, { event: 'press' })).text);
    assert.equal(ran.event, 'press');
    const copy = JSON.parse((await call('POST', `/api/surface-pages/${p.id}/copy`, { surface: 'mini' })).text);
    assert.equal(copy.name, 'Show copy');
    assert.equal(copy.surface, 'mini');
    const order = JSON.parse((await call('POST', '/api/surface-pages/order', { ids: [copy.id, p.id] })).text);
    assert.deepEqual(order.pages.map((x) => x.id), [copy.id, p.id]);
    const v = JSON.parse((await call('GET', '/api/version')).text);
    assert.ok(v.features.includes('companionButtons'));
    assert.equal(v.apiVersion, 9);
  } finally {
    server.close();
    engine.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('COMPANION is a top tab; the duplicate second-row DEVICES / BUTTONS / PAGES buttons are gone', () => {
  const html = read('public/index.html');
  const top = html.split('id="tabsSub"')[0];
  const sub = html.split('id="tabsSub"')[1].split('</nav>')[0];
  assert.match(top, /class="tab tab-companion" data-tab="companion"/);
  assert.match(top, /class="tab tab-buttons" data-tab="buttons"/);
  assert.match(top, /class="tab tab-pages" data-tab="pages"/);
  assert.doesNotMatch(sub, /decks-sub/);
  assert.doesNotMatch(sub, /data-tab="(decks|buttons|pages)"/);
  assert.doesNotMatch(read('public/sys.js'), /decks-sub/);
  assert.match(html, /id="pane-companion"/);
  assert.match(html, /src="\/companion-tab\.js"/);
  const js = read('public/companion-tab.js');
  assert.match(js, /\/api\/companion\/check/);
  assert.match(js, /\/api\/companion\/sync/);
  assert.match(js, /companionconfig/);
  assert.match(js, /<iframe/);
  assert.match(js, /target="_blank" rel="noopener"/);
  assert.match(read('public/app.js'), /'companion'/);
});

test('+ and + XL draw the keys first, then the touch strip, then the encoders', () => {
  const pages = read('public/surface-pages.js');
  const board = pages.slice(pages.indexOf('function boardHtml'), pages.indexOf('function syncPage'));
  assert.match(board, /return grid \+ row\('touch', 'pages-touch-row'\) \+ row\('encoder', 'pages-encoder-row'\)/);
  const decks = read('public/decks.js');
  assert.match(decks, /\$\{cells\.join\(''\)\}<\/div>\$\{strip\}`/);
  assert.doesNotMatch(decks, /return `\$\{strip\}<div class="deck-mini/);
  assert.match(read('public/style.css'), /\.deck-strip\{display:flex;gap:8px;margin-top:10px\}/);
  const { SURFACES, cellsOf } = require('../lib/decks/surfaces');
  const cells = cellsOf(SURFACES.plusxl);
  const maxKeyRow = Math.max(...cells.filter((c) => c.kind === 'key').map((c) => c.row));
  assert.ok(cells.filter((c) => c.kind === 'touch').every((c) => c.row === maxKeyRow + 1));
  assert.ok(cells.filter((c) => c.kind === 'encoder').every((c) => c.row === maxKeyRow + 2));
  assert.deepEqual(SURFACES.plus.stack, ['keys', 'touch', 'encoders']);
  const { boardOf } = require('../lib/decks/known-devices');
  assert.equal(boardOf(SURFACES.plus).touchRow, 2);
  assert.equal(boardOf(SURFACES.plus).encoderRow, 3);
  assert.equal(boardOf(SURFACES.xl).touchRow, null);
});

test('migration: old surface-pages.json and button-library.json are stamped version 2, fork surface ids and order are mapped', () => {
  const data = dir();
  fs.writeFileSync(path.join(data, 'button-library.json'), JSON.stringify([{ id: 'b1', name: 'CUT', role: 'hot', element: 'button', text: 'CUT' }]));
  fs.writeFileSync(path.join(data, 'surface-pages.json'), JSON.stringify({ pages: [
    { id: 'p2', name: 'Second', surface: 'streamdeck-plus-xl', order: 2, keys: [{ row: 0, col: 0, buttonId: 'b1' }] },
    { id: 'p1', name: 'First', surface: 'streamdeck-xl', order: 1, keys: [] },
    { id: 'p1', name: 'Dup id', surface: 'mk2', keys: [] },
    { id: 'order', name: 'Reserved', surface: 'mini', keys: [] },
  ] }));
  const lib = new ButtonLibrary({ dataDir: data });
  assert.equal(lib.button('b1').name, 'CUT');
  const pages = lib.viewPages().pages;
  assert.deepEqual(pages.slice(0, 2).map((p) => [p.id, p.surface]), [['p1', 'xl'], ['p2', 'plusxl']]);
  assert.equal(pages.length, 4);
  assert.equal(new Set(pages.map((p) => p.id)).size, 4);
  assert.ok(!pages.some((p) => p.id === 'order'));
  const disk = JSON.parse(fs.readFileSync(path.join(data, 'surface-pages.json'), 'utf8'));
  assert.equal(disk.version, 2);
  assert.ok(disk.pages.every((p) => p.order === undefined));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'button-library.json'), 'utf8')).version, 2);
  assert.throws(() => lib.createPage({ id: 'order', name: 'x', surface: 'xl' }), (e) => e.status === 400);
  const copy = lib.copyPage('p2', { surface: 'mini' });
  assert.equal(copy.dropped, 0);
  assert.equal(copy.keys.length, 1);
  assert.throws(() => lib.reorderPages(['p1', 'p1']), (e) => e.status === 400);
  assert.throws(() => lib.reorderPages(['nope']), (e) => e.status === 404);
  fs.rmSync(data, { recursive: true, force: true });
});
