# DECKS

**DECKS** is a top-row tab, next to **SCOPES**. It maps pages from the systems currently on the desk
onto Stream Decks that are plugged in.

The list of decks comes from the Path C plugin (`com.performancevideo.control`). Control Center
does not invent a device. If the plugin is not running, the list is empty.

## What you see

* Each connected deck: name, model, online or offline, and the pages loaded on it.
* A page library for the systems on the desk (RS6, ATEM, PTZ, E2, PixelHue, Pixera, Millumin).
  Mini keys are sized to that deck (Mini, MK.2, Neo, XL, +, + XL).
* The selected deck's page stack. Drag a row, or use the arrows, to reorder it.
* **PUSH** sends that stack to the selected deck.
* **DEPLOY ALL ON DESK** pushes every online deck that has a stack. Offline decks and empty stacks
  are skipped.

A key that jumps to a page not on that stack is listed in amber before you push. The push still
goes through. On the deck, pressing that key does not change page.

## How a push is stamped

Templates name the action (`TAKE`, preset `1`, PTZ iris, and so on). The push copies the live
connection into the page: for PTZ, the selected camera's id, name, and IP. Change the camera on
the PTZ page and push again to stamp the new one.

PTZ pages use the profiles **PTZ Live**, **PTZ Paint**, **PTZ Functions**, and **PTZ Move** when
those profiles are installed. Other systems paint the keys that are already on the deck.

## The plugin API

The plugin listens on `127.0.0.1:9721` (loopback only).

| | |
|---|---|
| `GET /v1/health` | Plugin is up |
| `GET /v1/devices` | Connected Stream Decks |
| `POST /v1/deploy` | `{ "deviceId", "pages" }` — device id is in the body, because Elgato ids contain slashes |

Control Center calls that API. Override the address Control Center uses with `RS6_DECK_PLUGIN`
(default `http://127.0.0.1:9721`). On the plugin, `RS6_DECK_PLUGIN_PORT` and `RS6_DECK_PLUGIN_HOST`
change the listen address. `RS6_DECK_PLUGIN_LAN=1` accepts clients that are not on loopback.

When the plugin starts it tells Control Center `POST /api/decks/hello` with its URL. The device
list Control Center shows is always a fresh `GET /v1/devices`, not the hello body.

The Companion file under **SYSTEMS → STREAM DECK PAGES** is a separate export. **DECKS** does not
build it and does not deploy through Companion.

A mock deck exists only in `test/decks.test.js`, as a stand-in for hardware the test machine does
not have. The server path in production is the plugin HTTP API above.

## ATEM switcher

The + XL switcher page is JSON (`lib/decks/pages/atem-switcher.page.json`). See `docs/key-class.md`. Other deck sizes are not changed.

| Row | Keys |
|---|---|
| 1 | HOME, ATEM INFO (name and IP), one blank, SWITCHER, ROUTER, AUDIO, KEYS/SS, MULTIVIEWER, TRANS SELECTION |
| 2 | seven flex keys, MACRO/SHIFT, CUT |
| 3 | program slots 1–8, TRANS (auto) |
| 4 | preview slots 1–8, SHIFT |

A flex key is blue for a macro, magenta for a memory, and dark grey when empty. MACRO/SHIFT cycles banks 1 through 4. Banks 2–4 turn that key yellow and show the bank number. SHIFT stays on, including after you leave the page, and shows slots 9–16. Program keys are muted red, and the source on program is bright red. Preview keys are muted green, and the source on preview is bright green. Names are the ATEM long names, wrapped. CUT and TRANS are solid red and turn lighter while a transition runs.

Hold a flex, program, or preview key and turn encoder 6. Release saves the mapping. One map is shared by every M/E unless the ATEM view has per-M/E bus mapping.

The strip is not a PTZ knob. It shows the M/E number, mix/wipe/DVE, a wipe picture, auto time in frames, a vertical T-bar, and the mapping you are editing (blank if you are not holding a key).

Hold TRANS SELECTION and the strip becomes the next-transition targets: background, the keyers on this M/E, downstream keyers only when M/E 1 is selected, and one touch target per M/E. The strip is outlined and the encoders do nothing. CUT and TRANS run on every M/E you selected.

Tap INFO for the info page. Hold INFO for config.

## Page layouts

The deck pages follow the console surface design (the 21-page gallery, plus the
detail/chroma and gamma/knee RCP banks from the paint section).

| Page | Where it sits |
|---|---|
| PTZ paint MSU, RCP EXP, WHITE/BLACK, DTL/CHROMA, GAMMA/KNEE, MATRIX | PTZ deck |
| PTZ presets, list and matrix | PTZ deck |
| PTZ lens | PTZ deck. Native on Stream Deck + |
| ATEM switcher on + XL, then companion, backup, memories, router | ATEM deck. Other models keep their previous ATEM pages |
| Videohub XY, flex, quick panel | Videohub deck |
| E2 presets and flex | E2 and PixelHue decks |
| Mitti cue grid, flex, playback | Mitti and Pixera decks |
| HyperDeck flex and transport | HyperDeck deck |
| OS page and Companion rows | Console deck |

A deck whose size matches the drawing (9×4, 8×4, or 4×2) gets that grid.
Mini, Neo, MK.2, and any other size keep the same keys in the same order,
with HOME at the top left and PAGE in the corner so every page can be reached.

These are the places the drawing could not be copied literally:

* One PTZ card is one camera, so the MSU dials are that camera's paint knobs, not six different cameras.
* Pan and tilt on the Stream Deck + are speed knobs. The deck has no joystick.
* ND, picture level, and the matrix axes share the nearest existing knob.
* GANG, COPY, COMPARE, and FOLLOW PVW are labeled. There is no command behind them yet.
* The preset matrix keeps HOME at the top left, so that corner is not a camera key.
* Adapted pages use the corner for PAGE. ALL STOP and GO stay in the corner only on the native grid.
* RS6 keeps the memory pad. The design has no RS6 page.
* Companion rows are drawn here and do nothing until Companion owns those keys.

## Key style

The pictures follow the console surface rules:

| | |
|---|---|
| Gray | a normal device key |
| Blue | a selected device key, or a page key inside a system |
| Green | preview |
| Red | on air only. Red is not used for a warning |
| Amber dashed | a guarded key (ALL STOP, and anything you have to hold) |
| Slate, light bar, inner frame | a Control Center key |

Control Center keys are the home page, the HOME key, the console page (shows, status, reconnect, alerts, lockout, power), and the system switcher. They use a slate fill (`#243044`), a light bar, and a second inner frame. Device keys do not. HOME is the word HOME. On a PTZ page that same key also shows the camera the deck is controlling, and the LCD strip shows that name. Both update when the camera changes.

A stepped key (ND, D.EXT, gain, shutter, white balance, and every other list) wraps. The step past the last value comes back to the first. A long press steps the other way. A plain number, such as iris, still stops at the end of its range.

Pan, tilt, zoom, and focus start slow and ease in while the key is held. A dial stays at one camera step until the turn is clearly fast, then eases up. The numbers are `ACCEL`, `OVERRIDES`, and `HOLD` in `lib/paint-accel.js`. Pass another cfg into `stepsFor`, `holdGain`, or `velocityFor` to try a different curve.
