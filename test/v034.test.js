'use strict';
// 0.3.4 regressions (Steven, Firefox on a Mac): "the layer presets don't populate, and MV unknown presets show up in
// the list even with the checkbox unchecked ... If i navigate away from the page in firefox I have to refresh the
// page to restore connectivity". Browser-side checks (layout alignment, reconnect) are in ui.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setup } = require('./helpers');
const { createServer } = require('../lib/server');

const slots = (cat, t) => (cat.items[t] || []).map((i) => i.slot);

async function withApp(opts, fn) {
  const ctx = await setup(opts);
  await ctx.engine.connect(); await ctx.engine.memoriesReady; if (ctx.engine.liveReady) await ctx.engine.liveReady;
  const server = createServer(ctx.engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try { await fn(call, { ...ctx, base }); } finally { server.closeClients(); await new Promise((r) => server.close(r)); await ctx.teardown(); }
}

// ---------- 2. "show empty / unknown slots" applies to every type ----------
test('unchecked: no unknown slots of any type (Multiviewer included); checked: every slot', async () => {
  for (const memoryProbe of [false, true]) {
    await withApp({ extra: { memoryProbe } }, async (call) => {
      const off = (await call('GET', '/api/memories/catalog')).json;
      for (const t of ['screen', 'master', 'multiviewer']) {
        assert.ok(off.items[t].every((i) => i.status === 'valid'), `${t} (probe ${memoryProbe}): only known slots without "all"`);
      }
      assert.deepEqual(slots(off, 'multiviewer'), memoryProbe ? [1, 2, 3, 10] : []); // the old code listed all 50 when the probe was off
      const on = (await call('GET', '/api/memories/catalog?all=1')).json;
      assert.equal(on.items.multiviewer.length, 50);
      assert.equal(on.items.screen.length, 1000); assert.equal(on.items.master.length, 500);
      assert.ok(on.items.multiviewer.some((i) => i.status !== 'valid'));
    });
  }
});

// (0.3.4 Layer memory tests removed in 0.4.0 with the feature; see v040.test.js)

// ---------- 4. event stream: visible heartbeat + retry hint ----------
test('event stream sends a retry hint and named ping heartbeats the page watchdog can see', async () => {
  process.env.RS6_SSE_HEARTBEAT_MS = '200';
  try {
    await withApp({}, async (call, { base }) => {
      const text = await new Promise((resolve, reject) => {
        let buf = '';
        const req = http.get(base + '/api/events', (res) => {
          assert.equal(res.headers['content-type'], 'text/event-stream');
          res.setEncoding('utf8');
          res.on('data', (d) => { buf += d; if ((buf.match(/event: ping/g) || []).length >= 2) { req.destroy(); resolve(buf); } });
        });
        req.on('error', (e) => { if (buf) resolve(buf); else reject(e); });
        setTimeout(() => { req.destroy(); resolve(buf); }, 3000);
      });
      assert.match(text, /^retry: \d+\nevent: state\ndata: \{/);
      const pings = [...text.matchAll(/event: ping\ndata: (\{[^\n]*\})\n\n/g)].map((m) => JSON.parse(m[1]));
      assert.ok(pings.length >= 2, text.slice(-200)); assert.ok(pings.every((p) => p.t > 0 && Number.isInteger(p.rev)));
    });
  } finally { delete process.env.RS6_SSE_HEARTBEAT_MS; }
});
