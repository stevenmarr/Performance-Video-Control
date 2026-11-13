# HTTP and stream API reference

Documented from the code on the default branch `performance-video-control`, v0.29.3, commit 251a29d9049c53723210ea0e1ab057dfcd3a6ef2. Only what the code registers is listed. Fields that are large or built from live desk state are summarized by their top-level keys. Anything not shown clearly in the handler is marked unverified.

The app listens with `node server.js`. Default port is 8080 (`--port` or `PORT`). Default bind is `0.0.0.0` (`--host` or `HOST`). Data lives in the directory from `lib/datadir.js` (`--data` or `RS6_DATA_DIR`). `--mock` starts in-process simulators.

Most JSON routes are registered in `lib/server.js` (`createServer`) and `lib/core/routes.js`. Scopes routes are mounted later by `lib/scopes/service.js` (`attachScopes` in `server.js`). The Path C plugin API is a separate HTTP server, usually on `127.0.0.1:9721`.

## Conventions

- Request body, when present, is JSON. Invalid JSON returns 400 `{ "error": "Invalid JSON body" }`.
- A successful handler return is 200 with that value as JSON. If the handler returns `undefined`, the body is `{ "ok": true }`.
- A thrown error becomes `{ "error": "<message>" }`. The status is `e.status` if set, otherwise 400. Some call sites use 404, 409, 423, 502, or 503.
- A return of `{ "__binary": { "type", "body", "cache?" } }` is sent as raw bytes (PTZ snapshot and thumbnail).
- A return of `{ "__download": { "name", "body" } }` is a JSON file download (`Content-Disposition: attachment`).
- Many `/api/sys/*`, `/api/decks/*`, cues, looks, ATEM desk, TSL, and core routes are registered only when a `SystemManager` is passed to `createServer`. That is the normal app start. A server created without `systems` does not have those routes (404).
- `:sys` in paths below is an instance id: family key, or family plus a suffix, matching `((?:rs6|e2|pixelhue|atem|ptz|pixera|millumin|videohub|hyperdeck|mitti)(?:-[a-z0-9]{4,12})?)`. `:atem` and `:ptz` are the same pattern limited to those families. `:id`, `:n`, and similar are as written in the regex.

Route counts from this tree: **209** `route()` registrations in `lib/server.js` and `lib/core/routes.js`, plus **GET /api/health** and **GET /api/events** handled in the request function, plus **4** scopes HTTP routes and **2** WebSocket upgrades mounted by `attachScopes`. The Path C plugin adds **3** routes on its own port. Long-poll uses the same paths as the matching GET routes when `?since=` is present; those are not extra path registrations.

---

## Health, version, events, and long-poll

Source for the special-cased handlers: `lib/server.js` (the `http.createServer` callback). Version is a normal `route()`.

### GET /api/health

Liveness for systemd and clients. If the OS core is attached, returns `os.health()` and uses HTTP 503 only when that object has `ok: false` (core tick stalled for 20 seconds). Devices being down does not fail this check. Without the core, the body is `{ ok, status: "ok", version, uptimeSec }`. Source: `lib/server.js`, `lib/core/index.js` (`os.health`).

### GET /api/version

Returns `{ app: "rs6-presets", appVersion, apiVersion, features, showVersion, tileCounts }`. `apiVersion` is 9 in this tree. `features` is the list in `lib/engine.js`. Source: `lib/engine.js` `versionInfo()`.

### GET /api/host-memory

Process and host memory/CPU snapshot: `{ appRss, appHeap, cpuPct, cpus, sysTotal, sysFree, sysUsed }`. Source: `lib/server.js`.

### GET /api/events

Server-Sent Events stream. Headers: `text/event-stream`, `retry: 2000`. The first messages are `event: state` with `engine.getState()`, then `event: sys` with `systems.getState()` if systems exist, then `event: core` with `os.snapshot()` if the core exists. Later events:

- `state` — RS6 engine state (debounced).
- `sys` — systems desk state (debounced). Also follows some RS6 state changes.
- `core` — OS snapshot, with the `sys` burst when the core is present.
- `log` — engine log entries.
- `ping` — heartbeat `{ t, rev }` on an interval (`RS6_SSE_HEARTBEAT_MS`, default 10000).

Source: `lib/server.js`.

### Long-poll (same paths, query required)

These are handled before the `route()` table when `?since=` is present:

| Path | Waits until | Body |
|---|---|---|
| GET /api/state?since=&timeout= | `engine.rev > since` | `engine.getState()` |
| GET /api/sys?since=&timeout= | `systems.rev > since` | `systems.getState()`, or that plus `views` when `views=all` |
| GET /api/core?since=&timeout= | `systems.rev > since` | `os.snapshot()` |
| GET /api/deck/ptz?since=&timeout= | `systems.rev > since` | `systems.deckSnapshot()` |

`timeout` is clamped 0–60000 ms, default 25000. If the client disconnects, the wait is cancelled. Source: `lib/server.js`.

---

## Core / OS

Mounted by `lib/core/routes.js` when `systems.os` exists. Persistence for profiles and Companion connections is `<dataDir>/console.json` (`lib/core/persist.js`).

### GET /api/core

OS snapshot: `{ rev, modules, instances, console, feedbacks, companion, surfaces, transitions, actions, transport, macros }`. `console` is the flat feedback map. `actions` is the recent dispatch log, not the action catalog. Source: `lib/core/index.js` `os.snapshot()`.

### GET /api/core/modules

