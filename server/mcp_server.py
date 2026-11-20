"""
GridSight MCP server — stdio transport for Claude Desktop integration.

Exposes read tools (list scenarios/layers/charts) and control tools that push
live state changes into the running GridSight app via the stateBus inject
endpoint.

Backend discovery (first match wins):
  1. GRIDSIGHT_BACKEND_URL + GRIDSIGHT_API_KEY  env vars
  2. <platform config dir>/gridsight/backend.json  (written by Tauri on launch)
  3. desktop/.dev-backend.json  relative to this file  (dev-mode fallback)

Invoke via Claude Desktop config:
  {
    "mcpServers": {
      "gridsight": {
        "command": "uv",
        "args": ["run", "--project", "/path/to/GridSight/server",
                 "python", "/path/to/GridSight/server/mcp_server.py"]
      }
    }
  }
"""
from __future__ import annotations

import json
import logging
import os
import platform
import socket
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Backend discovery
# ---------------------------------------------------------------------------


def _platform_config_dir() -> Path:
    system = platform.system()
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support"
    if system == "Windows":
        return Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming")))
    return Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))


def _port_alive(port: int, timeout: float = 0.4) -> bool:
    """True if something is accepting TCP connections on 127.0.0.1:port."""
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _load_backend_info() -> tuple[str, str]:
    """Return (base_url, api_key) for a LIVE GridSight backend.

    Discovery order: env override → desktop descriptor → dev descriptors. Each
    file-based candidate is liveness-checked (a quick TCP connect) so a stale
    descriptor — e.g. the desktop app's backend.json left behind after quitting,
    pointing at a dead ephemeral port — is skipped in favor of a live one (like
    dev.sh on :5001). Without this, the first descriptor that merely *parses*
    wins and every tool call fails with "Connection refused" until the stale
    file is deleted by hand. Raises RuntimeError only if nothing is reachable.
    """
    url = os.environ.get("GRIDSIGHT_BACKEND_URL")
    key = os.environ.get("GRIDSIGHT_API_KEY")
    if url and key:
        return url.rstrip("/"), key  # explicit override — honored as-is, no probe

    candidates = [
        _platform_config_dir() / "gridsight" / "backend.json",
        Path(__file__).parent.parent / "desktop" / ".dev-backend.json",
        Path.cwd() / ".dev-backend.json",
    ]
    first_parsed: tuple[str, str] | None = None
    for path in candidates:
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        port = data.get("port")
        api_key = data.get("apiKey")
        if not (port and api_key):
            continue
        info = (f"http://127.0.0.1:{port}", api_key)
        if _port_alive(port):
            return info  # first LIVE descriptor wins
        if first_parsed is None:
            first_parsed = info  # remember as a fallback

    # Nothing alive. Fall back to the first parsed descriptor so the caller
    # surfaces a normal connection error (and _call's retry can recover once a
    # backend comes up); only raise if no descriptor was found at all.
    if first_parsed is not None:
        return first_parsed

    raise RuntimeError(
        "GridSight is not running or its backend descriptor was not found. "
        "Start the GridSight desktop app (or ./dev.sh), then try again."
    )


_client: httpx.Client | None = None


def _get_client() -> httpx.Client:
    global _client
    if _client is None:
        base_url, api_key = _load_backend_info()
        _client = httpx.Client(
            base_url=base_url,
            headers={"X-MyApp-ApiKey": api_key},
            timeout=10.0,
        )
        logger.info("MCP server connected to GridSight at %s", base_url)
    return _client


def _call(method: str, path: str, **kwargs):
    """HTTP call that resets the cached client on connection failure so the next
    call re-discovers the (possibly new) backend port."""
    global _client
    try:
        return getattr(_get_client(), method)(path, **kwargs)
    except httpx.ConnectError:
        _client = None
        # Retry once — backend may have restarted at a new port
        return getattr(_get_client(), method)(path, **kwargs)


def _inject(channel: str, payload: dict[str, Any], action: str = "update") -> str:
    r = _call("post", "/internal/bus/inject",
               json={"channel": channel, "payload": payload, "action": action})
    r.raise_for_status()
    data = r.json()
    return f"Sent to {data['sent']} client(s) on channel '{data['channel']}'"


def _find_chart_spec(chart_name: str, ext_hint: str = "") -> tuple[dict | None, str]:
    """Fetch the full ChartSpec dict for a chart.

    Returns (spec_dict, ext_name) or (None, '') if not found.
    Searches all extensions unless ext_hint is provided.
    """
    extensions = _call("get", "/api/extensions").raise_for_status().json()
    for ext in extensions:
        ext_name = ext.get("name", "")
        if ext_hint and ext_name != ext_hint:
            continue
        try:
            specs = _call("get", f"/api/extensions/{ext_name}/charts").raise_for_status().json()
            for s in specs:
                if s.get("name") == chart_name:
                    return s, ext_name
        except Exception:
            pass
    return None, ""


# ---------------------------------------------------------------------------
# SEDS human-readable code mappings
# ---------------------------------------------------------------------------

_FUEL_LABELS: dict[str, str] = {
    "TE": "Total Energy",
    "ES": "Electricity",
    "CL": "Coal",
    "NN": "Natural Gas",
    "PA": "Petroleum",
    "NU": "Nuclear",
    "RE": "Renewables",
    "SO": "Solar",
    "WY": "Wind",
    "HY": "Hydro",
    "GE": "Geothermal",
    "BM": "Biomass",
}
_SECTOR_LABELS: dict[str, str] = {
    "TC": "Total Consumption",
    "RC": "Residential",
    "CC": "Commercial",
    "IC": "Industrial",
    "AC": "Transportation",
    "EI": "Electric Power",
    "TP": "Total Production",
    "TX": "Total Expenditures",
}

# Reverse maps: lowercase name → code, and code → code (accept either form)
_FUEL_BY_NAME: dict[str, str] = {v.lower(): k for k, v in _FUEL_LABELS.items()}
_FUEL_BY_NAME.update({k.lower(): k for k in _FUEL_LABELS})
_SECTOR_BY_NAME: dict[str, str] = {v.lower(): k for k, v in _SECTOR_LABELS.items()}
_SECTOR_BY_NAME.update({k.lower(): k for k in _SECTOR_LABELS})


def _resolve_fuel(s: str) -> str | None:
    upper = s.strip().upper()
    if upper in _FUEL_LABELS:
        return upper
    return _FUEL_BY_NAME.get(s.strip().lower())


def _resolve_sector(s: str) -> str | None:
    upper = s.strip().upper()
    if upper in _SECTOR_LABELS:
        return upper
    return _SECTOR_BY_NAME.get(s.strip().lower())


# ---------------------------------------------------------------------------
# MCP server definition
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "GridSight",
    instructions=(
        "Tools for reading data from and controlling the GridSight geospatial "
        "energy visualization app (maps, timeseries, and charts for US energy grid data).\n\n"
        "ALWAYS call describe_data() first. It returns every loaded extension's data "
        "model — tables, columns, controls, and example queries. The app's data lives in "
        "DuckDB tables (e.g. ext_seds.data) that you query directly; you are not limited "
        "to pre-defined charts.\n\n"
        "To visualize anything:\n"
        "  1. describe_data() — learn the tables/columns available\n"
        "  2. query_data(sql) — explore with read-only SELECTs to confirm shape/values\n"
        "  3. create_chart(sql, chart_type, x_column, y_column, ...) — YOU write the SQL; "
        "the chart is built server-side and opened live in the app\n\n"
        "Other tools:\n"
        "  - list_scenarios() / set_scenario() — projects & scenarios\n"
        "  - list_layers() / set_layer_visibility() — map layers\n"
        "  - pan_map() / fit_map_to_bounds() / zoom_map() / set_basemap() / set_clock_year() — view & time\n"
        "  - list_charts() / open_chart() — pre-defined extension charts (a shortcut; "
        "create_chart() is more flexible)\n"
        "  - query_seds() — convenience wrapper for EIA SEDS data (human-readable "
        "fuel/sector/year)\n\n"
        "Prefer create_chart() with your own SQL when the user wants something specific; "
        "fall back to open_chart()/query_seds() for the canned views."
    ),
)


