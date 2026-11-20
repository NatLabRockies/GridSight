#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the Meridian server + web images.
#
# Usage:
#   scripts/docker-build.sh                                   # native arch, tag = local
#   IMAGE_TAG=v1.2.3 scripts/docker-build.sh                  # tag override
#   TARGET_PLATFORM=linux/amd64 scripts/docker-build.sh       # cross-build for x86_64 hosts
#   TARGET_PLATFORM=linux/arm64 scripts/docker-build.sh       # explicit arm64
#
# TARGET_PLATFORM uses buildx; defaults to the host arch so local-test
# builds stay native. For multi-arch manifests, set TARGET_PLATFORM to
# a comma list and build with `docker buildx build --push` — buildx can
# only `--load` one platform into the local image store at a time.
#
# The server image installs:
#   1. Local SDK + SEDS sources staged from in-repo directories:
#        sdk/              → server/.build-deps/sdk/     (MERIDIAN_SDK_PATH)
#        extensions/seds/  → server/.build-deps/seds/    (SEDS_PATH)
#      Both are in-repo so no GitHub credentials are needed. Their
#      git+https:// lines in requirements.docker.txt are auto-commented.
#   2. PyPI deps from server/requirements.docker.txt
#      External extensions (GAT, DemandTldr) are commented out there —
#      uncomment and wire in GitHub auth when needed.
#
# The staged sources are pruned to just pyproject + package source
# (no test data, no .git) before being added to the build context.
#
# Tag and push the result to your own registry if you need to.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE_TAG="${IMAGE_TAG:-local}"
SERVER_IMAGE="${SERVER_IMAGE:-meridian-server}"
WEB_IMAGE="${WEB_IMAGE:-meridian-web}"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    sed -n '2,/^# ───/p' "$0" | sed 's/^# \?//'
    exit 0
fi

# SDK and SEDS live in-repo. Override paths via env vars if needed.
MERIDIAN_SDK_PATH="${MERIDIAN_SDK_PATH:-$ROOT/sdk}"
SEDS_PATH="${SEDS_PATH:-$ROOT/extensions/seds}"

# DemandTldr lives in a sibling repo and its `meridian-ext` package isn't
# pushed/tagged to the private GitHub yet, so we stage it locally like SEDS
# rather than via a git URL in requirements.docker.txt (which would need
# private-repo auth). Optional: if the path is absent the image just builds
# without DemandTldr. Override with DEMANDTLDR_PATH=… ; set DEMANDTLDR_PATH=skip
# to force-skip. Its reference data (forecast.parquet, geojson) is deliberately
# EXCLUDED from the image — the deployment sources it from SeaweedFS S3 at
# startup (DEMANDTLDR_S3_URI); see .env.example.
DEMANDTLDR_PATH="${DEMANDTLDR_PATH:-$HOME/code/DemandTldr/meridian-ext}"

BUILD_DEPS="$ROOT/server/.build-deps"

# Always start from a clean staging dir — leftover state from a previous
# build would silently end up in the new image.
rm -rf "$BUILD_DEPS"
trap 'rm -rf "$BUILD_DEPS"' EXIT

stage_dep() {
    local name="$1"
    local src="$2"
    local extra_excludes="${3:-}"

    if [ ! -d "$src" ]; then
        echo "✗ $name source not found at: $src" >&2
        echo "  Set MERIDIAN_SDK_PATH or SEDS_PATH to override." >&2
        exit 1
    fi

    local dest="$BUILD_DEPS/$name"
    mkdir -p "$dest"
    # Copy pyproject + package sources only. Excludes are conservative —
    # anything not needed by `pip install <dir>` is dropped so the build
    # context stays small and reproducible.
    #
    # Path-anchored excludes (leading `/`) only match at the top of $src,
    # so e.g. `/data` skips GAT's bulky example datasets but preserves
    # `src/<pkg>/data/` directories that ship asset files inside a
    # package (DemandTldr's geojson + parquet samples).
    rsync -a \
        --exclude='.git' \
        --exclude='.venv' \
        --exclude='__pycache__' \
        --exclude='*.egg-info' \
        --exclude='node_modules' \
        --exclude='.pytest_cache' \
        --exclude='.mypy_cache' \
        --exclude='.ruff_cache' \
        --exclude='/example_data' \
        --exclude='/data' \
        --exclude='/tests' \
        --exclude='/docs' \
        --exclude='/examples' \
        --exclude='/dist' \
        --exclude='/build' \
        --exclude='*.duckdb' \
        --exclude='*.db' \
        --exclude='*.h5' \
        --exclude='*.hdf5' \
        $extra_excludes \
        "$src/" "$dest/"
    echo "  staged $name from $src ($(du -sh "$dest" | cut -f1))"
}

