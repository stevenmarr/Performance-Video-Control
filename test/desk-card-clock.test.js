'use strict';
// The SYSTEMS desk card reads counts. HyperDeck and Mitti put the current
// clip or cue name and the remaining time on that summary, not only a flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { SystemManager } = require('../lib/systems');
const { MockHyperDeck } = require('../lib/mocks/hyperdeck');
const { MockMitti } = require('../lib/mocks/mitti');

function fakeEngine(dir) {
  const eng = new EventEmitter();
  eng.dataDir = dir;
  eng.settings = { host: '192.0.2.10', restPort: 80, awjPort: 10606, protocol: 'rest' };
  eng.presets = [];
  eng.destinations = [];
  eng.live = { inputs: {} };
  eng.log = () => {};
  eng.changed = () => {};
  eng.currentShow = { id: null, name: 'Desk' };
  eng.showStatus = () => ({ id: null, name: 'Desk', dirty: false });
  return eng;
}

test('desk counts carry the HyperDeck clip name and the Mitti cue name, plus remaining time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-'));
  const deck = new MockHyperDeck();
  const mitti = new MockMitti();
  const deckPort = await deck.start(0);
  const mittiPort = await mitti.start(0);
  const sm = new SystemManager({
    dataDir: dir,
    engine: fakeEngine(dir),
    autoStart: false,
    overrides: {
      hyperdeck: { host: '127.0.0.1', port: deckPort },
      mitti: { host: '127.0.0.1', port: mittiPort },
    },
  });
  try {
    assert.equal(sm.counts('hyperdeck').clipName, null);
    assert.equal(sm.counts('hyperdeck').remaining, null);
    assert.equal(sm.counts('mitti').cueName, null);
    assert.equal(sm.counts('mitti').remaining, null);
    await sm.connect('hyperdeck');
    await sm.connect('mitti');
    await sm.setActive('hyperdeck');
    await sm.setActive('mitti');
    const st = sm.getState();
    const hd = st.instances.find((i) => i.id === 'hyperdeck');
    const mi = st.instances.find((i) => i.id === 'mitti');
    assert.equal(hd.armed, true);
    assert.equal(mi.armed, true);
    assert.equal(hd.counts.clipName, 'Walk In');
    assert.equal(hd.counts.remaining, '00:00:07:13');
    assert.equal(hd.counts.timecode, '01:00:02:12');
    assert.equal(hd.counts.transport, 'stopped');
    assert.equal(st.systems.hyperdeck.counts.clipName, 'Walk In');
    assert.equal(st.systems.hyperdeck.counts.remaining, '00:00:07:13');
    assert.equal(mi.counts.cueName, 'Walk In');
    assert.equal(mi.counts.remaining, '00:00:45:00');
    assert.equal(mi.counts.cue, '1');
    assert.equal(mi.counts.mode, 'pause');
    assert.equal(st.systems.mitti.counts.cueName, 'Walk In');
    assert.equal(st.systems.mitti.counts.remaining, '00:00:45:00');

    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sys.js'), 'utf8');
    const hyper = src.slice(src.indexOf("s.kind === 'hyperdeck'"), src.indexOf("s.kind === 'mitti'"));
    assert.match(hyper, /n\.clipName/);
    assert.match(hyper, /n\.remaining/);
    const mittiCard = src.slice(src.indexOf("s.kind === 'mitti'"));
    assert.match(mittiCard, /n\.cueName/);
    assert.match(mittiCard, /n\.remaining/);
    assert.match(src, /hyperdeck' && \(n\.clipName \|\| n\.remaining\)/);
    assert.match(src, /mitti' && \(n\.cueName \|\| n\.remaining\)/);
    assert.match(src, /left` : ''/);
  } finally {
    sm.close();
    await deck.stop();
    await mitti.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
