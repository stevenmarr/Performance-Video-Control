# RS6 Presets

<img src="public/pv-logo.png" alt="Performance Video LLC" height="48">

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
- **Live device state (v0.2.0).** A persistent AWJ connection with subscriptions keeps the app in
  step with the RS6, including changes made on the RC400T or the Web RCS:
  - **real input tally** (which inputs are on Program and Preview layers)
  - **last Screen memory** per destination and **last Master memory** with their names
  - **input status** (label, enabled, signal, capability, scope, freeze)
  - **input, background-set and group backups**
  - **per-channel audio mutes**

  There are tabs for **Inputs** (freeze toggle), **Backup** and **Audio**. Preset tally now follows
  the device, not just the app.
- **Memory import and mix-and-match board (v0.3.0).** The app reads the RS6's own memories
  (Screen/Aux, Master, Multiviewer) with slot, name and status, keeps them current through the AWJ
  subscription, and shows them in a **palette grouped by type**. Drag (or tap) a memory onto a
  **screen, aux or multiviewer card** to stage a look, or onto a **preset tile** to build it. Presets can
  now be **combined**: a different memory per screen, plus an optional Master memory and multiviewer
  memories. Recall loads each memory only to its own target. See
  [Memory import and the board](#memory-import-and-the-board-v030).
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

## Live device state (v0.2.0)

When **Live device state** is on (Settings; the default), the app keeps one AWJ TCP connection open
to port 10606 alongside the REST commands:

1. **Discover:**
   - per-destination layer count: layer capability, §3.5 p.10
   - which inputs have labels: §6.1 p.24
   - which audio channels and backup groups answer: §5.1–5.2, §6.10
2. **Read everything once.** Gets are pipelined, and replies are matched by path.
3. **Subscribe** (§1.4 p.4–5) with one `replace` on `Subscriptions` listing path prefixes:
   - per destination:
     - `DeviceObject/$screenAuxGroup/@items/{S1}/status/@props/transition` (TBAR side, §3.8)
     - `DeviceObject/{$screen|$auxiliary}/@items/{S1}/control/@props/label`
     - each `…/$preset/@items/{A|B}/$layer/@items/{n|NATIVE}/source` (§3.6, §3.8–3.10)
   - `DeviceObject/presetBank/status/presetId` (last Screen memory, §3.11)
   - `DeviceObject/masterPresetBank/status/lastUsed` (last Master, §3.12)
   - `DeviceObject/presetBank/$bank` and `DeviceObject/masterPresetBank/$bank` (memory labels, §3.7)
   - `DeviceObject/$input/@items/` (inputs and input backups, §6.1, §6.4–6.6)
   - `DeviceObject/backup/$group` (§6.10–6.11)
   - `DeviceObject/preconfig/backgrounds/$screen/@items/{S}/$backgroundSet` (§6.7–6.9)
   - each `DeviceObject/audio/control/$device/@items/1/$rx|$tx/…/control` (§5.1–5.2)

   Every change the device pushes to the app is applied straight away and sent to browsers over SSE
   and to Companion over long-poll. A full re-read runs every 60 s as a safety net.
4. **Fallbacks.** If the subscription `replace` isn't echoed, the app **polls the same paths over AWJ**
   every *Fallback poll* ms (default 1000). If AWJ can't connect at all, it **polls REST**:
   - layer status and sources, REST p.15
   - backgrounds, REST p.17
   - aux sources, REST p.24
   - inputs, REST p.66

   It retries AWJ every 10 s. The header pill shows `LIVE · PUSH`, `LIVE · AWJ POLL`,
   `LIVE · REST POLL` or `LIVE OFF`.

**Program and Preview** come from the TBAR side (§3.8 p.13). With `AT_DOWN`, preset A is Program and
B is Preview. With `AT_UP`, it's the other way round.
**Input tally** counts an input as on Program (or Preview) when any Program (or Preview) layer, or a
background, on any destination has `LIVE_<n>` as its source.
**App preset tally** becomes "device-memory" tally: a destination matches a preset when the device's
last-loaded Screen memory on that side (§3.11) equals the preset's slot. When a destination has no
slot, the preset's layer-source snapshot is compared instead.

### Path forms

- **Device index.** The guide's 4.0+ notes (§1.4 p.5) say a device index was added and screens and
  aux were split into separate lists. The device index appears in the guide **only** in system and
  audio paths (`…/system/$device/@items/1/…`, `…/audio/control/$device/@items/1/…`). Screen, layer,
  memory and input paths have no device segment, so the app doesn't add one.
- **Screen and aux collections.** The guide's examples use `$screen`/`$auxiliary` for per-screen
  objects and `$screenAuxGroup` for transition control and status. `$auxiliaryScreen` appears nowhere
  in the v6.2 guide, so the app uses `$auxiliary`.
- **Subscription example.** The `Subscriptions` example in §1.4 uses the pre-4.0
  `DeviceObject/$screenGroup/…` form. It was **not copied**. The subscription prefixes above are
  derived from the documented get/replace paths in §3, §5 and §6 (see `lib/paths.js`). Each builder
  is unit-tested against the literal example printed in the guide (`test/paths.test.js`).

---

## Memory import and the board (v0.3.0)

![RS6 Presets 0.3.0 in mock mode](docs/rs6-presets-ui.png)

*(Mock mode, 1366×900. Preset 10 is on Program, preset 9 on Preview, and the board holds a staged mix.)*

### What is imported, and how

| Memory type | Capacity (Manual §15) | Name | Valid / empty | Load | Notes |
|---|---|---|---|---|---|
| **Screen** (also used by **Aux**: one shared bank) | 1000 | **Documented**: `DeviceObject/presetBank/$bank/@items/{n}/control/@props/label` (AWJ §3.7) | **INFERRED** (probe only) `…/presetBank/$bank/@items/{n}/status/@props/isValid` | REST `POST /screens/{id}/load-memory`, `/auxiliary-screens/{id}/load-memory`; AWJ §3.3 | Per screen: the device's last-loaded memory on PGM and PVW (§3.11) |
| **Master** | 500 | **Documented**: `DeviceObject/masterPresetBank/$bank/@items/{n}/control/@props/label` (§3.7) | **INFERRED** (probe only) `…/masterPresetBank/$bank/@items/{n}/status/@props/isValid` | REST `POST /load-master-memory {memoryId,target}` (p.13); AWJ `DeviceObject/masterPresetBank/control/load/$slot/@items/{n}/$preset/@items/PREVIEW\|PROGRAM/@props/xRequest` (§3.4) | Last Master on PGM/PVW (§3.12). **Which screens a Master contains cannot be read.** |
| **Multiviewer** | 50 | **INFERRED** (probe only) `DeviceObject/monitoringBank/$bank/@items/{n}/control/@props/label` | **INFERRED** (probe only) `…/monitoringBank/$bank/@items/{n}/status/@props/isValid` | REST `POST /multiviewers/{id}/load-memory {memoryId}` (p.28); AWJ `DeviceObject/monitoringBank/control/load/$slot/@items/{n}/$output/@items/{o}/@props/xRequest` (§4.2) | Outputs: REST `GET /multiviewers/{id}` (p.27) / AWJ `$monitoring/@items/{o}/status/@props/isEnabled`, `control/@props/label` (§4.1). No "last loaded" readback exists. |
| **Layer** | 50 | — | — | — | **No API at all** in either guide. Listed in the palette as unsupported. |

- **When:** on connect (after the live read), on every subscription push of a label or status, on
  the 60 s safety re-read, and on demand with **↻ Refresh** in the palette (`POST /api/memories/refresh`).
- **Status without the probe.** By default the app sends **only documented commands**. Validity
  isn't documented, so a slot is shown as **valid** when it has a name, or when the device reported it
  as loaded somewhere (§3.11/§3.12); otherwise it's **unknown**. Each item carries `evidence`
  (`device` / `label` / `loaded`) so you can see why. With the probe off, all 50 multiviewer slots are
  listed as *unknown* (numbers only), because their names can only be read with the probe.
- **Settings › Memory probe (INFERRED paths)**, default **off**. When on, the app also reads and
  subscribes to the `isValid` and multiviewer-label paths above. They are not in the AWJ guide; they
  are the TCP spelling of the Web RCS model names (`presetBank/bankList/items/N/status/pp/isValid`)
  used by the open-source Bitfocus `companion-module-analogway-awj`, translated with the same rule that
  maps the documented label path (`bankList/items → $bank/@items`, `pp → @props`). If the device
  rejects them, the app just logs it and falls back to the label rule. **Untested on a real RS6.**
- **REST only.** REST has no memory read at all, so if AWJ is unreachable the import fails with a
  clear message ("memories are read over AWJ only") and the palette keeps whatever it had.

### Using the board

- The **palette** (left) has tabs **SCREEN/AUX · MASTER · MV · LAYER**, a search box, and a
  *show empty/unknown* switch. Each memory shows its slot, name, status, and a PGM/PVW dot when it's
  live on some screen.
- The **board** has a card per screen, aux and multiviewer output, plus a **MASTER** card. Each card
  shows the staged memory and the device's live PGM/PVW memory.
- **Mouse:** drag a memory onto a card (or a preset tile). **Touch/tablet:** press and hold ~0.2 s,
  then drag. The page auto-scrolls near the edges. **Click/tap fallback:** tap a memory to *arm* it
  (blue banner), then tap a card or preset tile. Incompatible drops are refused (e.g. a Master on S1).
- Dropping onto a **preset tile** opens a small picker for the target (S1… / A1… / Master / M1…), then
  assigns the memory into that preset (creating it if the number is empty).
- **LOAD TO PVW** loads the board as it stands; **SAVE AS PRESET…** saves it as a combined preset;
  **CLEAR** empties it. EDIT › *Open on the board* copies a preset onto the board for changes.
- Preset tiles show chips like `M:3 S4:30 MV1:2`. Tally (PVW green / PGM red, partial dashed) and the
  last-recalled outline work as before; a Master counts as one component of the tally.

### Combined presets: recall targeting

A preset now holds `memories {S1: 10, S2: 32, A1: 42}`, an optional `master {slot, dests}` and
`mvMemories {M1: 2}`. Recall (and LOAD TO PVW) runs in this order:

1. **Master first**, as a Master: one Master load to Preview (REST `/load-master-memory`, AWJ §3.4).
   Per the Manual (§15.2), the device then changes only the screens stored in that Master.
2. **Then each Screen memory, only to its own destination** (one explicit load per screen/aux), so a
   per-screen memory overrides what the Master put on that screen.
3. **Then multiviewer memories**, one per output. These load straight to the output (there is no
   Preview/Program for multiviewers), so they change immediately even before a TAKE.

The app's selection becomes the Screen-memory destinations plus the Master's **dests**. Because the
API can't tell which screens a Master contains, `master.dests` is set by you in EDIT (it defaults to
all destinations) and is used for selection, TAKE, CUT and tally. CUT on a Master preset loads the
Master to Program.

