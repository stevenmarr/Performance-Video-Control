# Video scopes

Waveform, RGB parade, vectorscope, Lightning, Diamond and false colour from an **H.264** feed.
The picture is not re-encoded on the way. The browser decodes it and the scopes are drawn on the GPU
(WebGL2) from the decoded Y′CbCr values.

This is a standalone app in `apps/scopes`. It is not a Control Center tab. Control Center does not
serve `/scopes.html`, `/lightning.html`, or `/api/scopes`. Open **http://127.0.0.1:8092** (or
`/scopes.html`, `/lightning`, `/lightning.html` on that same port). There is no Pi relay.

**Lightning** is one mode in the scope strip: luminance (Y) vertical, B−Y on the left half and R−Y
on the right half. It is not stage lighting and not a separate app. TSL tallies stay on the Control
Center ATEM page.

## Desktop Video

Live scopes come from a **Blackmagic Desktop Video** input on this Mac. The INPUT menu lists devices
from `decklink-recv --list`. You cannot type a new source in. If the helper or the driver is missing,
the empty Desktop Video row shows that error. It does not invent a device.

```
cd apps/scopes
npm run build
node server.js
node tools/decklink-sidecar.js --list
node tools/decklink-sidecar.js --device 0 --app http://127.0.0.1:8092
```

Details: [decklink-ingest.md](decklink-ingest.md). Legacy NDI: [ndi-ingest.md](ndi-ingest.md).

## Using it

| Control | What it does |
|---|---|
| INPUT | Grouped menu: Desktop Video, cameras, test clips, and legacy NDI only when a sidecar is pushing. You cannot type a new source in. |
| PIC / WFM / PARADE / VEC / DIAMOND | The default layout shows all five. Diamond is G vs B on top and G vs R below. |
| NORMAL / FALSE / ZEBRA | Picture mode. ZEBRA uses the level next to it (%). |
| RANGE | AUTO uses the stream's VUI `video_full_range_flag`. LEGAL is 16–235. FULL is 0–255. |
| INTENSITY | Trace brightness. |
| VEC ×1 / ×2 / ×5 | Vectorscope and Lightning gain. |
| DECODE | AUTO, WEBCODECS, MSE, or JPEG (camera snapshots from this app, not Control Center). |
| ⚙ INPUTS | Add, edit, or remove cameras (name, host, stream, path, ports, login). Optional import from a Control Center URL. Test folder and a custom file on this Mac or an `rtsp://` URL. |
| ⤢ WINDOW | Opens `/scopes.html` on this app. |

**False colour (ARRI style; % of the legal or full range):** purple below 2.5 %, blue 2.5–4 %,
green 38–42 %, pink 52–56 %, yellow 97–99 %, red 99 % and above, grey otherwise.

**Vectorscope**: BT.709 75 % and 100 % targets, plus the skin line at 123°.

**Lightning**: the same bars as a component vectorscope. Positive B−Y goes left of the left Y axis.
Positive R−Y goes right of the right Y axis.

## Cameras

Cameras live in this app's `scopes.json`. Control Center does not have to be running.

- **URL.** `rtsp://<host>[:port]/MediaInput/h264/stream_N`, or the path you set. If no path is set,
  the app asks the camera (`/cgi-bin/get_rtsp`) itself.
- **Login.** Stored per camera. Empty login uses the factory default `admin` / `12345`. Passwords
  are never returned by the API.
- **JPEG.** `GET /api/scopes/cameras/:id/snapshot` fetches the camera's `/cgi-bin/camera?resolution=640`.
- **Import.** INPUTS can copy name, host, HTTP port, model and user from `GET /api/sys/views` on a
  Control Center URL. Passwords are not copied. After import, this app keeps the list with Control
  Center stopped.
- **Other series.** A non-UE150 model is JPEG only. UE150-class models (including AW-UE160) can do RTSP.

First start copies `scopes.json` from `~/Library/Application Support/RS6 Presets` into
`~/Library/Application Support/PVLLC Scopes` when the new folder is empty, and writes
`migrated-from.json`. It does not delete the old folder.

## Tests

```
cd apps/scopes
npm test
```
