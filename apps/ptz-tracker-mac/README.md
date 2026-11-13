# PTZ Tracker

Menu-bar app for Panasonic PTZ auto-tracking. Vision on Apple Silicon, motion in `TrackingCore`, settings in Control Center.

The app target has not been compiled on the machine that added it. `swift test` is the part that runs anywhere. The build, and a camera pass, are in [docs/ptz-tracking.md](../../docs/ptz-tracking.md).

```bash
cd apps/ptz-tracker-mac
swift test
swift build -c release --product PTZTracker
.build/release/PTZTracker
```

Or `bash scripts/make-app.sh` and open `build/PTZTracker.app`. macOS 14 or later, Apple Silicon, Xcode 15 or later.
