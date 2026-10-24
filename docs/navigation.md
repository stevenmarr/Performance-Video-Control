# Navigation (0.11.0)

The app has two rows of tabs under the header.

## Row 1: home and system groups

```
[⌂ SYSTEMS] [● RS6] [● E2 / PIXELHUE] [● ATEM] [● PTZ] [● PIXERA] [● MILLUMIN] [● LIGHTNING]
```

* **⌂ SYSTEMS** is always first. It is the home page. **DESK** is what is on the desk, connection
  settings, and status. **TALLIES** is the TSL tally map (its own setup, not part of Lightning).
  The app opens here unless the URL has a deep link (`/#arouter`, `/#xpresets`, ...).
* After it comes **one button per system group on the desk**. The order is always the same, no matter
  what order the systems were added in: RS6, E2 / PIXELHUE, ATEM, PTZ, PIXERA, MILLUMIN. A group that is
  not on the desk has no button. Use ADD TO DESK / REMOVE FROM DESK on the SYSTEMS page to change that.
* The led on each button shows the worst status in that group: green means online, amber means degraded
  (for example 2/3 PTZ cameras online), red means offline, and grey means not set up. Hover the button to
  see each system's status.
* E2 and PixelHue share one group because they share the preset pages. The button shows whichever of the
  two are on the desk, for example `E2 / PIXELHUE`.
* **LIGHTNING** is always shown. It is NDI ingest into the engineering scopes (waveform, parade,
  vectorscope, false colour). It is not a device to ADD TO DESK, and it is not the TSL tally page.
* Tapping a group button opens **the page you last used in that group**. The first time, it opens the
  group's main page (PRESETS, SWITCHER, CAMERA CONTROL, TIMELINES, COLUMNS). The last page is remembered
  in this browser.

## Row 2: the selected group's pages

Only the pages of the selected group are shown, always in the same order:

| Group | Pages |
|---|---|
| RS6 | PRESETS · INPUTS · BACKUP · AUDIO · WEB RCS |
| E2 / PIXELHUE | (E2 \| PIXELHUE focus) · PRESETS · CUES · SOURCES · STILLS · BACKUP |
| ATEM | SWITCHER · ROUTER · AUDIO · DVE / SS / KEYS · MACROS |
| PTZ | CAMERA CONTROL · CAMERAS · SCOPES (camera RTSP shortcut into the same WebGL scopes) |
| PIXERA | TIMELINES · CUES |
| MILLUMIN | COLUMNS · LAYER |
| LIGHTNING | SCOPES (pick an NDI ingest, then waveform / parade / vectorscope / false colour) |

A page that the connected system does not support is not shown (for example, PixelHue has no CUES).
On the SYSTEMS page this row shows a short hint instead of tabs.

## Overflow

Neither row wraps. When a row is wider than the screen (a phone, or a narrow side panel), it scrolls
sideways with a swipe or the trackpad, and the selected tab is scrolled into view automatically.

## For tests and automation

Page tabs keep their `data-tab` attributes (`.tab[data-tab=arouter]`), and group buttons are
`.tgrp[data-tabgrp=atem]`. A page tab is only visible while its group is selected, so a script should
click the group first. `test/ui-helpers.js` has `openTab(page, tab)`, which does that.
`body[data-tabgrp]` holds the selected group (`home` on SYSTEMS).
