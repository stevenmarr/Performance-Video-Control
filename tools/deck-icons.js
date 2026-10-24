'use strict';
// Writes the Stream Deck manifest icons (M4 Viewport mark). Re-run after changing the mark.
const fs = require('fs');
const path = require('path');
const { iconPng } = require('../lib/deck-image');

const root = path.join(__dirname, '..', 'streamdeck', 'com.performancevideo.control.sdPlugin', 'imgs');
const write = (rel, size, opts) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, iconPng(size, opts));
};

write('plugin/category-icon.png', 28, {});
write('plugin/category-icon@2x.png', 56, {});
write('plugin/marketplace.png', 256, { bg: '#101012', color: '#E6E6E8' });
write('plugin/marketplace@2x.png', 512, { bg: '#101012', color: '#E6E6E8' });

for (const name of ['home', 'camera', 'preset', 'page', 'key', 'dial']) {
  write(`actions/${name}/icon.png`, 20, {});
  write(`actions/${name}/icon@2x.png`, 40, {});
  write(`actions/${name}/key.png`, 72, { bg: '#222226', color: '#E6E6E8' });
  write(`actions/${name}/key@2x.png`, 144, { bg: '#222226', color: '#E6E6E8' });
}
write('actions/dial/encoder.png', 72, {});
write('actions/dial/encoder@2x.png', 144, {});
console.log('wrote Stream Deck icons');
