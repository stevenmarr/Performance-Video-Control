# Video scopes / Lightning (0.13.0-dev)

Waveform, RGB parade, vectorscope and false colour from a camera's **H.264 stream**. The picture is not
re-encoded on the way; the browser decodes it and the scopes are drawn on the GPU (WebGL2) from the decoded
Y′CbCr values.

Open it from the top-level **LIGHTNING** tab (engineering scopes), from **PTZ → SCOPES** (same experience),
or on its own page at **`/lightning.html`** / **`/scopes.html`**. The page also works in a separate window
(the **⤢ WINDOW** button).

**Lightning** means this engineering scopes surface — not stage lighting and not NewTek CG.

## Publishing over NDI (Mac path; no NDI SDK on the Pi)

The Pi app does **not** ship an NDI SDK or npm native deps. To get scopes onto an NDI multiviewer:

1. On a show Mac, open `/lightning.html` (or `/scopes.html`) **full screen**.
2. Publish that window with **OBS + DistroAV** (formerly OBS-NDI) or **NDI Tools** Scan Converter.
3. Prefer **one composite** NDI source first (picture + scopes together).

In the Lightning tab, **NDI HELP** shows the same recipe. A “Mac sidecar” toggle is a placeholder for a
future optional helper — it does not publish anything yet.

```
camera RTSP (TCP interleaved RTP, H.264)  ─┐
test file (.h264 Annex-B / .mp4 / .mov)  ──┼─► lib/stream-relay.js ──WebSocket /api/scopes/ws──► browser
mock UE150 RTSP camera (--mock)          ─┘   (access units, no transcoding)      │
                                                                                  ├─ WebCodecs VideoDecoder → I420 planes (exact Y′)
                                                                                  ├─ or MSE <video> (fMP4 muxed in the page) → RGB
                                                                                  └─ WebGL2: analyse → waveform / parade / vectorscope / false colour
```

## Using it

| Control | What it does |
|---|---|
| SOURCE | A camera (`cam:<id>`), a built-in test clip, a clip in the test folder, or the custom input |
| PIC / WFM / PARADE / VEC | Choose which panels to show; they lay out side by side. Double-click a panel to show it alone. |
| NORMAL / FALSE / ZEBRA | Picture mode. ZEBRA uses the level next to it (%). |
| RANGE | AUTO uses the stream's VUI `video_full_range_flag`. LEGAL is 16–235 = 0–100 %; FULL is 0–255 = 0–100 %. |
| INTENSITY | Trace brightness. |
| VEC ×1 / ×2 / ×5 | Vectorscope gain. |
| DECODE | AUTO, WEBCODECS, MSE, or JPEG (camera snapshots; picture only). |
| ⚙ INPUTS | Per-camera stream number, path, port and login; the test folder; and a custom file path or `rtsp://` URL. |

The status bar shows the decode path, codec/size/fps, displayed FPS, glass-to-glass **LATENCY** (server
receive → drawn), DECODE and DRAW time per frame, kb/s, range, DETAIL (analysis width), and skipped frames.

**DETAIL** is the analysis resolution (640 → 160 columns). It drops on its own when the GPU can't keep up,
so the scopes stay real time. The latency guard resets the decoder at the next key frame if output falls
more than 400 ms behind.

**False colour (ARRI style; % of the legal or full range)**

| Colour | Level |
|---|---|
| Purple | below 2.5 % |
| Blue | 2.5–4 % |
| Green | 38–42 % (18 % grey) |
| Pink | 52–56 % (skin, one stop over) |
| Yellow | 97–99 % |
| Red | 99 % and above (clipping) |
| Grey | everything else |

The legend is shown in the toolbar.

**Vectorscope**: BT.709 75 % (□) and 100 % (○) targets, plus the skin line at 123°.

## Cameras (Panasonic AW-UE150 class)

- **URL.** The relay first asks the camera for its request URI (`/cgi-bin/get_rtsp`, `h264_rtsp_req_uriN`).
  If that doesn't answer, it uses `rtsp://<camera>[:port]/MediaInput/h264/stream_N`. The spec's §12.1 example
  is lower case (`/mediainput/h264/stream_N`).
  - The default is stream 1. **Stream 2 is recommended**, so stream 1 stays as configured for anything else.
  - You can set the stream, port and an explicit path for each camera in ⚙ INPUTS.
