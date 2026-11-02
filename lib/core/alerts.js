'use strict';
// Health alerts. A failed or degraded connection raises one. Recovery marks it
// recovered. It stays on the list until someone acknowledges it, so a blip
// during a cue is still visible on the console key.

function createAlerts(bus) {
  const items = new Map();
  function emit() { if (bus) bus.emit('alert', api.list()); }
  const api = {
    list: () => [...items.values()].map((a) => ({ ...a })),
    unacked: () => [...items.values()].filter((a) => !a.acked).length,
    raise(id, info) {
      const key = String(id);
      const level = info.level || 'warn';
      const message = String(info.message || level).slice(0, 200);
      const cur = items.get(key);
      if (cur && !cur.recovered && cur.level === level && cur.message === message) return cur;
      const row = { id: key, level, message, source: info.source || null, at: new Date().toISOString(), acked: false, recovered: false };
      items.set(key, row);
      emit();
      return row;
    },
    recover(id) {
      const cur = items.get(String(id));
      if (!cur || cur.recovered) return cur || null;
      cur.recovered = true;
      cur.recoveredAt = new Date().toISOString();
      emit();
      return cur;
    },
    onConnection(instanceId, state, why) {
      const id = `conn:${instanceId}`;
      if (state === 'failed' || state === 'degraded') api.raise(id, { level: state, source: instanceId, message: why || state });
      else if (state === 'connected') api.recover(id);
    },
    ack(id) {
      if (!id || id === 'all') {
        for (const item of items.values()) item.acked = true;
        emit();
        return { ok: true, acked: 'all' };
      }
      const cur = items.get(String(id)) || items.get(`conn:${id}`);
      if (!cur) { const e = new Error(`No alert "${id}"`); e.status = 404; throw e; }
      cur.acked = true;
      emit();
      return { ok: true, id: cur.id };
    },
  };
  return api;
}

module.exports = { createAlerts };
