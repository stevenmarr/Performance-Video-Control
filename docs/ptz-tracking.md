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

## Tuning

Start from the defaults. Change one thing and watch a walk, not a still person.

| If the head… | Try |
|---|---|
| chases breathing and small shifts | Raise the dead zone a little. |
| starts or stops too suddenly | Raise smoothing, or lower max acceleration. |
| never quite catches a walk | Raise max pan, a little. 49 is a whip. |
| sits behind a fast walk | Raise latency, in steps of about 30 ms, toward the real video delay. |
| hunts left and right | Lower max speed and raise smoothing before you touch the dead zone again. |
| frames the head against the top | Raise headroom, or use Wide. |
| leaves no room in front of a walk | Raise lead room. |
| zooms in and out on its own | Leave zoom off until pan and tilt are calm. |

Lost hold of about a second covers a person passing in front of the subject. Longer than that and the head is frozen while the show has moved on.

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
