'use strict';
// Listens for Mitti's OSC so a test can see what was sent. It does not have to answer.
const dgram = require('dgram');
const osc = require('../drivers/osc');

class MockMitti {
  constructor() {
    this.messages = [];
    this.server = null;
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = dgram.createSocket('udp4');
    this.server.on('message', (buf) => {
      const msg = osc.decode(buf);
      if (msg) this.messages.push(msg);
    });
    return new Promise((resolve) => this.server.bind(port, host, () => resolve(this.server.address().port)));
  }
  stop() {
    return new Promise((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); });
  }
}

module.exports = { MockMitti };
