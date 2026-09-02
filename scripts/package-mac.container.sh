#!/bin/sh
# Runs INSIDE the codefly-mac-builder container (see package-mac.mjs). Expects the
# repository bind-mounted at /project with out/ already built on the host.
#
# 1. electron-builder assembles the x64 and arm64 apps under the container's native /tmp
#    filesystem. Building directly on the Windows bind mount makes its final directory
#    rename intermittently fail with EACCES. `dir` is forced from the CLI: the
#    zip target would compress with 7-Zip, which dereferences the symlinks inside
#    Electron Framework.framework (see electron-builder.yml).
# 2. Info-ZIP `zip -y` stores those symlinks as symlinks and keeps the executable
#    bits, so the archive unpacks on macOS to the same bundle electron-builder laid
#    out on disk.
set -eu

cd /project

version=$(node -p "require('./package.json').version")
output_dir=/tmp/codefly-mac-release

node node_modules/electron-builder/cli.js \
  --config electron-builder.mac-cross.yml \
  --config.directories.output="$output_dir" \
  --mac dir --x64 --arm64 \
  --publish never

echo "Compressing bundles with zip -y (symlinks preserved):"
for entry in mac:x64 mac-arm64:arm64; do
  dir=${entry%%:*}
  arch=${entry##*:}
  app=$(find "$output_dir/$dir" -mindepth 1 -maxdepth 1 -name '*.app' -type d | head -n 1)
  if [ -z "$app" ]; then
    echo "No .app bundle found under $output_dir/$dir" >&2
    exit 1
  fi
  case "$arch" in
    x64) other_arch=darwin-arm64 ;;
    arm64) other_arch=darwin-x64 ;;
    *) echo "Unsupported macOS bundle architecture: $arch" >&2; exit 1 ;;
  esac
  rm -rf "$app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/$other_arch"
  name=$(basename "$app" .app)
  zipfile="$name-$version-mac-$arch.zip"
  rm -f "release/$zipfile"
  (cd "$output_dir/$dir" && zip -r -y -X -q "/project/release/$zipfile" "$name.app")
  echo "  release/$zipfile"
done