# ── Read tools ───────────────────────────────────────────────────────────────


# ---------------------------------------------------------------------------
# Extensions and data intake
# ---------------------------------------------------------------------------

def _uv_binary() -> str | None:
    """The uv that manages this venv: $GRIDSIGHT_UV, the desktop bundle's
    copy (…/Resources/binaries/uv next to resources/server), or uv on PATH."""
    import shutil
    env = os.environ.get("GRIDSIGHT_UV")
    if env and Path(env).exists():
        return env
    here = Path(__file__).resolve()
    for cand in (here.parents[2] / "binaries" / "uv", here.parents[2] / "binaries" / "uv.exe"):
        if cand.exists():
            return str(cand)
    return shutil.which("uv")


@mcp.tool()
def list_extensions() -> list[dict]:
    """List the extensions that the running GridSight backend has loaded
    (name, display name, version). Call after install_extension and
    restart_backend to check that a new extension loaded."""
    r = _call("get", "/api/extensions")
    r.raise_for_status()
    data = r.json()
    items = data if isinstance(data, list) else data.get("extensions", data)
    return [{k: x.get(k) for k in ("name", "display_name", "version", "description") if k in x}
            for x in items]


@mcp.tool()
def install_extension(spec: str) -> dict:
    """Install a GridSight extension into the backend's Python environment.

    `spec` is anything `uv pip install` accepts, or a bundle zip:
      - a PyPI requirement, e.g. "gridsight-gat"
      - a git requirement, e.g. "gridsight-gat @ git+https://github.com/NatLabRockies/GridAnalysisToolkit.git@nlr-gat-v0.1.3#subdirectory=gridsight-ext"
      - several requirements separated by " ; " (installed in one call)
      - an absolute path to a .whl, or to a .zip of wheels (GAT's
        `make gridsight-bundle` output)
    The new extension loads only after restart_backend()."""
    import subprocess
    import sys
    import tempfile
    import zipfile

    uv = _uv_binary()
    if not uv:
        return {"ok": False, "error": "uv not found; set GRIDSIGHT_UV"}
    spec = spec.strip()
    args: list[str] = []
    if spec.lower().endswith(".zip"):
        tmp = tempfile.mkdtemp(prefix="gridsight-bundle-")
        with zipfile.ZipFile(spec) as z:
            for name in z.namelist():
                if name.lower().endswith(".whl"):
                    args.append(z.extract(name, tmp))
        if not args:
            return {"ok": False, "error": f"no wheels in {spec}"}
    else:
        args = [part.strip() for part in spec.split(" ; ") if part.strip()]
    proc = subprocess.run(
        [uv, "pip", "install", "--python", sys.executable, *args],
        capture_output=True, text=True,
    )
    return {
        "ok": proc.returncode == 0,
        "installed": args,
        "stdout": proc.stdout[-3000:],
        "stderr": proc.stderr[-3000:],
        "next": "call restart_backend() so the backend loads the extension",
    }


@mcp.tool()
def restart_backend(wait_seconds: float = 90.0) -> dict:
    """Restart the GridSight desktop backend (for example after
    install_extension) and wait until it answers again. The app window
    reconnects by itself. Desktop app only."""
    import time
    global _client
    try:
        _call("post", "/internal/restart")
    except Exception:
        pass  # the process may exit before the reply arrives
    time.sleep(4.0)
    deadline = time.time() + wait_seconds
    last = ""
    while time.time() < deadline:
        _client = None  # rediscover the new port from backend.json
        try:
            r = _call("get", "/api/extensions")
            if r.status_code == 200:
                return {"ok": True, "extensions": list_extensions()}
            last = f"HTTP {r.status_code}"
        except Exception as e:  # still starting
            last = str(e)
        time.sleep(2.0)
    return {"ok": False, "error": f"backend did not come back: {last}"}


@mcp.tool()
def list_upload_specs(extension: str) -> list[dict]:
    """Describe the data uploads an extension accepts: each spec's name,
    its file groups (with accepted types) and its form fields. Use these
    names with upload_local_files."""
    r = _call("get", f"/api/extensions/{extension}/upload-specs")
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, list) else data.get("specs", data)


@mcp.tool()
def upload_local_files(
    extension: str,
    spec_name: str,
    file_paths: dict[str, list[str]],
    form_data: dict[str, str] | None = None,
    wait_seconds: float = 900.0,
) -> dict:
    """Load local files into GridSight through an extension's upload spec
    (the same path as the app's upload dialog) and wait for the job.

    `file_paths` maps each file group to absolute paths; `form_data` holds
    the spec's fields. Call list_upload_specs(extension) first to get the
    names. Example: a Sienna scenario for the GAT extension is the system
    JSON plus the simulation_store.h5 file(s), and project/scenario names."""
    import time
    r = _call("post", f"/api/extensions/{extension}/upload-local/{spec_name}",
              json={"file_paths": file_paths, "form_data": form_data or {}})
    if r.status_code >= 400:
        return {"ok": False, "status": r.status_code, "error": r.text[:2000]}
    job_id = r.json()["job_id"]
    deadline = time.time() + wait_seconds
    job: dict = {}
    while time.time() < deadline:
        time.sleep(2.0)
        j = _call("get", f"/api/extensions/upload-jobs/{job_id}")
        if j.status_code != 200:
            continue
        job = j.json()
        if job.get("status") in ("success", "error"):
            break
    return {"ok": job.get("status") == "success", "job": job}

@mcp.tool()
def get_errors(since: int = 0, limit: int = 50) -> dict:
    """Recent errors in GridSight, oldest first: failed API calls (for
    example a chart whose SQL does not parse), server errors, and errors
    that the app window reported (render failures, uncaught exceptions).

    Call this after you change the view (set_scenario, open_chart,
    create_chart, load_dataset, ...) to check that it worked, and fix what
    it reports. Pass the returned `next_since` as `since` next time to get
    only new errors."""
    r = _call("get", "/api/errors", params={"since": since, "limit": limit})
    r.raise_for_status()
    return r.json()

@mcp.tool()
def capture_view(include_ui: bool = True, max_width: int = 1600):
    """Take a screenshot of the GridSight window as the user sees it: the
    map with all deck.gl layers, plus the panels, charts and legends on top
    (include_ui=False gives the map only). Use it to check what a change
    looks like, then correct it; pair it with get_errors().

    Returns the PNG image and a short note. The window must be open."""
    import base64
    import time
    import uuid

    from mcp.server.fastmcp import Image

    req = uuid.uuid4().hex
    sent = _inject("mcp", {"type": "capture-view", "requestId": req,
                           "includeUi": include_ui, "maxWidth": max_width}, "update")
    if sent.startswith("Sent to 0 "):
        return "No GridSight window is listening (Sent to 0 clients). Open the app or reload the window."
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(0.5)
        r = _call("get", f"/internal/capture/result/{req}")
        if r.status_code == 200:
            d = r.json()
            if d.get("error") or not d.get("png"):
                return f"Capture failed: {d.get('error') or 'no image'}"
            note = f"{d.get('width')}x{d.get('height')} px"
            if d.get("notes"):
                note += "; " + "; ".join(d["notes"])
            return [Image(data=base64.b64decode(d["png"]), format="png"), note]
    return "The window did not answer within 30 s."

@mcp.tool()
def inspect_layers() -> Any:
    """List the deck.gl layers the window draws RIGHT NOW, with their class,
    feature count and size/opacity props (radiusScale, radiusMaxPixels,
    widthScale, ...). Use it when capture_view shows a style change did not
    take effect: it tells you whether the window got the change."""
    import json as _json
    import time
    import uuid

    req = uuid.uuid4().hex
    sent = _inject("mcp", {"type": "inspect-layers", "requestId": req}, "update")
    if sent.startswith("Sent to 0 "):
        return "No GridSight window is listening."
    deadline = time.time() + 15
    while time.time() < deadline:
        time.sleep(0.3)
        r = _call("get", f"/internal/capture/result/{req}")
        if r.status_code == 200:
            notes = r.json().get("notes") or ["{}"]
            return _json.loads(notes[0])
    return "The window did not answer within 15 s."

