'use strict';
const { houseProfile, FORMAT } = require('./house-profile');
const crop = require('./crop');
const paint = require('./paint');

const hx = (n, w = 2) => Number(n).toString(16).toUpperCase().padStart(w, '0');

function installCode(v) { return v === 'hanging' || v === 1 || v === '1' ? 1 : 0; }

// Ordered list of settings the wizard applies. Each step is skipped when the
// current model does not have it. Reboot-likely steps are marked.
function stepsFor(profile, { model, title, install, bitrateKbps } = {}) {
  const p = profile || houseProfile();
  const kbps = bitrateKbps || (p.ipVideo && p.ipVideo.h264 && p.ipVideo.h264[0] && p.ipVideo.h264[0].bitrateKbps) || 20480;
  const titleText = title || 'PTZ1';
  const inst = installCode(install != null ? install : p.system.install);
  const cropDef = crop.centered(model, p.crop.uhdCrop === '720' ? 720 : 1080);
  const out = [];
  const add = (row) => out.push(row);

  add({ id: 'title', label: 'Camera title', path: 'web', cmd: `set_basic?cam_title=${encodeURIComponent(titleText)}`, also: { path: 'cam', cmd: `OSJ:5C:${Buffer.from(String(titleText).padEnd(20, ' ').slice(0, 20), 'ascii').toString('hex').toUpperCase()}` } });
  add({ id: 'frequency', label: 'System frequency 59.94 Hz', path: 'cam', cmd: `OSE:77:${FORMAT.frequencyCode}`, reboot: true });
  add({ id: 'format', label: 'System format 2160/59.94p', path: 'cam', cmd: `OSA:87:${hx(FORMAT.systemCode)}`, reboot: true });
  add({ id: 'out12g', label: '12G SDI / SFP+ output 1080/59.94p', path: 'cam', cmd: `OSJ:1E:${hx(FORMAT.outputCode)}` });
  add({ id: 'out3g', label: '3G SDI output 1080/59.94p', path: 'cam', cmd: `OSJ:21:${hx(FORMAT.outputCode)}` });
  add({ id: 'outhdmi', label: 'HDMI output 1080/59.94p', path: 'cam', cmd: `OSJ:25:${hx(FORMAT.outputCode)}` });
  add({ id: 'install', label: inst ? 'Install position hanging' : 'Install position desktop', path: 'ptz', cmd: `INS${inst}` });
  add({ id: 'powerOn', label: 'Power-on position home', path: 'cam', cmd: 'OSJ:45:2', models: ['AW-UE160', 'AW-UE163'] }); // unconfirmed on UE150
  add({ id: 'easyIpWindow', label: 'Easy IP window 20 minutes', path: 'web', cmd: model && /UE160|UE163/.test(model) ? 'network?time=20' : 'easyipset?time=20', afterLogin: true });
  add({ id: 'ntp', label: `NTP to USG gateway ${p.time.ntp.addr}`, path: 'web',
    cmd: `time?time_adjust=1&ntp_addr_dhcp=0&ntp_addr=${encodeURIComponent(p.time.ntp.addr)}&ntp_port=${p.time.ntp.port}&ntp_interval=${p.time.ntp.intervalHours}` });
  add({ id: 'userAuth', label: 'User authentication off', path: 'web', cmd: 'set_basic?auth=off', optional: true, note: 'CGI name unconfirmed; leave factory Off if the camera refuses this.' });
  add({ id: 'streamMode', label: 'Stream mode H.264', path: 'web', cmd: 'set_stream_mode?mode=h264', alias: 'set_priority_mode?mode=h264' });
  add({ id: 'h264', label: `H.264(1) 1080/59.94p ${kbps} kbps CBR unicast`, path: 'web',
    cmd: `set_h264?h264_transmit=1&h264_resolution=1920&framerate=60&f_priority=0&h264_quality=fine&h264_bandwidth=${kbps}` });
  add({ id: 'audio', label: 'Audio over IP 128 kbps', path: 'web', cmd: 'set_audio?audio_transmit=1&audio_bitrate=128' });
  add({ id: 'rtsp', label: 'RTSP port 554', path: 'web', cmd: 'set_rtsp?rtsp_port=554' });
  if (p.crop && p.crop.uhdCrop !== 'off') {
    const cropCmds = crop.commands({ model, mode: p.crop.uhdCrop === '720' ? 720 : 1080, sdiOut: p.crop.sdiOut, ipOut: p.crop.ipOut });
    add({ id: 'crop', label: `UHD crop ${p.crop.uhdCrop} centered (${cropDef.x},${cropDef.y})`, cmds: cropCmds.cmds });
  }
  if (p.paint && p.paint.mode === 'house-initial') {
    add({ id: 'paint', label: 'Initial paint 5000K, ND clear, shutter off', cmds: paint.commands() });
  }
  return out;
}

