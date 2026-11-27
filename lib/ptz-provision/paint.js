'use strict';
// House initial paint: 5000 K (VAR), ND clear (through), shutter off. Everything else stays factory.
const COLOR_TEMP_K = 5000;
const hex5 = (n) => Number(n).toString(16).toUpperCase().padStart(5, '0');

function commands() {
  return [
    { path: 'cam', cmd: 'OAW:9', label: 'WB mode VAR' },
    { path: 'cam', cmd: `OSI:20:${hex5(COLOR_TEMP_K)}`, label: 'Colour temperature 5000K' },
    { path: 'cam', cmd: 'OFT:0', label: 'ND clear (through)' },
    { path: 'cam', cmd: 'OSJ:03:0', label: 'Shutter off' },
  ];
}

module.exports = { COLOR_TEMP_K, hex5, commands };
