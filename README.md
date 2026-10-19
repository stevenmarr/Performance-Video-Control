# RS6 Presets

Barco E2-style preset save and recall for an **Analog Way Aquilon RS6** (firmware 6.2.x), in a
browser. It runs on your Mac and serves a dark, touch-friendly UI that an iPad or phone on the same
network can open.

- **Destinations are toggles.** A preset stores only the destinations that were lit when you saved it.
- **Recall loads to Preview on those destinations only**, and the app's destination selection
  changes to match. What's selected on the RC400T doesn't matter, because every load names its
  screen explicitly.
- **TAKE and CUT act only on the lit destinations.** After a recall, those are the preset's destinations.
- **Numbered and named grid with tally.** Green **PVW** marks the preset on Preview, red **PGM** marks
  the preset on Program, and a dashed tag means only some of the preset's destinations match. The last
  recalled preset is shown in the header and outlined in the grid.
- **Update / Overwrite / Rename / Renumber / Duplicate / Delete**, plus an **Auto take on recall** toggle.
- A **settings page**, a **log panel**, a **mock device mode** and an **HTTP API** for Bitfocus
  Companion (a module ships separately in `companion-module-rs6-presets`).

No dependencies, no build step. You need Node.js 18 or later.

---

## How it works (and why)

I read the *AWJ Protocol Programmer's Guide v6.2*, the *REST API Programmer's Guide* (the "v6.0"
file, internally v4.01) and the *User Manual v6.2* to decide between the two approaches in the brief:

| Option | What the docs allow | Verdict |
|---|---|---|
| **(a) Snapshot the whole layer state and write it back** | The only documented reads are layer **source** (REST p.15, AWJ p.11), layer **status** (REST p.15), and **background set** (REST p.17, AWJ p.14). **Position, size, opacity, crop, borders, keying parameters and transitions have no documented read or write.** | Can't reproduce a look. Sources only. |
| **(b) Native Master memories filtered to the chosen screens** | Master memories can be **loaded** (REST p.13, AWJ p.10). **Neither guide documents a save**, for Master or Screen memories. Filtered Master saves exist only in the Web RCS UI (Manual §15.2.1). | Can't be created from the API. |

So the app uses a **hybrid**, as the brief suggested for this case:

1. **Primary: per-destination Screen memories.** Each app preset stores
   `{ destination → Screen memory slot }`, for example `{ S1: 20, S2: 21, A1: 40 }`. Recall sends one
   explicit, documented load per destination: REST `POST /screens/{id}/load-memory` or
   `/auxiliary-screens/{id}/load-memory` with `target: "preview"`. The device's own memory restores
   the full look (positions, sizes, keys and so on), and only the named screens change.
2. **Slot detection when you save.** If AWJ is reachable, the app reads each destination's TBAR side
   (AWJ p.13) and then the **last Screen memory loaded to its Preview** (AWJ p.16), and pre-fills the
   slot. You can always type or correct slots yourself, in the Save dialog or later in EDIT.
3. **Fallback: source snapshot (a reduced form of approach a).** When you save, the app also reads
   each destination's Preview layer sources and background set over REST. If a destination has no
   memory slot, recall writes those sources back (REST p.16, p.18, p.24–25). Only *which source is in
   which layer* is restored, not geometry.

Why this is the more robust option: it uses only documented calls; the look stays in the switcher's
own memory, so the Web RCS, the RC400T and this app all agree on what "memory 20" is; and recall
never depends on what is selected on the controller.

**What you do differently from E2:** the app can't create Aquilon memories, so you build the look on
Preview and save it as a Screen memory in the Web RCS (Memories tab › Screen › Save; Manual §15.3.1).
A Master memory save with "create Screen memories" also works (§15.2.1). Then save the app preset over
those destinations. If the app has seen the memory loaded on Preview, the slot fills in automatically.

---

## Install on a Mac

1. Install Node.js 18 or later (the LTS release is fine), using **either**:
   - the macOS installer from <https://nodejs.org> (choose the LTS `.pkg`; it runs natively on Apple Silicon), **or**
   - Homebrew: `brew install node`
2. Check it: `node -v` should print v18 or later.
3. Unzip `rs6-presets.zip` somewhere, for example `~/RS6`, then:

```bash
cd ~/RS6/rs6-presets
node server.js            # or: npm start
```

You don't need `npm install`, because there are no dependencies. Open **http://localhost:8080**.
On an iPad or phone, open the `http://<your-mac-ip>:8080` address printed in the terminal. Add it to
the home screen for a full-screen app.

Options: `--port 8080`, `--host 0.0.0.0` (the default, so it listens on the LAN), `--data <dir>`
(where `presets.json` and `settings.json` live; the default is the app folder), and `--mock`.

