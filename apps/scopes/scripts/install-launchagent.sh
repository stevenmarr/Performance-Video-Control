#!/bin/bash
# Install com.pvllc.scopes so Scopes starts at login and restarts if it exits.
# Does not start Control Center. Does not delete settings.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
HOME_DIR="${HOME}"
NODE=""
if command -v node >/dev/null 2>&1; then NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then echo "node was not found. Install Node or put it on PATH." >&2; exit 1; fi
NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"
NODE_DIR="$(dirname "$NODE")"
LOG="$HOME_DIR/Library/Logs/PVLLC Scopes"
mkdir -p "$LOG" "$HOME_DIR/Library/LaunchAgents"
TPL="$APP/launchagent/com.pvllc.scopes.plist.template"
DEST="$HOME_DIR/Library/LaunchAgents/com.pvllc.scopes.plist"
sed -e "s|__APP_DIR__|$APP|g" -e "s|__NODE__|$NODE|g" -e "s|__NODE_DIR__|$NODE_DIR|g" -e "s|__HOME__|$HOME_DIR|g" "$TPL" > "$DEST"
echo "Wrote $DEST"
echo "Node: $NODE"
echo "Logs: $LOG/scopes.out.log and scopes.err.log"
if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  UID_NUM="$(id -u)"
  launchctl bootout "gui/$UID_NUM" "$DEST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID_NUM" "$DEST"
  echo "Bootstrapped com.pvllc.scopes"
else
  echo "launchctl bootstrap skipped (not macOS). The plist is in place for a Mac."
fi
