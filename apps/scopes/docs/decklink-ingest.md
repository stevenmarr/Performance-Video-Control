# Desktop Video ingest (Scopes)

**Scopes** is a standalone app on the Mac (`apps/scopes`, port **8092**). **Lightning** is a scope mode
in that app (Y / R−Y / B−Y), in the same strip as waveform, parade, vectorscope and false colour.
Live video is a **Blackmagic Desktop Video** (DeckLink) input. Control Center does not serve this page.

This is **ingest**. The Scopes process lists devices with `decklink-recv --list` and can capture
in-process. The optional sidecar below pushes the same H.264 into `/api/scopes/ndi/ingest` on port 8092.
TSL tallies stay on the Control Center **ATEM** page. They are not part of this app.

## Why a helper

Browsers cannot open Desktop Video. The DeckLink SDK stays out of Node. `decklink-recv` is a small
Mac helper. The Scopes app starts it when you pick a device, or you can run the sidecar yourself.

```
Mac (apps/scopes)                         browser
decklink-recv (darwin only)               public/scopes.js
  Desktop Video input ─H.264─► apps/scopes/lib/ndi-ingest.js
                               StreamRelay  ─WS /api/scopes/ws─► WebCodecs / MSE / WebGL2
```

The helper writes Annex-B H.264 to stdout. A sidecar can push it to
`WS /api/scopes/ndi/ingest?id=&name=&fps=&kind=decklink` on this app. Viewers use
`WS /api/scopes/ws?src=ndi:<id>` or `src=decklink:<index>` for in-app capture. The row is labeled
**Desktop Video · name** and `via` is `decklink`.

## On a Mac

Install Blackmagic Desktop Video. The SDK stays at `~/deck-link-sdk/Blackmagic DeckLink SDK 16.0` and is not in this repo. Build the helper once, from `apps/scopes`:

```
npm run build
# or: make -C tools/native/decklink-recv
```

Then, with Scopes already running (`node server.js`, port 8092):

```
node tools/decklink-sidecar.js --list
node tools/decklink-sidecar.js --device 0 --app http://127.0.0.1:8092
```

`--list` prints one tab-separated line per device, in iterator order. `--device` is that index.
`--mode auto` (the default) asks the card to detect the input format, starting from 1080p59.94.
`--connection` is `auto`, `SDI`, or `HDMI`.

Open **http://127.0.0.1:8092**. The Desktop Video group lists the feed. If the helper or the driver
is missing, that empty row shows the error. The menu does not invent a device.

`make` on Linux or on a Pi stops immediately. `--device` exits with a host error (code 2) before it
looks for a binary, even if `SCOPES_DECKLINK_RECV` (or `RS6_DECKLINK_RECV`) is set. If the binary is
missing on a Mac, the sidecar prints where to build it and exits 1.

Override the helper with `SCOPES_DECKLINK_RECV=/absolute/path/to/decklink-recv`.

A DeckLink input can be open in only one process. If Replay, Playout, or Media Express already has
that input, capture fails. Stop the other user of the input, then start capture.

If `CreateDeckLinkIteratorInstance` returns null, install Blackmagic Desktop Video and allow the
driver in System Settings → Privacy & Security.

## Where ingest is accepted

Default: **loopback only** (`127.0.0.1` / `::1`). No show address is built in.

`SCOPES_NDI_INGEST_LAN=1` (or `RS6_NDI_INGEST_LAN=1`) on the Scopes app allows a sidecar on another
machine to push H.264. Set that yourself. Do not commit a show IP.

`GET /api/scopes/ndi` includes `decklinkReceiveAllowed`. A connected Desktop Video session is
`kind: "decklink"`.

## What this is not

- Not an NDI finder. Legacy NDI, if you still use it, is [ndi-ingest.md](ndi-ingest.md) and stays
  hidden in the picker until a sidecar is pushing.
- Not Control Center. `--app` is this Scopes process (`http://127.0.0.1:8092`), not port 8080.
- Not `node server.js --mock`. That flag starts a mock RTSP camera for tests. It does not add a
  Desktop Video device.
- The sidecar's own `--mock` flag pushes a fixture file over the same socket for tests. It is not
  labeled Desktop Video, and it is not a device in the menu by itself.