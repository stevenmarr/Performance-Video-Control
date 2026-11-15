'use strict';
// Bind the HTTP server. A taken port used to dump an unhandled EADDRINUSE stack.
function listen(server, port, host, onListening, { exit = (code) => process.exit(code), write = (line) => console.error(line) } = {}) {
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      write(`Port ${port} is already in use. Something else is listening on it. To see what holds it: sudo ss -ltnp | grep ${port}`);
    } else {
      write(err && err.stack ? err.stack : String(err));
    }
    exit(1);
  });
  server.listen(port, host, onListening);
}

module.exports = { listen };
