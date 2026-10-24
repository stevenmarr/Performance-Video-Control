# decklink-recv

Small macOS command-line capture helper for Control Center Scopes. It talks to **Blackmagic Desktop Video** (DeckLink input), encodes H.264 with VideoToolbox, and writes Annex-B to stdout. `tools/decklink-sidecar.js` pushes that stream into Control Center.

Control Center itself never links the DeckLink SDK. A Raspberry Pi only relays the H.264. This directory is source plus build notes. Linux CI does not compile it. If the binary is missing, the sidecar prints a message and exits. It does not invent a source.

The DeckLink SDK is **not** in git. Point the build at a local SDK 16.0 tree, the same way Playout does.

## Build (Mac)

Install [Blackmagic Desktop Video](https://www.blackmagicdesign.com/support) and allow the driver in **System Settings → Privacy & Security**.

SDK locations Steven already has:

- `~/playout/Playout/Blackmagic DeckLink SDK 16.0`
- `~/Blackmagic DeckLink SDK 16.0`

```bash
cd tools/native/decklink-recv
make DECKLINK_SDK="$HOME/Blackmagic DeckLink SDK 16.0"
# binary: tools/native/decklink-recv/build/decklink-recv
```

The Makefile compiles `DeckLinkAPIDispatch.cpp` from the SDK include directory. It links CoreFoundation, Foundation, CoreMedia, CoreVideo, and VideoToolbox. `make` on Linux stops immediately and does not try to link Desktop Video.

Override the binary the sidecar spawns with `RS6_DECKLINK_RECV=/absolute/path/to/decklink-recv`.

## Commands

```text
decklink-recv --list
decklink-recv --device 0 [--mode auto|1080p5994] [--connection auto|SDI|HDMI]
decklink-recv --device 0 --raw-uyvy
```

`--list` prints one tab-separated line per device, in iterator order:

```text
index    name    connections    modes
0        DeckLink Mini Recorder    HDMI    1080p5994,1080p50,...
```

`--device N` uses that same index. It writes Annex-B H.264 to stdout and logs mode changes, no-signal, and drops on stderr. The default mode is `auto` (`bmdVideoInputEnableFormatDetection`, the Capture Preview / AutomaticModeDetection pattern). The initial guess is 1080p59.94 until the card reports the signal. The pixel format requested is 8-bit UYVY (`bmdFormat8BitYUV`). Frames are converted to NV12 and encoded with `VTCompressionSession`: realtime, no B-frames, GOP about half a second.

`--raw-uyvy` writes packed UYVY to stdout instead (debug). A bootstrap encode, if VideoToolbox in this helper is not what you want yet:

```bash
decklink-recv --raw-uyvy --device 0 2>mode.txt | ffmpeg -f rawvideo -pix_fmt uyvy422 -s 1920x1080 -r 59.94 -i pipe:0 \
  -an -c:v h264_videotoolbox -realtime 1 -bf 0 -g 30 -f h264 pipe:1
```

Homebrew ffmpeg on the show Mac does not include `-f decklink`. Do not block on a custom ffmpeg.

## Capture shape

The input path follows the Mac **Capture Preview** sample, not the GUI:

- `CreateDeckLinkIteratorInstance` lists devices (same idea as Playout `DeckLinkOutput` `listDevices` and the SDK DeviceList sample).
- `IDeckLinkInput::EnableVideoInput` + `StartStreams`.
- `VideoInputFormatChanged` restarts the stream when the signal mode changes.
- `VideoInputFrameArrived` copies `GetBytes` and leaves the callback.

There is no Cocoa preview window and no NDI SDK.

## Exclusive access

Playout schedules DeckLink **output**. This helper opens DeckLink **input**. Desktop Video gives one owner the device. If Playout is already using the same card as an output, capture fails. Use a second Desktop Video device, or a capture-only UltraStudio, when both programs run.

## What stays off the Pi

Do not copy the SDK into this repo. Do not `npm install` a native DeckLink addon into `server.js`. The sidecar is a separate process on the Mac.
