'use strict';
// Easy IP Setup datagram codec, from third-party HE120/HE130 captures
// (dPro-Software/PanasonicEasyIPsetupCore, stoatworks-labs/meerkat).
//
// UNVERIFIED on AW-UE150 / UE150A / UE160. A bench capture of current
// EasyIPSetupToolPlus against those models is required before Control Center
// may send a live reconfiguration on the wire. Discovery parse + assign
// planning are safe; live UDP write is refused until the bench flag is set.
//
// Port direction is itself disputed: Meerkat sends from 10670 to 10669;
// dPro Protocol.rtf sends to 10670 and listens on 10669. Both ports are
// reserved on the camera. The codec keeps both variants; the transport picks one.

const CAPTURE_REQUIRED = true;
const BENCH_FLAG = 'CC_PTZ_EASYIP_BENCH';

const PORTS = Object.freeze({
  // Preferred guess (dPro): requests go TO 10670; announcements arrive ON 10669.
  dpro: Object.freeze({ send: 10670, bind: 10669 }),
  meerkat: Object.freeze({ send: 10669, bind: 10670 }),
});

const PREFIX = Buffer.from([0x00, 0x01, 0x00, 0x2A, 0x00, 0x0D]);

const FIELD = Object.freeze({
  ipv4: 32, mask: 33, gateway: 34, dns: 35, httpPort: 37,
  ipv4b: 160, maskb: 161, gatewayb: 162, dnsb: 163, httpPortb: 68,
  model: 167, name: 168, firmware: 169,
});

const macToBuf = (mac) => {
  const h = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (h.length !== 12) throw new Error(`Bad MAC address: ${mac}`);
  return Buffer.from(h, 'hex');
};
const bufToMac = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(':');
const ipToBuf = (ip) => Buffer.from(String(ip).split('.').map((n) => Number(n)));
const bufToIp = (buf) => [...buf.slice(0, 4)].join('.');

function writeTlv(id, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const out = Buffer.alloc(4 + v.length);
  out.writeUInt16BE(id, 0);
  out.writeUInt16BE(v.length, 2);
  v.copy(out, 4);
  return out;
}

function readTlvs(buf, start = 0) {
  const fields = {};
  let i = start;
  while (i + 4 <= buf.length) {
    const id = buf.readUInt16BE(i); const len = buf.readUInt16BE(i + 2); i += 4;
    if (i + len > buf.length) break;
    fields[id] = Buffer.from(buf.slice(i, i + len));
    i += len;
  }
  return { fields, end: i };
}

function parseAnnouncement(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Announcements are a TLV dictionary. Some captures include the request prefix;
  // others start at the first field. Accept both.
  let off = 0;
  if (b.length >= PREFIX.length && b.slice(0, PREFIX.length).equals(PREFIX)) off = PREFIX.length;
  // Optional sender MAC (6) + IPv4 (4) after the prefix, before TLVs — if the next
  // bytes do not look like a field id we know, skip 10 bytes when present.
  let mac = null; let senderIp = null;
  const { fields: peek } = readTlvs(b, off);
  if (Object.keys(peek).length === 0 && b.length >= off + 10) {
    mac = bufToMac(b.slice(off, off + 6));
    senderIp = bufToIp(b.slice(off + 6, off + 10));
    off += 10;
  }
  const { fields } = readTlvs(b, off);
  const str = (id) => fields[id] ? fields[id].toString('ascii').replace(/\0+$/, '') : null;
  const ip = (id) => fields[id] && fields[id].length >= 4 ? bufToIp(fields[id]) : null;
  const port = (id) => fields[id] && fields[id].length >= 2 ? fields[id].readUInt16BE(0) : null;
  return {
    mac,
    ip: ip(FIELD.ipv4) || ip(FIELD.ipv4b),
    mask: ip(FIELD.mask) || ip(FIELD.maskb),
    gateway: ip(FIELD.gateway) || ip(FIELD.gatewayb),
    dns: fields[FIELD.dns] && fields[FIELD.dns].length >= 8
      ? [bufToIp(fields[FIELD.dns]), bufToIp(fields[FIELD.dns].slice(4))]
      : (fields[FIELD.dnsb] && fields[FIELD.dnsb].length >= 8 ? [bufToIp(fields[FIELD.dnsb]), bufToIp(fields[FIELD.dnsb].slice(4))] : []),
    httpPort: port(FIELD.httpPort) || port(FIELD.httpPortb) || 80,
    model: str(FIELD.model),
    name: str(FIELD.name),
    firmware: str(FIELD.firmware),
    senderIp,
    raw: fields,
    unverified: true,
  };
}

function buildDiscovery({ senderMac, senderIp, fields } = {}) {
  const want = fields || [FIELD.ipv4, FIELD.mask, FIELD.gateway, FIELD.dns, FIELD.httpPort, FIELD.model, FIELD.name, FIELD.firmware];
  const parts = [PREFIX, macToBuf(senderMac || '00:00:00:00:00:00'), ipToBuf(senderIp || '0.0.0.0')];
  parts.push(writeTlv(0x000d, Buffer.concat(want.map((id) => { const b = Buffer.alloc(2); b.writeUInt16BE(id, 0); return b; }))));
  return Buffer.concat(parts);
}

function buildReconfigure({ cameraMac, ip, mask, gateway, dns, httpPort = 80 }) {
  if (!cameraMac) throw new Error('Reconfigure requires the camera MAC');
  const dnsBuf = Buffer.concat((dns && dns.length ? dns : [gateway, gateway]).slice(0, 2).map(ipToBuf));
  const port = Buffer.alloc(2); port.writeUInt16BE(httpPort, 0);
  const payload = Buffer.concat([
    PREFIX,
    macToBuf(cameraMac),
    ipToBuf(ip),
    writeTlv(FIELD.ipv4, ipToBuf(ip)),
    writeTlv(FIELD.mask, ipToBuf(mask)),
    writeTlv(FIELD.gateway, ipToBuf(gateway)),
    writeTlv(FIELD.dns, dnsBuf),
    writeTlv(FIELD.httpPort, port),
    writeTlv(FIELD.ipv4b, ipToBuf(ip)),
    writeTlv(FIELD.maskb, ipToBuf(mask)),
    writeTlv(FIELD.gatewayb, ipToBuf(gateway)),
    writeTlv(FIELD.dnsb, dnsBuf),
    writeTlv(FIELD.httpPortb, port),
  ]);
  return payload;
}

function benchEnabled(env = process.env) {
  return env[BENCH_FLAG] === '1' || env[BENCH_FLAG] === 'true';
}

function refuseLiveWrite(env = process.env) {
  if (CAPTURE_REQUIRED && !benchEnabled(env)) {
    const err = new Error('Easy IP write is not enabled until a bench capture of EasyIPSetupToolPlus against a UE150 and a UE160 confirms the datagram and port direction. Set CC_PTZ_EASYIP_BENCH=1 only on that bench.');
    err.status = 409;
    err.code = 'EASYIP_CAPTURE_REQUIRED';
    throw err;
  }
}

module.exports = {
  CAPTURE_REQUIRED, BENCH_FLAG, PORTS, PREFIX, FIELD,
  macToBuf, bufToMac, ipToBuf, bufToIp, writeTlv, readTlvs,
  parseAnnouncement, buildDiscovery, buildReconfigure, benchEnabled, refuseLiveWrite,
};
