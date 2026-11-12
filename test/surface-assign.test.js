'use strict';
// Step 4: placements go in surface-pages.json, buttons stay in button-library.json,
// and decks.json is not part of the edit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ButtonLibrary } = require('../lib/decks/button-library');

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pages-assign-')); }

test('assign, refuse a mismatch, save, rename, delete, and clear a slot without touching decks.json', () => {
  const data = dir();
  const decks = { stacks: { 'SD-1': ['ptz-live'] }, loaded: {}, sessions: {} };
  const decksPath = path.join(data, 'decks.json');
  fs.writeFileSync(decksPath, JSON.stringify(decks, null, 2) + '\n');
  const decksBefore = fs.readFileSync(decksPath);

  const lib = new ButtonLibrary({ dataDir: data });
  const program = lib.createButton({ name: 'Program', role: 'program', element: 'button', text: '$(atem:name)' });
  const cut = lib.createButton({ name: 'CUT', role: 'hot', element: 'button', text: 'CUT', actions: { press: [{ action: 'atem.cut' }] } });
  const iris = lib.createButton({ name: 'Iris', role: 'toggle', element: 'encoder', text: 'IRIS', actions: { turn: [{ action: 'ptz.iris' }] } });

  const made = lib.createPage({ name: 'Show ATEM', surface: 'plusxl' });
  // Row 4 column 9 on the + XL grid is stored 0-based as row 3, column 8.
  const placed = lib.updatePage(made.id, {
    keys: [
      { row: 3, col: 8, buttonId: cut.id },
      { row: 0, col: 0, buttonId: program.id },
    ],
  });
  assert.equal(placed.keys.find((slot) => slot.row === 3 && slot.col === 8).buttonId, cut.id);
  assert.equal(placed.keys.find((slot) => slot.row === 0 && slot.col === 0).buttonId, program.id);

  assert.throws(
    () => lib.updatePage(made.id, { keys: [{ row: 1, col: 1, buttonId: iris.id }] }),
    (error) => error.status === 400 && /not a key/.test(error.message),
  );
  assert.equal(lib.page(made.id).keys.length, 2);
  const withEncoder = lib.updatePage(made.id, { encoders: [{ col: 0, buttonId: iris.id }] });
  assert.equal(withEncoder.encoders[0].col, 0);
  assert.equal(withEncoder.encoders[0].buttonId, iris.id);
  assert.equal(withEncoder.keys.length, 2);
  assert.throws(
    () => lib.updatePage(made.id, { encoders: [{ col: 1, buttonId: iris.id }] }),
    (error) => error.status === 400 && /no encoder/.test(error.message),
  );

  const renamed = lib.renamePage(made.id, 'Show ATEM v2');
  assert.equal(renamed.name, 'Show ATEM v2');
  assert.equal(renamed.keys.length, 2);
  const xl = lib.createPage({ name: 'XL show', surface: 'xl', keys: [{ row: 1, col: 2, buttonId: program.id }] });
  assert.equal(xl.surface, 'xl');
  assert.equal(xl.keys.length, 1);
  assert.equal(lib.page(made.id).surface, 'plusxl');
  assert.equal(lib.page(made.id).keys.length, 2);

  const buttonsOnDisk = JSON.parse(fs.readFileSync(path.join(data, 'button-library.json'), 'utf8'));
  const pagesOnDisk = JSON.parse(fs.readFileSync(path.join(data, 'surface-pages.json'), 'utf8'));
  assert.ok(buttonsOnDisk.buttons.some((row) => row.name === 'CUT'));
  assert.equal(buttonsOnDisk.pages, undefined);
  assert.equal(pagesOnDisk.buttons, undefined);
  assert.equal(pagesOnDisk.pages.find((row) => row.id === made.id).name, 'Show ATEM v2');
  assert.equal(pagesOnDisk.pages.find((row) => row.id === xl.id).surface, 'xl');

  const again = new ButtonLibrary({ dataDir: data });
  assert.equal(again.page(made.id).name, 'Show ATEM v2');
  assert.equal(again.page(made.id).keys.length, 2);
  assert.equal(again.page(xl.id).keys[0].buttonId, program.id);

  again.deletePage(xl.id);
  assert.throws(() => again.page(xl.id), /No page/);
  const afterDelete = new ButtonLibrary({ dataDir: data });
  assert.throws(() => afterDelete.page(xl.id), /No page/);
  assert.equal(afterDelete.page(made.id).name, 'Show ATEM v2');

  afterDelete.deleteButton(cut.id);
  assert.equal(afterDelete.page(made.id).keys.some((slot) => slot.buttonId === cut.id), false);
  assert.equal(afterDelete.page(made.id).keys.some((slot) => slot.buttonId === program.id), true);
  const cleared = new ButtonLibrary({ dataDir: data });
  assert.equal(cleared.page(made.id).keys.some((slot) => slot.buttonId === cut.id), false);
  assert.throws(() => cleared.button(cut.id), /No button/);

  assert.deepEqual(fs.readFileSync(decksPath), decksBefore);
  fs.rmSync(data, { recursive: true, force: true });
});

test('the pages screen assigns through the surface-page routes and does not push', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../public/surface-pages.js'), 'utf8');
  assert.match(ui, /\/api\/surface-pages/);
  assert.match(ui, /api\('POST', '\/api\/surface-pages'/);
  assert.match(ui, /api\('PUT', `\/api\/surface-pages\/\$\{page\.id\}`/);
  assert.match(ui, /\/rename/);
  assert.match(ui, /api\('DELETE', `\/api\/surface-pages\/\$\{page\.id\}`/);
  assert.match(ui, /not a key|not \$\{article\(need\)\}/);
  assert.doesNotMatch(ui, /\/api\/decks\/press/);
  assert.doesNotMatch(ui, /\/v1\/deploy/);
  assert.match(ui, /surface-pages\.json|\/api\/surface-pages/);
  assert.doesNotMatch(ui, /api\('POST', '\/api\/buttons'/);
});
