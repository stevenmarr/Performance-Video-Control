# PTZ tracking protocol

Version 1. The Mac app listens on one TCP port (8765 unless `PTZ_TRACKER_PORT` says otherwise).

- `GET /health` and `GET /status` return JSON and close.
- `GET /v1` with `Upgrade: websocket` is the control channel. Text frames, JSON, both ways.

Control Center is the client. The browser talks to Control Center, and Control Center opens this socket, so a tablet does not have to reach the Mac app itself.

## Envelope

Every message is one JSON object.

| Field | Always | Meaning |
|---|---|---|
| `v` | yes | `1`. Any other value is refused. |
| `type` | yes | The message name below. |
| `cameraId` | when a camera is involved | `<ptz instance>:<camera id>`, for example `ptz:cam1`. |

Unknown fields are ignored. A reply that is an error uses `type: "error"`.

## Messages

### hello

Either side, once the socket is up.

```json
{ "v": 1, "type": "hello", "role": "control", "name": "control-center", "protocol": 1 }
```

```json
{ "v": 1, "type": "hello", "role": "tracker", "name": "ptz-tracker", "protocol": 1 }
```

`role` is `control` or `tracker`. `protocol` is the same number as `v`.

### settings.get / settings.set / settings

```json
{ "v": 1, "type": "settings.get", "cameraId": "ptz:cam1" }
```

```json
{ "v": 1, "type": "settings.set", "cameraId": "ptz:cam1", "settings": { } }
```

The tracker answers `type: "settings"` with the settings it kept (clamped). The shape of `settings` is below.

### start / stop / resume / unlock

```json
{ "v": 1, "type": "start", "cameraId": "ptz:cam1" }
```

`stop` sends pan/tilt stop (and zoom stop, if zoom had been moving) and goes to `off`. `resume` leaves operator pause. `unlock` drops the chosen person.

### lock

```json
{ "v": 1, "type": "lock", "cameraId": "ptz:cam1", "targetId": "t3" }
```

`targetId` is a detection id from the latest status.

### override

Control Center sends this when it has just moved that camera itself (joystick, rocker, focus, home, preset recall, stop, absolute zoom or focus). The tracker stops the head immediately and waits.

```json
{ "v": 1, "type": "override", "cameraId": "ptz:cam1", "reason": "operator", "command": "move" }
```

A keep-alive is not an override. The tracker ignores override while that camera is `off`.

### status

The tracker sends this a few times a second while a camera is running, and when the state changes.

```json
{
  "v": 1,
  "type": "status",
  "cameraId": "ptz:cam1",
  "state": "locked",
  "fps": 14.2,
  "detections": [
    { "id": "t3", "x": 0.4, "y": 0.12, "w": 0.2, "h": 0.55, "confidence": 0.91, "kind": "body", "missing": false }
  ],
  "lockedTarget": "t3",
  "lastCommand": { "pan": 6, "tilt": 0, "zoom": 0, "panTilt": "PTS5650", "zoomCode": null }
}
```

Boxes are fractions of the frame. Origin is the top-left, `x` grows right, `y` grows down. `state` is `off`, `searching`, `locked`, `lost`, or `paused`.

`panTilt` is the Panasonic CGI code last sent. `PTS5050` is stop. Positive pan in `lastCommand.pan` is camera-right. Positive tilt is camera-up.

`aim` is where the framing math wants the subject (`centerX`, `top`, `height`, fractions of the frame). `velocity` is the speed command right now, Panasonic counts, −49…+49, 0 is stop. The TRACKING page draws the dead zone and the framing box from `aim` and the saved dead zone, and prints `velocity`.

### ping / pong

```json
{ "v": 1, "type": "ping" }
```

```json
{ "v": 1, "type": "pong" }
```

WebSocket ping frames are answered with pong frames as well.

### error

```json
{ "v": 1, "type": "error", "code": "bad_json", "message": "That message is not valid JSON.", "cameraId": "ptz:cam1" }
```

| code | When |
|---|---|
| `bad_json` | The frame was not JSON. |
| `bad_type` | `type` is not in this document. |
| `unsupported_version` | `v` is not 1. |
| `bad_message` | A required field is missing. |
| `unknown_camera` | No settings have been sent for that id yet. |
| `no_camera` | Start, but the settings have no camera address. |

## Settings

The same object is stored in Control Center's `ptz-tracking.json` (without `control`) and sent on the wire (with `control`).

