# PTZ auto-tracking evaluation

This is a read of the auto-tracking feature as it stands, plus the bugs that were clear enough to fix and test. The two pieces are the Mac menu-bar app (`apps/ptz-tracker-mac`) and the TRACKING page in Control Center (PTZ → TRACKING, `public/tracking.js`, with the socket and the settings file in `lib/tracking`).

The target is a Panasonic AW-UE150, and the AW-UE160 uses the same speed commands (`#PTS` and `#Z`). Nothing here was run against a real camera.

## What could be built here

This machine is Linux, not a Mac. There is no Mac environment to borrow.

- `swift test` in `apps/ptz-tracker-mac` passes: 52 tests. That is the motion math, the CGI wording, a fake Panasonic camera, and the rehearsal harness. `TrackingCore` does not need Apple frameworks, so it builds on Linux.
- `swift build` of that library succeeds.
- `swift build -c release --product PTZTracker` does not. The menu-bar app is only added to the package on macOS, because it needs AppKit, Vision, and Apple's network stack. **The menu-bar app has still never been compiled**, including the camera-sender changes in this pass. Those changes are covered by the same rules, tested in `TrackingCore`, but a Mac has to compile `Sources/TrackerMac` before you trust them on a show.

Vision, the live MJPEG pull, and the real HTTP conversation with a UE150 were not run. The cost of reading a frame on Apple Silicon was not measured.

## How it is put together

Control Center is the desk. The Mac app is the operator who watches the picture.

```
browser  --HTTP-->  Control Center  --WebSocket JSON-->  Mac menu-bar app
                         |                                    |
                         |  Panasonic CGI when you move it    |  Panasonic CGI while tracking
                         +---------------- camera ------------+
```

The Mac pulls its own pictures. It does not take them from the desk. Default is MJPEG at 640 wide, about 15 frames a second. A frame that arrives while one is being read is dropped.

Detection (Apple Vision, body or face) is only in the menu-bar app. Everything after the box — dead zone, smoothing, speed cap, the `#PTS` string — is in `TrackingCore`, which is what the tests run.

Speeds are the camera's own scale. 1 is a creep, 49 is as fast as the head will go, 50 in the command means stop. `#PTS5750` is pan a little right, tilt stopped. `#PTS5050` is stop. Positive pan is camera-right. Positive tilt is camera-up. A person sitting too low in the frame produces a negative tilt. That sign is tested.

The page and the Mac window share one set of numbers. A named feel (Slow / Lecture, Medium, Fast / Sports) replaces the reaction numbers. Custom keeps what you type. The shot (wide / medium / close) is separate from the feel.

## What already works

These are covered by tests, not by a camera.

- One person in frame is taken. Two people wait until you pick a box. A brief hole keeps the same id. Two people crossing does not swap ids.
- Inside the dead zone the speed target is zero. Once an axis has settled, it stays still until the error grows past the stickiness band, so a small sway does not start the head. A one-percent sway in the harness produced no pan and no tilt.
- Just outside the dead zone the speed starts as a creep and bends up. It does not step to the cap. Acceleration and deceleration are separate caps, so a stop can be firmer than a start.
- The gentle band holds a slow cap. Past that, the speed ramps toward the full cap. Nothing is allowed past 49, and the CGI word is never `00` (the camera rejects that).
- Delay compensation steps the aim forward by the milliseconds you set. Lead room shifts the framing opposite the walk, so there is space in front of them. Both are tested.
- Zoom stays at 0 until ZOOM FOLLOWS is on.
- A loss sends `#PTS5050`. The camera holds its last speed until it hears a new one, so the stop matters. Coming back inside the hold time keeps the same person. Past the hold, it searches again, or goes idle if STOP WHEN LOST is on.
- A joystick, rocker, focus, home, preset recall, or stop is an override. The head is stopped at once. It does not ease out against your hand. A keep-alive is not an override. An override while tracking is off does nothing.
- The camera password is sent to the Mac on the socket and is not written to `ptz-tracking.json` and not returned to the browser.
- The page's WebSocket client speaks the same handshake the Mac expects. Settings, start, status, and a desk move were exercised against a fake Mac and a fake UE150.

## Bugs fixed

Five of these were wrong in a way a test can pin down. Each fix has a test.

