'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SURFACES } = require('../lib/decks/surfaces');
const { show } = require('../lib/decks/faces');
const { GALLERY } = require('../lib/decks/gallery');

const MODELS = ['plusxl', 'xl', 'plus', 'mk2', 'neo', 'mini'];

function walk(kind, surface) {
  const system = kind;
  const desk = kind === 'console'
    ? { armed: [] }
    : { armed: [system], byKey: { ptz: { cameras: [{ id: 'cam1', name: 'Wide' }, { id: 'cam2', name: 'Tight' }], selected: 'cam2' } } };
  const first = show(surface, desk, { system, page: 0 });
  const seen = new Set();
  const queue = [0];
  const ids = new Set();
  while (queue.length) {
    const p = queue.pop();
    if (seen.has(p) || p < 0 || p >= first.pages) continue;
    seen.add(p);
    const face = show(surface, desk, { system, page: p });
    ids.add(face.designId);
    assert.equal(face.keys.find((k) => k.col === 0 && k.row === 0).nav === 'home' || face.keys.find((k) => k.col === 0 && k.row === 0).label === 'HOME', true, `${kind} ${surface.id} page ${p} starts at HOME`);
    for (const key of face.keys) {
      if (key && key.nav === 'page' && Number.isInteger(key.page)) queue.push(key.page);
    }
  }
  return ids;
}

test('every designed page is reachable on every deck model', () => {
  for (const kind of [...new Set(GALLERY.map((item) => item.kind))]) {
    const want = GALLERY.filter((item) => item.kind === kind).map((item) => item.id);
    for (const id of MODELS) {
      const got = walk(kind, SURFACES[id]);
      for (const page of want) assert.ok(got.has(page), `${page} on ${id}`);
    }
  }
});

test('the + XL RCP page is the camera-control bank, with ALL STOP at the bottom right', () => {
  const desk = { armed: ['ptz'], byKey: { ptz: { cameras: [{ id: 'cam1', name: 'Wide' }], selected: 'cam1' } } };
  const face = show(SURFACES.plusxl, desk, { system: 'ptz', page: 1 });
  assert.equal(face.designId, 'ptz-rcp-exp');
  assert.deepEqual(face.dials.map((d) => d.label), ['IRIS', 'M.PED', 'SHUTTER', 'ND', 'PIC LEVEL', 'GAIN']);
  for (const label of ['IRIS', 'WB', 'ND', 'GAIN', 'SHUTTER']) assert.ok(face.keys.some((k) => k.label === label), label);
  const stop = face.keys.find((k) => k.label === 'ALL STOP');
  assert.equal(stop.col, 8);
  assert.equal(stop.row, 3);
  assert.equal(face.keys.find((k) => k.col === 0 && k.row === 0).label, 'HOME');
});
