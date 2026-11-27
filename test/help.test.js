'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Help, renderMarkdown } = require('../lib/help');

test('help articles load from the repo and render safe HTML', () => {
  const help = new Help();
  const idx = help.index();
  const ids = idx.articles.map((a) => a.id).sort();
  assert.ok(ids.includes('getting-started'));
  assert.ok(ids.includes('ptz-camera-control'));
  assert.ok(ids.includes('live-safety'));
  assert.ok(ids.includes('on-the-deck'));
  assert.ok(ids.includes('home'));
  const ptz = help.article('ptz-camera-control');
  assert.match(ptz.html, /<h1>/);
  assert.match(ptz.html, /800 ms/);
  assert.equal(help.tips['tour.start'], 'The tour only starts from Help. It never starts by itself.');
  const hits = help.search('SYNC');
  assert.ok(hits.some((h) => h.id === 'surfaces-pages'));
  const bad = renderMarkdown('Hello <script>alert(1)</script> **world**');
  assert.doesNotMatch(bad, /<script>/);
  assert.match(bad, /&lt;script&gt;/);
  assert.match(bad, /<strong>world<\/strong>/);
});

test('the getting-started tour never auto-starts', () => {
  const help = new Help();
  const tour = help.tour('getting-started');
  assert.equal(tour.autoStart, false);
  assert.equal(tour.steps.length, 7);
  const idx = help.index();
  assert.ok(idx.tours.every((t) => t.autoStart === false));
});

test('a missing article is 404', () => {
  const help = new Help();
  assert.throws(() => help.article('no-such-article'), (e) => e.status === 404);
});