@mcp.tool()
def set_legend_open(open: bool = True) -> str:
    """Show the map legend panel open (True) or only on hover (False).
    The setting is saved with save_view, so story chapters show their
    legend. Legends follow the visible layers' styles automatically."""
    return _inject("mcp", {"type": "set-legend-open", "open": bool(open)})

@mcp.tool()
def list_scenarios() -> list[dict]:
    """List all projects and their scenarios currently loaded in GridSight.

    Call this first to understand what data is available before using
    set_scenario() or other tools that require project/scenario names.
    """
    projects: list[str] = _call("get", "/api/projects").raise_for_status().json()
    result = []
    for name in projects:
        scenarios: list[str] = _call("get", f"/api/projects/{name}").raise_for_status().json()
        result.append({"project": name, "scenarios": scenarios})
    return result


@mcp.tool()
def list_layers() -> list[dict]:
    """List all map layers available in GridSight (generation capacity, transmission lines, etc.).

    Use the returned layer_id values with set_layer_visibility().
    The project/scenario fields indicate which dataset a layer belongs to (null = always visible).
    """
    layers = _call("get", "/api/layers/all").raise_for_status().json()
    # `label`/`type` are not keys this API returns — it serialises
    # display_name/name and deck_layer_type. Reading the wrong ones made every
    # layer come back {"label": null, "type": null}, so a caller could not tell
    # which layer was which and could only address them by bare id.
    out = []
    for l in layers:
        geo = l.get("geometry") or {}
        out.append({
            "layer_id": l.get("id"),
            "label": l.get("display_name") or l.get("name"),
            "type": l.get("deck_layer_type"),
            "project": l.get("project") or None,
            "scenario": l.get("scenario") or None,
            "geometry": geo.get("display_name") or geo.get("name"),
            "feature_count": geo.get("feature_count"),
            "has_datasets": bool(l.get("layer_datasets")),
        })
    return out


@mcp.tool()
def list_charts() -> list[dict]:
    """List all chart types registered by installed extensions.

    Key fields:
      chart_name   — pass to open_chart()
      display_name — human-readable label shown in the UI
      scope        — "scenario" (full-dataset view, open directly) or
                     "entity" (per-state/plant detail, appears on map click)
      project      — if set, this chart only applies to that project (null = any)

    For SEDS data, query_seds() is a higher-level tool that sets fuel/sector/year
    and opens the scenario charts in one step.
    """
    extensions = _call("get", "/api/extensions").raise_for_status().json()
    charts = []
    for ext in extensions:
        ext_name = ext.get("name", "")
        try:
            specs = _call("get", f"/api/extensions/{ext_name}/charts").raise_for_status().json()
            for s in specs:
                charts.append({
                    "extension": ext_name,
                    "chart_name": s.get("name"),
                    "display_name": s.get("display_name"),
                    "scope": s.get("scope"),
                    "project": s.get("project") or None,
                    "scenario": s.get("scenario") or None,
                })
        except Exception:
            pass
    return charts


@mcp.tool()
def describe_data(extension: str = "") -> dict:
    """Describe queryable data in GridSight — CALL THIS FIRST.

    Two tiers:
      - describe_data()           → CONCISE overview: every extension with a
                                    one-line description, its table names, and a
                                    few example prompts. Start here.
      - describe_data("seds")     → FULL DETAIL for one extension: every table
                                    with column names/types/descriptions, example
                                    SQL queries, controls, plotting hints, and
                                    dataset join descriptions.

    Use the detail tier to learn exact column names before writing SQL for
    query_data() and create_chart(). Tables are namespaced by extension
    (e.g. ext_seds.data).
    """
    caps = _call("get", "/api/ai/capabilities").raise_for_status().json()
    exts = caps.get("extensions", [])
    tables = caps.get("tables", [])

    if extension:
        ext = next((e for e in exts if e.get("extension") == extension), None)
        if ext is None:
            return {
                "error": f"Extension '{extension}' has no AI schema.",
                "available": [e.get("extension") for e in exts],
            }
        ext_tables = [t for t in tables if t.get("extension") == extension]
        return {"extension": extension, "schema": ext, "duckdb_tables": ext_tables}

    # Concise overview
    summary = []
    for e in exts:
        summary.append({
            "extension": e.get("extension"),
            "description": (e.get("global_description") or e.get("description") or "")[:300],
            "tables": [t.get("table_name") for t in e.get("tables", [])],
            "example_prompts": (e.get("example_prompts") or [])[:3],
        })
    return {
        "extensions": summary,
        "all_duckdb_tables": [t.get("table_name") for t in tables],
        "hint": "Call describe_data(extension='<name>') for full columns, example "
                "queries, and controls before writing SQL.",
    }


@mcp.tool()
def query_data(sql: str) -> list[dict]:
    """Run a read-only SQL query against GridSight's DuckDB tables and return rows.

    Use this to explore data before charting (confirm columns, value ranges,
    distinct categories). Only SELECT / WITH queries are allowed. Table names
    come from describe_data() (e.g. ext_seds.data). Results are capped at 200 rows.

    Args:
        sql: A SELECT or WITH query, e.g.
             "SELECT state_code, value FROM ext_seds.data
              WHERE msn='ESTCB' AND year=2020 AND state_code<>'US'
              ORDER BY value DESC LIMIT 10"
    """
    r = _call("post", "/api/query", json={"sql": sql, "format": "json"})
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and "error" in data:
        return [{"error": data["error"]}]
    rows = data if isinstance(data, list) else [data]
    if len(rows) > 200:
        return rows[:200] + [{"_note": f"{len(rows)} rows total; showing first 200"}]
    return rows


@mcp.tool()
def create_chart(
    sql: str,
    chart_type: str = "bar",
    x_column: str = "",
    y_column: str = "",
    title: str = "",
    color_column: str = "",
    chart_format: str = "plotly",
    anchor: str = "floating",
) -> str:
    """Build a chart from your own SQL and open it live in the GridSight app.

    This is the flexible, generative path: YOU write the SQL against any
    extension table (see describe_data()), choose the chart type and axes, and
    the server runs the query, builds the spec, and pushes it to all connected
    displays. The chart carries reactive metadata so it refreshes when the
    underlying data/controls change.

    Tips:
      - x_column / y_column must be column names (or aliases) in your SELECT.
      - Use color_column to split into series/groups (e.g. one line per fuel).
      - For multi-series stacking use chart_type="stacked_bar" or "stacked_area".
      - You may embed control placeholders like {year} in the SQL; they resolve
        to the current control value and re-resolve on change.

    Args:
        sql:          SELECT/WITH query producing the chart's rows
        chart_type:   "bar" | "line" | "scatter" | "pie" | "stacked_bar" | "stacked_area"
        x_column:     column for the x-axis (or pie labels)
        y_column:     column for the y-axis (or pie values)
        title:        chart title
        color_column: optional column to group/color into multiple series
        chart_format: "plotly" (default) or "vega-lite"
        anchor:       panel placement — "floating" | "right" | "bottom" | "left"
    """
    body = {
        "sql": sql,
        "chart_type": chart_type,
        "x_column": x_column,
        "y_column": y_column,
        "title": title,
        "color_column": color_column or None,
        "format": chart_format,
        "anchor": anchor,
    }
    r = _call("post", "/api/ai/chart", json=body)
    if r.status_code == 400:
        try:
            return f"Chart not created: {r.json().get('error', r.text)}"
        except Exception:
            return f"Chart not created: {r.text}"
    r.raise_for_status()
    data = r.json()
    label = data.get("title") or "(untitled)"
    return f"Opened chart '{label}' on {data.get('sent', 0)} display(s)."


