'use strict';
// Test helper: ownOnly(server) makes a mock server hear only connections from this test process.
//
// Some CI machines probe every new listening port (an HTTP "GET /", or a few random bytes). The mock devices in
// modules.test / modules-live listen on 127.0.0.1 port 0 and record whatever arrives, so a probe mixed into recorded
// frames and request counts (and once crashed a mock: Grok Build, 0.35.1, `Cannot read properties of null (reading
// '1')`). The drivers under test run in this same process, so a connection from anywhere else is not theirs.
// Opt-in per server: nothing global is patched, and child processes (fake Companion, server.js) are unaffected.
// CC_TEST_ALLOW_FOREIGN=1 turns it off.
const net = require('net');
const fs = require('fs');

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

// Is the client end of an accepted `sock` a socket of this process? First the live handles; then on Linux the
// socket table (/proc/net/tcp{,6} inode, looked up in /proc/self/fd). When it cannot tell, it lets the
// connection through: the worst case is the old behaviour, never a dropped legitimate connection on a platform
// without /proc.
function fromThisProcess(sock) {
  const port = sock.remotePort;
  const addr = sock.remoteAddress;
  if (!port || !addr) return false; // already reset by the peer: a probe, not a driver
  if (!LOOPBACK.test(addr)) return true;
  try {
    if (process._getActiveHandles().some((h) => h !== sock && h instanceof net.Socket && h.localPort === port)) return true;
  } catch { return true; }
  if (process.platform !== 'linux') return true;
  try {
    const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    const inodes = new Set();
    let readable = false;
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); readable = true; } catch { continue; }
      for (const line of text.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length > 9 && c[1].endsWith(hex)) inodes.add(c[9]);
      }
    }
    if (!readable) return true;
    if (!inodes.size) return false; // the client socket is gone already: a probe (a driver's socket is still open)
    for (const fd of fs.readdirSync('/proc/self/fd')) {
      let link = '';
      try { link = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) return true;
    }
    return false;
  } catch { return true; }
}

// Call before listen(). createServer's handler (and http.Server's own parser hookup) are 'connection' listeners
// added in the constructor; they are moved behind one gate that closes a foreign socket before they see it.
function ownOnly(server) {
  if (process.env.CC_TEST_ALLOW_FOREIGN === '1' || server.__ownOnly) return server;
  const handlers = server.listeners('connection');
  server.removeAllListeners('connection');
  server.on('connection', (sock) => {
    if (!fromThisProcess(sock)) { sock.on('error', () => {}); sock.destroy(); return; }
    for (const fn of handlers) fn.call(server, sock);
  });
  server.__ownOnly = true;
  return server;
}

module.exports = { ownOnly, fromThisProcess };
