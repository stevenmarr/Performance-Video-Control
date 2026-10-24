#!/usr/bin/env node
'use strict';
// 0.12.0 scopes: make H.264 test content for the scopes (dev tool, NOT an app dependency: needs ffmpeg with libx264 on
// the machine that runs it; the app itself never calls ffmpeg). Writes Annex-B .h264 + .mp4 (and, with --frames,
// raw I420 frames for GL tests) into the output folder (default /workspace/rs6/scopes-test, or argv[2]).
//   bars      SMPTE RP 219 HD bars (ffmpeg smptehdbars), 1280x720 30p, legal range, BT.709
//   ramps     generated here with exact code values: luma ramp, false-colour step wedge, 75 %/100 % colour patches,
//             skin-tone patches (legal range)
//   ramps-full  the same picture encoded full range (VUI video_full_range_flag=1)
//   moving    ffmpeg testsrc2 + moving skin-tone boxes, 1280x720 30p
//   bars1080  1920x1080 59.94p bars + moving box (decode / draw cost at the UE150's top HD format)
// Encoder settings mimic a PTZ camera stream: High profile, no B-frames, GOP = 1 s, SPS/PPS before each IDR.
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..', '..', 'scopes-test');
if (require.main === module) fs.mkdirSync(OUT, { recursive: true });
const X264 = (range, gop = 30) => ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-bf', '0', '-g', String(gop), '-keyint_min', String(gop),
  '-pix_fmt', 'yuv420p', '-color_range', range, '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-x264-params', `repeat-headers=1:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=${range}`, '-b:v', '6M'];
const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }); if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`); };
const both = (name) => { // .h264 -> .mp4 remux (no re-encode)
  ff(['-r', name.includes('1080') ? '60000/1001' : '30', '-i', path.join(OUT, `${name}.h264`), '-c', 'copy', '-movflags', '+faststart', path.join(OUT, `${name}.mp4`)]);
};

// BT.709 R'G'B' (0..1) -> Y'CbCr code values; legal (16-235 / 16-240) or full (0-255)
function ycc(r, g, b, full) {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; const cb = (b - y) / 1.8556; const cr = (r - y) / 1.5748;
  return full ? [Math.round(y * 255), Math.round(128 + cb * 255), Math.round(128 + cr * 255)].map((v) => Math.max(0, Math.min(255, v)))
    : [Math.round(16 + 219 * y), Math.round(128 + 224 * cb), Math.round(128 + 224 * cr)];
}
// The step wedge: levels (in % of video level) chosen to sit inside each false-colour band (see public/scopes-gl.js)
const WEDGE = [1, 3.2, 10, 20, 30, 40, 50, 54, 70, 85, 98, 100];
const PATCHES = [[0.75, 0.75, 0.75], [0.75, 0.75, 0], [0, 0.75, 0.75], [0, 0.75, 0], [0.75, 0, 0.75], [0.75, 0, 0], [0, 0, 0.75],
  [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1]];
const SKIN = [[232, 190, 172], [224, 172, 140], [198, 134, 103], [161, 110, 85], [141, 85, 54], [96, 62, 44]];
function rampsFrame(W, H, full) {
  const Y = Buffer.alloc(W * H); const U = Buffer.alloc((W / 2) * (H / 2)); const V = Buffer.alloc((W / 2) * (H / 2));
  const rowH = H / 4;
  const put = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) Y.fill(c[0], y * W + x0, y * W + x0 + w);
    for (let y = y0 / 2; y < (y0 + h) / 2; y++) { U.fill(c[1], y * (W / 2) + x0 / 2, y * (W / 2) + (x0 + w) / 2); V.fill(c[2], y * (W / 2) + x0 / 2, y * (W / 2) + (x0 + w) / 2); }
  };
  // row 0: horizontal luma ramp 0 -> 100 %
  for (let x = 0; x < W; x += 2) { const p = x / (W - 2); put(x, 0, 2, rowH, ycc(p, p, p, full)); }
  // row 1: false-colour step wedge
  const sw = Math.floor(W / WEDGE.length / 2) * 2;
  WEDGE.forEach((p, i) => put(i * sw, rowH, i === WEDGE.length - 1 ? W - i * sw : sw, rowH, ycc(p / 100, p / 100, p / 100, full)));
  // row 2: 75 % and 100 % colour patches (vectorscope targets)
  const pw = Math.floor(W / PATCHES.length / 2) * 2;
  PATCHES.forEach((c, i) => put(i * pw, rowH * 2, i === PATCHES.length - 1 ? W - i * pw : pw, rowH, ycc(...c, full)));
  // row 3: skin tones on a 20 % grey surround
  put(0, rowH * 3, W, rowH, ycc(0.2, 0.2, 0.2, full));
  const kw = Math.floor(W / SKIN.length / 2) * 2;
  SKIN.forEach((c, i) => put(i * kw + 16, rowH * 3 + 20, kw - 32, rowH - 40, ycc(c[0] / 255, c[1] / 255, c[2] / 255, full)));
  return Buffer.concat([Y, U, V]);
}
function encodeRaw(name, W, H, frames, range, makeFrame) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', '30', '-color_range', range, '-i', '-', ...X264(range), path.join(OUT, `${name}.h264`)], { stdio: ['pipe', 'inherit', 'inherit'] });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${name} exit ${c}`))));
    for (let i = 0; i < frames; i++) p.stdin.write(makeFrame(i));
    p.stdin.end();
  });
}

