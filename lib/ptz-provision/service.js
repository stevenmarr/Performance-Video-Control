'use strict';
const { houseProfile, assertNoSecrets } = require('./house-profile');
const housePlan = require('./house-plan');
const assign = require('./assign');
const easyIp = require('./easy-ip');
const vault = require('./vault');
const networkTest = require('./network-test');
const crop = require('./crop');
const profileApply = require('./profile-apply');
const wizard = require('./wizard');

class ProvisionService {
  constructor({ systems, dataDir, log = () => {}, transport = null } = {}) {
    this.systems = systems;
    this.dataDir = dataDir;
    this.log = log;
    this.transport = transport; // { scan(), configure(assignment) } for tests / bench
    this._lastTest = null;
    this._state = wizard.initial();
  }

  view() {
    return {
      ...this._state,
      plan: { subnet: housePlan.PLAN.subnet, factoryDefaultIp: housePlan.PLAN.factoryDefaultIp, first: housePlan.assignmentFor(1), gateway: housePlan.PLAN.gateway, easyIpWindow: housePlan.PLAN.easyIpWindow },
      profile: assertNoSecrets(houseProfile()),
      vault: vault.publicView(vault.load({ dataDir: this.dataDir })),
      easyIp: { captureRequired: easyIp.CAPTURE_REQUIRED, bench: easyIp.benchEnabled(), ports: easyIp.PORTS },
      lastNetworkTest: this._lastTest && { ...this._lastTest, recommendation: this._lastTest.recommendation },
      steps: wizard.STEPS,
      help: wizard.helpFor(this._state.step),
    };
  }

  discover(cameras) {
    const list = cameras || (this.transport && this.transport.scan && this.transport.scan()) || [];
    if (!cameras && !this.transport) {
      try { easyIp.refuseLiveWrite(); } catch (e) {
        this._state = { ...this._state, step: 'discover', status: 'blocked', error: e.message, cameras: [], help: wizard.helpFor('discover') };
        throw e;
      }
    }
    const ov = assign.overlap(list);
    const planned = assign.planAssignments(list);
    this._state = { ...this._state, step: 'assign', status: 'ok', cameras: list, overlap: ov, assignments: planned, help: wizard.helpFor('assign') };
    return this.view();
  }

  assignOne(mac, { order } = {}) {
    if (this.transport && this.transport.configure) {
      easyIp.refuseLiveWrite();
    } else {
      easyIp.refuseLiveWrite();
    }
  }

  async networkTest({ cameras, throughput, pullAll } = {}) {
    const cams = cameras || (this.systems && this.systems.view('ptz').cameras) || [];
    const report = await networkTest.run({ cameras: cams, throughput, pullAll });
    this._lastTest = report;
    this._state = { ...this._state, step: 'network-test', status: 'ok', networkTest: { recommendation: report.recommendation, at: report.at }, help: wizard.helpFor('apply') };
    return report;
  }

  async applyProfile({ cam, model, title, install, bitrateKbps, send, waitReboot } = {}) {
    if (typeof send !== 'function') throw Object.assign(new Error('Profile apply needs a camera send function'), { status: 400 });
    const kbps = bitrateKbps || (this._lastTest && this._lastTest.recommendation && this._lastTest.recommendation.kbps) || 20480;
    const steps = profileApply.stepsFor(houseProfile(), { model, title, install, bitrateKbps: kbps });
    const results = await profileApply.apply(steps, send, { waitReboot });
    this._state = { ...this._state, step: 'verify', status: 'ok', apply: { cam, kbps, results }, help: wizard.helpFor('verify') };
    return { kbps, results };
  }

  async verify({ send } = {}) {
    const diff = await profileApply.verify(profileApply.readbackPlan(), send);
    this._state = { ...this._state, verify: diff, status: diff.ok ? 'ok' : 'mismatch' };
    return diff;
  }

  cropState(model, values = {}) {
    const format = values.format || values.systemFormat;
    const legal = crop.cropLegal(format || '2160/59.94p');
    const pos = crop.centered(model, 1080);
    return { legal, reason: legal ? null : 'Crop needs a 2160 system format (house profile uses 2160/59.94p).', default: pos, colors: crop.COLORS };
  }

  cropCommands(opts) { return crop.commands(opts); }
}

module.exports = { ProvisionService };