```json
{
  "detect": "body",
  "preset": "medium",
  "framing": { "subjectHeight": 0.55, "headroom": 0.12, "anchorX": 0.5, "lead": 0.08 },
  "deadZone": { "x": 0.045, "y": 0.05, "size": 0.06 },
  "maxSpeed": { "pan": 18, "tilt": 14, "zoom": 8 },
  "maxAccel": { "pan": 70, "tilt": 60, "zoom": 30 },
  "smoothing": 0.45,
  "feel": "medium",
  "maxDecel": { "pan": 90, "tilt": 80, "zoom": 40 },
  "gentleSpeed": { "pan": 6, "tilt": 5, "zoom": 3 },
  "gain": { "pan": 8, "tilt": 8, "zoom": 6 },
  "axisSmoothing": { "pan": 0.45, "tilt": 0.5, "zoom": 0.55 },
  "gentle": 0.05,
  "fast": 0.12,
  "hysteresis": 1.85,
  "jitter": 0.35,
  "drift": 0.035,
  "minSubject": 0.08,
  "latencyMs": 180,
  "lostHoldMs": 1200,
  "lostAction": "reacquire",
  "overrideResumeMs": 2000,
  "zoomEnabled": false,
  "autoLock": true,
  "redetectEvery": 8,
  "minConfidence": 0.4,
  "source": "mjpeg",
  "streamUrl": "",
  "control": {
    "host": "10.0.0.20",
    "port": 80,
    "user": "admin",
    "password": "12345",
    "streamUrl": "http://10.0.0.20:80/cgi-bin/mjpeg?resolution=640&framerate=15"
  }
}
```

| Field | Values |
|---|---|
| `detect` | `body` or `face` |
| `preset` | `wide`, `medium`, `close`, `custom`. A named preset replaces `framing`. |
| `framing.subjectHeight` | Desired box height, fraction of the frame. |
| `framing.headroom` | Empty frame above the subject. |
| `framing.anchorX` | Where the subject sits horizontally, before lead. |
| `framing.lead` | Largest shift lead room may apply. |
| `deadZone` | Inside this, the speed target is zero. `size` is for zoom. |
| `maxSpeed` | Panasonic units, 1...49. |
| `maxAccel` | How fast the speed number may change, per second. |
| `smoothing` | 0 snaps (still acceleration-limited). 1 is a slow ease. |
| `feel` | `lecture`, `medium`, `sports`, or `custom`. A named feel replaces the reaction numbers. |
| `maxDecel` | Per axis, speed counts per second while slowing down or reversing. |
| `gentleSpeed` | Per axis, Panasonic cap inside the gentle band. 1…49. |
| `gain` | Per axis, how fast the curve climbs once they leave the dead zone. 0.5…20. |
| `axisSmoothing` | Per axis low-pass, 0…1. |
| `gentle` | Width of the gentle band past the dead zone, fraction of the frame. 0 is one curve. |
| `fast` | Width of the ramp from the gentle cap up to the full cap. |
| `hysteresis` | How many times the dead zone a settled axis must be pushed before it moves. 1.05…3. |
| `jitter` | Error filter. 0 is raw. Near 1, a one-frame spike barely moves the output. |
| `drift` | Fraction of the frame per second that still counts as standing still. 0 turns it off. |
| `minSubject` | Smallest box height, fraction of the frame, that will be followed. |
| `latencyMs` | Video-to-head delay the predictor steps forward by. 0...2000. |
| `lostHoldMs` | How long to hold still after the person disappears. |
| `lostAction` | `reacquire` looks again. `stop` goes idle. |
| `overrideResumeMs` | How long after the last operator move before tracking continues. |
| `zoomEnabled` | Off until you ask. Zoom is easy to get wrong on a stage. |
| `autoLock` | One person in frame is taken. Two people wait for a tap. |
| `redetectEvery` | Full Vision pass every N analysed frames. Between them, the object tracker runs. |
| `source` | `mjpeg` or `jpeg`. |
| `streamUrl` | Optional override. Empty uses the URL Control Center builds. |
| `control` | Present on the wire only. The password is not written to `ptz-tracking.json` and is not returned to the browser. |

Preset framing, when the preset is not `custom`:

| Preset | Height | Headroom | Lead |
|---|---|---|---|
| wide | 0.38 | 0.16 | 0.06 |
| medium | 0.55 | 0.12 | 0.08 |
| close | 0.78 | 0.08 | 0.05 |

## Health

```json
{ "ok": true, "app": "ptz-tracker", "protocol": 1, "cameras": [{ "cameraId": "ptz:cam1", "state": "locked" }] }
```

## Camera commands

The tracker sends the same CGI Control Center sends. See `lib/drivers/ptz.js`.

```
GET /cgi-bin/aw_ptz?cmd=%23PTS<pan><tilt>&res=1
GET /cgi-bin/aw_ptz?cmd=%23Z<zoom>&res=1
```

Each axis is two digits, `50` at stop, `01`...`99` for −49...+49. Stop pan/tilt is `PTS5050`. Stop zoom is `Z50`. A speed is sent only when the code changes, and not twice inside 40 ms, except a stop, which skips the gap. The camera holds the last speed until a new one arrives, so stop is required. It is sent on pause, on loss, on quit, and when the picture stream goes quiet.
