#!/bin/bash
# Stop com.pvllc.scopes and remove the installed plist.
# Does not delete the data dir or the logs.
set -euo pipefail
DEST="${HOME}/Library/LaunchAgents/com.pvllc.scopes.plist"
if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$DEST" >/dev/null 2>&1 || launchctl bootout "gui/$(id -u)/com.pvllc.scopes" >/dev/null 2>&1 || true
fi
rm -f "$DEST"
echo "Removed $DEST (settings and logs were left in place)"
