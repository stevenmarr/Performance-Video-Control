'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../lib/ptz-provision');

const mac = (n) => `00:11:22:33:44:${n.toString(16).padStart(2, '0')}`;

test('house plan: cam 1 is 192.168.0.101 / PTZ1, reserved .1 and .10, next-free skips used', () => {
  const { PLAN, assignmentFor, fromAddress, nextFree, nameOf, hostOf, reserved } = P.housePlan;
  assert.equal(PLAN.subnet, '192.168.0.0/24');
  assert.equal(PLAN.factoryDefaultIp, '192.168.0.10');
  assert.equal(PLAN.gateway, '192.168.0.1');
  assert.equal(PLAN.ntpAddr, '192.168.0.1');
  assert.equal(PLAN.easyIpWindow, '20min');
  const a1 = assignmentFor(1);
  assert.deepEqual({ ip: a1.ip, name: a1.name, mask: a1.mask, gateway: a1.gateway }, { ip: '192.168.0.101', name: 'PTZ1', mask: '255.255.255.0', gateway: '192.168.0.1' });
  assert.equal(assignmentFor(2).ip, '192.168.0.102');
  assert.equal(assignmentFor(2).name, 'PTZ2');
  assert.equal(fromAddress('192.168.0.110').name, 'PTZ10');
  assert.equal(fromAddress('192.168.0.10'), null);
  assert.equal(nameOf(101), 'PTZ1');
  assert.equal(hostOf('192.168.0.101'), 101);
  assert.equal(reserved(1), true);
  assert.equal(reserved(10), true);
  assert.equal(reserved(101), false);
  const n = nextFree(['192.168.0.101', '192.168.0.103']);
  assert.equal(n.ip, '192.168.0.102');
  assert.equal(n.name, 'PTZ2');
});

test('assign: overlapping factory defaults get .101, .102… by MAC; unique plan addresses are kept', () => {
  const cams = [
    { mac: mac(3), ip: '192.168.0.10', model: 'AW-UE160' },
    { mac: mac(1), ip: '192.168.0.10', model: 'AW-UE150' },
    { mac: mac(2), ip: '192.168.0.105', model: 'AW-UE150A' },
  ];
  const ov = P.assign.overlap(cams);
  assert.equal(ov.factoryDefault.length, 2);
  const plan = P.assign.planAssignments(cams);
  assert.equal(plan.keep.length, 1);
  assert.equal(plan.keep[0].ip, '192.168.0.105');
  assert.equal(plan.keep[0].name, 'PTZ5');
  assert.deepEqual(plan.assign.map((a) => a.ip), ['192.168.0.101', '192.168.0.102']);
  assert.deepEqual(plan.assign.map((a) => a.name), ['PTZ1', 'PTZ2']);
  assert.equal(plan.assign[0].mac, mac(1), 'stable order by MAC');
  const w = P.assign.warnWindow(Date.now() - 21 * 60 * 1000);
  assert.equal(w.ok, false);
  assert.match(w.message, /power-cycle/i);
  assert.equal(P.assign.warnWindow(Date.now() - 5 * 60 * 1000).ok, true);
});

test('house profile has Steven\'s answers, no secret fields, and 20 Mbps default until tested', () => {
  const p = P.houseProfile.assertNoSecrets(P.houseProfile.houseProfile());
  assert.equal(p.system.format, '2160/59.94p');
  assert.equal(p.system.outputs.sdi12g, '1080/59.94p');
  assert.equal(p.system.outputs.hdmi, '1080/59.94p');
  assert.equal(p.system.install, 'desktop');
  assert.equal(p.crop.uhdCrop, '1080');
  assert.equal(p.crop.centered, true);
  assert.equal(p.userAuth, 'off');
  assert.equal(p.time.ntp.source, 'usg-gateway');
  assert.equal(p.time.ntp.addr, '192.168.0.1');
  assert.equal(p.network.easyIpWindow, '20min');
  assert.equal(p.paint.colorTempK, 5000);
  assert.equal(p.paint.nd, 'clear');
  assert.equal(p.paint.shutter, 'off');
  assert.equal(p.adminSecret, 'ptz-admin');
  assert.equal(p.ipVideo.h264[0].bitrateKbps, 20480);
  assert.equal(p.networkTest.defaultUntilTestedKbps, 20480);
  assert.equal(JSON.stringify(p).includes('pass'), false);
  assert.throws(() => P.houseProfile.assertNoSecrets({ adminPassword: 'x' }));
});

