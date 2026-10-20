'use strict';
// 0.3.4 regressions (Steven, Firefox on a Mac): "the layer presets don't populate, and MV unknown presets show up in
// the list even with the checkbox unchecked ... If i navigate away from the page in firefox I have to refresh the
// page to restore connectivity". Browser-side checks (layout alignment, reconnect) are in ui.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setup, awjCalls, until } = require('./helpers');
const { createServer } = require('../lib/server');
const { P } = require('../lib/paths');
const { LAYER_MEM_LABELS } = require('../lib/mock');

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
    await withApp({ extra: { memoryProbe, layerMemories: true } }, async (call) => {
      const off = (await call('GET', '/api/memories/catalog')).json;
      for (const t of ['screen', 'master', 'multiviewer', 'layer']) {
        assert.ok(off.items[t].every((i) => i.status === 'valid'), `${t} (probe ${memoryProbe}): only known slots without "all"`);
      }
      assert.deepEqual(slots(off, 'multiviewer'), memoryProbe ? [1, 2, 3, 10] : []); // the old code listed all 50 when the probe was off
      const on = (await call('GET', '/api/memories/catalog?all=1')).json;
      assert.equal(on.items.multiviewer.length, 50); assert.equal(on.items.layer.length, 50);
      assert.equal(on.items.screen.length, 1000); assert.equal(on.items.master.length, 500);
      assert.ok(on.items.multiviewer.some((i) => i.status !== 'valid'));
    });
  }
});

// ---------- 1. Layer memories (INFERRED, opt-in) ----------
test('layer memories are off by default: type unsupported with a one-line note, nothing read, load refused', async () => {
  await withApp({ protocol: 'awj' }, async (call, { mock }) => {
    const cat = (await call('GET', '/api/memories/catalog')).json;
    const lt = cat.types.find((t) => t.type === 'layer');
    assert.equal(lt.supported, false); assert.match(lt.note, /no Layer memory commands/); assert.match(lt.note, /Settings/);
    assert.equal(cat.items.layer, undefined);
    assert.equal(awjCalls(mock, /layerBank/).length, 0);
    const r = await call('POST', '/api/memories/load', { type: 'layer', slot: 1, dest: 'S1', layer: 1 });
    assert.equal(r.status, 400); assert.match(r.json.error, /Layer memories are off/);
  });
});

test('layer memories on: names + validity read over the inferred layerBank paths, live label updates', async () => {
  await withApp({ protocol: 'awj', liveEnabled: true, extra: { layerMemories: true } }, async (call, { mock }) => {
    let cat = (await call('GET', '/api/memories/catalog')).json;
    const lt = cat.types.find((t) => t.type === 'layer'); assert.equal(lt.supported, true); assert.match(lt.note, /INFERRED/);
    assert.deepEqual(cat.items.layer.map((i) => [i.slot, i.label]), [...Object.entries(LAYER_MEM_LABELS).map(([k, v]) => [+k, v]), [9, '']].sort((a, b) => a[0] - b[0]));
    assert.equal(awjCalls(mock, /^DeviceObject\/layerBank\/\$bank\/@items\/\d+\/control\/@props\/label$/).length, 50);
    assert.equal(awjCalls(mock, /^DeviceObject\/layerBank\/\$bank\/@items\/\d+\/status\/@props\/isValid$/).length, 50);
    mock.set(P.layerMemoryLabel(2), 'PiP R wide'); // renamed on the device
    await until(async () => ((await call('GET', '/api/memories/catalog')).json.items.layer.find((i) => i.slot === 2) || {}).label === 'PiP R wide', 3000, 'layer label push');
  });
});

for (const protocol of ['rest', 'awj']) {
  test(`layer memory recall (${protocol} mode): exact inferred AWJ path, validation`, async () => {
    await withApp({ protocol, extra: { layerMemories: true } }, async (call, { mock }) => {
      let r = await call('POST', '/api/memories/load', { type: 'layer', slot: 3, dest: 'A1', layer: 1, target: 'preview' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      r = await call('POST', '/api/memories/load', { type: 'layer', slot: 5, dest: 'S2', layer: 4, target: 'program' });
      assert.equal(r.status, 200);
      const sent = awjCalls(mock, /^DeviceObject\/layerBank\/control\/load/).map((h) => [h.op, h.path, h.value]);
      assert.deepEqual(sent, [
        ['replace', 'DeviceObject/layerBank/control/load/$slot/@items/3/$auxiliary/@items/A1/$preset/@items/PREVIEW/$layer/@items/1/@props/xRequest', true],
        ['replace', 'DeviceObject/layerBank/control/load/$slot/@items/5/$screen/@items/S2/$preset/@items/PROGRAM/$layer/@items/4/@props/xRequest', true],
      ]);
      assert.deepEqual(mock.history.filter((h) => h.op === 'loadLayer').map((h) => [h.dest, h.target, h.layer, h.memoryId]), [['A1', 'preview', 1, 3], ['S2', 'program', 4, 5]]);
      for (const bad of [{ slot: 51, dest: 'S1', layer: 1 }, { slot: 1, dest: 'S1', layer: 0 }, { slot: 1, dest: 'S1', layer: 9 }, { slot: 1, dest: 'S9', layer: 1 }, { slot: 1, dest: 'X1', layer: 1 }]) {
        r = await call('POST', '/api/memories/load', { type: 'layer', ...bad }); assert.ok(r.status >= 400, JSON.stringify(bad));
      }
      r = await call('POST', '/api/memories/load', { type: 'layer', slot: 20, dest: 'S1', layer: 1 }); // empty slot: the mock answers E12
      assert.ok(r.status >= 400);
    });
  });
}

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
