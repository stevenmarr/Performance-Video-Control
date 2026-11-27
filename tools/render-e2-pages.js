'use strict';
// Preview pictures of the Event Master programming pages. SVG, so this does not
// need the deck rasterizer. Pass an output directory.
const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/e2/schema');
const { ProgramSession } = require('../lib/e2/session');
const { buildProgramPages } = require('../lib/e2/pages');
const { SURFACES } = require('../lib/decks/surfaces');
const { keySvg } = require('../lib/deck-image');
const { keyModel } = require('../lib/decks/look');

const outDir = process.argv[2] || '/opt/cursor/artifacts';
fs.mkdirSync(outDir, { recursive: true });

function inner(svg) {
  return String(svg).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

function pageSvg(face) {
  const k = 78;
  const gap = 8;
  const pad = 16;
  const cols = 9;
  const rows = 4;
  const width = pad * 2 + cols * k + (cols - 1) * gap;
  const dials = (face.dials || []).filter((d) => d && d.knob && d.label);
  const stripH = dials.length ? 86 : 0;
  const height = pad * 2 + 28 + rows * k + (rows - 1) * gap + (stripH ? 16 + stripH : 0);
  const cells = (face.keys || []).map((key) => {
    const x = pad + key.col * (k + gap);
    const y = pad + 28 + key.row * (k + gap);
    return `<g transform="translate(${x} ${y}) scale(${k / 144})">${inner(keySvg(keyModel(key)))}</g>`;
  }).join('');
  const slice = Math.floor((width - pad * 2) / Math.max(1, dials.length || 1));
  const stripY = height - pad - stripH;
  const segs = dials.map((dial, i) => {
    const parts = (dial.knob && dial.knob.parts) || [];
    const text = parts.map((p) => `${p.active ? p.label : p.label} ${p.text}`).join('   ');
    return `<g transform="translate(${pad + i * slice} ${stripY})">
      <rect width="${slice - 6}" height="${stripH}" rx="10" fill="#1b2027" stroke="#2a313b"/>
      <text x="8" y="22" fill="#9A9AA2" font-family="Arial" font-size="11" font-weight="700">${dial.label || ''}</text>
      <text x="8" y="48" fill="#E6E6E8" font-family="Arial" font-size="13" font-weight="700">${text}</text>
      <text x="8" y="70" fill="#3DDC84" font-family="Arial" font-size="10" font-weight="700">PVW · TAP SWAPS</text>
    </g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#14161A"/>
    <text x="${pad}" y="22" fill="#F4F7FB" font-family="Arial" font-size="16" font-weight="700">${face.title || 'E2'}</text>
    ${cells}${segs}</svg>`;
}

function viewFrom(file, dest, layer, bank) {
  const model = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  const session = new ProgramSession({ rpc: async () => { throw new Error('offline'); } });
  session.model = model;
  session.sel.dest = dest;
  session.sel.layer = layer;
  session.sel.bank = bank;
  session._keepSelection();
  return session.view();
}

const shots = [
  ['e2-dest-single', viewFrom(path.join(__dirname, '../test/fixtures/e2/single-dest-v92.json'), 'S1', 0, 'place'), 0],
  ['e2-layers-live', viewFrom(path.join(__dirname, '../test/fixtures/e2/multi-dest.json'), 'S1', 2, 'place'), 1],
  ['e2-dials-border', viewFrom(path.join(__dirname, '../test/fixtures/e2/firmware-variant.json'), 'S1', 0, 'look'), 2],
  ['e2-sources', viewFrom(path.join(__dirname, '../test/fixtures/e2/multi-dest.json'), 'S1', 2, 'place'), 3],
];

for (const [name, view, index] of shots) {
  const pages = buildProgramPages(SURFACES.plusxl, view, 'e2');
  const file = path.join(outDir, `${name}.svg`);
  fs.writeFileSync(file, pageSvg(pages[index]));
  console.log(file);
}
