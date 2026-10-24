'use strict';
// 0.20.1: SCOPES is the persistent tab. Lightning is a component-vectorscope mode (Y / R−Y / B−Y),
// not a top-level tab. The NDI picker tells operators the list is mock fixtures or sidecar feeds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SM = require('../public/scopes-gl.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('SCOPES is the persistent top tab; LIGHTNING is not a nav group', () => {
  const html = read('public/index.html');
  const nav = read('public/sys.js');
  assert.match(html, /class="tab tab-scopes" data-tab="scopes"/);
  assert.match(html, />SCOPES</);
  assert.doesNotMatch(html, /data-tabgrp="lightning"/);
  assert.doesNotMatch(html, /data-tab="lightning"/);
  assert.doesNotMatch(html, /id="pane-lightning"/);
  assert.match(html, /id="pane-scopes"/);
  assert.match(html, /ndi-sidecar\.js --list/);
  assert.match(html, /--ndi "NAME"/);
  assert.match(html, /SIDECAR \/ DISCOVERED NDI/);
  assert.match(html, /cannot type a new name/i);
  assert.match(nav, /scopes: \['scopes'\]/);
  assert.doesNotMatch(nav, /lightning:/);
  assert.match(nav, /h === 'lightning'\) h = 'scopes'/);
  assert.match(read('public/app.js'), /'scopes'/);
  assert.doesNotMatch(read('public/app.js'), /'lightning'/);
});

test('Lightning is an extra mode beside WFM, parade, vectorscope and false colour', () => {
  const page = read('public/scopes.html');
  const gl = read('public/scopes-gl.js');
  assert.match(page, /data-show="wfm"/);
  assert.match(page, /data-show="parade"/);
  assert.match(page, /data-show="vec"/);
  assert.match(page, /data-view="1"/);
  assert.match(page, /data-show="ltng"/);
  assert.match(page, /LIGHTNING/);
  assert.match(page, /data-k="ltng"/);
  assert.match(gl, /u_mode == 3/);
  assert.match(gl, /LIGHTNING  Y \/ B−Y/);
  assert.match(read('public/scopes.js'), /lightningPeaks/);
});

test('Lightning plots positive B−Y left of the left axis and positive R−Y right of the right axis', () => {
  const blue = SM.targets().find((t) => t.name === 'B' && t.amp === 1);
  const red = SM.targets().find((t) => t.name === 'R' && t.amp === 1);
  const green = SM.targets().find((t) => t.name === 'G' && t.amp === 0.75);
  assert.ok(blue.pb > 0.4 && blue.y > 0 && blue.y < 0.2);
  assert.ok(red.pr > 0.4);
  const b = SM.lightningOf(blue.y, blue.pb, blue.pr, 1);
  const r = SM.lightningOf(red.y, red.pb, red.pr, 1);
  assert.ok(b.by.x < -0.5, 'positive B−Y is left of the left Y axis');
  assert.ok(b.by.x > -1, '100 % blue stays inside the left half at ×1');
  assert.ok(r.ry.x > 0.5, 'positive R−Y is right of the right Y axis');
  assert.ok(r.ry.x < 1, '100 % red stays inside the right half at ×1');
  assert.equal(b.by.y, b.ry.y);
  const g = SM.lightningOf(green.y, green.pb, green.pr, 1);
  assert.ok(g.by.x > -0.5 && g.by.x < 0, 'negative B−Y stays in the left half, toward center');
  assert.ok(g.ry.x < 0.5 && g.ry.x > 0, 'negative R−Y stays in the right half, toward center');
  const black = SM.lightningOf(0, 0, 0, 1);
  assert.equal(black.by.x, -0.5);
  assert.equal(black.ry.x, 0.5);
  assert.ok(Math.abs(black.by.y - (-0.5 * SM.LTNG_Y)) < 1e-9);
});
