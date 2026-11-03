'use strict';
// Draw one PNG per designed page per deck model.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { SURFACES } = require('../lib/decks/surfaces');
const { show } = require('../lib/decks/faces');
const { GALLERY } = require('../lib/decks/gallery');
const { keySvg, keyModel } = require('../lib/decks/look');

const outDir = process.argv[2] || '/opt/cursor/artifacts/deck-pages';
fs.mkdirSync(outDir, { recursive: true });

function inner(svg) {
  return String(svg).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

function pageSvg(face, surface) {
  const k = 78;
  const gap = 8;
  const pad = 16;
  const cols = surface.cols;
  const rows = surface.rows;
  const width = pad * 2 + cols * k + (cols - 1) * gap;
  const dials = face.dials || [];
  const dialH = dials.length ? 36 : 0;
  const height = pad * 2 + 28 + rows * k + (rows - 1) * gap + dialH;
  const keys = face.keys || [];
  const cells = keys.map((key) => {
    const x = pad + key.col * (k + gap);
    const y = pad + 28 + key.row * (k + gap);
    const svg = keySvg(keyModel(key));
    const scale = k / 144;
    return `<g transform="translate(${x} ${y}) scale(${scale})">${inner(svg)}</g>`;
  }).join('');
  const dialText = dials.map((d, i) => {
    const x = pad + ((i + 0.5) * (width - pad * 2)) / dials.length;
    return `<text x="${x}" y="${height - 12}" text-anchor="middle" font-family="Arial" font-size="14" fill="#D5D8DE">${d.label}</text>`;
  }).join('');
  const title = `${surface.label} · ${face.title || face.designId}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#14161A"/>
    <text x="${pad}" y="24" fill="#F4F7FB" font-family="Arial" font-size="16" font-weight="700">${title.replace(/[&<>]/g, '')}</text>
    ${cells}${dialText}
  </svg>`;
}

const desk = {
  armed: ['ptz', 'atem', 'videohub', 'e2', 'mitti', 'hyperdeck'],
  byKey: { ptz: { cameras: [{ id: 'cam1', name: 'Wide' }, { id: 'cam2', name: 'Tight' }], selected: 'cam2' } },
};
const models = ['plusxl', 'xl', 'plus', 'mk2', 'neo', 'mini'];
const written = [];
for (const model of models) {
  const surface = SURFACES[model];
  for (const item of GALLERY) {
    const system = item.kind;
    const armed = item.kind === 'console' ? { armed: [] } : desk;
    let face = null;
    const probe = show(surface, armed, { system, page: 0 });
    for (let p = 0; p < probe.pages; p++) {
      const candidate = show(surface, armed, { system, page: p });
      if (candidate.designId === item.id) { face = candidate; break; }
    }
    if (!face) continue;
    const svg = pageSvg(face, surface);
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: surface.cols * 90 }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' }, background: '#14161A' }).render().asPng();
    const file = path.join(outDir, `${model}--${item.id}.png`);
    fs.writeFileSync(file, png);
    written.push(file);
  }
}
const atemDesk = {
  armed: ['atem'],
  byKey: {
    atem: {
      label: 'ATEM', host: '10.0.0.8', port: 9910,
      view: {
        model: 'Constellation',
        mes: [{ program: 2, preview: 1, style: 'WIPE', mixRate: 30, handle: 2500, wipe: 1, bus: [
          { id: 1, long: 'Cam L', short: 'Cam L' }, { id: 2, long: 'Cam R', short: 'Cam R' },
          { id: 3, long: 'Mitti', short: 'Mitti' }, { id: 4, long: 'Hyper', short: 'Hyper' },
        ] }],
        macros: [{ index: 0, isUsed: true, name: 'Open' }],
      },
    },
  },
};
for (const model of models) {
  const surface = SURFACES[model];
  const face = show(surface, atemDesk, { system: 'atem', page: 0 });
  const svg = pageSvg(face, surface);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: surface.cols * 90 }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' }, background: '#14161A' }).render().asPng();
  const file = path.join(outDir, `${model}--atem-switcher.png`);
  fs.writeFileSync(file, png);
  written.push(file);
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ count: written.length, files: written.map((f) => path.basename(f)) }, null, 2));
console.log(`wrote ${written.length} pages to ${outDir}`);