`{ modules }` from `os.catalog.list()`. Each module has `id`, `label`, `kind`, `status`, `actions` (id list), `feedbacks` (id list). Source: `lib/core/sdk.js`.

### GET /api/core/feedbacks

`os.feedbacks()`: `{ flat, connection, alerts, service, panel, host }`. `flat` is a map of feedback ids to values (`focus.name`, `health.alert`, `panel.locked`, and so on). Source: `lib/core/index.js`.

### GET /api/core/transitions

`{ transitions }` — last 80 core log transitions. Source: `lib/core/log.js`.

### GET /api/core/actions

**Console module only**, not the full catalog. Returns `{ actions, feedbacks, values }` from `os.catalog.get("console")` plus `os.feedbacks().flat`. Source: `lib/core/routes.js`.

### GET /api/core/surfaces

`os.surfaces.snapshot()`: `{ active, name, profiles, bindings, focus }`. A binding is `{ id, surfaceId, region, owner, instanceId, companionId }`. `owner` is `"native"` or `"companion"`. `region` may be omitted (whole deck), or `{ row: [from,to], col: [from,to] }`, or `{ keys: [{col,row}] }`. Source: `lib/core/surfaces.js`.

### POST /api/core/surfaces/bind

Body is a binding (`surfaceId` required; optional `region`, `owner`, `instanceId`, `companionId`, `id`). Returns the cleaned binding. A whole-deck Companion binding causes Control Center to release USB for that deck. A region binding keeps USB and reserves those keys. Source: `lib/core/surfaces.js` `bind`, `lib/core/persist.js` `cleanBinding`.

### POST /api/core/surfaces/focus

Body `{ surfaceId, instanceId }`. Sets or clears which instance that surface is focused on. Returns the focus map. Source: `lib/core/surfaces.js` `setFocus`.

### POST /api/core/surfaces/profiles

Body `{ id, name }`. Copies the current profile to `id` and activates it. Returns a snapshot. Source: `saveAs`.

### POST /api/core/surfaces/profiles/:id/load

Activates profile `:id`. 404 if missing. Returns a snapshot.

### DELETE /api/core/surfaces/bind/:id

Removes that binding. 404 if missing. Returns `{ ok: true }`.

### GET /api/core/companion

`{ connections: [{ id, moduleId, label, host, port, note, feedback }] }`. `feedback` is the last posted live object or null. Source: `os.companionSnapshot()`.

### POST /api/core/companion/connections

Body needs `moduleId`. Optional `id`, `label`, `host`, `port`, `note`. Returns the cleaned connection. Source: `os.addCompanion`.

### DELETE /api/core/companion/connections/:id

404 if missing. Returns `{ ok: true }`.

### POST /api/core/companion/feedback

Body `{ id, status?, variables?, buttons? }`. Stores live feedback for that connection (max packed size 32000). Returns `{ ok, id, at }`. Triggers a systems change. Source: `os.companionFeedback`.

### POST /api/core/companion/satellite

Body `{ url }`. HTTP or HTTPS URL that receives reserved-key presses. Empty URL clears it. Stored on `console.json`. Returns `{ url }`. Source: `os.setSatellite`.

### POST /api/core/companion/satellite/keys

Body `{ surfaceId, keys: [{ col, row, label, caption, tone }] }`. Sets labels drawn on reserved Companion keys (up to 80). Returns `{ ok, surfaceId, keys }` (count). Source: `os.satelliteKeys`.

### POST /api/core/cmd/:action

One command path. `:action` matches `[a-z][\w.]*`. Body is the command input (often `{ instance }`, plus command-specific fields). Guarded actions may return `{ armed: false, pending: true, confirm, word, until }` on the first press. The implemented console actions are listed in `docs/architecture-core.md` and `lib/core/sdk.js` (focus, profile, show, connection, module, health, service, host, panel). Unknown actions are 404. A locked panel rejects commands other than the allow-list in `lib/core/index.js` `META` with 423. Source: `os.command` → `lib/core/dispatch.js`.

---

## Systems desk

Source: `lib/server.js` (the `systems` block) and `lib/systems.js`. `:sys` is the instance id described above.

### GET /api/sys

Desk state: `{ rev, active, armed, systems, instances, groups, planned, migrated, instanceMigration, view }`. `systems` is one record per family (status, counts, capabilities, connection). `view` is the focused non-primary-RS6 view, or null. Query `?since=` is long-poll (see above). Query `?views=all` on the long-poll form adds `views`. Source: `SystemManager.getState()`.

### GET /api/sys/views

`{ rev, active, views }` where `views` is every configured system's view. Source: `allViews()`.

### POST /api/sys/active

Body `{ system }`. Focus that instance; add it to the desk if needed. Return value is whatever `setActive` returns. Unverified in full beyond the call.

### POST /api/sys/armed

Body `{ system, on }`. `on` defaults true. Adds or removes one instance. Others stay.

### GET /api/sys/instances

`{ instances }` from `listInstances()`.

### POST /api/sys/instances

Body `{ type, ... }`. Adds an instance of that family. Return is the new instance record (shape unverified beyond `addInstance`).

### POST /api/sys/instances/:id/rename

Body `{ name }`.

### POST /api/sys/instances/:id/duplicate

Duplicates that instance.

### POST /api/sys/instances/:id/disconnect

Holds the link down.

### POST /api/sys/instances/:id/connect

Connects, then returns `instancePublic(id)`.

### POST /api/sys/instances/:id/simulate

Body is simulator options (ATEM may include `{ model }`). Puts the instance on a loopback fixture. Not saved.

### DELETE /api/sys/instances/:id