async function main() {
  const t0 = Date.now();
  ff(['-f', 'lavfi', '-i', 'smptehdbars=s=1280x720:r=30:d=6', ...X264('tv'), path.join(OUT, 'bars.h264')]); both('bars');
  const legal = rampsFrame(1280, 720, false); const full = rampsFrame(1280, 720, true);
  await encodeRaw('ramps', 1280, 720, 150, 'tv', () => legal); both('ramps');
  await encodeRaw('ramps-full', 1280, 720, 150, 'pc', () => full); both('ramps-full');
  fs.writeFileSync(path.join(OUT, 'ramps-legal-1280x720.yuv'), legal); // exact source frame (I420) for GL tests
  const skin = (c, i) => `drawbox=x='640+${300 - i * 60}*sin(t*${0.7 + i * 0.3})':y='${120 + i * 110}+40*cos(t)':w=150:h=90:color=${c}@1:t=fill`;
  ff(['-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=10,${['0xE0AC8C', '0xC68667', '0x8D5536', '0xF1C9B0', '0xA0644A'].map(skin).join(',')}`, ...X264('tv'), path.join(OUT, 'moving.h264')]); both('moving');
  ff(['-f', 'lavfi', '-i', 'smptehdbars=s=1920x1080:r=60000/1001:d=6,drawbox=x=\'800+600*sin(t)\':y=420:w=200:h=200:color=0xC68667@1:t=fill', ...X264('tv', 60), path.join(OUT, 'bars1080.h264')]); both('bars1080');
  if (process.argv.includes('--frames')) { // decoded reference frames (what a decoder outputs), I420
    for (const n of ['bars', 'moving']) ff(['-i', path.join(OUT, `${n}.h264`), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', path.join(OUT, `${n}-frame0-1280x720.yuv`)]);
  }
  fs.writeFileSync(path.join(OUT, 'README.txt'), [
    'Scopes test content (made by rs6-presets/tools/scopes-testgen.js; needs ffmpeg + libx264, not part of the app).',
    'All H.264 High profile, no B-frames, 1 s GOP, SPS/PPS repeated before each IDR, BT.709.',
    '  bars.h264/.mp4        SMPTE RP 219 HD bars 1280x720 30p legal range',
    '  ramps.h264/.mp4       luma ramp / false-colour wedge (1,3.2,10,20,30,40,50,54,70,85,98,100 %) / 75 + 100 % patches / skin tones, legal',
    '  ramps-full.h264/.mp4  the same, full range (video_full_range_flag=1)',
    '  moving.h264/.mp4      testsrc2 + moving skin-tone boxes 1280x720 30p',
    '  bars1080.h264/.mp4    1920x1080 59.94p bars + moving box (performance)',
    '  *.yuv                 raw I420 frames (ramps source frame; --frames: decoded frame 0 of bars / moving)', ''].join('\n'));
  console.log(`done in ${Date.now() - t0} ms -> ${OUT}`);
}
module.exports = { rampsFrame, ycc, WEDGE, PATCHES, SKIN };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
