# Key class

A Stream Deck control is one object. A page is a grid of those objects, stored as JSON, not drawn in code. A later page editor can create and edit the JSON.

The shape follows the Bitfocus Companion button: a style, actions for each event, and feedbacks that change the style when a condition is true.

## Element

`button`, `encoder`, or `touch-segment` (one piece of the LCD strip).

## Style

* Text, fixed or from a variable such as `$(atem:name)`. Long text wraps onto more than one line.
* Text color, background color, and the thin group bar across the top.
* An optional border. HOME and INFO also draw the slate OS frame.

## Actions

Each event has a list of actions. Events are `press`, `release`, `hold`, `turn` (encoder), `push` (encoder), and `touch` (strip). An action is a system instance, an action id, and options. The switcher page turns those ids into the existing Control Center routes (`atem.cut`, `atem.auto`, `nav.page`, and so on).

## Feedbacks

An ordered list. A boolean feedback overrides style fields when its `when` flag is true. An advanced feedback may return a style object. Later feedbacks win.

## Roles

A role is a preset of base style plus the usual feedbacks. The same role looks the same no matter what it controls.

| Role | Looks like |
|---|---|
| program | Muted red, bright red when that source is on program |
| preview | Muted green, bright green when that source is on preview |
| hot | Solid red. CUT and TRANS. Lighter red while a transition is running |
| shift | Dark, yellow bar. Yellow fill while the shift or a higher flex bank is on |
| flex-macro | Blue fill, no separate group bar |
| flex-memory | Magenta fill, no separate group bar |
| flex | Dark grey. Nothing is assigned. The + XL page does not print this word; bank 1 reads MACROS and bank 2 reads MEMORY |
| nav | Slate OS key. HOME |
| tab | Darker than HOME, same group bar as navigation. The open tab is blue |
| info | Slate, name and address on the key |
| toggle | Dark key with the shared hot-key bar |

## Page

`lib/decks/pages/atem-switcher.page.json` is the + XL switcher: 9 by 4 keys and 6 encoders. A `repeat` entry is still data. It expands into numbered slots. Only the + XL uses this file. Other deck sizes keep the pages they already had.

## Library and named pages

Buttons live in `button-library.json`. A named page lives in `surface-pages.json`, next to `decks.json`. A page is placements for one surface type: a key, encoder, or touch segment points at a library id. It is not a stack, and it is not tied to one deck.

**Control Devices → BUTTONS** edits that library. **Control Devices → PAGES** is the mapping screen: the real grid for one surface type, with empty slots left empty, and a library button accepted only on a matching key, encoder, or touch segment. **Push** sends the selected page to an online Path C deck through `POST /api/decks/deploy` and the plugin `POST /v1/deploy`. After that push, `GET /api/decks` lists the deck's `loaded` titles the same way a built-in stack push does. The page is translated into the older shape the plugin already paints: `label`, `value`, `caption`, and `action` as `{ method, path, body }`. A bound id such as `atem.cut` becomes `POST /api/sys/atem/cmd/cut`. An id with no route (`nav.home`, `atem.shift`, and the other page-only ids) is sent as a label with no path. `nav.page` is a jump. The last key row is not replaced with page-jump keys.

Encoder and touch placements are included as `knobs` and `strip`. `dials` stays one string per column (`off` unless it is a built-in paint widget) because the current plugin paints knobs from widget names. USB live paint of a library page is not part of this push.

A stack in `decks.json` can hold a built-in id such as `ptz-live` and a saved page id together. Pushing a saved page puts that id first and leaves the built-in ids on the stack.
