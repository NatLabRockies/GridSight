# Meridian — Claude Code Project Guide

## Project Overview

Meridian is a geospatial data visualization platform for energy/grid modeling. It animates timeseries data over maps using deck.gl + MapLibre, with a Python/FastAPI backend and React frontend.

## Development

### Running locally
```bash
./dev.sh  # Starts Python backend (:5001) + Bun proxy (:3001) + Vite dev server (:5173)
```

Open http://localhost:5173.

### Testing interactivity
The `/interactivity-test` skill (`.claude/skills/interactivity-test/`) is a grouped,
repeatable regression suite for the map/chart/`stateBus` (MCP-driven) interactions.
It brings up the dev stack and drives the real bus handlers in a browser via the
preview tools, with independent groups so a change can be verified without running
everything. Run it after touching frontend interactivity or MCP control, and add a
checklist item there whenever you build a new interaction.

### Package management
- **Server:** `uv` (Python) — `cd server && uv sync`
- **Frontend:** `bun` — `cd web && bun install`
- **SDK:** `cd sdk && uv pip install -e .`
- **Extensions:** most live in their own repo (e.g. `~/code/DemandTldr/meridian-ext`, `~/code/GAT/meridian-ext`); install with `uv pip install -e .` from inside the package directory. The server's `pyproject.toml` references them via `tool.uv.sources` so `uv sync` wires them up automatically. **SEDS is a first-party exception** — it lives in this repo at `extensions/seds/` (the `meridian-seds` package, in-repo relative `tool.uv.sources` path) and ships with the server, like `meridian-sdk`. Small first-party dataset extensions can go there; larger model-backed ones stay in their own repos.

### Key env vars (set in dev.sh)
- `API_KEY` — API auth key (default: `dev-api-key`)
- `DATA_DIR` — Storage directory (default: `../data`)
- `DB_PATH` — SQLite database path (default: `../data/meridian.db`)
- `LLM_MODEL` — Ollama model name (default: `gpt-oss:20B`)
- `OLLAMA_URL` — Ollama server URL (default: `http://localhost:11434`)

### Container builds
Images are built and tagged by `scripts/docker-build.sh`:

```bash
./scripts/docker-build.sh                    # tags meridian-server:local + meridian-web:local
IMAGE_TAG=v1.2.3 ./scripts/docker-build.sh   # custom tag
```

The container build uses **`server/requirements.docker.txt`** (PyPI names + `git+https://…` URLs) instead of `pyproject.toml`'s editable sibling-repo sources. Adding an extension to a deployment image = appending one line to that file (no Dockerfile edits). Extension env vars (DB URLs, API keys) live in `.env` and are forwarded into both containers via `env_file:` in `docker-compose.yml`.

Two distinct extension install paths exist on purpose:
- **Local dev** — `pyproject.toml` + `uv sync` with editable installs from `~/code/<ext>/meridian-ext`. Edits to extension source are picked up immediately.
- **Container** — `server/requirements.docker.txt` with pinned remote refs. Self-contained, no host-machine paths.

For dev mode inside Docker (Vite HMR + `--reload`), use the overlay: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`. For active extension development, prefer `./dev.sh` over Docker — editable cross-repo installs don't survive a containerized build.

## Architecture

### Two packages (plus extensions)
1. **meridian-sdk** (`sdk/`) — Extension interfaces, dataclasses. Extension devs import from here.
2. **meridian-server** (`server/`) — FastAPI backend. Discovers extensions, serves data, runs AI chat.

Most extensions live in their own repos under `~/code/` (currently DemandTldr and GAT) and are referenced from `server/pyproject.toml`'s `tool.uv.sources` as editable installs. The exception is **SEDS** (`extensions/seds/`, package `meridian-seds`), bundled first-party in this repo — local dev uses an in-repo relative `tool.uv.sources` path; the container build pulls it via `git+https://…/Meridian.git@main#subdirectory=extensions/seds` (same pattern as the SDK).

### Extension system
Extensions are pip packages with `meridian.extensions` entry_points. They implement `MeridianExtensionBase` from the SDK. The server discovers them at startup via `importlib.metadata.entry_points`.

### Database
SQLite (in-memory with disk backup). Migrations in `server/db.py` (currently 4). DuckDB for analytical queries (in-memory, tables registered by extensions).

### Frontend patterns
- `loaders.js` — one async function per API call, all use `credentials: 'include'`
- `EntityInteractionManager.jsx` — content array drives what sections show (infocard, timeseries, heatmap, histogram, controls, charts)
- Lazy loading: PlotlyChart and Plotly.js loaded on demand
- `chartRegistry.js` maps chart_type strings to React components

## Code style
- Server: Python 3.11+, type hints, `from __future__ import annotations`
- Frontend: React functional components with hooks, MUI for UI, no TypeScript
- Prefer editing existing files over creating new ones
- Follow existing patterns in loaders.js for new API functions
