# ATEM layout editor

ATEM → **LAYOUT** has three sub-tabs: **M/Es**, **SUPERSOURCE**, and **MULTIVIEW**. Properties for the selected key, box, or window are on the left. The resources for the tab are on the right. The canvases are 16:9. The page reads the switcher's source names and draws each box in a stable color. It does not pull input thumbnails; the switcher protocol this app speaks has no per-input thumbnail.

**APPLY** sends the active tab to the switcher (the look, or the multiview). **READ** loads that tab back from the switcher and drops anything not yet sent. **LIVE** sends each drag and each number as you finish it, and a drop also puts that resource on air. **HOLD** keeps the drop on the page only: the resource is placed, and it stays off air until LIVE, the on-air button, or a program recall.

**SAVE PRESET** stores the M/E, downstream-key, and SuperSource look on this install (not inside a show file), with a recall target of Preview or Program. Recall can choose either bus again. **SAVE SALVO** stores a multiview the same way. **SAVE MACRO** writes two things:

- a Macro Desk macro, which plays by sending the switcher commands
- ATEM Software Control XML, in the box under the buttons, for File → Restore

A macro cuts to the layout. It does not animate the move. To fly, store key frame A and key frame B, then **RUN A** / **RUN B**. Those run commands are not part of the macro.

## M/Es

Every M/E on the connected switcher is a 16:9 canvas at the same time. On a wide screen four M/Es sit in quadrants: M/E 1 top-left, M/E 2 top-right, M/E 3 bottom-left, M/E 4 bottom-right. Two sit side by side. One fills the area. Three share one row. Each M/E button in the toolbar hides or shows that canvas, and the ones left reflow. The choice is kept in this browser.

The right-hand list is that M/E's upstream keyers (as many as the model has, four on a Constellation) plus a **DOWNSTREAM** group for the DSKs. Drag a key onto its own M/E. A key will not drop on a different M/E. Drag a DSK onto M/E 1; downstream keys composite after that M/E. Once a resource is on a canvas it is checked and greyed in the list and will not drag again.

A drop places the resource. It does not cut it on air unless **LIVE** is on. With a free DVE, the key becomes a DVE window at the drop point (half frame). With no DVE left, it fills the frame. A DSK that is placed and not yet on air is tied, so the next transition can take it. Right-click the canvas item or its row for **Properties**, **Bring to front** (drawing order on this page; the switcher still stacks key 1 over key 2), and **Delete**. Delete takes it off air, clears a DSK tie, and turns a DVE key back to luma so it returns to the list. Fill, mask, and the other type's numbers stay.

**READ** marks a key used when it is on air, a DVE, or flying, and a DSK used when it is on air or tied.

**THIRDS**, **CENTER**, and **SAFE** are guides (thirds, the center cross, action safe at 90%, title safe at 80%). Dragging snaps to those lines and to the other windows on the same canvas. **ASPECT** keeps a DVE key's shape while you drag. Arrow keys nudge the selected window by 0.1 frame unit, or by 1 with Shift.

## SUPERSOURCE

Each SuperSource is its own 16:9 canvas. Boxes are the resources: four per SuperSource, and a second SuperSource when the model has one. Drag a box onto its own SuperSource. A box is used when it is enabled. Delete disables it and keeps the position, so the next drop puts it back. Size is one number and stays 16:9. Crop is the box mask. Art and the border are SuperSource-wide: one border for every box, shown under the selected box's properties.

## Looks on preview or program

**SAVE PRESET** stores the whole look (every M/E, the DSKs, every SuperSource) and the bus you picked. **PREVIEW** recall puts each M/E's background on preview, leaves placed keys off air, and arms them in the next transition (plus a tied DSK) so the operator can take the look. **PROGRAM** recall cuts that background on air and puts the placed keys and DSKs on air. **APPLY** sends the on-air flags as they are on the page, without that bus choice.

## MULTIVIEW

