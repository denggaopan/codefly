# design/

Artwork that the build does not consume. Nothing in here is wired into
`electron-builder.yml` or bundled by Vite — the shipping icons live in
[`build/`](../build) (the packaged app icon) and
[`src/renderer/src/assets/`](../src/renderer/src/assets) (in-app icons).

## `icon-1.png`

The flat 512px export the desktop mark was drawn from: the same rocket and "C"
porthole as [`build/icon.svg`](../build/icon.svg), in one solid `#9d4edd`, with no
gradient and no drop shadow.

Keep it as the reference for the silhouette. What ships is
[`build/icon.png`](../build/icon.png) / `icon.ico`, rasterised from the SVG by
[`scripts/rasterize-icons.mjs`](../scripts/rasterize-icons.mjs) — the depth in
those comes from a gradient and an `feDropShadow` that live in the SVG, so this
bitmap is not a substitute for either of them.

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
