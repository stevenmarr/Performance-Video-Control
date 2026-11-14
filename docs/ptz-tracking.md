# PTZ auto-tracking

A menu-bar app on a Mac follows one person with a Panasonic PTZ (UE150 and the other AW bodies that take the same CGI). Apple Vision does the detection. Control Center holds the settings and the start/stop/lock buttons. The browser can close; the Mac keeps tracking.

This is the same split as the Stream Deck plugin: the web app is the desk, the other process does the work the desk cannot.

## Where it lives

```
apps/ptz-tracker-mac/     Swift package
  Sources/TrackingCore/   motion, lock, state, CGI codes, the JSON protocol
  Sources/TrackerMac/     menu bar, Vision, MJPEG, the socket, the camera HTTP
  Tests/TrackingCoreTests/
lib/tracking/             Control Center's settings file and the socket to the Mac
public/tracking.js        the TRACKING page under PTZ
```

`tools/native/` is a small capture helper the Node process launches. This is a separate application, the way the Stream Deck plugin is, so it sits under `apps/` rather than beside that helper.

`TrackingCore` imports nothing Apple-only. `swift test` runs on Linux. `TrackerMac` is added to the package only when the manifest is evaluated on macOS, because it imports AppKit, Vision, and Network. It has not been compiled in the environment that wrote it.

## What talks to what

```
browser  --HTTP-->  Control Center  --WebSocket JSON-->  Mac menu-bar app
                         |                                    |
                         |  Panasonic CGI (when you move it)  |  Panasonic CGI (while tracking)
                         +---------------- camera ------------+
```

The Mac pulls pictures itself. It does not take them from Control Center.

- MJPEG, default: `http://<camera>/cgi-bin/mjpeg?resolution=640&framerate=15`
- JPEG poll, if that path is wrong: `http://<camera>/cgi-bin/camera?resolution=640` (the snapshot this app already uses)

Analyse about 15 frames a second. A frame that arrives while one is being read is dropped, not queued.

Detection is a protocol. Version 1 is Vision human rectangles or face rectangles, with `VNTrackObjectRequest` between full passes. A Core ML model can replace that later without touching the motion code.

## How the head moves

The box is measured from the top-left of the frame. The aim is the shot you asked for: headroom, subject size, horizontal position, and lead room in the direction of travel.

- Inside the dead zone the speed target is zero. Once an axis has settled it stays still until the error is clearly outside the zone again, so a small sway does not start the head.
- Outside the zone the speed bends up toward the max. It does not step there. Smoothing is a lag, and the acceleration cap limits how fast the speed number can change.
- When the person stops, the speed eases to zero. That is the stop you want at the end of a move.
- When you take the stick, or recall a preset, or press stop, the head is stopped at once. Easing out would keep it moving against you. Tracking waits (`paused`), then resumes after the resume time, or when you press RESUME.
- Latency is a guess of where the person is now, from where the late frame shows them. It is a time in milliseconds, not a hidden constant.
- Zoom is off until you turn it on. Pan and tilt are the part that has to feel right first.
- One person in frame is taken automatically. Two people wait until you tap a box.
- If the person disappears, the head holds still. They can come back inside the lost-hold time and keep the same id. After that, the app either looks again or goes idle, whichever you set.
- A loss, a pause, quit, and a stream that goes quiet all send `PTS5050`. The camera keeps the last speed until it hears a new one.

The CGI codes are the ones in `lib/drivers/ptz.js`: `PTS<pan><tilt>` and `Z<speed>`, two digits, 50 at stop, sent to `/cgi-bin/aw_ptz?cmd=%23...&res=1`. Positive pan is right. Positive tilt is up. A subject sitting too low in the frame produces a negative tilt.

## Control Center

PTZ → TRACKING.

The link is the Mac's address and port. Save it once. It is stored in `ptz-tracking.json` in the data directory, next to the other JSON files, written by rename so a crash cannot leave a half file. The camera password is not in that file. It is copied from the camera record onto the socket when settings are pushed, and the TRACKING page never receives it.

A move this desk sends to a camera (`move`, `zoom`, `focus`, `home`, `recall`, `stop`, absolute zoom or focus) is also an `override` on the socket. A keep-alive is not.

The message list is [ptz-tracking-protocol.md](ptz-tracking-protocol.md).

## Build on the M2

macOS 14 or later. Xcode 15 or later (Swift 5.9 or later). Apple Silicon. The package does not need a signed developer account.

