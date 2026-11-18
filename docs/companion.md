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

1. In Companion, install the **Control Center module** ("Performance Video Control Center", id `pvllc-control-center`, 0.11.0 or newer; release asset `pvllc-control-center.tgz`. Version 0.10.0 under the old id `rs6-presets` also works) and add a connection that points at this app (this Mac's address, port 8080).
2. In Control Center open **COMPANION**. Enter Companion's host and port (default `127.0.0.1`, port `8000`) and press **Save**.
3. The CONNECTION card says whether Companion answers. The MODULE card lists the Control Center module connections Companion has, and the module version that last reported in. An older module is flagged with a link to the releases.
4. Press **SYNC TO COMPANION**. The module refreshes its presets. In Companion, open **Buttons → Presets → Performance Video Control Center**:
   * **CC buttons** has one preset per library button.
   * **CC page: \<name\>** has one preset per placed slot, named by its row and column.
   Drag them onto Companion buttons, or onto a page on the fork's page browser.
5. To move a whole page at once, press **.companionconfig** next to the page. In Companion use **Import / Export → Import**, choose the page to replace, and map the connection called `cc` to your Control Center module connection. On the fork, the page keeps its surface layout (Stream Deck, XL, +, or + XL); save it as a template there if you want to stamp it out again.
6. In Companion's **Surfaces** tab, pick the page (and startup page) each Stream Deck shows. Companion owns the deck: quit Control Center's USB use of that deck (Control Devices) or let Companion take it.

The COMPANION tab also shows Companion's own web UI. If it does not show (for example when you open Control Center from another computer, where `127.0.0.1` is that computer), use **Open in a new window**.

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
