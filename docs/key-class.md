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
| flex | Dark grey. Nothing is assigned |
| nav | Slate OS key. HOME |
| tab | Darker than HOME, same group bar as navigation. The open tab is blue |
| info | Slate, name and address on the key |
| toggle | Dark key with the shared hot-key bar |

## Page

`lib/decks/pages/atem-switcher.page.json` is the + XL switcher: 9 by 4 keys and 6 encoders. A `repeat` entry is still data. It expands into numbered slots. Only the + XL uses this file. Other deck sizes keep the pages they already had.