@mcp.tool()
def load_dataset(
    path: str,
    name: str = "",
    join_key: str = "",
    timestamp_col: str = "",
    description: str = "",
) -> dict:
    """Load a local data file (Parquet or CSV) into GridSight as a queryable dataset.

    Use this to bring arbitrary data into the app. The file is uploaded to the
    backend, registered as a DuckDB table under the `user` schema, and becomes
    immediately discoverable via describe_data() and queryable via query_data().
    After loading, explore it, chart it with create_chart(), or describe it for
    future sessions — the typical setup loop is:
        load_dataset(...) -> describe_data() -> query_data(...) -> create_chart(...)

    Args:
        path:          Absolute path to a local .parquet or .csv file.
        name:          Dataset name (defaults to the file's basename). Becomes
                       the DuckDB table name (sanitized) under the `user` schema.
        join_key:      Optional column to join against map geometry (e.g. a FIPS
                       or state code) when later building a map layer.
        timestamp_col: Optional timestamp column name if this is a timeseries.
        description:   Optional human description of what the data is.

    Returns:
        The created dataset record. The `duckdb_table` field is the exact
        fully-qualified table name (e.g. "user.baxtel_dc") to use in
        query_data() / create_chart() SQL.
    """
    if not os.path.isfile(path):
        return {"error": f"file not found: {path}"}
    fname = os.path.basename(path)
    suffix = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
    fmt = "csv" if suffix == "csv" else "parquet"

    form: dict[str, str] = {"format": fmt}
    if name:
        form["name"] = name
    if join_key:
        form["join_key"] = join_key
    if timestamp_col:
        form["timestamp_col"] = timestamp_col
    if description:
        form["description"] = description

    with open(path, "rb") as fh:
        files = {"file": (fname, fh, "application/octet-stream")}
        r = _call("post", "/api/datasets", data=form, files=files)
    if r.status_code >= 400:
        try:
            return {"error": r.json()}
        except Exception:
            return {"error": r.text}
    return r.json()


@mcp.tool()
def create_point_layer(
    sql: str,
    name: str,
    lon_column: str = "longitude",
    lat_column: str = "latitude",
    radius_column: str = "",
    color_column: str = "",
    colormap: str = "",
    fill_color: str = "",
    category_column: str = "",
    category_groups: str = "",
) -> dict:
    """Create a bubble (point) map layer from a SELECT query and show it live.

    YOU write SQL against any DuckDB table (see describe_data()) that returns a
    longitude and latitude column plus any properties. Each row becomes a map
    bubble. Bubble size and color are data-driven. The layer appears on every
    connected display immediately. Great for "show me X locations" requests
    (e.g. filtering data centers to Texas + operational).

    Tips:
      - The SELECT must include the lon/lat columns named below.
      - radius_column (numeric) drives bubble SIZE (area ∝ value).
      - Coloring options (pick one):
          * category_column (categorical) → one color per category from a
            generated palette, PLUS an interactive legend (click to filter).
            Best for status/type fields like `stage`. Takes precedence.
          * color_column (numeric) → continuous `colormap` fill.
          * neither → a single flat fill_color ("r,g,b[,a]", 0–255).
      - Clicking a bubble shows an infocard with that row's properties.

    CATEGORICAL workflow — IMPORTANT: before coloring by a category column,
    first inspect its distinct values with query_data
    (e.g. SELECT DISTINCT stage, count(*) ... GROUP BY 1 ORDER BY 2 DESC).
    If you see related/overlapping values (e.g. '{Planned}' and
    '{Land Bank, Planned}'), ASK THE USER whether to merge them into one
    bucket or keep them split — do not decide silently. Then pass their choice
    via category_groups.

    Args:
        sql:             SELECT returning lon/lat + property columns.
        name:            Layer name (shown in the layer list).
        lon_column:      Longitude column name (default "longitude").
        lat_column:      Latitude column name (default "latitude").
        radius_column:   Numeric column for bubble size (optional).
        color_column:    Numeric column for continuous color via colormap.
        colormap:        Colormap name for color_column (blank → user default).
        fill_color:      Static "r,g,b[,a]" 0–255 (when no color/category column).
        category_column: Column to color BY CATEGORY with a legend (e.g. "stage").
                         Include this column in your SELECT.
        category_groups: Optional JSON object merging raw values into labeled
                         buckets, e.g.
                         '{"Planned":["Planned"],"Operational":["Operational"],
                           "Construction":["Construction"]}'
                         A raw value joins the first group it substring-matches
                         (case-insensitive); unmatched values fall into "Other".
                         Omit to give every distinct raw value its own color.

    Returns:
        The created layer record. For categorical layers, `categories` lists
        each bucket and its count.
    """
    body: dict[str, Any] = {
        "sql": sql,
        "name": name,
        "lon_column": lon_column,
        "lat_column": lat_column,
        "colormap": colormap,
    }
    if radius_column:
        body["radius_column"] = radius_column
    if color_column:
        body["color_column"] = color_column
    if fill_color:
        try:
            body["fill_color"] = [int(x) for x in fill_color.split(",")]
        except ValueError:
            return {"error": f"fill_color must be comma-separated ints, got {fill_color!r}"}
    if category_column:
        body["category_column"] = category_column
    if category_groups:
        try:
            groups = json.loads(category_groups)
        except json.JSONDecodeError as e:
            return {"error": f"category_groups must be valid JSON object: {e}"}
        if not isinstance(groups, dict):
            return {"error": "category_groups must be a JSON object {label: [patterns]}"}
        body["category_groups"] = groups

    r = _call("post", "/api/layers/point", json=body)
    if r.status_code >= 400:
        try:
            return {"error": r.json()}
        except Exception:
            return {"error": r.text}
    result = r.json()
    # Nudge every connected display to re-fetch and show the new layer live.
    try:
        _inject("mcp", {"type": "reload-layers"})
        # For a categorical layer, auto-pop-out its interactive legend so the
        # user doesn't have to open it from the layer's Mappings.
        if result.get("category_column") and result.get("id") is not None:
            _inject("mcp", {"type": "popout-legend", "layerId": result["id"]})
    except Exception:
        pass
    return result


@mcp.tool()
def remove_layer(layer_id: int) -> dict:
    """Delete a map layer and remove it from every connected display.

    Use this to clean up layers you (or a previous session) created — e.g.
    redundant or superseded user point layers. Find layer ids with
    list_layers(). Deletes the layer server-side and drops it from the live map
    immediately. Extension-provided layers can be deleted too, but they
    typically reappear when their extension reloads — prefer set_layer_visibility
    to merely hide those.

    Args:
        layer_id: The layer's numeric id (from list_layers()).

    Returns:
        {"removed": <layer_id>} on success, or {"error": ...}.
    """
    r = _call("delete", f"/api/layers/{layer_id}")
    if r.status_code == 404:
        return {"error": f"layer {layer_id} not found"}
    if r.status_code >= 400:
        try:
            return {"error": r.json()}
        except Exception:
            return {"error": r.text}
    # Drop it from every live display.
    try:
        _inject("mcp", {"type": "remove-layer", "layerId": layer_id})
    except Exception:
        pass
    return {"removed": layer_id}


