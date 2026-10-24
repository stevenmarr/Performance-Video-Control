# ATEM model profiles (0.10.0)

The simulator (`--mock --atem-model <key>`, or SYSTEMS › ATEM › ADD TO DESK AS SIMULATOR › pick a model) answers with the
product id, topology, keyers, SuperSource, multiviewers and audio mixer of the chosen profile. A real switcher is matched to a
profile from its product id (`_pin`) and, failing that, its topology (`_top`); a topology that does not match is flagged *mismatch*.
Profiles live in `lib/drivers/atem-models.js`.

Sources: **[BM]** Blackmagic product pages / manuals, **[CM]** Bitfocus companion-module-bmd-atem model table,
**[AC]** Sofie atem-connection enums. A number marked uncertain below was not confirmed from two sources and has not
been checked on hardware.

| key | model | pid | M/E | inputs | USK/ME | DSK | DVE | SS (boxes) | MP | aux/outputs | MV (windows) | audio |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `mini` | ATEM Mini | 0x0d | 1 | 4 | 1 | 1 | 1 | 0 | 1 | 2 | 0 (0) | fairlight 6 |
| `minipro` | ATEM Mini Pro | 0x0e | 1 | 4 | 1 | 1 | 1 | 0 | 1 | 2 | 1 (10) | fairlight 6 |
| `miniproiso` | ATEM Mini Pro ISO | 0x0f | 1 | 4 | 1 | 1 | 1 | 0 | 1 | 2 | 1 (10) | fairlight 6 |
| `miniextreme` | ATEM Mini Extreme | 0x10 | 1 | 8 | 4 | 2 | 2 | 1 (4) | 2 | 3 | 1 (16) | fairlight 10 |
| `miniextremeiso` | ATEM Mini Extreme ISO | 0x11 | 1 | 8 | 4 | 2 | 2 | 1 (4) | 2 | 3 | 1 (16) | fairlight 10 |
| `tvshd8` | ATEM Television Studio HD8 | 0x1a | 1 | 8 | 4 | 2 | 2 | 1 (4) | 2 | 2 | 1 (16) | fairlight 29 + MADI, routing |
| `tvshd8iso` | ATEM Television Studio HD8 ISO | 0x1b | 1 | 8 | 4 | 2 | 2 | 1 (4) | 2 | 2 | 1 (16) | fairlight 29 + MADI, routing |
| `chd1me` | ATEM 1 M/E Constellation HD | 0x12 | 1 | 10 | 4 | 1 | 1 | 0 | 2 | 6 | 1 (16) | fairlight 14, routing |
| `chd2me` | ATEM 2 M/E Constellation HD | 0x13 | 2 | 20 | 4 | 2 | 2 | 1 (4) | 2 | 12 | 2 (16) | fairlight 24, routing |
| `chd4me` | ATEM 4 M/E Constellation HD | 0x14 | 4 | 40 | 4 | 4 | 4 | 2 (4) | 4 | 24 | 4 (16) | fairlight 78 + MADI, routing |
| `c4k1me` | ATEM 1 M/E Constellation 4K | 0x1c | 1 | 10 | 4 | 1 | 1 | 0 | 2 | 6 | 1 (16) | fairlight 14, routing |
| `c4k2me` | ATEM 2 M/E Constellation 4K | 0x1d | 2 | 20 | 4 | 2 | 2 | 1 (4) | 2 | 12 | 2 (16) | fairlight 24, routing |
| `c4k4me` | ATEM 4 M/E Constellation 4K | 0x1e | 4 | 40 | 4 | 4 | 4 | 2 (4) | 4 | 24 | 4 (16) | fairlight 78 + MADI, routing |
| `c8k` | ATEM Constellation 8K (8K mode) | 0x0c | 1 | 10 | 4 | 2 | 1 | 1 (4) | 1 | 6 | 1 (16) | fairlight 48 + MADI, routing |
| `c8khd` | ATEM Constellation 8K (HD/UHD mode) | 0x0b | 4 | 40 | 4 | 4 | 4 | 2 (4) | 4 | 24 | 4 (16) | fairlight 78 + MADI, routing |
| `ps4k` | ATEM Production Studio 4K | 0x04 | 1 | 8 | 1 | 2 | 0 | 0 | 2 | 1 | 1 (10) | classic 10 |
| `2meps4k` | ATEM 2 M/E Production Studio 4K | 0x06 | 2 | 20 | 2 | 2 | 1 | 1 (4) | 2 | 6 | 2 (10) | classic 24 |
| `4mebs4k` | ATEM 4 M/E Broadcast Studio 4K | 0x07 | 4 | 20 | 4 | 2 | 1 | 1 (4) | 4 | 6 | 2 (10) | classic 26 |

## Uncertain numbers, per model

### ATEM Mini (`mini`)

