#!/usr/bin/env node
'use strict';
// Pasteable USB Stream Deck check. Run on the Pi:
//   node tools/deck-diag.js
//   sudo node tools/deck-diag.js
// Add --json for the same report as GET /api/surfaces/diag.

const { diagnose } = require('../lib/decks/diag');

diagnose().then((report) => {
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${report.text}\n`);
}).catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