@mcp.tool()
def set_table_description(
    table_name: str,
    description: str = "",
    column_name: str = "",
    column_description: str = "",
    is_joinable: bool = False,
    join_target_table: str = "",
    join_target_column: str = "",
) -> dict:
    """Describe a DuckDB table or one of its columns so the AI understands it.

    Persisted descriptions are merged into the AI's context, so this is how you
    teach the agent about user-loaded data — what the table is, what a column
    means, value conventions (e.g. "stage is a set-string like {Operational}"),
    and join relationships. Call once per table, then again per column as needed.

    Args:
        table_name:         Fully-qualified table, e.g. "user.baxtel_us_sites".
        description:        Table-level description (what the data is).
        column_name:        Column to describe (omit for table-level only).
        column_description: What the column means / how to use it.
        is_joinable:        True if this column joins to another table.
        join_target_table:  The table this column joins to (if joinable).
        join_target_column: The column it joins on (if joinable).

    Returns:
        Confirmation of what was written.
    """
    body: dict[str, Any] = {"table_name": table_name}
    if description:
        body["description"] = description
    if column_name:
        body["column_name"] = column_name
    if column_description:
        body["column_description"] = column_description
    if is_joinable:
        body["is_joinable"] = True
    if join_target_table:
        body["join_target_table"] = join_target_table
    if join_target_column:
        body["join_target_column"] = join_target_column

    r = _call("post", "/api/descriptions", json=body)
    if r.status_code >= 400:
        try:
            return {"error": r.json()}
        except Exception:
            return {"error": r.text}
    return r.json()


@mcp.tool()
def set_style_preference(
    colormap: str = "",
    opacity: float = -1.0,
    point_color: str = "",
) -> dict:
    """Save the user's default map-styling preferences (persisted across sessions).

    New layers created via create_point_layer (and other layer tools) use these
    defaults automatically. Use when the user states a styling preference, e.g.
    "I like the plasma colormap" or "make bubbles more transparent". Set only the
    fields that changed.

    Args:
        colormap:    Default colormap, e.g. "viridis", "plasma", "coolwarm", "rdylgn".
        opacity:     Default layer opacity 0.0–1.0 (leave as -1 to not change).
        point_color: Default bubble color as "r,g,b" or "r,g,b,a" (0–255).
    """
    body: dict[str, Any] = {}
    if colormap:
        body["colormap"] = colormap
    if opacity >= 0:
        body["opacity"] = opacity
    if point_color:
        try:
            body["point_color"] = [int(x) for x in point_color.split(",")]
        except ValueError:
            return {"error": f"point_color must be comma-separated ints, got {point_color!r}"}
    if not body:
        return {"error": "Nothing to set — provide colormap, opacity, and/or point_color."}

    r = _call("patch", "/api/preferences/style", json=body)
    if r.status_code >= 400:
        try:
            return {"error": r.json()}
        except Exception:
            return {"error": r.text}
    return r.json()


# ── Control tools ─────────────────────────────────────────────────────────────


@mcp.tool()
def set_scenario(project: str, scenario: str) -> str:
    """Switch the active project and scenario displayed in GridSight.

    Use list_scenarios() to get valid project/scenario names.

    Args:
        project: Project name (e.g. "Western Grid", "seds-historical")
        scenario: Scenario name within that project (e.g. "2030 High RE", "all")
    """
    return _inject("scenario", {"project": project, "scenario": scenario})


@mcp.tool()
def pan_map(latitude: float, longitude: float, zoom: float = 5.0) -> str:
    """Pan and zoom the GridSight map to specific coordinates.

    Args:
        latitude: Target latitude in decimal degrees (e.g. 39.5 for center of US)
        longitude: Target longitude in decimal degrees (e.g. -98.0 for center of US)
        zoom: Map zoom level — 2=continent, 4=country, 6=multi-state, 8=state, 12=city
    """
    return _inject("viewport", {
        "latitude": latitude,
        "longitude": longitude,
        "zoom": zoom,
    })


@mcp.tool()
def set_basemap(basemap: str) -> str:
    """Change the GridSight map's base layer (background tiles).

    Canonical schema lives in lib/ai/tool_catalog.py (shared with the web chat);
    this injects the same 'set-basemap' bus payload the in-app assistant uses.

    Args:
        basemap: One of 'dark-matter' (dark, minimal — default), 'positron'
            (light, minimal), 'voyager' (light with more detail), or 'satellite'
            (Esri aerial imagery). Use 'satellite' for aerial/photographic context.
    """
    valid = ("dark-matter", "positron", "voyager", "satellite")
    if basemap not in valid:
        return f"Unknown basemap '{basemap}'. Valid options: {', '.join(valid)}."
    return _inject("mcp", {"type": "set-basemap", "basemap": basemap})


@mcp.tool()
def zoom_map(delta: float) -> str:
    """Zoom the GridSight map in/out by a RELATIVE amount, keeping the center.

    Each +1 roughly doubles the scale (zooms in); each -1 halves it. Use for
    'zoom in a little' (~1), 'zoom in' (~2), 'zoom out' (~-2). To jump to a place,
    use fit_map_to_bounds or pan_map instead.

    Args:
        delta: Relative zoom change; positive zooms in, negative zooms out.
    """
    return _inject("viewport", {"zoomDelta": delta})


@mcp.tool()
def fit_map_to_bounds(west: float, south: float, east: float, north: float) -> str:
    """Fit the GridSight map view to a geographic bounding box.

    Use this to frame a region of interest (e.g. a state, NERC region, or country).

    Args:
        west: Western longitude (e.g. -124.4 for California's western edge)
        south: Southern latitude
        east: Eastern longitude
        north: Northern latitude
    """
    # `fit: True` forces the receiver onto its fitBounds path regardless of the
    # viewport-sync "fit bounds" toggle (which defaults off). The midpoint
    # center is a harmless fallback if a receiver ignores bounds.
    return _inject("viewport", {
        "bounds": {"w": west, "s": south, "e": east, "n": north},
        "fit": True,
        "latitude": (south + north) / 2.0,
        "longitude": (west + east) / 2.0,
    })


@mcp.tool()
def open_chart(
    chart_name: str,
    extension: str = "",
    entity_id: str = "",
    anchor: str = "",
) -> str:
    """Open an extension chart panel in the GridSight UI with live data.

    Use list_charts() first to find chart names and their scope.

    Scope guidance:
      scope=scenario  — shows full-dataset views (US totals, rankings, fuel mix).
                        Open directly with open_chart().
      scope=entity    — shows per-state or per-plant detail views.
                        These normally appear when the user clicks a map entity;
                        provide entity_id to open them directly.

    Args:
        chart_name: Chart identifier from list_charts() (e.g. "seds__us_total_energy")
        extension:  Extension name from list_charts(). Auto-detected if omitted.
        entity_id:  For entity-scoped charts: the FIPS code or entity ID
                    (e.g. "06" for California). Omit for scenario-scope charts.
        anchor:     Panel placement. Omit unless the user asks for a specific
                    spot — the app then uses its own default (the chart tray).
    """
    spec, ext_name = _find_chart_spec(chart_name, extension)
    if spec is None:
        available = [c["chart_name"] for c in list_charts()]
        return (
            f"Chart '{chart_name}' not found. "
            f"Available charts: {', '.join(available) or '(none loaded)'}"
        )
    # An entity chart with no entity_id resolves its WHERE clause to `= ''`,
    # matches nothing, and renders "No chart data available". Opening a frame
    # is fire-and-forget, so refusing here is the only way the caller learns.
    if spec.get("scope") == "entity" and not str(entity_id or "").strip():
        alt = ", ".join(
            c["chart_name"] for c in list_charts()
            if c.get("extension") == ext_name and c.get("scope") == "scenario"
        )
        return (
            f"'{spec.get('display_name') or chart_name}' is entity-scoped and needs "
            f"entity_id (a state FIPS like '48' for Texas, or a county GEOID). "
            f"Nothing was opened — it would have rendered empty. "
            f"Scenario-wide charts in {ext_name}: {alt or '(none)'}"
        )
    # Omit anchorMode unless asked for: the frontend resolves placement as
    # `payload.anchorMode || defaultAnchor`, so sending a value here overrides
    # the app's own default (the tray) and floats the chart over the map.
    frame: dict = {
        "type": "chart:open-frame",
        "charts": [{"extName": ext_name, "spec": spec, "entityId": entity_id}],
    }
    if anchor:
        frame["anchorMode"] = anchor
    return _inject("charts", frame)


