'use strict';
// Common switcher driver interface (0.6.0). Every system the app can drive (Analog Way Aquilon RS6, Barco Event
// Master E2/S3, PixelHue P/Q series) is wrapped in a driver with the same shape, so the routes in lib/server.js
// and the shared UI in public/sys.js never need to know which protocol is underneath.
//
//   driver.system                 'rs6' | 'e2' | 'pixelhue'
//   driver.capabilities           { presets, recallPreview, recallProgram, take, cut, destinations, armDestinations,
//                                   sources, freeze, auxRoute, stills, cues, backups, destFilteredRecall }
//   await driver.connect()        -> { model, version, ... }          (throws when the device is unreachable)
//   driver.close()
//   driver.status()               -> { connected, info, error, lastSeen }
//   await driver.listPresets()    -> [{ key, id, number, name, dests: ['S1', 'A2'] | null }]
//   await driver.listDestinations() -> [{ key: 'S1' | 'A1', kind: 'screen' | 'aux', id, label }]
//   await driver.listSources()    -> [{ key, id, name, kind: 'input' | 'still' | 'dest', status, frozen }]
//   await driver.recall(preset, { target: 'preview' | 'program', dests })
//   await driver.select(destKeys) (arm on E2; PixelHue / RS6 keep it in the app)
//   await driver.take(destKeys, opts) / await driver.cut(destKeys, opts)
//   optional: listCues / activateCue, listStills / takeStill / deleteStill, listBackups / selectBackup,
//             freeze(kind, id, on), routeAux(auxKey, sourceId, target)
//
// Destination keys are always S<n> (screen) / A<n> (aux), 1-based for display. Drivers map them to the device's
// own ids (E2 indices are 0-based; PixelHue screen ids are whatever the device reports).
const http = require('http');

function httpJson({ host, port, method = 'GET', path = '/', body, headers = {}, timeout = 4000 }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host, port, method, path, timeout, headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; if (raw.length > 16e6) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        let j = null; try { j = raw ? JSON.parse(raw) : null; } catch { return reject(Object.assign(new Error(`${method} ${path}: HTTP ${res.statusCode}, not JSON`), { status: res.statusCode })); }
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`${method} ${path}: HTTP ${res.statusCode}${j && j.message ? ` (${j.message})` : ''}`), { status: res.statusCode, body: j }));
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} http://${host}:${port}${path} timed out after ${timeout} ms`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const destKey = (kind, n) => `${kind === 'aux' ? 'A' : 'S'}${n}`;
function parseKey(k) { const m = /^([SA])(\d+)$/.exec(String(k || '').toUpperCase()); return m ? { kind: m[1] === 'S' ? 'screen' : 'aux', n: Number(m[2]) } : null; }

module.exports = { httpJson, destKey, parseKey };
