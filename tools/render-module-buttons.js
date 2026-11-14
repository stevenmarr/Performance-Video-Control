'use strict';
// Rasterize a row of sample buttons in dark and light mode.
// node tools/render-module-buttons.js [outDir]
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { resolveKey, faceFromKey } = require('../lib/decks/key-class');
const { keySvg } = require('../lib/deck-image');
const { encodePng } = require('../lib/deck-image');
const { buttonFor } = require('../lib/modules/framework');
const { get } = require('../lib/modules/catalog');

const SAMPLES = [
  ['atem', 'cut', {}, 'CUT'],
  ['atem', 'preview', {}, 'Preview'],
  ['atem', 'program', { program: true }, 'On air'],
  ['hyperdeck', 'record', {}, 'Record'],
  ['vmix', 'audioOn', {}, 'vMix'],
  ['qlab', 'pause', {}, 'QLab'],
  ['ross-rosstalk', 'ftb', {}, 'Confirm'],
  ['console', 'host.shutdown', {}, 'OS'],
];

function model(systemId, actionId, flags, theme) {
  const system = get(systemId);
  const action = system.actionMap.get(actionId);
  const button = buttonFor(system, action);
  if (flags.program) button.feedbacks = [...(button.feedbacks || []), { when: 'program', style: { bgcolor: '#C42020', color: '#FFFFFF', bar: '#C42020' } }];
  const face = faceFromKey(resolveKey(button, flags, { 'atem:name': 'CAM 1' }, theme));
  return {
    fill: face.fill, ink: face.ink, dim: face.dim || face.ink, bar: face.bar,
    border: face.border, guard: face.guard, os: face.os,
    title: face.title, value: face.value, caption: face.caption,
  };
}

function paint(theme) {
  const cell = 160;
  const width = SAMPLES.length * cell;
  const height = 210;
  const bg = theme === 'light' ? '#E6EAF0' : '#0B0D10';
  const label = theme === 'light' ? '#12161C' : '#F4F7FB';
  const parts = SAMPLES.map(([systemId, actionId, flags], i) => {
    const svg = keySvg(model(systemId, actionId, flags, theme));
    const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    const x = i * cell + 8;
    return `<g transform="translate(${x},28) scale(0.9)">${inner}</g>
      <text x="${x + 64}" y="190" text-anchor="middle" fill="${label}" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700">${SAMPLES[i][3]}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${bg}"/>
    <text x="16" y="20" fill="${label}" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700">${theme === 'light' ? 'Light' : 'Dark'}</text>
    ${parts}
  </svg>`;
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render();
  return encodePng(rendered.width, rendered.height, Buffer.from(rendered.pixels));
}

const outDir = process.argv[2] || path.join(__dirname, '..');
fs.writeFileSync(path.join(outDir, 'module-buttons-dark.png'), paint('dark'));
fs.writeFileSync(path.join(outDir, 'module-buttons-light.png'), paint('light'));
console.log('wrote', outDir);
