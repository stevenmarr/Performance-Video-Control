# Buttons, pages, and Companion (0.31.0)

Control Center **defines** buttons and pages. Bitfocus Companion **assigns** them to Stream Decks. On Steven's Companion fork that includes its page designs (a page written for a Stream Deck, XL, +, or + XL) and page templates.

```
Control Center                         Companion (or Steven's fork)
  BUTTONS  → library buttons  ─┐
  PAGES    → pages per surface ─┼─ Control Center module (pvllc-control-center 0.11.0+) ─→ presets, actions, feedbacks
  COMPANION → status, SYNC   ──┘   or a .companionconfig page file ────────────────→ Import
                                                                       Surfaces tab → which deck shows which page
```

## 1. Make buttons (BUTTONS tab)

1. Open **BUTTONS**.
2. Start from a template (Program, Preview, CUT, TRANS, Shift, Memory, Macro) or pick a button in the list.
3. Set the **element**: a key, an encoder (Stream Deck + / + XL knob), or a touch segment (the strip above a knob).
4. Set the text (variables such as `$(atem:name)` work), colors, role, and the target (follow the selection, or a fixed instance such as `atem-1`).
5. Add **actions** per event: a key has Press, Release, and Hold; an encoder has Turn and Push; a touch segment has Touch.
6. Add **feedbacks** to change the colors when a flag or variable matches.

Everything saves as you type, to `button-library.json`.

## 2. Lay out pages (PAGES tab)

1. Open **PAGES** and pick a surface type (Mini, MK.2, Neo, XL, +, + XL) or a connected deck.
2. Type a name under **New page** and press **Create**.
3. Pick a library button, then click a slot (or drag it). A key only goes on a key, an encoder on a knob, a touch segment on the strip.
4. **Rename**, **Copy** (the copy uses the same buttons), **◀ / ▶** (reorder pages of this size), and **Delete** are next to the name.
5. On the + and + XL the grid matches the hardware: keys on top, the touch strip under the keys, and the knobs under the strip. The + XL has six knobs, under keys 1, 3, 4, 6, 7, and 9 of each row.

Pages save to `surface-pages.json`. A Path C deck can still get a page directly with **Push**.

## 3. Hand them to Companion (COMPANION tab)

