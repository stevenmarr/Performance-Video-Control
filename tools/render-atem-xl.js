'use strict';
// Five + XL previews of the ATEM switcher page.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { SURFACES } = require('../lib/decks/surfaces');
const { show } = require('../lib/decks/faces');
const { keyModel } = require('../lib/decks/look');
const { keySvg, segmentSvg } = require('../lib/deck-image');

const outDir = process.argv[2] || '/opt/cursor/artifacts/deck-pages';
fs.mkdirSync(outDir, { recursive: true });

const desk = {
  armed: ['atem'],
  byKey: {
    atem: {
      label: 'Constellation', host: '10.0.0.8', port: 9910,
      view: {
        model: 'Constellation HD',
        topology: { downstreamKeyers: 2, mixEffects: 2 },
        dsk: [{}, {}],
        mes: [
          { program: 2, preview: 1, style: 'WIPE', nextSelection: 1, mixRate: 30, handle: 4500, wipe: 0, inTransition: false, keyers: [{ onAir: true }, { onAir: false }], bus: [
            { id: 1, long: 'Camera Left', short: 'Cam L' },
            { id: 2, long: 'Camera Right', short: 'Cam R' },
            { id: 3, long: 'Mitti Walk In', short: 'Mitti' },
            { id: 4, long: 'HyperDeck 1', short: 'Hyper' },
          ] },
          { program: 3, preview: 4, style: 'MIX', mixRate: 25, handle: 0, wipe: 0, keyers: [{ onAir: false }], bus: [] },
        ],
        macros: [{ index: 0, isUsed: true, name: 'Open' }],
      },
    },
  },
};

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
  const stripH = 72;
  const height = pad * 2 + 28 + rows * k + (rows - 1) * gap + 16 + stripH;
  const cells = (face.keys || []).map((key) => {
    const x = pad + key.col * (k + gap);
    const y = pad + 28 + key.row * (k + gap);
    const scale = k / 144;
    return `<g transform="translate(${x} ${y}) scale(${scale})">${inner(keySvg(keyModel(key)))}</g>`;
  }).join('');
  const dials = face.dials || [];
  const slice = Math.floor((width - pad * 2) / Math.max(1, dials.length));
  const stripY = height - pad - stripH;
  const segs = dials.map((dial, i) => {
    const svg = segmentSvg(dial.strip || { kind: 'map', text: dial.readout || '' }, slice, stripH);
    return `<g transform="translate(${pad + i * slice} ${stripY})">${inner(svg)}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#14161A"/>
    <text x="${pad}" y="22" fill="#F4F7FB" font-family="Arial" font-size="16" font-weight="700">${face.title || 'ATEM switcher'}</text>
    ${cells}${segs}</svg>`;
}

const states = [
  ['normal', {}],
  ['shift', { atemUi: { shift: 1, me: 1, flexBank: 0, mes: [1] } }],
  ['bank2', { atemUi: { shift: 0, me: 1, flexBank: 1, mes: [1] } }],
  ['trans', { atemUi: { shift: 0, me: 1, flexBank: 0, mes: [1, 2], transHold: true, next: { bkgd: true, keys: [false, true], dsk: [false, true] } } }],
  ['mapping', { atemUi: { shift: 0, me: 1, flexBank: 0, mes: [1], pending: { bus: 'pgm', slot: 2, index: 0, name: 'Mitti Walk In' } } }],
];

for (const [name, session] of states) {
  const face = show(SURFACES.plusxl, desk, { system: 'atem', page: 0, ...session });
  const png = new Resvg(pageSvg(face), { fitTo: { mode: 'width', value: 900 }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' }, background: '#14161A' }).render().asPng();
  const file = path.join(outDir, `plusxl--atem-switcher--${name}.png`);
  fs.writeFileSync(file, png);
  console.log(file);
}
