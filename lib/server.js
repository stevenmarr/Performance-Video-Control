'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function createServer(engine, systems = null) {
  const clients = new Set();
  const broadcast = (event, data) => { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); };
  let pending = null;
  engine.on('state', () => { if (pending) return; pending = setTimeout(() => { pending = null; broadcast('state', engine.getState()); }, 30); });
  engine.on('log', (e) => broadcast('log', e));
  // 0.6.0 multi-system: E2 / PixelHue state goes out as its own `sys` event
  let sysPending = null;
  let sysDue = 0;
  const sysSoon = (ms) => {
    const due = Date.now() + ms;
    if (sysPending && sysDue <= due) return;
    clearTimeout(sysPending); sysDue = due;
    sysPending = setTimeout(() => { sysPending = null; broadcast('sys', systems.getState()); }, ms);
  };
  if (systems) { systems.on('state', () => sysSoon(30)); engine.on('state', () => sysSoon(1000)); } // RS6 card on the dashboard

  const routes = [];
  const route = (method, re, fn) => routes.push({ method, re, fn });
  const V = (p) => engine.presetView(p);

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
  route('POST', /^\/api\/stage\/save$/, (b) => V(engine.saveStage(b)));
  route('POST', /^\/api\/stage\/from\/(\d+)$/, (b, m) => engine.stageFromPreset(m[1]));
  route('POST', /^\/api\/presets\/(\d+)\/assign$/, (b, m) => V(engine.assignToPreset(m[1], b)));
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
  route('POST', /^\/api\/presets$/, (b) => engine.savePreset(b).then(V));
  route('GET', /^\/api\/presets\/(\d+)$/, (b, m) => { const p = engine.getPreset(m[1]); if (!p) throw Object.assign(new Error('not found'), { status: 404 }); return V(p); });
  // 0.3.3: the default name for content about to be saved ({memories, master, mvMemories})
  route('POST', /^\/api\/presets\/suggest-name$/, (b) => ({ name: engine.suggestName(b || {}) }));
  route('PUT', /^\/api\/presets\/(\d+)$/, (b, m) => V(engine.editPreset(m[1], b)));
  route('DELETE', /^\/api\/presets\/(\d+)$/, (b, m) => { engine.deletePreset(m[1]); return { ok: true }; });
  route('POST', /^\/api\/presets\/(\d+)\/recall$/, (b, m) => engine.recall(m[1]));
  route('POST', /^\/api\/presets\/(\d+)\/update$/, (b, m) => engine.updatePreset(m[1], b).then(V));
  // 0.4.0: swap two tiles (or move into an empty one). Body {a, b} (or {from, to}).
  route('POST', /^\/api\/presets\/swap$/, (b) => engine.swapPresets(b.a ?? b.from, b.b ?? b.to));
  // 0.4.0 Web RCS pane
  // 0.5.0: API version (clients compare apiVersion) and show files
  route('GET', /^\/api\/version$/, () => engine.versionInfo());
  const sid = (m) => decodeURIComponent(m[1]);

  // ---------- 0.6.0 systems: one API for every switcher behind the common driver interface ----------
  // /api/sys                      GET state (focused system, systems on the desk, every system's status, the focused view)
  // /api/sys/active               POST {system}   focus it, and add it to the desk if it was not already there
  // /api/sys/armed                POST {system, on}  add (on:true, also focuses) or remove one system; the others stay
  // /api/sys/:sys/simulate        POST  put it on the desk against a loopback fixture. Not saved. Not for RS6.
  // /api/sys/:sys/...             connection, connect, refresh, selection, presets/:key/recall, take, cut, ...
  if (systems) {
    const SYS = '(rs6|e2|pixelhue|atem|ptz|pixera|millumin)';
    const r = (method, tail, fn) => route(method, new RegExp(`^/api/sys/${SYS}${tail}$`), (b, m, url) => fn(m[1], b, m, url));
    route('GET', /^\/api\/sys$/, () => systems.getState());
    route('POST', /^\/api\/sys\/active$/, (b) => systems.setActive(String(b.system || '')));
    route('POST', /^\/api\/sys\/armed$/, (b) => systems.setArmed(String(b.system || ''), b.on !== false && b.on !== 0));
    r('POST', '/simulate', (s, b) => systems.simulate(s, b || {}));
    // 0.11.0 SAVE on a switcher page: the show (to the library) and, on an ATEM, its startup state ({startup:false} skips it)
    r('POST', '/save', (s, b) => systems.saveDesk(s, b || {}));
    r('GET', '', (s) => systems.view(s));
    r('POST', '/connection', (s, b) => systems.updateConnection(s, b));
    r('POST', '/connect', (s) => systems.connect(s).then(() => systems.view(s)));
    r('POST', '/refresh', (s) => systems.refresh(s).then(() => systems.view(s)));
    r('POST', '/selection', (s, b) => systems.setSelection(s, b.destinations || []).then((selection) => ({ selection })));
    r('POST', '/destinations/([SAsa]\\d+)/toggle', (s, b, m) => systems.toggleDest(s, m[2]).then((selection) => ({ selection })));
    r('POST', '/presets/([^/]+)/recall', (s, b, m) => systems.recall(s, decodeURIComponent(m[2]), { target: b.target === 'program' ? 'program' : 'preview' }));
    r('POST', '/presets/swap', (s, b) => systems.swapTiles(s, b.a ?? b.from, b.b ?? b.to));
    r('POST', '/layout/reset', (s) => { systems.resetLayout(s); return { ok: true }; });
    r('POST', '/take', (s) => systems.take(s));
    r('POST', '/cut', (s) => systems.cut(s));
    r('POST', '/autotake', (s, b) => ({ autoTake: systems.setAutoTake(s, b.value) }));
    r('POST', '/tiles', (s, b) => ({ tileCount: systems.setTileCount(s, b.tileCount) }));
    r('POST', '/cues/(\\d+)/(play|pause|stop)', (s, b, m) => systems.cue(s, +m[2], m[3]));
    r('POST', '/freeze', (s, b) => systems.freeze(s, String(b.kind), b.id, !!b.on));
    r('POST', '/aux/([Aa]\\d+)/source', (s, b, m) => systems.routeAux(s, m[2].toUpperCase(), b.source, b.target === 'program' ? 'program' : 'preview'));
    r('POST', '/backups/(\\d+)', (s, b, m) => systems.backup(s, +m[2], Number(b.slot)));
    r('POST', '/stills/take', (s, b) => systems.takeStill(s, b.input, b.file));
    r('DELETE', '/stills/(\\d+)', (s, b, m) => systems.deleteStill(s, +m[2]));
    // 0.11.0 per-install UI preferences: GET /api/ui-prefs → {prefs}; POST /api/ui-prefs/<key> {value} (null deletes)
    route('GET', /^\/api\/ui-prefs$/, () => ({ prefs: systems.uiPrefs() }));
    route('POST', /^\/api\/ui-prefs\/([\w.:-]+)$/, (b, m) => systems.setUiPref(m[1], b.value));
    // 0.7.0 ATEM: POST /api/sys/atem/cmd/<name> {source, style, rate, key, on, aux, macro, selection}
    route('POST', /^\/api\/sys\/atem\/cmd\/(\w+)$/, (b, m) => systems.atem(m[1], b));
    // 0.10.0 ATEM: model profiles (simulator picker; POST /api/sys/atem/simulate {model}) and SuperSource layouts
    // (built-ins + saved on this install; POST {name, boxes} or {name, ss} to capture the current SuperSource)
    route('GET', /^\/api\/sys\/atem\/models$/, () => systems.atemModels());
    route('GET', /^\/api\/sys\/atem\/ss-layouts$/, () => ({ layouts: systems.ssLayouts() }));
    route('POST', /^\/api\/sys\/atem\/ss-layouts$/, (b) => systems.saveSsLayout(b));
    route('DELETE', /^\/api\/sys\/atem\/ss-layouts\/([\w-]+)$/, (b, m) => systems.deleteSsLayout(m[1]));
    // 0.7.0 PTZ: cameras (add / edit / remove) and POST /api/sys/ptz/cmd/<name> {cam, pan, tilt, dir, preset, on, value, ...}
    route('POST', /^\/api\/sys\/ptz\/cameras$/, (b) => systems.addCamera(b));
    route('POST', /^\/api\/sys\/ptz\/cameras\/([\w-]+)$/, (b, m) => systems.updateCamera(m[1], b));
    route('DELETE', /^\/api\/sys\/ptz\/cameras\/([\w-]+)$/, (b, m) => systems.removeCamera(m[1]));
    route('POST', /^\/api\/sys\/ptz\/cmd\/(\w+)$/, (b, m) => systems.ptz(m[1], b));
    // 0.9.4 media servers. Pixera (JSON-RPC over TCP): POST /api/sys/pixera/cmd/<name> {handle, mode, ignore, timeline, cue, index, blend}
    route('POST', /^\/api\/sys\/pixera\/cmd\/(\w+)$/, (b, m) => systems.pixera(m[1], b));
    // Millumin (OSC over UDP): POST /api/sys/millumin/cmd/<name> {value} (a column index or name, a time, an opacity)
    route('POST', /^\/api\/sys\/millumin\/cmd\/(\w+)$/, (b, m) => systems.millumin(m[1], b));
    // 0.8.0 PTZ dashboard: per-camera command catalog (what this model offers, with value lists / ranges and the
    // source of each command), a rate-limited fast status read, and preset thumbnails (proxied, images only)
    route('GET', /^\/api\/sys\/ptz\/cameras\/([\w-]+)\/catalog$/, (b, m) => systems.ptzCatalog(m[1]));
    route('GET', /^\/api\/sys\/ptz\/cameras\/([\w-]+)\/status$/, (b, m) => systems.ptzStatus(m[1]));
    route('GET', /^\/api\/sys\/ptz\/cameras\/([\w-]+)\/snapshot$/, async (b, m) => { const t = await systems.ptzSnapshot(m[1]); return { __binary: { type: t.type, body: t.body, cache: 'no-store' } }; });
    route('GET', /^\/api\/sys\/ptz\/cameras\/([\w-]+)\/info$/, (b, m) => systems.ptzInfo(m[1]));
    route('GET', /^\/api\/sys\/ptz\/cameras\/([\w-]+)\/thumbnail\/(\d+)$/, async (b, m) => { const t = await systems.ptzThumbnail(m[1], Number(m[2])); return { __binary: { type: t.type, body: t.body } }; });
    // 0.8.0: every configured system's view in one read (the Companion module); long-poll: /api/sys?since=<rev>&timeout=<ms>
    route('GET', /^\/api\/sys\/views$/, () => ({ rev: systems.rev, active: systems.cfg.active, views: systems.allViews() }));
  }
  const flag = (url, k) => ['1', 'true', 'yes'].includes(String(url.searchParams.get(k) || '').toLowerCase());
  // 0.9.0 Companion pages: ready-made Stream Deck pages (XL, MK.2, +, + XL) for the configured systems, as a
  // .companionconfig for Steven's Companion fork. GET .../pages = what each surface would get; .../pages/file = the file
  // (?surfaces=xl,plus [&combined=1] [&host=&port=] the app address Companion uses, [&label=] the connection label)
  const companionPages = require('./companion');
  const companionInput = () => [engine.getState(), systems ? systems.allViews() : {}];
  route('GET', /^\/api\/companion\/pages$/, () => companionPages.describe(...companionInput()));
  route('GET', /^\/api\/companion\/pages\/file$/, (b, m, url) => {
    const q = (k) => url.searchParams.get(k) || undefined;
    const surfaces = companionPages.parseSurfaces(q('surfaces') || q('surface'));
    const combined = flag(url, 'combined');
    if (surfaces.length > 1 && !combined) { const e = new Error('One surface per file, or combined=1 for one file with all of them'); e.status = 400; throw e; }
    const host = q('host'); const port = q('port'); const label = q('label');
    if (host && !/^[A-Za-z0-9.:\[\]-]{1,253}$/.test(host)) { const e = new Error('Invalid host'); e.status = 400; throw e; }
    if (label && !/^[A-Za-z0-9_-]{1,64}$/.test(label)) { const e = new Error('Invalid connection label (letters, digits, - and _)'); e.status = 400; throw e; }
    const { files } = companionPages.generate(...companionInput(), {
      surfaces, combined, build: `pv-control-center ${engine.getState().appVersion || ''}`.trim(),
      connection: { ...(host ? { host } : {}), ...(port ? { port: Number(port) } : {}), ...(label ? { label } : {}) },
    });
    return { __download: { name: files[0].name, body: JSON.stringify(files[0].json) } };
  });
  route('GET', /^\/api\/shows$/, () => engine.listShows());
  route('POST', /^\/api\/shows\/save$/, (b) => engine.saveShow({ name: b.name, asNew: !!b.asNew, includeConnection: !!b.includeConnection, includePassword: !!b.includePassword }));
  route('POST', /^\/api\/shows\/new$/, (b) => engine.newShow(b.name));
  route('POST', /^\/api\/shows\/upload$/, (b) => engine.importShow(b.content, b.name));
  route('POST', /^\/api\/shows\/preview$/, (b) => engine.previewShow(b.content !== undefined ? { content: b.content } : { id: b.id, backup: !!b.backup }));
  route('POST', /^\/api\/shows\/open$/, (b) => engine.openShow(b.content !== undefined ? { content: b.content } : { id: b.id, backup: !!b.backup }, { applyConnection: !!b.applyConnection }));
  // the current state as a file (Export); connection / password only when asked
  route('GET', /^\/api\/show\/export$/, (b, m, url) => {
    const show = engine.buildShow({ includeConnection: flag(url, 'connection'), includePassword: flag(url, 'connection') && flag(url, 'password') });
    return { __download: { name: `${require('./shows').slug(show.name)}.rs6show`, body: JSON.stringify(show, null, 2) } };
  });
  route('GET', /^\/api\/shows\/([^/]+)\/file$/, (b, m, url) => {
    const backup = flag(url, 'backup'); const id = sid(m);
    return { __download: { name: `${id}.rs6show`, body: engine.library.read(id, backup) } };
  });
  route('POST', /^\/api\/shows\/([^/]+)\/rename$/, (b, m) => engine.renameShow(sid(m), b.name));
  route('POST', /^\/api\/shows\/([^/]+)\/duplicate$/, (b, m) => engine.duplicateShow(sid(m), b.name));
  route('DELETE', /^\/api\/shows\/([^/]+)$/, (b, m, url) => { engine.deleteShow(sid(m), flag(url, 'backup')); return { ok: true }; });
  route('GET', /^\/api\/webrcs$/, () => engine.checkWebRcs().then((c) => ({ ...c, mock: !!engine.settings.mock })));
  route('POST', /^\/api\/presets\/(\d+)\/duplicate$/, (b, m) => V(engine.duplicatePreset(m[1], b.toNumber)));
  route('POST', /^\/api\/take$/, () => engine.take());
  route('POST', /^\/api\/cut$/, () => engine.cut());
  route('POST', /^\/api\/autotake$/, (b) => ({ autoTake: engine.setAutoTake(b.value) }));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      // 0.3.4: retry hint + a named heartbeat the page can see (comments are invisible to EventSource), so the
      // page's watchdog can tell a live stream from one that died while the tab was frozen or in the bfcache.
      res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(engine.getState())}\n\n`);
      if (systems) res.write(`event: sys\ndata: ${JSON.stringify(systems.getState())}\n\n`);
      clients.add(res);
      const hbMs = Math.max(200, Number(process.env.RS6_SSE_HEARTBEAT_MS) || 10000);
      const ka = setInterval(() => res.write(`event: ping\ndata: {"t":${Date.now()},"rev":${engine.rev}}\n\n`), hbMs);
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

    // 0.8.0 long-poll for the multi-system state: GET /api/sys?since=<rev>&timeout=<ms>[&views=all]
    if (systems && req.method === 'GET' && url.pathname === '/api/sys' && url.searchParams.has('since')) {
      const since = Number(url.searchParams.get('since')); const timeout = Math.min(60000, Math.max(0, Number(url.searchParams.get('timeout') || 25000)));
      const all = url.searchParams.get('views') === 'all';
      const out = () => { const st = systems.getState(); return all ? { ...st, views: systems.allViews() } : st; };
      if (systems.rev > since) return json(200, out());
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); systems.off('state', onState); try { json(200, out()); } catch (e) { json(500, { error: e.message }); } };
      const onState = () => { if (systems.rev > since) setTimeout(finish, 15); };
      const t = setTimeout(finish, timeout);
      systems.on('state', onState);
      req.on('close', () => { if (!done) { done = true; clearTimeout(t); systems.off('state', onState); } });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return json(404, { error: `No route ${req.method} ${url.pathname}` });
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 8e6) req.destroy(); }); // 0.5.0: show uploads
      req.on('end', async () => {
        let body = {};
        if (raw) { try { body = JSON.parse(raw); } catch { return json(400, { error: 'Invalid JSON body' }); } }
        try {
          const out = await r.fn(body || {}, url.pathname.match(r.re), url);
          if (out && out.__binary) {
            res.writeHead(200, { 'Content-Type': out.__binary.type, 'Cache-Control': out.__binary.cache || 'max-age=30', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
            return res.end(out.__binary.body);
          }
          if (out && out.__download) {
            const d = out.__download; const ascii = d.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.name)}` });
            return res.end(d.body);
          }
          json(200, out === undefined ? { ok: true } : out);
        }
        catch (e) { if (!e.quiet) engine.log('error', `${req.method} ${url.pathname}: ${e.message}`); json(e.status || 400, { error: e.message }); }
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
