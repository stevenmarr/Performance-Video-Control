'use strict';
// Every Bitfocus Companion connection type, and whether Control Center has a
// native system for it. The id list is the public bitfocus/companion-module-*
// repositories. Status comes from the system catalog, not from wrapping Companion.

const ids = require('./companion-ids.json');
const { systems } = require('./catalog');

const EXTRA = {
  'generic-tcp-udp': { status: 'implemented', system: 'generic-tcp + generic-udp', note: 'Companion combines TCP and UDP. Control Center has one system for each.' },
};

function index() {
  const map = new Map();
  for (const system of systems()) {
    for (const name of system.companion || []) {
      map.set(name, system);
    }
  }
  return map;
}

function rows() {
  const map = index();
  return ids.map((id) => {
    const extra = EXTRA[id];
    if (extra) return { id, status: extra.status, system: extra.system, note: extra.note, docs: '' };
    const system = map.get(id);
    if (!system) return { id, status: 'not yet', system: '', note: '', docs: '' };
    return {
      id,
      status: system.status,
      system: system.id,
      note: system.docs.note || '',
      docs: system.docs.url || '',
      basis: system.docs.basis || '',
    };
  });
}

function summary(list = rows()) {
  const counts = { implemented: 0, partial: 0, 'not yet': 0 };
  for (const row of list) counts[row.status] = (counts[row.status] || 0) + 1;
  return { total: list.length, ...counts, systems: systems().map(countSystem) };
}

function countSystem(system) {
  return {
    id: system.id,
    label: system.label,
    status: system.status,
    buttons: system.actions.length,
    variables: system.variables.length,
    feedbacks: system.feedbacks.length,
    docs: system.docs.url,
    basis: system.docs.basis,
  };
}

