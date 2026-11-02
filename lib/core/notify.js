'use strict';
// systemd notify. Type=notify + WatchdogSec on the Pi. No socket, no work.
const dgram = require('dgram');

function sdNotify(msg) {
  const addr = process.env.NOTIFY_SOCKET;
  if (!addr || !msg) return;
  let client;
  try {
    client = dgram.createSocket('unix_dgram');
    const dest = addr.startsWith('@') ? `\0${addr.slice(1)}` : addr;
    client.send(Buffer.from(String(msg)), dest, () => { try { client.close(); } catch { /* gone */ } });
  } catch { if (client) { try { client.close(); } catch { /* gone */ } } }
}

module.exports = { sdNotify };
