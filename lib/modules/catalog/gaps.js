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
  held(
    'colorlight-grandshow', 'Colorlight GrandShow', 'Colorlight', ['colorlight-grandshow'],
    'https://developer.colorlightcloud.com/CLTServer/en/api-reference/sender-device/screen-group/brightness-and-color-temperature/set-screen-brightness.html',
    'CLTPlatform set screen brightness',
    'GrandShow is Colorlight\'s media server. The CLTPlatform brightness call implemented for the processor is not the GrandShow control set, and no GrandShow command list was verified.',
  ),
  held(
    'novastar-other', 'NovaStar other families', 'NovaStar', ['novastar-allinone', 'novastar-broadcastswitcher', 'novastar-controller', 'novastar-d12', 'novastar-mediaserver', 'novastar-mxreal3', 'novastar-splicer', 'novastar-switcher', 'novastar-t-series', 'novastar-vx4s'],
    'https://oss.novastar.tech/uploads/2023/02/COEX-Series-Interface-API-User-Manual.pdf',
    'NovaStar COEX Series Interface API',
    'COEX HTTP and the VX Pro TCP brightness frame are separate systems. These remaining NovaStar ids use other frames or products, and no matching official request was verified for each one.',
  ),
  held(
    'fora', 'FOR-A', 'FOR-A', ['fora-hvs', 'fora-mfr', 'fora-processors'],
    'https://www.for-a.com/products/hvs6000/',
    'FOR-A HVS-6000',
    'FOR-A publishes an HVS protocol command list, and the download on the product page requires a login. No command line from that list was available to send.',
  ),
  held(
    'roland-other', 'Roland other models', 'Roland', ['roland-m5000', 'roland-p20hd', 'roland-v1200hd', 'roland-v600uhd', 'roland-vp42h', 'roland-vr400uhd', 'roland-vr50hd-mk2', 'roland-xs42h', 'roland-xs62s', 'roland-xs84h'],
    'https://static.roland.com/assets/media/pdf/LAN_RS-232_Basic_Control_Commands_eng02_W.pdf',
    'Roland LAN/RS-232 basic control commands',
    'The basic PGM and CUT commands cover V-160HD, V-80HD, VR-120HD and V-1-4K. These other Roland products are not in that table, and the V-60HD table is its own system.',
  ),
  held(
    'evertz', 'Evertz', 'Evertz', ['evertz-dreamcatcher', 'evertz-quartz', 'evertz-symphony', 'evertz-vipx'],
    'https://evertz.com/',
    'Evertz',
    'No public Evertz command list for DreamCatcher, Quartz, Symphony or VIP-X was verified in this pass, so no button is sent.',
  ),
  held(
    'riedel', 'Riedel', 'Riedel', ['riedel-medianetworks', 'riedel-mediornet', 'riedel-rrcs', 'riedel-smartpanel'],
    'https://www.riedel.net/produkt/intercom/intercom-software/rrcs/',
    'Riedel RRCS',
    'RRCS is Riedel\'s interface for third-party control of Artist. The interface specification was not available as a public command list, so no crosspoint or key command is sent. MediorNet, MediaNetworks and SmartPanel are separate products.',
  ),
  held(
    'haivision', 'Haivision', 'Haivision', ['haivision-connectdvr', 'haivision-kbencoder', 'haivision-makito-x4-decoder', 'haivision-makito-x4-encoder'],
    'https://doc.haivision.com/MakitoX4Enc/1.9/accessing-the-rest-api',
    'Makito X4 REST API',
    'Haivision tells you to open /apidoc on the encoder for the REST stack, and the stream page describes a stream start command without a request line that was safe to copy. No button is sent.',
  ),
  held(
    'teradek', 'Teradek', 'Teradek', ['teradek-prism', 'teradek-vidiu', 'teradek-vidiux'],
    'https://www.teradek.com/',
    'Teradek',
    'No published Prism, VidiU or VidiU X request line was verified in this pass, so no stream command is sent.',
  ),
  held(
    'magewell', 'Magewell', 'Magewell', ['magewell-director', 'magewell-proconvert-decoder', 'magewell-ultrastream'],
    'https://www.magewell.com/developer/27/detail',
    'Magewell Pro Convert HTTP API',
    'Magewell documents product HTTP APIs, including source select for Pro Convert IP to USB and a large live-apply body for Audio DX. Neither page gave one request body that matches these three Companion products, so no button is sent.',
  ),
  held(
    'hippotizer', 'Green Hippo Hippotizer', 'Green Hippo', ['greenhippo-hippotizer', 'greenhippo-hippotizer-rest'],
    'https://support.green-hippo.com/hc/en-gb/articles/29184031287442-NDI-Troubleshooting',
    'Green Hippo support',
    'The pages read describe NDI source compatibility. They do not publish a Hippotizer control command or REST call, so no button is sent.',
  ),
  held(
    'tricaster', 'TriCaster', 'Vizrt', ['newtek-tricaster'],
    'https://vizrt.my.site.com/knowledgebase/s/article/TriCaster-remote-control-port',
    'TriCaster remote control port',
    'Vizrt documents REST on TCP 80, 443 and 5952, and CharacterWorks on 5951. The article does not publish a shortcut request, so no button is sent.',
  ),
  held(
    'soundcraft-ui', 'Soundcraft Ui', 'Soundcraft', ['soundcraft-ui'],
    'https://www.soundcraft.com/',
    'Soundcraft',
    'The Ui series serves its own web mixer. The SETD text messages are the web socket the page uses, not a published control specification, so no button is sent.',
  ),
  held(
    'kiloview', 'Kiloview', 'Kiloview', ['kiloview-4kconverter', 'kiloview-cuber1', 'kiloview-cubex1', 'kiloview-decoder', 'kiloview-encoder', 'kiloview-mediagateway'],
    'https://www.kiloview.com/en/docs/device-http-api/description-of-http-api/',
    'Kiloview device HTTP API',
    'Kiloview publishes an HTTP API index of modules such as streamer and encode. This pass did not verify one request body for start, stop or input select, so no button is sent.',
  ),
];

module.exports = { systems };
