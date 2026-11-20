#!/usr/bin/env bash
# Download the uv binary for the current host into desktop/src-tauri/binaries/
# so Tauri can bundle it as a resource and our app doesn't need a PATH-installed uv.
#
# For cross-platform release builds, run this on each target host (or extend
# the script to iterate over UV_RELEASE_TARGETS in CI).

set -euo pipefail

VERSION="${UV_VERSION:-0.9.25}"
cd "$(dirname "$0")/.."

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  Darwin-arm64)        TARGET="aarch64-apple-darwin" ;;
  Darwin-x86_64)       TARGET="x86_64-apple-darwin" ;;
  Linux-x86_64)        TARGET="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64)       TARGET="aarch64-unknown-linux-gnu" ;;
  MINGW*-x86_64|MSYS*-x86_64) TARGET="x86_64-pc-windows-msvc" ;;
  *) echo "unsupported host: $OS-$ARCH" >&2; exit 1 ;;
esac

# Windows uv releases ship as .zip; everything else is .tar.gz.
case "$TARGET" in
  *windows*) ARCHIVE_EXT="zip" ;;
  *)         ARCHIVE_EXT="tar.gz" ;;
esac

URL="https://github.com/astral-sh/uv/releases/download/${VERSION}/uv-${TARGET}.${ARCHIVE_EXT}"
DEST="src-tauri/binaries"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ uv ${VERSION} for ${TARGET}"
echo "  ${URL}"
curl -fsSL "$URL" -o "$TMP/uv.${ARCHIVE_EXT}"

if [ "$ARCHIVE_EXT" = "zip" ]; then
  unzip -q "$TMP/uv.${ARCHIVE_EXT}" -d "$TMP"
else
  tar -xzf "$TMP/uv.${ARCHIVE_EXT}" -C "$TMP"
fi

mkdir -p "$DEST"
# Different uv release archives use different layouts. The unix tarballs
# wrap files in uv-<target>/; the windows zip extracts files at the root.
# Find whichever uv binary landed and copy it.
UV_SRC="$(find "$TMP" -maxdepth 3 -type f \( -name 'uv' -o -name 'uv.exe' \) | head -1)"
if [ -z "$UV_SRC" ]; then
  echo "uv binary not found in archive layout:" >&2
  ls -lR "$TMP" >&2
  exit 1
fi
DEST_NAME="$(basename "$UV_SRC")"
# `install` isn't on Windows Git Bash; use cp + chmod which work everywhere.
cp "$UV_SRC" "$DEST/$DEST_NAME"
chmod 0755 "$DEST/$DEST_NAME" 2>/dev/null || true

echo "✓ installed → $DEST/"
ls -lh "$DEST"