1. **The clock was pretending the person had stopped.** The menu-bar app wakes five times a second to expire a pause and a loss hold. That wake was feeding the last box back into the motion math at a new time. A box that has not moved looks like the person stopped, so the head would ease off a walk between real frames. A clock tick now only checks the timers. The speed stays until a real frame arrives.

2. **A stop waited behind the 40 ms gap.** Panasonic's spec asks for 40 ms between speed commands. A stop is the exception: the head holds its last speed until it hears one, so a stop must not wait. The session already skipped the gap. The queue the app uses to talk to the camera did not. A stop now goes out even when a speed is still inside that 40 ms.

3. **A lost command left the head running.** If the HTTP request for a move timed out, or the camera dropped the connection, nothing sent `#PTS5050`, and a failed stop was not tried again. The link now does this: a move that is not confirmed is followed at once by a stop on that axis; a stop that fails is tried again immediately, three more times; if those fail, it waits (half a second, then longer, up to 8 seconds) and tries the stop again. While it is recovering, new speeds are ignored so a later pan cannot replace the stop. The menu-bar sender uses this link. That file was not compiled here. The behaviour is tested against a fake camera that stays silent and one that hangs up.

4. **STOP could be lost while the Mac was disconnected.** The TRACKING page refused STOP if the socket was down, so a network blip left the Mac tracking with no stop waiting for it. A burst of setting saves could also push a queued STOP out of a 20-message line. STOP is now accepted while the socket is down, and it is kept ahead of settings. It goes out when the Mac comes back. START still requires the link. You do not want a start from ten minutes ago to fire on its own.

5. **A zoom or focus dial did not count as you taking the camera.** A joystick already paused tracking. The dial that writes an absolute zoom or focus position (`zoomPos` / `focusPos`, including a step or a reset) did not, so tracking would fight the dial. It now sends the same override. An iris or paint step does not. That is a picture change, not a move.

## Rehearsal numbers

The harness is `TrackingHarness` in `Sources/TrackingCore/Simulation.swift`. It is not a video file. It is a person moving in a simple world. The camera aim integrates the speeds the session actually commands, and the next box is what the detector would have seen. You can also feed a JSON recording of positions (`t`, `x`, `y`, `h`, `present`). `HarnessTests` runs both.

The walk is a cross at about 12% of the picture per second, then a stop, then they are covered for 0.8 seconds (inside the Medium hold of 1.2 seconds), then they are back. Zoom is off. 15 frames a second.

Distances are percent of the picture. Positive lag means the person is to the right of the aim: the head is behind a walk to the right. "Held" is where they sat, relative to the aim, in the half-second before the cover, after they had stopped. Overshoot is how far the head coasted past the aim. Reversals are the head changing direction.

| Feel | Time to first pan | Lag during the walk | Where they sat after the stop | Past the aim | Fastest pan command | Direction changes while walking | Direction changes after the stop | Stop sent on the loss |
|---|---|---|---|---|---|---|---|---|
| Slow / Lecture | 800 ms | 22.8% | 20.4% short | 0 | 6 (cap is 10) | none | none | yes |
| Medium | 200 ms | 14.9% | 8.5% short | 0 | 11 (cap is 18) | none | none | yes |
| Fast / Sports | same frame (under 67 ms) | 6.8% | 3.2% short | 0 | 12 (cap is 36) | none | none | yes |

A wider dead zone and heavier smoothing waited 533 ms. A tight dead zone and a light smoothing waited 67 ms, on the same walk.

A one-percent sway on Medium never started the head.

Coming back inside the hold locked the same person on the first frame. The loss sent `#PTS5050`. No speed was sent twice in a row.

Read this with two limits in mind.

- The fake head has no mechanical inertia. When the command reaches zero, the aim stops. A real UE150 coasts past that. **Overshoot of zero here means the controller did not aim past them. It does not mean the real head will stop on the mark.**
- On this walk the speed caps were not what limited the move. Sports never got out of its slow band (the gentle cap is 12, and the peak command was 12). The thing you would feel is the lag, not a whip. Lecture was still 20% short of the framing when they stopped. That matches the preset: it is not willing to chase a cross. If the walk is a real cross of the stage, Medium or Sports is the one to start from. Lecture is for someone who shifts their weight.

The commands themselves are the normal ramp, for Medium starting `PTS5150`, `PTS5250`, `PTS5350` and so on, and ending in a stop when the person is covered.

## Performance

