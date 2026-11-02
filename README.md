# Performance Video Control Center

<img src="public/pv-logo.png" alt="Performance Video LLC" height="48">

One desk for the show. The app runs on a Mac (or a Pi that only relays video) and serves a dark,
touch-friendly UI. An iPad or phone on the same network opens it in a browser.

The top row is **SYSTEMS**, the systems you have put on the desk, **SCOPES**, and **Control Devices**. Each system you add
gets its own pages: presets, switcher, cameras, media. Program is red. Preview is green. **Control Devices** draws those pages on Stream Decks over USB.

| On the desk | What it drives |
|---|---|
| RS6 | Analog Way Aquilon RS6 presets, inputs, backup, audio, Web RCS |
| E2 / PixelHue | Barco Event Master and PixelHue presets, cues, sources, stills |
| ATEM | Blackmagic switcher, router (output, then source), audio, keys, macros, and **TSL tally** |
| PTZ | Panasonic AW-UE / AW-HE camera control, plus the Path C Stream Deck pages |
| Pixera / Millumin | Timelines, cues, columns, layers |

The npm package name is still `rs6-presets`. The on-disk data folder still uses that older name.
The product in the browser is Control Center.

No build step for the desk. Node.js 16 or later. USB Stream Decks need
`@elgato-stream-deck/node` **7.8.0** and `node-hid` **3.4.0**. That package needs
**Node >=18.18**. The Pi's Node 18.20.4 is new enough. Do not upgrade Node for
this. The Pi install below runs `npm ci --omit=dev` so both packages are present.
The Stream Deck plugin is a separate package and needs Node.js 24.

---

## Run it

```bash
node server.js
# or: npm start
```

Open **http://localhost:8080**. The terminal prints `Control Center:` and the LAN addresses. On an
iPad or phone, open `http://<this-machine>:8080`.

| Flag | Meaning |
|---|---|
| `--port 8080` | HTTP port (default 8080) |
| `--host 0.0.0.0` | Listen address (the default, so the LAN can open the UI) |
| `--data <dir>` | Where shows and settings live. `RS6_DATA_DIR` does the same |

The desk UI starts with `node server.js` and no build. USB Stream Decks do not.
On a Mac that should open decks, run `npm ci --omit=dev` in this folder once.
Without that library the server still starts and logs `USB Stream Deck library is missing`.

The first time it runs, macOS may ask whether `node` may accept incoming connections. Allow it, or
phones on the LAN cannot open the UI. `localhost` works either way. If you denied it: System
Settings → Network → Firewall → Options, and allow `node`.

### Where your show lives

Presets, connections, the show library, scopes settings, and the TSL map live **outside** the app
folder, so replacing the app does not wipe the show.

| System | Folder |
|---|---|
| macOS | `~/Library/Application Support/RS6 Presets` |
| Windows | `%APPDATA%\RS6 Presets` |
| Linux | `$XDG_CONFIG_HOME/rs6-presets`, or `~/.config/rs6-presets` |

`--data` and `RS6_DATA_DIR` override that. The folder name is the one the app already uses.

### `--mock` is for tests

`node server.js --mock` starts built-in simulators (RS6, E2, ATEM, PTZ, Pixera, Millumin) and writes
under `<app>/mock-data`, so a demo cannot mix with a real show. Unit tests and the Playwright UI
tests use it. It does **not** put a live picture on SCOPES, and it does not add NDI sources.

On a show, run `node server.js` and connect each system from **SYSTEMS → CONFIGURE**, or use
**ADD TO DESK AS SIMULATOR** on a card when you want a fixture that is not saved.

---

## SYSTEMS

**⌂ SYSTEMS** is the home page. The left column is a palette of every system type the app can drive (RS6, E2, PixelHue, ATEM, PTZ, Pixera, Millumin). A palette row is a template: dragging it, or ADD, does not use it up. Every type can be added more than once.

The right column is the desk. Each card is one instance, with its own id, name, IP address and port, type-specific settings, and connection status: CONNECTING, ONLINE, RECONNECTING, or OFFLINE. Drop the same type again to add another — two RS6s, two E2s, two PTZ desks — and give each its own address. **DUPLICATE IP** means the same host and the same port. The same host on a different port is fine (a second PTZ camera port, or a second RS6 REST port).

Right-click a desk card for **Rename**, **Duplicate**, **Disconnect / Connect**, and **Delete** (it asks first). Delete removes that instance. Layout looks, tally rows, and Stream Deck pages store the instance id, not the IP, so changing the address does not retarget them.