test('crop: centered even-pixel windows differ by model; commands default crop on', () => {
  const { crop } = P;
  assert.equal(crop.cropLegal('2160/59.94p'), true);
  assert.equal(crop.cropLegal('1080/59.94p'), false);
  const u150 = crop.centered('AW-UE150', 1080);
  assert.deepEqual({ x: u150.x, y: u150.y, w: u150.w, h: u150.h }, { x: 320, y: 180, w: 1920, h: 1080 });
  const u160 = crop.centered('AW-UE160', 1080);
  assert.deepEqual({ x: u160.x, y: u160.y }, { x: 576, y: 324 });
  const a = crop.centered('AW-UE150A', 1080);
  assert.equal(a.x % 2, 0);
  assert.equal(a.y % 2, 0);
  assert.equal(crop.clampWindow('AW-UE150', { x: 321, y: 181, mode: 1080 }).x, 320);
  const { cmds, pos } = crop.commands({ model: 'AW-UE160' });
  assert.equal(pos.x, 576);
  assert.ok(cmds.some((c) => c.cmd === 'OSJ:2E:1'));
  assert.ok(cmds.some((c) => c.cmd === 'OSJ:2F:240')); // 576 = 0x240
  assert.ok(cmds.some((c) => c.cmd === 'OSI:32:1'));
  const live = crop.commands({ model: 'AW-UE160', x: 576, y: 324, live: true });
  assert.equal(live.cmds.some((c) => c.cmd.startsWith('OSJ:2E')), false, 'mode not sent on a live nudge');
});