@mcp.tool()
def set_layer_visibility(layer_id: str, visible: bool) -> str:
    """Show or hide a specific map layer in GridSight.

    Use list_layers() to find valid layer_id values.

    Args:
        layer_id: Layer identifier from list_layers()
        visible:  True to show the layer, False to hide it
    """
    # Use the merge-safe 'mcp' command, NOT the 'layers:visibility' sync
    # channel: that channel REPLACES the whole visibility map, so a
    # single-entry payload would hide every other layer.
    return _inject("mcp", {
        "type": "set-layer-visibility",
        "layerId": layer_id,
        "visible": visible,
    })


@mcp.tool()
def set_clock_year(year: int) -> str:
    """Jump the GridSight animation clock to a specific year and pause playback.

    Useful for snapping the map and charts to a particular point in time
    before opening a chart or taking a screenshot.

    Args:
        year: Four-digit year to display (e.g. 2030)
    """
    return _clock_payload(index=year, animate=False)


def _clock_payload(index: int | None = None, animate: bool | None = None,
                   frequency: int | None = None, start_index: int | None = None,
                   end_index: int | None = None) -> str:
    """Publish a clock anchor in the shape useClockEngine reads: the window
    ignores `index`; it snaps to `startIndex` when paused, and plays from
    (`startIndex`, `startWallTime`) when `animate` is true."""
    import time as _t
    now = int(_t.time() * 1000)
    p: dict[str, Any] = {"senderTime": now, "startWallTime": now}
    if index is not None:
        p["startIndex"] = int(index)
    if animate is not None:
        p["animate"] = bool(animate)
    if frequency is not None:
        p["frequency"] = int(frequency)
    if start_index is not None:
        p["start_index"] = int(start_index)
    if end_index is not None:
        p["end_index"] = int(end_index)
    return _inject("clock", p)


@mcp.tool()
def set_clock(index: int | None = None, animate: bool | None = None,
              frequency_ms: int | None = None, start_index: int | None = None,
              end_index: int | None = None) -> str:
    """Control the time clock that drives animated layers and charts.

    Args:
        index:        Time step to show (0 = first step of the scenario,
                      e.g. hour 0 of an hourly week; for annual data use the
                      year's index or set_clock_year).
        animate:      True plays the animation from `index`; False pauses.
        frequency_ms: Milliseconds per step while playing (default 750).
        start_index / end_index: Loop range while playing.
    The clock state is saved with save_view, so a story chapter can play an
    animation. Check with capture_view()."""
    return _clock_payload(index, animate, frequency_ms, start_index, end_index)


@mcp.tool()
def query_seds(
    fuel: str = "Electricity",
    sectors: str | list[str] = "Total Consumption",
    year: int = 2020,
    open_scenario_charts: bool = True,
    anchor: str = "",
) -> str:
    """Configure and display EIA State Energy Data System (SEDS) data (1960–2023).

    Updates the SEDS extension's fuel, sector, and reference-year controls, then
    optionally opens the US-wide scenario charts (total energy, state rankings,
    fuel mix). The choropleth map layer will also reflect the new selection.

    Available fuels (name or 2-letter code):
      Electricity (ES), Natural Gas (NN), Coal (CL), Petroleum (PA),
      Nuclear (NU), Renewables (RE), Solar (SO), Wind (WY), Hydro (HY),
      Geothermal (GE), Biomass (BM), Total Energy (TE)

    Available sectors (name or 2-letter code):
      Total Consumption (TC), Residential (RC), Commercial (CC),
      Industrial (IC), Transportation (AC), Electric Power (EI),
      Total Production (TP), Total Expenditures (TX)

    Note: entity-scoped state-detail charts appear automatically when a user
    clicks a state on the map; use open_chart() to open scenario-scope charts
    manually.

    Args:
        fuel:                 Fuel type — name or code (default "Electricity")
        sectors:              Sector(s) to display — single name/code or list for
                              multi-sector comparison (default "Total Consumption")
        year:                 Reference year for ranking charts and map layer (1960–2023)
        open_scenario_charts: Also open the US-wide scenario charts (default True)
        anchor:               Chart placement — "floating" | "right" | "bottom"
    """
    # Resolve fuel
    fuel_code = _resolve_fuel(fuel)
    if fuel_code is None:
        valid = ", ".join(f"{v} ({k})" for k, v in _FUEL_LABELS.items())
        return f"Unknown fuel '{fuel}'. Valid options: {valid}"

    # Resolve sectors (accept single string or list)
    sector_input = [sectors] if isinstance(sectors, str) else list(sectors)
    sector_codes: list[str] = []
    for s in sector_input:
        code = _resolve_sector(s)
        if code is None:
            valid = ", ".join(f"{v} ({k})" for k, v in _SECTOR_LABELS.items())
            return f"Unknown sector '{s}'. Valid options: {valid}"
        sector_codes.append(code)

    if not (1960 <= year <= 2023):
        return f"Year {year} is out of range. SEDS data covers 1960–2023."

    # POST control updates to the SEDS extension
    # SEDS is a singleton extension; project/scenario are routing metadata only.
    _seds_project = "seds-historical"
    _seds_scenario = "all"
    base = f"/api/extensions/seds/input-controls/{_seds_project}/{_seds_scenario}"

    updates: list[tuple[str, Any]] = [
        ("fuel", fuel_code),
        ("sector", sector_codes),
        ("year", year),
    ]
    errors: list[str] = []
    for control_name, value in updates:
        try:
            r = _call("post", base, json={"control_name": control_name, "value": value})
            r.raise_for_status()
            result = r.json()
            if not result.get("success"):
                errors.append(f"{control_name}: update returned success=false")
        except Exception as exc:
            errors.append(f"{control_name}: {exc}")

    if errors:
        return "SEDS control update errors: " + "; ".join(errors)

    # Broadcast the new control VALUES so a synced peer on a DIFFERENT backend
    # (e.g. a wall the desktop is driving) applies them to its own SEDS
    # singleton — control state isn't shared across backends, so a refresh
    # alone would leave the peer's widgets/data stale.
    for control_name, value in updates:
        try:
            _inject("controls:effects", {
                "type": "control-set",
                "extName": "seds",
                "controlName": control_name,
                "value": value,
                "project": _seds_project,
                "scenario": _seds_scenario,
            })
        except Exception:
            pass  # best-effort

    # Invalidate cached data in the frontend so already-open charts refresh.
    try:
        _inject("controls:effects", {
            "type": "datasets-invalidated",
            "extName": "seds",
            "datasets": ["state-view"],
        })
    except Exception:
        pass  # best-effort

    fuel_label = _FUEL_LABELS[fuel_code]
    sector_labels = [_SECTOR_LABELS[c] for c in sector_codes]
    summary = f"SEDS configured: fuel={fuel_label}, sectors={sector_labels}, year={year}."

    if not open_scenario_charts:
        return summary

    # Fetch fresh SEDS specs once (SQL is now baked with the updated control state).
    _scenario_chart_names = {
        "seds__us_total_energy",
        "seds__top_states_current",
        "seds__us_fuel_mix",
    }
    try:
        seds_specs: list[dict] = (
            _call("get", "/api/extensions/seds/charts").raise_for_status().json()
        )
    except Exception:
        return summary + " Could not fetch SEDS chart specs to open charts."

    opened: list[str] = []
    for spec in seds_specs:
        if spec.get("name") not in _scenario_chart_names:
            continue
        try:
            frame: dict = {
                "type": "chart:open-frame",
                "charts": [{"extName": "seds", "spec": spec, "entityId": ""}],
            }
            if anchor:                      # see open_chart: omit → app default
                frame["anchorMode"] = anchor
            _inject("charts", frame)
            opened.append(spec.get("display_name", spec.get("name", "?")))
        except Exception:
            pass

    if opened:
        summary += f" Opened charts: {', '.join(opened)}."
    else:
        summary += " No scenario charts found — use open_chart() to open them manually."
    return summary


# ── Chart management ──────────────────────────────────────────────────────────