Removes the instance.

### GET /api/sys/:sys

`systems.view(s)` for that instance. Shape depends on family (ATEM buses, PTZ cameras, media transport, and so on). Unverified field-by-field here.

### POST /api/sys/:sys/simulate

Same idea as the instance simulate route, using the path id.

### POST /api/sys/:sys/save

Body may include `{ startup: false }` to skip ATEM startup-state save. Saves the show to the library and, on an ATEM, startup state unless skipped.

### POST /api/sys/:sys/connection

Body is a connection patch (host, port, and family-specific fields). `updateConnection`.

### POST /api/sys/:sys/connect

Connects, then returns `view(s)`.

### POST /api/sys/:sys/refresh

Refreshes, then returns `view(s)`.

### POST /api/sys/:sys/selection

Body `{ destinations }`. Returns `{ selection }`.

### POST /api/sys/:sys/destinations/:dest/toggle

`:dest` matches `[SAsa]\d+`. Returns `{ selection }`.

### POST /api/sys/:sys/presets/:key/recall

Body `{ target }` is `"program"` or defaults to `"preview"`. `:key` is URL-decoded.

### POST /api/sys/:sys/presets/:key/followup

Body `{ followUp }`. Per-preset auto-recall. `followUp` may be null (inherit), `0` (off), a target key, or an object. Exact object shape: see comments at `lib/server.js` and `setFollowUp`. Some cases unverified here.

### POST /api/sys/:sys/followup

Body `{ enabled, default, delayMs, groups }`. Show-wide auto-recall defaults.

### POST /api/sys/:sys/presets/swap

Body `{ a, b }` or `{ from, to }`.

### POST /api/sys/:sys/layout/reset

Returns `{ ok: true }`.

### POST /api/sys/:sys/take

Runs take. Also releases a running cue timeline for that system (`releaseCue`).

### POST /api/sys/:sys/cut

Runs cut. Also releases a running cue timeline.

### POST /api/sys/:sys/autotake

Body `{ value }`. Returns `{ autoTake }`.

### POST /api/sys/:sys/tiles

Body `{ tileCount }`. Returns `{ tileCount }`.

### POST /api/sys/:sys/cues/:n/play|pause|stop

E2-style cue control. `:n` is a cue index.

### POST /api/sys/:sys/freeze

Body `{ kind, id, on }`.

### POST /api/sys/:sys/aux/:aux/source

`:aux` matches `[Aa]\d+`. Body `{ source, target }` (`target` is `"program"` or `"preview"`).

### POST /api/sys/:sys/backups/:n

Body `{ slot }`.

### POST /api/sys/:sys/stills/take

Body `{ input, file }`.

### DELETE /api/sys/:sys/stills/:n

Deletes still index `:n`.

Which of these family-shared routes a given system actually implements is determined inside `SystemManager`. A call on the wrong family may 404 or 409. Unverified per family in this document.

### GET /api/ui-prefs

`{ prefs }` — per-install UI preferences.

### POST /api/ui-prefs/:key

Body `{ value }`. `null` deletes the key. `:key` matches `[\w.:-]+`.

---

## ATEM (system commands, layouts, models)

ATEM instance routes use `:atem` (`atem` or `atem-xxxx`). Commands go through `systems.atem()` and `lib/core/dispatch.js`.

### GET /api/sys/atem/models

`{ default, models, simulator }`. Simulator picker profiles. Source: `systems.atemModels()`, `lib/drivers/atem-models.js`.

### GET /api/sys/:atem/ss-layouts

`{ layouts }` — built-in plus saved SuperSource layouts for that instance.

### POST /api/sys/:atem/ss-layouts

Body `{ name, boxes? }` or `{ name, ss? }`. If `boxes` is omitted, captures the current SuperSource. Needs a connected ATEM in that case (409). Returns the saved layout (shape unverified beyond `saveSsLayout`).

### DELETE /api/sys/:atem/ss-layouts/:id

### GET /api/sys/:atem/layout-presets

`{ presets }`

### POST /api/sys/:atem/layout-presets

Body includes layout fields plus `instance` is taken from the path.

### DELETE /api/sys/:atem/layout-presets/:id

### GET /api/sys/:atem/mv-salvos

`{ salvos }`

### POST /api/sys/:atem/mv-salvos

### DELETE /api/sys/:atem/mv-salvos/:id

### POST /api/sys/:atem/layout-macro

Builds a layout macro and saves it on the ATEM desk. Body is the layout-macro input (includes optional `acknowledgeOpaque`). Returns `{ ok, macro: { index, name, steps }, xml, note, skipped }`. Source: `systems.layoutMacro`, `AtemDesk.saveMacro`.

### POST /api/sys/:atem/mv-salvo-macro

Same pattern for a multiview salvo. Returns `{ ok, macro, xml, note }`.

### POST /api/sys/:atem/cmd/:name

