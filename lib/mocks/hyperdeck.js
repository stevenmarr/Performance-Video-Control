'use strict';
// A small HyperDeck for tests. It answers the ethernet text protocol.
const net = require('net');

class MockHyperDeck {
  constructor() {
    this.status = 'stopped';
    this.server = null;
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.write('500 connection info:\nprotocol version: 1.11\nmodel: HyperDeck Studio Mini\n\n');
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) if (line.trim()) sock.write(this._cmd(line.trim()));
      });
      sock.on('error', () => {});
    });
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address().port)));
  }
  _cmd(line) {
    const word = line.split(/\s+/)[0];
    if (word === 'record') { this.status = 'record'; return '200 ok\n\n'; }
    if (word === 'play') { this.status = 'play'; return '200 ok\n\n'; }
    if (word === 'stop') { this.status = 'stopped'; return '200 ok\n\n'; }
    if (word === 'preview:') { this.status = 'preview'; return '200 ok\n\n'; }
    if (line === 'transport info') {
      return `208 transport info:\nstatus: ${this.status}\nspeed: ${this.status === 'play' ? 100 : 0}\nslot id: 1\ndisplay timecode: 00:00:00:00\n\n`;
    }
    return '102 invalid command\n\n';
  }
  stop() {
    return new Promise((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); });
  }
}

module.exports = { MockHyperDeck };
