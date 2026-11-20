#!/usr/bin/env bash
# Download the CATS inputs into $DATA_DIR (default /data). Re-runs are cheap:
# files that are already present with the expected checksum are kept.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
CATS_REPO="https://github.com/WISPO-POP/CATS-CaliforniaTestSystem.git"
CATS_COMMIT="${CATS_COMMIT:-8a6f7fa067a77109abb59a67b8f4ac8ee908e04d}"
PROFILES="$DATA_DIR/profiles"

# 2019 hourly profiles from the CATS authors' Google Drive folder
# (linked from the CATS README). id  name  sha256
FILES=(
  "1CxLlcwAEUy-JvJQdAfVydJ1p9Ecot-4d HourlyProduction2019.csv f94732d00a0dd0d95047aef6fa358eb04211e08ade1c49431d6b8aff8687a842"
  "1Sz8st7g4Us6oijy1UYMPUvkA1XeZlIr8 Load_Agg_Post_Assignment_v3_latest.csv e3a5b61b0597181162a9484217d18a06658fa6a8fe95854852b1e1da23f21393"
)

mkdir -p "$PROFILES"

if [ ! -d "$DATA_DIR/CATS-CaliforniaTestSystem/.git" ]; then
  echo "→ cloning CATS"
  git clone --quiet "$CATS_REPO" "$DATA_DIR/CATS-CaliforniaTestSystem"
fi
git -C "$DATA_DIR/CATS-CaliforniaTestSystem" -c advice.detachedHead=false checkout --quiet "$CATS_COMMIT"
echo "✓ CATS at $(git -C "$DATA_DIR/CATS-CaliforniaTestSystem" rev-parse --short HEAD)"

for entry in "${FILES[@]}"; do
  read -r id name sha <<<"$entry"
  dest="$PROFILES/$name"
  if [ -f "$dest" ] && echo "$sha  $dest" | sha256sum -c --quiet - 2>/dev/null; then
    echo "✓ $name (cached)"
    continue
  fi
  echo "→ downloading $name"
  gdown --quiet "$id" -O "$dest"
  echo "$sha  $dest" | sha256sum -c --quiet - || {
    echo "checksum mismatch for $name — the source file changed; update FILES in $0" >&2
    exit 1
  }
  echo "✓ $name"
done
