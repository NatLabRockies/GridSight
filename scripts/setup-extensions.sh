#!/usr/bin/env bash
# scripts/setup-extensions.sh
#
# One-shot bootstrap of the GridSight extensions that the local-dev
# workflow expects (sibling repos, editable installs).
#
# Why this exists: server/pyproject.toml's [tool.uv.sources] points at
# `../../GAT` and `../../DemandTldr` for editable installs. New contributors
# need those sibling clones at the right refs before `uv sync` works. This
# script does that — clones each extension repo (or fetches updates if
# already cloned) and points it at a known-good ref.
#
# After running, the standard local-dev sequence works:
#   cd sdk && uv pip install -e . && cd ..
#   cd server && uv sync && cd ..
#   cd web && bun install && cd ..
#   ./dev.sh
#
# Usage:
#   ./scripts/setup-extensions.sh                  # GAT only, default ref
#   ./scripts/setup-extensions.sh --gat-ref v1.2.3 # pin GAT to a tag/branch/sha
#   ./scripts/setup-extensions.sh --skip-gat       # skip the GAT clone
#   ./scripts/setup-extensions.sh --parent-dir DIR # clone siblings under DIR
#                                                  # (defaults to gridsight's parent)
#
# Requirements:
#   - git
#   - uv (https://docs.astral.sh/uv/)
#
# Repository:
#   GAT is cloned over HTTPS from its public GitHub repo, so no credentials
#   are needed. To use a fork, a mirror or SSH, override the URL, e.g.
#     GAT_REPO_URL=git@github.com:NatLabRockies/GridAnalysisToolkit.git
#   (or pass --gat-repo URL).
#
# DemandTldr is an optional, external extension and is not cloned by this
# script; clone it as a sibling repo yourself if you need it.

set -euo pipefail
cd "$(dirname "$0")/.."
GRIDSIGHT_DIR="$(pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────
GAT_REF="${GAT_REF:-nlr-gat-v0.1.3}"
GAT_REPO_URL="${GAT_REPO_URL:-https://github.com/NatLabRockies/GridAnalysisToolkit.git}"
PARENT_DIR="${PARENT_DIR:-$(cd .. && pwd)}"
SKIP_GAT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --gat-ref)     GAT_REF="$2"; shift 2 ;;
    --gat-repo)    GAT_REPO_URL="$2"; shift 2 ;;
    --parent-dir) PARENT_DIR="$2"; shift 2 ;;
    --skip-gat)   SKIP_GAT=1; shift ;;
    -h|--help)
      sed -n 's/^# \{0,1\}//p' "$0" | head -40
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not on PATH." >&2; exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install: https://docs.astral.sh/uv/" >&2; exit 1
fi

# ── Helper: clone or update a repo at a specific ref ──────────────────────
sync_repo() {
  local name="$1"
  local repo_url="$2"
  local ref="$3"
  local dest="$4"

  echo
  echo "── $name ──────────────────────────────────────────────"
  echo "  repo: $repo_url"
  echo "  ref:  $ref"
  echo "  path: $dest"

  if [ -d "$dest/.git" ]; then
    echo "  (existing clone — fetching $ref)"
    git -C "$dest" fetch --quiet origin "$ref" || {
      echo "  fetch failed. Check git auth for $repo_url"; return 1;
    }
    # Detach onto the requested ref. Tags, branches, and sha refs all work
    # via FETCH_HEAD after the fetch above.
    git -C "$dest" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
  else
    git clone --quiet "$repo_url" "$dest" || {
      echo
      echo "Clone failed. Check network access to $repo_url, or point"
      echo "GAT_REPO_URL (or --gat-repo) at a fork/mirror you can reach, e.g."
      echo "  GAT_REPO_URL=git@github.com:NatLabRockies/GridAnalysisToolkit.git $0"
      return 1
    }
    git -C "$dest" -c advice.detachedHead=false checkout --quiet "$ref" || {
      echo "  checkout of $ref failed (does it exist?)"; return 1;
    }
  fi
  echo "  ✓ at $(git -C "$dest" rev-parse --short HEAD)"
}

# ── GAT ──────────────────────────────────────────────────────────────────
if [ "$SKIP_GAT" -eq 0 ]; then
  GAT_DIR="$PARENT_DIR/GAT"
  sync_repo "GAT" "$GAT_REPO_URL" "$GAT_REF" "$GAT_DIR"
fi

# ── Wire up server deps ──────────────────────────────────────────────────
echo
echo "── Installing server dependencies ────────────────────────"
echo "  cd $GRIDSIGHT_DIR/server && uv sync"
cd "$GRIDSIGHT_DIR/server"
uv sync

cat <<EOF

──────────────────────────────────────────────────────────
✓ Extensions ready. Next steps:

   cd $GRIDSIGHT_DIR/web && bun install && cd ..
   ./dev.sh

   # Open http://localhost:5173

To load a Sienna scenario (system.json + simulation_store.h5), use the
GAT extension's upload in GridSight. For demo data, see
examples/cats-sienna/README.md.

──────────────────────────────────────────────────────────
EOF
