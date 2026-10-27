# Desktop Video ingest (Scopes)

**SCOPES** is the engineering tab. **Lightning** is a scope mode on that tab (Y / R−Y / B−Y), in the same
strip as waveform, parade, vectorscope and false colour. Live video for that tab is a **Blackmagic
Desktop Video** (DeckLink) input.

This is **ingest**. The app does not publish scopes, and it does not open a DeckLink device. TSL tallies
are on the **ATEM** page ([tsl-tally.md](tsl-tally.md)), not on this list.

## Why a sidecar

Browsers cannot open Desktop Video. A Raspberry Pi is the wrong host for DeckLink capture, and the app
stays free of the DeckLink SDK. The machine running Control Center only relays compressed H.264, the
same way it already relays a camera RTSP stream.

```
Mac sidecar                         Control Center                         browser
decklink-sidecar.js                 lib/scopes/ndi-ingest.js               public/scopes.js
  decklink-recv (darwin only) ─WS─► Annex-B → access units                 WebCodecs / MSE
  Desktop Video input               StreamRelay (same as RTSP)  ─WS─►     WebGL2 scopes
```

The helper writes Annex-B H.264 to stdout. The sidecar pushes it to
`WS /api/scopes/ndi/ingest?id=&name=&fps=&kind=decklink`. Viewers use the existing
`WS /api/scopes/ws?src=ndi:<id>` endpoint. The key still starts with `ndi:` because it is the same
relay. The row is labeled **Desktop Video · name** and `via` is `decklink`.

## On a Mac

Install Blackmagic Desktop Video. The SDK stays at `~/deck-link-sdk/Blackmagic DeckLink SDK 16.0` and is not in this repo. Build the helper once:

```
cd tools/native/decklink-recv
make
```

Then, with Control Center already running:

```
node tools/decklink-sidecar.js --list
node tools/decklink-sidecar.js --device 0 --app http://127.0.0.1:8080
```

`--list` prints one tab-separated line per device, in iterator order. `--device` is that index.
`--mode auto` (the default) asks the card to detect the input format, starting from 1080p59.94.
`--connection` is `auto`, `SDI`, or `HDMI`.

Open **SCOPES**. The Desktop Video group lists the feed while the sidecar is connected. The menu
does not create a device, and it does not keep a row after the sidecar disconnects.

`make` on Linux or on a Pi stops immediately. `--device` exits with a host error (code 2) before it
looks for a binary, even if `RS6_DECKLINK_RECV` is set. If the binary is missing on a Mac, the
sidecar prints where to build it and exits 1.

Override the helper with `RS6_DECKLINK_RECV=/absolute/path/to/decklink-recv`.

A DeckLink input can be open in only one process. If Playout (or another app) already has that input,
capture fails. Stop the other user of the input, then start the sidecar.

## Where ingest is accepted

Default: **loopback only** (`127.0.0.1` / `::1`). No show address is built in.

`RS6_NDI_INGEST_LAN=1` on the app allows a sidecar on another machine to push H.264. The app still
does not capture DeckLink. Set that yourself. Do not commit a show IP.

`GET /api/scopes/ndi` includes `decklinkReceiveAllowed`. A connected Desktop Video session is
`kind: "decklink"`.

## What this is not

- Not an NDI finder. Legacy NDI, if you still use it, is [ndi-ingest.md](ndi-ingest.md) and stays
  hidden in the picker until a sidecar is pushing.
- Not `node server.js --mock`. That flag starts simulators for tests. It does not add scope sources
  and it is not how you get a live picture.
- The sidecar's own `--mock` flag pushes a fixture file over the same socket for tests. It is not
  labeled Desktop Video, and it is not a device in the menu by itself.
