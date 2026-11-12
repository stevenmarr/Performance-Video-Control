# Navigation

The app has two rows of tabs under the header. They are short on purpose: one system row, then at most one page row. Nothing else stacks under them.

## Header

Next to the Performance Video mark and **CONTROL CENTER** is the connection pill for the system you have open: model, software version, address, and **MOCK** when that system is the simulator. It does not repeat the tab name. The old chip that only said **ATEM** (or RS6, PTZ, …) is gone. The tab you are on already says which system that is, and the light on that tab is online / offline / degraded.

**SHOW** is the show file. **APP LINK** is this browser's connection to the app, which is separate from the switcher.

## Row 1: home, system groups, and Scopes

```
[⌂ SYSTEMS] [● RS6] [● E2 / PIXELHUE] [● ATEM] [● PTZ] [● PIXERA] [● MILLUMIN] [SCOPES] [CUES] [PRESETS] [Control Devices]
```

* **⌂ SYSTEMS** is always first. It is the home page: a palette of every system type on the left, and one card per instance on the desk.
  The app opens here unless the URL has a deep link (`/#arouter`, `/#xpresets`, `/#scopes`, ...).
  Drag a type onto the desk to add an instance. The palette row stays. Two ATEMs are two cards, two IPs, one ATEM group.
* After it comes **one button per system group on the desk**. The order is always the same, no matter
  what order the systems were added in: RS6, E2 / PIXELHUE, ATEM, PTZ, PIXERA, MILLUMIN. A group that is
  not on the desk has no button. ADD or drag a type on the SYSTEMS page; REMOVE or Delete takes an instance off.
  When a group has more than one instance, every page in that group shows an instance picker (RS6, E2 / PixelHue, ATEM, PTZ, Pixera, Millumin). The choice is the instance id, not the IP. Same host and same port is DUPLICATE IP. Same host, different port, is two devices.
* The led on each button shows the worst status in that group: green means online, amber means degraded
  (for example 2/3 PTZ cameras online), red means offline, and grey means not set up. Hover the button to
  see each system's status.
* E2 and PixelHue share one group because they share the preset pages. The button shows whichever of the
  two are on the desk, for example `E2 / PIXELHUE`.
* **SCOPES** is always shown. It is the engineering scopes for the whole app (waveform, parade,
  vectorscope, Lightning, false colour), not a device to ADD TO DESK and not a PTZ page. **Lightning**
  is a mode inside that tab, not a tab of its own. A `/#lightning` link from 0.20.0 opens SCOPES.
  **TALLIES** (TSL) is a card on the SYSTEMS page.
* **Control Devices** is always shown, the same way SCOPES is. `/#decks` opens the USB view. The second row is DEVICES, BUTTONS, and PAGES. DEVICES is the USB assign view. BUTTONS creates library keys. PAGES lays out a surface. Quit the Elgato Stream Deck app so this app can own a USB deck.
* Tapping a group button opens **the page you last used in that group**. The first time, it opens the
  group's main page (PRESETS, SWITCHER, CAMERA CONTROL, TIMELINES, COLUMNS). The last page is remembered
  in this browser.

## Row 2: the selected group's pages

Only the pages of the selected group are shown, always in the same order:

| Group | Pages |
|---|---|
| RS6 | PRESETS · INPUTS · BACKUP · AUDIO · WEB RCS |
| E2 / PIXELHUE | (E2 \| PIXELHUE focus) · PRESETS · CUES · SOURCES · STILLS · BACKUP |
| ATEM | SWITCHER · ROUTER · AUDIO · DVE / SS / KEYS · LAYOUT · MULTIVIEW · MACROS |
| PTZ | CAMERA CONTROL · CAMERAS · SCOPES (shortcut into the top-row SCOPES pane) |
| PIXERA | TIMELINES · CUES |
| MILLUMIN | COLUMNS · LAYER |

**SCOPES** has no second-row page of its own. The top-row button opens the pane. The second row shows a
one-line hint (modes, and that live video is Desktop Video from a Mac sidecar).

**Control Devices** has a second row:

| Page | What it is |
|---|---|
| DEVICES | USB Stream Decks. Home picks one system. This is the view that used to be the whole tab. |
| BUTTONS | Create, edit, duplicate, and delete library buttons. No grid. |
| PAGES | Name a page for a surface type, assign library buttons, and push that page to an online Path C deck. |

**LAYOUT** is the M/E and SuperSource picture: resources on the left, canvases in the middle, properties on the right. **MULTIVIEW** is its own page. DVE / SS / KEYS stays the full key and DSK panel. See [atem-layout.md](atem-layout.md).

**ROUTER** is a destination list, like Videohub Control. Each output shows the source on it now. Tap the output and pick a source. Multiview windows are not on this list. See [router.md](router.md).

A page that the connected system does not support is not shown (for example, PixelHue has no CUES).
On the SYSTEMS page this row shows a short hint instead of tabs.

## Overflow

Neither row wraps. When a row is wider than the screen (a phone, or a narrow side panel), it scrolls
sideways with a swipe or the trackpad, and the selected tab is scrolled into view automatically.

## For tests and automation

Page tabs keep their `data-tab` attributes (`.tab[data-tab=arouter]`), and group buttons are
`.tgrp[data-tabgrp=atem]`. A page tab is only visible while its group is selected, so a script should
click the group first. **SCOPES** and **DECKS** are the exceptions: `.tab[data-tab=scopes]` and
`.tab[data-tab=decks]` are always on the top row.
`test/ui-helpers.js` has `openTab(page, tab)`, which does that.
`body[data-tabgrp]` holds the selected group (`home` on SYSTEMS, `scopes` on SCOPES, `decks` on Control Devices).
