#!/usr/bin/env bash
# Build the Python-side resources that Tauri bundles into the .app/.exe.
#
# Produces under desktop/src-tauri/resources/:
#   server/             — frozen copy of the server/ source tree (no .venv,
#                          no __pycache__, no tests)
#   wheels/             — pre-built wheels: gridsight-sdk, gat, gridsight-gat
#   requirements.txt    — pinned PyPI deps derived from server/pyproject.toml
#                          (with the local packages stripped)
#
# Source locations are configurable via env vars so the script works on a
# fresh build machine where the repos live somewhere other than ~/code.
#   GRIDSIGHT_REPO       — defaults to two levels up from this script
#   GAT_SOURCE_DIR      — defaults to $GRIDSIGHT_REPO/../GAT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES="$DESKTOP_DIR/src-tauri/resources"
WHEELS="$RESOURCES/wheels"

GRIDSIGHT_REPO="${GRIDSIGHT_REPO:-$(cd "$DESKTOP_DIR/.." && pwd)}"
GAT_SOURCE_DIR="${GAT_SOURCE_DIR:-$GRIDSIGHT_REPO/../GAT}"
DEMAND_TLDR_SOURCE_DIR="${DEMAND_TLDR_SOURCE_DIR:-$GRIDSIGHT_REPO/../DemandTldr/gridsight-ext}"

UV="${UV:-$DESKTOP_DIR/src-tauri/binaries/uv}"
if [ ! -x "$UV" ]; then
  UV="$(command -v uv || true)"
fi
if [ -z "$UV" ] || [ ! -x "$UV" ]; then
  echo "uv binary not found. Run scripts/fetch-uv.sh first, or install uv on PATH." >&2
  exit 1
fi

echo "→ gridsight repo:  $GRIDSIGHT_REPO"
echo "→ GAT source:     $GAT_SOURCE_DIR"
echo "→ DemandTldr ext: $DEMAND_TLDR_SOURCE_DIR"
echo "→ uv:             $UV"

for d in "$GRIDSIGHT_REPO/server" "$GRIDSIGHT_REPO/sdk"; do
  if [ ! -d "$d" ]; then
    echo "missing required source dir: $d" >&2
    exit 1
  fi
done

HAS_GAT=true
for d in "$GAT_SOURCE_DIR" "$GAT_SOURCE_DIR/gridsight-ext"; do
  if [ ! -d "$d" ]; then
    echo "→ GAT not found at $d — skipping GAT wheels (extension unavailable at runtime)"
    HAS_GAT=false
    break
  fi
done

HAS_DEMAND_TLDR=true
if [ ! -d "$DEMAND_TLDR_SOURCE_DIR" ]; then
  echo "→ DemandTldr not found at $DEMAND_TLDR_SOURCE_DIR — skipping (extension unavailable at runtime)"
  HAS_DEMAND_TLDR=false
fi

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
  --no-emit-package gridsight-gat \
  --no-emit-package gridsight-demand-tldr \
  --no-emit-package gat \
  --no-hashes \
  --no-dev \
  -o "$RESOURCES/requirements.txt"

echo "→ building wheels"
"$UV" build --wheel --out-dir "$WHEELS" "$GRIDSIGHT_REPO/sdk"
if [ "$HAS_GAT" = "true" ]; then
  "$UV" build --wheel --out-dir "$WHEELS" "$GAT_SOURCE_DIR"
  "$UV" build --wheel --out-dir "$WHEELS" "$GAT_SOURCE_DIR/gridsight-ext"
fi
if [ "$HAS_DEMAND_TLDR" = "true" ]; then
  "$UV" build --wheel --out-dir "$WHEELS" "$DEMAND_TLDR_SOURCE_DIR"
fi

echo
echo "✓ Resources prepared:"
echo "  $RESOURCES/server          ($(find "$RESOURCES/server" -type f | wc -l | tr -d ' ') files)"
echo "  $RESOURCES/requirements.txt ($(wc -l < "$RESOURCES/requirements.txt" | tr -d ' ') lines)"
ls -lh "$WHEELS"/*.whl 2>/dev/null | awk '{print "  "$NF"  ("$5")"}'