### macOS firewall prompt
The first time it runs, macOS may ask **"Do you want the application 'node' to accept incoming
network connections?"** Click **Allow**, or iPads and phones won't reach the UI; `localhost` works
either way. If you clicked Deny, go to System Settings › Network › Firewall › Options and set `node`
to *Allow incoming connections*. Outgoing connections to the RS6 or simulator don't trigger a prompt.

## Connect to the device

Open **⚙ Settings**:

| Field | AW LivePremier/Aquilon Simulator on this Mac | Real RS6 |
|---|---|---|
| Device IP / host | `127.0.0.1` | the RS6 control IP |
| REST / Web RCS port | the port the Simulator session uses (**3001** on Steven's setup; the Simulator defaults to 3000) | `80` (`443` and tick HTTPS if you enabled the HTTPS server) |
| AWJ TCP port | `10606` if the Simulator exposes AWJ (unverified, see below) | `10606` |
| Commands via | REST | REST (recommended) or AWJ |
| Web RCS password | only if protection is on (the Simulator default is `11:22:33:44:55:66`, Manual §4.3.7.1) | your Web RCS password |

On a real unit, make sure REST and AWJ are enabled under **Web RCS › Remote Control › Application
Programming Interfaces** (Manual §4.3.8). If a password is set, the app logs in with
`POST /auth/login?identifier=Admin&password=…`, stores the `auth-jwt` cookie, and logs in again on a 401
(REST p.73–74). The password is kept in `settings.json` on the Mac and never sent to browsers.

**Save & connect** reads the system info and builds the destination list from enabled screens and aux
(REST p.11 and p.21). Change "Scan screens/aux" if you use Link or more aux. The RS6 supports up to
16 screens + 4 aux (Manual, unit specifications).

If AWJ isn't reachable (for example, the Simulator may not open 10606), untick **Use AWJ readback**.
Everything still works, but you type the Screen memory slots by hand.

## Using it

- **RECALL mode** (the default): tap a preset to load it to Preview on its destinations. TAKE (or the
  space bar) and CUT (or the C key) act on the lit destinations.
- **SAVE mode**: light the destinations you want, then tap an empty slot (or an existing preset to
  overwrite it). Pick a number and name, and check or type the Screen memory slot for each destination.
- **EDIT mode**: tap a preset to rename it, renumber it, fix slots, **Update** (re-capture its own
  destinations), **Overwrite with current selection**, **Duplicate** or **Delete**.
- **AUTO TAKE**: when on, every recall is followed immediately by a TAKE of the same destinations.
- Destination tiles show which app preset is on PGM and PVW for each screen.

## Mock / demo mode

```bash
node server.js --mock
```
This starts a simulated RS6 inside the app: REST on a random local port and AWJ on another, with
4 screens and 2 aux. It also seeds 8 demo presets in `./mock-data/`, kept separate from your show
presets. The mock implements only the documented endpoints the app uses. It's a test double, not
an emulator of the real device.

Run the automated tests (against the mock):
```bash
npm test
```

## HTTP control API (for Companion, Stream Deck, scripts)

Everything returns JSON. Errors return HTTP 4xx with `{ "error": "…" }`.

| Method & path | Body | Action |
|---|---|---|
| `GET /api/state` | | Full state: destinations (with selection and per-destination PVW/PGM preset), presets (with `tally.pvw`/`tally.pgm` = `none`/`partial`/`full`, `onPreview`, `onProgram`), `lastRecalled`, `programPresets`, `tally.preview`/`tally.program` maps, `autoTake`, `connected` |
| `POST /api/presets/{n}/recall` | | Recall preset *n* to Preview |
| `POST /api/take` | | TAKE the selected destinations |
| `POST /api/cut` | | CUT the selected destinations |
| `POST /api/destinations/{S1\|A2…}/toggle` | | Toggle one destination |
| `POST /api/selection` | `{"destinations":["S1","S2"]}` | Set the selection |
| `POST /api/autotake` | `{}` to toggle, or `{"value":true}` | Auto take on recall |
| `POST /api/presets` | `{"number","name","destinations"?,"memories"?}` | Save or overwrite (default: current selection) |
| `PUT /api/presets/{n}` | `{"name"?,"newNumber"?,"memories"?}` | Rename, renumber or edit slots |
| `POST /api/presets/{n}/update` | `{"useSelection":false}` | Re-capture (or overwrite with the selection) |
| `POST /api/presets/{n}/duplicate` | `{"toNumber"?}` | Duplicate |
| `DELETE /api/presets/{n}` | | Delete |
| `POST /api/capture` | `{"destinations":[…]}` | Report the Screen memory slots detected on Preview |
| `GET /api/events` | | Server-Sent Events (`state`, `log`) used by the UI |
| `GET/POST /api/settings`, `POST /api/connect`, `GET /api/log` | | Settings, reconnect, log |

Example: `curl -X POST http://<mac-ip>:8080/api/presets/3/recall`

There is no authentication on this API. Run it only on a trusted show network.

## Device commands used

Page numbers are the printed page numbers in the guides.

| Purpose | Call | Doc |
|---|---|---|
| System info | REST `GET /api/tpp/v1/system` (AWJ fallback `…/$device/@items/1/@props/dev`, `…/version/@props/updater`) | REST p.7; AWJ p.6–7 |
| Screen / aux list | REST `GET /screens/{1..24}`, `GET /auxiliary-screens/{n}` (AWJ fallback: preconfig `mode` and `label`) | REST p.11, p.21; AWJ p.8 |
| Recall to Preview / Program | REST `POST /screens/{id}/load-memory` and `/auxiliary-screens/{id}/load-memory` `{"memoryId":n,"target":"preview"\|"program"}`; AWJ `DeviceObject/presetBank/control/load/$slot/@items/{n}/$screen\|$auxiliary/@items/{S1\|A1}/$preset/@items/PREVIEW\|PROGRAM/@props/xRequest` | REST p.12, p.22; AWJ p.9 |
| TAKE | REST `POST /take {"screenIds":[…],"auxiliaryScreenIds":[…]}`, falling back to `POST /screens/{id}/take` and `/auxiliary-screens/{id}/take`; AWJ `DeviceObject/$screenAuxGroup/@items/{S1}/control/@props/xTake` | REST p.19–20, p.26; AWJ p.9 |
| TBAR side (which of A/B is Preview) | AWJ `DeviceObject/$screenAuxGroup/@items/{S1}/status/@props/transition` | AWJ p.13 |
| Last Screen memory on Preview | AWJ `DeviceObject/presetBank/status/presetId/$screen\|$auxiliary/@items/{key}/$preset/@items/{A\|B}/@props/id` | AWJ p.16 |
| Layer sources (snapshot) | REST `GET /screens/{id}/layers/{L}/presets/preview`, `GET /auxiliary-screens/{id}/layers/{L}/presets/preview/source` | REST p.15, p.24 |
| Background (snapshot) | REST `GET /screens/{id}/background-layer/presets/preview` | REST p.17 |
| Write sources | REST `POST …/layers/{L}/presets/{target}/source`, `POST …/background-layer/presets/{target}/source` | REST p.16, p.18, p.24–25 |
| Auth | `POST /auth/login?identifier=Admin&password=…` and then `Cookie: auth-jwt=…` | REST p.73–74 |

## Limitations and what's unverified

**I tested this against the built-in mock only. I have not run it against a real RS6 or the AW
Simulator.** Please run a dry rehearsal before using it in a show.

- **CUT is not a native Take Cut.** Neither guide documents a Take Cut command. CUT here loads the
  Preview preset's Screen memory (or source snapshot) straight to **Program** on each lit destination
  (`target: "program"`), which has no transition. It works only for destinations where the app knows
  which preset is on Preview. If you changed Preview by hand after recalling, those changes **aren't**
  cut; use TAKE.
- **The app can't create Aquilon memories**, because no save is documented. Make Screen memories in
  the Web RCS.
- **The source-snapshot fallback restores only sources and background sets**, not position, size,
  opacity, crop, masks or keying.
- **Tally is app-side.** It reflects what *this app* recalled and took. A recall, take or T-bar move
  from the RC400T or the Web RCS isn't seen. No tally read is documented. Use the "Preset Toggle"
  setting to match the device so PVW tally stays correct after a TAKE.
- **The device's own transition selection isn't changed.** Selection follows the preset *in this app*,
  and every take names its screens explicitly. The guides document no way to set the device's
  transition filter. A TAKE pressed on the RC400T still uses the RC400T's selection.
- Unverified details: the global TAKE key `auxiliaryScreenIds` (the raw-TCP example in the guide has a
  stray trailing space; the app uses the spelling from the parameter table and the C# sample, and
  falls back to per-screen TAKEs on error). The AWJ aux TAKE path `$screenAuxGroup/@items/A1/...` is
  inferred from the documented `S1` example. The AWJ `presetId` readback after a *save* (as opposed to
  a load) isn't documented; check the slot in the Save dialog. Whether the Simulator exposes AWJ on
  10606 is also unknown.
- Firmware: the guides target "v6.2 or higher" (AWJ) and "v4.0 or higher" (REST). The app is built
  for 6.2.79, but none of this has been checked on that exact firmware.

## Files

```
server.js            entry point (CLI flags, mock bootstrap)
lib/engine.js        presets, selection, recall/take/cut, tally
lib/device.js        every device call (with doc page refs)
lib/rest.js          REST client (exact Content-Length, auth-jwt cookie)
lib/awj.js           AWJ TCP client (0x04 framing)
lib/mock.js          mock RS6 (REST + AWJ)
lib/server.js        HTTP server, JSON API, SSE, static UI
public/              UI (index.html, app.js, style.css)
test/                node:test suites
presets.json         your presets (created on first save)
settings.json        device settings (created on first save)
```

MIT licensed. See `LICENSE`.