The pan/tilt/zoom math, by itself, took **1.22 microseconds per update** on this Linux machine (x86, not Apple Silicon). A frame at 15 per second is about 67,000 microseconds. The math is not the cost.

What will cost time on the show Mac is Vision, turning the JPEG into a picture, and the HTTP trip to the camera. None of that was measured. The app already throws away frames that arrive while one is being read, and it aims at about 15 per second, so a slow detector drops frames instead of building a queue. That part is in the menu-bar app and was not run.

Do not treat 1.22 microseconds as an Apple Silicon number. It is only the arithmetic.

## Safety

What the code does today:

- **Your hand wins.** A move, zoom, focus, home, preset recall, stop, or a zoom/focus position dial stops the head immediately. It does not coast out. While it is paused it will not fight you. After the resume time (Medium is 2 seconds) it takes the person again, unless you press RESUME sooner or STOP.
- **A loss, a pause, quit, and a picture that goes quiet are all supposed to send `#PTS5050`.** The loss path is tested. Quit and the quiet-stream path live in the menu-bar app and were not run. The quiet-stream check is: no frame for half a second while locked, then it treats the person as missing and stops.
- **Speeds are clamped to 1–49.** The command can never be the illegal `00` code.
- **STOP is now kept** if the Mac socket drops, and sent when it comes back.

What it does not do, and you should treat as unfinished before a show:

- **It will move a camera that is on program.** Preset recall from a deck already has a live guard: red tally can lock or hold a recall. Tracking does not look at tally. START moves the camera if you press it, and the automatic resume after a stick will move it again two seconds later, tally or not. If the camera is tallied, that resume is the head moving on air without a new button press.
- **It does not read the camera's pan and tilt end stops.** It sends a speed, not a position. At the end of travel the camera stops mechanically and the app keeps asking until the person is centered. That is a motor against the stop, not a soft limit.
- **The picture is not reopened if MJPEG drops.** The head is stopped, which is right, and then it stays blind until you start it again.
- **A hanging camera is not flipped in software.** The install position does not flip the CGI picture. If the box is upside down relative to the person, the head drives the wrong way. Check that before you judge the feel. The existing checklist in `docs/ptz-tracking.md` already says this. It has not been done, because the app has not been compiled and has not seen a camera.

## Recommended next steps

In the order I would do them.

1. **Compile the menu-bar app on the show Mac and walk the checklist in `docs/ptz-tracking.md`.** That is the thing this evaluation could not do. `swift test` is green. `swift build -c release --product PTZTracker` has to be run on macOS 14 or later. Fix whatever the compiler says in `Sources/TrackerMac` before you point it at a camera. The camera-sender changes in this pass are part of that build.

2. **Add a red-tally gate, the same idea as the preset live guard.** Do not auto-resume while the camera is on program. START on a tallied camera should take a deliberate confirm, not happen because a resume timer expired. Tracking a presenter who is on air is a real use. The dangerous case is the head moving because a timer ran out, or because the socket came back, while that camera is tallied.

3. **Reopen the picture when MJPEG dies.** Today a dead stream stops the head and then sits there. A reconnect, with the head staying stopped until a frame is actually back, is the missing half.

4. **Put a little inertia in the harness, or record one real move.** The numbers above are the controller only. A UE150 coasts. Until the harness or a recording includes that coast, do not use "overshoot 0%" as a reason to trust the stop.

5. **Only ignore slow drift after the shot has already settled.** Drift ignore treats a slow error inside the stickiness band as standing still, including the first correction. A person who starts a few percent off center and barely moves can be left there. The dead zone is the right tool for breathing. Drift ignore should not block the first framing.

6. **Ping the Mac.** The desk socket does not send pings. A half-open network can look connected. A ping every couple of seconds would turn that into "not connected" on the page. STOP is now queued either way.

7. **Leave Core ML, NDI, and a second camera for later.** The pipeline is already per camera id. A second camera is a second id, not a rewrite, and it has not been the thing under test. One camera that starts, follows, and stops cleanly is the show requirement.

## How to re-run

On this repo, from a machine with Swift 5.9 or later (the Linux run used Swift 6.0.3):

```bash
cd apps/ptz-tracker-mac
swift test
```

The rehearsal lines are printed by `HarnessTests`. Control Center's side:

```bash
node --test test/tracking.test.js
```

The menu-bar app, on the Mac only:

```bash
cd apps/ptz-tracker-mac
swift build -c release --product PTZTracker
```
