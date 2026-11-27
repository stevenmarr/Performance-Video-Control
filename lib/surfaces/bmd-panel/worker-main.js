'use strict';
// ATEM Micro Panel process. node-hid lives here, so a native fault restarts this process and leaves
// Control Center running (the same split as the Stream Deck worker, lib/decks/worker-main.js).
// CC_BMD_PANEL_MOCK=1 uses the pretend panel in ./mock-hid.js and accepts {op:'mock'} to drive it.
const { PanelScanner } = require('./scanner');

const mock = process.env.CC_BMD_PANEL_MOCK === '1';
let hid = null; let mockPanel = null;
if (mock) { const { MockPanel, mockHid } = require('./mock-hid'); mockPanel = new MockPanel(); hid = mockHid([mockPanel]); }
else { try { hid = require('node-hid'); } catch { hid = null; } }

const send = (msg) => { if (process.connected) process.send(msg); };
const scanner = new PanelScanner({ hid, send, log: (level, msg) => send({ event: 'log', level, msg }), scanMs: mock ? 100 : undefined, retryMs: mock ? 300 : undefined });

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;
  try {
    if (msg.op === 'start') { scanner.start(); return send({ id, ok: true }); }
    if (msg.op === 'stop') { await scanner.stop(); return send({ id, ok: true }); }
    if (msg.op === 'leds') { const painted = await scanner.leds(Buffer.from(String(msg.hex || ''), 'hex')); return send({ id, ok: true, painted }); }
    if (msg.op === 'mock') {
      if (!mockPanel) return send({ id, ok: false, error: 'not a mock panel' });
      const a = msg.action;
      if (a === 'press') mockPanel.press(msg.key); else if (a === 'release') mockPanel.release(msg.key); else if (a === 'tap') mockPanel.tap(msg.key);
      else if (a === 'tbar') mockPanel.tbar(Number(msg.value)); else if (a === 'battery') mockPanel.battery(Number(msg.value));
      else if (a === 'unplug') { mockPanel.gone = true; mockPanel.unplug(); } else if (a === 'replug') mockPanel.gone = false;
      const last = mockPanel.leds.length ? mockPanel.leds[mockPanel.leds.length - 1].toString('hex') : null;
      return send({ id, ok: true, leds: last, auths: mockPanel.auths, opened: mockPanel.opened });
    }
    send({ id, ok: false, error: `unknown op ${msg.op}` });
  } catch (e) { send({ id, ok: false, error: e.message }); }
});

process.on('disconnect', () => { scanner.stop().finally(() => process.exit(0)); });
send({ event: 'ready', mock });