One canvas per multiviewer. The four layout positions are Program top, Program bottom, Program left, and Program right. Windows 0 and 1 are the large preview and program cells; **SWAP** exchanges them. The other windows fill the remaining area. Click a window and pick a source the multiview can take. Windows the model fixes (the large pair on a classic 10-view) stay fixed. Safe area and VU are toggles on windows whose state says they support them; the switcher reports that support on `MvIn`. **APPLY** sends layout, swap, sources, and those toggles. **SAVE SALVO** keeps the multiview on this install. **SAVE MACRO** writes the same steps the Macro Desk can play, and Software Control XML.

## Per layer

| Layer | What you can set | Hardware note |
|---|---|---|
| SuperSource box | enable, source, x, y, size, crop (top, bottom, left, right) | Size is one number. Crop is the box mask. |
| SuperSource art | fill, key, background or foreground, pre-multiplied or clip/gain, invert | One art layer for that SuperSource. |
| SuperSource border | on, outer/inner width, softness, hue, saturation, luma, bevel, light direction and altitude | One border for every box on that SuperSource, not a border per box. |
| Upstream key | type (luma, chroma, pattern, DVE), fill, key (luma only), the type's settings, mask, on air | A drop places it. On air is separate unless LIVE is on. DVE, or a key with Fly on, is a sized window. |
| Downstream key | fill, key, clip, gain, invert, mask, rate, tie, on air | No picture position. It keys over the program output. Drop it on M/E 1. |
| DVE / fly key | x, y, size x, size y, rotation, border, shadow, light, DVE mask, rate | Uses one of the model's DVEs. |

Luma, chroma, and pattern keys stay in the layer list with their settings. They fill the frame, so they are not draggable boxes. Pattern position is the pattern generator, not a picture-in-picture.

## Models that cannot do some of this

The page follows the connected model (or the simulator's model).

- No SuperSource (Mini, Mini Pro, 1 M/E Constellation, Production Studio 4K): no boxes, no art, no SuperSource border. The note on the page says so. Macros omit every `SuperSource…` op.
- No DVE (Production Studio 4K): the DVE type is disabled. Macros do not emit DVE ops. A key that was marked DVE is saved as luma instead, and the skip reason says there is no DVE left.
- Fewer keyers: only the keyers that M/E has are listed. A 1 M/E Mini has one upstream key.
- More than one SuperSource (4 M/E Constellation, Constellation 8K in HD): each SuperSource is its own canvas.
- More than one M/E: every M/E is on the page together. Hide one with its button. Upstream keys belong to that M/E. Downstream keys are one group for the switcher.
- Multiview: one canvas per multiviewer. A fixed window (classic 10-view program and preview) cannot be routed. Safe area and VU are offered only when that window's `MvIn` support flags are set.
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
- `PreviewInput`, `ProgramInput`, `TransitionSelection` when a look is recalled to a bus
- `DownstreamKeyFill`, `DownstreamKeyCut`, `DownstreamKeyRate`, `DownstreamKeyPreMultiply`, `DownstreamKeyClip`, `DownstreamKeyGain`, `DownstreamKeyInvert`, `DownstreamKeyMaskEnable`, `DownstreamKeyTie`, `DownstreamKeyOnAir`
- `MultiViewerLayout` (`ProgramTop`, `ProgramBottom`, `ProgramLeft`, `ProgramRight`), `MultiViewerProgramPreviewSwapped`, `MultiViewerWindowInput`, `MultiViewerWindowVu`, `MultiViewerWindowSafeArea`

`FlyKeyStoreKeyFrame` is the fly-key family name (`KeyFlyEnable` and `FlyKeyResetKeyFrame` are the ones seen verbatim in exports). The command Control Center actually sends is `SFKF`, which the simulator applies: it copies the DVE geometry just set into key frame A or B. The macro does not contain a run-to op, so importing it does not fly. **RUN A** / **RUN B** send `RFlK`, which does animate, and they stay off the macro on purpose.

Source names in the XML are Software Control's tokens (`Camera1`, `MediaPlayer1`, `MediaPlayer1Key`, `SuperSource`, `Color1`, `ME1Program`, …), not the raw source id.

Older Macro Desk steps (`PreviewInput`, `SuperSourceBoxSource`, and the rest of that subset) are unchanged. A layout step exports as the V2 ops above. Importing that XML back into the Macro Desk rebuilds the steps.
