# design/

Artwork that the build does not consume. Nothing in here is wired into
`electron-builder.yml` or bundled by Vite — the shipping icons live in
[`build/`](../build) (the packaged app icon) and
[`src/renderer/src/assets/`](../src/renderer/src/assets) (in-app icons).

## `mobile-app-icon.svg` / `mobile-app-icon-1024.png`

The white-rocket-on-purple treatment, kept for a future mobile app.

Phones and desktops want opposite things from an app icon, which is why this is a
separate file rather than the one `build/` ships. A Windows shortcut and a macOS
dock take a transparent silhouette, so the desktop icon is exactly that. iOS and
Android instead hand you an opaque square and apply their own mask, so the
artwork has to bring its own ground — that is this version.

Read the comment at the top of the SVG before exporting: it records the geometry,
why the porthole is a punched subpath rather than a painted shape, and the
per-platform gotchas (iOS wants the alpha channel gone entirely; Android's
adaptive-icon safe area is the middle 66%).

The PNG is a straight 1024 export of the SVG, rasterised with Chromium.
