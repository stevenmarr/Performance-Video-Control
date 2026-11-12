'use strict';
process.env.RS6_QUIET = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ButtonLibrary } = require('../lib/decks/button-library');
const { resolveKey } = require('../lib/decks/key-class');
const { Engine } = require('../lib/engine');
const { createServer } = require('../lib/server');

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'btnlib-')); }

test('memory and macro use the flex-memory and flex-macro looks', () => {
  assert.equal(resolveKey({ role: 'macro', text: 'M1' }, {}, {}).style.bgcolor, '#1A4FA0');
  assert.equal(resolveKey({ role: 'memory', text: '1' }, {}, {}).style.bgcolor, '#A03A8C');
  assert.equal(resolveKey({ role: 'flex-macro', text: 'M' }, {}, {}).style.bgcolor, '#1A4FA0');
  assert.equal(resolveKey({ role: 'flex', text: '' }, {}, {}).style.bgcolor, '#2a2a2e');
});

test('library round-trips, duplicates, and refuses flex, blank, and a bad surface', () => {
  const data = dir();
  const lib = new ButtonLibrary({ dataDir: data });
  const program = lib.createButton({ name: 'Cam', role: 'program', element: 'button', text: '$(atem:name)', target: { mode: 'follow' }, actions: { press: [{ action: 'atem.program', instance: '$(target)', options: { source: 1 } }] } });
  const cut = lib.createButton({ name: 'CUT', role: 'hot', element: 'button', text: 'CUT', actions: { press: [{ action: 'atem.cut' }] }, feedbacks: [{ when: 'transition', style: { bgcolor: '#ff6b6b' } }] });
  assert.ok(!lib.view().roles.includes('flex'));
  assert.ok(!lib.view().roles.includes('blank'));
  assert.throws(() => lib.createButton({ name: 'Nope', role: 'flex' }), (e) => e.status === 400);
  assert.throws(() => lib.createButton({ name: 'Nope', role: 'blank' }), (e) => e.status === 400);
  const mapped = lib.createButton({ name: 'Bank', role: 'flex-macro', text: 'M1' });
  assert.equal(mapped.role, 'macro');
  const copy = lib.duplicateButton(cut.id);
  assert.notEqual(copy.id, cut.id);
  assert.equal(copy.name, 'CUT copy');
  assert.equal(lib.button(cut.id).text, 'CUT');
  const page = lib.createPage({
    name: 'Show ATEM',
    surface: 'plusxl',
    keys: [{ row: 3, col: 8, buttonId: cut.id }],
    encoders: [],
    touch: [],
  });
  lib.renamePage(page.id, 'Show ATEM v2');
  assert.equal(lib.page(page.id).name, 'Show ATEM v2');
  assert.equal(lib.page(page.id).keys[0].buttonId, cut.id);
  assert.throws(() => lib.createPage({ name: 'Bad', surface: 'deck' }), (e) => e.status === 400);
  assert.throws(() => lib.updatePage(page.id, { encoders: [{ col: 1, buttonId: cut.id }] }), (e) => e.status === 400);
  lib.deleteButton(cut.id);
  assert.equal(lib.page(page.id).keys.length, 0);
  const again = new ButtonLibrary({ dataDir: data });
  assert.equal(again.button(program.id).text, '$(atem:name)');
  assert.equal(again.button(copy.id).name, 'CUT copy');
  assert.equal(again.page(page.id).name, 'Show ATEM v2');
  assert.deepEqual(again.page(page.id).keys, []);
  const onDisk = fs.readFileSync(path.join(data, 'button-library.json'), 'utf8');
  assert.match(onDisk, /\n/);
  assert.match(onDisk, /"role": "program"/);
  assert.doesNotMatch(onDisk, /"role": "flex"/);
  fs.rmSync(data, { recursive: true, force: true });
});

