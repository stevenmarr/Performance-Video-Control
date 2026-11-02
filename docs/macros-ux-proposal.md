# Macro Desk — layout proposal

This is a proposal only. The MACROS tab is not rebuilt here.

The page today is three modes (OPERATOR, EDITOR, MEMORIES) plus SYNC, STOP, and CONTINUE in the header. Operator is a grid of tiles that looks like the preset wall. Editor is three columns: a slot list, a step list written as protocol names (`programInput`, `userWait`), and an inspector that dumps every command the catalog knows, plus XML import and export. Memories (a snapshot of the switcher, not a macro) replace the whole page when you switch modes.

That is a lot of equal-weight buttons for a show caller who wants to hit "open" and see that it ran.

## User stories

1. **Show caller.** I am on headset. I want a page of named macros, big enough to hit, with the one that is running obvious (name, which step, and WAITING if it is sitting on a user wait). I want STOP and CONTINUE next to that, not buried. I do not want to open an editor to fire one.

2. **TD building the show.** I want to record the way ATEM Software Control does: pick an empty slot, press RECORD, do the moves on the switcher, press STOP. The steps should read as English ("Program → Cam 1", "Mix 30 frames", "USER WAIT", "DSK 1 on"), and I want to reorder or delete one step without seeing the protocol name.

3. **Someone fixing a slot.** I want the steps for the macro I just touched sitting beside the buttons, not on a different mode that hides the buttons. If the switcher and the app disagree on the name, tell me in one line and let me keep one or the other. XML export can live under a menu. I should not have to scroll past it to rename a step.

4. **Someone saving a look.** A memory is "the switcher as it is now", recalled as values, not played as steps. I want that as its own small list, labeled SNAPSHOT, so I do not fire a macro when I meant to recall a look, or the other way around.

## Proposed layout

One screen. The buttons stay put. Editing the selected slot opens beside them. Snapshots are a strip, not a mode.

```
+----------------------------------------------------------------------------------+
| MACROS                         RUNNING  12  Intro · step 3 of 6 · WAITING        |
|                                [ CONTINUE ]  [ STOP ]                            |
+----------------------------------------+-----------------------------------------+
|  [ 1 Black   ] [ 2 Open    ] [ 3 Cam 2 ]|  12  Intro                    [RECORD] |
|  [ 4 Lower 3 ] [ 5 Sting   ] [ 6 Walk  ]|  1  Program → Cam 1                   |
|  [ 7 Awards  ] [ 8 Clear   ] [ 9       ]|  2  Mix · 30 frames                   |
|  [10        ] [11        ] [12 Intro* ]|  3  USER WAIT                  ← here |
|  [13        ] [14        ] [15        ]|  4  DSK 1 on                          |
|  [16        ] [17        ] [18        ]|  5  Program → Media Player 1          |
|  [19        ] [20        ]             |  [ + STEP ]  [ USER WAIT ]  [ DELETE ]|
|  [ SHIFT ]   page 1 of 5               |  Name [ Intro____________ ]  [ WRITE ]|
+----------------------------------------+-----------------------------------------+
| SNAPSHOTS   Two-shot   Wide   Walk-in look          [ CAPTURE ]  [ RECALL ]     |
+----------------------------------------------------------------------------------+
```

`*` is the slot you have selected. The running slot gets a red or amber bar, the same language as program / preview, and the banner up top is the thing you look at when someone says "what's running?"

SHIFT on this pad is the same idea as the router: twenty buttons visible, SHIFT pages the pool. The switcher holds 100. A search field above the pad ("find intro") is enough. No second mode.

The right column is the selected slot only:

* Steps in plain language, one per line. The step that is waiting is marked.
* RECORD / STOP RECORD at the top of that column, next to the name, because that is how you build a macro on a show.
* + STEP and USER WAIT add one line. DELETE removes the selected line. Up / down moves it. No catalog of every possible command on screen at once. A single "Add step…" menu can list the few groups (switcher, keys, aux) if you need to insert something you cannot record.
* WRITE sends this slot to the switcher. If the names disagree, one line: `Switcher says "Opener". App says "Intro".` with KEEP SWITCHER / KEEP APP. Not a third column.
* XML import and export sit in that column's overflow menu (⋯), not in the flow.

SNAPSHOTS stay a single row under the pad. CAPTURE stores the switcher now. RECALL puts those values back and does not run a macro. They never replace the button pad.

## What I would change, and why

| Today | Change | Why |
|---|---|---|
| OPERATOR / EDITOR / MEMORIES as three modes | One pad. Steps for the selected slot beside it. Snapshots in a strip. | Mode switches hide the thing you were about to hit. A caller and a TD can stand at the same page. |
| Tiles that match the preset wall | A fixed bank of 20, with the slot number always in the corner, empty slots still visible | Empty slots are where you record. A wall of only "used" tiles hides them. SHIFT pages the rest so the bank does not grow the page. |
| Running state is a CSS class on a tile, easy to miss | A banner: name, step count, WAITING. STOP and CONTINUE live in the banner. | On a dark stage the question is "did it fire, and is it waiting on me?" |
| Steps show the op code | Plain language, source names from the switcher ("Cam 1", not `1`) | The op code is for the file. The button is for the operator. |
| Inspector lists every catalog command | Record first. "Add step…" only when you have to insert one | The catalog is how the beta editor got crowded. Recording already knows what you did. |
| XML textarea in the editor column | Overflow menu | Useful when you are moving a macro to Software Control. In the way the rest of the time. |
| LOOP STEPS / PLAY STEPS under the tile grid | Drop them from the caller page. A "play the steps in the app" control can live next to WRITE for the person building the slot. | Two play buttons (run the switcher macro, and play the app's step list) read as the same control. |
| Conflict copy and version buttons inline | One conflict line, and versions behind the slot name (a small "earlier" menu) | You need them when something went wrong, not on every slot. |
| Memories as a mode that replaces the pad | SNAPSHOT strip, labeled as a look, not a macro | Recall and run are different. The label should say so before the click. |

## What this does not change

* The macro file, the switcher write path, and SYNC stay. This is a layout, not a new engine.
* A macro still cannot fly a DVE. The LAYOUT page already says that, and the step list should keep saying "end position" if a step only sets geometry.
* Master cues (the CUES tab) are a timeline across systems. This proposal is only the ATEM macro pool.

## Mock

Open [macros-ux-mock.html](macros-ux-mock.html) in a browser. It is a static picture of the layout above, in the same dark panel colors as the app. It does not talk to the switcher.
