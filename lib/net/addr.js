'use strict';
// Loopback check shared by the Stream Deck plugin. Scopes keeps its own copy
// in apps/scopes/lib/ndi/host.js so this process does not require that app.
function isLoopbackAddress(addr) {
  const a = String(addr || '').toLowerCase().replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}
module.exports = { isLoopbackAddress };