1. In Companion, install the **Control Center module** ("Performance Video Control Center", id `pvllc-control-center`, 0.11.0 or newer, 0.14.0 recommended; release asset `pvllc-control-center.tgz`. PV Companion has it built in) and add a connection that points at this app (this Mac's address, port 8080).
2. In Control Center open **COMPANION**. Enter Companion's host and port (default `127.0.0.1`, port `8000`) and press **Save**.
3. The CONNECTION card says whether Companion answers. The MODULE card lists the Control Center module connections Companion has, and the module version that last reported in. An older module is flagged with a link to the releases.
4. Press **SYNC TO COMPANION**. The module refreshes its presets. In Companion, open **Buttons → Presets → Performance Video Control Center**:
   * **CC buttons** has one preset per library button.
   * **CC page: \<name\>** has one preset per placed slot, named by its row and column.
   Drag them onto Companion buttons, or onto a page on the fork's page browser.
5. To move a whole page at once, press **.companionconfig** next to the page. In Companion use **Import / Export → Import**, choose the page to replace, and map the connection called `cc` to your Control Center module connection. On the fork, the page keeps its surface layout (Stream Deck, XL, +, or + XL); save it as a template there if you want to stamp it out again.
6. In Companion's **Surfaces** tab, pick the page (and startup page) each Stream Deck shows. Companion owns the deck: quit Control Center's USB use of that deck (Control Devices) or let Companion take it.

The COMPANION tab also shows Companion's own web UI, at `/companion/` on Control Center's own address (0.34.0, see below), so it works from any computer that can open Control Center.

## What runs where

* A Companion button made from a CC preset or page file calls `cc_button_run` with the CC button id. The app runs that button's actions for the event, the same way a USB deck press does (`POST /api/companion/buttons/:id/run`).
* The look comes from `cc_button_look`: the CC button's text and colors. Live tally from CC feedback flags is not evaluated in Companion yet; use the module's system feedbacks (for example ATEM program / preview) on top.
* Editing a button or page in Control Center changes `rev`; the module checks every few seconds and republishes. SYNC forces it.
* Nothing about Companion is stored except its host and port (`companion.json`). Companion's HTTP API has no password.

API details: [api-reference.md](api-reference.md#companion-bridge-companion-tab-0310).

## Stream Decks: Control Center or Companion (0.31.1)

Only one program can open a USB Stream Deck. If Control Center holds a deck, Companion logs `cannot open device ...` for it.
The COMPANION tab's **STREAM DECKS** card has **Let Companion drive Stream Decks**. When it is on, Control Center closes its
USB deck handles at once and stops opening decks, so Companion picks them up (unplug and replug the deck if Companion does not
see it within a few seconds). It is on automatically once the Control Center module reports in or a check finds its
connection; tick or untick it to choose explicitly, or press **Automatic** to go back. The choice is saved in companion.json.
Turn it off to drive the decks from Control Center (Control Devices) again, after quitting Companion or disabling its Stream Deck surface.

## One web app: Control Center runs Companion (0.34.0)

From 0.34.0 Control Center starts PV Companion itself and shows it at **http://\<this Mac\>:8080/companion/**, the
same address as the rest of Control Center. There is no separate Terminal window and no `yarn start:local` by hand.

* **Start and stop.** The launchd service `com.performancevideo.controlcenter` starts Control Center, and Control
  Center starts Companion: `yarn start:local` in `~/companion`, with config in `~/companion-config` and Companion's
  web server on `127.0.0.1:8000` (loopback only; browsers reach it through Control Center). Stopping or restarting
  Control Center stops Companion cleanly (SIGTERM to its whole process group, SIGKILL after 10 s).
* **Supervision.** If Companion exits, Control Center ends whatever is left of it and starts it again after 1, 2, 5,
  10, 30, then 60 s (the delay resets after two minutes of running). The **COMPANION SERVICE** card on the COMPANION
  tab shows the state (STARTING, RUNNING, BACKOFF, UNHEALTHY, ERROR, NOT-INSTALLED, ADOPTED, STOPPED), pid, uptime,
  restarts and Node version, with RESTART / STOP / START and the last lines of Companion's log. The full log is
  `companion.log` in the data folder (rotated at 5 MB). A Companion left running by a Control Center that was killed
  hard is stopped at the next start (`companion.pid`).
* **Node and yarn.** start:local needs Node 26.10+ (below 27). Control Center uses its own node when that fits, else
  looks in nvm, Homebrew `node@26`, fnm, mise, asdf, Volta, `/opt/homebrew/bin`, `/usr/local/bin` and the PATH a
  login shell has, because launchd gives Control Center a bare PATH. Set **Node** / **yarn** under Settings on the card
  if it picks the wrong one.
* **Already running.** If a Companion that Control Center did not start already answers on the port (for example one
  still open in Terminal), the card says ADOPTED and Control Center uses it. Quit it and Control Center starts its own
  within 10 s.
* **Updating Companion** stays separate: `git pull` in `~/companion`, then RESTART on the card (or restart Control
  Center). A pulled checkout rebuilds Companion's web UI on that first start (a minute or two); a crash restart on
  the same commit skips the rebuild (fork `COMPANION_DEV_REBUILD_WEBUI=auto`, set by Control Center).
* **Opt out.** Untick **Run Companion inside Control Center** (or start Control Center with `--no-companion`, or set
  `CC_COMPANION_MODE=external`). Control Center then uses the Companion at the CONNECTION card's host and port, and
  still shows it at `/companion/`. With no checkout at the folder (the Pi, for example) the card says NOT-INSTALLED
  and the CONNECTION host and port are used the same way.
* **Settings** are in `companion-supervisor.json` in the data folder: `mode` (`managed` / `external`), `path`,
  `configDir`, `port`, `nodePath`, `yarnPath`. Environment variables win over the file (handy in the launchd plist):
  `CC_COMPANION_MODE`, `CC_COMPANION_PATH`, `CC_COMPANION_CONFIG_DIR`, `CC_COMPANION_PORT`, `CC_COMPANION_NODE`,
  `CC_COMPANION_YARN`. `--mock` never starts Companion unless `CC_COMPANION_MODE=managed`.

**How /companion/ works.** `lib/companion/proxy.js` forwards `/companion/*` to Companion with the prefix removed and
the request header `companion-custom-prefix: companion`. Companion's web UI is built with the placeholder base
`/ROOT_URL_HERE` and its server swaps in that prefix (upstream reverse-proxy support), so assets, the router and the
tRPC websocket all live under `/companion/` with no Companion change. The websocket `/companion/trpc` is checked
against Control Center's own origin first (a page from another site cannot open it), then forwarded with
Companion's own origin. `/user-guide/` and `/instance/` (help links and module HTTP handlers) are forwarded too.
Because the frame is now same-origin, it also works from another computer or an iPad: there is no `127.0.0.1` in it.

**LAN access.** Companion used to answer only on this Mac (start:local binds 127.0.0.1). Through Control Center it is
reachable by anyone who can open Control Center, the same as every other Control Center page. Control Center has
no login; keep the show network private.

## Companion's web UI in the tab (0.31.2)

The COMPANION tab shows Companion's own web UI in an iframe. Up to 0.31.1 every status change the 10 s poll saw
repainted the whole tab, iframe included. The module says hello every 30 s with a new timestamp, so the iframe was
rebuilt about every 30 s and Companion's UI reloaded at `/`, which redirects to Connections. From 0.31.2 the status
column repaints on its own and the iframe is only rebuilt when Companion's address, its online state or **Show here**
changes. Companion opened in its own browser window was never affected by this.

## Why Companion still showed the old buttons, and the fixes (0.33.0, module 0.13.0)

Three things made a correctly updated setup look out of date:

* **Order.** Module 0.12.0 listed its per-system sections before CC buttons and **CC deck**, so the deck pages were at
  the bottom under dozens of other sections. Module 0.13.0 lists **CC deck** and **CC** first. Module 0.14.0 (with
  Control Center 0.34.1) lists only the Control Center presets (**CC deck**, **CC buttons**, **CC page**); its actions
  and feedbacks are unchanged, so placed buttons keep working.
* **The count.** "10 presets" on the COMPANION tab was only the CC button presets; deck pages were not reported.
  Module 0.13.0 reports deck presets too, and the MODULE card says **N CC button presets · N deck presets**. When deck
  presets are 0 it says why and how to switch them on (Connections → the connection → **Control Center deck pages for**
  → Stream Deck + XL → Save, then SYNC). Connections made before 0.12.0 get Stream Deck + XL switched on by an upgrade.
* **An old imported module.** An imported `pvllc-control-center` 0.11.0 shadowed PV Companion's built-in copy for new
  connections and in Manage Modules. PV Companion now prefers a newer built-in copy and moves connections off an older
  import. The MODULE card says **imported v0.11.0** on such a connection, with how to fix it.

## Companion buttons draw Control Center's own pictures (0.35.0, module 0.15.0)

Up to 0.34.x a Companion button for a CC deck key got only text lines and two colors, so Companion drew a plain
text button: no color bar, no small header over the big label, no green PVW / red PGM frame, no dashed amber guard
border, no house on HOME, and the strip readouts were text instead of the round knobs. From 0.35.0 every slot in
`GET /api/companion/deck` has an `img` id and `GET /api/companion/deck/art/<id>.png` is the very picture the DECKS page
and a USB deck show. Module 0.15.0 fetches each picture once (the id changes with the value or tally) and draws it
full-bleed (`cc_deck_look` / `cc_dial_look` return `png64`). A page placed from **Control Center pages** keeps the
layout tile for tile, blank keys included. Older modules keep drawing text.

0.35.1: pictures are drawn off the main thread, two at a time, so Control Center keeps answering camera and switcher
requests while Companion fetches a page set. When the usual font files are missing it finds a sans and a mono family
in the font folders instead of loading every system font (about 3 ms a picture instead of about 150 ms).

## Control Center pages and User pages in PV Companion (0.33.0)

PV Companion has **Control Center pages** in the left menu under BUILD (fork 0.35.0; before that it was at the bottom of **Buttons → Pages tab**, not the left-menu Pages screen): the live deck pages (whole deck and each PTZ / ATEM / HOME / CONSOLE
page, per deck size), the PAGES library pages, and **User pages**. **Place** copies one into a new Companion page.
That page is its own copy: edit it like any page, the Control Center original never changes. **Save page N to User
pages** stores an edited copy here in Control Center (`companion-user-pages.json` in the data folder, so it is backed up
with the app). The COMPANION tab lists them under **USER PAGES** with a download and a delete. A user page keeps only
the connection labels and module ids its buttons use, never a connection's address, config or secrets.

### 0.36.0 (fork 0.36.0, PV Companion "Control Center pages" round 2)

* **Pictures in the list.** Every page in **Control Center pages** shows a small picture of its keys (strip and knobs
  too on a + / + XL). PV Companion's server fetches it from `GET /api/companion/catalog/preview.png`.
* **PTZ camera row.** Only cameras that exist get a key, named after the camera. With one camera there is one camera
  key; the CAM 2 (green) / CAM 3 (red) keys of the design are gone, and so are ◂ CAM / CAM ▸ and the CAMS bank key.
  Live preview / program tally still colours a camera key.
* **Two of a kind.** With PTZ 1 and PTZ 2 (or two ATEMs ...) armed, page titles start with the system's name, and the
  HOME key on each system page shows that name too.
* **Navigating between placed pages.** **Place every page** (per deck size) puts HOME and every system page on
  Companion pages in a row and turns their HOME / page / system keys into Companion page jumps, so the Stream Deck
  moves between them with no Surfaces-tab change. **Whole deck** is still the one-page way: place it once on the page
  the Stream Deck shows, and Control Center's own HOME and page keys change what it shows.
* **Restyle a copy.** Tick **My own look** before placing to leave out the Control Center deck look, so text and colours
  edited in Companion show (the keys still run Control Center). Without it, the deck look paints Control Center's
  picture over the key; remove the "Control Center deck look" feedback from one key to restyle just that key.

## Old rs6-presets connections

A connection on the old module id `rs6-presets` runs the pre-0.10 code, which has none of the CC buttons and pages.
Companion only offers the move to `pvllc-control-center` (its `legacyIds`); it does not move it by itself. In stock
Companion edit the connection and change its module to Performance Video Control Center (import module 0.11.0 or newer
first). PV Companion ships the module built in and moves `rs6-presets` connections at start-up.

## Deck pages and touch-strip displays in Companion (0.32.0)

Up to 0.31.2 Companion only got the BUTTONS / PAGES library (`GET /api/companion/buttons`). The pages a USB
Stream Deck shows — HOME, the PTZ paint / preset / lens pages with their knobs, the ATEM switcher page, CONSOLE —
are built at run time by `lib/decks/faces.js` for a deck session and were never in that library, so Companion
could not show them. From 0.32.0:

* Every surface size has one Control Center **virtual deck**, `companion-<surface>` (`plusxl`, `plus`, `xl`, `mk2`).
  A Companion key on it calls `POST /api/companion/deck/:surface/key` (`press` / `release`); a knob or a touch-strip
  cell calls `POST /api/companion/deck/:surface/dial` (`rotate` with `ticks`, `down` / `up` for push and long-press
  reset, `tap` for the strip). Control Center runs the same press / release / turn as a USB deck of that size, so
  HOME, system and page keys, holds, the ATEM shift and the R / B gain pair steps behave the same.
* `pin: "ptz.0"` (system.page) moves that virtual deck to one page before the press, for page presets that stay on
  one page. No pin: the deck follows its own navigation (the "whole deck" page).
* `GET /api/companion/deck[?surfaces=plusxl][&since=<rev>&timeout=<ms>]` returns, per surface, what the deck shows
  now (`live`) and every system page (`pages`), as key text and colors and, for each knob, the touch-strip readout
  (label and live value, e.g. `R GAIN +12` / `B GAIN -3`, the active side marked `>`). `widgets` has every PTZ dial
  as a standalone display; `POST /api/companion/dials/:widget` turns one without a page. `rev` is a hash of the
  answer; with `since` the request waits until something changes. `layoutRev` changes only when the set of presets would.
* `GET /api/companion/deck/:surface/companionconfig[?pin=ptz.0]` downloads a Companion page file. The COMPANION tab
  lists them under **DECK PAGES**. On a + / + XL the strip readouts are on the row under the keys and the knobs on
  the row under that, the same rows as Steven's Companion fork page layouts.
* The Control Center module 0.12.0 draws all of this (`cc_deck_look`) and publishes presets under **CC deck**.