function readbackPlan() {
  return [
    { id: 'frequency', label: 'System frequency', path: 'cam', cmd: 'QSE:77', want: String(FORMAT.frequencyCode) },
    { id: 'format', label: 'System format', path: 'cam', cmd: 'QSA:87', want: hx(FORMAT.systemCode) },
    { id: 'out12g', label: '12G SDI output', path: 'cam', cmd: 'QSJ:1E', want: hx(FORMAT.outputCode) },
    { id: 'out3g', label: '3G SDI output', path: 'cam', cmd: 'QSJ:21', want: hx(FORMAT.outputCode) },
    { id: 'outhdmi', label: 'HDMI output', path: 'cam', cmd: 'QSJ:25', want: hx(FORMAT.outputCode) },
    { id: 'install', label: 'Install position', path: 'ptz', cmd: 'INS', wantSoft: true },
    { id: 'crop', label: 'UHD crop', path: 'cam', cmd: 'QSJ:2E', want: '1' },
    { id: 'shutter', label: 'Shutter', path: 'cam', cmd: 'QSJ:03', want: '0' },
    { id: 'nd', label: 'ND filter', path: 'cam', cmd: 'QFT', want: '0' },
    { id: 'wb', label: 'WB mode', path: 'cam', cmd: 'QAW', want: '9' },
  ];
}

function normalizeReply(reply) {
  return String(reply || '').trim().replace(/^(?:[A-Z]{2,3}:[0-9A-F]{2}:)?/i, (m) => m).replace(/^[^:]*:/, (m, off, s) => (s.split(':').length > 2 ? '' : m));
}

function compare(want, got) {
  if (want == null) return { ok: true, skipped: true };
  const a = String(want).replace(/^0+/, '') || '0';
  const b = String(got == null ? '' : got).trim();
  const bh = b.split(':').pop().replace(/^0x/i, '');
  const ok = b === String(want) || bh.toUpperCase() === String(want).toUpperCase() || parseInt(bh, 16) === parseInt(String(want), 16) || parseInt(bh, 16) === Number(want);
  return { ok, want, got: b };
}

async function apply(steps, send, { waitReboot } = {}) {
  const results = [];
  for (const step of steps) {
    const cmds = step.cmds || [{ path: step.path, cmd: step.cmd, alias: step.alias, also: step.also }];
    const row = { id: step.id, label: step.label, ok: true, replies: [] };
    try {
      for (const c of cmds) {
        if (!c || !c.cmd) continue;
        try {
          const r = await send(c);
          row.replies.push({ cmd: c.cmd, reply: r });
        } catch (e) {
          if (c.alias) {
            const r = await send({ ...c, cmd: c.alias });
            row.replies.push({ cmd: c.alias, reply: r, usedAlias: true });
          } else if (c.also) {
            const r = await send(c.also);
            row.replies.push({ cmd: c.also.cmd, reply: r, usedFallback: true });
          } else throw e;
        }
      }
      if (step.reboot && typeof waitReboot === 'function') await waitReboot(step);
    } catch (e) {
      row.ok = false;
      row.error = e.message;
      if (!step.optional) { results.push(row); throw Object.assign(new Error(`${step.label} failed: ${e.message}`), { step: row, results }); }
    }
    results.push(row);
  }
  return results;
}

async function verify(plan, send) {
  const rows = [];
  let ok = true;
  for (const step of plan) {
    try {
      const reply = await send(step);
      const got = String(reply || '').trim();
      const cmp = step.want == null ? { ok: true, skipped: true, got } : compare(step.want, got);
      if (!cmp.ok && !step.wantSoft) ok = false;
      rows.push({ id: step.id, label: step.label, ...cmp, reply: got });
    } catch (e) {
      if (!step.wantSoft) ok = false;
      rows.push({ id: step.id, label: step.label, ok: false, error: e.message });
    }
  }
  return { ok, rows };
}

module.exports = { stepsFor, readbackPlan, apply, verify, compare, installCode, hx };
