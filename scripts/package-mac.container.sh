#!/bin/sh
# Runs INSIDE the codefly-mac-builder container (see package-mac.mjs). Expects the
# repository bind-mounted at /project with out/ already built on the host.
#
# 1. electron-builder assembles release/mac/<Product>.app (x64) and
#    release/mac-arm64/<Product>.app (arm64). `dir` is forced from the CLI: the
#    zip target would compress with 7-Zip, which dereferences the symlinks inside
#    Electron Framework.framework (see electron-builder.yml).
# 2. Info-ZIP `zip -y` stores those symlinks as symlinks and keeps the executable
#    bits, so the archive unpacks on macOS to the same bundle electron-builder laid
#    out on disk.
set -eu

cd /project

version=$(node -p "require('./package.json').version")

node node_modules/electron-builder/cli.js \
  --config electron-builder.mac-cross.yml \
  --mac dir --x64 --arm64 \
  --publish never

echo "Compressing bundles with zip -y (symlinks preserved):"
for entry in mac:x64 mac-arm64:arm64; do
  dir=${entry%%:*}
  arch=${entry##*:}
  app=$(find "release/$dir" -mindepth 1 -maxdepth 1 -name '*.app' -type d | head -n 1)
  if [ -z "$app" ]; then
    echo "No .app bundle found under release/$dir" >&2
    exit 1
  fi
  name=$(basename "$app" .app)
  zipfile="$name-$version-mac-$arch.zip"
  rm -f "release/$zipfile"
  (cd "release/$dir" && zip -r -y -X -q "../$zipfile" "$name.app")
  echo "  release/$zipfile"
done
