'use strict';
// House IPv4 plan for Panasonic PTZ cameras on the Panasonic default subnet.
// Reset cameras sit at 192.168.0.10. Cam 1 is 192.168.0.101, cam 2 is .102, and so on.
// Names are PTZ1, PTZ2, … (n = last octet − 100). The USG gateway is assumed at .1;
// override gateway/ntpAddr in the plan if the router is at a different address.

const NET = '192.168.0';
const PLAN = Object.freeze({
  subnet: `${NET}.0/24`,
  mask: '255.255.255.0',
  gateway: `${NET}.1`,
  dns: Object.freeze([`${NET}.1`]),
  httpPort: 80,
  factoryDefaultIp: `${NET}.10`,
  firstCameraHost: 101, // .101 = PTZ1
  lastCameraHost: 254,
  ntpAddr: `${NET}.1`,
  ntpPort: 123,
  ntpIntervalHours: 12,
  easyIpWindow: '20min',
  titleTemplate: 'PTZ{{n}}',
});

const ipOf = (n) => `${NET}.${Number(n)}`;
const hostOf = (ip) => {
  const m = String(ip || '').trim().match(/^192\.168\.0\.(\d+)$/);
  return m ? Number(m[1]) : null;
};
const nameOf = (n) => `PTZ${Number(n) - 100}`;
const indexOfName = (name) => {
  const m = /^PTZ(\d+)$/i.exec(String(name || '').trim());
  return m ? Number(m[1]) : null;
};
const reserved = (n) => n === 0 || n === 255 || n === 1 || n === 10;
const inRange = (n) => Number.isInteger(n) && n >= PLAN.firstCameraHost && n <= PLAN.lastCameraHost;

function assignmentFor(index) {
  const n = PLAN.firstCameraHost + (Number(index) - 1);
  if (!inRange(n)) throw Object.assign(new Error(`No house address left for camera ${index} (plan is ${ipOf(PLAN.firstCameraHost)}–${ipOf(PLAN.lastCameraHost)})`), { status: 400 });
  return { index: Number(index), host: n, ip: ipOf(n), name: nameOf(n), mask: PLAN.mask, gateway: PLAN.gateway, dns: [...PLAN.dns], httpPort: PLAN.httpPort };
}

function fromAddress(ip) {
  const n = hostOf(ip);
  if (!inRange(n)) return null;
  return { index: n - 100, host: n, ip: ipOf(n), name: nameOf(n), mask: PLAN.mask, gateway: PLAN.gateway, dns: [...PLAN.dns], httpPort: PLAN.httpPort };
}

function nextFree(usedIps) {
  const used = new Set((usedIps || []).map((ip) => hostOf(ip)).filter((n) => n != null));
  for (let n = PLAN.firstCameraHost; n <= PLAN.lastCameraHost; n++) {
    if (reserved(n) || used.has(n)) continue;
    return assignmentFor(n - 100);
  }
  throw Object.assign(new Error('The house PTZ address plan is full'), { status: 409 });
}

module.exports = { PLAN, NET, ipOf, hostOf, nameOf, indexOfName, reserved, inRange, assignmentFor, fromAddress, nextFree };
