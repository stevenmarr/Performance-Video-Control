'use strict';
// Scopes data lives outside the app folder.
//   macOS    ~/Library/Application Support/PVLLC Scopes
//   Windows  %APPDATA%\PVLLC Scopes
//   Linux    ~/.config/pvllc-scopes
// Overrides: --data, then SCOPES_DATA_DIR, then RS6_DATA_DIR.
// Mock mode uses <app>/mock-data. A one-time import copies scopes.json from the
// old RS6 Presets folder and does not delete that folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fillFromSystems } = require('./cameras');

function defaultDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'PVLLC Scopes');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'PVLLC Scopes');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'pvllc-scopes');
}

function legacyDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'RS6 Presets');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'RS6 Presets');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'rs6-presets');
}

function resolveDataDir({ argData, env = process.env, mock = false, appDir, platform, home } = {}) {
  if (argData && argData !== true) return { dir: path.resolve(String(argData)), source: '--data' };
  if (env.SCOPES_DATA_DIR) return { dir: path.resolve(env.SCOPES_DATA_DIR), source: 'SCOPES_DATA_DIR' };
  if (env.RS6_DATA_DIR) return { dir: path.resolve(env.RS6_DATA_DIR), source: 'RS6_DATA_DIR' };
  if (mock) return { dir: path.join(appDir, 'mock-data'), source: 'mock' };
  return { dir: defaultDataDir({ platform, env, home }), source: 'default' };
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

// Empty destination only. Never deletes or moves the RS6 Presets files.
function importLegacy({ destDir, platform, env, home, sourceDir } = {}) {
  const marker = path.join(destDir, 'migrated-from.json');
  const destFile = path.join(destDir, 'scopes.json');
  if (fs.existsSync(destFile) || fs.existsSync(marker)) return { imported: false, reason: 'dest not empty' };
  const fromDir = sourceDir || legacyDataDir({ platform, env, home });
  const src = path.join(fromDir, 'scopes.json');
  if (!fs.existsSync(src)) return { imported: false, reason: 'no legacy file' };
  const cfg = readJson(src);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { imported: false, reason: 'legacy file unreadable' };
  const systems = readJson(path.join(fromDir, 'systems.json'));
  if (systems) fillFromSystems(cfg, systems);
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = `${destFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, destFile);
  fs.writeFileSync(marker, JSON.stringify({ from: src, at: new Date().toISOString() }, null, 2));
  return { imported: true, from: src };
}

module.exports = { defaultDataDir, legacyDataDir, resolveDataDir, importLegacy };
