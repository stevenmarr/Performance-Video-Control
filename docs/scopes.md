# Video scopes

Scopes is a standalone Mac app in this repo. Control Center does not show a SCOPES tab and does not
serve `/api/scopes` or `/scopes.html`.

Run it from `apps/scopes` (default **http://127.0.0.1:8092**). Install, the LaunchAgent, Desktop Video
and cameras are in [apps/scopes/README.md](../apps/scopes/README.md).

Scope modes (waveform, parade, vectorscope, Lightning, Diamond, false colour) and the INPUT menu:
[apps/scopes/docs/scopes.md](../apps/scopes/docs/scopes.md).

Desktop Video: [apps/scopes/docs/decklink-ingest.md](../apps/scopes/docs/decklink-ingest.md).
Legacy NDI: [apps/scopes/docs/ndi-ingest.md](../apps/scopes/docs/ndi-ingest.md).

You cannot type a new source in the INPUT menu. The list is Desktop Video devices, cameras, test clips,
and a legacy NDI sidecar only while it is pushing.

The scope dock uses the same 30 px row unit as the PTZ camera page. The stage scrolls vertically
when the grid is taller than the window. Panels are not shrunk to fit the viewport.