echo "→ staging local sources into $BUILD_DEPS"
stage_dep sdk  "$MERIDIAN_SDK_PATH"
stage_dep seds "$SEDS_PATH"

# DemandTldr is optional. Its reference data (forecast.parquet + geojson under
# src/demand_tldr_ext/data) is BAKED INTO THE IMAGE so the extension works with
# no S3/env-var setup — the packaged data is the loader's fallback. To decouple
# data from the image and source it from SeaweedFS S3 instead, add
# `--exclude=/src/demand_tldr_ext/data` to the stage_dep call below and set
# DEMANDTLDR_S3_URI (+ SEAWEEDFS_* creds) on the deployment. Only the *.bak
# backup is dropped to keep the image lean.
if [ "$DEMANDTLDR_PATH" = "skip" ]; then
    echo "  skipping DemandTldr (DEMANDTLDR_PATH=skip)"
elif [ -d "$DEMANDTLDR_PATH" ]; then
    stage_dep demand-tldr "$DEMANDTLDR_PATH" "--exclude=*.bak"
else
    echo "  ⚠ DemandTldr not staged — path not found: $DEMANDTLDR_PATH" >&2
    echo "    (SEDS→Demand100 drill-down needs it; set DEMANDTLDR_PATH=… to include.)" >&2
fi

# Filter git+https:// lines for staged packages from requirements.docker.txt
# so the staged copy takes precedence (no redundant network fetch, builds
# cleanly without GitHub credentials). Restore the original on exit.
REQS="$ROOT/server/requirements.docker.txt"
REQS_BACKUP="${REQS}.preBuild.bak"
if [ -f "$REQS" ]; then
    cp "$REQS" "$REQS_BACKUP"
    declare -a STAGED_PKGS
    [ -d "$BUILD_DEPS/sdk" ]  && STAGED_PKGS+=("meridian-sdk")
    [ -d "$BUILD_DEPS/seds" ] && STAGED_PKGS+=("meridian-seds")
    [ -d "$BUILD_DEPS/demand-tldr" ] && STAGED_PKGS+=("meridian-demand-tldr")
    for pkg in ${STAGED_PKGS[@]+"${STAGED_PKGS[@]}"}; do
        sed -i '' -E "s|^(${pkg}[[:space:]]+@[[:space:]]+git\\+.*)$|# [staged-local] \\1|" "$REQS"
    done
    if [ "${#STAGED_PKGS[@]:-0}" -gt 0 ]; then
        echo "  filtered ${#STAGED_PKGS[@]} git URL(s) from requirements.docker.txt"
    fi
fi

trap 'rm -rf "$BUILD_DEPS"; [ -f "$REQS_BACKUP" ] && mv "$REQS_BACKUP" "$REQS"' EXIT

# Cross-platform support via buildx. Defaults to the host architecture
# so local-test builds on Apple Silicon stay native (fast). For
# x86_64 hosts set TARGET_PLATFORM=linux/amd64. Multi-
# platform manifests (`linux/amd64,linux/arm64`) are also accepted but
# require `--push` to a registry — buildx can't `--load` more than one
# platform into the local image store. For that flow use
# `docker buildx build --push` directly.
TARGET_PLATFORM="${TARGET_PLATFORM:-}"
PLATFORM_ARGS=()
LOAD_OR_PUSH=("--load")
if [ -n "$TARGET_PLATFORM" ]; then
    PLATFORM_ARGS+=("--platform" "$TARGET_PLATFORM")
    if [[ "$TARGET_PLATFORM" == *","* ]]; then
        echo "ℹ Multi-platform target ($TARGET_PLATFORM) requires --push;" >&2
        echo "  use \`docker buildx build --push\` to a registry instead." >&2
        exit 2
    fi
    echo "ℹ Cross-building for $TARGET_PLATFORM (host is $(uname -m))"
fi

# `docker buildx build` is the cross-platform builder. Falls back to a
# legacy `docker build` warning if buildx isn't installed — but every
# modern Docker ships it, and the colima/Docker Desktop builders here
# all advertise multi-arch BuildKit support.
build() {
    docker buildx build \
        ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} \
        "${LOAD_OR_PUSH[@]}" \
        "$@"
}

echo
echo "→ building $SERVER_IMAGE:$IMAGE_TAG"
build \
    -f "$ROOT/server/Dockerfile" \
    -t "$SERVER_IMAGE:$IMAGE_TAG" \
    "$ROOT/server"

echo
echo "→ building $WEB_IMAGE:$IMAGE_TAG"
build \
    -f "$ROOT/web/Dockerfile" \
    -t "$WEB_IMAGE:$IMAGE_TAG" \
    "$ROOT/web"

echo
echo "✓ built $SERVER_IMAGE:$IMAGE_TAG and $WEB_IMAGE:$IMAGE_TAG"
echo "  tag and push these to your registry if needed"
