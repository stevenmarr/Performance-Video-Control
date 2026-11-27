'use strict';
// Listens for Mitti's OSC and serves the OSC Query document Mitti publishes
// on the same port over HTTP. Playback stays where the test left it: a
// connect only receives the query, unless the driver asks for feedback again.
const dgram = require('dgram');
const http = require('http');
const osc = require('../drivers/osc');

class MockMitti {
  constructor() {
    this.messages = [];
    this.cues = [
      { id: '1', name: 'Walk In' },
      { id: '2', name: 'Opener' },
    ];
    this.current = '1';
    this.playing = false;
    this.remaining = '00:00:45:00';
    this.elapsed = '00:00:15:00';
    this.duration = '00:01:00:00';
    this.server = null;
    this.http = null;
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = dgram.createSocket('udp4');
    this.http = http.createServer((req, res) => this._http(req, res));
    this.server.on('message', (buf, rinfo) => {
      const msg = osc.decode(buf);
      if (!msg) return;
      this.messages.push(msg);
      this._apply(msg);
      if (msg.address === '/mitti/resendOSCFeedback') this._feedback(rinfo);
    });
    this.server.on('error', () => {});
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.bind(port, host, () => {
        const p = this.server.address().port;
        this.http.once('error', reject);
        this.http.listen(p, host, () => resolve(p));
      });
    });
  }
  _apply(msg) {
    const addr = msg.address;
    const arg = msg.args && msg.args[0] ? msg.args[0].value : undefined;
    if (addr === '/mitti/play') this.playing = true;
    else if (addr === '/mitti/pause' || addr === '/mitti/stop') this.playing = false;
    else if (addr === '/mitti/togglePlay') this.playing = !this.playing;
    else if (addr === '/mitti/cue' && arg != null) this.current = String(arg);
    else if (addr === '/mitti/gotoCueByName' && arg != null) {
      const row = this.cues.find((c) => c.name === String(arg));
      if (row) this.current = row.id;
    }
  }
  _http(req, res) {
    const path = String(req.url || '/').split('?')[0];
    if (path === '/' || path === '/mitti' || path === '/mitti/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.query()));
      return;
    }
    res.writeHead(404);
    res.end();
  }
  query() {
    const current = this.cues.find((c) => c.id === this.current) || this.cues[0];
    const contents = {};
    for (const cue of this.cues) {
      contents[cue.id] = {
        FULL_PATH: `/mitti/${cue.id}`,
        CONTENTS: { cueName: { FULL_PATH: `/mitti/${cue.id}/cueName`, TYPE: 's', VALUE: [cue.name] } },
      };
    }
    contents.cueTimeLeft = { FULL_PATH: '/mitti/cueTimeLeft', TYPE: 's', VALUE: [this.remaining] };
    contents.cueTimeElapsed = { FULL_PATH: '/mitti/cueTimeElapsed', TYPE: 's', VALUE: [this.elapsed] };
    contents.currentCueTRT = { FULL_PATH: '/mitti/currentCueTRT', TYPE: 's', VALUE: [this.duration] };
    contents.currentCueName = { FULL_PATH: '/mitti/currentCueName', TYPE: 's', VALUE: [current ? current.name : ''] };
    contents.currentCueID = { FULL_PATH: '/mitti/currentCueID', TYPE: 's', VALUE: [this.current] };
    contents.togglePlay = { FULL_PATH: '/mitti/togglePlay', TYPE: 'i', VALUE: [this.playing ? 1 : 0] };
    return { FULL_PATH: '/mitti', CONTENTS: contents };
  }
  _feedback(rinfo) {
    const current = this.cues.find((c) => c.id === this.current);
    const packets = [
      ['/mitti/cueTimeLeft', [{ type: 's', value: this.remaining }]],
      ['/mitti/cueTimeElapsed', [{ type: 's', value: this.elapsed }]],
      ['/mitti/currentCueName', [{ type: 's', value: current ? current.name : '' }]],
      ['/mitti/currentCueID', [{ type: 's', value: this.current }]],
      ['/mitti/togglePlay', [this.playing ? 1 : 0]],
    ];
    for (const cue of this.cues) packets.push([`/mitti/${cue.id}/cueName`, [{ type: 's', value: cue.name }]]);
    for (const [address, args] of packets) {
      const buf = osc.encode(address, args);
      this.server.send(buf, rinfo.port, rinfo.address);
    }
  }
  stop() {
    const udp = this.server;
    const web = this.http;
    this.server = null;
    this.http = null;
    const jobs = [];
    if (udp) jobs.push(new Promise((resolve) => udp.close(() => resolve())));
    if (web) jobs.push(new Promise((resolve) => web.close(() => resolve())));
    return Promise.all(jobs);
  }
}

module.exports = { MockMitti };