### Preset file v2 and migration

`presets.json` keeps the same shape with `"version": 2` and two new optional fields per preset,
`master` (or `null`) and `mvMemories` (`{}`). On first start, a version-1 (0.2.0) file is copied
once to `presets.v1.bak.json` and rewritten as version 2; every preset, slot and source snapshot is
kept. The log shows "Migrated N presets…". 0.2.0 can't read the new fields but ignores them.

### Branding

The header shows the Performance Video LLC play mark and wordmark (`public/pv-logo.png`, white on the
dark header). The favicon and Apple touch icon are the play mark alone. Contact details from the
source artwork are deliberately left out. There is no light theme; if one is added, the logo needs a
dark backing (see the comment in `style.css`).

---

## v0.3.3: preset names on the tiles

Before 0.3.3, a preset made by dropping memories on a tile, or saved without typing a name, was
stored as "Preset 4". So the tile showed only its number, twice. The app never used the names of
the device memories the preset holds.

**Names**
- Every filled tile shows its **name** large, with the slot number small above it.
- A preset without a typed name has an **automatic name**, built from the device memory names
  (AWJ §3.7) and kept up to date when a memory is renamed on the device:
  - one memory: its name, e.g. `Keynote`
  - a Master: the Master's name, e.g. `Show Open`
  - several memories: joined with `+`, e.g. `IMAG L + IMAG R`
  - a slot without a device name: `S2:M2` or `Master 7`
  - a destination with no memory slot: `S1 snapshot`
