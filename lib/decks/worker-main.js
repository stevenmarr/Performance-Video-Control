'use strict';
// Stream Deck process. node-hid, resvg, and JPEG encoding live here so a
// native SIGSEGV restarts this process and leaves Control Center running.
const { installJpegGuard, jpegTurboAllowed } = require('./jpeg-guard');
installJpegGuard();

const { UsbDecks } = require('./usb');

const usb = new UsbDecks();
let loggedEncoder = false;

function send(msg) {
  if (process.connected) process.send(msg);
}

usb.onPress((id, at) => send({ event: 'press', deviceId: id, at }));
usb.onRelease((id, at) => send({ event: 'release', deviceId: id, at }));
usb.onTurn((id, at) => send({ event: 'turn', deviceId: id, at }));

function noteEncoder() {
  if (loggedEncoder) return;
  loggedEncoder = true;
  const how = jpegTurboAllowed() ? 'jpeg-turbo' : 'jpeg-js (jpeg-turbo needs Node >=22)';
  send({ event: 'log', level: 'info', msg: `USB deck worker up. Button JPEG encoder: ${how}.` });
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;
  try {
    if (msg.op === 'die') {
      if (process.env.CC_DECK_TEST === '1') process.kill(process.pid, 'SIGSEGV');
      return;
    }
    if (msg.op === 'list') {
      const listed = await usb.list();
      send({ id, ok: true, ...listed });
      return;
    }
    if (msg.op === 'scan') {
      noteEncoder();
      const skip = new Set(Array.isArray(msg.skip) ? msg.skip : []);
      const devices = await usb.scan({ skipPaths: skip });
      send({ id, ok: true, devices, report: usb.lastReport, openErrors: usb.openErrors });
      return;
    }
    if (msg.op === 'paint') {
      noteEncoder();
      const ok = await usb.paint(msg.deviceId, msg.keys, msg.face);
      send({ id, ok: true, painted: ok });
      return;
    }
    if (msg.op === 'closeId') {
      send({ id, ok: true, closed: await usb.closeId(msg.deviceId) });
      return;
    }
    if (msg.op === 'close') {
      await usb.close();
      send({ id, ok: true });
      return;
    }
    if (msg.op === 'status') {
      send({ id, ok: true, status: usb.status(), openErrors: usb.openErrors, report: usb.lastReport });
      return;
    }
    send({ id, ok: false, error: `Unknown deck worker op ${msg.op}` });
  } catch (e) {
    send({ id, ok: false, error: e && e.message ? e.message : String(e) });
  }
});

send({ event: 'ready' });
