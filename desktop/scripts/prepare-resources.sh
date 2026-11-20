#!/usr/bin/env bash
# Build the Python-side resources that Tauri bundles into the .app/.exe.
#
# Produces under desktop/src-tauri/resources/:
#   server/             — frozen copy of the server/ source tree (no .venv,
#                          no __pycache__, no tests)
#   wheels/             — pre-built wheels: gridsight-sdk, gridsight-seds
#   requirements.txt    — pinned PyPI deps derived from server/pyproject.toml
#                          (with the local packages stripped)
#
# Only first-party packages from this repo go into the app. External
# extensions (GAT, DemandTldr, ...) are never bundled, even when a sibling
# checkout exists: users install them from the app (side-load a wheel or
# bundle zip, or a PyPI/git spec).
#
#   GRIDSIGHT_REPO       — defaults to two levels up from this script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES="$DESKTOP_DIR/src-tauri/resources"
WHEELS="$RESOURCES/wheels"

GRIDSIGHT_REPO="${GRIDSIGHT_REPO:-$(cd "$DESKTOP_DIR/.." && pwd)}"

UV="${UV:-$DESKTOP_DIR/src-tauri/binaries/uv}"
if [ ! -x "$UV" ]; then
  UV="$(command -v uv || true)"
fi
if [ -z "$UV" ] || [ ! -x "$UV" ]; then
  echo "uv binary not found. Run scripts/fetch-uv.sh first, or install uv on PATH." >&2
  exit 1
fi

echo "→ gridsight repo:  $GRIDSIGHT_REPO"
echo "→ uv:             $UV"

for d in "$GRIDSIGHT_REPO/server" "$GRIDSIGHT_REPO/sdk" "$GRIDSIGHT_REPO/extensions/seds"; do
  if [ ! -d "$d" ]; then
    echo "missing required source dir: $d" >&2
    exit 1
  fi
done

echo "→ cleaning $RESOURCES"
rm -rf "$RESOURCES"
mkdir -p "$RESOURCES" "$WHEELS"

echo "→ copying server source"
# Mirror server/ but skip dev cruft. rsync would be cleaner but isn't on all
# Windows shells; tar-then-untar gives us the same selective copy.
(cd "$GRIDSIGHT_REPO" && tar --exclude=server/__pycache__ \
                           --exclude='server/**/__pycache__' \
                           --exclude=server/.venv \
                           --exclude=server/tests \
                           -cf - server) | (cd "$RESOURCES" && tar -xf -)
# Strip leftover *.pyc just in case.
find "$RESOURCES/server" -name "*.pyc" -delete 2>/dev/null || true

echo "→ exporting requirements.txt (local packages stripped)"
"$UV" export \
  --project "$GRIDSIGHT_REPO/server" \
  --frozen \
  --format requirements-txt \
  --no-emit-project \
  --no-emit-package gridsight-sdk \
  --no-emit-package gridsight-seds \
  --no-hashes \
  --no-dev \
  -o "$RESOURCES/requirements.txt"

echo "→ building wheels"
"$UV" build --wheel --out-dir "$WHEELS" "$GRIDSIGHT_REPO/sdk"
# SEDS is a first-party extension in this repo (server dep via a relative
# path). Ship it as a wheel; the relative path does not exist in the app.
"$UV" build --wheel --out-dir "$WHEELS" "$GRIDSIGHT_REPO/extensions/seds"

echo
echo "✓ Resources prepared:"
echo "  $RESOURCES/server          ($(find "$RESOURCES/server" -type f | wc -l | tr -d ' ') files)"
echo "  $RESOURCES/requirements.txt ($(wc -l < "$RESOURCES/requirements.txt" | tr -d ' ') lines)"
ls -lh "$WHEELS"/*.whl 2>/dev/null | awk '{print "  "$NF"  ("$5")"}'