@mcp.tool()
def close_charts() -> str:
    """Close ALL open chart panels in GridSight (AI charts and extension charts).

    Use this to clear the workspace before opening a fresh set, or when the user
    asks to dismiss the current charts.
    """
    return _inject("charts", {"type": "chart:close-all"})


@mcp.tool()
def arrange_charts(anchor: str = "right") -> str:
    """Re-anchor every currently open chart panel to the same dock.

    Useful when charts opened floating and overlap — pin them all to one side.

    Args:
        anchor: "right" | "left" | "bottom" | "floating" | "tray"
    """
    valid = {"right", "left", "bottom", "floating", "tray"}
    if anchor not in valid:
        return f"Invalid anchor '{anchor}'. Choose one of: {', '.join(sorted(valid))}."
    return _inject("charts", {"type": "chart:reanchor-all", "anchorMode": anchor})


# ── Layer styling and filtering (same verbs as the in-app AI) ─────────────


def _layer_tool(name: str, args: dict) -> Any:
    r = _call("post", f"/internal/tools/{name}", json={k: v for k, v in args.items() if v is not None})
    r.raise_for_status()
    return r.json()


@mcp.tool()
def list_layer_details() -> Any:
    """List map layers with their style mappings (style_id, visual property,
    column, colormap, domain) and geometry_properties (feature properties with
    sample values). Use it before style_layer, update_layer_style or
    filter_layer."""
    return _layer_tool("list_layers", {})


@mcp.tool()
def style_layer(layer_id: int, visual_property: str, column: str,
                scale_type: str | None = None, colormap: str | None = None,
                domain_min: float | None = None, domain_max: float | None = None,
                units: str | None = None, scale: float | None = None,
                min_pixels: float | None = None, max_pixels: float | None = None,
                category_colors: dict[str, str] | None = None) -> Any:
    """Create a NEW style mapping: drive a visual property of a layer from a
    data column or feature property (for example color transmission lines by
    voltage, size generators by capacity).

    visual_property: getColor | getFillColor | getLineColor | getLineWidth |
      getPointRadius | getElevation.
    scale_type: linear | log | quantile | categorical. colormap: viridis |
      plasma | coolwarm | rdylgn. For categorical, call once without
      category_colors to get the category values, then again with
      {value: '#RRGGBB'}.
    Size properties: units meters|pixels, scale (multiplier), min/max_pixels.
    See list_layer_details for columns; check with capture_view()."""
    return _layer_tool("style_layer", dict(
        layer_id=layer_id, visual_property=visual_property, column=column,
        scale_type=scale_type, colormap=colormap, domain_min=domain_min,
        domain_max=domain_max, units=units, scale=scale, min_pixels=min_pixels,
        max_pixels=max_pixels, category_colors=category_colors))


@mcp.tool()
def update_layer_style(layer_id: int, style_id: int, colormap: str | None = None,
                       scale_type: str | None = None, domain_min: float | None = None,
                       domain_max: float | None = None, column: str | None = None) -> Any:
    """Change an EXISTING style mapping (colormap viridis/plasma/coolwarm/rdylgn,
    scale linear/log/quantile/categorical, value domain, column). Get style_id
    from list_layer_details."""
    return _layer_tool("update_layer_style", dict(
        layer_id=layer_id, style_id=style_id, colormap=colormap,
        scale_type=scale_type, domain_min=domain_min, domain_max=domain_max, column=column))


@mcp.tool()
def filter_layer(layer_id: int, property: str = "", values: list[str] | None = None,
                 enabled: bool = True) -> Any:
    """Draw only the features of a layer whose property matches one of the
    values (for example transmission lines with voltage '500'). enabled=False
    clears the filter. Unknown values are refused and the real ones returned."""
    return _layer_tool("filter_layer", dict(layer_id=layer_id, property=property,
                                            values=values, enabled=enabled))


@mcp.tool()
def set_visible_layers(layer_ids: list[int]) -> Any:
    """Show exactly these layers and hide all others."""
    return _layer_tool("set_visible_layers", dict(layer_ids=layer_ids))

@mcp.tool()
def set_layer_options(layer_id: int, options: dict) -> str:
    """Set display options on a layer (merged into its local style), live.

    Common keys (all optional):
      Any layer:     opacity (0-1), filled, stroked, staticFillColor /
                     staticLineColor ([r,g,b,a] or '#rrggbb'), legendLabel
                     (adds a one-swatch legend entry for a single-color layer),
                     lineWidthMinPixels, lineWidthMaxPixels, lineWidthUnits.
      GeneratorLayer: generationVisible, capacityVisible, curtailmentVisible,
                     capacityProperty (e.g. 'nameplate_mw'), capacitySource
                     'availability' (default: hourly available MW, so solar
                     is 0 at night) | 'nameplate' (installed MW from
                     capacityProperty), radiusScale (px per MW),
                     radiusMinPixels, radiusMaxPixels.
      TransmissionLayer: displayMode 'flow' (default, animated loading) |
                     'capacity' (static: width = sqrt(capacity MW) *
                     capacityWidthFactor, color = categoryColors[colorProperty]
                     or staticLineColor), colorProperty (e.g. 'voltage_kv'),
                     categoryColors ({value: '#rrggbb'}), capacityWidthFactor.
    Check the result with capture_view()."""
    opts = dict(options or {})
    for k, v in list(opts.items()):
        if isinstance(v, str) and k.endswith("Color") and v.startswith("#") and len(v) == 7:
            opts[k] = [int(v[1:3], 16), int(v[3:5], 16), int(v[5:7], 16), 220]
    return _inject("mcp", {"type": "set-layer-geo-mapping", "layerId": layer_id, "style": opts})


@mcp.tool()
def create_geojson_layer(path: str, name: str, display_name: str = "",
                         description: str = "", options: dict | None = None) -> dict:
    """Add a local GeoJSON file (points, lines or polygons) as a new map layer,
    for example public data from another source to lay over the grid.

    The file is uploaded as a geometry and a layer is made from it; numeric
    properties get a default color mapping. Then style it with
    set_layer_options (e.g. {"staticFillColor": "#ff6a00", "opacity": 0.4}),
    style_layer or filter_layer, and check with capture_view().

    Args:
        path:         Absolute path to a .geojson / .json file.
        name:         Short name (used as the geometry and layer name).
        display_name: Label shown in the layer panel.
        description:  What the data is and where it came from (source, date).
        options:      Optional set_layer_options keys to apply at once.
    Returns: {"layer_id", "geometry_id", "name"} or {"error"}.
    """
    if not os.path.isfile(path):
        return {"error": f"file not found: {path}"}
    form = {"name": name, "format": "geojson", "scope": "global"}
    if display_name:
        form["display_name"] = display_name
    if description:
        form["description"] = description
    with open(path, "rb") as fh:
        r = _call("post", "/api/geometry", data=form,
                  files={"file": (os.path.basename(path), fh, "application/geo+json")})
    if r.status_code >= 400:
        return {"error": f"geometry upload: {r.status_code} {r.text[:300]}"}
    geo = r.json()
    r2 = _call("post", f"/api/geometry/{geo['id']}/quick-layer")
    if r2.status_code >= 400:
        return {"error": f"quick-layer: {r2.status_code} {r2.text[:300]}"}
    layer = r2.json()
    layer_id = layer.get("id") or layer.get("layer_id")
    try:
        _inject("mcp", {"type": "reload-layers"})
        if options and layer_id is not None:
            import time as _t
            _t.sleep(1.5)  # let the window fetch the new layer first
            set_layer_options(layer_id, options)
    except Exception:
        pass
    return {"layer_id": layer_id, "geometry_id": geo["id"], "name": name}