- Existing presets named `Preset <n>` (or with no name) are treated as automatic. They show the
  derived name, and the stored file isn't rewritten. A name you typed is never replaced.

**Saving and renaming**
- The Save and Save-board dialogs prefill the name with the automatic one. Keep it, or leave it
  empty, and it stays automatic; type your own to fix it.
- To rename, **long-press** a tile (iPad) or **right-click** it (Mac). Clear the name to go back
  to the automatic one. EDIT shows both names.

**API and Companion**
- In `/api/state` and the preset routes, `name` is the name to show. They also return
  `customName` (what was typed, `''` when automatic), `autoName` and `derivedName`.
- `POST /api/presets/suggest-name` with `{memories, master, mvMemories}` returns the default name.
- Companion's `$(rs6presets:preset_N_name)` and `last_preset_name` therefore show the same name as
  the tile, with no module update needed.

## v0.3.2: Settings button fix

In 0.3.0 and 0.3.1 the **⚙ Settings** button was missing from the top bar at every width and in
every browser. It wasn't the layout. The CSS rule for the drag preview (`.ghost`, added in 0.3.0)
also matched buttons styled `btn ghost`. That pinned the Settings button, and the Cancel/Close
buttons in the dialogs, just off the top-left corner of the screen, where they couldn't be clicked.
The drag preview now has its own class (`dragghost`).

