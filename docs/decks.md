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
