'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function createServer(engine) {
  const clients = new Set();
  const broadcast = (event, data) => { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); };
  let pending = null;
  engine.on('state', () => { if (pending) return; pending = setTimeout(() => { pending = null; broadcast('state', engine.getState()); }, 30); });
  engine.on('log', (e) => broadcast('log', e));

  const routes = [];
  const route = (method, re, fn) => routes.push({ method, re, fn });

  route('GET', /^\/api\/state$/, () => engine.getState());
  // live device data
  const L = engine.live;
  const act = async (label, fn) => { try { const r = await fn(); engine.log('info', label); return { ok: true, value: r }; } catch (e) { e.status = e.status || 409; throw e; } };
  route('GET', /^\/api\/live$/, () => L.status());
  route('GET', /^\/api\/inputs$/, () => L.inputsView());
  route('GET', /^\/api\/tally$/, () => { const st = engine.getState(); return { source: st.tally.source, inputs: st.live.tally, presets: { preview: st.tally.preview, program: st.tally.program }, destinations: st.live.destinations }; });
  // memories imported from the device (0.3.0). ?all=1 includes empty/unknown slots.
  route('GET', /^\/api\/memories$/, (b, m, url) => ({ ...L.memoriesView(), catalog: engine.memoryCatalog({ all: url.searchParams.get('all') === '1' }) }));
  route('GET', /^\/api\/memories\/catalog$/, (b, m, url) => engine.memoryCatalog({ all: url.searchParams.get('all') === '1' }));
  route('POST', /^\/api\/memories\/refresh$/, () => engine.refreshMemories());
  route('POST', /^\/api\/memories\/load$/, (b) => engine.loadMemoryNow(b));
  // staging board (mix and match before saving)
  route('GET', /^\/api\/stage$/, () => engine.getState().staging);
  route('POST', /^\/api\/stage$/, (b) => engine.stage(b));
  route('DELETE', /^\/api\/stage$/, () => engine.clearStage());
  route('POST', /^\/api\/stage\/load$/, (b) => engine.loadStage(b));
  route('POST', /^\/api\/stage\/save$/, (b) => engine.saveStage(b));
  route('POST', /^\/api\/stage\/from\/(\d+)$/, (b, m) => engine.stageFromPreset(m[1]));
  route('POST', /^\/api\/presets\/(\d+)\/assign$/, (b, m) => engine.assignToPreset(m[1], b));
  route('GET', /^\/api\/backup$/, () => L.backupView());
  route('GET', /^\/api\/audio$/, () => L.audioView());
  route('POST', /^\/api\/inputs\/(\d+)\/freeze$/, (b, m) => act(`Input ${m[1]} freeze -> ${b.value ?? 'toggle'}`, () => L.setFreeze(+m[1], b.value)));
  route('POST', /^\/api\/inputs\/(\d+)\/backup$/, (b, m) => act(`Input ${m[1]} backup select ${b.slot}`, () => L.inputBackupSelect(+m[1], b.slot)));
  route('POST', /^\/api\/inputs\/(\d+)\/backup\/mode$/, (b, m) => act(`Input ${m[1]} backup auto=${!!b.auto}`, () => L.inputBackupMode(+m[1], b.auto)));
  route('POST', /^\/api\/backgrounds\/(S\d+)\/(\d+)\/backup$/, (b, m) => act(`Background ${m[1]}/${m[2]} backup select ${b.slot}`, () => L.bgBackupSelect(m[1], +m[2], b.slot)));
  route('POST', /^\/api\/backgrounds\/(S\d+)\/(\d+)\/backup\/mode$/, (b, m) => act(`Background ${m[1]}/${m[2]} backup auto=${!!b.auto}`, () => L.bgBackupMode(m[1], +m[2], b.auto)));
  route('POST', /^\/api\/groups\/(\d+)\/backup$/, (b, m) => act(`Group ${m[1]} backup select ${b.slot}`, () => L.groupBackupSelect(+m[1], b.slot)));
  route('POST', /^\/api\/groups\/(\d+)\/backup\/mode$/, (b, m) => act(`Group ${m[1]} backup auto=${!!b.auto}`, () => L.groupBackupMode(+m[1], b.auto)));
  route('POST', /^\/api\/audio\/(inputs|outputs)\/(\d+)\/channels\/(\d+)\/mute$/, (b, m) => act(`Audio ${m[1]} ${m[2]} ch ${m[3]} mute -> ${b.value ?? 'toggle'}`, () => L.audioMute(m[1] === 'inputs' ? 'in' : 'out', +m[2], +m[3], b.value)));
  route('GET', /^\/api\/log$/, () => engine.logs);
  route('GET', /^\/api\/settings$/, () => engine.publicSettings());
  route('POST', /^\/api\/settings$/, async (b) => { engine.updateSettings(b); await engine.connect(); return engine.getState(); });
  route('POST', /^\/api\/connect$/, async () => { await engine.connect(); return engine.getState(); });
  route('POST', /^\/api\/destinations\/refresh$/, async () => { await engine.connect(); return engine.getState(); });
  route('POST', /^\/api\/destinations\/([SAsa]\d+)\/toggle$/, (b, m) => ({ selection: engine.toggleDest(m[1]) }));
  route('POST', /^\/api\/selection$/, (b) => ({ selection: engine.setSelection(b.destinations || []) }));
  route('POST', /^\/api\/capture$/, (b) => engine.exclusive(async () => {
    const dests = (b.destinations && b.destinations.length ? b.destinations : [...engine.selection]);
    const cap = await engine.capture(dests);
    return { memories: cap.memories, warnings: cap.warnings };
  }));
  route('POST', /^\/api\/presets$/, (b) => engine.savePreset(b));
  route('GET', /^\/api\/presets\/(\d+)$/, (b, m) => { const p = engine.getPreset(m[1]); if (!p) throw Object.assign(new Error('not found'), { status: 404 }); return p; });
  route('PUT', /^\/api\/presets\/(\d+)$/, (b, m) => engine.editPreset(m[1], b));
  route('DELETE', /^\/api\/presets\/(\d+)$/, (b, m) => { engine.deletePreset(m[1]); return { ok: true }; });
  route('POST', /^\/api\/presets\/(\d+)\/recall$/, (b, m) => engine.recall(m[1]));
  route('POST', /^\/api\/presets\/(\d+)\/update$/, (b, m) => engine.updatePreset(m[1], b));
  route('POST', /^\/api\/presets\/(\d+)\/duplicate$/, (b, m) => engine.duplicatePreset(m[1], b.toNumber));
  route('POST', /^\/api\/take$/, () => engine.take());
  route('POST', /^\/api\/cut$/, () => engine.cut());
  route('POST', /^\/api\/autotake$/, (b) => ({ autoTake: engine.setAutoTake(b.value) }));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(engine.getState())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    // Long-poll: GET /api/state?since=<rev>&timeout=<ms> answers as soon as rev > since (or on timeout).
    if (req.method === 'GET' && url.pathname === '/api/state' && url.searchParams.has('since')) {
      const since = Number(url.searchParams.get('since')); const timeout = Math.min(60000, Math.max(0, Number(url.searchParams.get('timeout') || 25000)));
      if (engine.rev > since) return json(200, engine.getState());
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); engine.off('state', onState); json(200, engine.getState()); };
      const onState = () => { if (engine.rev > since) setTimeout(finish, 15); }; // let bursts settle
      const t = setTimeout(finish, timeout);
      engine.on('state', onState);
      req.on('close', () => { if (!done) { done = true; clearTimeout(t); engine.off('state', onState); } });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return json(404, { error: `No route ${req.method} ${url.pathname}` });
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        let body = {};
        if (raw) { try { body = JSON.parse(raw); } catch { return json(400, { error: 'Invalid JSON body' }); } }
        try { const out = await r.fn(body || {}, url.pathname.match(r.re), url); json(200, out === undefined ? { ok: true } : out); }
        catch (e) { engine.log('error', `${req.method} ${url.pathname}: ${e.message}`); json(e.status || 400, { error: e.message }); }
      });
      return;
    }

    // static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (file === '/settings') file = '/index.html';
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  server.closeClients = () => { for (const c of clients) c.end(); clients.clear(); };
  return server;
}

module.exports = { createServer };