```bash
cd apps/ptz-tracker-mac
swift test
swift build -c release --product PTZTracker
.build/release/PTZTracker
```

`swift test` is the core only. It does not compile the menu-bar app. `swift build` does.

A bundle with no dock icon:

```bash
bash scripts/make-app.sh
open build/PTZTracker.app
```

The first launch may ask for local network access. Allow it. The app listens on `0.0.0.0:8765` so Control Center on another machine on the show network can reach it. Set that Mac's address on the TRACKING page.

`PTZ_TRACKER_PORT` changes the port.

Quit from the menu. Quit sends stop to every camera it was driving and waits briefly for the camera to take it.

### Signing, later

Unsigned is enough for the show Macs. Nothing in the build requires a certificate. When you want one:

- Developer ID Application
- `codesign --force --deep --sign "Developer ID Application: …" build/PTZTracker.app`
- `notarytool submit`

Do not sandbox the first build. A sandbox needs an entitlements file (`com.apple.security.network.client` and `.server`) and a different test pass. Add that file when you sign, not before.

## Controls

The same numbers live on PTZ → TRACKING and in the menu-bar app’s **Tuning…** window. A change on the page is sent to the Mac immediately, including while it is already tracking. A change in the Mac window is sent back and saved in `ptz-tracking.json`. Speeds are the Panasonic scale used by `#PTS` and `#Z`: **1** is a creep, **49** is as fast as the head will go, **0** is stop.

Three reaction presets set the whole feel. The shot (wide / medium / close) is separate.

| Feel | What it is for | Pan cap | Dead zone, pan | Smoothing | Delay |
|---|---|---|---|---|---|
| Slow / Lecture | Someone who shifts their weight and should not be chased | 10 | 8% of the picture | 0.72 | 240 ms |
| Medium | The default | 18 | 4.5% | 0.45 | 180 ms |
| Fast / Sports | A person who actually crosses the stage | 36 | 2.5% | 0.18 | 100 ms |

Custom keeps whatever you type. Nudging a number, including from a Stream Deck encoder, switches the feel to Custom so the preset does not put the number back.

### Sensitivity

| Control | Unit | Medium | What to do |
|---|---|---|---|
| Dead zone, pan / tilt / zoom | Percent of the picture | 4.5% / 5% / 6% | How far they can move before that axis starts. Raise it if the head chases breathing. |
| Confidence | Percent | 40% | Boxes the detector is less sure about are ignored. Raise it if a coat on a chair gets locked. |
| Smallest subject | Percent of the picture height | 8% | Shorter than this is not treated as a person. |
| Hold after a loss | Milliseconds | 1200 | How long the head waits, stopped, after they disappear. Then it searches again, or stops for good if STOP WHEN LOST is on. |
| Stickiness | Times the dead zone | 1.85 | Once an axis has settled, the error must grow this far past the dead zone before it moves again. Stops the head ticking on the edge. |
| Jitter filter | 0 raw, near 1 heavy | 0.35 | A one-frame twitch is blended away. Raise it if the box flickers. |
| Drift ignore | Percent of the picture per second | 3.5% | Motion slower than this, and still inside the release band, is treated as standing still. |

### Reaction time

Each of pan, tilt and zoom has its own cap, acceleration, deceleration, smoothing and response.

| Control | Unit | Medium (pan) | What to do |
|---|---|---|---|
| Delay | Milliseconds | 180 | How far ahead the aim is placed, to cover the lag between the picture and the head. Raise it if the head sits behind a walk. |
| Speed cap | Camera speed, 1–49 | 18 | The fastest that axis will be told to go. 49 is a whip. |
| Acceleration | Speed counts per second | 70 | How fast the speed number may rise. Lower it if the start is abrupt. |
| Deceleration | Speed counts per second | 90 | How fast the speed number may fall, including a reversal. Raise it if the head coasts past them. |
| Smoothing | 0 snaps, 1 eases | 0.45 | A low-pass on the speed command, after the cap. |
| Response | 0.5–20 | 8 | How quickly the curve climbs toward the cap once they leave the dead zone. |
| Gentle band | Percent of the picture past the dead zone | 5% | Inside this band the speed is held to the gentle cap. 0 means one curve all the way to the full cap. |
| Gentle cap | Camera speed, 1–49 | 6 | The slow speed used in that band. |
| Fast ramp | Percent of the picture | 12% | How wide the climb is from the gentle cap up to the full cap. |