test('vault: shared admin lives in a 0600 file or the env, never in the public view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ptz-vault-'));
  const PW = `T-${crypto.randomBytes(8).toString('hex')}-a1`;
  try {
    assert.equal(P.vault.load({ dataDir: dir, env: {} }), null);
    const saved = P.vault.writeFile(dir, { user: 'house', pass: PW });
    assert.equal(saved.passSet, true);
    assert.equal(saved.user, 'house');
    assert.equal('pass' in saved, false);
    assert.equal(JSON.stringify(saved).includes(PW), false);
    const st = fs.statSync(P.vault.filePath(dir));
    assert.equal(st.mode & 0o777, 0o600);
    const loaded = P.vault.load({ dataDir: dir, env: {} });
    assert.equal(loaded.pass, PW);
    assert.equal(loaded.source, 'file');
    const envWins = P.vault.load({ dataDir: dir, env: { CC_PTZ_ADMIN_USER: 'envu', CC_PTZ_ADMIN_PASS: PW + 'X' } });
    assert.equal(envWins.source, 'env');
    assert.equal(envWins.user, 'envu');
    assert.equal(P.vault.publicView(loaded).passSet, true);
    assert.equal(JSON.stringify(P.vault.publicView(loaded)).includes(PW), false);
    assert.throws(() => P.vault.assertNotIn(JSON.stringify(loaded), loaded));
    P.vault.assertNotIn(JSON.stringify(P.vault.publicView(loaded)), loaded);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('network test: stepped bitrates, all cameras at once, recommend highest clean with headroom; default 20 Mbps until tested', () => {
  assert.equal(P.networkTest.DEFAULT_UNTIL_TESTED.kbps, 20480);
  const steps = P.houseProfile.H264_STEPS;
  assert.deepEqual(steps.map((s) => s.kbps), [8192, 12288, 20480, 25600]);
  assert.equal(steps[3].requestedMbps, 30);
  const clean = (kbps) => ({ cam: 'a', lossPct: 0, jitterMs: 4, decoderStalls: 0, kbps });
  const lossy = (kbps) => ({ cam: 'a', lossPct: 2, jitterMs: 4, decoderStalls: 0, kbps });
  const r = P.networkTest.recommend([
    P.networkTest.stepResult(steps[0], [clean(8192)]),
    P.networkTest.stepResult(steps[1], [clean(12288)]),
    P.networkTest.stepResult(steps[2], [clean(20480)]),
    P.networkTest.stepResult(steps[3], [lossy(25600)]),
  ], { throughputMbps: 80, cameraCount: 1 });
  assert.equal(r.kbps, 20480);
  assert.equal(r.applied, false);
  assert.equal(r.atCeiling, false);
});

test('network test run() pulls every camera at each step and does not apply', async () => {
  const pulled = [];
  const report = await P.networkTest.run({
    cameras: [{ id: 'cam1', ip: '192.168.0.101' }, { id: 'cam2', ip: '192.168.0.102' }],
    throughput: async (cam) => ({ mbps: 400, cam: cam.id }),
    pullAll: async (cams, step) => {
      pulled.push({ n: cams.length, kbps: step.kbps });
      return cams.map((c) => ({ cam: c.id, lossPct: step.kbps > 20480 ? 3 : 0, jitterMs: 5, decoderStalls: 0 }));
    },
  });
  assert.deepEqual(pulled.map((p) => p.n), [2, 2, 2, 2], 'every camera at once at each step');
  assert.equal(report.recommendation.kbps, 20480);
  assert.equal(report.recommendation.applied, false);
  assert.equal(report.defaultUntilTested.kbps, 20480);
});

test('Easy IP codec: documented prefix and TLVs; live write refused without the bench flag', () => {
  const { easyIp } = P;
  assert.equal(easyIp.CAPTURE_REQUIRED, true);
  const disc = easyIp.buildDiscovery({ senderMac: 'aa:bb:cc:dd:ee:ff', senderIp: '192.168.0.50' });
  assert.ok(disc.slice(0, 6).equals(easyIp.PREFIX));
  const rec = easyIp.buildReconfigure({ cameraMac: mac(1), ip: '192.168.0.101', mask: '255.255.255.0', gateway: '192.168.0.1', dns: ['192.168.0.1', '192.168.0.1'] });
  const parsed = easyIp.parseAnnouncement(rec);
  assert.equal(parsed.ip, '192.168.0.101');
  assert.equal(parsed.mask, '255.255.255.0');
  assert.equal(parsed.gateway, '192.168.0.1');
  assert.equal(parsed.httpPort, 80);
  assert.equal(parsed.unverified, true);
  // A bare TLV announcement (no prefix) still parses.
  const tlv = Buffer.concat([
    easyIp.writeTlv(32, easyIp.ipToBuf('192.168.0.10')),
    easyIp.writeTlv(33, easyIp.ipToBuf('255.255.255.0')),
    easyIp.writeTlv(167, Buffer.from('AW-UE160\0')),
  ]);
  const a = easyIp.parseAnnouncement(tlv);
  assert.equal(a.ip, '192.168.0.10');
  assert.equal(a.model, 'AW-UE160');
  assert.throws(() => easyIp.refuseLiveWrite({}), /CAPTURE|bench capture/i);
  assert.doesNotThrow(() => easyIp.refuseLiveWrite({ CC_PTZ_EASYIP_BENCH: '1' }));
});

test('paint: 5000K VAR, ND clear, shutter off; 5000 is 01388h', () => {
  assert.equal(P.paint.hex5(5000), '01388');
  const cmds = P.paint.commands().map((c) => c.cmd);
  assert.deepEqual(cmds, ['OAW:9', 'OSI:20:01388', 'OFT:0', 'OSJ:03:0']);
});

test('profile apply order and verify diff, hanging override, 20-min Easy IP window', async () => {
  const steps = P.profileApply.stepsFor(P.houseProfile.houseProfile(), { model: 'AW-UE160', title: 'PTZ1', install: 'hanging', bitrateKbps: 20480 });
  const ids = steps.map((s) => s.id);
  assert.ok(ids.indexOf('frequency') < ids.indexOf('format'));
  assert.ok(ids.indexOf('format') < ids.indexOf('crop'));
  assert.ok(ids.indexOf('ntp') < ids.indexOf('h264'));
  assert.ok(steps.find((s) => s.id === 'install').cmd.endsWith('1'), 'hanging');
  assert.match(steps.find((s) => s.id === 'easyIpWindow').cmd, /time=20/);
  assert.match(steps.find((s) => s.id === 'ntp').cmd, /ntp_addr=192\.168\.0\.1/);
  assert.match(steps.find((s) => s.id === 'format').cmd, /OSA:87:19/);
  assert.match(steps.find((s) => s.id === 'out12g').cmd, /OSJ:1E:10/);
  const sent = [];
  const replies = { 'QSA:87': 'OSA:87:19', 'QSE:77': 'OSE:77:0', 'QSJ:1E': 'OSJ:1E:10', 'QSJ:21': 'OSJ:21:10', 'QSJ:25': 'OSJ:25:10', 'QSJ:2E': 'OSJ:2E:1', 'QSJ:03': 'OSJ:03:0', 'QFT': 'OFT:0', 'QAW': 'OAW:9' };
  await P.profileApply.apply(steps, async ({ cmd, path }) => { sent.push({ path, cmd }); return 'ok'; });
  assert.ok(sent.some((s) => s.cmd === 'INS1'));
  assert.ok(sent.some((s) => s.cmd === 'OSJ:2E:1'));
  const diff = await P.profileApply.verify(P.profileApply.readbackPlan(), async ({ cmd }) => replies[cmd] || '');
  assert.equal(diff.ok, true);
  const bad = await P.profileApply.verify(P.profileApply.readbackPlan(), async ({ cmd }) => (cmd === 'QSA:87' ? 'OSA:87:10' : (replies[cmd] || '')));
  assert.equal(bad.ok, false);
  assert.equal(bad.rows.find((r) => r.id === 'format').ok, false);
});

test('wizard steps include NETWORK TEST; account CGI still unpublished; help mentions power-cycle and 20 Mbps', () => {
  const ids = P.wizard.STEPS.map((s) => s.id);
  assert.deepEqual(ids, ['discover', 'assign', 'account', 'network-test', 'apply', 'verify']);
  assert.equal(P.wizard.ACCOUNT_CGI_UNPUBLISHED, true);
  assert.equal(P.wizard.nextId('network-test'), 'apply');
  const h = P.wizard.helpFor('network-test');
  assert.match(h.why, /20 Mbps/);
  assert.match(P.wizard.helpFor('assign').fail, /power-cycle|minute/i);
});