- **Transport.** RTSP over TCP (RTP interleaved on the RTSP connection), the spec's "TCP Unicast" mode.
  - In the camera's web menu, set H.264(N) *Transmission type* to **Unicast (AUTO)** and *H.264 transmission*
    to ON. Otherwise the camera answers SETUP with 503.
  - Audio is ignored.
  - Keep-alive is GET_PARAMETER; the camera's timeout is 120 s.
- **Login.** Sent only when the camera asks (Digest or Basic).
  - With *User auth.* OFF (factory setting), live video needs no login.
  - The login used is, in order: the camera's own login from the PTZ CAMERAS tab (LOGIN, 0.11.1) when one is set,
    then the one set in ⚙ INPUTS, then the factory default `admin` / `12345`. CGI control and the RTSP stream then
    use the same account. ⚙ INPUTS shows "camera login (CAMERAS tab)" for those cameras instead of the fields.
  - The login is read again on every reconnect, so fixing it on the CAMERAS tab heals a rejected stream on the
    next retry (about 15 s after a refusal) without reopening the SCOPES tab.
  - Passwords are saved in the data folder (`scopes.json`) and the API never returns them.
- **Other cameras.** HE130/HE40-class cameras have no RTSP H.264; for them JPEG mode shows snapshots only.
  Any other RTSP H.264 source can be used through the custom input (`rtsp://user:pass@host/path`, or a
  separate user/password).

**Not yet verified on a real camera:**

