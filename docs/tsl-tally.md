# TSL tally

TSL is a function of the **ATEM** page. It is not a SYSTEMS home, and it is not part of Scopes.
Lightning is a scope mode on the SCOPES tab.

Control Center is a **TSL 5.0 UDP sender**. On the ATEM switcher page, map ATEM inputs to a receiver
address: **PGM → red**, **PVW → green**. The map is stored with the show file and in `<dataDir>/tsl.json`
while you edit.

## What you set

| Piece | Behaviour |
|---|---|
| Protocol | **TSL 5.0** (not 3.1) |
| Where | **ATEM → TSL TALLY**, under the switcher buses |
| Transport | **`mock`** (packet log) or **`udp`** to the host and port on that page |
| Default port | **8900** (configurable 1–65535) |
| Colour | LH = PGM red (`1`), RH = PVW green (`2`), brightness 3, ASCII labels |
| Source of truth | **ATEM** M/E 1 program / preview input ids |
| Optional | **Follow PTZ lamps**: cameras listed on a map row get red/green CGI from the same map |
| API | `GET/POST /api/tsl`, `POST /api/tsl/tick` |

On a live desk, UDP sends to the IP and port you type. A simulator session (`node server.js --mock`,
or a connection override used by tests) refuses any UDP target that is not loopback
(`127.0.0.1` / `::1` / `localhost`). Do not put a show IP in the repo.

## Address map

Each row:

- **index** — TSL display INDEX (0–65534)
- **label** — up to 16 ASCII characters (UMD text)
- **ATEM IN** — switcher input id (same numbers as the SWITCHER bus)
- **PTZ CAM** — optional `cameraId` (for example `cam1`) when Follow PTZ lamps is on

A show file may carry a top-level `tsl` object (same shape as the API config). Older apps ignore it.

## Tests

Unit tests assert packet bytes and PGM/PVW mapping without opening sockets to a show network.
`--mock` forces the mock transport for that process.
