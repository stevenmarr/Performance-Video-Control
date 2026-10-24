# Legacy NDI ingest (optional)

Live scopes are **Desktop Video**. See [decklink-ingest.md](decklink-ingest.md). This page is the
older NDI sidecar, kept for a Mac that already receives NDI and pushes H.264 into the same relay.

The app does not discover NDI, does not link an NDI SDK, and does not invent a source name. The
**NDI (advanced)** group is hidden until a sidecar is actually connected. There is no mock-fixture
group in the picker. TSL tallies are on the ATEM page ([tsl-tally.md](tsl-tally.md)).

```
Mac sidecar                         Control Center                         browser
ndi-sidecar.js                      lib/scopes/ndi-ingest.js               public/scopes.js
  NDI receive (darwin only)  ─WS─►  Annex-B → access units                 WebCodecs / MSE
                                    StreamRelay (same as RTSP)  ─WS─►     WebGL2 scopes
```

Source keys look like `ndi:cam-a`. Viewers use `WS /api/scopes/ws?src=ndi:<id>`.

## A real NDI source (Mac)

On a Mac, with ffmpeg built against the NDI SDK (`libndi_newtek`):

```
node tools/ndi-sidecar.js --list
node tools/ndi-sidecar.js --ndi "SOURCE NAME" --app http://127.0.0.1:8080
```

`--ndi` and `--list` refuse to run unless the process is macOS, and they refuse if the machine looks
like a Raspberry Pi. Full-bandwidth NDI is not H.264, so the default ffmpeg line encodes
ultrafast H.264 (no B-frames, a short GOP) and the app relays those access units.

If you already have a receiver that writes Annex-B H.264 to stdout:

```
RS6_NDI_RECV=/path/to/helper node tools/ndi-sidecar.js --ndi "SOURCE NAME" --app http://127.0.0.1:8080
```

The helper is executed directly (no shell) with the source name as its only argument.
`RS6_NDI_FFMPEG` overrides the ffmpeg binary.

## Tests only

`node tools/ndi-sidecar.js --mock` pushes a fixture file into the relay while that process is
connected. It is not a Desktop Video input, and the app does not list it until the socket is up.
Ids starting with `mock-` are reserved and rejected. `node server.js --mock` does **not** add NDI
sources. Do not start the desk that way to get a picture on SCOPES.

## Where ingest is accepted

`WS /api/scopes/ndi/ingest?id=<id>&name=<label>&fps=<n>` accepts the sidecar. A Desktop Video
sidecar adds `kind=decklink` on that same URL.

- Default: **loopback only** (`127.0.0.1` / `::1`). No show address is built in.
- `RS6_NDI_INGEST_LAN=1` on the app allows a sidecar on another machine to push H.264. The app still
  does not receive NDI. Set that yourself. Do not commit a show IP.

`GET /api/scopes/ndi` returns `{ receive: "sidecar", inProcess: false, pi, platform, ndiReceiveAllowed, decklinkReceiveAllowed, ingest, sidecar, sources }`.

## What stays off the Pi

- No NDI SDK, no DeckLink SDK, no native npm addon, no ffmpeg spawned by `server.js`.
- `server.js` never starts a sidecar.
- `--ndi` exits with a host error on Linux and on a Pi. Desktop Video capture is the same: macOS only.
