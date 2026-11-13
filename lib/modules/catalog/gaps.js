'use strict';
// Companion types checked in this pass that do not get buttons yet.
// The note is the blocker. The URL is the document that was read.

const { defineSystem } = require('../framework');

const docs = (url, title, note) => ({ url, title, basis: 'official', note });

function held(id, label, manufacturer, companion, url, title, note) {
  return defineSystem({
    id, label, short: label.slice(0, 16), category: 'gap', manufacturer, bar: '#5c6570',
    status: 'not yet', transport: 'none', companion, summary: note,
    docs: docs(url, title, note),
    connection: { fields: [] },
    variables: [], feedbacks: [], actions: [],
  });
}

const systems = [
  held(
    'analogway-midra', 'Analog Way Midra', 'Analog Way', ['analogway-midra'],
    'https://www.analogway.com/downloads',
    'Analog Way downloads',
    'Classic Midra TPP lines such as GCtak and GClrq are described in Analog Way programmer-guide text hosted outside Analog Way. No Analog Way download of that guide was found, so those lines are not sent. Midra 4K is controlled from the Web RCS and is a different path.',
  ),
  held(
    'analogway-livecore', 'Analog Way LiveCore', 'Analog Way', ['analogway-livecore', 'analogway-livecore-custom'],
    'https://www.analogway.com/downloads',
    'Analog Way downloads',
    'LiveCore uses its own register set. It is not the LivePremier AWJ protocol already spoken by RS6, and it is not the classic Midra TPP lines. No Analog Way command list for LiveCore was verified, so no button is sent.',
  ),
  held(
    'barco-imagepro', 'Barco ImagePRO', 'Barco', ['barco-imagepro'],
    'https://www.barco.com/en/support/docs/R5919184',
    'Event Master remote control protocol',
    'Barco lists ImagePRO-4K on the Event Master protocol, which this build already speaks as the E2 system. The older ImagePRO ASCII set was not verified as the PDS-4K command list, so it is not aliased.',
  ),
  held(
    'ross-nk', 'Ross NK router', 'Ross Video', ['rossvideo-nkrouter'],
    'https://documentation.rossvideo.com/files/Manuals/Routers/NK/NK%20Series%20User%20Guide(9807DR-0100).pdf',
    'NK Series User Guide',
    'Third-party control is the NK-3RD speaking Pro-Bel SW-P-08, SW-P-02, Jupiter or GVG Native on RS-422, or the NK-SCP/A ASCII protocol. The user guide names those protocols and does not print a command line that can be sent, so no button is sent.',
  ),
];

module.exports = { systems };