- The HDMI output and the USB webcam output are the two aux buses the switcher reports [CM]; Blackmagic calls them outputs, not aux.

### ATEM Mini Pro (`minipro`)

- The Mini Pro multiview has a fixed layout (no routable windows): uncertain, from the Mini manual, not tested on a unit.

### ATEM Mini Pro ISO (`miniproiso`)

- The Mini Pro multiview has a fixed layout (no routable windows): uncertain, from the Mini manual, not tested on a unit.

### ATEM Television Studio HD8 (`tvshd8`)

- DVEs: Blackmagic lists 2 (1 upstream DVE + 1 for DVE transitions); companion-module-bmd-atem models 1.
- MADI: 16 stereo inputs (32 channels) and 32 MADI routing outputs, from [CM]; the Blackmagic page says "up to 32 channels of MADI".
- Clean feed count is 1 in [CM] (marked TODO there).

### ATEM Television Studio HD8 ISO (`tvshd8iso`)

- DVEs: Blackmagic lists 2 (1 upstream DVE + 1 for DVE transitions); companion-module-bmd-atem models 1.
- MADI: 16 stereo inputs (32 channels) and 32 MADI routing outputs, from [CM]; the Blackmagic page says "up to 32 channels of MADI".
- Clean feed count is 1 in [CM] (marked TODO there).

### ATEM 1 M/E Constellation HD (`chd1me`)

- DSKs: 1 per [CM]; [CM] also lists 2 DSK mask sources for this model, which does not match one DSK (1 used here).
- All 6 SDI outputs are routable like aux outputs.

### ATEM 2 M/E Constellation HD (`chd2me`)

- DVEs: Blackmagic lists 2; companion-module-bmd-atem models 1.
- No MADI on 2 M/E models (Blackmagic: MADI is on the 4 M/E models).

### ATEM 4 M/E Constellation HD (`chd4me`)

- MADI: 1 MADI input (32 stereo channels, modelled as 32 stereo Fairlight inputs 1501-1532) and 2 MADI outputs (32 routing outputs 1001-1032), from [CM] and the Blackmagic page.

### ATEM 1 M/E Constellation 4K (`c4k1me`)

- DSKs: 1 per [CM]; [CM] also lists 2 DSK mask sources for this model, which does not match one DSK (1 used here).
- All 6 SDI outputs are routable like aux outputs.
- Same topology as the HD model per [CM].

### ATEM 2 M/E Constellation 4K (`c4k2me`)

- DVEs: Blackmagic lists 2; companion-module-bmd-atem models 1.
- No MADI on 2 M/E models (Blackmagic: MADI is on the 4 M/E models).
- Same topology as the HD model per [CM]; Blackmagic: 20 x 12G-SDI in, 12 x 12G-SDI out, 2 multiviews, 8 keyers, 1 SuperSource, 2 media players, 40 stills.

### ATEM 4 M/E Constellation 4K (`c4k4me`)

- MADI: 1 MADI input (32 stereo channels, modelled as 32 stereo Fairlight inputs 1501-1532) and 2 MADI outputs (32 routing outputs 1001-1032), from [CM] and the Blackmagic page.
- Stills: 64 for the 4K model [CM].

### ATEM Constellation 8K (8K mode) (`c8k`)

- 8K mode: Blackmagic lists 10 inputs, 6 aux, 1 M/E with 4 keyers, 2 DSKs, 1 DVE, 1 media player, 24 stills, 1 multiview; SuperSource count in 8K mode is not published (1 here, from [CM]).
- Product id 0x0c is the 8K personality and 0x0b the HD / Ultra HD one, per [CM]; not checked on a unit.
- MADI routing outputs: 8 in 8K mode per [CM] (uncertain).

### ATEM Constellation 8K (HD/UHD mode) (`c8khd`)

- HD / Ultra HD mode: 40 inputs, 24 aux, 4 M/E, 16 keyers, 4 DSKs, 4 DVEs, 2 SuperSource, 4 media players, 4 multiviews [BM].
- Product id 0x0b for this personality per [CM]; not checked on a unit.

### ATEM Production Studio 4K (`ps4k`)

- No DVE: the upstream key has no DVE type (dve 0 per [CM]).
- Inputs 1-4 HDMI, 5-8 SDI per [CM] audio port table.
- Multiview windows 3-10 routable, Program / Preview fixed (classic 10-view layout).

### ATEM 2 M/E Production Studio 4K (`2meps4k`)

- Input 1 switches between SDI and HDMI [CM]; shown as HDMI here.
- Keyers: 2 per M/E [CM].

### ATEM 4 M/E Broadcast Studio 4K (`4mebs4k`)

