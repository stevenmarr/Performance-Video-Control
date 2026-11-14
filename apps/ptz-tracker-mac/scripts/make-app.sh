#!/bin/bash
# Wrap the release binary in a menu-bar bundle (no dock icon). Run on the Mac.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release --product PTZTracker
APP="build/PTZTracker.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/PTZTracker "$APP/Contents/MacOS/PTZTracker"
cp Resources/Info.plist "$APP/Contents/Info.plist"
chmod +x "$APP/Contents/MacOS/PTZTracker"
echo "Built $APP"
