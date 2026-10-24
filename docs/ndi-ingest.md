# Scopes NDI ingest (0.20.1)

**SCOPES** is the engineering tab. **Lightning** is a scope mode on that tab (Y / R−Y / B−Y), in the same
strip as waveform, parade, vectorscope and false colour. The operator picks an **NDI source** and those
modes run on that feed.

This is **ingest**. The app does not publish scopes as an NDI output. TSL tallies are a different setup
under **SYSTEMS → TALLIES** ([tsl-tally.md](tsl-tally.md)).

## Why a sidecar

Browsers cannot open NDI. A Raspberry Pi is the wrong host for NDI receive (CPU, and the app stays free
of an NDI SDK and of npm native addons). The Pi, or any host running Control Center, only relays
compressed H.264 the way it already relays a camera RTSP stream.

```
Mac sidecar                         Control Center                         browser
ndi-sidecar.js                      lib/scopes/ndi-ingest.js               public/scopes.js
  NDI receive (darwin only)  ─WS─►  Annex-B → access units                 WebCodecs / MSE
  or --mock fixture file            StreamRelay (same as RTSP)  ─WS─►     WebGL2 scopes
```

Source keys look like `ndi:mock-bars` or `ndi:cam-a`. Viewers use the existing
`WS /api/scopes/ws?src=ndi:<id>` endpoint. Nothing in that path decodes NDI.

## Try it without hardware

```
node server.js --mock
```

Open **SCOPES**. The sidecar / discovered NDI strip lists **NDI · MOCK BARS** and **NDI · MOCK RAMPS**
under **MOCK FIXTURES**. Pick one. The scopes page SOURCE list includes the same keys, in the mock group.
Those fixtures are in-process H.264 files. They do not use the NDI SDK, and they are how CI exercises the
picker and the relay. If the app was not started with `--mock`, that group says so and stays empty. You
cannot type a source name into the list.

To exercise the sidecar socket as well (still no NDI hardware):

```
node tools/ndi-sidecar.js --mock --app http://127.0.0.1:8080
```

That plays `test/fixtures/scopes/bars.h264` as a sidecar source named **SIDECAR BARS**. The id is
`sidecar-bars` unless you pass `--id`. Ids starting with `mock-` are reserved for the in-process fixtures.

## Try it with a real NDI source (Mac)

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

## Where ingest is accepted

`WS /api/scopes/ndi/ingest?id=<id>&name=<label>&fps=<n>` accepts the sidecar.

- Default: **loopback only** (`127.0.0.1` / `::1`). No show address is built in.
- `RS6_NDI_INGEST_LAN=1` on the app allows a sidecar on another machine to push H.264. The app still
  does not receive NDI; it only accepts the compressed stream. Set that yourself. Do not commit a show IP.

`GET /api/scopes/ndi` returns `{ receive: "sidecar", inProcess: false, pi, platform, ndiReceiveAllowed, ingest, sidecar, sources }`.

## What stays off the Pi

- No NDI SDK, no native npm addon, no ffmpeg spawned by `server.js`.
- `server.js` never starts the sidecar.
- `--ndi` exits with a host error on Linux and on a Pi. Use `--mock` there.