- Product id 0x07 is named TwoMEBS4K in atem-connection but is the 4 M/E Broadcast Studio 4K per [CM].
- Audio: Blackmagic says "24 input x 2 channel mixer"; [CM] lists 26 (20 SDI, XLR, RCA, 4 media players). 26 used here.
- Multiview: 2 x 10 views (Blackmagic), 8 routable windows each.

## General modelling choices

- **DVE limit.** The simulator refuses a USK type change to DVE once the profile's DVE count is used by DVE-type keyers
  (the real switcher also counts transition DVE / SuperSource use; this is approximate).
- **Multiviewer routing.** \`mvRoutable\`: \`none\` (Mini Pro, fixed layout), \`small\` (windows 2+ only, classic 10-view
  switchers where windows 0/1 are fixed to PGM/PVW) or \`all\`.
- **MADI** is modelled as stereo channels (one Fairlight input per pair), routed with \`AROC\`.
- **SuperSource clamps:** box x ±4800, y ±2700 (×100), size 70..1000 (×1000), crop top/bottom ≤ 18000, left/right ≤ 32000.

## Protocol commands added in 0.10.0

All are byte-checked against the LibAtem vectors (\`test/fixtures/atem-vectors.json\`, 164 vectors, from Sofie
atem-connection's \`libatem-data.json\`, MIT) and against the mock. **None has been sent to real hardware.**

| area | setters (app → switcher) | state (switcher → app) |
|---|---|---|
| router | \`CAuS\` (aux), \`CPgI\`/\`CPvI\` (M/E), \`CMvI\` (multiviewer window) | \`AuxS\`, \`PrgI\`, \`PrvI\`, \`MvIn\`, \`MvPr\`, \`_MvC\` |
| upstream keys | \`CKTp\`, \`CKeF\`, \`CKeC\`, \`CKMs\`, \`CKLm\`, \`CKCk\`, \`CKPt\`, \`CKDV\`, \`SFKF\`, \`RFlK\` | \`KeBP\`, \`KeLm\`, \`KeCk\`, \`KePt\`, \`KeDV\`, \`KeFS\`, \`KKFP\` |
| downstream keys | \`CDsF\`, \`CDsC\`, \`CDsG\`, \`CDsM\`, \`CDsR\` | \`DskB\`, \`DskP\` |
| SuperSource | \`CSBP\` (V8 layout), \`CSSc\`, \`CSBd\` | \`SSrc\`, \`SSBd\`, \`SSBP\`, \`_SSC\` |
| classic audio | \`CAMI\`, \`CAMM\`, \`CAMm\`, \`CAMH\` | \`AMIP\`, \`AMMO\`, \`AMmO\`, \`AMHP\`, \`AMPP\`, \`_AMC\` |
| Fairlight | \`CFSP\`, \`CFMP\`, \`CFMH\`, \`CFMS\` | \`FAIP\`, \`FASP\`, \`FASD\`, \`FAMP\`, \`FMHP\`, \`FAMS\`, \`_FAC\` |
| audio routing | \`AROC\` | \`AROP\`, \`ARSP\` |

Known disagreements between references:

- \`_MvC\` from V8.1.1: LibAtem puts the window count in byte 0, atem-connection reads byte 1. The driver follows
  atem-connection; the mock writes both. Check on hardware.
- \`KeFS\`: LibAtem reads *running to keyframe* at byte 4, atem-connection *is at keyframe* at byte 6. Both are parsed.

## Protocol commands added in 0.11.0 (unverified)

None of these has been sent to a real switcher. Their encodings come from atem-connection 3.10.3 and are checked
only against the mock (`test/atem-audio-desk.test.js`, `test/ui-desk-save.test.js`). **Try them on a spare
switcher before a show.**

| Command | Used by | Bytes (from atem-connection 3.10.3) |
|---|---|---|
| `SRsv` | SAVE → *also save the ATEM startup state* | 4 zero bytes |
| `RICD` | DESK ZERO (Fairlight): reset an input's dynamics | 20 bytes: u16 input index @0, source (i64) @8, reset bits `0b1111` @17 |
| `RICE` | DESK ZERO (Fairlight): reset an input's EQ | flag 1 @0, u16 input index @2, source (i64) @8, equalizer 1 @16 |
| `RMOD` | DESK ZERO (Fairlight): reset the master dynamics | 4 bytes, reset bits `0b1111` @1 |
| `RMOE` | DESK ZERO (Fairlight): reset the master EQ | `[1, 1, 0, 0]` |

The rest of MUTE ALL and DESK ZERO uses commands that were already in 0.10.0 (`CAMI`, `CAMM`, `CFSP`, `CFMP`).
DESK ZERO sets gain 0 dB, balance centre, EQ off and EQ gain / make-up 0, and resets dynamics. It does not change
mix (on / off / AFV), routing, delay, monitor or solo. MUTE ALL remembers each input's mix and UN-MUTE ALL restores
only the inputs it muted.
