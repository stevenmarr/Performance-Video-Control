# Status

Status is a read-only screen for a tablet or a TV on the show network. It does not take, recall, record, or change a Companion variable. The buttons that do those things stay on the normal Control Center pages.

Open it at **http://\<this Mac\>:8080/status**.

The editor is a different page: **http://\<this Mac\>:8080/status/config**.

## What a screen shows

Each screen shows one named layout. Three layouts are already there:

| Name | Address | What it is for |
|---|---|---|
| FOH | `/status?layout=FOH` | The full wall: clock, countdown, playback, program, cameras, systems |
| Green room | `/status?layout=Green%20room` | Clock, doors, show time, what is on program, cameras |
| Client | `/status?layout=Client` | Clock, time until the show, and the name on program. No edit link |

The name in the address is the layout name. `FOH` and `foh` are the same layout.

The wall reconnects on its own if the iPad sleeps or the network blips. The pill says **LIVE** or **RECONNECTING**. **COMPANION** means Companion's web port answered. **COMPANION LIVE** means the satellite link is up too.

## The editor

`/status/config` is the only place that changes a layout.

- **Add a tile** picks what the tile shows: clock, countdown, time remaining, text, tally, online / offline, or preset (standby and program).
- **Data from** picks where the number comes from: the house clock, a time you type, any system on the desk (ATEM, PTZ, HyperDeck, Pixera, and the rest), the Companion connection, or one Companion custom variable. Type the variable name the way it is spelled in Companion, for example `show_name`.
- Drag a tile to move it. Drag the corner to resize it. The grid is 12 columns wide.
- Each tile has its own name, number size, colors, and warning times. Amber is the longer warning. Red has to be shorter. The usual pair is amber under 30 seconds and red under 10.
- **Time zone** and **12-hour / 24-hour** belong to the layout. The usual zone is `America/Chicago`.
- **Save** writes the layout on this Mac, in the same data folder as the show (`status-layouts.json`). The wall does not change until you save.
- **New**, **Duplicate**, and **Delete** manage the list. You cannot delete the last layout.
- **Download JSON** saves one layout as a file. **Load JSON** brings a file back. A file can be one layout or the whole set. Loading a file saves it on this Mac. It does not touch the switcher.

A countdown time is a clock time today, such as `7:00 PM` or `19:00`, or a full date such as `2026-11-27T19:00:00`. After that time passes, the tile says **OVER**. It does not jump to tomorrow.

If a Companion variable already holds the time remaining, set the tile to countdown, point it at that variable, and choose **already a time remaining**.

## What it can see

Covered, when that system is on the desk and answering:

- Time of day, in the zone and 12-hour or 24-hour clock you set
- Countdowns you type, or a time held in a Companion variable you name
- Time remaining when a player reports a length and a position, or a remaining time
- RS6, E2, and PixelHue: on program, on preview, and the last preset recalled that has not been taken
- The cue stack: the loaded cue and the next cue. The show cue list works the same way
- ATEM program and preview on each mix effect
- The name of an ATEM media player when it is on program or preview
- HyperDeck clip number, timecode, and record / play / stop
- Pixera timeline and cue, and play / pause / stop
- Millumin column or media, and whether it is running
- Mitti cue, and play / pause / stop
- Each system: online or offline, its address, and when it last answered
- PTZ cameras: a red frame and **LIVE** when that camera is on program, preview tally, pan, tilt, zoom, and whether the head is moving
- Record and stream when a HyperDeck is recording, or when a module connection such as vMix or OBS says so
- Companion's web connection, the live satellite link, and the custom variables you name

Not on this screen yet:

- ATEM media-player clip time. This switcher connection does not read the media pool clock, so a media player shows its name and not a countdown
- HyperDeck clip name and clip length. The deck connection reports the clip number and the timecode
- Pixera, Millumin, and Mitti time remaining, unless that connection reports a position and a length
- A countdown that follows the show file by itself. You set each countdown, or point it at a Companion variable
- Companion variables you have not named. Companion does not hand over the whole list
- Anything that changes a device

Companion here is the 4.3 HTTP remote-control API (`GET /api/connections` and `GET /api/custom-variable/<name>/value`) and the satellite WebSocket on port 16623 (read the version, answer a ping). Control Center already knows Companion's address from the COMPANION tab. The status screen only reads.
