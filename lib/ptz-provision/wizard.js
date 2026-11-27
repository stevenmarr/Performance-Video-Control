'use strict';
// Provision wizard state machine. Steps always run in this order.
// Account registration CGI is unpublished; v1 either uses a captured form
// (not yet available) or a guided manual step, then stores the shared login
// in the vault and continues.

const STEPS = Object.freeze([
  { id: 'discover', label: 'Discover cameras by MAC' },
  { id: 'assign', label: 'Assign unique IPs and names' },
  { id: 'account', label: 'Shared admin account' },
  { id: 'network-test', label: 'Network test' },
  { id: 'apply', label: 'Apply house profile' },
  { id: 'verify', label: 'Read back and confirm' },
]);

const ACCOUNT_CGI_UNPUBLISHED = true;

function initial() {
  return {
    step: 'discover',
    status: 'idle',
    cameras: [],
    assignments: null,
    networkTest: null,
    apply: null,
    verify: null,
    help: helpFor('discover'),
  };
}

function helpFor(id) {
  const H = {
    discover: {
      why: 'Several factory-defaulted cameras all come up on 192.168.0.10. Easy IP still sees each one by its MAC.',
      fail: 'If nothing appears, confirm the cameras are on the same switch as this Pi (Easy IP does not cross a router), the 20-minute window is still open (power-cycle to reopen it), and nothing else is running Auto IP at the same time. Live address writes stay disabled until a bench capture of EasyIPSetupToolPlus confirms the datagram.',
    },
    assign: {
      why: 'Give each camera a unique address from the house plan (PTZ1 = 192.168.0.101, and so on) before anyone talks HTTP to them.',
      fail: 'After Save, wait about a minute and search again. Do not pull power or the LAN cable while it is applying. If the window expired, power-cycle and retry.',
    },
    account: {
      why: 'There is no factory password. The first administrator account has to be registered before Admin CGI (format, streams, NTP, crop defaults) will work. One shared account is stored only in the vault.',
      fail: 'Unique IPs first. If the registration form cannot be sent from Control Center yet (the CGI is unpublished), use EasyIPSetupToolPlus Administrator Registration or the camera web page, then store the same username and password in the vault and continue. Do not try random logins; the camera can lock the address out.',
    },
    'network-test': {
      why: 'This Pi measures the path to every camera, then pulls every H.264 stream at once at 8, 12, 20 and ~30 Mbps. It recommends the highest setting that stayed clean with headroom. Nothing is applied until you accept it. Until a test has been run, the profile uses 1080/59.94p at 20 Mbps.',
      fail: 'If the test cannot reach a camera, check the cable and the new address. If higher bitrates drop packets, accept a lower recommendation or fix the switch path and test again.',
    },
    apply: {
      why: 'The house profile sets 2160/59.94p on the camera so crop works, downconverts SDI / HDMI / 12G to 1080/59.94p, turns crop on and centered, points NTP at the router, leaves user authentication off, and applies 5000K, ND clear and shutter off. Frequency and format may reboot the camera; the wizard waits.',
      fail: 'If the camera drops during a format change, wait until it answers at the same IP and retry. A mismatch on an optional model-only setting is listed, not a failure.',
    },
    verify: {
      why: 'Read everything back and show wanted vs got. A required mismatch is not finished.',
      fail: 'Retry the mismatches, or accept and finish if you have a reason to leave a row as it is.',
    },
  };
  return H[id] || { why: '', fail: '' };
}

function nextId(id) {
  const i = STEPS.findIndex((s) => s.id === id);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1].id : null;
}

module.exports = { STEPS, ACCOUNT_CGI_UNPUBLISHED, initial, helpFor, nextId };