An older `systems.json` with one configured device becomes that one instance. The id stays the family key: `atem`, `e2`, `pixelhue`, `ptz`, `pixera`, `millumin`, and `rs6` when the RS6 already had an IP in settings. New copies are ids like `atem-k3f2a1` or `rs6-k3f2a1`.

`/api/sys/<family>/...` still means the original instance (`/api/sys/atem/...`, `/api/sys/ptz/...`, `/api/sys/rs6/...`). `/api/sys/<instance-id>/...` is any other copy. The original RS6 connection is still saved with `/api/settings`. Every added RS6 has its own driver, IP, REST port, and AWJ port.

- **ADD** or drag puts an instance on the desk. The first of a type keeps the old id.
- **OPEN** goes to that instance's pages. When two or more of a family are on the desk, those pages show the same instance picker the ATEM pages use (RS6, E2 / PixelHue, PTZ, Pixera, Millumin).
- **CONFIGURE** is the name, IP, and port. The summary on the card shows the address.
- **REMOVE** takes it off the desk. **Delete** (right-click) also clears a primary connection.
- **ADD AS SIMULATOR** runs a built-in fixture on 127.0.0.1 for that instance, including a second RS6. In `--mock` the first of each family is already the built-in mock; add another, then ADD AS SIMULATOR. The fixture address is not written into the show.

Recall, take, and cut on an added RS6 go to that processor. The show book still lives on the original RS6, and the inputs, backup, audio, and Web RCS pages still read that original processor.

A Stream Deck is keyed by its USB serial when the device reports one (`serial:…`). A DeckLink input is keyed by device index (`decklink:0`), not by an IP. An NDI sidecar source is keyed by its sidecar id (`ndi:…`). A camera on the original PTZ stays `cam:<id>`; a camera on an added PTZ is `cam:<instance-id>:<id>`.

TSL tally can send to more than one receiver. The original receiver keeps id `tsl` and the host and port already on the ATEM page. **＋ TSL DESTINATION** adds another (`tsl-……`) with its own name, host, and port. The same host and port on two receivers is flagged.

Cues, looks, and the CUES timeline store the instance id. A family name with no suffix (`rs6`, `e2`, `pixelhue`, `atem`, `ptz`) still means the original. An added RS6 (`rs6-……`) recalls, takes, and cuts on that processor. The original RS6 still uses the Engine. The systems tree shows each instance by name. An ATEM macro step names its ATEM. A PTZ step names the added PTZ when the camera is not on the original. The timeline is one row per instance: two RS6s are two rows, and the same row cannot share a step.

Group chips (Presentation switchers, Production switchers, Cameras, Media servers) and the search
box filter the cards. The look matches the rest of Control Center: dark panels, red for the system
you are in.

**STREAM DECK PAGES** at the bottom of SYSTEMS is the Companion page download for other surfaces.
It is not the system cards, and it is not the PTZ deck. Path C is below.

---

## SCOPES

**SCOPES** stays on the top row. Waveform, RGB parade, vectorscope, Lightning, false colour, and
zebra run on the selected feed. Lightning is a scope mode (Y vertical, B−Y left, R−Y right), not
its own tab. **PTZ → SCOPES** is a shortcut into the same pane, aimed at a camera.

Live video is **Blackmagic Desktop Video** (a DeckLink input). The Pi and the app process never
open the card. A Mac sidecar captures, encodes H.264, and pushes it into the same WebSocket relay
the camera RTSP path already uses. Browsers decode with WebCodecs (or MSE) and draw the scopes
in WebGL2.

```bash
# Mac, once: build the helper. The DeckLink SDK is not in this repo.
cd tools/native/decklink-recv
make

# Control Center already running:
node tools/decklink-sidecar.js --list
node tools/decklink-sidecar.js --device 0 --app http://127.0.0.1:8080
```

The SOURCE list does not invent a device. **Desktop Video** is the first group and stays empty
until that sidecar is connected. Cameras and test clips stay available. **NDI (advanced)** is
hidden until a legacy sidecar is actually pushing. There is no mock-fixture group.

`make` on Linux stops before it tries to link Desktop Video. `--device` on Linux or on a Pi exits
before it looks for a binary. If the helper is missing on a Mac, the sidecar says so and exits.
Details: [docs/decklink-ingest.md](docs/decklink-ingest.md). Scopes controls:
[docs/scopes.md](docs/scopes.md). Legacy NDI: [docs/ndi-ingest.md](docs/ndi-ingest.md).

