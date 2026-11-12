'use strict';
// Live preview for the button editor. Uses resolveKey / faceFromKey and the
// same key SVG the USB deck paints (lib/deck-image.js keySvg). Encoders and
// touch segments get a matching picture from that face, not a second style.

const { resolveKey, faceFromKey } = require('./key-class');
const { keySvg } = require('../deck-image');

const SAMPLE = {
  'atem:name': 'Constellation',
  'atem:shiftLabel': 'INPUTS',
  'atem:mes': 'ME1',
  target: 'atem-1',
};

function xml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;');
}

function modelFrom(button, flags, vars) {
  const resolved = resolveKey(button || {}, flags || {}, vars || SAMPLE);
  const face = faceFromKey(resolved);
  return {
    fill: face.fill,
    ink: face.ink,
    dim: face.dim || face.ink,
    bar: face.bar,
    border: face.border,
    os: face.os,
    title: face.title,
    value: face.value,
    caption: face.caption,
  };
}

function encoderSvg(model) {
  const fill = model.fill || '#2a2a2e';
  const ink = model.ink || '#F4F7FB';
  const bar = model.bar || fill;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="18" fill="#101214"/>
    <circle cx="72" cy="62" r="36" fill="${fill}" stroke="${bar}" stroke-width="8"/>
    <text x="72" y="128" text-anchor="middle" fill="${ink}" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700">${xml(model.value || model.title || '')}</text>
  </svg>`;
}

function segmentSvg(model) {
  const fill = model.fill || '#1a1e24';
  const ink = model.ink || '#F4F7FB';
  const bar = model.bar || fill;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="72" viewBox="0 0 200 72">
    <rect width="200" height="72" rx="10" fill="${fill}" stroke="${bar}" stroke-width="3"/>
    <text x="100" y="42" text-anchor="middle" fill="${ink}" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700">${xml(model.value || model.title || '')}</text>
  </svg>`;
}

function previewSvg(button, flags, vars) {
  const model = modelFrom(button, flags, vars);
  const element = button && button.element;
  const svg = element === 'encoder' ? encoderSvg(model) : element === 'touch-segment' ? segmentSvg(model) : keySvg(model);
  return { svg, element: element || 'button', face: model };
}

module.exports = { previewSvg, SAMPLE, modelFrom };