test('an encoder and a touch segment can share a knob column', () => {
  const lib = new ButtonLibrary({ dataDir: dir() });
  const enc = lib.createButton({ name: 'ME', role: 'toggle', element: 'encoder', actions: { turn: [{ action: 'atem.me' }] } });
  const strip = lib.createButton({ name: 'Bar', role: 'toggle', element: 'touch-segment', actions: { touch: [{ action: 'atem.tbar' }] } });
  const page = lib.createPage({
    name: 'Knobs',
    surface: 'plusxl',
    encoders: [{ col: 0, buttonId: enc.id }],
    touch: [{ col: 0, buttonId: strip.id }],
  });
  assert.equal(page.encoders[0].col, 0);
  assert.equal(page.touch[0].col, 0);
  assert.throws(() => lib.updatePage(page.id, { keys: [{ row: 0, col: 0, buttonId: enc.id }] }), (e) => e.status === 400 && /not a key/.test(e.message));
  assert.throws(() => lib.updatePage(page.id, { encoders: [{ col: 1, buttonId: enc.id }] }), (e) => e.status === 400);
});

test('old flex-macro records load as macro, and a flex button is dropped', () => {
  const data = dir();
  fs.writeFileSync(path.join(data, 'button-library.json'), JSON.stringify({
    buttons: [
      { id: 'bmacro', name: 'Old', role: 'flex-macro', element: 'button', text: 'M' },
      { id: 'bflex', name: 'Empty', role: 'flex', element: 'button', text: '' },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(data, 'surface-pages.json'), JSON.stringify({
    pages: [{ id: 'p1', name: 'Old page', surface: 'xl', keys: [{ row: 0, col: 0, buttonId: 'bflex' }, { row: 0, col: 1, buttonId: 'bmacro' }], encoders: [], touch: [] }],
  }, null, 2));
  const lib = new ButtonLibrary({ dataDir: data });
  assert.equal(lib.button('bmacro').role, 'macro');
  assert.throws(() => lib.button('bflex'), (e) => e.status === 404);
  assert.deepEqual(lib.page('p1').keys.map((s) => s.buttonId), ['bmacro']);
  const disk = fs.readFileSync(path.join(data, 'button-library.json'), 'utf8');
  assert.match(disk, /"role": "macro"/);
  assert.doesNotMatch(disk, /flex/);
  fs.rmSync(data, { recursive: true, force: true });
});

test('HTTP create survives a new process reading the same data dir', async () => {
  const data = dir();
  const start = () => {
    const engine = new Engine({ dataDir: data });
    const server = createServer(engine);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ engine, server, base: `http://127.0.0.1:${server.address().port}` })));
  };
  const call = async (base, method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const first = await start();
  try {
    const made = await call(first.base, 'POST', '/api/buttons', { name: 'CUT', role: 'hot', text: 'CUT' });
    assert.equal(made.status, 200);
    assert.equal(made.json.role, 'hot');
    const refused = await call(first.base, 'POST', '/api/buttons', { name: 'X', role: 'flex' });
    assert.equal(refused.status, 400);
    const page = await call(first.base, 'POST', '/api/surface-pages', { name: 'Show ATEM', surface: 'plusxl', keys: [{ row: 3, col: 8, buttonId: made.json.id }] });
    assert.equal(page.status, 200);
    const renamed = await call(first.base, 'POST', `/api/surface-pages/${page.json.id}/rename`, { name: 'Show ATEM v2' });
    assert.equal(renamed.json.name, 'Show ATEM v2');
  } finally {
    first.server.close();
    first.engine.close();
  }
  const second = await start();
  try {
    const list = await call(second.base, 'GET', '/api/buttons');
    assert.equal(list.json.buttons[0].name, 'CUT');
    assert.ok(!list.json.roles.includes('flex'));
    const pages = await call(second.base, 'GET', '/api/surface-pages');
    assert.equal(pages.json.pages[0].name, 'Show ATEM v2');
    assert.equal(pages.json.pages[0].keys[0].buttonId, list.json.buttons[0].id);
  } finally {
    second.server.close();
    second.engine.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
