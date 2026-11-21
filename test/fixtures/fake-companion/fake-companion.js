'use strict';
// Test stand-in for PV Companion: answers like Companion (X-App header) on COMPANION_APP_PORT, and starts a
// grandchild that keeps running if only this process dies (like tsx + Companion's node under yarn).
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const port = Number(process.env.COMPANION_APP_PORT);
const marker = process.env.FAKE_MARKER;
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
if (marker) fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, grandchild: grand.pid, env: { COMPANION_CONFIG_BASEDIR: process.env.COMPANION_CONFIG_BASEDIR, COMPANION_TRUSTED_PROXIES: process.env.COMPANION_TRUSTED_PROXIES, COMPANION_DEV_REBUILD_WEBUI: process.env.COMPANION_DEV_REBUILD_WEBUI } }));
console.log('fake companion starting');
http.createServer((req, res) => { res.setHeader('X-App', 'Bitfocus Companion'); res.end(`fake ${req.url} prefix=${req.headers['companion-custom-prefix'] || ''}`); })
  .listen(port, '127.0.0.1', () => console.log(`Started on ${port}`));
if (process.env.FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