The header also got more robust:
- Settings stays at the end of the first row at every width.
- The logo shrinks.
- On iPad portrait (820 px) and narrower, the PVW/Master/live readouts wrap to a second row.

`/settings` still opens the settings directly. `test/ui.test.js` checks the CSS statically. When
Playwright is available, it also checks that the button is visible and clickable inside the top
bar at 820 and 1440 px.

## TAKE, transitions and selection (v0.3.1)

v0.3.0 sent correct TAKE commands, and the device did transition, but the app's tally and memory
indicators then showed the wrong thing, so the transition looked broken. Screen selection could
also seem not to stick. 0.3.1 fixes both. Everything below was checked on the **LivePremier
Simulator 6.2.79** (Aquilon RS6), in both REST and AWJ mode.

### What the device does on a TAKE (observed on the Simulator)

| Command | Result |
|---|---|
| REST `POST /api/tpp/v1/take` `{"screenIds":[1],"auxiliaryScreenIds":[]}` (REST guide p.28) | 204; takes S1 only, with the configured transition. |
| Same, but a list key is **missing** | Takes **all** screens (or all aux) of that kind. An empty list means none. The guide's raw-TCP example has the key `"auxiliaryScreenIds "` with a trailing space; the device ignores that key, so that request takes everything. |
| Same, without `Content-Type: application/json` | The body is ignored and **everything** is taken. |
| `{"screenIds":2}`, `[0]`, `[99]`, bad JSON | 400 with a text message. The device skips disabled screen IDs. |
| REST `POST /screens/{1..24}/take`, `/auxiliary-screens/{id}/take` | 204. `0` and `25` give 400. |
| AWJ `replace DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake` `true` (AWJ guide §3.2) | Takes S1; `A1` works the same for aux. `S0` gives error E12. No reply is sent. |

The app always sends both lists, with JSON Content-Type, listing **exactly** the lit destinations
(1-based IDs). A test checks these bytes against the guide's examples.

What the device does **not** update after a TAKE (observed):
- `presetBank/status/@props/presetId` on the side that becomes Preview keeps its old value. With
  Preset Toggle **off**, the device copies Program's look back to Preview, but the id doesn't follow.
- `masterPresetBank/status/@props/lastUsed` PROGRAM stays where it was.
- A Master load doesn't change the screens' `presetId`.
- The TBAR side (`status/@props/transition`, `AT_DOWN`/`AT_UP`) flips only when the transition
  **ends**, after the Take duration.

**Root cause (bug 1).** 0.3.0 built tally from those readbacks, and its mock faked them (it copied
the memory id on TAKE and moved the Master to Program). On the real device, after a TAKE the app
showed a stale preset on Preview and nothing on Program, and Master presets never went PGM.
0.3.1 keeps an **effective tally** per destination instead:
- The memory on each side is taken from the device's readback only when that readback **changes**
  (a load).
- When the TBAR side flips (a TAKE from the app, RC400T or Web RCS), the app moves the memory
  itself: Preview's memory goes to Program. Preview keeps a copy (Preset Toggle off) or gets the old
  Program (Preset Toggle on).
- A Master on Preview goes to Program when one of its screens is taken.

The mock now behaves like the Simulator: it rejects malformed takes the same way, can delay the
TBAR flip, and no longer fakes those readbacks.

**Root cause (bug 2).** The board's screen cards didn't show or change the TAKE selection; only the
destination tiles at the top did. Those tiles were also rebuilt on every device push, which could
swallow a tap. Now:
- A tap on a **screen card** (when no memory is armed) or a destination tile toggles it.
- Selected cards are outlined and carry a **TAKE** badge.
- TAKE and CUT show their targets ("TAKE / CUT → S1, A1").
- The tiles are redrawn only when something changes.
- Recall still sets the selection to the preset's destinations. A **Master** preset uses its
  declared Master screens, or all destinations if none are declared, so set them in EDIT.

### Why selection stays in the app

Neither guide documents a command to read or set the device's own screen selection (the
transition filter). Per User Manual §4.5, the Web RCS shares it between controllers only with
"Selection Synced to Server", through the Web RCS's internal websocket, which isn't a public API.
Every TAKE the app sends names its screens explicitly, so the device's selection isn't needed and
the app keeps its own. A TAKE pressed on the RC400T or in the Web RCS still uses that controller's
selection, and the app follows the result.

### Preset Toggle

Set the app's **Device has Preset Toggle** setting to match the Preset Toggle switch in the Web
RCS (Transitions, right panel). With *Settings › Also probe undocumented memory paths* on, the app reads the device's
`control/@props/copyMode` instead. **INFERRED** path: it is in the Web RCS model and works on the
Simulator, but it isn't in the guides.

