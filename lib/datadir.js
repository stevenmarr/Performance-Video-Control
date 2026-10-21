'use strict';
// 0.5.0: where the app keeps its data (settings, presets, the show library), OUTSIDE the app folder, so a new
// version unzipped somewhere else (or over the old one) starts with the same configuration.
//   macOS    ~/Library/Application Support/RS6 Presets
//   Windows  %APPDATA%\RS6 Presets
//   Linux    $XDG_CONFIG_HOME/rs6-presets, or ~/.config/rs6-presets
// Overrides, in order: --data <dir>, RS6_DATA_DIR. Mock mode keeps using <app>/mock-data so demo data never mixes
// with a real show.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILES = ['settings.json', 'presets.json'];

function defaultDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'RS6 Presets');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'RS6 Presets');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'rs6-presets');
}

function resolveDataDir({ argData, env = process.env, mock = false, appDir, platform, home } = {}) {
  if (argData && argData !== true) return { dir: path.resolve(String(argData)), source: '--data' };
  if (env.RS6_DATA_DIR) return { dir: path.resolve(env.RS6_DATA_DIR), source: 'RS6_DATA_DIR' };
  if (mock) return { dir: path.join(appDir, 'mock-data'), source: 'mock' };
  return { dir: defaultDataDir({ platform, env, home }), source: 'default' };
}

const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const hasData = (dir) => DATA_FILES.some((f) => fs.existsSync(path.join(dir, f)));
// An old copy of the app: a folder with server.js and at least one data file.
const isAppCopy = (dir) => { try { return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'server.js')) && hasData(dir); } catch { return false; } };

// Folders that may hold an older version's data: this app folder, its rs6-presets* siblings (the next unzip often
// lands next to the last one, e.g. "rs6-presets 2" or "rs6-presets-main"), and rs6-presets* in ~/Downloads and
// ~/Dropbox/Downloads. Read-only.
function legacyCandidates({ appDir, home = os.homedir() } = {}) {
  const roots = new Set([path.dirname(appDir), path.join(home, 'Downloads'), path.join(home, 'Dropbox', 'Downloads'), path.join(home, 'Desktop')]);
  const out = new Set([appDir]);
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names) if (/^rs6[-_ ]?presets/i.test(n)) out.add(path.join(r, n));
  }
  return [...out].filter(isAppCopy);
}

// Pick the copy whose presets.json (else settings.json) was written last.
function newestLegacy(cands) {
  // a copy with presets beats one with only settings; then the newest file wins
  const score = (d) => { const p = mtime(path.join(d, 'presets.json')); return p ? [1, p] : [0, mtime(path.join(d, 'settings.json'))]; };
  return cands.slice().sort((a, b) => { const x = score(a); const y = score(b); return y[0] - x[0] || y[1] - x[1] || (a < b ? -1 : 1); })[0] || null;
}

// First start with an empty data dir: COPY (never move) the data files from the newest old copy. Returns what
// happened, for the log and the Settings page. Does nothing when the data dir already has data.
function migrateLegacy({ dataDir, appDir, home, candidates } = {}) {
  if (hasData(dataDir)) return { migrated: false, reason: 'data dir already has data' };
  const cands = (candidates || legacyCandidates({ appDir, home })).filter((d) => path.resolve(d) !== path.resolve(dataDir));
  const src = newestLegacy(cands);
  if (!src) return { migrated: false, reason: 'no older copy found', searched: cands };
  fs.mkdirSync(dataDir, { recursive: true });
  const copied = [];
  for (const f of DATA_FILES) {
    const from = path.join(src, f);
    if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(dataDir, f)); copied.push(f); }
  }
  const info = { migrated: true, from: src, files: copied, at: new Date().toISOString(), candidates: cands };
  fs.writeFileSync(path.join(dataDir, 'migrated-from.json'), JSON.stringify(info, null, 2));
  return info;
}

module.exports = { defaultDataDir, resolveDataDir, legacyCandidates, newestLegacy, migrateLegacy, DATA_FILES };
