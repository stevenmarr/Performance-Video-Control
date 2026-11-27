'use strict';
const { PLAN, hostOf, fromAddress, nextFree, reserved } = require('./house-plan');

function overlap(cameras) {
  const byIp = new Map();
  for (const c of cameras || []) {
    const ip = String(c.ip || '').trim();
    if (!ip) continue;
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(c);
  }
  const clashes = [...byIp.entries()].filter(([, list]) => list.length > 1 || list[0].ip === PLAN.factoryDefaultIp);
  return {
    clashes: clashes.map(([ip, list]) => ({ ip, macs: list.map((c) => c.mac) })),
    factoryDefault: (byIp.get(PLAN.factoryDefaultIp) || []).map((c) => c.mac),
  };
}

// Assign unique house IPs one camera at a time, keyed by MAC.
// Cameras that already hold a unique address in the plan keep it.
// Others take the next free address starting at .101. Sort by MAC so a
// repeated run is stable if the operator does not pick a specific order.
function planAssignments(cameras, { order } = {}) {
  const list = [...(cameras || [])];
  const byMac = new Map(list.map((c) => [String(c.mac || '').toLowerCase(), c]));
  const used = [];
  const keep = [];
  for (const c of list) {
    const cur = fromAddress(c.ip);
    const others = list.filter((x) => x !== c && x.ip === c.ip);
    if (cur && others.length === 0 && c.ip !== PLAN.factoryDefaultIp) {
      used.push(c.ip);
      keep.push({ mac: c.mac, action: 'keep', ...cur, model: c.model, currentIp: c.ip });
    }
  }
  const need = list.filter((c) => !keep.some((k) => k.mac === c.mac));
  const seq = order && order.length ? order.map((m) => byMac.get(String(m).toLowerCase())).filter(Boolean)
    : need.sort((a, b) => String(a.mac).localeCompare(String(b.mac)));
  const assign = [];
  for (const c of seq) {
    if (!c) continue;
    if (keep.some((k) => k.mac === c.mac) || assign.some((k) => k.mac === c.mac)) continue;
    const next = nextFree(used);
    used.push(next.ip);
    assign.push({ mac: c.mac, action: 'assign', ...next, model: c.model, currentIp: c.ip });
  }
  return { keep, assign, used, overlap: overlap(list) };
}

function warnWindow(bootAt, now = Date.now()) {
  if (!bootAt) return { ok: null, message: 'Easy IP is refused about 20 minutes after the camera boots. Power-cycle the camera to reopen the window.' };
  const left = 20 * 60 * 1000 - (now - bootAt);
  if (left <= 0) return { ok: false, message: 'The 20-minute Easy IP window has probably closed. Power-cycle the camera and try again.' };
  return { ok: true, leftMs: left, message: `About ${Math.ceil(left / 60000)} minutes left in the Easy IP window.` };
}

module.exports = { overlap, planAssignments, warnWindow, reserved, hostOf };
