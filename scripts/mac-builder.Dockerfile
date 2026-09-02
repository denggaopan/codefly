# Image used by scripts/package-mac.mjs to run electron-builder for macOS targets
# from a non-macOS host. Node runs electron-builder itself (it is a pure-JS
# dependency once the Electron download and asar steps are involved); Info-ZIP
# `zip -y` is what preserves the symlinks inside Electron Framework.framework when
# the bundle is compressed — the 7-Zip electron-builder would use off macOS
# dereferences them.
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends zip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
