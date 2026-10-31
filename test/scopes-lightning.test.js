'use strict';
// 0.20.1: SCOPES is the persistent tab. Lightning is a component-vectorscope mode (Y / R−Y / B−Y),
// not a top-level tab. Live video on that tab is Desktop Video, not an invented NDI source.
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
  const scopes = read('public/scopes.html') + read('public/scopes-tab.js');
  // The sidecar commands and the Desktop Video label live on the scopes page, not in the shell.
  assert.match(scopes, /decklink-sidecar\.js --list/);
  assert.match(scopes, /--device 0/);
  assert.match(scopes, /DESKTOP VIDEO/);
  assert.doesNotMatch(html + scopes, /MOCK FIXTURES/);
  assert.doesNotMatch(html + scopes, /id="ndiMock"/);
  const atem = html.slice(html.indexOf('id="pane-atem"'), html.indexOf('id="pane-arouter"'));
  const system = html.slice(html.indexOf('id="pane-system"'), html.indexOf('id="pane-xpresets"'));
  assert.match(atem, /id="tslPanel"/);
  assert.doesNotMatch(system, /id="tslPanel"/);
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
  assert.match(page, /DIAMOND/);
  assert.match(page, /id="fcMode"/);
  assert.match(page, /ST 2084/);
  assert.match(page, /data-k="ltng"/);
  assert.match(gl, /u_mode == 3/);
  assert.match(gl, /DIAMOND/);
  assert.doesNotMatch(gl, /mV/, 'diamond does not print a voltage');
  assert.doesNotMatch(read('public/scopes.js'), /gemOf/);
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

test('Diamond is the WFM display: G left of B on top, G left of R below', () => {
  const green = SM.diamondOf(0, 1, 0);
  const blue = SM.diamondOf(0, 0, 1);
  const red = SM.diamondOf(1, 0, 0);
  assert.ok(green.upper.x < 0 && blue.upper.x > 0, 'upper diamond: G left, B right');
  assert.ok(green.lower.x < 0 && red.lower.x > 0, 'lower diamond: G left, R right');
  assert.ok(green.upper.y > 0 && red.lower.y < 0);
  const black = SM.diamondOf(0, 0, 0);
  assert.ok(Math.abs(black.upper.x) < 1e-9);
  assert.ok(Math.abs(black.upper.y) < 1e-9);
  assert.ok(Math.abs(black.lower.y) < 1e-9);
});