### Transition type and duration

Neither is set by the API, so set them on the device:
- **Duration:** in the Web RCS, Take button settings, global transition duration
  (`takeUpTime`/`takeDownTime`, in tenths of a second; the Simulator defaults to 1.0 s).
- **Effects:** per layer, opening and closing effect, speed and timing (User Manual §14.3).
- **Take Cut** ignores effects. The app's CUT loads straight to Program instead (see Limitations).

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
- Destination tiles show which app preset is on PGM and PVW for each screen. They also show the
  **last Screen memory number and name** on each side (red for PGM, green for PVW). The header shows
  the last **Master** memory.
- **INPUTS tab:**
  - every input with its device label
  - a red border when it's on Program, green when it's on Preview, and the destinations it's on
  - FROZEN, NO SIGNAL, DISABLED and BKP badges
  - a **FREEZE/UNFREEZE** button
- **BACKUP tab:** PRIMARY / BACKUP 1 / BACKUP 2 and AUTO on/off for each input that has backups
  configured, for each background set with backups, and for each backup group.
- **AUDIO tab:** a mute button for every audio input and output channel. Red means muted.
- **Save dialog:** the slot fields list the device's **Screen memory names** (§3.7), and each
  destination shows which memory is on its Preview right now.

## Mock / demo mode

```bash
node server.js --mock
```
This starts a simulated RS6 inside the app: REST on a random local port and AWJ on another, with
4 screens and 2 aux. It also simulates:
- 12 labelled inputs (IN 6 has no signal, IN 8 is disabled), with backups on IN 4
- a background-set backup on S1, and 4 backup groups
- 4×8 audio inputs and outputs
- named Screen and Master memories, with some unnamed-but-valid slots (Screen 60/61, Master 7) and
  some empty ones (v0.3.0), 2 multiviewer outputs with named MV memories, and REST/AWJ Master and MV loads
- AWJ subscriptions with prefix-matched push, plus "external" changes that bypass the app (used in
  tests to stand in for the RC400T or Web RCS).

It also seeds demo presets: some with typed names, some with automatic names (3 *IMAG L + IMAG R*, 9 *Keynote + Sponsor L + Sponsor R*, 11 and 12 Master-only), and combined preset 10 *Panel Master + MV*, in `./mock-data/`, kept separate from your show
presets. The mock implements only the documented endpoints the app uses. It's a test double, not
an emulator of the real device.

