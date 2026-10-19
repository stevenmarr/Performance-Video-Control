'use strict';
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error(`Could not read ${file}: ${e.message}`); return fallback; }
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
  host: '127.0.0.1',     // simulator on the same Mac; set to the RS6 IP for the real unit
  restPort: 3001,        // REST/Web RCS port: 80 on a real unit, the session port on the Simulator
  https: false,
  awjPort: 10606,        // AWJ raw TCP (AWJ p.3)
  protocol: 'rest',      // 'rest' or 'awj' for loads and takes
  awjReadback: true,     // use AWJ reads (AWJ p.13, p.16) to auto-detect Screen memory slots when saving
  password: '',          // Web RCS password; empty if protection is off
  maxScreens: 24,        // REST p.11 range
  maxAux: 20,
  maxLayers: 8,          // layers per screen to snapshot (REST allows 1-128)
  autoTake: false,
  presetToggle: false,   // match the device's Transition > Preset Toggle setting (User Manual 14.1.9) for tally
};

module.exports = { readJson, writeJsonAtomic, DEFAULT_SETTINGS };
