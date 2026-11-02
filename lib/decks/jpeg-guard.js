'use strict';
// @julusian/jpeg-turbo 3.x is N-API 10 and declares Node >=22.18. Node 18 can
// load that .node file and then die with SIGSEGV on the first JPEG encode,
// which is the first Stream Deck paint. jpeg-js is pure JavaScript and is the
// encoder on Node 18. The Elgato library require()s jpeg-turbo whenever the
// folder exists, so this guard makes that require throw before the .node loads.

const Module = require('module');

function nodeMajor(version = process.version) {
  const m = /^v(\d+)/.exec(String(version || ''));
  return m ? Number(m[1]) : 0;
}

function jpegTurboAllowed(version = process.version, env = process.env) {
  const flag = String((env && env.CC_JPEG_TURBO) || '').toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  if (flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes') return true;
  return nodeMajor(version) >= 22;
}

let installed = false;

function installJpegGuard() {
  if (installed) return;
  installed = true;
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    const name = String(id || '');
    if ((name === '@julusian/jpeg-turbo' || name.startsWith('@julusian/jpeg-turbo/')) && !jpegTurboAllowed()) {
      const err = new Error(`@julusian/jpeg-turbo is not loaded on Node ${process.version}. It needs Node >=22. Deck images use jpeg-js.`);
      err.code = 'CC_SKIP_JPEG_TURBO';
      throw err;
    }
    return orig.apply(this, arguments);
  };
}

module.exports = { installJpegGuard, jpegTurboAllowed, nodeMajor };