Ingest accepts loopback only unless you set `RS6_NDI_INGEST_LAN=1` yourself. Do not commit a show IP.

A DeckLink input can be open in one process. If another app already has that input, stop it before
the sidecar.

---

## TSL on the ATEM page

Tallies are not a SYSTEMS page. Open **ATEM → SWITCHER**. Under the buses, **TSL TALLY** maps
ATEM inputs to a TSL 5.0 receiver:

- Each row is an address: index, label, ATEM input, optional PTZ camera.
- Program lights red. Preview lights green.
- **UDP** sends to the host and port on that form (default port **8900**).
- **MOCK** only logs packets.
- The map is saved with the show.

A simulator session (`--mock`) will only UDP to loopback. A live desk sends to the address you type.
See [docs/tsl-tally.md](docs/tsl-tally.md).

---

## ATEM layout

**ATEM → LAYOUT** is the M/E and SuperSource picture. Resources are on the left, canvases in the middle, properties on the right. M/E buttons sit at the top. Each M/E has its own THIRDS, CENTER, and SAFE. A new DVE key starts at 0, 0 and size 0.5 by 0.5. **HOLD** keeps an edit off air until APPLY. **ASPECT** locks a DVE key's shape while you drag. **ATEM → MULTIVIEW** is its own page: a 16-window multiview can be 16-up, 4-up, or a mix (right-click a quadrant). **ATEM → ROUTER** is a Videohub-style destination list. See [docs/atem-layout.md](docs/atem-layout.md) and [docs/router.md](docs/router.md).

**APPLY** and **LIVE** send the picture. **READ** loads it back. **SAVE PRESET** keeps a look and recalls it to preview (take it) or program (on air). **SAVE SALVO** keeps a multiview. **SAVE MACRO** writes a Macro Desk macro and ATEM Software Control XML.

A macro cuts to the layout. It does not animate. Store key frame A and B, then **RUN A** / **RUN B**, when the move should fly. Models with no SuperSource or no DVE hide the parts they do not have.

Details and the hardware limits: [docs/atem-layout.md](docs/atem-layout.md).

---

## Stream Deck (older Path C plugin)

Control Devices, above, is how a deck is driven now: this app owns the USB
device, including on a Pi. The Elgato plugin below is the previous path. Leave
the Elgato app quit if Control Center should draw the keys.

Path C is the show deck for Panasonic AW-UE150 cameras. The Elgato plugin
`com.performancevideo.control` calls this app over HTTP. This app calls the camera. The Stream Deck
does not open a camera connection. Companion is not in that path.

| | |
|---|---|
| Plugin | `streamdeck/` |
| UUID | `com.performancevideo.control` |
| Bundle | `streamdeck/com.performancevideo.control.sdPlugin` |

Stream Deck 7.1 or newer runs the plugin on Node.js 24.

```bash
cd streamdeck
npm install
npm run build
npx @elgato/cli link com.performancevideo.control.sdPlugin
```

`npm run watch` rebuilds while Stream Deck is running. If **Performance Video Control** does not
appear, quit Stream Deck and open it again. `npx @elgato/cli pack com.performancevideo.control.sdPlugin`
writes a `.streamDeckPlugin` you can double-click.

In each action, set the Control Center host and port. The default is `127.0.0.1` port `8080`.
There is no camera address and no password on the deck.

```
Stream Deck  →  HTTP  →  Control Center  →  Panasonic AW-UE150
                GET /api/deck/ptz
                POST /api/sys/ptz/cmd/…
```

The plugin long-polls `GET /api/deck/ptz?since=<rev>`. Page tabs switch profiles named
**PTZ Live**, **PTZ Paint**, **PTZ Functions**, and **PTZ Move** when those profiles are installed.
`GET /api/deck/ptz/layout` is the same grid.

| Page | What the keys do |
|---|---|
| LIVE | Cameras, presets 1–18, iris auto, push AF, AWB, live guard, all stop |
| PAINT | Exposure and white balance. R/B gain and pedestal are encoders, not keys |
| FUNC | Tally, power, AF, O.I.S., bars, D.EXT, DRS, night, guard |
| MOVE | Pan/tilt, zoom, focus, camera home |

