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
  // live state (AWJ subscriptions with polling fallback)
  liveEnabled: true,
  pollMs: 1000,          // fallback poll interval
  maxInputs: 32,         // RS6 has up to 32 inputs
  audioChannels: 8,      // channels probed per audio input/output
  maxAudioOutputs: 20,
  maxBgSets: 8,          // background sets per screen (REST p.69: 1-8)
  maxGroups: 8,          // backup groups probed
  screenMemoryLabels: 1000, // Screen memory labels read (Manual §15: up to 1000)
  masterMemoryLabels: 500,  // Master memory labels read (up to 500)
  mvMemories: 50,           // Multiviewer memory slots (Manual §16.4, REST §5.2: 1-50)
  maxMultiviewers: 8,       // Multiviewer outputs probed (REST §5.1: 1-8; an RS6 has 2)
  // OFF by default: also read the INFERRED, undocumented memory paths (slot isValid for Screen/Master/
  // Multiviewer banks, Multiviewer memory labels). See lib/paths.js. Without it only labels are read.
  memoryProbe: false,
  layerMemories: false,     // 0.3.4: read + recall Layer memories over INFERRED AWJ paths (see lib/paths.js)
};
const NUMERIC_SETTINGS = ['restPort', 'awjPort', 'maxScreens', 'maxAux', 'maxLayers', 'pollMs', 'maxInputs', 'audioChannels', 'maxAudioOutputs', 'maxBgSets', 'maxGroups', 'screenMemoryLabels', 'masterMemoryLabels', 'mvMemories', 'maxMultiviewers'];

module.exports = { readJson, writeJsonAtomic, DEFAULT_SETTINGS, NUMERIC_SETTINGS };
