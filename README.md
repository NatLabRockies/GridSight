# GridSight

**An extensible geospatial analytics and animation platform.**

GridSight is a desktop app (also available as a Docker deployment) for visualizing, animating, and analyzing geospatial timeseries data. Built on a plugin architecture, it supports pip-installable Python extensions that provide data, interactive controls, SQL-driven charts, and custom shaders. An integrated AI chat assistant lets users query data with natural language via DuckDB, and a data lineage system tracks provenance across every query and control change.

While designed with energy and infrastructure modeling in mind, the platform's extension system makes it suitable for any domain that combines geospatial data with temporal analysis.


> **Looking for GridSight classic?** The original GridSight lives on the
> [`classic`](https://github.com/NatLabRockies/GridSight/tree/classic) branch
> and the [`v0-classic`](https://github.com/NatLabRockies/GridSight/tree/v0-classic) tag.


## Key Features

- **Extension system** — Pip-installable Python plugins provide data, controls, charts, and shaders. Discovered automatically at startup via Python entry points.
- **AI chat assistant** — Provider-agnostic LLM integration (Ollama, OpenAI, Anthropic) with tool use. The AI can query DuckDB, create charts, and update controls.
- **DuckDB analytical engine** — In-memory SQL engine. Extensions register tables; users and AI query them freely.
- **Geospatial visualization** — deck.gl + MapLibre GL for high-performance map rendering with configurable layer styling and colormaps.
- **Timeseries animation** — Play through timesteps with transport-style controls. Data partitions drive animated choropleth, scatter, and arc layers.
- **Interactive controls** — Extensions expose per-entity controls (sliders, dropdowns, toggles) and project-level input controls that can trigger re-simulation.
- **Plotly charts** — Extension-defined SQL-template charts rendered inline. Support for bar, line, scatter, and custom Plotly layouts.
- **Custom shaders** — Extensions can provide GLSL vertex/fragment shaders and deck.gl layer extensions.
- **Data lineage** — Every data source, SQL query, control change, and saved perspective is tracked in a provenance DAG with review status.
- **Cross-project analysis** — Tag-based search across projects and extensions. Cross-perspectives let users compose views spanning multiple data sources.


## Architecture

```
gridsight-sdk        (pip package — extension interfaces & data models)
      | implements
my-extension         (pip package — entry_points: gridsight.extensions)
      | discovered by
gridsight-server     (FastAPI backend)
  |-- ExtensionRegistry  — discovers extensions via importlib.metadata
  |-- DuckDBEngine       — in-memory analytical SQL engine
  |-- AI Chat            — provider-agnostic LLM with tool use
  |-- LineageManager     — data provenance tracking
  |-- SQLite ORM         — projects, scenarios, layers, perspectives
  '-- API routes         — data, controls, charts, shaders, search
      | serves
web frontend         (React + deck.gl + MapLibre + Material UI)
  |-- Animation engine   — TimeseriesBuffer drives animated layers
  |-- Entity interaction — dynamic controls, charts, info cards
  |-- Shader registry    — lazy-loads extension GLSL/JS modules
  '-- Chart registry     — maps chart types to React components
```

At startup, the server discovers all installed extensions, calls `get_manifest()` and `on_startup()` on each, registers their DuckDB tables, syncs their projects/scenarios/geometries/datasets into the ORM, and creates default layers.


## Concepts

| Concept | Description |
|---------|-------------|
| **Project** | Top-level container for related data, often spanning multiple modeling tools. |
| **Scenario** | A data collection within a project. Scenarios can be hierarchical (parent/child). |
| **Layer** | Binds geometry to a deck.gl layer type with dataset joins and style mappings. |
| **Painting** | A named style snapshot for a single layer — opacity, colormap, filters, scales. |
| **Perspective** | A collection of paintings, plots, map state, and animation state that captures an analytical view. |
| **Story** | A sequence of perspectives with transitions and narration for guided analysis. |


## Install the Desktop App

The desktop app is the main way to use GridSight. It bundles the server and
the web UI; at first launch it sets up its own Python environment.

1. Download the installer for your platform from
   [Releases](https://github.com/NatLabRockies/GridSight/releases/latest):
   `.dmg` (macOS, Apple Silicon), `.exe` or `.msi` (Windows).
2. **macOS:** open the `.dmg` and drag **GridSight.app** to Applications.
   The app is not signed with an Apple Developer ID, so on first launch:
   - macOS 14 or earlier: right-click GridSight, choose **Open**, then **Open**.
   - macOS 15 or later: run `xattr -dr com.apple.quarantine /Applications/GridSight.app` once, then open it.
3. **Windows:** run the installer. SmartScreen warns that the publisher is
   unknown; click **More info → Run anyway**.

To build the desktop app from source, see
[`docs/desktop-building.md`](docs/desktop-building.md).

## Run with Docker

Use Docker to serve GridSight to a team from one host:

```bash
cp .env.example .env          # extension creds, AI keys, …
./scripts/docker-build.sh     # builds gridsight-server and gridsight-web
docker compose up
```

See [Docker](#docker) below for build options.

## Development

### Prerequisites

- **Python 3.12+** with [uv](https://docs.astral.sh/uv/)
- **Bun** (JavaScript runtime)
- **Ollama** (optional, for AI chat with local models)

### Local Development

```bash
# Clone and enter the repo
git clone https://github.com/NatLabRockies/GridSight.git
cd GridSight

# Install SDK (editable)
cd sdk && uv pip install -e . && cd ..

# Bootstrap the GAT extension as a sibling clone at the supported ref and
# run `uv sync` against the server. Re-runnable; updates existing clones.
# GAT is cloned from its public repo,
# https://github.com/NatLabRockies/GridAnalysisToolkit (skip with --skip-gat
# if you don't need it). DemandTldr is an optional, external extension and
# is not cloned by this script.
./scripts/setup-extensions.sh

# If you skipped the script, run `uv sync` manually. Note that
# server/pyproject.toml has editable [tool.uv.sources] pointing at sibling
# repos (DemandTldr, GAT) — `uv sync` errors out if those aren't cloned
# alongside this one.
#   cd server && uv sync && cd ..

# Install frontend dependencies
cd web && bun install && cd ..

# Start everything (Python backend + Bun proxy + Vite dev server)
./dev.sh
```

Open http://localhost:5173 in your browser.

`setup-extensions.sh` clones GAT to `../GAT` (relative to the gridsight
repo) at branch `mw/v1.0.0` by default. Override with flags:

```bash
./scripts/setup-extensions.sh --gat-ref v1.2.3 --parent-dir ~/code
```

### Docker

Two images come out of `scripts/docker-build.sh`: `gridsight-server`
(FastAPI + extensions) and `gridsight-web` (Vite-built dist + Bun
proxy). Build and run:

```bash
cp .env.example .env                                       # extension creds, AI keys, …

# Build native arch (your host) and run locally
./scripts/docker-build.sh
docker compose up

# Cross-build for x86_64 hosts
IMAGE_TAG=v0.1.0 TARGET_PLATFORM=linux/amd64 ./scripts/docker-build.sh
```

Behind a TLS-intercepting proxy, pass your root CA to the server build
with `--build-arg EXTRA_CA_CERT_URL=<url-to-root.pem>`.

For local hot-reload (Vite HMR + uvicorn `--reload`):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

For *active extension development* (editing GAT or DemandTldr source
alongside the server), skip Docker and use `./dev.sh` — sibling-repo
editable installs make changes live without a rebuild.

**Adding a new extension to the build** is covered in
[`docs/extensions.md`](docs/extensions.md).

### AI Chat Setup (Optional)

GridSight's AI assistant automatically discovers available LLM providers. No configuration is required beyond setting API keys — each provider with valid credentials appears in the chat model selector.

**Ollama** is auto-detected when running locally (default `http://localhost:11434`). For cloud providers, set the corresponding API key:

```bash
# OpenAI
export OPENAI_API_KEY=sk-...

# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini
export GOOGLE_API_KEY=...

# xAI (Grok)
export XAI_API_KEY=xai-...

# AWS Bedrock
export AWS_BEDROCK_API_KEY=...
```

Optionally set a default model so AI is pre-selected on startup:

```bash
export LLM_MODEL=gpt-4o
export LLM_PROVIDER=openai    # ollama (default), openai, xai, anthropic
```

To force-disable AI entirely (e.g. in a deployment that shouldn't expose LLM access):

```bash
export GRIDSIGHT_DISABLE_AI=true
```

#### Configuring LLM Providers

Provider definitions are loaded from `server/llm_providers.json`. The default file ships with four providers (Ollama, OpenAI, xAI, Anthropic), but deployers can customize it to add, remove, or restrict providers.

The file is resolved in this order:
1. `LLM_PROVIDERS_FILE` env var — explicit path to a custom JSON file
2. `{DATA_DIR}/llm_providers.json` — deployment-level override
3. `server/llm_providers.json` — shipped default

Each provider entry has the following fields:

```json
{
  "providers": [
    {
      "id": "ollama",
      "display_name": "Ollama (Local)",
      "base_url": "http://localhost:11434/v1",
      "base_url_env": "OLLAMA_URL",
      "api_key_env": null,
      "api_key_default": "ollama",
      "enabled_when": "always"
    },
    {
      "id": "openai",
      "display_name": "OpenAI",
      "base_url": "https://api.openai.com/v1",
      "api_key_env": "OPENAI_API_KEY",
      "enabled_when": "api_key"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique provider identifier, used internally and in the API |
| `display_name` | Human-readable name shown in the UI |
| `base_url` | Default OpenAI-compatible API endpoint |
| `base_url_env` | Optional env var that overrides `base_url` (e.g. `OLLAMA_URL`) |
| `api_key_env` | Env var containing the API key. `null` if no key is needed |
| `api_key_default` | Fallback API key when `api_key_env` is not set (e.g. `"ollama"` for local) |
| `enabled_when` | `"api_key"` — enabled only if the API key env var is set. `"always"` — always enabled |
| `models_endpoint` | Optional custom URL for listing models (direct HTTP GET, bypasses the OpenAI client) |
| `known_models` | Optional array of fallback models when API-based listing fails (see below) |

Model discovery uses a three-tier resolution: `models_endpoint` (custom URL) -> standard OpenAI `/v1/models` -> `known_models` fallback. Some providers don't support the standard endpoint or use a different URL. Use `models_endpoint` for a direct HTTP call, and `known_models` as a last resort:

```json
{
  "id": "xai",
  "display_name": "xAI (Grok)",
  "base_url": "https://api.x.ai/v1",
  "api_key_env": "XAI_API_KEY",
  "enabled_when": "api_key",
  "known_models": [
    {"name": "grok-3", "supports_tools": true, "supports_thinking": false},
    {"name": "grok-3-mini", "supports_tools": true, "supports_thinking": true}
  ]
}
```

To add a custom provider (e.g. Azure OpenAI, local vLLM, or another OpenAI-compatible server), add an entry to the `providers` array with the appropriate base URL and API key configuration. To restrict available providers in a deployment, remove unwanted entries from the file.


## Extension System

Extensions are pip-installable Python packages that implement `GridSightExtensionBase` from the SDK. They declare capabilities (data provision, controls, charts, shaders, AI context, DuckDB tables) and are discovered automatically at startup via `importlib.metadata.entry_points`.

```python
from gridsight.extensions import GridSightExtensionBase, ExtensionManifest, Capability

class MyExtension(GridSightExtensionBase):
    def get_manifest(self):
        return ExtensionManifest(
            name="my-extension",
            display_name="My Extension",
            version="0.1.0",
            capabilities=[Capability.DATA_PROVIDER, Capability.DUCKDB_TABLES],
        )

    def list_projects(self):
        return [...]
```

Register via `pyproject.toml`:

```toml
[project.entry-points."gridsight.extensions"]
my_extension = "my_package:MyExtension"
```

Read the full [Extension Developer Guide](docs/extensions.md) for a step-by-step walkthrough. Already have an extension package and just want to install it? See [Installing Extensions](docs/extensions.md#installing-extensions) for both the local-dev (editable) and container (`requirements.docker.txt`) paths.


## API Overview

| Route | Description |
|-------|-------------|
| `GET /api/extensions` | List all extension manifests |
| `GET /api/extensions/{ext}/geometry/{ref}/data` | Fetch geometry bytes |
| `GET /api/extensions/{ext}/dataset/{ref}/data` | Fetch dataset bytes |
| `GET /api/extensions/{ext}/dataset/{ref}/partitions` | List dataset partitions |
| `GET /api/extensions/{ext}/dataset/{ref}/stream/{date}` | Fetch one partition |
| `GET /api/extensions/{ext}/input-controls/{p}/{s}` | Get project-level controls |
| `POST /api/extensions/{ext}/input-controls/{p}/{s}` | Update an input control |
| `GET /api/extensions/{ext}/controls/{p}/{s}/{id}` | Get entity controls |
| `POST /api/extensions/{ext}/controls/{p}/{s}/{id}` | Update an entity control |
| `GET /api/extensions/{ext}/charts` | List chart specs |
| `GET /api/extensions/{ext}/charts/{name}/data` | Get chart data via SQL template |
| `GET /api/extensions/{ext}/shaders` | List shader specs |
| `POST /api/query` | Execute DuckDB SQL (json/arrow/chartjs) |
| `POST /api/chat` | AI chat (SSE streaming) |
| `GET /api/search/projects?tag=...` | Cross-project search by tag |
| `GET/POST /api/cross-perspectives` | Multi-extension saved views |


## Roadmap

- [x] Generalized animated layers for any geometry + timeseries
- [x] Extension system with pip-installable plugins
- [x] AI chat assistant with DuckDB queries and tool use
- [x] Per-entity and project-level data controls
- [x] Plotly chart visualization for extensions
- [x] Data lineage tracking with review status
- [ ] AI-driven visualization search (autonomous analysis)
- [ ] Multi-scenario comparison (side-by-side or visual diff)
- [ ] Multi-display, multi-machine capability
- [ ] Custom deck.gl layers (directional transmission line layer)
