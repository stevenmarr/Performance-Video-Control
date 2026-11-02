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

No dependencies and no build step for the app. Node.js 16 or later. The Stream Deck plugin is a
separate package and needs Node.js 24.

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

You do not need `npm install` for the app.

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

**⌂ SYSTEMS** is the home page. Cards are split into **ON THE DESK** and **AVAILABLE**.

- **ADD TO DESK** puts that system on the desk. Its tabs appear. The address is unchanged.
- **OPEN** goes to that system's pages (SWITCHER, PTZ CONTROL, PRESETS, …).
- **CONFIGURE** is the connection: IP, port, protocol. The summary on the card shows the address.
- **REMOVE FROM DESK** takes it off. A simulator goes away; a saved address comes back.
- **ADD TO DESK AS SIMULATOR** runs a built-in fixture on 127.0.0.1. It is not written into the show.

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

**ATEM → LAYOUT** has three tabs. **M/Es** shows every mix effect at once (four in quadrants, two side by side, one filling the frame) and lists upstream keys and downstream keys on the right. **SUPERSOURCE** does the same for each SuperSource's boxes. **MULTIVIEW** assigns layout, program/preview swap, window sources, safe area, and VU. Drag a resource onto its own canvas to place it; it goes on air only while **LIVE** is on. Properties for the selection are on the left. Right-click to delete.

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

On a Pi, copy `tools/udev/50-elgato-stream-deck.rules` to `/etc/udev/rules.d/`,
reload udev, and replug the deck. The USB driver needs Node 18 or newer:

```bash
npm install
```

`@elgato-stream-deck/node` is optional. Without it, Control Devices still opens
and Scan explains that the driver is missing.

The older plugin on port 9721 is documented in [docs/decks.md](docs/decks.md). It is not required.

---

## Install on a Mac

1. Install Node.js 16 or later from <https://nodejs.org> (the LTS `.pkg`), or `brew install node`.
2. `node -v` should print v16 or later.
3. From this folder:

```bash
node server.js
```

Open **http://localhost:8080**. Put the systems you need on the desk, then **CONFIGURE** each
address and **SAVE & CONNECT**.

For the Stream Deck plugin, use the steps above (Node.js 24, inside `streamdeck/`). For live
scopes, build `tools/native/decklink-recv` on the Mac that has Desktop Video, then run
`tools/decklink-sidecar.js`.

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