- whether stream N needs a login when User auth. is ON;
- how many simultaneous RTSP clients each stream allows;
- the real SDP and control URLs (the relay handles absolute, relative and `*` controls);
- whether the camera signals video range in the VUI (if not, AUTO assumes legal; use the RANGE switch);
- GOP length (the first picture waits for a key frame; set the camera's I-frame interval to 1 s or less);
- encoder latency;
- a stream set to H.265 is reported as "H.265 not supported", which is untested on hardware.

## Browsers

| Browser | Exact path (WebCodecs) | Fallback (MSE) |
|---|---|---|
| Chrome / Edge 94+ (Mac, Windows, Linux) | ✔ Tested headless (Chromium) | ✔ Tested |
| Firefox 130+ | ✔ Tested headless (Linux build). Firefox hands back RGB frames, not Y′CbCr, so the scopes use the RGB path. | ✔ |
| Safari 16.4+ (Mac), Safari on iPad (iPadOS 16.4+) | Expected ✔ (not tested) | ✔ (ManagedMediaSource on iPhone) |

**WebCodecs needs a secure context**: `https://`, or `http://localhost`. A tablet or laptop opening
`http://<pi-address>:<port>` does **not** get WebCodecs and falls back to MSE automatically. MSE is still
H.264 without transcoding, but:

- it goes through RGB, so it is ~1 code value less exact and loses below-black and above-white;
- latency is higher (~0.25 s).

For the exact path on other machines:

- **HTTPS mirror** (built in): start the app with
  `RS6_TLS_CERT=/path/cert.pem RS6_TLS_KEY=/path/key.pem [RS6_TLS_PORT=8443]`, then open
  `https://<pi-address>:8443/`. A self-signed certificate works once it is accepted or trusted on each device:
  ```
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout key.pem -out cert.pem -subj "/CN=rs6" \
    -addext "subjectAltName=IP:<pi-address>"
  ```
- or in Chrome, `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the app's address.

## Test video Steven can supply

- **Codec:** H.264 / AVC, **not H.265**. Use High, Main or Baseline profile, 8-bit 4:2:0. **No B-frames is
  best** (lower latency); B-frames still decode.
- **Container:** a raw Annex-B elementary stream (`.h264` / `.264`), or a normal (non-fragmented)
  `.mp4` / `.mov` / `.m4v`. The first video track is used and audio is ignored.
- Any resolution up to 1080p60. **A key frame at least every 1–2 s** makes the scopes start quickly.
- Ideally a camera recording (UE150 SD card/stream capture) of a chart, skin tones and a highlight clip.
- **To use it:** drop it in the test folder (default `../scopes-test`, or `RS6_SCOPES_TEST_DIR`, or set it in
  ⚙ INPUTS), or put its full path in the **custom input**. It plays looped at its own frame rate.
- **Remux without re-encoding:**
  ```
  ffmpeg -i in.mov -an -c:v copy -bsf:v h264_mp4toannexb out.h264
  ```
- **Convert H.265/ProRes:**
  ```
  ffmpeg -i in.mov -an -c:v libx264 -profile:v high -pix_fmt yuv420p -bf 0 -g 30 -color_range tv -colorspace bt709 out.h264
  ```

`tools/scopes-testgen.js` (needs ffmpeg on the dev machine, never on the Pi) makes the bars, ramps (legal and
full) and moving `testsrc2` clips, plus raw frames, into `../scopes-test`. Small copies used by the tests are
in `test/fixtures/scopes`.

## Performance (measured on the dev box: Xeon, headless Chromium, **software GL** = worst case)

**Relay, % of one CPU core:**

| Input | CPU |
|---|---|
| Idle | 0 |
| 1080p59.94 file → 1 viewer | 2.2 |
| 720p30 6 Mb/s file → 1 viewer | 0.8 |
| Mock RTSP camera 720p30 → 1 viewer | 3.0 |
| Mock RTSP camera → 4 viewers | 3.0 |

**Browser:**

- **Decode** (WebCodecs, software): 720p 2.4 ms/frame; 1080p bars 0.6 ms (+0.2–0.3 ms to copy planes).
- **Live end to end** at DETAIL 160 on software GL:
  - 720p moving: 30 fps, 45 ms latency (p90 48 ms);
  - mock RTSP camera 720p30: 30 fps, 31 ms (p90 33 ms);
  - 1080p60 bars: 34 fps shown, 0.35 s latency. The software GL can't present 60 fps, so frames queue; a real
    GPU shouldn't have this problem.
- **GL draw**, all scopes, software GL:

  | Analysis width | All | Waveform | Parade | Vectorscope |
  |---|---|---|---|---|
  | 640 | 119 ms | 37 ms | 51 ms | 42 ms |
  | 320 | 41 ms | – | – | – |
  | 160 | 19 ms | – | – | – |

  Real GPUs (Mac, iPad) are expected to manage 640 easily; this is not yet measured. DETAIL adapts on its own.

## Protocol (for other clients)

**Opening a session.** `GET /api/scopes/sources` lists the sources. `WS /api/scopes/ws?src=<key>` opens a
session.

**Text frames (JSON):**

- `config` `{codec, description (base64 avcC), width, height, codedWidth, codedHeight, fps, fullRange, colour, profile, level, label, kind}`
  — sent again when the SPS changes.
- `status` `{state: connecting|playing|error, error, auth}`.
- `pong` — answers the client's `{type:'ping', t}`.

**Binary frames:** one access unit each, with a 20-byte header followed by the AVCC (length-prefixed) NAL
units. AUD/SPS/PPS/filler are already removed (they are in `description`).

| Bytes | Field |
|---|---|
| 0 | `1` |
| 1 | flags: 1 = key frame, 2 = catch-up (decode, don't draw), 4 = replayed |
| 2–3 | reserved |
| 4–11 | server receive time in ms (f64, little-endian) |
| 12–19 | pts in µs (f64, little-endian) |

**Relay behaviour:**

- A late viewer gets the current GOP replayed.
- A slow viewer skips to the next key frame.
- An input stops 3 s after its last viewer leaves.

## Tests and tools

```
node --test test/scopes-relay.test.js                                    # 12 tests: NAL/SPS/AU, avcC, MP4, RTP, RTSP + mock camera, relay, service
NODE_PATH=/path/to/node_modules node --test test/ui-scopes.test.js       # Playwright (Chromium): decoded bars/ramps, raw-frame maths, MSE, HTTPS, PTZ tab
node tools/scopes-testgen.js [outdir]                                    # test clips (ffmpeg)
NODE_PATH=... node tools/scopes-bench.js [dir]                           # relay CPU + browser decode / draw numbers
NODE_PATH=... node tools/scopes-shots.js                                 # screenshots
node server.js --mock                                                    # mock UE150 RTSP camera on 127.0.0.1 cameras
```

**Files:**

| Part | Files |
|---|---|
| Server | `lib/scopes/{h264,rtp,rtsp-client,sources,ws,service}.js`, `lib/stream-relay.js`, `lib/mocks/rtsp-camera.js` |
| Browser | `public/scopes.{html,js}`, `public/scopes-gl.js`, `public/scopes-mse.js`, `public/scopes-tab.js` |
