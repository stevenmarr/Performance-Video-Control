'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Help } = require('../lib/help');

test('every data-help in public/ has a tip', () => {
  const help = new Help();
  const tips = help.tips;
  const pub = path.join(__dirname, '..', 'public');
  const files = fs.readdirSync(pub).filter((f) => /\.(html|js)$/.test(f));
  const keys = new Set();
  for (const f of files) {
    const txt = fs.readFileSync(path.join(pub, f), 'utf8');
    for (const m of txt.matchAll(/data-help="([^"]+)"/g)) keys.add(m[1]);
  }
  const missing = [...keys].filter((k) => !tips[k] && !tips['core.' + k]);
  assert.equal(missing.length, 0, `data-help without tip: ${missing.join(', ')}`);
});
