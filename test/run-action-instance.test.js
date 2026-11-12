'use strict';
// A second ATEM or PTZ is the instance in the path, same as Videohub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckService } = require('../lib/decks/service');
const { actionToRequest } = require('../lib/decks/page-push');
const { catalog } = require('../lib/decks/action-catalog');

test('the second ATEM cut and the second PTZ recall fire on that instance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-act-'));
  const calls = [];
  const systems = {
    atem(name, body) { calls.push({ type: 'atem', name, instance: body.instance }); return { ok: true }; },
    ptz(name, body) { calls.push({ type: 'ptz', name, instance: body.instance, preset: body.preset, cam: body.cam }); return { ok: true }; },
    pixera(name, body) { calls.push({ type: 'pixera', name, instance: body.instance, mode: body.mode }); return { ok: true }; },
    millumin(name, body) { calls.push({ type: 'millumin', name, instance: body.instance }); return { ok: true }; },
  };
  const svc = new DeckService({ dataDir: dir, systems, engine: { settings: {}, log() {} }, usbEnv: { CC_DECK_USB: '0' } });
  try {
    const cut = actionToRequest({ action: 'atem.cut', instance: 'atem-bbbb' });
    const recall = actionToRequest({ action: 'ptz.recall', instance: 'ptz-cccc', options: { preset: 4, cam: 'cam2' } });
    assert.equal(cut.path, '/api/sys/atem-bbbb/cmd/cut');
    assert.equal(recall.path, '/api/sys/ptz-cccc/cmd/recall');
    assert.equal(recall.body.preset, 4);
    assert.equal(recall.body.cam, 'cam2');
    assert.equal(actionToRequest({ action: 'atem.cut' }).path, '/api/sys/atem/cmd/cut');

    await svc.runAction(cut);
    await svc.runAction(recall);
    await svc.runAction(actionToRequest({ action: 'pixera.play', instance: 'pixera-dddd' }));
    await svc.runAction(actionToRequest({ action: 'millumin.pause', instance: 'millumin-eeee' }));
    await svc.runAction({ method: 'POST', path: '/api/sys/atem/cmd/cut', body: { instance: 'atem-bbbb' } });

    assert.deepEqual(calls[0], { type: 'atem', name: 'cut', instance: 'atem-bbbb' });
    assert.deepEqual(calls[1], { type: 'ptz', name: 'recall', instance: 'ptz-cccc', preset: 4, cam: 'cam2' });
    assert.deepEqual(calls[2], { type: 'pixera', name: 'transport', instance: 'pixera-dddd', mode: 'play' });
    assert.deepEqual(calls[3], { type: 'millumin', name: 'pause', instance: 'millumin-eeee' });
    assert.equal(calls[4].instance, 'atem-bbbb');
    assert.notEqual(calls[0].instance, 'atem');
    assert.notEqual(calls[1].instance, 'ptz');

    const offered = catalog().actions.find((action) => action.id === 'atem.cut');
    assert.equal(offered.request.path, '/api/sys/atem/cmd/cut');
    assert.equal(offered.bound, true);
  } finally {
    svc.stopUsb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