Body is command options. `me` is 1-based (default: the connection's M/E). Key, DSK, aux, MV, window, SuperSource, and box indexes are 0-based where used. Returns `{ ok: true, ... }` or `{ ok: true }`. Unknown `:name` is 404. Not connected is 409. `cut` and `auto` also release a cue timeline. `macroRecord` / `macroStopRecord` arm or disarm the ATEM desk recorder.

Implemented command names in `systems.atem` (`lib/systems.js`):

`cut`, `auto`, `program` (`source`), `preview` (`source`), `style`, `mixRate` (`rate`), `transitionPosition` (`handle` or `position`), `wipePattern` (`pattern`), `ftb`, `ftbRate`, `nextSelection` (`selection`), `uskTie`, `uskOnAir`, `dskAuto`, `dskOnAir`, `dskTie`, `aux` (`aux`, `source`), `macroRun` (`macro`), `macroStop`, `macroRecord`, `macroStopRecord`, `macroUserWait`, `macroContinue`, `route` (`output`, `source`), `mvSource`, `mvProps`, `mvVu`, `mvSafe`, `uskType`, `uskSources`, `uskLuma`, `uskChroma`, `uskPattern`, `uskMask`, `uskDve`, `uskFlyStore`, `uskFlyRun`, `dskSources`, `dskGeneral`, `dskMask`, `dskRate`, `ssBox`, `ssProps`, `ssBorder`, `ssLayoutRecall`, `layoutApply`, `mvApply`, `mvSalvoRecall`, `layoutRecall`, `audioInput`, `audioMute`, `audioNudge`, `audioMaster`, `audioMasterNudge`, `audioMonitor`, `audioHeadphones`, `audioSolo`, `audioMuteAll`, `audioDeskZero` (requires `{ confirm: true }`), `audioRoute`.

---

## PTZ

PTZ instance routes use `:ptz` (`ptz` or `ptz-xxxx`). Commands go through `systems.ptz()`.

### POST /api/sys/:ptz/cameras

Adds a camera. Body is the camera record (id, name, host, port, login, and so on). Exact required fields: see `addCamera` (not fully expanded here; unverified field-by-field).

### POST /api/sys/:ptz/cameras/:cam/sim

Body `{ on }`. `on` defaults true. Puts that camera on the simulator.

### POST /api/sys/:ptz/cameras/:cam

Updates camera `:cam`.

### DELETE /api/sys/:ptz/cameras/:cam

### POST /api/sys/:ptz/cmd/:name

Body usually includes `{ cam }`. If `cam` is omitted, the selected camera or the first camera is used. Default instance if the path were not present would be `"ptz"`; the route passes `instance` from the path. Returns `{ ok: true, ... }`. Unknown `:name` is 404. Paint lock is 423. Live-guard blocked recalls are 423.

Implemented command names: `move` (`pan`, `tilt`, optional `speed`), `zoom` (`dir` or `value`), `focus`, `keepalive`, `stop` (`axes`), `op` (`op`, `value` — any catalog command), `step` (`op`, `steps`), `reset` (`op`), `stopAll`, `notes` (`text` or `notes`), `lock` (`on`), `paintSave` / `paintLoad` / `paintClear` (`slot` 1–N, optional `name` on save), `home`, `recall` (`preset`, optional `guarded`, `confirmed`, `speed`), `store` (`preset`, `name`), `rename` (`preset`, `name`), `power` (`on`), `tally` (`on`, `color`), `autoFocus`, `oneTouchAF`, `iris` (`value`), `autoIris`, `gain`, `shutter`, `whiteBalance`, `select`, `guard` (`mode`, `holdMs`; `mode` may be `cycle`), `speeds` (`pt`, `zoom`, `focus`), `refresh`.

Catalog of camera `op` ids: `GET /api/sys/:ptz/cameras/:cam/catalog` and `lib/drivers/ptz-commands.js`.

### GET /api/sys/:ptz/cameras/:cam/catalog

`{ camera, instance, model, ...catalog, sources }`. Command list, ranges, and value sources for that model.

### GET /api/sys/:ptz/cameras/:cam/status

Rate-limited poll (250 ms), then that camera's row from `ptzView`.

### GET /api/sys/:ptz/cameras/:cam/snapshot

Raw JPEG (or whatever the camera returns). `Cache-Control: no-store`.

### GET /api/sys/:ptz/cameras/:cam/info

`systems.ptzInfo(cam, inst)`. Shape unverified beyond the call.

### GET /api/sys/:ptz/cameras/:cam/thumbnail/:n

Raw image for preset `:n`.

---

## Pixera, Millumin, Videohub, HyperDeck, Mitti

All of the form `POST /api/sys/<family-or-instance>/cmd/:name`. Body is mixed into the driver call. Not connected is 409. Unknown command is 404. Returns `{ ok: true, ... }`.

### Pixera — POST /api/sys/:pixera/cmd/:name

`:pixera` is `pixera` or `pixera-xxxx`. Commands: `transport` (`mode`, optional `handle`), `nextCue`, `prevCue` (optional `ignore`), `applyCue` (`timeline`, `cue`, `index`, `blend`), `select` (`handle`), `refresh`. Source: `systems.pixera`, `lib/drivers/pixera.js`.

### Millumin — POST /api/sys/:millumin/cmd/:name

Body `{ value }` (also accepts `column` or `name` as the value). Commands from `lib/drivers/millumin.js`: `launchColumn`, `launchOrStopColumn`, `stopColumn`, `nextColumn`, `previousColumn`, `play`, `pause`, `playOrPause`, `goToTime`, `goToSegment`, `selectBoard`, `selectLayer`, `selectLight`, `enterFullscreen`, `exitFullscreen`, `displayTestCard`, `hideTestCard`, `startMedia`, `pauseMedia`, `startOrPauseMedia`, `stopMedia`, `mediaTime`, `mediaSpeed`, `opacity`.

### Videohub — POST /api/sys/:videohub/cmd/:name

Only `crosspoint` is implemented. Body `{ output, input }` (0-based). Source: `systems.videohub`.

### HyperDeck — POST /api/sys/:hyperdeck/cmd/:name

`record`, `play`, `stop`, or `preview`. Source: `systems.hyperdeck`, `lib/drivers/hyperdeck.js`.

### Mitti — POST /api/sys/:mitti/cmd/:name

Commands from `lib/drivers/mitti.js`: `play`, `stop`, `pause`, `toggle`, `next`, `prev`, `cue` (index in `value` or `cue`), `cueName`.

---

## RS6 engine (legacy /api paths)

These talk to the original RS6 Engine (`lib/engine.js`, `lib/live.js`). They are not instance-suffixed. TAKE/CUT here also call `releaseCue("rs6")`.

### GET /api/state

Full engine state. Top-level keys include `app`, `version`, `appVersion`, `apiVersion`, `rev`, `tileCount`, `show`, `dataDir`, `dataMigration`, `mock`, `connected`, `lastError`, `system`, `settings`, `autoTake`, `followUp`, `destinations`, `multiviewers`, `selection`, `transitionTargets`, `staging`, `memories`, `master`, `lastRecalled`, `programPresets`, `presets`, plus further live/tally fields in the same object. The full field set is large; see `Engine.getState()`. Long-poll: `?since=`.

### GET /api/live

`engine.live.status()`.

### GET /api/inputs

`live.inputsView()`.

### GET /api/tally

`{ source, inputs, presets: { preview, program }, destinations }` drawn from engine state and live tally.

### GET /api/memories

Live memories view plus `catalog` from `engine.memoryCatalog({ all })`. Query `?all=1` includes empty/unknown slots.

### GET /api/memories/catalog

Just the catalog. Same `?all=1`.

### POST /api/memories/refresh

`engine.refreshMemories()`.

### POST /api/memories/load

Body `{ type, slot, dest, target }`. `type` defaults `"screen"`, `target` defaults `"preview"`. Source: `loadMemoryNow`.

### GET /api/stage

Current staging board (`engine.getState().staging`).

### POST /api/stage

`engine.stage(body)`.

### DELETE /api/stage

Clears the staging board.

### POST /api/stage/load

`engine.loadStage(body)`.

### POST /api/stage/save

`engine.saveStage(body)`, then the preset view wrapper `V(...)`.

### POST /api/stage/from/:n

Stages from preset `:n`.

### POST /api/presets/:n/assign

Body is assigned onto preset `:n`. Returns the preset view.

### GET /api/backup

`live.backupView()`.

### GET /api/audio

`live.audioView()`.

### POST /api/inputs/:n/freeze

Body `{ value }` (or toggle). Returns `{ ok: true, value }`.

### POST /api/inputs/:n/backup

Body `{ slot }`.

### POST /api/inputs/:n/backup/mode

Body `{ auto }`.

### POST /api/backgrounds/:screen/:n/backup

`:screen` matches `S\d+`. Body `{ slot }`.

### POST /api/backgrounds/:screen/:n/backup/mode

Body `{ auto }`.

### POST /api/groups/:n/backup

Body `{ slot }`.

### POST /api/groups/:n/backup/mode

Body `{ auto }`.

### POST /api/audio/:side/:n/channels/:ch/mute

`:side` is `inputs` or `outputs`. Body `{ value }`.

### GET /api/log

`engine.logs`.

### GET /api/settings

`engine.publicSettings()` — settings with the password replaced by `passwordSet`.

### POST /api/settings

Body is a settings patch. Updates settings, then `engine.connect()`, then returns `getState()`.

### POST /api/connect

Connects the Engine, returns `getState()`.

### POST /api/destinations/refresh

Same as connect: `engine.connect()` then `getState()`.

### POST /api/destinations/:dest/toggle

`:dest` matches `[SAsa]\d+`. Returns `{ selection }`.

### POST /api/selection

Body `{ destinations }`. Returns `{ selection }`.

### POST /api/capture

Body `{ destinations? }`. Captures memories for those destinations (or the current selection). Returns `{ memories, warnings }`. Exclusive lock on the engine.

### POST /api/presets

Saves a preset from the body. Returns the preset view.

### GET /api/presets/:n

That preset, or 404 `{ error: "not found" }`.

### POST /api/presets/suggest-name

Body is content about to be saved (`memories`, `master`, `mvMemories`, …). Returns `{ name }`.

### PUT /api/presets/:n

Edits preset `:n`. Returns the preset view.

### POST /api/presets/:n/followup

Body `{ followUp }`.

### GET /api/followup

`engine.followUpState()`.

### POST /api/followup

`engine.setFollowUpDefaults(body)`.

### DELETE /api/presets/:n

Returns `{ ok: true }`.

### POST /api/presets/:n/recall

Recalls preset `:n`.

### POST /api/presets/:n/update

Updates preset `:n` from the body. Returns the preset view.

### POST /api/presets/swap

Body `{ a, b }` or `{ from, to }`.

### POST /api/presets/:n/duplicate

Body `{ toNumber }`. Returns the preset view.

### POST /api/take

Engine take, and `releaseCue("rs6")`.

### POST /api/cut

Engine cut, and `releaseCue("rs6")`.

### POST /api/autotake

Body `{ value }`. Returns `{ autoTake }`.

### GET /api/webrcs

`engine.checkWebRcs()`, plus `mock`. Used by the Web RCS pane.

---

## Shows

Source: `lib/engine.js`, `lib/shows.js`. Show files use the `.rs6show` extension.

### GET /api/shows

`{ current, shows, backups, dir }`.

### POST /api/shows/save

Body `{ name, asNew, includeConnection, includePassword }`.

### POST /api/shows/new

Body `{ name }`.

### POST /api/shows/upload

Body `{ content, name }`. Imports a show.

### POST /api/shows/preview

Body `{ content }` or `{ id, backup }`.

### POST /api/shows/open

Same locator as preview, plus `{ applyConnection }`.

### GET /api/show/export

Current state as a downloadable `.rs6show`. Query `connection=1` includes connection; `password=1` with `connection=1` includes the password.

### GET /api/shows/:id/file

Download that library show. Query `backup=1` selects the backup copy.

### POST /api/shows/:id/rename

Body `{ name }`.

### POST /api/shows/:id/duplicate

Body `{ name }`.

### DELETE /api/shows/:id

Query `backup=1` deletes the backup. Returns `{ ok: true }`.

---

## Looks (PRESETS tab hi-res stack)

Source: `lib/looks.js`. Not ATEM Software Control memories; this is the Control Center look book.

### GET /api/looks

`{ looks }` filtered by query `?system=` if present.

### POST /api/looks

Body is a look (`id`, `system`, `preset`, `keys`, …). Returns the cleaned look. Field list: see `cleanLook` (not fully expanded; unverified field-by-field).

### DELETE /api/looks/:id

Returns `{ ok: true }`.

### POST /api/looks/:id/recall

Recalls that look to preview (RS6/E2/PixelHue preset recall, or ATEM preview + key on-air). Returns `{ ok, id, target: "preview", absolute: true, steps }`. 404 if missing.

---

## Cues and master cues

Source: `lib/cues.js`, `lib/master-cues.js`. Registered with the systems block.

### GET /api/cues

`{ ...cues.status(), catalog }`. Status includes the selected cue, run state, and the system link.

### POST /api/cues

Save one cue or a list. Body may be `{ cues: [...] }` to replace the list, `{ system }` only to switch the cue system, or a single cue (`id`, `name`, `steps`, `advance`, `bail`, `followUp`, …). Returns status or the annotated cue.

### POST /api/cues/reorder

Body `{ ids }`. Returns status.

### POST /api/cues/select

Body `{ index }`.

### POST /api/cues/system

Body `{ system }`.

### POST /api/cues/go

### POST /api/cues/stop

### POST /api/cues/back

### DELETE /api/cues/:id

404 if missing. Returns status.

### GET /api/master-cues

`masters.status()`. Includes stacked rows and per-cell run state. Exact keys: see `MasterCues.status` (large; unverified field-by-field).

### POST /api/master-cues

`masters.save(body)`.

### POST /api/master-cues/reorder

Body `{ ids }`.

### POST /api/master-cues/stop

### POST /api/master-cues/run

### POST /api/master-cues/ack

### POST /api/master-cues/stacked

Body is the stacked-mode patch (`setStacked`).

### POST /api/master-cues/:id/load

### POST /api/master-cues/:id/go

### DELETE /api/master-cues/:id

### POST /api/master-cues/:id/duplicate

### POST /api/master-cues/:id/clear

---

## ATEM desk (macros and memories in this app)

Source: `lib/atem-desk.js`. This is Control Center's macro editor and memory book, not a substitute for ATEM Software Control files.

### GET /api/atem-desk

Syncs, then `atemDesk.view()`.

### POST /api/atem-desk/sync

### POST /api/atem-desk/macros

`saveMacro(body)`.

### POST /api/atem-desk/macros/add

`addMacro(body)`.

### POST /api/atem-desk/macros/:n/duplicate

### DELETE /api/atem-desk/macros/:n

### POST /api/atem-desk/macros/reorder

Body `{ indexes }`.

### POST /api/atem-desk/macros/:n/play

Body `{ loop? }`.

### POST /api/atem-desk/play/stop

### POST /api/atem-desk/play/continue

### POST /api/atem-desk/record/:n

Arms recording into macro `:n`.

### POST /api/atem-desk/record/stop

Disarms.

### GET /api/atem-desk/sim/:n/:step

Simulates macro `:n` at step `:step` (signed). Returns the simulate result (shape unverified beyond the call).

### POST /api/atem-desk/memories

Body is a name (`b && b.name`) for a capture.

### POST /api/atem-desk/memories/:id

Saves/updates that memory. Body merged with `{ id }`.

### POST /api/atem-desk/memories/:id/recall

### DELETE /api/atem-desk/memories/:id

### POST /api/atem-desk/macros/:n/resolve

Body is resolve options.

### POST /api/atem-desk/macros/:n/restore

### POST /api/atem-desk/macros/:n/commit

### GET /api/atem-desk/xml

`{ xml, note }`. The note says this is a Control Center subset, not verified as an ATEM Software Control file.

### POST /api/atem-desk/xml

Body `{ xml }` or `{ text }`. Imports XML.

---

## Decks and surfaces (Control Center process)

Source: `lib/decks/service.js`, routes in `lib/server.js`. Persistence: `<dataDir>/decks.json` (`pluginUrl`, `stacks`, `loaded`, `sessions`).

### GET /api/decks

`decks.view()`. Body:

```
{
  plugin: { url, online, error },
  devices: [ { id, name, model, type, columns, rows, online, surfaceId, pages, warnings, loaded } ],
  library: { mini|mk2|neo|xl|plus|plusxl: [ stamped pages ] },
  surfaces: { ...SURFACES },
  desk: { armed },
  control: { transport: "usb", driver, devices: [ { ..., face } ] }
}
```

`devices` is the Path C plugin list (empty if the plugin is down). `control.devices` is USB decks, or a + XL preview device if none are open. A plugin hello body is not used as the device list; the list is always a fresh `GET /v1/devices`. Source: `DeckService.view`, `lib/decks/surfaces.js`.

### GET /api/surfaces/diag

USB / hidraw diagnostic: Node version, library load, stream decks found, hidraw nodes, holders, open errors, plus a `text` field. Source: `lib/decks/diag.js`. Also runnable as `node tools/deck-diag.js`.

### POST /api/decks/plugin

Body `{ url }`. Must be http(s). Saved on `decks.json`. Returns `{ url }`.

### POST /api/decks/hello

Body may include `{ url }` (same as setPlugin). Then refreshes devices from the plugin (not from `body.devices`). Returns `view()`.

### POST /api/decks/refresh

Calls `decks.refresh()`, which rescans USB (`pollUsb`, one scan) and then re-fetches the Path C plugin device list. Returns `view({ refresh: false })`, so the body has both lists: `devices` is the plugin, and `control.devices` is the USB decks found by that scan. The Control Devices **Scan USB** button posts this route. USB open/scan also continues in the background (`startUsb`, hidraw hotplug, and a timer). After this returns, the client redraws `control.devices` from the view.

### POST /api/decks/stack

Body `{ deviceId, pages }` (array of built-in template page ids, no duplicates) or `{ deviceId, from, to }` to reorder. Unknown new ids are 400. Returns `{ deviceId, pages, warnings }`. This is the Path C stack, not the USB assign-to-system session.

### POST /api/decks/deploy

Body `{ deviceId }` or `{ deviceId, pageId }`. Builds pages from `libraryFor` / `stampPage` / `linkPages` and POSTs them to the plugin `/v1/deploy`. `pageId` is a saved surface page or a built-in id; it is placed first and any built-in ids already on the stack stay. Errors: 400 (no pages / unknown page / empty saved page / surface mismatch), 404 (device not in the plugin list), 409 (offline), 502 (plugin down). Returns `{ ok, deviceId, warnings, loaded, pages, plugin }`. After a successful push, `GET /api/decks` reports that deck's `loaded` titles.

On a Stream Deck + XL, the built-in `atem-switcher` page in that payload is the USB key-class face (`bindSwitcher`), not the packed CUT/AUTO template. `keys` are still the older shape plugin **0.20.0** paints (`label`, `value`, `caption`, `action: { method, path, body }`). `dials` stays one string per column so that plugin does not treat the strip as a paint widget. `keyClass` is the USB face, including its dials. No plugin build in this repo reads `keyClass`; **0.20.0** (`streamdeck/` manifest `0.20.0.0`) ignores it. An XL or any other size still gets the packed `ATEM SWITCHER` page.

A deck key whose action path is `/api/sys/<instance>/cmd/<name>` resolves the instance from that path for ATEM, PTZ, Pixera, and Millumin, the same way Videohub, HyperDeck, and Mitti already did. `<instance>` is `atem` or `atem-` plus 4–12 characters, and the same form for the other five. The HTTP routes above already accepted those suffixes. The button catalog (`GET /api/buttons/catalog`) and a saved page use the same id-to-path mapper.

### POST /api/decks/deploy-all

Deploys every online plugin deck that has a non-empty stack. Returns `{ deployed, skipped }`.

### POST /api/decks/press

Body `{ deviceId, col, row }`. Presses a key on a USB deck (or `deviceId: "preview"`). Returns `{ ok, face }`. 404 if that USB device is not open. 409 if the whole deck is Companion-owned. A Companion-reserved key is forwarded to the satellite URL instead of a native action. There is **no** `POST /api/decks/release` route; release is wired only from the USB host.

### POST /api/decks/assign

Body `{ deviceId, system }`. `system` null or omitted is HOME. The system must be on the desk (or `"console"`). Returns `{ ok, deviceId, system, face }`. 404 if the USB device is not open. This is the Control Devices “pick a system” path.

### POST /api/decks/turn

Body `{ deviceId, index, ticks }`. The HTTP route does **not** pass an `event` name; `DeckService.turn` is called as `turn(deviceId, index, ticks)`. The USB host does pass `event` (`rotate`, `tap`, `push`, `down`, `up`). Returns the turn result (`{ ok }` or a face in some ATEM cases; unverified field-by-field).

### GET /api/deck/ptz

Path C plugin poll of the app's PTZ view, formatted for the deck. Long-poll with `?since=`. Source: `systems.deckSnapshot()`.

### GET /api/deck/ptz/layout

`require("./deck").layout()` — PTZ deck layout used by the plugin. Source: `lib/deck.js`.

---

## TSL tally

Source: `lib/tsl.js`. 404 `{ error: "TSL not available" }` if `systems.tsl` is missing.

### GET /api/tsl

`systems.tsl.status()` — config plus recent send log / receiver state. Field set is large; see `status()`.

### POST /api/tsl

Body is a config patch. Fields cleaned in `cleanConfig`: `transport` (`udp` or `mock`), `enabled`, `host`, `port`, `receivers`, `screen`, `brightness` (0–3), `followPtz`, `addresses`. Then `tick()` is called (errors ignored) and systems is marked changed. Returns `status()`. Simulator sessions refuse a non-loopback UDP target.

### POST /api/tsl/tick

Sends one tick. Returns `{ ...tickResult, status }`.

---

## Scopes (HTTP and WebSocket)

Mounted by `attachScopes` in `server.js`. Source: `lib/scopes/service.js`, `lib/stream-relay.js`, `lib/scopes/ndi-ingest.js`. Settings file: `<dataDir>/scopes.json`. Passwords are never returned (only `hasPassword` / `customHasPassword`).

### GET /api/scopes/sources

`{ sources, settings, mock, ndi, decklinkError }`. Source keys: `decklink:<index>`, `ndi:<id>`, `builtin:<file>`, `test:<file>`, `cam:<id>` or `cam:<instance>:<id>`, `custom`. Live video is Desktop Video (or a legacy NDI sidecar), not an in-process NDI receiver.

### GET /api/scopes/ndi

`{ ...ndiStatus, sources, decklinkError }` where `sources` is the `kind: "ndi"` subset (Desktop Video and sidecar).

### GET /api/scopes/status

`{ relays }` — `relay.stats()` per running source.

### POST /api/scopes/settings

Body `{ testDir?, custom?, customUser?, customPassword?, cameras?: { <camId>: { stream, path, port, user, password } } }`. `stream` is 1–4. `custom` is an `rtsp://` URL or a `.h264` / `.264` / `.mp4` / `.mov` / `.m4v` path. Returns the public settings object. Running relays for changed sources are reopened.

### WebSocket /api/scopes/ws?src=<key>

H.264 relay to the browser. Source: `lib/stream-relay.js`.

Server → browser:

- text `{ "type": "config", codec, description, width, height, fps, fullRange, colour, label }` (`description` is base64 avcC)
- text `{ "type": "status", state, error? }` — `state` is `connecting` | `playing` | `error` | `ended`
- text `{ "type": "pong", t, server }`
- binary: 20-byte header then an AVCC access unit. Byte 0 is 1. Byte 1 flags: 1 = key, 2 = catch-up (decode, do not draw), 4 = replayed from the GOP cache. Then two little-endian float64s: server receive ms, PTS in microseconds.

Browser → server: text `{ "type": "ping", t }`.

A new viewer gets config, then the current GOP with the catch-up flag. Unknown `src` is a 400/404 handshake error, not a JSON route. Loopback vs LAN is not restricted on this socket (unlike ingest).

### WebSocket /api/scopes/ndi/ingest

Mac sidecar (or DeckLink sidecar) push of Annex-B H.264 into the hub. Query: `id` (required, NDI id pattern; `mock-` prefix refused), `name`, `fps`, `kind=decklink`, `device`, `mode`. Default accept is loopback only; `RS6_NDI_INGEST_LAN=1` allows other hosts. 403/400 are plain-text HTTP errors before the upgrade. Source: `lib/scopes/service.js` `ingestUpgrade`, `lib/ndi/ingest-client.js` (client).

Optional HTTPS: if `RS6_TLS_CERT` and `RS6_TLS_KEY` are set, the same HTTP and WebSocket handlers are also served on `RS6_TLS_PORT` (default 8443).

---

## Static pages

Served from `public/` by `lib/server.js`:

- `GET /` → `public/index.html`
- `GET /settings` → `public/index.html`
- `GET /lightning.html` and `GET /lightning` → `public/scopes.html` (old alias; the tab is SCOPES)
- Other paths under `public/` (scripts, CSS, images, `scopes.html`)

Unknown files are 404. Path escape outside `public/` is 403.

---

## Path C plugin API (separate process)

Hosted by the Stream Deck plugin `com.performancevideo.control`, not by `createServer`. Default `http://127.0.0.1:9721`. Override the URL Control Center uses with `RS6_DECK_PLUGIN`. Plugin listen host/port: `RS6_DECK_PLUGIN_HOST`, `RS6_DECK_PLUGIN_PORT`. `RS6_DECK_PLUGIN_LAN=1` accepts non-loopback clients; otherwise 403. Source: `lib/decks/plugin-server.js`, client `lib/decks/plugin-client.js`.

### GET /v1/health

`{ ok: true, plugin: "com.performancevideo.control" }`

### GET /v1/devices

`{ devices: [...] }`. Each device typically has `id`, `name`, `model`, `type`, `columns`, `rows`, `online`. Control Center does not invent this list.

### POST /v1/deploy

Body `{ deviceId, pages }`. Both required (`deviceId` is in the body because Elgato ids can contain slashes). Returns whatever `hardware.deploy` returns (the test adapter returns `{ ok, loaded }`). 404 if the adapter rejects an unknown device.

`pages` is the array built by `DeckService.pagesFor`: stamped `libraryFor()` templates (`id`, `system`, `title`, `profile`, `surface`, `keys` with `row`, `col`, `label`, `value`, `caption`, `action` as `{ method, path, body }`, `jump`, `role`, `device`, plus `dials` and `jumps`). This is **not** the key-class JSON used by the + XL USB ATEM page. See `docs/decks.md` in this folder.

---

## Related files

| Area | Files |
|---|---|
| Router | `lib/server.js`, `lib/core/routes.js`, `server.js` |
| Core | `lib/core/index.js`, `lib/core/sdk.js`, `lib/core/dispatch.js`, `lib/core/surfaces.js`, `lib/core/persist.js` |
| Systems | `lib/systems.js`, `lib/drivers/*` |
| RS6 engine | `lib/engine.js`, `lib/live.js`, `lib/shows.js`, `lib/store.js` |
| Decks | `lib/decks/service.js`, `lib/decks/pages.js`, `lib/decks/surfaces.js`, `lib/decks/plugin-client.js`, `lib/decks/plugin-server.js`, `lib/decks/diag.js` |
| Scopes | `lib/scopes/service.js`, `lib/stream-relay.js`, `lib/scopes/ws.js`, `lib/scopes/ndi-ingest.js` |