Run the automated tests (against the mock):
```bash
npm test       # 114 tests; the browser check is skipped unless Playwright is installed
NODE_PATH=$(npm root -g) npm test   # with `npm i -g playwright && npx playwright install chromium`
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
| `POST /api/presets` | `{"number","name","destinations"?,"memories"?,"master"?,"mvMemories"?}` | Save or overwrite (default: current selection) |
| `PUT /api/presets/{n}` | `{"name"?,"newNumber"?,"memories"?}` | Rename, renumber or edit slots |
| `POST /api/presets/{n}/update` | `{"useSelection":false}` | Re-capture (or overwrite with the selection) |
| `POST /api/presets/{n}/duplicate` | `{"toNumber"?}` | Duplicate |
| `DELETE /api/presets/{n}` | | Delete |
| `POST /api/capture` | `{"destinations":[…]}` | Report the Screen memory slots detected on Preview |
| `GET /api/state?since={rev}&timeout={ms}` | | **Long-poll**: answers as soon as the state revision `rev` passes `since`, or after `timeout` (default 25 s, max 60 s) |
| `GET /api/live` | | Live status and snapshot: `mode` (`push`/`poll-awj`/`poll-rest`/`off`), per-destination PGM/PVW layers, memory and layer-1 label; `tally`; `inputs`; `lastMaster`; `backup`; `audio` (also in `state.live`) |
| `GET /api/tally` | | Input tally: `{program:[…], preview:[…], inputs:{n:{program:[S1…],preview:[…]}}}` |
| `GET /api/inputs` | | Inputs: `label`, `isEnabled`, `isAvailable`, `capability`, `freeze`, `scope`, `device`, tally and `backup` |
| `GET /api/memories` | | Screen and Master memory labels, last Master memory, last Screen memory per destination, plus (0.3.0) `catalog` |
| `GET /api/memories/catalog[?all=1]` | | **0.3.0** Imported memories by type: `{types, items:{screen,master,multiviewer:[{slot,label,status,evidence,onProgram,onPreview,seenOn}]}, import:{at,error,count,probe}}`. `all=1` includes empty/unknown slots |
| `POST /api/memories/refresh` | | **0.3.0** Re-import memories now (409 if AWJ is unreachable) |
| `POST /api/memories/load` | `{"type":"screen"\|"master"\|"multiviewer","slot":n,"dest":"S1"\|"M1","target":"preview"\|"program"}` | **0.3.0** Load one memory now |
| `GET /api/stage`, `DELETE /api/stage` | | **0.3.0** The board, or clear it |
| `POST /api/stage` | `{"target":"S1"\|"A1"\|"master"\|"M1","type"?,"slot":n\|null,"dests"?}` | **0.3.0** Stage a memory on a card (`slot:null` removes it; `type` is checked against the target) |
| `POST /api/stage/load` | `{"target":"preview"}` | **0.3.0** Load the board (Master, then screens, then MVs) |
| `POST /api/stage/save` | `{"number"?,"name"?}` | **0.3.0** Save the board as a (combined) preset |
| `POST /api/stage/from/{n}` | | **0.3.0** Copy preset *n* onto the board |
| `POST /api/presets/{n}/assign` | same body as `POST /api/stage` | **0.3.0** Drag-assign a memory into preset *n* (created if missing) |
| `GET /api/backup`, `GET /api/audio` | | Backup and audio state |
| `POST /api/inputs/{n}/freeze` | `{}` to toggle, or `{"value":true}` | Freeze or unfreeze an input (*inferred write*) |
| `POST /api/inputs/{n}/backup` | `{"slot":"NONE"\|"1"\|"2"}` | Select primary or a backup slot |
| `POST /api/inputs/{n}/backup/mode` | `{"auto":true}` | Automatic or manual backup switching |
| `POST /api/backgrounds/{S1}/{set}/backup` and `…/mode` | same | Background-set backup |
| `POST /api/groups/{g}/backup` and `…/mode` | same | Group backup |
| `POST /api/audio/{inputs\|outputs}/{n}/channels/{c}/mute` | `{}` to toggle, or `{"value":true}` | Audio channel mute |
| `GET /api/events` | | Server-Sent Events (`state`, `log`) used by the UI |
| `GET/POST /api/settings`, `POST /api/connect`, `GET /api/log` | | Settings, reconnect, log |

Example: `curl -X POST http://<mac-ip>:8080/api/presets/3/recall`

`state.rev` goes up by one on every change. Live-control writes need the AWJ connection, and return
HTTP 409 when it's down or the device rejects the write.

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
| **Live (v0.2.0), all AWJ:** subscriptions | `{"op":"replace","path":"Subscriptions","value":[prefixes…]}`; the device echoes the list and then pushes `{path,value}` for any path starting with a prefix | §1.4 p.4–5 |
| Layer and background sources, both sides | `DeviceObject/{$screen\|$auxiliary}/@items/{S1}/$preset/@items/{A\|B}/$layer/@items/{n\|NATIVE}/source/@props/inputNum` | §3.6 p.11–12, §3.8 p.13–14, §3.9–3.10 p.14–15 |
| Layer count probe | `DeviceObject/preconfig/resources/new/$screen/@items/{S1}/$layer/@items/{n}/control/@props/capability` | §3.5 p.10 |
| **v0.3.0** Master memory load | REST `POST /load-master-memory {"memoryId":1-500,"target"}`; AWJ `DeviceObject/masterPresetBank/control/load/$slot/@items/{n}/$preset/@items/PREVIEW\|PROGRAM/@props/xRequest` | REST p.13; AWJ §3.4 p.10 |
| **v0.3.0** Multiviewer outputs | REST `GET /multiviewers/{1..8}` (`isEnabled`, `label`); AWJ `DeviceObject/$monitoring/@items/{o}/status/@props/isEnabled`, `…/control/@props/label` | REST p.27; AWJ §4.1 p.18 |
| **v0.3.0** Multiviewer memory load | REST `POST /multiviewers/{id}/load-memory {"memoryId":1-50}`; AWJ `DeviceObject/monitoringBank/control/load/$slot/@items/{n}/$output/@items/{o}/@props/xRequest` | REST p.28; AWJ §4.2 p.18 |
| **v0.3.0 INFERRED, opt-in** memory validity / MV names | `…/presetBank\|masterPresetBank\|monitoringBank/$bank/@items/{n}/status/@props/isValid`, `DeviceObject/monitoringBank/$bank/@items/{n}/control/@props/label` (only with Settings › Memory probe) | **not in the guide**, see above |
| Memory labels | `DeviceObject/presetBank/$bank/@items/{n}/control/@props/label`, `DeviceObject/masterPresetBank/$bank/@items/{n}/control/@props/label` | §3.7 p.12–13 |
| Last Screen memory per side | `DeviceObject/presetBank/status/presetId/{$screen\|$auxiliary}/@items/{S1}/$preset/@items/{A\|B}/@props/id` | §3.11 p.16 |
| Last Master memory | `DeviceObject/masterPresetBank/status/lastUsed/$presetMode/@items/{PROGRAM\|PREVIEW}/@props/memoryId` | §3.12 p.16–17 |
| Input status | `DeviceObject/$input/@items/IN_{n}/status/@props/isEnabled\|capability\|isAvailable\|scope`, `…/control/@props/label\|freeze`, `…/mapping/@props/device` | §6.1 p.24–25 |
| Input backup | `…/$input/@items/IN_{n}/backup/$slot/@items/{1\|2}/control/@props/source`, `…/backup/control/@props/xSelectSlot` (`NONE`/`1`/`2`), `…/backup/control/@props/enableAutoSelect` | §6.4–6.6 p.28–29 |
| Background-set backup | `DeviceObject/preconfig/backgrounds/$screen/@items/{S1}/$backgroundSet/@items/{set}/backup/…` (same three properties) | §6.7–6.9 p.29–30 |
| Group backup | `DeviceObject/backup/$group/@items/GROUP_{g}/control/@props/xSelectSlot\|enableAutoSelect` | §6.10–6.11 p.30 |
| Audio mutes | `DeviceObject/audio/control/$device/@items/1/$rx/@items/INPUT_{i}_CHANNEL_{c}/control/@props/mute`; `…/$tx/@items/OUTPUT_{o}/$channel/@items/{c}/control/@props/mute` | §5.1.1–5.1.2 p.21–22; §5.2.1–5.2.2 p.22–23 |
| REST polling fallback | layer status and sources `GET /screens/{id}/layers/{L}/presets/{program\|preview}`, background `…/background-layer/presets/…`, aux `…/auxiliary-screens/{id}/layers/{L}/presets/…/source`, inputs `GET /inputs/{n}` | REST p.15, p.17, p.24, p.66 |

