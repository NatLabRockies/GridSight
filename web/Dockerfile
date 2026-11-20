# ── GridSight Client – Production Dockerfile ──────────────────────────────────
#
# Multi-stage build:
#   Stage 1 (builder) – install deps and compile the Vite frontend
#   Stage 2 (runner)  – lean production image running only the Bun server
#
# The Bun server (server/index.js) serves the Vite dist/ as static assets
# and proxies /api/* requests to the Python backend.
# ---------------------------------------------------------------------------

# ── Stage 1: Build ──────────────────────────────────────────────────────────
#
# `--platform=$BUILDPLATFORM` pins this stage to whatever architecture
# buildx is running on (your laptop), so the Vite/Rollup build runs
# native — not under QEMU emulation. Two reasons that matters:
#
#   1. Bun's amd64 binary requires CPU features (AVX) that QEMU on
#      Apple Silicon doesn't expose. Trying to `bun run build` under
#      `--platform=linux/amd64` crashes with
#        "CPU lacks AVX support … panic(main thread): Segmentation fault"
#      then exits 132 (SIGILL).
#
#   2. Even when QEMU works, JS bundling under translation is 5-10x
#      slower than native — a clean Vite build that takes ~6s on a
#      native arm64 host stretches to a minute or more under QEMU.
#
# Output of this stage is `dist/` — pure JS/CSS, completely platform-
# agnostic, so the runner stage (which DOES target $TARGETPLATFORM)
# just COPYs it in. node_modules used here are builder-arch and never
# escape this stage; the runner re-installs production deps for its
# own target arch.
FROM --platform=$BUILDPLATFORM oven/bun:1 AS builder

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies needed for build)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Copy the rest of the source
COPY . .

# Disable source maps to avoid the multi-GB in-memory cost of generating
# them for deck.gl / maplibre-gl inside a memory-constrained build VM.
# Give the JS heap a generous upper bound so Vite/Rollup doesn't get OOM-killed.
ENV VITE_BUILD_SOURCEMAP=false
ENV NODE_OPTIONS="--max-old-space-size=3072"

# On-device Whisper voice input (opt-in). Pass --build-arg WHISPER_ASSETS=tiny.en
# (or "tiny.en,base.en", or "all") to bake the model + ONNX-Runtime wasm into
# public/ (→ dist/), served same-origin so the feature works on networks where
# the HuggingFace/jsDelivr CDNs are blocked. WHISPER_OFFLINE=1 stops
# transformers.js from ever falling back to those CDNs at runtime. Both default
# empty → no assets bundled, feature still usable in dev via CDN.
ARG WHISPER_ASSETS=""
ARG WHISPER_OFFLINE=""
ENV VITE_WHISPER_OFFLINE=${WHISPER_OFFLINE}
RUN if [ -n "$WHISPER_ASSETS" ]; then bun scripts/fetch-whisper-assets.mjs --models "$WHISPER_ASSETS"; fi

# Build the Vite frontend to dist/
RUN bun run build

# ── Stage 2: Run ────────────────────────────────────────────────────────────
FROM oven/bun:1-slim AS runner

WORKDIR /app

# Set production mode so the Bun server serves static files
ENV NODE_ENV=production

# Copy dependency manifests and install only production deps
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

# Copy the compiled frontend assets from the builder stage
COPY --from=builder /app/dist ./dist

# Copy the Bun server
COPY server ./server

# Expose the port the Bun server listens on (default 3001)
# Override at runtime with the BUN_PORT environment variable.
EXPOSE 3001

# Runtime environment variables – override via docker-compose or -e flags:
#   ADMIN_USER      username for the login form
#   ADMIN_PASS      password for the login form
#   SESSION_SECRET  secret used to sign session tokens
#   BACKEND_URL     URL of the Python backend  (e.g. http://server:5001)
#   API_KEY         forwarded as X-MyApp-ApiKey to the backend
#   BUN_PORT        port this server listens on (default 3001)

CMD ["bun", "run", "server/index.js"]