@mcp.tool()
def create_story(name: str, chapters: list[dict], description: str = "",
                 project: str = "") -> dict:
    """Make a story (guided tour) from saved perspectives, in order.

    Typical loop per chapter: set up the view -> capture_view() to check it
    -> save_view(name) -> list_perspectives() for its id. Then call this once.

    Args:
        name:        Story name.
        chapters:    [{"perspective_id": int, "narration": "markdown text",
                       "auto_advance_ms": optional int,
                       "transition_duration_ms": optional int}, ...]
        description: One-line summary of the story.
        project:     Optional project name to attach the story to.
    Returns: {"story_id", "steps": [step ids]} or {"error"}.
    """
    body: dict[str, Any] = {"name": name, "description": description, "owner": "agent"}
    if project:
        try:
            for p in _call("get", "/api/projects").raise_for_status().json():
                if p.get("name") == project:
                    body["project_id"] = p.get("id")
        except Exception:
            pass
    r = _call("post", "/api/stories", json=body)
    if r.status_code >= 400:
        return {"error": r.text[:300]}
    sid = r.json()["id"]
    steps = []
    for i, ch in enumerate(chapters, start=1):
        rs = _call("post", f"/api/stories/{sid}/steps", json={
            "perspective_id": ch["perspective_id"],
            "narration": ch.get("narration"),
            "auto_advance_ms": ch.get("auto_advance_ms"),
            "transition_duration_ms": ch.get("transition_duration_ms", 1000),
            "sort_order": i,
        })
        if rs.status_code >= 400:
            return {"story_id": sid, "steps": steps, "error": f"chapter {i}: {rs.text[:300]}"}
        steps.append(rs.json()["id"])
    return {"story_id": sid, "steps": steps}

# ── Stories, perspectives & memory (agent learning over time) ──────────────────


@mcp.tool()
def list_perspectives() -> list[dict]:
    """List saved perspectives — named snapshots of a full view (map, layers,
    charts, scenario). Apply one with apply_perspective(perspective_id)."""
    return _call("get", "/api/perspectives").raise_for_status().json()


@mcp.tool()
def list_stories() -> list[dict]:
    """List saved stories — ordered sequences of perspectives (guided narratives).

    Check this BEFORE building a new view: a past story may already capture an
    approach that worked. Play one with apply_story(story_id)."""
    return _call("get", "/api/stories").raise_for_status().json()


@mcp.tool()
def get_story(story_id: int) -> dict:
    """Get a story and its ordered steps (each step references a perspective with
    its saved view config and narration). Use to inspect how a past story was built.

    Args:
        story_id: Story id from list_stories()
    """
    story = _call("get", f"/api/stories/{story_id}").raise_for_status().json()
    steps = _call("get", f"/api/stories/{story_id}/steps").raise_for_status().json()
    return {"story": story, "steps": steps}


@mcp.tool()
def export_story(story_id: int, path: str = "") -> dict:
    """Package a story as a self-contained, shareable bundle.

    A story is only a list of steps pointing at perspective ROWS, so the story
    alone is meaningless on another machine — perspective ids won't match, and
    stories live in each install's own database. The bundle inlines every
    step's full perspective config, so the result is portable: hand the file to
    someone else and they can import_story() it with no shared database.

    Args:
        story_id: Story id from list_stories()
        path:     Optional file path to write the bundle to. When given, the
                  bundle is saved there and only a summary is returned (bundles
                  run large — a 7-chapter story is ~50KB of view config).
    Returns:
        {"story", "chapters", "path"} when written to disk, else the full bundle.
    """
    bundle = _call("get", f"/api/stories/{story_id}/export").raise_for_status().json()
    if path:
        import json as _json
        from pathlib import Path as _Path
        p = _Path(path).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(_json.dumps(bundle, indent=2))
        return {
            "story": bundle.get("story", {}).get("name"),
            "chapters": len(bundle.get("steps") or []),
            "path": str(p),
        }
    return bundle


@mcp.tool()
def import_story(path: str = "", bundle: dict | None = None, name: str = "") -> dict:
    """Load a story bundle (from export_story) into this GridSight instance.

    Creates fresh perspectives and a new story wired to them. Pass `name` to
    import alongside an existing copy instead of creating a confusing duplicate.

    Import can only wire up what this instance actually has: if the bundle
    names an extension or dataset that isn't installed here, those chapters
    still import but come back in `warnings` — check them before presenting the
    story as ready.

    Args:
        path:   Path to a bundle JSON file written by export_story().
        bundle: The bundle dict inline, as an alternative to `path`.
        name:   Optional replacement name for the imported story.
    Returns:
        {"id", "name", "steps", "warnings"}
    """
    if not path and bundle is None:
        return {"error": "pass either path= or bundle="}
    if path:
        import json as _json
        from pathlib import Path as _Path
        bundle = _json.loads(_Path(path).expanduser().read_text())
    body = dict(bundle or {})
    if name:
        body["name"] = name
    return _call("post", "/api/stories/import", json=body).raise_for_status().json()


@mcp.tool()
def apply_perspective(perspective_id: int) -> str:
    """Restore a saved perspective in the live app (map view, layers, charts).

    Args:
        perspective_id: id from list_perspectives()
    """
    return _inject("mcp", {"type": "apply-perspective", "perspectiveId": perspective_id})


@mcp.tool()
def apply_story(story_id: int) -> str:
    """Start playing a saved story in the live app (enters story playback mode).

    Args:
        story_id: id from list_stories()
    """
    return _inject("mcp", {"type": "apply-story", "storyId": story_id})


@mcp.tool()
def save_view(name: str, description: str = "", as_story: bool = False) -> str:
    """Snapshot the CURRENT live GridSight view and save it for later reuse.

    The frontend captures the live state (map viewport, layer visibility/styles,
    open charts, scenario, clock) and persists it as a perspective. With
    as_story=True it also wraps that snapshot in a one-step story so it shows up
    in list_stories() for future agents to discover and replay.

    This is fire-and-forget: after calling, use list_perspectives()/list_stories()
    to confirm and get the new id.

    Args:
        name:        Name for the saved view
        description: What this view shows and why it's useful (helps future recall)
        as_story:    Also create a story wrapping this view (default False)
    """
    return _inject("mcp", {
        "type": "capture-perspective",
        "name": name,
        "description": description,
        "storyName": name if as_story else None,
    })


@mcp.tool()
def save_memory(
    name: str,
    description: str,
    content: dict,
    memory_type: str = "insight",
    tags: list[str] | None = None,
) -> str:
    """Save a reusable artifact (a SQL query, chart spec, or insight) to GridSight's
    memory so future agent sessions can find and reuse it.

    Use this to record what worked — e.g. a SQL query that produced a good chart,
    or an analytical insight — with searchable tags.

    Args:
        name:        Short descriptive name
        description: What it is and when to reuse it
        content:     The artifact payload, e.g. {"sql": "SELECT ..."} or {"note": "..."}
        memory_type: "chart" | "query" | "insight" | "perspective_ref" | "story_ref"
        tags:        Tags for later search (e.g. ["texas", "electricity", "trend"])
    """
    body = {
        "name": name,
        "description": description,
        "memory_type": memory_type,
        "content": content,
        "tags": tags or [],
    }
    r = _call("post", "/api/memory", json=body)
    r.raise_for_status()
    data = r.json()
    if data.get("success"):
        return f"Saved memory '{name}' (id={data.get('memory_id')})."
    return f"Memory save result: {json.dumps(data)}"


@mcp.tool()
def search_memory(query: str, memory_type: str = "", limit: int = 10) -> list[dict]:
    """Search GridSight's memory for previously saved artifacts (queries, charts,
    insights) — call this to reuse approaches that worked in earlier sessions.

    Args:
        query:       Text to match against names, descriptions, and tags
        memory_type: Optional filter — "chart" | "query" | "insight" | etc.
        limit:       Max results (default 10)
    """
    params: dict = {"query": query, "limit": limit}
    if memory_type:
        params["memory_type"] = memory_type
    r = _call("get", "/api/memory/search", params=params)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and "error" in data:
        return [{"error": data["error"]}]
    return data if isinstance(data, list) else [data]


if __name__ == "__main__":
    mcp.run()