The AWJ § and page numbers refer to the *AWJ Protocol Programmer's Guide v6.2*. The REST page
numbers refer to the *REST API Programmer's Guide*.

## Verified vs inferred (v0.2.0 live features)

"Documented" means the exact path and verb appear in the v6.2 AWJ guide, and a unit test checks
the builder against the guide's printed example. **Nothing here has been verified on a real RS6 or
on the AW Simulator** at 0.2.0. Every behaviour was tested against the built-in mock, which implements the
guide as written. In 0.3.1 the TAKE paths and the readbacks around them were checked on the
Simulator 6.2.79 (see [v0.3.1](#take-transitions-and-selection-v031)).

| Feature | Documented in the guide | Inferred by me |
|---|---|---|
| Subscriptions | `get`/`replace` on `Subscriptions`, prefix matching, `{path,value}` pushes (§1.4) | That the device accepts **many** prefixes (≈140 here) and **narrow** prefixes down to a single property. The guide's example uses only 3. Notifications for object values are flattened, in case the device sends a parent object. The app falls back to AWJ polling if the `replace` isn't echoed. |
| Layer sources A/B and TBAR side | `get` (§3.6, §3.8) | That layer and background **sources** changed from the RC400T or Web RCS generate pushes on those paths. Layer visibility isn't documented over AWJ, so in AWJ mode an input counts on air when it's a layer source, even if that layer is closed. REST polling does exclude closed layers (REST p.15 `status`). `SCREEN_x` sources, where a screen feeds a layer, are not followed. |
| Last Screen memory / last Master | `get` (§3.11, §3.12) | That these values update and push on every load from any controller. |
| Memory labels | `get` (§3.7) | Reading up to 1000 Screen and 500 Master labels at startup. Fewer are read when Settings › *Memory labels to read* is lower. |
| Input status (§6.1) | `get` on isEnabled, capability, label, isAvailable, freeze, device, scope | **Freeze write:** §6.1 documents only a `get` on `control/@props/freeze`. The app sends `replace` with `true`/`false` on the same path, and then reads it back to confirm. **Marked INFERRED.** It has been tested against the mock only. |
| Input backups | `get` slot sources (§6.4); `replace` `xSelectSlot` `NONE`/`1`/`2` (§6.5); `replace` `enableAutoSelect` (§6.6) | "Backup active" means `xSelectSlot` read back as anything other than `NONE`. Whether reading `xSelectSlot` (an x-prefixed request property) returns the current selection is inferred. Reading `enableAutoSelect` is inferred too. |
| Background-set and group backups | Same, on §6.7–6.9 and §6.10–6.11 paths | Same as above. Group ids `GROUP_1…8` and background sets `1…8` are discovered by probing. |
| Audio mutes | `get` and `replace` on the rx and tx `mute` (§5.1.2, §5.2.2) | The channel and output counts are discovered by probing, up to Settings limits. Only the device index `1` is used (no Link). |
| **Memory import (0.3.0)** | Screen/Master labels (§3.7), last loaded (§3.11/§3.12), Master load (§3.4), MV outputs and MV load (§4.1–4.2) | **Validity** (`isValid`) and **multiviewer memory names**: paths derived from the Web RCS model, sent only with the opt-in probe. Without it, "valid" = has a name or was seen loaded. That label/status changes push through the `$bank` subscription prefix. That a Master loaded to Preview changes only its own screens (Manual §15.2, not the API guides). On the Simulator a TAKE does **not** update `lastUsed`, so the app moves the Master itself (see [v0.3.1](#take-transitions-and-selection-v031)). |
| REST fallback | Layer status and source (REST p.15), background (p.17), aux source (p.24), inputs (p.66) | REST gives tally and inputs only. Memories, backups, audio and freeze need AWJ. |

## Limitations and what's unverified

- **0.3.0 memories:** the API can't read what's *inside* a Master (which screens, which Screen
  memories), so `master.dests` is your declaration. Multiviewer memories have no last-loaded readback,
  so they aren't part of tally. Layer memories can't be listed or loaded. Memories still can't be
  created or saved from the API; save them in the Web RCS, then press ↻ Refresh.

**Not yet run on a real RS6.** TAKE, recall and tally were checked on the AW Simulator 6.2.79
(0.3.1); the rest was tested against the mock. Please run a dry rehearsal before using it in a show.

- **CUT is not a native Take Cut.** Neither guide documents a Take Cut command. CUT here loads the
  Preview preset's Screen memory (or source snapshot) straight to **Program** on each lit destination
  (`target: "program"`), which has no transition. It works only for destinations where the app knows
  which preset is on Preview. If you changed Preview by hand after recalling, those changes **aren't**
  cut; use TAKE.
- **The app can't create Aquilon memories**, because no save is documented. Make Screen memories in
  the Web RCS.
- **The source-snapshot fallback restores only sources and background sets**, not position, size,
  opacity, crop, masks or keying.
- **Tally.** With live state on, preset and input tally follow the device. Changes from the RC400T,
  the Web RCS and T-bar moves are picked up through the TBAR side and the last-loaded memory (see
  above). With live state off, tally is app-side, as in 0.1, and depends on the "Preset Toggle"
  setting. Since 0.3.1 the memory shown on Program/Preview after a TAKE is tracked by the app
  (the device doesn't update it); a memory loaded elsewhere is picked up from the device. A Screen memory changed by hand after loading still reports that memory's id, because the
  device doesn't flag "modified" over AWJ.
- **The device's own transition selection isn't changed.** Selection follows the preset *in this app*,
  and every take names its screens explicitly. The guides document no way to set the device's
  transition filter. A TAKE pressed on the RC400T still uses the RC400T's selection.
- Checked on the Simulator 6.2.79 in 0.3.1: the global TAKE key `auxiliaryScreenIds` (without the
  trailing space in the guide's raw-TCP example) and the AWJ aux TAKE path
  `$screenAuxGroup/@items/A1/...`. The AWJ `presetId` readback after a *save* (as opposed to
  a load) isn't documented; check the slot in the Save dialog. Whether the Simulator exposes AWJ on
  10606 is also unknown.
- Firmware: the guides target "v6.2 or higher" (AWJ) and "v4.0 or higher" (REST). The app is built
  for 6.2.79, but none of this has been checked on that exact firmware.

## Files

```
server.js            entry point (CLI flags, mock bootstrap)
lib/engine.js        presets (file v2 + migration), board/staging, recall/take/cut, tally
lib/device.js        every device call (with doc page refs)
lib/paths.js         AWJ v6.2 path builders (one per documented path, with § and page refs)
lib/live.js          live device state: AWJ subscriptions / AWJ poll / REST poll, tally, inputs, memories, backup, audio
lib/rest.js          REST client (exact Content-Length, auth-jwt cookie)
lib/awj.js           AWJ TCP client (0x04 framing)
lib/mock.js          mock RS6 (REST + AWJ + subscriptions/push, external-change hooks)
lib/server.js        HTTP server, JSON API, SSE, static UI
public/              UI (index.html, app.js, style.css, pv-logo.png, favicons)
test/                node:test suites
presets.json         your presets (created on first save)
settings.json        device settings (created on first save)
```

MIT licensed. See `LICENSE`.
