# ATEM layout editor

ATEM → **LAYOUT** is a 16:9 program raster for SuperSource boxes and upstream DVE keys. Drag a box to move it, drag a handle to resize it, and type the same numbers beside the picture. The page reads the switcher's source names and draws each box in a stable color. It does not pull input thumbnails; the switcher protocol this app speaks has no per-input thumbnail.

**APPLY** sends the picture to the switcher. **READ** loads the switcher's current boxes and keys back, dropping anything not yet sent. **LIVE** sends each drag and each number as you finish it. **HOLD** keeps the edits on the page until APPLY.

**SAVE PRESET** stores the picture on this install (same place as the older SuperSource layout buttons, not inside a show file). **SAVE MACRO** writes two things:

- a Macro Desk macro, which plays by sending the switcher commands
- ATEM Software Control XML, in the box under the buttons, for File → Restore

A macro cuts to the layout. It does not animate the move. To fly, store key frame A and key frame B, then **RUN A** / **RUN B**. Those run commands are not part of the macro.

## What is on the raster

SuperSource boxes and the selected M/E's DVE keys are drawn on one frame so they can be lined up. They are not the same compositor. A SuperSource box is inside that SuperSource source. A DVE key sits on the M/E, over whatever is on the background. They stack on the program output only when that SuperSource is the background of that M/E.

**BOTH**, **SUPERSOURCE**, and **DVE KEYS** show one or the other. **THIRDS**, **CENTER**, and **SAFE** are guides (thirds, the center cross, action safe at 90%, title safe at 80%). Dragging snaps to those lines and to the other boxes. **ASPECT** keeps a DVE key's shape while you drag. A SuperSource box is always 16:9; the hardware has one size, not a separate width and height.

Arrow keys nudge the selected box by 0.1 frame unit, or by 1 with Shift.

## Per layer

| Layer | What you can set | Hardware note |
|---|---|---|
| SuperSource box | enable, source, x, y, size, crop (top, bottom, left, right) | Size is one number. Crop is the box mask. |
| SuperSource art | fill, key, background or foreground, pre-multiplied or clip/gain, invert | One art layer for that SuperSource. |
| SuperSource border | on, outer/inner width, softness, hue, saturation, luma, bevel, light direction and altitude | One border for every box on that SuperSource, not a border per box. |
| Upstream key | type (luma, chroma, pattern, DVE), fill, key (luma only), the type's settings, mask, on air | Only DVE, or a key with Fly on, is a box on the raster. |
| DVE / fly key | x, y, size x, size y, rotation, border, shadow, light, DVE mask, rate | Uses one of the model's DVEs. |

Luma, chroma, and pattern keys stay in the layer list with their settings. They fill the frame, so they are not draggable boxes. Pattern position is the pattern generator, not a picture-in-picture.

## Models that cannot do some of this