function markdown() {
  const list = rows();
  const sum = summary(list);
  const lines = [];
  lines.push('# Systems coverage');
  lines.push('');
  lines.push('Control Center systems are native. Each implemented system speaks the manufacturer\'s published protocol. Companion module names are a checklist, so a later run can see what is still open. They are not loaded or wrapped.');
  lines.push('');
  lines.push(`Companion connection types: **${sum.total}**. Implemented: **${sum.implemented}**. Partial: **${sum.partial}**. Not yet: **${sum['not yet']}**.`);
  lines.push('');
  lines.push('## Systems in this build');
  lines.push('');
  lines.push('| System | Status | Buttons | Variables | Feedbacks | Protocol basis | Source |');
  lines.push('|---|---|---:|---:|---:|---|---|');
  for (const system of systems()) {
    const basis = system.docs.basis === 'community' ? 'community' : system.docs.basis === 'reverse' ? 'reverse-engineered' : 'official';
    lines.push(`| ${system.label} (\`${system.id}\`) | ${system.status} | ${system.actions.length} | ${system.variables.length} | ${system.feedbacks.length} | ${basis} | ${system.docs.url || '—'} |`);
  }
  lines.push('');
  lines.push('## Notes on sources');
  lines.push('');
  lines.push('- Official means the command is the one the manufacturer\'s document names. The URL is that document, or the manufacturer page that publishes it.');
  lines.push('- Yamaha CL/QL commands are the published remote-control lines (`set MIXER:Current/...`, `ssrecall_ex`). The command list ships in Yamaha\'s setup package. https://github.com/BrenekH/yamaha-rcp-docs/ is a public transcription of that list, not a second protocol.');
  lines.push('- DiGiCo addresses are the console\'s own OSC paths. The Companion CSV is only a cross-reference.');
  lines.push('- NDI routing is not implemented. The NDI SDK is a licensed binary and there is no open wire protocol in this build.');
  lines.push('- grandMA3 control addresses are `/Page/Fader` and `/Page/Key`. Sequence feedback is the console\'s `/13.13.1.6.<n>` message (function, handle, percent).');
  lines.push('- Barco Pulse is JSON-RPC 2.0 on TCP 9090 (`system.poweron`, `system.poweroff`, `optics.shutter.target`, `image.window.main.source`). Christie stays on PJLink.');
  lines.push('- BirdDog uses the VISCA-over-IP command set its cameras document. Model-specific REST bodies are not guessed.');
  lines.push('- ATEM\'s public interface is the Blackmagic SDK. The desk speaks that switcher protocol. The byte layout is the SDK\'s, not a separate REST document.');
  lines.push('- Analog Way Midra and LiveCore have no buttons. The classic Midra programmer guide was not found on an Analog Way download, and LiveCore is not the LivePremier protocol already spoken by RS6.');
  lines.push('- Barco ImagePRO-4K is listed on the Event Master protocol, which the E2 system already speaks. The older ImagePRO ASCII set is not aliased to PDS-4K.');
  lines.push('- Ross NK third-party control is the NK-3RD serial protocols or the NK-SCP/A ASCII protocol. The user guide does not print a command line, so no button is sent.');
  lines.push('- Colorlight processors use the CLTPlatform brightness call. GrandShow is not that API. NovaStar COEX is the HTTP brightness API. The other NovaStar families are not that API and are not the VX Pro frame.');
  lines.push('- Roland basic PGM and CUT cover V-160HD, V-80HD, VR-120HD and V-1-4K. FOR-A\'s command list is behind a login. Evertz, Riedel RRCS, Haivision, Teradek, Magewell, Hippotizer and TriCaster did not yield a request line that was safe to send.');
  lines.push('- Avantis mute, CQ mute, MultiView routing, Blackmagic camera record, SMP 351 record, PCS4 receptacles, Vaddio presets, AVer VISCA, DM3 OSC, Sennheiser SSC, RossTalk server and Caprica, Viz Trio, Picturall, disguise OSC, SPX, Flowics reads and WLED are separate systems. AJA FS, Datavideo DVIP, OBSBOT, Clear-Com, Kairos, Encore, the SuperJoy, and the other ids named in the blocker rows did not yield a command line that was safe to send.');
  lines.push('- APC switched-rack `on 1`, Gude `cmd=1`, Neol `M0:O1=ON`, Dataprobe outlet control, ATEN `/api/outlet/relay`, ATDM mute, Audia `RECALL 0 PRESET`, Bravia `setPlayContent`, DN-500BD `@0PW00`, Foscam CGI, ZoneMinder alarm, Lilliput `1v2.`, H2R `/run`, Mosart `start-continue`, CueTimer `/global/fire` and Irisdown `GO` are separate systems. A zero-button row is a recorded blocker, not a command system. APC UPS, CyberPower, Eaton, Crestron NVX, Dahua, d&b, Christie WD, Barco DCS/DP/MatrixPRO, Biamp QTX, the other Denon ids and Lumix did not get a command copied from a different product.');
  lines.push('- WyreStorm `SET SW in4 out1`, Blustream `OUT01FR04`, TESmart `MT00SW0102NT`, Gefen `r 7 3`, DirectOut `audioxp 1 65 66`, Panasonic TH `PON` in an STX/ETX frame, CueServer `Cue 1 Go`, AVMatrix `1v2.`, Atlona Omega `x2AVx1`, Atlona CLSO `Input HDMI 2`, WattBox `command=1`, ATND1061 mute, VidBlaster `apiwrite`, Blackbird `1V2.` and CYP `set out A route 1` are separate systems. MT-VIKI and OREI route lines were only found outside the manufacturer, so they are not sent.');
  lines.push('- Audac MTX `#|X001|web|SR1|3|U|`, AtlasIED Atmosphere `ZoneGain_0`, Axia `DST 1 ADDR:"239.190.1.1"`, Titan `FirePlaybackAtLevel`, Hog 4 `/hog/playback/go/0`, WATCHOUT HTTP `POST /v0/play/1` and 7thSense `PLAY TL=1` are separate systems. ArKaos does not print its Telnet command, and Ai is not given the Titan call.');
  lines.push('');
  lines.push('## Every Companion connection');
  lines.push('');
  lines.push('| Companion module | Status | Control Center system | Source |');
  lines.push('|---|---|---|---|');
  for (const row of list) {
    lines.push(`| \`${row.id}\` | ${row.status} | ${row.system || '—'} | ${row.docs || '—'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { rows, summary, markdown, ids, countSystem };
