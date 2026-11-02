# ATEM router

The ROUTER page works like Blackmagic Videohub Control.

Each output is one row. The output name is on the left (Output 1, HDMI Out, Aux 1 — whatever that ATEM calls it). The source on that output right now is on the right, in gold, with a dropdown mark.

Tap the row. A popover opens on that output:

* **Search** narrows the sources by name. It does not change which output you are routing.
* **SOURCES** is the normal bank: cameras, black, bars, color, media player fill, clean feed, program, preview, and the other sources you would put on an aux.
* **ADVANCED** is the key and mask bank: media player key signals and key masks. Those stay off the SOURCES bank so a mis-tap does not send a key to an output.
* **SHIFT** pages the bank. Sixteen sources show at a time, the same idea as a hardware panel that has fewer buttons than sources. SHIFT lights after the first page. The label reads `PAGE 2 / 4`. From the last page, SHIFT returns to page 1. If the filtered list fits on one page, SHIFT is dim.
* The source that is already on the output is outlined. Tap a source and the output takes it. The popover closes. The row shows the new source.

There are no ALL / INPUTS / MEDIA (or other) filter chips. Search and the ADVANCED tab cover that.

Multiview windows are not on this page. Both multiviewers used to be listed here as window grids. Route those on the MULTIVIEW page. The switcher still accepts a multiview route on the API; the panel just does not offer it.

Esc, the ✕, or a click outside the popover closes it without routing. Enter in the search box takes the first source that matches.