The page follows the connected model (or the simulator's model).

- No SuperSource (Mini, Mini Pro, 1 M/E Constellation, Production Studio 4K): no boxes, no art, no SuperSource border. The note on the page says so. Macros omit every `SuperSource…` op.
- No DVE (Production Studio 4K): the DVE type is disabled. Macros do not emit DVE ops. A key that was marked DVE is saved as luma instead, and the skip reason says there is no DVE left.
- Fewer keyers: only the keyers that M/E has are listed. A 1 M/E Mini has one upstream key.
- More than one SuperSource (4 M/E Constellation, Constellation 8K in HD): **SS 1** / **SS 2** chooses which generator is on the raster.
- More than one M/E: the M/E buttons match the switcher page. Upstream keys are that M/E's keys.
- DVE pool: the model has a fixed number of DVEs. Extra keys that ask for DVE are left as luma and listed under skipped. The simulator's count is the profile's DVE count; a real switcher also counts a DVE transition. See [atem-models.md](atem-models.md).

## Units

The frame is 32 units wide and 18 tall, origin in the center, positive Y up. That is the frame Software Control's macro numbers use.

| Value | Switcher integer | Macro number |
|---|---|---|
| SuperSource x, y | ×100, x ±4800, y ±2700 | frame units (−8 is `xPosition="-8"`) |
| SuperSource size | ×1000, 70…1000 | 0.07…1 |
| SuperSource crop | ×1000, top/bottom ≤ 18000, left/right ≤ 32000 | the same frame units |
| DVE position, size | ×1000 | frame units, size 1 = full frame |
| DVE rotation, hues, light direction | ×10 | degrees |
| Clip, gain, border luma and saturation | ×10 percent | 0…1 in the macro |
| Border width | ×100 | the width Software Control shows |

## Macro operations

The XML is the Software Control macro document (`Profile` / `MacroPool` / `Op`). Op ids below are the ones that show up in real Software Control exports (Constellation exports and the public snippet catalogs built from them). Playing the macro from Control Center does not depend on the XML: it sends the protocol commands the driver already uses (`CSBP`, `CSSc`, `CSBd`, `CKTp`, `CKDV`, `SFKF`, …). Those commands are checked against the simulator. They have not been sent to a real switcher, same as the rest of the ATEM protocol in this app.

The protocol can run and record a macro slot. It cannot download the steps inside a slot, and Control Center does not overwrite a slot whose steps it cannot read. Import the XML with ATEM Software Control (File → Restore, Macros only) when the macro has to live on the hardware.

Export-confirmed ops used here:

- `SuperSourceV2BoxEnable`, `SuperSourceV2BoxInput`, `SuperSourceV2BoxXPosition`, `SuperSourceV2BoxYPosition`, `SuperSourceV2BoxSize`
- `SuperSourceV2BoxMaskEnable`, `SuperSourceV2BoxMaskTop`, `SuperSourceV2BoxMaskBottom`, `SuperSourceV2BoxMaskLeft`, `SuperSourceV2BoxMaskRight`
- `SuperSourceV2ArtFillInput`, `SuperSourceV2ArtCutInput`, `SuperSourceV2ArtAbove`
- `KeyType`, `KeyFillInput`, `KeyCutInput`, `KeyOnAir`, `KeyFlyEnable`, `KeyMaskEnable`, `KeyMaskTop`, `KeyMaskBottom`, `KeyMaskLeft`, `KeyMaskRight`
- `DVEAndFlyKeyXSize`, `DVEAndFlyKeyYSize`, `DVEAndFlyKeyXPosition`, `DVEAndFlyKeyYPosition`, `DVEAndFlyKeyRotation`
- `DVEKeyBorderEnable`, `DVEKeyBorderOuterWidth`, `DVEKeyBorderInnerWidth`, `DVEKeyBorderOuterSoftness`, `DVEKeyBorderInnerSoftness`, `DVEKeyBorderOpacity`, `DVEKeyBorderHue`, `DVEKeyBorderSaturation`, `DVEKeyBorderLuminescence`
- `DVEKeyShadowEnable`, `DVEKeyShadowDirection`, `DVEKeyShadowAltitude`
- `DVEKeyMaskEnable`, `DVEKeyMaskTop`, `DVEKeyMaskBottom`, `DVEKeyMaskLeft`, `DVEKeyMaskRight`
- `LumaKeyPreMultiply`, `LumaKeyClip`, `LumaKeyGain`, `LumaKeyInvert`
- `ChromaKeyHue`, `ChromaKeyGain`
- `PatternKeyPattern`, `PatternKeySize`, `PatternKeySymmetry`, `PatternKeySoftness`, `PatternKeyXPosition`, `PatternKeyYPosition`, `PatternKeyInvert`

These follow that same naming (the `SuperSourceV2Art*` and `SuperSourceV2Border*` families are in real exports; the attribute names match the luma and DVE ops above). They are the ones to check first if a Software Control import skips a line:

- `SuperSourceV2ArtPreMultiply`, `SuperSourceV2ArtClip`, `SuperSourceV2ArtGain`, `SuperSourceV2ArtInvert`
- `SuperSourceV2BorderEnable`, `SuperSourceV2BorderBevel`, `SuperSourceV2BorderOuterWidth`, `SuperSourceV2BorderInnerWidth`, `SuperSourceV2BorderOuterSoftness`, `SuperSourceV2BorderInnerSoftness`, `SuperSourceV2BorderBevelSoftness`, `SuperSourceV2BorderBevelPosition`, `SuperSourceV2BorderHue`, `SuperSourceV2BorderSaturation`, `SuperSourceV2BorderLuminescence`, `SuperSourceV2BorderLightSourceDirection`, `SuperSourceV2BorderLightSourceAltitude`
- `ChromaKeyYSuppress`, `ChromaKeyLift`, `ChromaKeyNarrow`
- `DVEAndFlyKeyRate`, `DVEKeyBorderBevel`
- `FlyKeyStoreKeyFrame` with `keyFrame="A"` or `"B"`

`FlyKeyStoreKeyFrame` is the fly-key family name (`KeyFlyEnable` and `FlyKeyResetKeyFrame` are the ones seen verbatim in exports). The command Control Center actually sends is `SFKF`, which the simulator applies: it copies the DVE geometry just set into key frame A or B. The macro does not contain a run-to op, so importing it does not fly. **RUN A** / **RUN B** send `RFlK`, which does animate, and they stay off the macro on purpose.

Source names in the XML are Software Control's tokens (`Camera1`, `MediaPlayer1`, `MediaPlayer1Key`, `SuperSource`, `Color1`, `ME1Program`, …), not the raw source id.

Older Macro Desk steps (`PreviewInput`, `SuperSourceBoxSource`, and the rest of that subset) are unchanged. A layout step exports as the V2 ops above. Importing that XML back into the Macro Desk rebuilds the steps.
