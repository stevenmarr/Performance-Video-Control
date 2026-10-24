# TSL tally (0.20.0-dev)

TSL is its own setup. It is **not** part of Lightning (NDI ingest → scopes).

Control Center is a **TSL 5.0 UDP sender**. It maps switcher **PGM → red** and **PVW → green** onto
addresses stored with the show file (and in `<dataDir>/tsl.json` while you edit).

## First slice (this build)

| Piece | Behaviour |
|---|---|
| Protocol | **TSL 5.0** only (not 3.1 yet) |
| Transport | **`mock`** (in-memory packet log) or **`udp`** to **loopback only** (`127.0.0.1` / `::1`) |
| Default port | **8900** (configurable 1–65535) |
| Colour | LH = PGM red (`1`), RH = PVW green (`2`), brightness 3, ASCII labels |
| Source of truth (now) | **ATEM** M/E 1 program / preview input ids |
| Optional | **Follow PTZ lamps**: cameras listed on a map row get red/green CGI from the same map (other cameras keep their own TLR path) |
| UI | **⌂ SYSTEMS → TALLIES** (the DESK \| TALLIES switch). Not a Lightning control. |
| API | `GET/POST /api/tsl`, `POST /api/tsl/tick` |

LAN UDP to a real UMD / Tally Arbiter is **not enabled** yet (public-repo safety). Enable later behind an
explicit operator choice after loopback proving.

## Address map

Each row:

- **index** — TSL display INDEX (0–65534)
- **label** — up to 16 ASCII characters (UMD text)
- **ATEM IN** — switcher input id (same numbers as the SWITCHER bus)
- **PTZ CAM** — optional `cameraId` (e.g. `cam1`) when Follow PTZ lamps is on

A show file may carry a top-level `tsl` object (same shape as the API config). Older apps ignore it.

## Mock / tests

`--mock` forces the mock transport. Unit tests assert packet bytes and PGM/PVW mapping without opening
sockets to real devices. Never point the public repo at a show IP (e.g. `192.168.21.125`).

## Open questions

1. Keep default port **8900**, or prefer another fleet default (9100, etc.)?
2. ATEM-only first (current), or also RS6 / E2 / PixelHue sources in the same table next?
3. Should Follow PTZ be on by default for shows that already use camera TLR elsewhere?