### Framing, profiles, overlay

Headroom, subject size, horizontal position and lead room are the shot, not the reaction. They are percents of the picture. 50% horizontal is the centre.

SAVE on THIS CAMERA stores the current numbers under a name for that camera. Tap the name to recall it. RESET TO MEDIUM puts the reaction and the shot back to the Medium / medium-shot defaults and turns zoom off. The stream choice and face-or-body choice are kept.

The preview draws two boxes. The solid one is the framing box (where they should sit, and how tall). The dashed amber one is the dead zone around that aim. The line under the state is the speed command right now: pan, tilt, zoom, on the camera’s −49…+49 scale.

### Stream Deck

A library button or encoder can use these action ids. One step is one detent. A long press on the matching dial resets that control to Medium.

| Action | What one step does |
|---|---|
| `ptz.trackSensitivity` | Dead zone, all three axes, by 0.5% of the picture |
| `ptz.trackSpeed` | Pan and tilt speed caps, by 1 (zoom cap stays put) |
| `ptz.trackSmoothing` | Smoothing, by 0.05, on all three axes |
| `ptz.trackLatency` | Delay, by 20 ms |
| `ptz.trackConfidence` | Confidence, by 5% |

On a + / + XL dial the widget names are `trackSens` and `trackSpeed`. They are not on a built-in page. A saved layout can name the dial. Rotate sends the steps. A long press resets that one control.

### If the head…

| If the head… | Try |
|---|---|
| chases breathing and small shifts | Slow / Lecture, or raise the dead zone and the jitter filter. |
| starts too suddenly | Lower pan acceleration, or raise pan smoothing. |
| coasts past them | Raise pan deceleration. |
| never quite catches a walk | Fast / Sports, or raise the pan cap a little. Stay well under 49. |
| sits behind a fast walk | Raise the delay, about 30 ms at a time. |
| hunts left and right | Lower the pan cap and raise smoothing before you shrink the dead zone. |
| ticks on the edge of the zone | Raise stickiness. |
| locks a coat on a chair | Raise confidence, or the smallest-subject percent. |
| frames them against the top | Raise headroom, or use the Wide shot. |
| leaves no room in front of a walk | Raise lead room. |
| zooms in and out | Leave ZOOM FOLLOWS off until pan and tilt are calm. |

## Real UE150 checklist

Do this on the show Mac, with one camera, before a rehearsal. The items below are not done yet: the app has not been compiled, and it has not seen a camera.

1. `swift test` passes.
2. `swift build -c release --product PTZTracker` succeeds. Fix anything the compiler reports in `Sources/TrackerMac/` before trusting the rest.
3. Launch the app. The menu bar shows PTZ, and "listening". `curl -s http://127.0.0.1:8765/health` returns `"ok": true`.
4. On TRACKING, set the Mac's address, SAVE LINK, and the line says connected.
5. Pick the UE150. APPLY the medium preset. Do not turn zoom on yet.
6. Confirm the picture path. If START logs `MJPEG HTTP 404` (or the menu stays on `searching` with no boxes), switch on JPEG POLL and APPLY. That path is the snapshot this app already uses. If MJPEG works, note the exact URL the camera accepted and keep it in the stream field.
7. Confirm the JPEG is upright. A hanging camera's install position does not flip the CGI picture. If the box is upside down relative to the person, tracking will drive the wrong way. Fix the stream before judging the motion.
8. START with one person standing still. The state goes to `locked`. The head does not move for a small sway.
9. Walk slowly across the stage. The head starts smoothly, stays ahead of the person by about the lead you set, and eases to a stop when they stop. It does not whip, and it does not keep crawling after they stop.
10. Cover the person for under a second. The head holds, then picks them up again. Cover them past the lost-hold time. It goes back to searching, or idle, matching the switch.
11. While it is tracking, move the joystick in Control Center (or on the Stream Deck). The head stops following at once and does not fight the stick. After the resume time, or RESUME, it takes them again.
12. Quit the menu-bar app while it is tracking. The camera receives a stop and does not keep panning.
13. Only then try ZOOM FOLLOWS, on a mark, and decide if you want it in the show.

## What this version does not do

Core ML / YOLO, NDI, RTSP, Bonjour discovery, code signing, and more than one camera running as a finished feature. The protocol and the pipeline are per camera, so a second camera is a second id, not a rewrite. It has not been the thing under test.
