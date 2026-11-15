# Scopes

Standalone video scopes for a Mac with Blackmagic Desktop Video. Waveform, RGB parade, vectorscope,
Lightning, Diamond, false colour and picture. Not a tab inside Control Center.

Default page: **http://127.0.0.1:8092**

## Prerequisites

- Node.js 16 or later (`node` on `PATH`; Homebrew on Apple Silicon is often `/opt/homebrew/bin/node`)
- Blackmagic Desktop Video
- DeckLink SDK, default `~/deck-link-sdk/Blackmagic DeckLink SDK 16.0` (override with `DECKLINK_SDK`)
- Xcode command line tools (`xcode-select --install` if `make` cannot find `<string>`)

The checkout this README assumes is `~/control-center`.

## Run

```bash
cd ~/control-center
git pull
cd apps/scopes
npm test
npm run build
# if make fails: xcode-select --install
# SDK default: ~/deck-link-sdk/Blackmagic DeckLink SDK 16.0
# override: make -C tools/native/decklink-recv DECKLINK_SDK="/other/path/Blackmagic DeckLink SDK 16.0"

./tools/native/decklink-recv/build/decklink-recv --list
# expect the UltraStudio Mini Replay 12G when Desktop Video is installed
# and no other app has the input exclusive (stop Replay / Playout / Media Express if capture fails)

node server.js
# or, to run at login:
./scripts/install-launchagent.sh
open http://127.0.0.1:8092
```

`node server.js` prints `Scopes: http://localhost:8092` and `Data dir: ...`.
Flags: `--port 8092`, `--host 0.0.0.0`, `--data <dir>`, `--mock`.
`PORT` and `HOST` are the same overrides. `--mock` uses `apps/scopes/mock-data`.

## LaunchAgent

`./scripts/install-launchagent.sh` writes `~/Library/LaunchAgents/com.pvllc.scopes.plist`
(label `com.pvllc.scopes`, RunAtLoad, KeepAlive, port 8092) and bootstraps it on macOS.
It resolves `node` from `PATH`, then `/opt/homebrew/bin/node`, then `/usr/local/bin/node`.

Logs:

```bash
tail -f ~/Library/Logs/PVLLC\ Scopes/scopes.err.log
```

Uninstall does not delete settings or logs:

```bash
./scripts/uninstall-launchagent.sh
```

## Data

| System | Folder |
|---|---|
| macOS | `~/Library/Application Support/PVLLC Scopes` |
| Windows | `%APPDATA%\PVLLC Scopes` |
| Linux | `~/.config/pvllc-scopes` |

`--data` wins, then `SCOPES_DATA_DIR`, then `RS6_DATA_DIR`. The file is `scopes.json`.

The first start copies `scopes.json` from `~/Library/Application Support/RS6 Presets` when the new
folder has no `scopes.json` and no `migrated-from.json`. Host and name are filled from that folder's
`systems.json` when the scopes file does not already have them. The old folder is left in place.

## Cameras

Add cameras in **INPUTS** (name, host, stream, path, RTSP port, HTTP port, login). The factory login
is admin / 12345 until you change it. **IMPORT CAMERAS** reads a Control Center URL
(`http://127.0.0.1:8080` or `http://<pi>:8088`) once. It copies name, host, port and model. It does
not copy passwords. After that, Scopes keeps working with Control Center stopped.

## Optional sidecar

```bash
node tools/decklink-sidecar.js --list
node tools/decklink-sidecar.js --device 0 --app http://127.0.0.1:8092
```

Ingest is loopback-only unless `SCOPES_NDI_INGEST_LAN=1` (or `RS6_NDI_INGEST_LAN=1`).

A DeckLink input can be open in one process. Stop Replay, Playout, or Media Express if capture fails.
If `CreateDeckLinkIteratorInstance` returns null, install Blackmagic Desktop Video and allow the driver
in System Settings → Privacy & Security.

`make` on Linux refuses to link Desktop Video. Capture is macOS only.

Scope modes and the INPUT menu: [docs/scopes.md](docs/scopes.md).