Paint dials (iris, gain, R/B gain, R/B pedestal, master pedestal, detail, gamma, chroma, knee) do not have a fine / coarse mode. Turn speed comes from the Stream Deck `dialRotate` tick count and the time since the previous rotate on that dial. A slow detent is exactly one camera step. Faster turns follow a quadratic curve, capped per parameter, in `lib/paint-accel.js` (`baseStep`, `exponent`, `slowMs`, `fastMs`, `windowMs`, `maxMultiplier`, `maxStepsPerEvent`, and the `OVERRIDES` map). Iris is capped lower than R/B gain because its range is 1–99, not ±200. Detail is capped lower still (±31). The first event after a gap longer than `windowMs` is always one step per detent. Zoom and focus use the same curve. Pan/tilt and zoom/focus speed dials stay one unit per detent. The browser paint page still has FINE and COARSE for the pointer and the ± buttons. The deck does not.

A short press swaps the parameter on a paired dial: R gain ↔ B gain, R pedestal ↔ B pedestal, iris ↔ gain. The touch strip labels the active side `ACTIVE R GAIN` (or whichever side is live) and draws a ring on that arc. Hold the dial for `LONG_PRESS_MS` (500 ms, same file) to reset the active parameter to the newest stored paint memory for that camera, or to the catalog centre / list default (0 dB, ATW, OFF) when nothing is stored. Zoom and focus are not reset by a hold. A tap still runs the knob's own function (A/M, AWB, ABB, stop, push AF).

Outgoing paint writes are coalesced (`COALESCE_MS`, 80 ms) so a fast spin does not open one Panasonic HTTP call per detent. The newest absolute value replaces anything not yet sent, and a value that arrives while a call is in flight is sent when that call finishes. The LCD, the touch strip, and the web paint knobs read that same optimistic value.

Function keys (auto iris, detail, DRS, white balance, gain, shutter, and the rest of the toggles and modes) draw their label from the camera's camdata readback, not from the last press. The AWB key shows the live white-balance mode (ATW, AWC A, AWC B, …) from `OAW`. ABB is an execute: the Panasonic camdata page has no ABB latch, so that key is never drawn as on.

When the camera being painted is on program, every camera function on the deck (keys, dial strip, LCD) takes a red frame. Preview is a green frame. Program wins if both are true. The source is the camera's tally lamps, which TSL follow-PTZ writes from the ATEM program / preview bus, plus the TSL address map itself (`busTally`) so the deck still shows tally if the lamp write has not landed. The web paint page uses the same red or green frame.

The Companion page export only places preset references (`ptz_<cam>_enc_*`). Those rotary actions are filled in by the external `rs6-presets` module, which does not forward dial timing, so this curve is not applied there. A client that calls `POST /api/sys/ptz/cmd/step` with an explicit `steps` count still moves that many native steps. The Elgato plugin and the USB Control Devices path both measure time and apply the curve before that call.

HOME on every page opens Control Center. It does not recall a shot. Red is program / live only.
ALL STOP is the bottom-right key on every page.

The Companion page file under **SYSTEMS → STREAM DECK PAGES** is a separate export for other
surfaces (the older Companion module). It does not build these four PTZ profiles.

The same plugin listens on `127.0.0.1:9721`. That is the old push path. Control Devices does not use it.

---

## Control Devices

Stream Decks are owned over USB, the same way Companion does it. The Elgato
desktop app is not required and does not run on a Pi. Quit that app before
scanning, or it keeps the USB device.

The deck opens on **Home**. Each key is one system on the desk (RS6, a PTZ
system, E2, Pixelhue, and the rest). Choosing one fills the deck with that
system only. The top-left key is **Home** on every page after that.

How many pages that system takes depends on the deck. A Stream Deck + has
8 keys, so PTZ spills across more pages. A Stream Deck + XL has 36 keys and
6 knobs, so the same controls fit in fewer pages. PREV and NEXT show up only
when a page is not enough.

RS6, E2 and Pixelhue preset keys are memories. Pressing one loads the stored
look onto preview. It does not toggle a key the way a macro does. Take commits
the preview. That is the Ross memory model: the recall is the absolute state
that was stored, including whether a key was on air or off air.

