"""
Chat handler — manages conversations, builds system prompts, orchestrates tool calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import TYPE_CHECKING, Any, AsyncIterator

from .context import (
    VIEW_MUTATING_TOOLS,
    render_story_context,
    render_table_catalog,
    render_view_state,
)
from .openai_client import llm_chat
from .providers import get_default_provider, is_ai_disabled
from .tools import TOOL_DEFINITIONS, ChatContext, execute_tool, to_canonical

if TYPE_CHECKING:
    from lib.extensions.duckdb_engine import DuckDBEngine
    from lib.extensions.registry import ExtensionRegistry
    from lib.lineage.manager import LineageManager

logger = logging.getLogger(__name__)

# In-memory conversation store (keyed by conversation_id)
_conversations: dict[str, list[dict]] = {}

# Active cancel events (keyed by conversation_id)
_cancel_events: dict[str, asyncio.Event] = {}

# Composing a view is inherently multi-step: list layers → show → filter →
# size → colour → frame the camera → open a chart is already seven calls, and
# models usually emit one per round. At 5 the loop was cut off mid-compose —
# a request could burn the whole budget on discovery and never reach the map,
# leaving a half-built view and an assistant that sounded like it had finished.
# The cap exists to stop runaway loops, so it should sit well above the
# longest legitimate workflow rather than inside it.
MAX_TOOL_ROUNDS = int(os.environ.get("LLM_MAX_TOOL_ROUNDS", "14"))
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "60"))  # seconds


def get_llm_config() -> dict | None:
    """Resolve the default provider and model from env vars.

    Returns {"provider": str, "model": str} if LLM_MODEL is set,
    or None if no default is configured. Note: AI may still be available
    even when this returns None — the user can pick a provider/model in the UI.
    """
    if is_ai_disabled():
        return None
    default = get_default_provider()
    if not default:
        return None
    return {"provider": default[0], "model": default[1]}


def build_system_prompt(
    registry: ExtensionRegistry,
    duckdb_engine: DuckDBEngine,
    *,
    webgpu_available: bool = False,
    db: Any = None,
    active_extensions: list[str] | None = None,
    active_story_id: int | None = None,
    active_perspective_id: int | None = None,
    visible_layer_ids: list[int] | None = None,
    extra_instructions: str | None = None,
) -> str:
    """Build a system prompt with context from extensions and DuckDB.

    If active_extensions is provided, only include context for those extensions.
    If None, include all extensions (backwards-compatible).

    If active_story_id is provided, the story's guide + description and its
    ordered chapter descriptions are injected, along with a reuse-first
    hierarchy so the assistant builds on the story instead of from scratch.

    active_perspective_id names the chapter currently applied. It is what makes
    the story context concrete — the chapter's saved scenario, visible layers,
    open charts, controls, and camera describe what the user is actually
    looking at. It is also meaningful on its own, for a perspective applied
    outside any story.
    """
    parts = [
        "You are Atlas, an assistant for geospatial data analysis and visualization.",
        "You help users explore datasets, run SQL queries, and understand patterns in their data.",
        "",
        "## Rendering Capabilities",
    ]
    parts.extend([
        "- Supported chart formats: plotly (default, recommended — uses WebGL via scattergl), vega-lite (declarative)",
        "- ChartGPU is deprecated; it requires a secure context (HTTPS) which our deployment can't provide. Do NOT emit format='chartgpu' unless the user explicitly asks for it.",
        "- Use format='vega-lite' for declarative specs that support brushing/selection",
        "- Use format='plotly' (default) for standard charts",
        "",
        "## Available Tools",
        "- **query_data(sql)**: Execute a read-only SQL query. Returns JSON rows.",
        "- **get_table_catalog(pattern?)**: List tables with their columns. The DuckDB Tables section below collapses large same-shaped table families into one line showing their name pattern — pass that pattern here to expand it. Call with no pattern only if you really need the full catalog.",
        "- **get_lineage(node_id?, node_type?)**: Retrieve the data lineage DAG.",
        "- **list_charts()**: List the pre-configured charts extensions provide (already correctly built, Plotly, slider-reactive, draggable). Call this BEFORE create_chart.",
        "- **open_chart(chart_name, extension?, entity_id?, anchor?)**: Open a pre-configured extension chart. PREFER this over create_chart whenever a listed chart matches the request. Charts listed with `requires_entity_id: true` (scope='entity') are per-state/per-county and MUST be given entity_id — a state FIPS like '48' for Texas, or a county GEOID; without one the chart renders empty and the tool refuses to open it. If the user hasn't named a place, either use the entity the current chapter is focused on, or pick the extension's scenario-wide chart instead.",
        "- **create_chart(sql, chart_type, x_column, y_column, title?, color_column?)**: Create a CUSTOM chart from a SQL query — use only when no pre-configured chart matches. The `sql` parameter is REQUIRED — the tool runs the query itself; do NOT pass raw data. Always Plotly.",
        "- **update_control(extension, project, scenario, entity_id, control_name, value)**: Modify an entity-level data control value.",
        "- **set_input_controls(extension, values)**: Set SEVERAL controls at once as {name: value}. PREFER THIS when a request implies more than one — controls are interdependent, and setting them one per round leaves half-configured states that render blank. Reports back any control that ends up selecting nothing, or that got coerced, so fix those before describing the result.",
        "- **update_input_control(extension, project, scenario, control_name, value)**: Change ONE control. Use for a single incremental tweak; for a request that implies several, use set_input_controls.",
        "- **list_extensions()** / **set_extension_state(extension, state)**: See which extensions are installed and enabled, and switch one on. A DISABLED extension is absent from everything below — its tables, layers, charts and controls are simply not in your context — so a request for data you cannot find may be switched off rather than missing. Enable it, then call list_layers again.",
        "- **list_layers()**: List all map layers with their visual style mappings AND each layer's styleable `geometry_properties` (name + numeric hint + sample value). Call before styling layers.",
        "- **style_layer(layer_id, visual_property, column, scale_type?, colormap?, domain_min?, domain_max?, units?, scale?, min_pixels?, max_pixels?, source?)**: Create a NEW visual style on a layer from scratch — e.g. 'color by planning_stage and size by planned_mw'. `visual_property` is one of getColor/getFillColor/getLineColor/getLineWidth/getPointRadius/getElevation; `column` comes from the layer's geometry_properties (or an attached dataset). For CATEGORICAL color, pass scale_type='categorical' (distinct colors are assigned automatically). For SIZE (getPointRadius/getLineWidth), also set `units` ('meters' scales with zoom, 'pixels' is constant screen size), `scale` (multiplier on the raw value), and optional min_pixels/max_pixels — a raw value like planned_mw is drawn as value×scale in those units, so choose units+scale that keep sizes readable. Routing is automatic (geometry property → geoMapping; dataset column → style mapping). Use update_layer_style to tweak an EXISTING mapping.",
        "- **update_layer_style(layer_id, style_id, colormap?, scale_type?, domain_min?, domain_max?, column?)**: Fine-tune an EXISTING map layer style mapping (colormap, scale, domain). Available colormaps: viridis, plasma, coolwarm, rdylgn.",
        "- **configure_layer_interaction(source_layer_name, actions)**: Set up cross-layer click interactions. Actions: filter (filter target layer by property), show (show target layer), hide_self (hide clicked layer), fly_to_bounds (zoom to clicked feature). Example: click a state → filter counties, hide states, show counties, zoom in.",
        "- **set_visible_layers(layer_ids)**: Set the COMPLETE visible set — listed layers shown, ALL others hidden. Use this when composing a view for a question: name the layers the answer needs and leftovers from earlier questions vanish by construction. Prefer it over a sequence of set_layer_visibility calls.",
        "- **set_layer_visibility(layer_id, visible)**: Show or hide ONE layer, leaving the rest alone. Use for a single incremental toggle; for composing a whole view use set_visible_layers.",
        "- **filter_layer(layer_id, property, values, enabled?)**: Draw only the features matching a property value — 'sites under construction', 'counties in Texas'. This is the verb for narrowing a layer; set_layer_visibility cannot do it. Use the property names from list_layers' geometry_properties. Handles set-valued properties (a site whose stage is '{Construction,Planned}' matches 'Construction'). Refuses and returns the real values if yours don't exist.",
        "- **update_description(table_name, description?, column_name?, column_description?, is_joinable?, join_target_table?, join_target_column?)**: Persist metadata about tables and columns you discover. This helps future conversations understand the data without re-discovering it.",
        "- **save_memory(name, description, memory_type, content, tags?)**: Save a reusable artifact (chart, query, insight) for future retrieval. Use after creating something the user might want to reuse.",
        "- **search_memory(query, memory_type?, limit?)**: Search your saved artifacts. Check this before creating something new.",
        "- **search_artifacts(query, artifact_types?, limit?)**: Search across all stored work — perspectives, stories, paintings, table descriptions, and memories. Use to find existing work to build upon.",
        "- **list_perspectives(project_id?)**: List all saved perspectives.",
        "- **apply_perspective(perspective_id)**: Load a saved perspective, restoring map view and layer styles.",
        "- **create_perspective(name, description?, project_id?, scenario_id?, overwrite?)**: Create a new perspective capturing the current view. If the name already exists, you MUST ask the user for confirmation before calling with overwrite=true.",
        "- **list_stories(project_id?)**: List all saved stories.",
        "- **apply_story(story_id)**: Start playing a saved story.",
        "- **list_scenarios()**: List all projects and their scenarios.",
        "- **set_scenario(extension, project, scenario)**: Switch the active data context.",
        "- **update_project_description(project_id, description?, scenario_id?, scenario_description?)**: Update descriptions for projects and scenarios.",
        "- **create_hover_chart(layer_name, sql_template, chart_type, x_column, y_column, title_template?, trigger?, color_column?)**: Attach a dynamic chart to a layer that renders when a feature is clicked/hovered. Use {property_name} placeholders in sql_template for feature properties.",
        "- **fit_map_to_bounds(west, south, east, north)**: Move the map to frame a geographic area — the best way to 'zoom into' a state, region, or country. Use your geographic knowledge for the bounds.",
        "- **pan_map(latitude, longitude, zoom?)**: Pan and zoom the map to a center point.",
        "- **zoom_map(delta)**: Zoom in/out by a RELATIVE amount, keeping the current center (delta ~1 = a little closer, -2 = further out). Use for 'zoom in a little' when no specific place is named.",
        "- **set_basemap_detail(visible? | hidden?)**: Declutter the basemap by feature category — roads_major, roads_minor, water, waterways, labels. \"Turn off the city streets\" is hidden=['roads_minor']. Declarative: `visible` names the complete set to keep. Vector basemaps only.",
        "- **set_basemap(basemap)**: Change the base layer — 'dark-matter' (default), 'positron', 'voyager', or 'satellite' (aerial imagery). Use 'satellite' for aerial/photographic context.",
        "- **set_clock_year(year)**: Jump the animation clock to a year (or time index) and pause. Use for 'show 2030'.",
        "- **close_charts()**: Close all open chart panels.",
        "- **arrange_charts(anchor?)**: Re-anchor all chart panels to one dock (right/left/bottom/floating/tray).",
        "",
        "## You are a visualization specialist",
        "Read the user's phrasing for the ENCODINGS it implies, and build all of them. A request naming two attributes is a request for two visual channels — you should not have to be told which goes where:",
        "- A **quantity** (capacity, demand, MW, count, cost) → SIZE. style_layer getPointRadius / getLineWidth with scale_type='linear', units='meters', and a scale that keeps the largest features readable without swallowing the map.",
        "- A **category** (stage, phase, type, fuel, status, owner) → COLOR. style_layer getFillColor with scale_type='categorical'. YOU choose the palette via category_colors: the values are listed under each layer below, so read them and assign colors that reflect how they relate — related categories in nearby hues, contrast reserved for genuinely different ones, and a sensible convention where one exists (e.g. built/operational as settled, planned as tentative). Omitting category_colors falls back to evenly-spaced hues, which spreads related categories arbitrarily.",
        "- A **subset** ('under construction', 'in Texas', 'hyperscale only') → filter_layer, not a colour for the ones you want and grey for the rest.",
        "The attributes of an uploaded layer (sites, plants, assets) are FEATURE PROPERTIES, already listed for every layer under 'Map Layers' below. They are not DuckDB tables and no SQL will find them — reach for query_data / get_table_catalog only when the subject really is a table. If the user names something that matches a layer, style that layer.",
        "So \"data centers by construction phase and capacity\" means: colour by phase AND size by capacity — two style_layer calls, neither optional. \"Sized by planned mw\" alone still deserves a colour encoding if an obvious category exists; a single-channel map wastes the second channel.",
        "A categorical colour is meaningless without a legend, so one is opened for you automatically whenever you set scale_type='categorical' on a colour property — don't describe colours in prose as a substitute, and don't claim an encoding you did not apply.",
        "**Changing a control is not the same as changing the view.** Controls decide what the data SAYS; layer visibility decides what the user SEES. Setting `state` and `sectors` does not put counties on screen if the county layer is hidden and the state layer is drawn — and every layer's current state is marked [VISIBLE NOW] or [hidden] under Map Layers, so check rather than assume. A resolution change (\"counties in Texas\" when states are showing) is always at least two calls: show the finer layer AND hide the coarser one, or they stack and the coarse one wins. Never claim the map shows something you did not make visible.",
        "**Don't narrow what the user didn't narrow.** Energy demand is delivered by several carriers (electricity, natural gas, petroleum, hydrogen, coal, …) across several sectors. \"Industrial demand\" means industry across ALL carriers — not industry-and-electricity. Filtering to one carrier because it is the most familiar silently answers a smaller question and understates the total, which is the kind of error a user cannot see. Only constrain a dimension the user actually named; if a control is already narrowed from an earlier turn and the new question is broader, widen it back.",
        "**Prefer more resolution over less.** When a quantity breaks down along a dimension the user cares about, show the breakdown, not just the total: industrial demand by carrier belongs as a STACKED bar (composition and total in one), not a single bar. And a forecast has a time axis — pair the composition with a line of the total over time so both the mix and the trajectory are visible. Two complementary charts beat one aggregate, provided each answers a different question.",
        "**Clear away what the question isn't about.** A view is defined as much by what is off it as what is on. Decide the full set of layers the answer needs and call set_visible_layers with exactly that — a coarser layer left drawn stacks over the finer one and wins, and a layer from an earlier question (sites, generation, a different geography) is clutter the user must mentally subtract. Close charts that answer a different question too (close_charts, or just don't open more). Leaving the previous topic's layers and charts on screen buries the answer in clutter — the user asked about one thing, so show them that thing. Never hide a layer the user pinned/anchored, and say in one line what you turned off.",
        "**Label units on every custom chart.** A bare number is unreadable: axis titles must carry units (\"Demand (MWh)\", \"Capacity (MW)\", \"Year\"), and if you scale values for legibility, say so in the label (\"Demand (TWh)\") rather than silently changing the magnitude. Units are in the table/column descriptions above — use them. Pre-built extension charts are already labelled; this is about the ones you author.",
        "Then reinforce the map with ONE chart that answers the question the map raises — for a category+quantity map, the totals per category (e.g. total planned MW by construction stage) as a bar chart. The map shows where; the chart shows how much. Prefer a pre-built chart, else create_chart.",
        "Order matters: filter first, then style, then chart — styling a layer you are about to filter wastes a call and flashes an intermediate view at the user.",
        "",
        "## Answering \"show me X\" — compose a view, don't just make a chart",
        "This is a MAP application. When the user asks to *show*, *find*, *look at*, or *explore* something, they are asking you to change what is on screen — not to append one chart to it. A chart alone is the weakest possible answer to \"show me data centers in Texas\".",
        "Work outward from the data they named, doing as many of these as apply, in this order:",
        "1. **Scope the data with controls.** Set the input controls that carry the subject — sector, carrier, state, year — with update_input_control. This is the highest-leverage step: controls drive the map layers AND every open chart at once, so 'data centers' becomes a sector selection, not a bespoke SQL filter. Check the Input Controls Reference below for what exists before writing SQL that duplicates a control.",
        "2. **Put it on the map.** Make the layer that carries the subject visible with set_layer_visibility (list_layers first), and move the camera to the place named with fit_map_to_bounds. A named state/region should always end with the map framed on it.",
        "   When the user describes a SUBSET — 'still under construction', 'in Texas', 'hyperscale only' — showing the whole layer is not the answer. Narrow it with filter_layer on the matching geometry_property, and encode the quantity they named with style_layer (e.g. 'sized by planned mw' → getPointRadius on planned_mw, units='meters', with a scale that keeps dots readable). A request naming both a subset and a measure needs BOTH calls; the layer's geometry_properties in list_layers tell you which columns exist, so you rarely need SQL to find out.",
        "3. **Then add supporting charts.** Prefer open_chart on a pre-built chart; pass entity_id when the place is a state or county.",
        "4. Only write custom SQL when no control, layer, or pre-built chart covers it.",
        "Prefer several coordinated changes over one. If the user names a place AND a topic, the answer should almost always involve a control change, a visible layer, and a camera move — then a chart.",
        "When something the user asked for genuinely isn't in the loaded data, say so plainly and show the closest thing that is, rather than silently substituting it.",
        "Close with one short line naming what you changed, so the user can follow the view.",
        "",
        "## Guidelines",
        "- CRITICAL: You MUST call tools to answer questions. NEVER fabricate, invent, or guess data.",
        "- CRITICAL: create_chart requires a `sql` parameter (a SQL query string). It does NOT accept a `data` parameter. If you already queried data and now need a chart, call create_chart with the same SQL query — it will re-execute it internally.",
        "- CRITICAL — Dynamic SQL with input controls: When an input control has a `sql_column` mapping (shown as `→ SQL column: col` in the Input Controls Reference below), you MUST use a `{control_name}` placeholder in the WHERE clause instead of a literal value. Example: if `forecast_year` maps to sql_column `year`, write `WHERE year = {forecast_year}` — NOT `WHERE year = 2030`. This makes the chart reactive: when the user moves the slider, the placeholder is resolved to the new value and the chart auto-refreshes. NEVER hardcode a value for a control-mapped column. NEVER omit the filter. NEVER aggregate across all values. The only exception is if the user explicitly asks for a specific fixed value (e.g. 'show me year 2025').",
        "- ALWAYS call tools directly using the tool calling API. NEVER write tool calls as JSON text in your response.",
        "- The DuckDB Tables section below is ALREADY in your context — do not call get_table_catalog to re-read it. Call it only to expand a table family the listing collapsed, at most once per pattern, and never repeat a call whose result you already have. If a subject isn't in a table, it doesn't become one on a second look.",
        "- Write clean, efficient SQL. Use WHERE, GROUP BY, JOINs, and aggregates as needed.",
        "- Present numeric results clearly — round to reasonable precision.",
        "- When users ask to visualize, plot, chart, or show data graphically: FIRST call list_charts and, if a pre-configured chart matches what they want, use open_chart — those are already correctly labelled, Plotly, and reactive to the year/control sliders. Only fall back to create_chart (custom SQL) when no pre-configured chart fits. For create_chart pick appropriate chart types: line for time series, bar for comparisons, scatter for correlations, pie for proportions.",
        "- When users ask to change input parameters (sliders, controls), use update_input_control.",
        "- When users ask to change map styling (colors, colormaps, scales), use list_layers first. If the layer already has a style mapping for that visual property, tweak it with update_layer_style; if not (e.g. a newly-uploaded layer with no mappings), create one with style_layer, choosing the column from the layer's geometry_properties. When the column IS a geometry_property (a feature attribute like voltage/planned_mw/stage on an uploaded layer), pass source='geometry' so it becomes an editable geometry mapping — reserve dataset mappings for columns that come from a separately attached dataset/timeseries.",
        "- When users ask to connect layers, set up drill-downs, or create click-to-filter interactions, use list_layers then configure_layer_interaction.",
        "- When users ask to show or hide layers, use set_layer_visibility.",
        "- When users ask to switch projects/scenarios, use list_scenarios then set_scenario.",
        "- When users ask to zoom into or focus on a place (a state, region, or city), use fit_map_to_bounds with that area's bounding box (or pan_map for a single point). For a relative 'zoom in/out a little' with no named place, use zoom_map(delta).",
        "- When users ask for a satellite / aerial / imagery view, use set_basemap('satellite'); use set_basemap to switch back to 'dark-matter' etc. when they want the minimal style again.",
        "- When users ask to load/save perspectives or stories, use the perspective and story tools.",
        "- Before creating new charts or queries, search_memory to check if a similar artifact already exists.",
        "- When you discover interesting metadata about tables/columns (join keys, descriptions), save it with update_description.",
        "- Some layers may be anchored (locked) by the user. If a style or visibility change doesn't take effect, the layer is likely anchored — inform the user.",
        "- When overwriting existing perspectives or stories, you MUST get explicit user confirmation first.",
        "- If the user's request is ambiguous about which data slice, time period, metric, or scope to use, ASK for clarification rather than guessing. Example: if they say 'show me transport energy' but don't specify a sector filter or grouping, ask what breakdown they want.",
        "- Be concise. Answer directly without unnecessary preamble.",
    ])

    # Name the extensions that exist but are switched OFF. Everything about
    # them is filtered out below, so without this line a disabled extension is
    # indistinguishable from one that was never installed — and the assistant
    # answers "there is no grid data" when the truth is "it is disabled".
    if active_extensions is not None:
        try:
            inactive = sorted(
                name for name, _ in registry.items() if name not in set(active_extensions)
            )
            if inactive:
                parts.append(
                    f"\n## Installed but DISABLED extensions: {', '.join(inactive)}"
                )
                parts.append(
                    "Their tables, layers, charts and controls are NOT in this context. "
                    "If the user asks for something one of them provides, enable it with "
                    "set_extension_state(extension, 'enabled') and then re-run list_layers "
                    "— do not report the data as unavailable."
                )
        except Exception:
            logger.debug("Could not list inactive extensions", exc_info=True)

    # Collect input control details across extensions for a consolidated table
    _control_table_rows: list[dict] = []
    # Tables rendered in full (with columns) below, so the DuckDB catalog can
    # skip them instead of repeating name + description a second time.
    _documented_tables: set[str] = set()

    # Add extension AI schemas (filtered by active_extensions if provided)
    for name, ext in registry.items():
        if active_extensions is not None and name not in active_extensions:
            continue
        ai_schema = ext.get_ai_schema()
        if ai_schema:
            parts.append(f"\n## Extension: {name}")
            parts.append(ai_schema.description)
            if ai_schema.tables:
                parts.append("\nTables:")
                for t in ai_schema.tables:
                    _documented_tables.add(t.table_name)
                    parts.append(f"- `{t.table_name}`: {t.description}")
                    parts.append("  Columns:")
                    for c in t.columns:
                        desc = c.get('description', '')
                        parts.append(f"    - `{c['name']}` ({c['type']}){': ' + desc if desc else ''}")
                    if hasattr(t, 'example_queries') and t.example_queries:
                        parts.append("  Example SQL queries:")
                        for q in t.example_queries:
                            parts.append(f"    `{q}`")
            if ai_schema.controls:
                # Get the active project/scenario for this extension
                projects = ext.list_projects() if hasattr(ext, 'list_projects') else []
                proj_name = projects[0].name if projects else "unknown"
                scenarios = ext.list_scenarios(proj_name) if projects and hasattr(ext, 'list_scenarios') else []
                scen_name = scenarios[0].name if scenarios else "unknown"
                # Collect full control details including group and invalidated datasets
                _control_table_rows.append({
                    "extension": name,
                    "project": proj_name,
                    "scenario": scen_name,
                    "controls": ext.get_input_controls(proj_name, scen_name),
                    "ai_controls": {c.control_name: c for c in ai_schema.controls},
                })
            if ai_schema.dataset_descriptions:
                parts.append("\nDataset Descriptions:")
                for dd in ai_schema.dataset_descriptions:
                    parts.append(f"- `{dd.dataset_name}`: {dd.description}")
                    if dd.key_columns:
                        parts.append(f"  Key columns: {', '.join(dd.key_columns)}")
                    for jc in dd.joinable_columns:
                        parts.append(f"  - `{jc['column']}` joins to `{jc['target_table']}`.`{jc['target_column']}`: {jc.get('description', '')}")
            if ai_schema.plotting_hints:
                parts.append("\nPlotting Hints:")
                for h in ai_schema.plotting_hints:
                    parts.append(f"- {h}")
            if ai_schema.example_prompts:
                parts.append("\nExample questions:")
                for p in ai_schema.example_prompts:
                    parts.append(f"- {p}")

    # Render consolidated input controls table
    if _control_table_rows:
        parts.append("\n## Input Controls Reference")
        parts.append("These controls drive the underlying datasets. When the user changes a control, the affected datasets are recomputed and any charts built on them auto-refresh.")
        parts.append("")
        parts.append("Controls marked with `→ SQL:` have a direct column mapping. See the CRITICAL guideline above about using these values in SQL queries.")
        parts.append("")
        for entry in _control_table_rows:
            ext_name = entry["extension"]
            proj = entry["project"]
            scen = entry["scenario"]
            parts.append(f"### {ext_name} (project='{proj}', scenario='{scen}')")
            parts.append(f"  Tool alias: `update_input_control(extension='{ext_name}', project='{proj}', scenario='{scen}', control_name=..., value=...)`")
            parts.append("")
            # Group controls
            grouped: dict[str, list] = {}
            for dc in entry["controls"]:
                group = dc.group or "General"
                grouped.setdefault(group, []).append(dc)
            for group_name, controls in grouped.items():
                parts.append(f"  **{group_name}**")
                for dc in controls:
                    ai_ctrl = entry["ai_controls"].get(dc.name)
                    desc = ai_ctrl.description if ai_ctrl else ""
                    range_str = ""
                    if dc.min is not None and dc.max is not None:
                        range_str = f", range: {dc.min}–{dc.max}"
                        if dc.step:
                            range_str += f", step: {dc.step}"
                    unit_str = f" {dc.unit}" if dc.unit else ""
                    invalidates = ""
                    sql_col = ""
                    # Get invalidated datasets and sql_column from the decorator metadata
                    try:
                        from meridian.extensions.controls import _collect_input_controls
                        ext_obj = registry.get(ext_name)
                        if ext_obj:
                            meta_map = _collect_input_controls(ext_obj)
                            meta = meta_map.get(dc.name)
                            if meta:
                                inv_list = meta[0].get("invalidates", [])
                                if inv_list:
                                    invalidates = f" → invalidates: {', '.join(inv_list)}"
                                col = meta[0].get("sql_column")
                                if col:
                                    sql_col = f" → SQL column: `{col}` — use `WHERE {col} = {{{dc.name}}}` in queries (current: {dc.current_value})"
                    except Exception:
                        pass
                    parts.append(
                        f"  - `{dc.name}` = **{dc.current_value}**{unit_str}"
                        f" ({dc.type.value}{range_str}){invalidates}{sql_col}"
                    )
                    if desc:
                        parts.append(f"    {desc}")
                parts.append("")

    # Build set of active extension schema prefixes for filtering
    _active_prefixes = None
    if active_extensions is not None:
        # Extension tables use schema "ext_{name}" (with hyphens replaced by underscores)
        _active_prefixes = {f"ext_{n.replace('-', '_')}." for n in active_extensions}

    # Add DuckDB table catalog summary. Scoped + collapsed — the catalog grows
    # ~80 tables per loaded scenario, so rendering it flat made it the single
    # largest block in the prompt. See lib/ai/context.py.
    catalog = duckdb_engine.get_table_catalog()
    if catalog:
        parts.extend(render_table_catalog(
            catalog,
            documented=_documented_tables,
            active_prefixes=_active_prefixes,
        ))

    # Add persisted metadata descriptions (AI-discovered and user-provided)
    if db:
        try:
            from models.orm import TableDescription, ColumnDescription
            session = db.get_session()
            try:
                descs = session.query(TableDescription).all()
                needs_review = []
                if descs:
                    parts.append("\n## Persisted Data Descriptions")
                    parts.append("(These were previously discovered or provided — update them with update_description if you find errors.)")
                    for td in descs:
                        if td.description:
                            conf = f" _(AI guess, {td.confidence} confidence)_" if td.source == "ai" and td.confidence else ""
                            parts.append(f"- `{td.table_name}`: {td.description}{conf}")
                        if getattr(td, "needs_review", 0) and td.review_question:
                            needs_review.append((td.table_name, td.review_question))
                        cols = session.query(ColumnDescription).filter(
                            ColumnDescription.table_description_id == td.id,
                        ).all()
                        for cd in cols:
                            join_info = ""
                            if cd.is_joinable and cd.join_target_table:
                                join_info = f" [joinable → {cd.join_target_table}.{cd.join_target_column or '?'}]"
                            if cd.description or join_info:
                                parts.append(f"  - `{cd.column_name}` ({cd.data_type or '?'}): {cd.description or ''}{join_info}")
                if needs_review:
                    parts.append("\n## Data Needing Clarification")
                    parts.append(
                        "These uploaded datasets couldn't be confidently described. "
                        "When relevant (e.g. the user references one, or naturally early "
                        "in the conversation), ask the user the question below ONCE, then "
                        "save their answer with update_description (which clears the flag). "
                        "Do not nag — ask only when it helps answer their request."
                    )
                    for tname, q in needs_review:
                        parts.append(f"- `{tname}`: {q}")
            finally:
                session.close()
        except Exception:
            logger.debug("Could not add persisted descriptions to system prompt", exc_info=True)

    # Add layer summary for AI context
    if db:
        try:
            from models.orm import Layer, LayerStyleMapping
            session = db.get_session()
            try:
                layers = session.query(Layer).all()
                if layers:
                    # Filter layers by active extensions if specified
                    if active_extensions is not None:
                        active_set = set(active_extensions)
                        layers = [l for l in layers if not hasattr(l, 'extension_name') or l.extension_name in active_set]
                    from lib.ai.tools import (
                        _layer_geometry_props,
                        _layer_property_values,
                    )

                    parts.append("\n## Map Layers")
                    parts.append(
                        "Each layer's `properties` are its per-feature attributes. They are "
                        "the columns to pass to style_layer (source='geometry') and "
                        "filter_layer. They live in the layer's geometry, NOT in any "
                        "DuckDB table — do not go looking for them with query_data or "
                        "get_table_catalog. `#` marks a numeric property (suitable for "
                        "size or a continuous colour); the rest are categorical."
                    )
                    for lyr in layers:
                        styles = session.query(LayerStyleMapping).filter(
                            LayerStyleMapping.layer_id == lyr.id,
                        ).all()
                        style_desc = ", ".join(
                            f"{s.visual_property}→{s.column} ({s.colormap or 'default'})"
                            for s in styles
                        ) if styles else "no style mappings"
                        # Whether a layer is CURRENTLY drawn is client state, so
                        # it has to be sent with the request. Without it the
                        # assistant cannot tell a visible layer from a hidden
                        # one, and a drill-down ("counties in Texas") looks like
                        # it needs no visibility change — it reports showing
                        # counties while the state layer is still the one drawn.
                        vis = ""
                        if visible_layer_ids is not None:
                            vis = " **[VISIBLE NOW]**" if lyr.id in set(visible_layer_ids) else " [hidden]"
                        parts.append(
                            f"- layer_id={lyr.id} `{lyr.display_name or lyr.name}` "
                            f"({lyr.deck_layer_type}){vis}: {style_desc}"
                        )
                        try:
                            props = _layer_geometry_props(lyr, session, duckdb_engine)
                        except Exception:
                            props = []
                        if props:
                            rendered = ", ".join(
                                f"`{p['name']}`{'#' if p.get('numeric') else ''}"
                                for p in props[:40]
                            )
                            more = f" (+{len(props) - 40} more)" if len(props) > 40 else ""
                            parts.append(f"    properties: {rendered}{more}")
                            # Distinct values for the low-cardinality
                            # categorical properties. Choosing a palette means
                            # knowing what the categories ARE and how they
                            # relate — with the values in hand that is one
                            # judgement call, not a probe call first.
                            for p in props:
                                if p.get("numeric"):
                                    continue
                                vals = _layer_property_values(
                                    lyr, session, duckdb_engine, p["name"],
                                )
                                if vals and len(vals) <= 25:
                                    parts.append(
                                        f"      `{p['name']}` values: "
                                        + ", ".join(f'"{v}"' for v in vals)
                                    )
            finally:
                session.close()
        except Exception:
            logger.debug("Could not add layer summary to system prompt", exc_info=True)

    # Add join hints for AI context
    if db:
        try:
            from models.orm import JoinHint, Dataset, GeometryFile
            session = db.get_session()
            try:
                hints = session.query(JoinHint).filter(
                    JoinHint.status != "rejected",
                    JoinHint.overlap > 0.5,
                ).all()
                if hints:
                    parts.append("\n## Dataset-Geometry Join Hints")
                    for h in hints:
                        ds = session.query(Dataset).filter(Dataset.id == h.dataset_id).first()
                        geo = session.query(GeometryFile).filter(GeometryFile.id == h.geometry_id).first()
                        if ds and geo:
                            parts.append(f"- `{ds.name}`.{h.dataset_column} → `{geo.name}`.{h.geometry_key} ({h.overlap:.0%} overlap)")
            finally:
                session.close()
        except Exception:
            logger.debug("Could not add join hints to system prompt", exc_info=True)

    # Add artifact counts so AI knows to search before creating
    if db:
        try:
            from models.orm import Perspective, Story, AIMemory
            session = db.get_session()
            try:
                n_persp = session.query(Perspective).count()
                n_stories = session.query(Story).count()
                n_memories = session.query(AIMemory).count()
                if n_persp or n_stories or n_memories:
                    parts.append(f"\n## Available Artifacts: {n_persp} perspectives, {n_stories} stories, {n_memories} AI memories")
                    parts.append("Use search_artifacts or search_memory to find and reuse existing work.")
            finally:
                session.close()
        except Exception:
            logger.debug("Could not add artifact counts to system prompt", exc_info=True)

    # What is on screen RIGHT NOW — distinct from the chapter's saved state.
    parts.extend(render_view_state(
        db, registry,
        visible_layer_ids=visible_layer_ids,
        active_extensions=active_extensions,
    ))

    # Active story + the chapter inside it that is on screen. Placed last so
    # it is the most salient block. See lib/ai/context.py.
    parts.extend(render_story_context(
        db, story_id=active_story_id, perspective_id=active_perspective_id,
    ))

    # User instructions come last so they read as the most recent, most
    # specific guidance. Appended rather than replacing the assembled prompt:
    # the tool contracts, data catalog and live view state above are what make
    # the tools usable at all, so a full override would break the assistant in
    # ways that look like model failure.
    if extra_instructions and extra_instructions.strip():
        parts.append("\n## Additional instructions from the user")
        parts.append(
            "These come from this deployment's settings and take precedence over "
            "the general guidance above where they conflict."
        )
        parts.append(extra_instructions.strip())

    return "\n".join(parts)


async def chat_stream(
    message: str,
    conversation_id: str,
    registry: ExtensionRegistry,
    duckdb_engine: DuckDBEngine,
    images: list[str] | None = None,
    lineage_manager: LineageManager | None = None,
    webgpu_available: bool = False,
    db: Any = None,
    active_extensions: list[str] | None = None,
    active_story_id: int | None = None,
    active_perspective_id: int | None = None,
    visible_layer_ids: list[int] | None = None,
    model_override: str | None = None,
    provider_override: str | None = None,
    think: bool | None = None,
    reasoning_effort: str | None = None,
    extra_instructions: str | None = None,
) -> AsyncIterator[str]:
    """
    Process a chat message and yield SSE-formatted events.

    Args:
        images: Optional list of base64-encoded images to include with the message.
        provider_override: Override the default LLM provider for this message.

    Events:
      data: {"type": "token", "content": "..."}
      data: {"type": "tool_call", "name": "...", "arguments": {...}}
      data: {"type": "tool_result", "name": "...", "result": "..."}
      data: {"type": "error", "message": "..."}
      data: {"type": "done"}
    """
    if is_ai_disabled():
        yield _sse({"type": "error", "message": "AI is disabled (MERIDIAN_DISABLE_AI is set)."})
        yield _sse({"type": "done"})
        return

    llm_config = get_llm_config()
    provider = provider_override or (llm_config or {}).get("provider")
    model = model_override or (llm_config or {}).get("model")

    if not provider or not model:
        yield _sse({"type": "error", "message": "No model selected. Please choose a provider and model from the dropdown."})
        yield _sse({"type": "done"})
        return

    # Always built: besides lineage this now identifies the conversation for
    # per-conversation tool memos (see _exec_catalog), which must work whether
    # or not lineage tracking is enabled.
    chat_ctx = ChatContext(conversation_id=conversation_id, ai_model=model)

    # The client's visibility snapshot is from the START of the turn. Every
    # set_layer_visibility the assistant makes moves it, so the verification
    # block has to track those or it would report a change that landed as
    # missing — worse than no feedback, because it would prompt a redundant
    # retry. Control values need no such care: they are read live from the
    # extensions, which own them.
    live_visible = list(visible_layer_ids) if visible_layer_ids is not None else None

    # Set up cancellation
    cancel_event = asyncio.Event()
    _cancel_events[conversation_id] = cancel_event

    # Build system prompt (rebuilt each message to reflect active extensions / layer changes)
    system_prompt = build_system_prompt(
        registry, duckdb_engine,
        webgpu_available=webgpu_available, db=db,
        active_extensions=active_extensions,
        active_story_id=active_story_id,
        active_perspective_id=active_perspective_id,
        visible_layer_ids=visible_layer_ids,
        extra_instructions=extra_instructions,
    )

    # Get or create conversation
    if conversation_id not in _conversations:
        _conversations[conversation_id] = [
            {"role": "system", "content": system_prompt}
        ]
    else:
        # Update the system prompt in-place so it reflects current active extensions
        _conversations[conversation_id][0] = {"role": "system", "content": system_prompt}

    messages = _conversations[conversation_id]

    # Build user message (with optional images for vision models)
    user_msg: dict = {"role": "user", "content": message}
    if images:
        user_msg["images"] = images
    messages.append(user_msg)

    try:
        for _round in range(MAX_TOOL_ROUNDS):
            if cancel_event.is_set():
                yield _sse({"type": "token", "content": "\n\n*Cancelled.*"})
                break

            try:
                result_msg = await llm_chat(
                    provider, model, messages, TOOL_DEFINITIONS,
                    timeout=LLM_TIMEOUT, cancel_event=cancel_event,
                    think=think, reasoning_effort=reasoning_effort,
                )
                content = result_msg["content"] or ""
                thinking = result_msg.get("thinking") or ""
                tool_calls = result_msg["tool_calls"]
            except asyncio.CancelledError:
                yield _sse({"type": "token", "content": "\n\n*Cancelled.*"})
                break
            except asyncio.TimeoutError:
                yield _sse({"type": "error", "message": f"LLM timed out after {LLM_TIMEOUT}s"})
                break
            except Exception as e:
                logger.exception("LLM call failed")
                yield _sse({"type": "error", "message": str(e)})
                break

            # Send thinking content (if the model produced it)
            if thinking:
                yield _sse({"type": "thinking", "content": thinking})

            # Send the text content
            if content:
                yield _sse({"type": "token", "content": content})

            # If no tool calls, we're done
            if not tool_calls:
                if content:
                    messages.append({"role": "assistant", "content": content})
                break

            # Build assistant message with tool calls for conversation history
            assistant_msg: dict = {"role": "assistant", "content": content or None}
            assistant_msg["tool_calls"] = [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {
                        "name": tc["name"],
                        "arguments": tc["arguments"],
                    },
                }
                for tc in tool_calls
            ]
            messages.append(assistant_msg)

            # Execute each tool call
            for tc in tool_calls:
                if cancel_event.is_set():
                    break

                name = tc["name"]
                try:
                    args = json.loads(tc["arguments"]) if tc["arguments"] else {}
                except json.JSONDecodeError:
                    args = {}

                yield _sse({"type": "tool_call", "name": name, "arguments": args})

                result = execute_tool(
                    name, args, duckdb_engine, registry,
                    lineage_manager=lineage_manager, chat_context=chat_ctx,
                    db=db,
                )
                yield _sse({"type": "tool_result", "name": name, "result": result})

                if live_visible is not None and to_canonical(name) == "set_layer_visibility":
                    try:
                        parsed = json.loads(result)
                        lid = parsed.get("layer_id")
                        if parsed.get("__layer_visibility__") and lid is not None:
                            if parsed.get("visible"):
                                if lid not in live_visible:
                                    live_visible.append(lid)
                            elif lid in live_visible:
                                live_visible.remove(lid)
                    except (ValueError, AttributeError):
                        pass

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                })

            # Feed the view back after any round that changed it. Without this
            # the assistant has no way to tell a change that landed from one it
            # only intended — the recurring failure has been confident
            # narration ("the map now shows Texas counties") over a screen that
            # never changed, because nothing ever contradicted it.
            if any(to_canonical(tc["name"]) in VIEW_MUTATING_TOOLS for tc in tool_calls):
                after = render_view_state(
                    db, registry,
                    visible_layer_ids=live_visible,
                    active_extensions=active_extensions,
                    heading="## Verification — the view after your changes",
                )
                if after:
                    messages.append({"role": "system", "content": "\n".join(after) + (
                        "\n\nCheck this against what the user asked for. If something you "
                        "meant to change is not reflected here, make the call you missed "
                        "instead of describing the intended result. Only describe what this "
                        "block confirms."
                    )})
        else:
            # for-else: every round was used and the model still wanted more.
            # Silence here is what made this confusing — the user saw a partly
            # built view and a confident summary, with nothing saying the loop
            # had been cut short.
            logger.warning(
                "Tool-round limit (%d) hit for conversation %s",
                MAX_TOOL_ROUNDS, conversation_id,
            )
            yield _sse({"type": "token", "content": (
                f"\n\n*Stopped after {MAX_TOOL_ROUNDS} tool rounds — the view may be "
                f"incomplete. Ask me to continue if something is missing.*"
            )})

    finally:
        _cancel_events.pop(conversation_id, None)

    # Trim conversation if it gets too long (keep system + last 40 messages)
    if len(messages) > 42:
        _conversations[conversation_id] = [messages[0]] + messages[-40:]

    yield _sse({"type": "done"})


def cancel_chat(conversation_id: str) -> bool:
    """Signal a running chat to stop. Returns True if there was an active chat."""
    event = _cancel_events.get(conversation_id)
    if event:
        event.set()
        return True
    return False


def clear_conversation(conversation_id: str) -> None:
    cancel_chat(conversation_id)
    _conversations.pop(conversation_id, None)
    # The catalog memo assumes "you already have this in context"; once the
    # history is gone that is no longer true, so it must go too.
    from .tools import reset_catalog_cache

    reset_catalog_cache(conversation_id)


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, default=str)}\n\n"
