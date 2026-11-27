'use strict';
// overhaul phase 1 (0.37.0): deck keys and CC buttons reach the routes the web UI uses, a key that does nothing says
// so, refused knobs are logged, and GET /api/companion/selftest reports dead keys, mis-bound knobs and what blocks.
process.env.RS6_QUIET = '1';
process.env.CC_DECK_USB = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const { CompanionBridge } = require('../lib/companion/bridge');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ovh-'));
  const svc = new DeckService({ dataDir: dir, systems: null, usbEnv: { CC_DECK_USB: '0' } });
  const calls = [];
  svc.routeExists = (method, p) => /^\/api\/(modules\/cmd|cues\/go)/.test(p);
  svc.routeFallback = async (method, p, body) => { if (!svc.routeExists(method, p)) return undefined; calls.push([method, p, body]); return { ok: true, ran: p }; };
  const bridge = new CompanionBridge({ dataDir: dir, decks: svc, appVersion: '0.37.0', apiVersion: 9 });
  return { dir, svc, bridge, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('module-system and cue actions run through the HTTP route table instead of returning null', async () => {
  const { svc, calls, cleanup } = rig();
  try {
    assert.deepEqual(await svc.runAction({ method: 'POST', path: '/api/modules/cmd/vmix/cut', body: { input: 2 } }), { ok: true, ran: '/api/modules/cmd/vmix/cut' });
    assert.deepEqual(await svc.runAction({ path: '/api/cues/go' }), { ok: true, ran: '/api/cues/go' });
    assert.deepEqual(calls.map((c) => c[1]), ['/api/modules/cmd/vmix/cut', '/api/cues/go']);
    assert.equal(await svc.runAction({ path: '/api/shows/delete' }), null, 'only the allow-listed paths are handed over');
    assert.equal(svc.resolveAction({ path: '/api/modules/cmd/vmix/cut' }), 'route');
    assert.equal(svc.resolveAction({ path: '/api/nope' }), 'none');
  } finally { cleanup(); }
});

test('noteError keeps the newest 50 failures', () => {
  const { svc, cleanup } = rig();
  try {
    for (let i = 0; i < 60; i++) svc.noteError(`knob ${i}`, new Error('paint is locked'));
    assert.equal(svc.lastErrors.length, 50);
    assert.equal(svc.lastErrors[0].where, 'knob 59');
  } finally { cleanup(); }
});

test('selftest: counts every key on every deck size, finds label-only keys and mis-bound knobs; warnings name the panel lock', () => {
  const { svc, bridge, cleanup } = rig();
  try {
    const t = bridge.selftest();
    assert.ok(t.totals.keys > 300, `keys ${t.totals.keys}`);
    assert.equal(t.surfaces.length, 4);
    assert.ok(t.totals.labelOnly > 0, 'the gallery still has keys that only show a label');
    assert.ok(t.problems.some((p) => p.kind === 'labelOnly'));
    assert.equal(t.totals.knobsMisbound || 0, 0, 'after P1b no knob turns a control its label does not name');
    svc.os = { panel: { locked: true } };
    assert.match(bridge.warnings()[0], /panel is LOCKED/);
    assert.match(bridge.hello({ moduleVersion: '0.16.0' }).warnings[0], /LOCKED/);
  } finally { cleanup(); }
});