The USB library is `@elgato-stream-deck/node` at version **7.8.0** (it uses `node-hid` **3.4.0**). On Linux that
opens `/dev/hidraw*`. Button pictures use `@resvg/resvg-js` **2.6.2**. Both native builds publish a
linux-arm64 binary that loads on Node 18 (node-hid is N-API 4 and includes `HID_hidraw-linux-arm64`;
resvg's Pi 5 package is `@resvg/resvg-js-linux-arm64-gnu`, glibc, not musl). 7.8.0 needs **Node >=18.18**.
Node 18.20.4 is enough.

`@julusian/jpeg-turbo` stays an optional package and wants Node >=22. On Node 18 Control Center
does not load it. The first deck paint uses `jpeg-js` instead. Loading jpeg-turbo 3 on Node 18
can kill the process with SIGSEGV a few milliseconds after `opened serial`.

HID, resvg, and JPEG run in a deck worker process. If that process dies, the log says
`USB deck worker died` and `Control Center stays up`, and the worker is started again.
The web server does not exit. `CC_DECK_USB=0` does not start the worker at all.

The service scans at startup, watches `/dev` for a new hidraw node, and scans again
every few seconds. The log lines are `found N decks`, `opened serial …`, and
`cannot open …: EACCES` or `cannot open …: busy`.

The older plugin on port 9721 is documented in [docs/decks.md](docs/decks.md). It is not required.

Companion also opens Stream Decks over USB when **Settings → Surfaces → Enable direct connection to Stream Decks** is on (Companion's setting `elgato_plugin_enable`). Turn that off, or disable each deck on Companion's Surfaces page, then unplug the deck. Control Center opens the USB device itself. You do not have to click Scan. Keys you mark for Companion are handed back over the satellite URL. If another program still holds the deck, the log says `cannot open …: busy` and names that Companion setting.

A Stream Deck keeps the last picture on its keys until some other program paints. `sudo lsof /dev/hidraw*` showing nobody, while the keys still show Companion's pages, means nothing has the device open. Companion is not drawing. The old bitmap is still in the deck. Companion can also talk to a deck through its satellite connection or, on a Mac, the Elgato app. Those paths do not hold `/dev/hidraw*`. On the Pi, an empty `lsof` plus frozen Companion art means Control Center has not opened the node yet.

---

## Install on a Mac

1. Install Node.js 16 or later from <https://nodejs.org> (the LTS `.pkg`), or `brew install node`.
2. `node -v` should print v16 or later.
3. From this folder:

```bash
node server.js
```

USB decks on this Mac also need Node 18 or later and `npm ci --omit=dev` in this folder.
The server still starts without it and logs that the USB library is missing.

Open **http://localhost:8080**. Put the systems you need on the desk, then **CONFIGURE** each
address and **SAVE & CONNECT**.

For the Stream Deck plugin, use the steps above (Node.js 24, inside `streamdeck/`). For live
scopes, build `tools/native/decklink-recv` on the Mac that has Desktop Video, then run
`tools/decklink-sidecar.js`.

`node server.js` on a Mac listens on **8080**. The Pi service listens on **8088**.

---

## Install / update on the Pi

Raspberry Pi OS, Node >=18.18 (18.20.4 is fine). The service file is `Type=simple` and listens on **8088**.
8080 is left for the UniFi Network controller. 8081 is File Browser, 8000 is Companion, and 8090
is the speaker timer. Do not point this service at those.

The app's own default stays 8080, so `node server.js` on a Mac is unchanged. The unit passes
`--port 8088`.

Per-Pi settings do not belong in the unit file. Copying the unit overwrites local edits. Put
them in a drop-in: `sudo systemctl edit control-center`.

`npm ci` reads `package-lock.json` and installs `@elgato-stream-deck/node` and `node-hid`. It deletes `node_modules` first. If that folder is owned by root, npm warns `EACCES` `rmdir` `/opt/control-center/...` and the Stream Deck package never appears (`added 2 packages` is that failure). The warning is the install not finishing. Give the folder to `pi` and delete `node_modules` before `npm ci`.

If `npm ci` cannot download a node-hid prebuild, install the compiler first: `sudo apt-get install -y build-essential libudev-dev`. A warning about `@julusian/jpeg-turbo` wanting Node 22 is optional. Ignore it.

```bash
sudo git clone https://github.com/stevenmarr/Performance-Video-Control.git /opt/control-center
sudo mkdir -p /var/lib/control-center
sudo chown -R pi:pi /opt/control-center /var/lib/control-center
sudo rm -rf /opt/control-center/node_modules
sudo -u pi npm ci --omit=dev --prefix /opt/control-center
sudo -u pi node -e "require('@elgato-stream-deck/node')"
sudo cp /opt/control-center/tools/udev/50-control-center-streamdeck.rules /etc/udev/rules.d/99-control-center-streamdeck.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
sudo cp /opt/control-center/tools/systemd/control-center.service /etc/systemd/system/control-center.service
sudo systemctl daemon-reload
sudo systemctl enable --now control-center
```

Unplug the Stream Decks and plug them back in after the udev rule is installed. Open **http://<the-pi>:8088**.

The rule matches Elgato vendor `0fd9`, mode `0660`, group `plugdev`, plus `uaccess`. It is installed as `99-` so it runs after Companion's `50-` rule. Companion's rule sets group `companion`. That is why `ls -l /dev/hidraw*` shows `crw-rw----+ root companion`. The `+` is an ACL for the person logged in on the console. A systemd service does not get that ACL. After this rule and a replug, the group should be `plugdev`. The unit has `SupplementaryGroups=plugdev`, so user `pi` can open the node without being added to the group by hand.

`usermod -aG` only affects processes started afterwards. A service that is already running keeps its old groups until `sudo systemctl restart control-center`.

If `ls` still shows group `companion`, Companion's rule locked the group (`GROUP:=`). Add the group for this service and restart:

```bash
sudo systemctl edit control-center
```

```ini
[Service]
SupplementaryGroups=plugdev companion
```

The `companion` group has to exist. If it does not, systemd fails the start with status 217/USER. Do not list a group that `getent group` cannot find.

Update. `git checkout` throws away a local `npm install` that changed `package.json` or `package-lock.json`. `npm ci` installs from the lock, so those two files have to be the ones from git.

```bash
cd /opt/control-center
git checkout -- package.json package-lock.json
git pull
sudo rm -rf /opt/control-center/node_modules
sudo chown -R pi:pi /opt/control-center
sudo -u pi npm ci --omit=dev --prefix /opt/control-center
sudo -u pi node -e "require('@elgato-stream-deck/node')"
sudo cp tools/udev/50-control-center-streamdeck.rules /etc/udev/rules.d/99-control-center-streamdeck.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
sudo cp tools/systemd/control-center.service /etc/systemd/system/control-center.service
sudo systemctl daemon-reload
sudo systemctl restart control-center
```

That `cp` replaces the unit. Anything you changed in the unit file is gone. The drop-in is kept.

Then unplug and replug the decks. Check the log and the one-shot diagnostic:

```bash
journalctl -u control-center -n 80 --no-pager
node /opt/control-center/tools/deck-diag.js
sudo node /opt/control-center/tools/deck-diag.js
curl -s http://127.0.0.1:8088/api/surfaces/diag
```

`require('@elgato-stream-deck/node')` with no output means the library loaded. `found N decks` and `opened serial …` mean Control Center has the device. `cannot open …: EACCES` is permissions (the udev rule and a service restart). `cannot open …: busy` is another program still holding it. `sudo` on the diagnostic sees holders that user `pi` is not allowed to see. `HID library: MISSING` is followed by the real `require()` error (`MODULE_NOT_FOUND` means `node_modules/@elgato-stream-deck/node` is not there).

```bash
sudo systemctl edit control-center
```

```ini
[Service]
Environment=CC_HOST_POWER=1
Environment=CC_SERVICE_CONTROL=1
```

`CC_HOST_POWER=1` lets the console's two-press shutdown and reboot call `systemctl`.
`CC_SERVICE_CONTROL=1` lets the console start and stop the speaker-timer, SMB, and Companion units.
`CC_DECK_USB=0` does not open Stream Decks. Use it if the deck worker keeps dying and the show
has to stay up without the keys. Leave the power and service lines unset until you want them.

```ini
[Service]
Environment=CC_DECK_USB=0
```

The watchdog is off. Node cannot open systemd's notify socket (`dgram` is UDP only, and
`unix_dgram` throws). A `Type=notify` unit waits for `READY=1` and then fails the start with
"a timeout was exceeded" when that datagram never arrives. The process sends `READY=1` and
`WATCHDOG=1` through `systemd-notify`, which is a child, so it only counts if you opt in:

```ini
[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
```

`NotifyAccess=main` ignores the child. Leave the watchdog out unless you have checked
`systemctl status control-center` and seen the service reach `active (running)`.

---

## Tests

```bash
node --test test/*.test.js
```

Playwright UI tests skip when Playwright is not installed. They start `server.js --mock` on
127.0.0.1. That is the test path, not the desk.

The DeckLink helper is source only on Linux. `make` in `tools/native/decklink-recv` fails there
on purpose. CI checks the host gate, the missing-binary message, and a fixture push. It does not
link the DeckLink SDK, and the SDK is not in git.
