'use strict';
// A small HyperDeck for tests. It answers the ethernet text protocol, including
// the reads the driver issues on connect (notify, slot info, clips get,
// transport info). It does not start playback unless a test asks it to.
const net = require('net');

class MockHyperDeck {
  constructor() {
    this.status = 'stopped';
    this.slot = 1;
    this.clip = 1;
    this.timecode = '01:00:02:12';
    this.format = '1080p25';
    this.speed = 0;
    this.notifyTransport = false;
    this.clipVersion = 1;
    this.lines = [];
    this.clips = [
      { id: 1, name: 'Walk In', start: '01:00:00:00', duration: '00:00:10:00', end: '01:00:10:00' },
      { id: 2, name: 'Opener', start: '01:00:10:00', duration: '00:01:00:00', end: '01:01:10:00' },
    ];
    this.server = null;
  }
  start(port = 0, host = '127.0.0.1') {
    this.server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.write('500 connection info:\nprotocol version: 1.11\nmodel: HyperDeck Studio Mini\n\n');
      let buf = '';
      sock.on('data', (chunk) => {
        buf += String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) if (line.trim()) sock.write(this._cmd(line.trim()));
      });
      sock.on('error', () => {});
    });
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address().port)));
  }
  _cmd(line) {
    this.lines.push(line);
    if (line === 'notify: transport: true' || line.startsWith('notify:')) {
      if (/transport:\s*true/.test(line)) this.notifyTransport = true;
      if (/transport:\s*false/.test(line)) this.notifyTransport = false;
      return '200 ok\n\n';
    }
    if (line === 'slot info' || line.startsWith('slot info:')) return this._slotBlock();
    if (line === 'clips get' || line.startsWith('clips get')) return this._clipsBlock(line);
    if (line === 'transport info') return this._transportBlock(208);
    if (line === 'record') { this.status = 'record'; this.speed = 0; return this._ok(); }
    if (line === 'play' || line.startsWith('play:') || line.startsWith('play ')) {
      this.status = 'play';
      const speed = /speed:\s*(-?\d+)/.exec(line);
      this.speed = speed ? Number(speed[1]) : 100;
      return this._ok();
    }
    if (line === 'stop') { this.status = 'stopped'; this.speed = 0; return this._ok(); }
    if (line.startsWith('preview:')) { this.status = 'preview'; this.speed = 0; return this._ok(); }
    const goto = /^goto:\s*clip id:\s*(\d+)/i.exec(line);
    if (goto) {
      const id = Number(goto[1]);
      const clip = this.clips.find((c) => c.id === id);
      this.clip = id;
      this.status = 'stopped';
      if (clip) this.timecode = clip.start;
      return this._ok();
    }
    const slot = /^slot select:\s*slot id:\s*(\d+)/i.exec(line);
    if (slot) { this.slot = Number(slot[1]); return this._ok(); }
    return '102 invalid command\n\n';
  }
  _ok() {
    return `200 ok\n\n${this.notifyTransport ? this._transportBlock(508) : ''}`;
  }
  _transportBlock(code) {
    const speed = this.status === 'play' ? this.speed : 0;
    return `${code} transport info:\nstatus: ${this.status}\nspeed: ${speed}\nslot id: ${this.slot}\nclip id: ${this.clip}\nsingle clip: false\ndisplay timecode: ${this.timecode}\ntimecode: ${this.timecode}\nvideo format: ${this.format}\nloop: false\n\n`;
  }
  _clipsBlock(line) {
    const version = /version:\s*2/.test(line) || this.clipVersion === 2 ? 2 : 1;
    const rows = this.clips.map((c) => (version === 2
      ? `${c.id}: ${c.start} ${c.duration} ${c.start} ${c.end} ${c.name}`
      : `${c.id}: ${c.name} ${c.start} ${c.duration}`));
    return `205 clips info:\nclip count: ${this.clips.length}\n${rows.join('\n')}\n\n`;
  }
  _slotBlock() {
    return `202 slot info:\nslot id: ${this.slot}\nstatus: mounted\nvolume name: MEDIA\nrecording time: 3600\nvideo format: ${this.format}\n\n`;
  }
  stop() {
    return new Promise((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); });
  }
}

module.exports = { MockHyperDeck };
