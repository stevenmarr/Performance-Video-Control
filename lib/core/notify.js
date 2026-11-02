'use strict';
// Tell systemd we are up, when it asked us to.
//
// Node's dgram module only creates udp4 and udp6 sockets. createSocket('unix_dgram')
// throws ERR_SOCKET_BAD_TYPE on Node 18 (the Pi) and on Node 22. The old code
// caught that and dropped READY=1, so Type=notify sat until systemd's start
// timeout. systemd-notify is the tool that speaks the datagram. It is part of
// systemd on Raspberry Pi OS. It is a child process, so a Type=notify unit
// must set NotifyAccess=all. The shipped unit is Type=simple and does not wait.
const { spawn, spawnSync } = require('child_process');

let missingLogged = false;

function sdNotify(msg, { sync = false } = {}) {
  const socket = process.env.NOTIFY_SOCKET;
  if (!socket || !msg) return false;
  const args = [`--pid=${process.pid}`, String(msg)];
  try {
    if (sync) {
      const child = spawnSync('systemd-notify', args, { stdio: 'ignore', env: process.env });
      if (child.error || child.status) {
        logOnce(child.error ? child.error.message : `systemd-notify exited ${child.status}`);
        return false;
      }
      return true;
    }
    const child = spawn('systemd-notify', args, { stdio: 'ignore', env: process.env });
    if (child.unref) child.unref();
    child.on('error', (err) => logOnce(err.message));
    return true;
  } catch (e) {
    logOnce(e.message);
    return false;
  }
}

function logOnce(why) {
  if (missingLogged) return;
  missingLogged = true;
  console.error(`systemd notify did not go out (${why}). Node cannot open NOTIFY_SOCKET itself. The service file is Type=simple, so startup does not wait on this.`);
}

module.exports = { sdNotify };
