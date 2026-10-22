# lib/companion: Companion pages for Stream Deck surfaces (0.9.0)

Builds `.companionconfig` files (Companion export format **version 12**, `type: 'full'`) with pages for the
configured systems, for the Companion fork `stevenmarr/companion` `feat/lcars-gui` (page `surfaceLayout`).

| File | What |
| --- | --- |
| `surfaces.js` | The four profiles (XL, MK.2, +, + XL): key grid, strip and knob cells, the fork's layout id, `parseSurfaces()` |
| `pageset.js` | `catalogue(state, views)`: what the systems offer (preset ids per section); `buildSurface(profile, catalogue)`: the pages and their cells |
| `model.js` | Companion objects: linked module presets, legacy v12 buttons, internal `set_page`, pages, the full export |
| `styles.js` | Copy of the module's 72×72 button backgrounds (a test checks it against the module checkout) |
| `index.js` | `generate(state, views, { surfaces, combined, connection })` and `describe()` for the UI |

Notes:

- **Buttons** are `preset-reference` controls with an empty cache and the module feedback
  `cc_pages_refresh`. Companion only refreshes a reference when the module publishes its presets; that
  feedback's subscription makes the module (0.7.0+) publish them right after the import, so the buttons fill
  in without restarting the connection. Without it, a Buttons-only import into a running connection stays
  blank (checked against the fork).
- **Navigation** is a legacy `type: 'button'` (Companion converts it to a layered button on import) with
  `set_page {surfaceId: 'self', page: <page id>}` and a `page_missing` feedback. A full import remaps page ids
  by page number, so links survive; a single-page import (Buttons tab) would leave them NO PAGE.
- **Preset ids** follow the module's stable naming. The module's `test/v070.test.js` generates pages with
  this code and checks that every linked preset, action and feedback exists.
- The connection in the file has a fixed id; Companion matches it to an existing connection by label and
  module (`rs6presets`, `rs6-presets`) or creates one from the host and port in the file.
