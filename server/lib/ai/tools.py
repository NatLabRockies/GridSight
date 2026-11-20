"""
Tool definitions and execution for the AI chat system.
"""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from lib.extensions.duckdb_engine import DuckDBEngine
    from lib.extensions.registry import ExtensionRegistry
    from lib.lineage.manager import LineageManager

logger = logging.getLogger(__name__)


@dataclass
class ChatContext:
    """Metadata about the current chat session, threaded into tool execution."""
    conversation_id: str
    ai_model: str
    user_id: int | None = None

# -- OpenAI-format tool definitions (consumed by ollama_client) --

from lib.ai.tool_catalog import TOOL_DEFINITIONS, to_canonical  # noqa: F401  (re-exported)


def execute_tool(
    tool_name: str,
    arguments: dict[str, Any],
    duckdb_engine: DuckDBEngine,
    registry: ExtensionRegistry,
    lineage_manager: LineageManager | None = None,
    chat_context: ChatContext | None = None,
    db: Any | None = None,
) -> str:
    """Execute a tool call and return the result as a string."""
    # Accept legacy tool names (pre-canonicalization) by resolving to canonical.
    tool_name = to_canonical(tool_name)
    try:
        if tool_name == "query_data":
            return _exec_query(
                arguments["sql"], duckdb_engine,
                lineage_manager=lineage_manager, chat_context=chat_context,
            )
        elif tool_name == "get_table_catalog":
            return _exec_catalog(duckdb_engine, arguments, chat_context)
        elif tool_name == "get_lineage":
            return _exec_get_lineage(arguments, lineage_manager)
        elif tool_name == "create_chart":
            return _exec_create_chart(
                arguments, duckdb_engine, registry,
                lineage_manager=lineage_manager, chat_context=chat_context,
            )
        elif tool_name == "update_control":
            return _exec_update_control(
                arguments, registry,
                lineage_manager=lineage_manager, chat_context=chat_context,
            )
        elif tool_name == "list_extensions":
            return _exec_list_extensions(registry, db)
        elif tool_name == "set_extension_state":
            return _exec_set_extension_state(arguments, registry, db)
        elif tool_name == "set_input_controls":
            return _exec_set_input_controls(
                arguments, registry,
                lineage_manager=lineage_manager, chat_context=chat_context,
            )
        elif tool_name == "update_input_control":
            return _exec_update_input_control(
                arguments, registry,
                lineage_manager=lineage_manager, chat_context=chat_context,
            )
        elif tool_name == "list_layers":
            return _exec_list_layers(db, duckdb_engine)
        elif tool_name == "update_layer_style":
            return _exec_update_layer_style(arguments, db)
        elif tool_name == "style_layer":
            return _exec_style_layer(arguments, db, duckdb_engine)
        elif tool_name == "configure_layer_interaction":
            return _exec_configure_layer_interaction(arguments, db)
        elif tool_name == "set_layer_visibility":
            return _exec_toggle_layer_visibility(arguments, db)
        elif tool_name == "filter_layer":
            return _exec_filter_layer(arguments, db)
        elif tool_name == "set_visible_layers":
            return _exec_set_visible_layers(arguments, db)
        elif tool_name == "update_description":
            return _exec_update_description(arguments, db)
        elif tool_name == "save_memory":
            return _exec_save_memory(arguments, db)
        elif tool_name == "search_memory":
            return _exec_search_memory(arguments, db)
        elif tool_name == "search_artifacts":
            return _exec_search_artifacts(arguments, db)
        elif tool_name == "list_perspectives":
            return _exec_list_perspectives(arguments, db)
        elif tool_name == "apply_perspective":
            return _exec_apply_perspective(arguments, db)
        elif tool_name == "create_perspective":
            return _exec_create_perspective(arguments, db)
        elif tool_name == "list_stories":
            return _exec_list_stories(arguments, db)
        elif tool_name == "apply_story":
            return _exec_apply_story(arguments, db)
        elif tool_name == "list_scenarios":
            return _exec_list_projects_and_scenarios(db)
        elif tool_name == "set_scenario":
            return _exec_switch_project_scenario(arguments, db)
        elif tool_name == "update_project_description":
            return _exec_update_project_description(arguments, db)
        elif tool_name == "create_hover_chart":
            return _exec_create_hover_chart(arguments, db)
        elif tool_name == "set_category_colors":
            return _exec_set_category_colors(arguments)
        elif tool_name == "set_style_preference":
            return _exec_set_style_preference(arguments, db)
        elif tool_name == "fit_map_to_bounds":
            return _exec_fit_map_to_bounds(arguments)
        elif tool_name == "pan_map":
            return _exec_pan_map(arguments)
        elif tool_name == "set_basemap_detail":
            return _exec_set_basemap_detail(arguments)
        elif tool_name == "set_basemap":
            return _exec_set_basemap(arguments)
        elif tool_name == "zoom_map":
            return _exec_zoom_map(arguments)
        elif tool_name == "set_clock_year":
            return _exec_set_clock_year(arguments)
        elif tool_name == "close_charts":
            return _exec_close_charts(arguments)
        elif tool_name == "arrange_charts":
            return _exec_arrange_charts(arguments)
        elif tool_name == "list_charts":
            return _exec_list_charts(registry)
        elif tool_name == "open_chart":
            return _exec_open_chart(arguments, registry, duckdb_engine)
        else:
            return json.dumps({"error": f"Unknown tool: {tool_name}"})
    except Exception as e:
        logger.exception("Tool execution failed: %s", tool_name)
        return json.dumps({"error": str(e)})


def _exec_query(
    sql: str,
    engine: DuckDBEngine,
    *,
    lineage_manager: LineageManager | None = None,
    chat_context: ChatContext | None = None,
) -> str:
    sql_lower = sql.strip().lower()
    if not sql_lower.startswith("select") and not sql_lower.startswith("with"):
        return json.dumps({"error": "Only SELECT/WITH queries are allowed"})
    rows = engine.query_json(sql)

    # Record lineage for AI-generated queries
    if lineage_manager and chat_context:
        _record_query_lineage(
            sql, len(rows), lineage_manager, chat_context,
        )

    # Cap output size to avoid overwhelming the LLM context
    result = json.dumps(rows[:200], default=str)
    if len(rows) > 200:
        result += f"\n... ({len(rows)} total rows, showing first 200)"
    return result


# (conversation_id, pattern) → already-returned catalog result. The catalog is
# static for the life of a conversation, so a repeat call can only return what
# the model already has in context. Prompt instructions did not stop the
# repeats — one trace read it five times in a single turn, burning rounds that
# the actual work needed — so the second call answers from here and says so.
_CATALOG_SEEN: dict[tuple[str, str], str] = {}


def reset_catalog_cache(conversation_id: str) -> None:
    """Drop a conversation's catalog memo (called when its history is cleared)."""
    for key in [k for k in _CATALOG_SEEN if k[0] == conversation_id]:
        _CATALOG_SEEN.pop(key, None)


def _exec_catalog(
    engine: DuckDBEngine,
    args: dict | None = None,
    chat_context: ChatContext | None = None,
) -> str:
    """List DuckDB tables, optionally filtered by a substring `pattern`.

    The system prompt collapses large same-shaped table families into a single
    line naming their pattern; `pattern` is how the agent expands one of those
    back to full detail without pulling the entire catalog into context.

    Repeats within one conversation are answered from a memo, so re-reading
    costs a round but not a second copy of the catalog in context.
    """
    pattern = ((args or {}).get("pattern") or "").strip()
    conv = getattr(chat_context, "conversation_id", None)
    cache_key = (conv, pattern.lower()) if conv else None
    if cache_key and cache_key in _CATALOG_SEEN:
        logger.info("[get_table_catalog] repeat call (pattern=%r) served from memo", pattern)
        return json.dumps({
            "note": (
                "You already called get_table_catalog with this pattern in this "
                "conversation — the result is unchanged and already in your context. "
                "Scroll back to it rather than calling again; if what you need is not "
                "there, it is not in a table."
            ),
            "pattern": pattern or None,
        })
    catalog = engine.get_table_catalog()
    tables = []
    for t in catalog:
        if pattern and pattern.lower() not in t.table_name.lower():
            continue
        tables.append({
            "table_name": t.table_name,
            "description": t.description,
            "columns": t.columns,
        })
    if pattern and not tables:
        # A miss is memoised too — re-asking for a pattern that matched nothing
        # is the most common repeat, and the answer will not change.
        if cache_key:
            _CATALOG_SEEN[cache_key] = "miss"
        return json.dumps({
            "pattern": pattern,
            "matches": 0,
            "hint": "No table names contain that substring. Call get_table_catalog() with no pattern to see what exists.",
        })
    if cache_key:
        _CATALOG_SEEN[cache_key] = "hit"
    return json.dumps(tables, default=str)


def _exec_get_lineage(
    args: dict,
    lineage_manager: LineageManager | None,
) -> str:
    """Read-only lineage access for AI agents."""
    if not lineage_manager:
        return json.dumps({"error": "Lineage tracking is not enabled"})

    node_id = args.get("node_id")
    node_type = args.get("node_type")

    if node_id:
        # Get ancestor DAG for a specific node
        dag = lineage_manager.get_dag_for_node(node_id)
        return json.dumps({"nodes": dag.nodes, "edges": dag.edges}, default=str)

    # Search/list nodes — search_nodes returns serialized dicts
    nodes = lineage_manager.search_nodes(node_type=node_type, limit=50)
    # Keep it concise for the LLM
    result = []
    for n in nodes:
        result.append({
            "id": n.get("id"),
            "type": n.get("node_type"),
            "label": n.get("label"),
            "creator": n.get("creator_type"),
            "ai_model": n.get("ai_model"),
            "review_status": n.get("review_status"),
            "extension": n.get("extension_name"),
        })
    return json.dumps(result, default=str)


def _resolve_column(requested: str, actual_cols: list[str]) -> str:
    """Resolve a requested column name against actual query result columns.

    Handles cases where the model specifies 'peak_demand_mw' but the query
    returns 'any_value(peak_demand_mw)' or 'sum(peak_demand_mw)' etc.
    """
    if not requested or requested in actual_cols:
        return requested
    req_lower = requested.lower()
    # Try case-insensitive exact match
    for col in actual_cols:
        if col.lower() == req_lower:
            return col
    # Try matching inside aggregate function: func(col_name) → col_name
    for col in actual_cols:
        col_lower = col.lower()
        # Match patterns like "any_value(peak_demand_mw)" or "sum(x)"
        if '(' in col_lower and req_lower in col_lower:
            return col
    # Try substring match (e.g. alias "total_gwh" matching "sum(annual_energy_gwh) as total_gwh")
    for col in actual_cols:
        if req_lower in col.lower():
            return col
    return requested  # give up, use as-is


def _chart_type_to_vl_mark(chart_type: str) -> dict:
    """Map chart_type string to Vega-Lite mark spec."""
    mapping = {
        "bar": {"type": "bar", "cornerRadiusTopLeft": 3, "cornerRadiusTopRight": 3},
        "line": {"type": "line", "point": True},
        "scatter": {"type": "point"},
        "pie": {"type": "arc"},
        "stacked_bar": {"type": "bar"},
        "stacked_area": {"type": "area"},
    }
    return mapping.get(chart_type, {"type": "bar"})


def _infer_vl_type(rows: list[dict], col: str) -> str:
    """Infer Vega-Lite data type from column values."""
    if not rows:
        return "nominal"
    sample = rows[0].get(col)
    if isinstance(sample, (int, float)):
        return "quantitative"
    # Check if it looks like a year or date
    if isinstance(sample, str):
        try:
            int(sample)
            return "ordinal"
        except (ValueError, TypeError):
            pass
    return "nominal"


def _exec_create_chart(
    args: dict,
    engine: DuckDBEngine,
    registry: ExtensionRegistry | None = None,
    *,
    lineage_manager: LineageManager | None = None,
    chat_context: ChatContext | None = None,
) -> str:
    """Execute SQL and build a chart spec (Plotly or Vega-Lite) returned as JSON."""
    sql = args.get("sql", "")
    if not sql:
        return json.dumps({
            "error": "Missing required 'sql' parameter. create_chart requires a SQL query string, not raw data. "
            "Pass a SELECT query like: sql=\"SELECT county_name, peak_demand_mw FROM ...\"",
        })
    # Keep the original SQL as the template (may contain {control_name} placeholders)
    sql_template = sql.strip()
    sql_lower = sql_template.lower()
    if not sql_lower.startswith("select") and not sql_lower.startswith("with"):
        return json.dumps({"error": "Only SELECT/WITH queries are allowed"})

    # Discover which input controls drive the datasets referenced in this chart
    table_refs = extract_table_refs(sql_template)
    input_controls = _get_controls_for_tables(table_refs, registry)

    # Resolve {control_name} placeholders for initial execution
    resolved_sql = sql_template
    if input_controls:
        for ctrl in input_controls:
            placeholder = "{" + ctrl["name"] + "}"
            if placeholder in resolved_sql:
                resolved_sql = resolved_sql.replace(placeholder, str(ctrl["current_value"]))

    try:
        rows = engine.query_json(resolved_sql)
    except Exception as e:
        # A bad column or typo used to escape as an unhandled exception, so the
        # HTTP route returned a bare 500 and the caller got nothing to act on.
        # DuckDB's message names the offending column and its candidates —
        # exactly what is needed to fix the query — so pass it back.
        logger.info("[create_chart] SQL failed: %s", e)
        return json.dumps({
            "error": f"SQL failed: {e}",
            "sql": resolved_sql,
            "hint": "Check the column names against get_table_catalog(pattern=…) for this table.",
        })
    if not rows:
        return json.dumps({"error": "Query returned no rows"})

    # Record lineage
    if lineage_manager and chat_context:
        _record_query_lineage(resolved_sql, len(rows), lineage_manager, chat_context)

    chart_type = args.get("chart_type", "bar")
    x_col = args.get("x_column", "")
    y_col = args.get("y_column", "")
    title = args.get("title", "")
    color_col = args.get("color_column")
    # Always Plotly: the vega-lite path embedded a static data snapshot that
    # couldn't re-execute on slider changes (a "chart with no SQL"). Plotly
    # charts re-run their template SQL and stay reactive.

    # Resolve column names — handle aggregate aliases like "any_value(peak_demand_mw)"
    actual_cols = list(rows[0].keys()) if rows else []
    x_col = _resolve_column(x_col, actual_cols)
    y_col = _resolve_column(y_col, actual_cols)
    if color_col:
        color_col = _resolve_column(color_col, actual_cols)

    # Titles carry placeholders too. Only the SQL was ever resolved, so a
    # chart titled "Demand by Sector ({forecast_year})" displayed that
    # literally — and kept displaying it after the slider moved, because the
    # refresh path rebuilds the spec from this same raw string. Keep the
    # template for re-resolution and render the resolved text.
    title_template = title
    if input_controls:
        for ctrl in input_controls:
            ph = "{" + ctrl["name"] + "}"
            if ph in title:
                title = title.replace(ph, str(ctrl["current_value"]))

    # Include reactive metadata so the frontend can re-execute on data changes
    # Store the TEMPLATE sql (with placeholders), not the resolved version
    reactive = {
        "sql": sql_template,
        "datasets": table_refs,
        "chart_type": chart_type,
        "x_column": x_col,
        "y_column": y_col,
        "title": title,
        "title_template": title_template,
        "color_column": color_col,
    }

    if input_controls:
        reactive["input_controls"] = input_controls

    # Default: build Plotly spec
    return _build_plotly_chart(rows, chart_type, x_col, y_col, title, color_col, reactive)


def _build_vegalite_chart(
    rows: list[dict],
    chart_type: str,
    x_col: str,
    y_col: str,
    title: str,
    color_col: str | None,
    reactive: dict,
) -> str:
    """Build a Vega-Lite spec from query rows."""
    is_stacked_vl = chart_type in ("stacked_bar", "stacked_area")
    encoding: dict[str, Any] = {
        "x": {"field": x_col, "type": _infer_vl_type(rows, x_col)},
        "y": {"field": y_col, "type": "quantitative"},
    }
    if is_stacked_vl:
        encoding["y"]["stack"] = "zero"

    if chart_type == "pie":
        encoding = {
            "theta": {"field": y_col, "type": "quantitative"},
            "color": {"field": x_col, "type": "nominal"},
        }
    elif color_col:
        encoding["color"] = {"field": color_col, "type": "nominal"}

    vl_spec: dict[str, Any] = {
        "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
        "data": {"values": rows[:500]},
        "mark": _chart_type_to_vl_mark(chart_type),
        "encoding": encoding,
        "width": 460,
        "height": 320,
    }

    if title:
        vl_spec["title"] = title

    return json.dumps({
        "__chart__": True,
        "format": "vega-lite",
        "spec": vl_spec,
        "reactive": reactive,
    }, default=str)


def _build_plotly_chart(
    rows: list[dict],
    chart_type: str,
    x_col: str,
    y_col: str,
    title: str,
    color_col: str | None,
    reactive: dict,
) -> str:
    """Build a Plotly spec from query rows."""
    is_stacked = chart_type in ("stacked_bar", "stacked_area")
    base_type = {"stacked_bar": "bar", "stacked_area": "line"}.get(chart_type, chart_type)

    traces: list[dict[str, Any]] = []
    if color_col:
        groups: dict[str, tuple[list, list]] = {}
        for row in rows:
            key = str(row.get(color_col, ""))
            if key not in groups:
                groups[key] = ([], [])
            groups[key][0].append(row.get(x_col))
            groups[key][1].append(row.get(y_col))
        for group_name, (xs, ys) in groups.items():
            trace: dict[str, Any] = {"name": group_name, "x": xs, "y": ys}
            if base_type == "bar":
                trace["type"] = "bar"
            elif base_type == "line":
                trace["type"] = "scatter"
                trace["mode"] = "lines"
                if is_stacked:
                    trace["stackgroup"] = "one"
                    trace["groupnorm"] = ""
                else:
                    trace["mode"] = "lines+markers"
            elif base_type == "scatter":
                trace["type"] = "scatter"
                trace["mode"] = "markers"
            elif base_type == "pie":
                trace = {"type": "pie", "labels": xs, "values": ys, "name": group_name}
            traces.append(trace)
    else:
        xs = [row.get(x_col) for row in rows]
        ys = [row.get(y_col) for row in rows]
        if base_type == "bar":
            traces.append({"type": "bar", "x": xs, "y": ys})
        elif base_type == "line":
            trace: dict[str, Any] = {"type": "scatter", "x": xs, "y": ys}
            if is_stacked:
                trace["mode"] = "lines"
                trace["stackgroup"] = "one"
            else:
                trace["mode"] = "lines+markers"
            traces.append(trace)
        elif base_type == "scatter":
            traces.append({"type": "scatter", "mode": "markers", "x": xs, "y": ys})
        elif base_type == "pie":
            traces.append({"type": "pie", "labels": xs, "values": ys})

    # No plotly title — the chart frame's header renders spec.title, so setting
    # it here showed it twice and the clipped copy was the plotly one. The
    # title still travels in `reactive` for the header (and stays reactive to
    # its {control} placeholders); this just stops drawing it inside the plot.
    layout: dict[str, Any] = {
        "xaxis": {"title": {"text": x_col}, "automargin": True, "tickangle": -45},
        "yaxis": {"title": {"text": y_col}, "automargin": True},
        "template": "plotly_dark",
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": "rgba(30,30,30,0.8)",
        "margin": {"l": 60, "r": 20, "t": 20, "b": 100},
        # No width/height. Baking a figure size in pinned the plot: the frame
        # resized around it and the chart stayed 500×380, because an explicit
        # layout.width/height beats Plotly's responsive sizing. Extension
        # charts never set these, which is why only the generated ones were
        # stuck. The renderer sets a size when it genuinely needs one.
    }
    if chart_type == "stacked_bar":
        layout["barmode"] = "stack"

    spec = {"data": traces, "layout": layout}
    return json.dumps({"__chart__": True, "format": "plotly", "plotly": spec, "reactive": reactive}, default=str)


def _exec_update_control(
    args: dict,
    registry: ExtensionRegistry,
    *,
    lineage_manager: LineageManager | None = None,
    chat_context: ChatContext | None = None,
) -> str:
    from dataclasses import asdict

    ext = registry.get(args["extension"])
    if not ext:
        return json.dumps({"error": f"Extension not found: {args['extension']}"})
    result = ext.set_control_value(
        args["project"], args["scenario"], args["entity_id"],
        args["control_name"], args["value"],
    )

    # Record lineage for AI-driven control updates
    if lineage_manager and chat_context:
        from lib.lineage.manager import TransformKind, CreatorType
        lineage_manager.record_transform(
            kind=TransformKind.DATA_CONTROL,
            content={
                "control_name": args["control_name"],
                "new_value": args["value"],
                "entity_id": args["entity_id"],
                "extension_name": args["extension"],
                "invalidated_datasets": result.invalidated_datasets if result else [],
            },
            creator_type=CreatorType.AI,
            ai_model=chat_context.ai_model,
            ai_conversation_id=chat_context.conversation_id,
            extension_name=args["extension"],
            label=f"AI control: {args['control_name']} = {args['value']}",
        )

    return json.dumps(asdict(result), default=str)


def _extension_prefs(db: Any) -> dict:
    """{extension_name: state} from the user's saved preferences."""
    from models.orm import UserExtensionPref

    session = db.get_session()
    try:
        return {p.extension_name: p.state for p in session.query(UserExtensionPref).all()}
    finally:
        session.close()


def _exec_list_extensions(registry: ExtensionRegistry, db: Any | None) -> str:
    """Every INSTALLED extension and whether it is currently enabled.

    A disabled extension is filtered out of the assistant's context entirely —
    its tables, charts and controls simply are not there — so without this it
    cannot tell "this data does not exist" from "this data is switched off",
    and answers the first when the truth is the second.
    """
    if registry is None:
        return json.dumps({"error": "Extension registry not available"})
    prefs = _extension_prefs(db) if db else {}
    out = []
    for name, ext in registry.items():
        state = prefs.get(name, "enabled")
        entry = {"extension": name, "state": state}
        try:
            m = ext.get_manifest()
            entry["display_name"] = getattr(m, "display_name", None) or name
            entry["description"] = getattr(m, "description", None)
        except Exception:
            pass
        out.append(entry)
    return json.dumps({
        "extensions": out,
        "note": (
            "Data, charts and controls from a disabled extension are absent from your "
            "context. Enable it with set_extension_state before trying to use it."
        ),
    }, default=str)


def _exec_set_extension_state(args: dict, registry: ExtensionRegistry, db: Any | None) -> str:
    """Enable or disable an extension for the current user."""
    if not db:
        return json.dumps({"error": "Database not available"})
    from models.orm import UserExtensionPref

    name = args.get("extension")
    state = (args.get("state") or "enabled").strip().lower()
    if state not in ("enabled", "disabled", "hidden"):
        return json.dumps({"error": "state must be 'enabled', 'disabled' or 'hidden'"})
    installed = {n for n, _ in registry.items()} if registry else set()
    if name not in installed:
        return json.dumps({
            "error": f"No extension named {name!r} is installed. Nothing was changed.",
            "installed": sorted(installed),
        })

    session = db.get_session()
    try:
        # Same helper the HTTP route uses, so tool and UI agree on whose prefs.
        from routes.extensions import _get_or_create_default_user

        user_id = _get_or_create_default_user(session)
        pref = session.query(UserExtensionPref).filter(
            UserExtensionPref.user_id == user_id,
            UserExtensionPref.extension_name == name,
        ).first()
        if pref:
            pref.state = state
        else:
            session.add(UserExtensionPref(
                user_id=user_id, extension_name=name, state=state,
            ))
        session.commit()
        db.save_to_disk()
    except Exception as e:
        session.rollback()
        return json.dumps({"error": f"Could not set extension state: {e}"})
    finally:
        session.close()

    # The app filters layers and context by extension state at load time, so a
    # preference change is inert until it re-reads both.
    _inject_bus("mcp", {"type": "extensions-changed", "extension": name, "state": state})
    logger.info("[set_extension_state] %s -> %s", name, state)
    return json.dumps({
        "message": f"Extension '{name}' is now {state}.",
        "extension": name,
        "state": state,
        "note": (
            "Its layers and data are being (re)loaded. Call list_layers again before "
            "referring to them — the ids you saw earlier may not include them yet."
            if state == "enabled" else
            "Its layers and data have been removed from the view."
        ),
    })


def _exec_set_input_controls(
    args: dict,
    registry: ExtensionRegistry,
    *,
    lineage_manager: LineageManager | None = None,
    chat_context: ChatContext | None = None,
) -> str:
    """Set several input controls in ONE call.

    Controls are interdependent: sectors chosen but carriers left empty is a
    state that renders blank everywhere downstream, and setting them one per
    round makes that half-applied state both reachable and easy to stop at.
    Validating the whole set first means either the intended configuration
    lands or nothing does — there is no partially-applied middle to reason
    about, and the dataset invalidation cascade runs once instead of N times.

    Controls not named are left alone.
    """
    ext_name = args.get("extension")
    ext = registry.get(ext_name) if ext_name else None
    if not ext:
        return json.dumps({"error": f"Extension not found: {ext_name}"})
    values = args.get("values")
    if not isinstance(values, dict) or not values:
        return json.dumps({"error": "values must be a non-empty object of {control_name: value}"})

    project = args.get("project")
    scenario = args.get("scenario")
    if not (project and scenario):
        try:
            projects = ext.list_projects() if hasattr(ext, "list_projects") else []
            project = project or (projects[0].name if projects else None)
            scens = ext.list_scenarios(project) if project else []
            scenario = scenario or (scens[0].name if scens else None)
        except Exception:
            pass
    if not (project and scenario):
        return json.dumps({"error": "project and scenario are required and could not be inferred"})

    # Validate every name before applying any of them.
    try:
        known = {dc.name for dc in ext.get_input_controls(project, scenario)}
    except Exception as e:
        return json.dumps({"error": f"Could not read controls for {ext_name}: {e}"})
    unknown = sorted(set(values) - known)
    if unknown:
        return json.dumps({
            "error": f"No such control(s) on {ext_name}: {unknown}. Nothing was changed.",
            "available_controls": sorted(known),
        })

    applied, invalidated, failed = {}, [], {}
    for name, value in values.items():
        try:
            res = ext.set_input_control_value(project, scenario, name, value)
            applied[name] = getattr(res, "new_value", value) if res else value
            invalidated.extend(getattr(res, "invalidated_datasets", None) or [])
            _inject_bus("controls:effects", {
                "type": "control-set", "extName": ext_name, "project": project,
                "scenario": scenario, "controlName": name, "value": applied[name],
            })
        except Exception as e:
            failed[name] = str(e)

    if lineage_manager and chat_context and applied:
        try:
            from lib.lineage.manager import CreatorType, TransformKind
            lineage_manager.record_transform(
                kind=TransformKind.INPUT_CONTROL,
                content={"values": applied, "extension_name": ext_name,
                         "project": project, "scenario": scenario,
                         "invalidated_datasets": sorted(set(invalidated))},
                creator_type=CreatorType.AI,
                ai_model=chat_context.ai_model,
                ai_conversation_id=chat_context.conversation_id,
                extension_name=ext_name,
                label=f"AI input controls: {', '.join(f'{k}={v}' for k, v in applied.items())}",
            )
        except Exception:
            logger.debug("lineage record failed for set_input_controls", exc_info=True)

    # Read the state back and report anything degenerate. Applying a control
    # is not the same as getting the state you asked for: a value can be
    # coerced to something the extension considers valid, and a selection can
    # end up empty — which silently blanks every layer and chart downstream.
    # Reporting it here is what lets the assistant fix it in the same turn
    # instead of narrating a view that renders nothing.
    from lib.ai.context import is_empty_selection

    errors: list[str] = []
    warnings: list[str] = []
    try:
        for dc in ext.get_input_controls(project, scenario):
            current = dc.current_value
            if is_empty_selection(current):
                line = (
                    f"EMPTY SELECTION: '{dc.name}' is {current!r} — it matches nothing, so "
                    f"every layer and chart filtered by it renders blank."
                )
                (errors if dc.name in values else warnings).append(line)
            elif dc.name in values and str(current) != str(values[dc.name]):
                warnings.append(
                    f"COERCED: '{dc.name}' was requested as {values[dc.name]!r} but the "
                    f"extension resolved it to {current!r}."
                )
    except Exception:
        logger.debug("could not read back controls for %s", ext_name, exc_info=True)

    out = {
        # Same marker the single-control tool uses, so the frontend refresh
        # path treats a batch exactly like one change.
        "__input_control__": True,
        "extension": ext_name,
        "applied": applied,
        "invalidated_datasets": sorted(set(invalidated)),
        "message": "Set " + ", ".join(f"{k}={v}" for k, v in applied.items()) + ".",
    }
    if failed:
        out["failed"] = failed
        out["message"] += f" FAILED: {failed}"
    if errors:
        out["errors"] = errors
        out["message"] += (
            " — one or more controls you set select nothing; widen them before "
            "describing the result."
        )
    if warnings:
        out["warnings"] = warnings
    return json.dumps(out, default=str)


def _exec_update_input_control(
    args: dict,
    registry: ExtensionRegistry,
    *,
    lineage_manager: LineageManager | None = None,
    chat_context: ChatContext | None = None,
) -> str:
    """Update a project-level input control (slider, dropdown, etc.)."""
    from dataclasses import asdict

    ext = registry.get(args["extension"])
    if not ext:
        return json.dumps({"error": f"Extension not found: {args['extension']}"})
    result = ext.set_input_control_value(
        args["project"], args["scenario"],
        args["control_name"], args["value"],
    )

    # Record lineage for AI-driven input control updates
    if lineage_manager and chat_context:
        from lib.lineage.manager import TransformKind, CreatorType
        lineage_manager.record_transform(
            kind=TransformKind.INPUT_CONTROL,
            content={
                "control_name": args["control_name"],
                "new_value": args["value"],
                "extension_name": args["extension"],
                "project": args["project"],
                "scenario": args["scenario"],
                "invalidated_datasets": result.invalidated_datasets if result else [],
            },
            creator_type=CreatorType.AI,
            ai_model=chat_context.ai_model,
            ai_conversation_id=chat_context.conversation_id,
            extension_name=args["extension"],
            label=f"AI input control: {args['control_name']} = {args['value']}",
        )

    result_dict = asdict(result) if result else {"success": True, "new_value": args["value"], "invalidated_datasets": []}
    result_dict["__input_control__"] = True
    result_dict["extension"] = args["extension"]
    result_dict["control_name"] = args["control_name"]
    new_val = result_dict.get("new_value", args["value"])
    result_dict["message"] = f"Successfully set {args['control_name']} to {new_val}. The UI slider and any linked datasets/charts have been updated."
    from lib.ai.context import is_empty_selection

    if is_empty_selection(new_val):
        result_dict["errors"] = [
            f"EMPTY SELECTION: '{args['control_name']}' is {new_val!r} — it matches "
            f"nothing, so every layer and chart filtered by it renders blank."
        ]
        result_dict["message"] += " WARNING: this selection matches nothing."

    # Also drive synced displays: a 'control-set' on the controls:effects
    # channel makes peers re-apply the value to their backend and re-fetch
    # (matches how a peer's own slider commit propagates). The marker above
    # still refreshes this tab; re-applying the same value is idempotent.
    _inject_bus("controls:effects", {
        "type": "control-set",
        "extName": args["extension"],
        "project": args["project"],
        "scenario": args["scenario"],
        "controlName": args["control_name"],
        "value": new_val,
    })
    return json.dumps(result_dict, default=str)


def _exec_list_layers(db: Any | None, duckdb_engine: Any | None = None) -> str:
    """List all map layers with their style mappings and geometry info,
    including each layer's styleable geometry properties (for agentic styling)."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Layer, LayerDataset, LayerStyleMapping, GeometryFile

    session = db.get_session()
    try:
        layers = session.query(Layer).all()
        result = []
        for lyr in layers:
            styles = session.query(LayerStyleMapping).filter(
                LayerStyleMapping.layer_id == lyr.id,
            ).all()
            geo = session.query(GeometryFile).filter(
                GeometryFile.id == lyr.geometry_id,
            ).first() if lyr.geometry_id else None
            datasets = session.query(LayerDataset).filter(
                LayerDataset.layer_id == lyr.id,
            ).all()
            result.append({
                "layer_id": lyr.id,
                "name": lyr.name,
                "display_name": lyr.display_name,
                "deck_layer_type": lyr.deck_layer_type,
                "geometry_join_key": geo.join_key if geo else None,
                "datasets": [
                    {
                        "geom_join_key": ld.geom_join_key,
                        "data_join_key": ld.data_join_key,
                    }
                    for ld in datasets
                ],
                "style_mappings": [
                    {
                        "style_id": s.id,
                        "visual_property": s.visual_property,
                        "column": s.column,
                        "colormap": s.colormap,
                        "scale_type": s.scale_type,
                        "domain_min": s.domain_min,
                        "domain_max": s.domain_max,
                    }
                    for s in styles
                ],
                # Styleable feature properties (name + numeric hint + sample),
                # so the agent can pick a column and scale for style_layer.
                "geometry_properties": _layer_geometry_props(lyr, session, duckdb_engine),
            })
        return json.dumps(result, default=str)
    finally:
        session.close()


# Feature properties are immutable for a given file, so key the cache on the
# content hash. Without this the system prompt — which now lists every layer's
# properties and is rebuilt on every chat message — would re-parse each stored
# GeoJSON per turn.
_GEOM_PROPS_CACHE: dict[str, list[dict]] = {}


def _layer_geometry_props(lyr, session, duckdb_engine) -> list[dict]:
    """Styleable feature-property descriptors for a layer's geometry:
    ``[{name, numeric, sample}]``. Spatial layers read the ingested DuckDB
    table; GeoJSON layers sample the stored file. Best-effort — any failure
    yields ``[]`` so discovery never breaks a list_layers call.
    """
    from models.orm import GeometryFile

    geo = (
        session.query(GeometryFile)
        .filter(GeometryFile.id == lyr.geometry_id)
        .first()
        if lyr.geometry_id else None
    )
    if not geo:
        return []

    cache_key = geo.spatial_table if getattr(geo, "is_spatial", False) else geo.content_hash
    if cache_key and cache_key in _GEOM_PROPS_CACHE:
        return _GEOM_PROPS_CACHE[cache_key]

    samples: dict[str, list] = {}
    try:
        if getattr(geo, "is_spatial", False) and duckdb_engine is not None:
            from lib import geometry_spatial

            cols = geometry_spatial.spatial_columns(duckdb_engine, geo.id) or []
            table = geo.spatial_table or f"geom_{geo.id}"
            if cols:
                sel = ", ".join('"' + c.replace('"', "") + '"' for c in cols)
                rows = duckdb_engine.query_json(f'SELECT {sel} FROM "{table}" LIMIT 20')
                for c in cols:
                    samples[c] = [r.get(c) for r in rows if r.get(c) is not None]
        else:
            from lib.state import storage

            raw = storage.read_file_bytes(geo.content_hash)
            gj = json.loads(raw)
            feats = gj.get("features", []) if isinstance(gj, dict) else []
            for f in feats[:20]:
                for k, v in (f.get("properties") or {}).items():
                    lst = samples.setdefault(k, [])
                    if v is not None and len(lst) < 20:
                        lst.append(v)
    except Exception:
        # Swallowing this silently is what made the phantom dataset mapping
        # untraceable: a failed geometry read looks exactly like "the layer has
        # no such property", so style_layer routed to the dataset branch and
        # created a LayerStyleMapping nobody asked for. Log loudly; the caller
        # still gets [] so discovery never hard-fails.
        logger.warning(
            "Could not read geometry properties for layer %s (geometry %s)",
            getattr(lyr, "id", "?"), geo.id, exc_info=True,
        )
        return []

    out = []
    for name, vals in samples.items():
        numeric = bool(vals) and all(
            isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals
        )
        out.append({"name": name, "numeric": numeric, "sample": (vals[0] if vals else None)})
    if cache_key:
        _GEOM_PROPS_CACHE[cache_key] = out
    return out


# Distinct values per (geometry, property). Same rationale as the props
# cache: the system prompt lists these and is rebuilt on every message.
_PROP_VALUES_CACHE: dict[tuple, list[str]] = {}


def _layer_property_values(lyr, session, duckdb_engine, prop: str, cap: int = 26) -> list[str]:
    """Distinct values of a categorical layer property, or [] if high-cardinality.

    Bails past ``cap`` distinct values — an id or a free-text field is not a
    palette, and listing thousands of them would swamp the prompt it feeds.
    """
    key = (getattr(lyr, "geometry_id", None), prop)
    if key in _PROP_VALUES_CACHE:
        return _PROP_VALUES_CACHE[key]
    try:
        vals = _column_distinct_values(lyr, session, duckdb_engine, prop, limit=cap + 1)
        out = [] if len(vals) > cap else sorted(str(v) for v in vals)
    except Exception:
        logger.debug("distinct values failed for %s.%s", getattr(lyr, "id", "?"), prop)
        out = []
    _PROP_VALUES_CACHE[key] = out
    return out


def _coerce_rgba(value) -> list[int] | None:
    """Accept '#RRGGBB', '#RGB' or [r,g,b(,a)] and return deck.gl RGBA.

    Callers author palettes in hex; the renderer wants integer channels.
    Anything unparseable returns None so one bad entry falls back to the
    layer's static fill rather than failing the whole call.
    """
    if isinstance(value, (list, tuple)) and 3 <= len(value) <= 4:
        try:
            ch = [max(0, min(255, int(c))) for c in value]
        except (TypeError, ValueError):
            return None
        return ch if len(ch) == 4 else ch + [200]
    if isinstance(value, str):
        h = value.strip().lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            try:
                return [int(h[i:i + 2], 16) for i in (0, 2, 4)] + [200]
            except ValueError:
                return None
    return None


def _categorical_palette(n: int) -> list[list[int]]:
    """N visually-distinct RGBA colors (evenly-spaced hues) for categorical
    coloring."""
    import colorsys

    out = []
    n = max(1, n)
    for i in range(n):
        r, g, b = colorsys.hsv_to_rgb((i / n) % 1.0, 0.62, 0.95)
        out.append([int(r * 255), int(g * 255), int(b * 255), 200])
    return out


def _column_distinct_values(lyr, session, duckdb_engine, column: str, limit: int = 50) -> list:
    """Distinct non-null values of a geometry-feature property (for building a
    categorical color map). Spatial → DISTINCT query; GeoJSON → scan features.
    Best-effort; returns [] on failure."""
    from models.orm import GeometryFile

    geo = (
        session.query(GeometryFile).filter(GeometryFile.id == lyr.geometry_id).first()
        if lyr.geometry_id else None
    )
    if not geo:
        return []
    try:
        if getattr(geo, "is_spatial", False) and duckdb_engine is not None:
            table = geo.spatial_table or f"geom_{geo.id}"
            col = column.replace('"', "")
            rows = duckdb_engine.query_json(
                f'SELECT DISTINCT "{col}" AS v FROM "{table}" '
                f'WHERE "{col}" IS NOT NULL LIMIT {int(limit)}'
            )
            return [r.get("v") for r in rows if r.get("v") is not None]
        from lib.state import storage

        gj = json.loads(storage.read_file_bytes(geo.content_hash))
        seen: list = []
        for f in (gj.get("features", []) if isinstance(gj, dict) else []):
            v = (f.get("properties") or {}).get(column)
            if v is not None and v not in seen:
                seen.append(v)
                if len(seen) >= limit:
                    break
        return seen
    except Exception:
        return []


def _exec_style_layer(args: dict, db: Any | None, duckdb_engine: Any | None = None) -> str:
    """Create a NEW visual style on a map layer (color / width / radius driven
    by a column). Routes automatically:
      * a GEOMETRY feature property (e.g. an uploaded shapefile's ``voltage``)
        → writes a geoMapping into the layer's default_style and applies it
        live over the bus.
      * a DATASET column → creates a LayerStyleMapping row.
    `source` ('geometry' | 'dataset') can force the routing.
    """
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Layer, LayerDataset, LayerStyleMapping

    layer_id = args.get("layer_id")
    visual_property = args.get("visual_property")
    column = args.get("column")
    if not layer_id or not visual_property or not column:
        return json.dumps({"error": "layer_id, visual_property, and column are required"})

    scale_type = args.get("scale_type")
    colormap = args.get("colormap")
    domain_min = args.get("domain_min")
    domain_max = args.get("domain_max")
    source = args.get("source")
    category_colors = args.get("category_colors") or {}
    units = args.get("units")
    scale = args.get("scale")
    min_pixels = args.get("min_pixels")
    max_pixels = args.get("max_pixels")

    # Generic per-layer sizing knobs (localStyle), mapped to the right keys for
    # the target property. These control HOW a raw value renders — size in
    # 'meters' (geographic, zoom-scaled) vs 'pixels' (screen), the linear
    # multiplier, and pixel clamps — so a size-by-value mapping looks sensible
    # (raw planned_mw × scale in the chosen units).
    def _sizing_patch() -> dict:
        size_props = {"getPointRadius", "getRadius", "getLineWidth"}
        if visual_property not in size_props:
            return {}
        radius = visual_property in ("getPointRadius", "getRadius")
        k_scale, k_units, k_min, k_max = (
            ("radiusScale", "radiusUnits", "radiusMinPixels", "radiusMaxPixels")
            if radius else
            ("lineWidthScale", "lineWidthUnits", "lineWidthMinPixels", "lineWidthMaxPixels")
        )
        patch: dict = {}
        if scale is not None:
            patch[k_scale] = scale
        if units is not None:
            patch[k_units] = units
        if min_pixels is not None:
            patch[k_min] = min_pixels
        if max_pixels is not None:
            patch[k_max] = max_pixels
        return patch

    style_patch = _sizing_patch()

    session = db.get_session()
    try:
        lyr = session.query(Layer).filter(Layer.id == layer_id).first()
        if not lyr:
            return json.dumps({"error": f"Layer {layer_id} not found"})

        geo_props = {p["name"] for p in _layer_geometry_props(lyr, session, duckdb_engine)}
        is_geo = source == "geometry" or (source is None and column in geo_props)
        if source == "dataset":
            is_geo = False
        logger.info(
            "[style_layer] layer=%s %s→%s source=%s → %s (%d geometry properties)",
            layer_id, visual_property, column, source or "auto",
            "geometry" if is_geo else "dataset", len(geo_props),
        )
        # Auto-routing with NO geometry properties is not evidence that the
        # column belongs to a dataset — it usually means the geometry could not
        # be read (see the warning logged above). Creating a LayerStyleMapping
        # here is how a phantom dataset mapping appears on a layer that has no
        # business having one, and the UI cannot delete what the agent didn't
        # knowingly create. Refuse instead, and say which it is.
        if not is_geo and source is None and not geo_props:
            return json.dumps({"error": (
                f"Could not read any geometry properties for layer {layer_id}, so it is "
                f"impossible to tell whether '{column}' is a feature property or a "
                f"dataset column. Nothing was created. Check the layer's geometry loads "
                f"(list_layers shows its properties); pass source='dataset' explicitly if "
                f"you really mean a dataset column."
            )})

        if is_geo:
            default_style = json.loads(lyr.default_style_json) if lyr.default_style_json else {}
            gm = default_style.setdefault("geoMappings", {})
            entry = {"property": column}
            if colormap is not None:
                entry["colormap"] = colormap
            if scale_type is not None:
                entry["scale_type"] = scale_type
            if domain_min is not None:
                entry["domain_min"] = domain_min
            if domain_max is not None:
                entry["domain_max"] = domain_max
            # Categorical color needs an explicit value→color map, or the
            # frontend renders a flat fallback. Enumerate distinct values and
            # assign each a distinct hue.
            _color_props = {"getColor", "getFillColor", "getLineColor"}
            _set_valued_note = None
            _sizing_note = None
            _palette_note = None
            _distinct_values: list[str] = []
            if scale_type == "categorical" and visual_property in _color_props:
                distinct = _column_distinct_values(lyr, session, duckdb_engine, column)
                if distinct:
                    # A set-valued property ("{Construction,Planned}") has one
                    # distinct value per COMBINATION, so colouring by it yields
                    # dozens of near-duplicate categories and an unreadable
                    # legend. Colour still applies — but say so, because the
                    # result looks broken rather than wrong.
                    sets = sum(
                        1 for v in distinct
                        if len(str(v)) >= 2 and str(v)[0] in "{[" and str(v)[-1] in "}]"
                    )
                    if sets > len(distinct) / 2:
                        _set_valued_note = (
                            f"'{column}' holds a SET per feature, so this produced "
                            f"{len(distinct)} combination categories rather than one per "
                            f"stage. For a readable view, filter_layer to the stage of "
                            f"interest, or colour by a single-valued property instead."
                        )
                    # The CALLER owns the palette. Which categories are related
                    # — and therefore which should sit near each other — is a
                    # judgement about meaning that belongs with whoever read
                    # the values, not with a rule baked in here. Pass
                    # category_colors to decide it; the even-hue spread below
                    # is only a fallback so an unspecified call still renders.
                    if category_colors:
                        entry["categoryColors"] = {
                            str(k): _coerce_rgba(v) for k, v in category_colors.items()
                            if _coerce_rgba(v) is not None
                        }
                        missing = [str(v) for v in distinct
                                   if str(v) not in entry["categoryColors"]]
                        if missing:
                            _palette_note = (
                                f"{len(missing)} value(s) had no colour and fall back to the "
                                f"layer's static fill: {missing[:8]}"
                            )
                    else:
                        palette = _categorical_palette(len(distinct))
                        entry["categoryColors"] = {
                            str(v): palette[i] for i, v in enumerate(distinct)
                        }
                        _palette_note = (
                            "Auto-assigned evenly-spaced hues, which ignores how these "
                            "categories relate. Re-call with category_colors to group "
                            "related values into similar colours."
                        )
                    _distinct_values = [str(v) for v in distinct]
            # Size encodings: derive the scale from the data instead of taking
            # a guess on faith. `radius = value × scale` in the chosen units,
            # so a scale that suits one column is meaningless for another —
            # sizing 0–11,000 MW at scale 0.5 in metres put even the largest
            # site at 0.56 px, under radiusMinPixels, so every point rendered
            # identically and the encoding silently vanished. Only the server
            # knows the column's range, so only the server can pick this.
            if visual_property in {"getPointRadius", "getRadius", "getLineWidth"}:
                nums = [
                    float(v) for v in _column_distinct_values(
                        lyr, session, duckdb_engine, column, limit=5000,
                    ) if isinstance(v, (int, float)) and not isinstance(v, bool)
                ]
                if nums and max(nums) > 0:
                    nums.sort()
                    top = nums[-1]
                    # Scale off the 95th percentile, not the max. These
                    # distributions have a long tail — capacity runs to 11,000
                    # MW against a median of 23 — so fitting the largest
                    # feature on screen squeezes the whole body of the data
                    # onto the minimum-pixel floor, which looks exactly like
                    # no encoding at all. Fit the bulk and let the handful of
                    # giants clamp at max_pixels instead.
                    p95 = nums[min(len(nums) - 1, int(len(nums) * 0.95))] or top
                    # Area-proportional by default: the cartographic norm for
                    # point symbols, and what keeps a long tail legible.
                    if not entry.get("scale_type") or entry.get("scale_type") == "linear":
                        entry["scale_type"] = "sqrt"

                    def _mag(x: float) -> float:
                        if entry["scale_type"] == "sqrt":
                            return math.sqrt(max(0.0, x))
                        if entry["scale_type"] == "log":
                            return math.log10(max(1.0, x))
                        return x

                    is_radius = visual_property != "getLineWidth"
                    k_s = "radiusScale" if is_radius else "lineWidthScale"
                    k_u = "radiusUnits" if is_radius else "lineWidthUnits"
                    k_mn = "radiusMinPixels" if is_radius else "lineWidthMinPixels"
                    k_mx = "radiusMaxPixels" if is_radius else "lineWidthMaxPixels"
                    target_px = 18.0          # radius at the 95th percentile
                    if _mag(p95) > 0:
                        # The tool owns this number, even when the caller
                        # supplied one. A raw multiplier is only meaningful
                        # against the column's actual range, which the caller
                        # cannot see — a plausible-looking scale=0.5 in metres
                        # put every site under radiusMinPixels and flattened
                        # the encoding completely. Choosing it here is the
                        # difference between a size encoding and a uniform dot
                        # field.
                        computed = round(target_px / _mag(p95), 4)
                        overrode = scale is not None and abs(scale - computed) > 1e-9
                        style_patch[k_s] = computed
                        # Pixels, not metres: a metre-denominated radius is
                        # invisible at national zoom and absurd zoomed in.
                        style_patch[k_u] = "pixels"
                        style_patch.setdefault(k_mn, 2)
                        style_patch.setdefault(k_mx, 40)
                        _sizing_note = (
                            f"Sized by {column} with a {entry['scale_type']} scale fitted to "
                            f"the 95th percentile ({p95:g}; max {top:g}): scale={computed} in "
                            f"pixels, clamped to 2–40px."
                        )
                        if overrode:
                            _sizing_note += (
                                f" (Your scale={scale} in {units or 'meters'} was replaced — "
                                f"it would have put every feature on the minimum-pixel floor. "
                                f"You don't need to pass scale/units for size encodings.)"
                            )
            gm[visual_property] = entry
            # Spatial (viewport-served) layers prune served feature properties;
            # ensure the styled column is fetched so the geoMapping can read it.
            vc = default_style.setdefault("viewportColumns", [])
            if column not in vc:
                vc.append(column)
            if style_patch:
                default_style.update(style_patch)
            lyr.default_style_json = json.dumps(default_style)
            session.commit()
            db.save_to_disk()
            _inject_bus("mcp", {
                "type": "set-layer-geo-mapping",
                "layerId": layer_id,
                "visualProperty": visual_property,
                "mapping": entry,
                "style": style_patch,
            })
            result = {
                # NOT __layer_style__. That marker means "a DATASET style
                # mapping row changed" and the chat panel responds by upserting
                # it into the layer's style_mappings, keyed on style_id — which
                # a geometry mapping has no such thing as. The upsert appended
                # an entry with id=undefined, so the styler showed a "Point
                # Radius ← dataset" row with no column that no delete button
                # could ever target, on a layer with no dataset attached. Each
                # subsequent geometry style overwrote that same phantom, which
                # is why exactly one appeared and it always named whatever was
                # styled last. This path is already applied live by the
                # set-layer-geo-mapping command above.
                "__layer_geo_style__": True, "layer_id": layer_id,
                "visual_property": visual_property, "driven_by": "geometry",
                "sizing": style_patch, **entry,
            }
            # A categorical colour without a legend is unreadable — the colours
            # mean nothing until you can name them. Surface the legend as part
            # of applying the style rather than leaving it to be remembered.
            if visual_property in _color_props and scale_type == "categorical":
                _inject_bus("mcp", {"type": "popout-legend", "layerId": layer_id})
                result["legend"] = "Opened the categorical legend for this layer."
            if _set_valued_note:
                result["warning"] = _set_valued_note
            if _sizing_note:
                result["sizing_note"] = _sizing_note
            if _palette_note:
                result["palette_note"] = _palette_note
            if _distinct_values:
                result["category_values"] = _distinct_values
            return json.dumps(result, default=str)

        # Dataset-driven: needs an attached dataset to source the column from.
        lds = session.query(LayerDataset).filter(LayerDataset.layer_id == layer_id).all()
        if not lds:
            avail = sorted(geo_props)
            return json.dumps({
                "error": (
                    f"'{column}' is not a geometry property of layer {layer_id}, and the "
                    f"layer has no attached dataset to source a column from. Style by one "
                    f"of the geometry properties instead, or attach a dataset."
                ),
                "available_geometry_properties": avail,
            })
        ld = lds[0]
        logger.info(
            "[style_layer] creating DATASET mapping on layer=%s %s→%s "
            "(layer_dataset=%s); '%s' is not one of the %d geometry properties",
            layer_id, visual_property, column, ld.id, column, len(geo_props),
        )
        sm = LayerStyleMapping(
            layer_id=layer_id, layer_dataset_id=ld.id, visual_property=visual_property,
            column=column, colormap=colormap, scale_type=scale_type,
            domain_min=domain_min, domain_max=domain_max,
        )
        session.add(sm)
        # Generic sizing knobs (units/scale/pixel clamps) are localStyle-level,
        # so they apply to dataset-driven mappings too — persist to default_style.
        if style_patch:
            ds = json.loads(lyr.default_style_json) if lyr.default_style_json else {}
            ds.update(style_patch)
            lyr.default_style_json = json.dumps(ds)
        session.commit()
        session.refresh(sm)
        db.save_to_disk()
        mapping = {
            "style_id": sm.id, "layer_id": layer_id, "layer_dataset_id": ld.id,
            "visual_property": visual_property, "column": column, "colormap": colormap,
            "scale_type": scale_type, "domain_min": domain_min, "domain_max": domain_max,
        }
        # set-layer-style upserts the mapping into the layer's style_mappings live.
        _inject_bus("mcp", {"type": "set-layer-style", "layerId": layer_id, "mapping": mapping})
        # Apply the sizing knobs live too (localStyle patch, no geoMapping).
        if style_patch:
            _inject_bus("mcp", {"type": "set-layer-geo-mapping", "layerId": layer_id, "style": style_patch})
        return json.dumps({"__layer_style__": True, "driven_by": "dataset", "sizing": style_patch, **mapping}, default=str)
    except Exception as e:
        session.rollback()
        return json.dumps({"error": str(e)})
    finally:
        session.close()


def _exec_update_layer_style(args: dict, db: Any | None) -> str:
    """Update a layer style mapping (colormap, scale, domain, column)."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import LayerStyleMapping

    layer_id = args.get("layer_id")
    style_id = args.get("style_id")
    if not layer_id or not style_id:
        return json.dumps({"error": "layer_id and style_id are required"})

    session = db.get_session()
    try:
        sm = (
            session.query(LayerStyleMapping)
            .filter(LayerStyleMapping.id == style_id, LayerStyleMapping.layer_id == layer_id)
            .first()
        )
        if not sm:
            return json.dumps({"error": f"Style mapping {style_id} not found for layer {layer_id}"})

        updatable = ("colormap", "scale_type", "domain_min", "domain_max", "column")
        for field in updatable:
            if field in args:
                setattr(sm, field, args[field])

        session.commit()
        db.save_to_disk()

        updated = {
            "style_id": sm.id,
            "layer_id": layer_id,
            "visual_property": sm.visual_property,
            "column": sm.column,
            "colormap": sm.colormap,
            "scale_type": sm.scale_type,
            "domain_min": sm.domain_min,
            "domain_max": sm.domain_max,
        }
        # Also drive synced displays via the merge-safe 'mcp' command (merges
        # into the layer's style_mappings). The marker below applies locally;
        # both call the same merge, so re-applying is idempotent.
        _inject_bus("mcp", {"type": "set-layer-style", "layerId": layer_id, "mapping": updated})
        return json.dumps({"__layer_style__": True, **updated}, default=str)
    except Exception as e:
        session.rollback()
        return json.dumps({"error": str(e)})
    finally:
        session.close()


def _exec_configure_layer_interaction(args: dict, db: Any | None) -> str:
    """Configure cross-layer click interactions on a layer."""
    source_name = args.get("source_layer_name")
    actions = args.get("actions", [])

    if not source_name:
        return json.dumps({"error": "source_layer_name is required"})
    if not actions:
        return json.dumps({"error": "actions array is required and cannot be empty"})

    # Validate action types
    valid_actions = {"filter", "show", "hide_self", "fly_to_bounds", "drilldown"}
    for act in actions:
        if act.get("action") not in valid_actions:
            return json.dumps({"error": f"Invalid action: {act.get('action')}. Valid: {sorted(valid_actions)}"})
        if act["action"] == "filter" and not act.get("targetLayerName"):
            return json.dumps({"error": "filter action requires targetLayerName"})
        if act["action"] == "show" and not act.get("targetLayerName"):
            return json.dumps({"error": "show action requires targetLayerName"})

    # Expand drilldown actions into component actions
    expanded = []
    for act in actions:
        if act["action"] == "drilldown":
            target = act.get("targetLayerName")
            source_prop = act.get("sourceProperty")
            filter_prop = act.get("filterProperty")
            if not target:
                return json.dumps({"error": "drilldown action requires targetLayerName"})
            expanded.append({"action": "filter", "targetLayerName": target, "filterProperty": filter_prop or source_prop, "sourceProperty": source_prop})
            expanded.append({"action": "show", "targetLayerName": target})
            expanded.append({"action": "hide_self"})
            expanded.append({"action": "fly_to_bounds"})
        else:
            expanded.append(act)
    actions = expanded

    # Verify source layer exists
    if db:
        from models.orm import Layer
        session = db.get_session()
        try:
            source = session.query(Layer).filter(Layer.name == source_name).first()
            if not source:
                return json.dumps({"error": f"Layer '{source_name}' not found"})
        finally:
            session.close()

    return json.dumps({
        "__cross_layer_config__": True,
        "source_layer_name": source_name,
        "actions": actions,
        "message": f"Configured {len(actions)} cross-layer action(s) on '{source_name}'. Click a feature to trigger them.",
    }, default=str)


# ---------------------------------------------------------------------------
# SQL table-reference parser
# ---------------------------------------------------------------------------

# Matches table references after FROM and JOIN keywords, handling:
#   - schema.table (e.g., ext_reeds.generation)
#   - quoted identifiers (e.g., "ext_reeds"."generation")
#   - subqueries are naturally skipped since ( doesn't match
_TABLE_REF_PATTERN = re.compile(
    r'(?:FROM|JOIN)\s+'
    r'("?[\w]+"?\s*\.\s*"?[\w]+"?|"?[\w]+"?)'
    r'(?:\s|$|,|\))',
    re.IGNORECASE,
)


def extract_table_refs(sql: str) -> list[str]:
    """Extract table names referenced in FROM/JOIN clauses of a SQL query."""
    matches = _TABLE_REF_PATTERN.findall(sql)
    tables = []
    for m in matches:
        # Normalize: strip quotes and whitespace around dots
        cleaned = re.sub(r'\s*\.\s*', '.', m.strip().replace('"', ''))
        if cleaned.lower() not in ("select", "values", "unnest"):
            tables.append(cleaned)
    return list(dict.fromkeys(tables))  # deduplicate preserving order


def _get_controls_for_tables(
    table_refs: list[str],
    registry: ExtensionRegistry | None,
) -> list[dict]:
    """Return input controls from extensions whose tables are referenced in a chart's SQL.

    Matches table refs like 'ext_demand_tldr.forecast' to extension 'demand-tldr'
    and returns all input controls for that extension with their current values.
    """
    if not registry or not table_refs:
        return []

    # Map extension names to their schema prefix: "demand-tldr" -> "ext_demand_tldr"
    ext_prefixes = {}
    for ext_name, _ in registry.items():
        prefix = f"ext_{ext_name.replace('-', '_')}"
        ext_prefixes[prefix] = ext_name

    # Find which extensions are referenced
    matched_extensions = set()
    for ref in table_refs:
        # e.g. "ext_demand_tldr.forecast" -> prefix "ext_demand_tldr"
        schema = ref.split(".")[0] if "." in ref else ref
        if schema in ext_prefixes:
            matched_extensions.add(ext_prefixes[schema])

    # Collect input controls from matched extensions
    controls = []
    for ext_name in matched_extensions:
        ext = registry.get(ext_name)
        if not ext:
            continue
        try:
            projects = ext.list_projects() if hasattr(ext, "list_projects") else []
            proj_name = projects[0].name if projects else None
            if not proj_name:
                continue
            scenarios = ext.list_scenarios(proj_name) if hasattr(ext, "list_scenarios") else []
            scen_name = scenarios[0].name if scenarios else None
            if not scen_name:
                continue
            from gridsight.extensions.controls import _collect_input_controls
            meta_map = _collect_input_controls(ext)
            for dc in ext.get_input_controls(proj_name, scen_name):
                ctrl_info = {
                    "extension": ext_name,
                    "name": dc.name,
                    "display_name": dc.display_name,
                    "current_value": dc.current_value,
                    "default_value": dc.default_value,
                    "unit": dc.unit,
                }
                meta = meta_map.get(dc.name)
                if meta:
                    ctrl_info["sql_column"] = meta[0].get("sql_column")
                controls.append(ctrl_info)
        except Exception:
            pass

    return controls


def _record_query_lineage(
    sql: str,
    row_count: int,
    lineage_manager: LineageManager,
    chat_context: ChatContext,
) -> None:
    """Record a TRANSFORM lineage node for a SQL query."""
    from lib.lineage.manager import TransformKind, CreatorType

    table_refs = extract_table_refs(sql)
    parent_ids = []
    for table_name in table_refs:
        node_id = lineage_manager.find_data_source_id(table_name)
        if node_id is not None:
            parent_ids.append(node_id)

    lineage_manager.record_transform(
        kind=TransformKind.SQL_AI,
        content={"sql": sql, "row_count": row_count, "tables": table_refs},
        parent_node_ids=parent_ids,
        creator_type=CreatorType.AI,
        ai_model=chat_context.ai_model,
        ai_conversation_id=chat_context.conversation_id,
        label=f"AI query: {sql[:80]}{'...' if len(sql) > 80 else ''}",
    )


def _exec_toggle_layer_visibility(args: dict, db: Any | None) -> str:
    """Toggle layer visibility. Returns a marker for the frontend."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Layer

    layer_id = args.get("layer_id")
    visible = args.get("visible", True)

    if layer_id is None:
        return json.dumps({"error": "layer_id is required"})

    session = db.get_session()
    try:
        lyr = session.query(Layer).filter(Layer.id == layer_id).first()
        if not lyr:
            return json.dumps({"error": f"Layer {layer_id} not found"})
        action = "shown" if visible else "hidden"
        # Also drive synced displays via the merge-safe 'mcp' command (the
        # same one MCP uses). The marker below still applies locally; both
        # paths call the targeted setter, so re-applying is idempotent.
        _inject_bus("mcp", {"type": "set-layer-visibility", "layerId": layer_id, "visible": visible})
        return json.dumps({
            "__layer_visibility__": True,
            "layer_id": layer_id,
            "visible": visible,
            "message": f"Layer '{lyr.display_name or lyr.name}' {action}.",
        })
    finally:
        session.close()


def _geometry_property_values(session, geometry_id: int, prop: str, limit: int = 40) -> list[str]:
    """Distinct values of one geometry feature property, for filter validation.

    Set-valued properties (``{Construction,Planned}``) are exploded into their
    members, because those members — not the raw set strings — are what a user
    means by a category and what filter_layer matches against.
    """
    from models.orm import GeometryFile
    from lib.state import storage

    geo = session.query(GeometryFile).filter(GeometryFile.id == geometry_id).first()
    if not geo:
        return []
    try:
        geojson = json.loads(storage.read_file_bytes(geo.content_hash))
    except Exception:
        return []
    values: set[str] = set()
    for f in geojson.get("features", []):
        v = (f.get("properties") or {}).get(prop)
        if v is None:
            continue
        s = str(v)
        if len(s) >= 2 and s[0] in "{[" and s[-1] in "}]":
            for member in s[1:-1].split(","):
                cleaned = member.strip().strip("\"'")
                if cleaned:
                    values.add(cleaned)
        else:
            values.add(s)
        if len(values) > limit:
            break
    return sorted(values)


def _exec_set_visible_layers(args: dict, db: Any | None) -> str:
    """Set the COMPLETE set of visible layers; everything else is hidden.

    Declarative where set_layer_visibility is incremental. Composing a view by
    toggling means remembering every layer that happens to be on from an
    earlier question and turning each one off — which is exactly the step that
    keeps getting skipped, leaving a state choropleth and an unrelated site
    layer stacked over the county answer. Stating the intended result instead
    makes the cleanup structural rather than something to remember.
    """
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Layer

    raw = args.get("layer_ids")
    if raw is None:
        return json.dumps({"error": "layer_ids is required (pass [] to hide everything)"})
    if not isinstance(raw, list):
        raw = [raw]
    try:
        wanted = {int(v) for v in raw}
    except (TypeError, ValueError):
        return json.dumps({"error": f"layer_ids must be integers, got {raw!r}"})

    session = db.get_session()
    try:
        layers = session.query(Layer).all()
        known = {l.id for l in layers}
        unknown = sorted(wanted - known)
        if unknown:
            return json.dumps({
                "error": f"No such layer(s): {unknown}. Nothing was changed.",
                "available": [
                    {"layer_id": l.id, "name": l.display_name or l.name} for l in layers
                ],
            })
        shown, hidden = [], []
        for lyr in layers:
            visible = lyr.id in wanted
            _inject_bus("mcp", {
                "type": "set-layer-visibility", "layerId": lyr.id, "visible": visible,
            })
            (shown if visible else hidden).append(lyr.display_name or lyr.name)
        logger.info("[set_visible_layers] visible=%s", sorted(wanted))
        return json.dumps({
            "message": f"Visible: {', '.join(shown) if shown else 'none'}.",
            "shown": shown,
            "hidden": hidden,
        })
    finally:
        session.close()


def _exec_filter_layer(args: dict, db: Any | None) -> str:
    """Filter a map layer to features whose property matches given values.

    This is the missing verb between "show the layer" and "style the layer":
    without it the assistant could only reveal a layer whole, so a request like
    "data centres still under construction" had no way to narrow what was drawn.

    Values are validated against the layer's actual geometry so a typo or a
    guessed category comes back with the real options instead of silently
    emptying the map.
    """
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Layer

    layer_id = args.get("layer_id")
    prop = (args.get("property") or "").strip()
    values = args.get("values")
    enabled = args.get("enabled", True)

    if layer_id is None:
        return json.dumps({"error": "layer_id is required. Call list_layers first."})
    if enabled and not prop:
        return json.dumps({"error": "property is required when enabling a filter"})
    if isinstance(values, str):
        values = [values]
    values = [str(v) for v in (values or [])]

    session = db.get_session()
    try:
        lyr = session.query(Layer).filter(Layer.id == layer_id).first()
        if not lyr:
            return json.dumps({"error": f"Layer {layer_id} not found"})
        label = lyr.display_name or lyr.name

        if not enabled:
            _inject_bus("mcp", {
                "type": "set-layer-geo-mapping",
                "layerId": layer_id,
                "style": {"filterEnabled": False},
            })
            return json.dumps({"message": f"Cleared the filter on '{label}'."})

        available = _geometry_property_values(session, lyr.geometry_id, prop)
        if available:
            unmatched = [v for v in values if v not in available]
            if unmatched and len(unmatched) == len(values):
                return json.dumps({
                    "error": (
                        f"None of {unmatched} are values of '{prop}' on '{label}', so the "
                        f"filter would hide every feature. Nothing was changed."
                    ),
                    "available_values": available,
                })

        _inject_bus("mcp", {
            "type": "set-layer-geo-mapping",
            "layerId": layer_id,
            "style": {
                "filterEnabled": True,
                "filterProperty": prop,
                "filterCategories": values,
            },
        })
        return json.dumps({
            "message": f"Filtered '{label}' to {prop} in {values}.",
            "note": (
                "A feature matches if the property equals one of these values, or — "
                "for set-valued properties like '{A,B}' — contains one of them."
            ),
        })
    finally:
        session.close()


def _exec_update_description(args: dict, db: Any | None) -> str:
    """Create or update a table/column description in the metadata store."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import TableDescription, ColumnDescription

    table_name = args.get("table_name")
    if not table_name:
        return json.dumps({"error": "table_name is required"})

    session = db.get_session()
    try:
        # Find or create the table description
        td = session.query(TableDescription).filter(
            TableDescription.table_name == table_name,
        ).first()
        if not td:
            td = TableDescription(table_name=table_name, source="ai")
            session.add(td)
            session.flush()

        if "description" in args and args["description"]:
            td.description = args["description"]
            # A confirmed description (often recording the user's own answer)
            # supersedes a low-confidence auto-description: stop asking.
            td.source = "user"
            if hasattr(td, "needs_review"):
                td.needs_review = 0
                td.review_question = None
                td.confidence = "high"

        # Handle column-level description
        column_name = args.get("column_name")
        if column_name:
            cd = session.query(ColumnDescription).filter(
                ColumnDescription.table_description_id == td.id,
                ColumnDescription.column_name == column_name,
            ).first()
            if not cd:
                cd = ColumnDescription(
                    table_description_id=td.id,
                    column_name=column_name,
                    source="ai",
                )
                session.add(cd)

            if args.get("column_description"):
                cd.description = args["column_description"]
            if args.get("column_type"):
                cd.data_type = args["column_type"]
            if "is_joinable" in args:
                cd.is_joinable = args["is_joinable"]
            if args.get("join_target_table"):
                cd.join_target_table = args["join_target_table"]
            if args.get("join_target_column"):
                cd.join_target_column = args["join_target_column"]
            cd.source = "ai"

        session.commit()
        db.save_to_disk()

        result = {"success": True, "table_name": table_name}
        if column_name:
            result["column_name"] = column_name
        result["message"] = f"Description updated for {table_name}" + (f".{column_name}" if column_name else "")
        return json.dumps(result)
    except Exception as e:
        session.rollback()
        return json.dumps({"error": str(e)})
    finally:
        session.close()


def _exec_set_style_preference(args: dict, db: Any | None) -> str:
    """Persist the user's default map-style preferences (colormap/opacity/color).
    Partial updates merge into existing values."""
    if not db:
        return json.dumps({"error": "Database not available"})

    import json as _json
    from datetime import datetime, timezone

    from routes.extensions import _get_or_create_default_user
    from models.orm import UserPreference

    update = {}
    if args.get("colormap"):
        update["colormap"] = str(args["colormap"])
    if args.get("opacity") is not None:
        try:
            update["opacity"] = max(0.0, min(1.0, float(args["opacity"])))
        except (TypeError, ValueError):
            pass
    if isinstance(args.get("point_color"), list):
        update["point_color"] = args["point_color"]
    if not update:
        return _json.dumps({"error": "Nothing to update (provide colormap, opacity, and/or point_color)."})

    session = db.get_session()
    try:
        uid = _get_or_create_default_user(session)
        pref = session.query(UserPreference).filter(
            UserPreference.user_id == uid, UserPreference.key == "style",
        ).first()
        existing = {}
        if pref and pref.value_json:
            try:
                existing = _json.loads(pref.value_json)
            except Exception:
                existing = {}
        merged = {**existing, **update}
        now = datetime.now(timezone.utc).isoformat()
        if pref:
            pref.value_json = _json.dumps(merged)
            pref.updated_at = now
        else:
            session.add(UserPreference(user_id=uid, key="style", value_json=_json.dumps(merged), updated_at=now))
        session.commit()
        db.save_to_disk()
        return _json.dumps({"success": True, "style": merged})
    except Exception as e:
        session.rollback()
        return _json.dumps({"error": str(e)})
    finally:
        session.close()


def _exec_save_memory(args: dict, db: Any | None) -> str:
    """Save a reusable artifact to AI memory."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from datetime import datetime, timezone
    from models.orm import AIMemory

    name = args.get("name", "")
    description = args.get("description", "")
    memory_type = args.get("memory_type", "insight")
    content = args.get("content", {})
    tags = args.get("tags", [])

    if not name:
        return json.dumps({"error": "name is required"})

    session = db.get_session()
    try:
        now = datetime.now(timezone.utc).isoformat()
        mem = AIMemory(
            memory_type=memory_type,
            name=name,
            description=description,
            content_json=json.dumps(content, default=str),
            tags=",".join(tags) if tags else None,
            creator_type="ai",
            created_at=now,
            updated_at=now,
        )
        session.add(mem)
        session.commit()
        db.save_to_disk()
        return json.dumps({
            "success": True,
            "memory_id": mem.id,
            "message": f"Saved '{name}' to AI memory (type={memory_type}).",
        })
    except Exception as e:
        session.rollback()
        return json.dumps({"error": str(e)})
    finally:
        session.close()


def _exec_search_memory(args: dict, db: Any | None) -> str:
    """Search AI memory for previously saved artifacts."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import AIMemory

    query = args.get("query", "")
    memory_type = args.get("memory_type")
    limit = min(args.get("limit", 10), 50)

    session = db.get_session()
    try:
        q = session.query(AIMemory)
        if memory_type:
            q = q.filter(AIMemory.memory_type == memory_type)
        if query:
            pattern = f"%{query}%"
            q = q.filter(
                AIMemory.name.ilike(pattern)
                | AIMemory.description.ilike(pattern)
                | AIMemory.tags.ilike(pattern)
            )
        results = q.order_by(AIMemory.updated_at.desc()).limit(limit).all()
        return json.dumps([
            {
                "id": m.id,
                "memory_type": m.memory_type,
                "name": m.name,
                "description": m.description,
                "tags": m.tags.split(",") if m.tags else [],
                "content": json.loads(m.content_json) if m.content_json else {},
                "created_at": m.created_at,
            }
            for m in results
        ], default=str)
    finally:
        session.close()


def _exec_search_artifacts(args: dict, db: Any | None) -> str:
    """Search across perspectives, stories, paintings, table descriptions, and AI memories."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Perspective, Story, Painting, TableDescription, AIMemory

    query = args.get("query", "")
    artifact_types = args.get("artifact_types") or ["perspective", "story", "painting", "table", "memory"]
    limit = min(args.get("limit", 20), 100)
    pattern = f"%{query}%"
    results = []

    session = db.get_session()
    try:
        if "perspective" in artifact_types:
            for p in session.query(Perspective).filter(
                Perspective.name.ilike(pattern) | Perspective.description.ilike(pattern)
            ).limit(limit).all():
                results.append({"type": "perspective", "id": p.id, "name": p.name, "description": p.description})

        if "story" in artifact_types:
            for s in session.query(Story).filter(
                Story.name.ilike(pattern) | Story.description.ilike(pattern)
            ).limit(limit).all():
                results.append({"type": "story", "id": s.id, "name": s.name, "description": s.description})

        if "painting" in artifact_types:
            for p in session.query(Painting).filter(
                Painting.name.ilike(pattern)
            ).limit(limit).all():
                results.append({"type": "painting", "id": p.id, "name": p.name, "layer_id": p.layer_id})

        if "table" in artifact_types:
            for td in session.query(TableDescription).filter(
                TableDescription.table_name.ilike(pattern) | TableDescription.description.ilike(pattern)
            ).limit(limit).all():
                results.append({"type": "table", "id": td.id, "name": td.table_name, "description": td.description})

        if "memory" in artifact_types:
            for m in session.query(AIMemory).filter(
                AIMemory.name.ilike(pattern) | AIMemory.description.ilike(pattern)
            ).limit(limit).all():
                results.append({"type": "memory", "id": m.id, "name": m.name, "memory_type": m.memory_type, "description": m.description})

        return json.dumps(results[:limit], default=str)
    finally:
        session.close()


def _exec_list_perspectives(args: dict, db: Any | None) -> str:
    """List all saved perspectives."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Perspective

    session = db.get_session()
    try:
        q = session.query(Perspective)
        project_id = args.get("project_id")
        if project_id:
            q = q.filter(Perspective.project_id == project_id)
        perspectives = q.all()
        return json.dumps([
            {
                "id": p.id,
                "name": p.name,
                "description": p.description,
                "owner": p.owner,
                "project_id": p.project_id,
                "scenario_id": p.scenario_id,
            }
            for p in perspectives
        ], default=str)
    finally:
        session.close()


def _exec_apply_perspective(args: dict, db: Any | None) -> str:
    """Apply a perspective by ID. Returns a marker for the frontend."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Perspective

    perspective_id = args.get("perspective_id")
    if not perspective_id:
        return json.dumps({"error": "perspective_id is required"})

    session = db.get_session()
    try:
        p = session.query(Perspective).filter(Perspective.id == perspective_id).first()
        if not p:
            return json.dumps({"error": f"Perspective {perspective_id} not found"})
        config = json.loads(p.config_json) if p.config_json else {}
        # Also drive synced displays via the same 'mcp' command MCP uses; the
        # marker still applies locally (both call handleApplyPerspective, so
        # re-applying is idempotent).
        _inject_bus("mcp", {"type": "apply-perspective", "perspectiveId": p.id})
        return json.dumps({
            "__apply_perspective__": True,
            "perspective_id": p.id,
            "name": p.name,
            "config": config,
            "message": f"Applied perspective '{p.name}'.",
        }, default=str)
    finally:
        session.close()


def _exec_create_perspective(args: dict, db: Any | None) -> str:
    """Create a new perspective. Checks for name collision."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Perspective

    name = args.get("name", "")
    if not name:
        return json.dumps({"error": "name is required"})

    overwrite = args.get("overwrite", False)
    description = args.get("description", "")
    project_id = args.get("project_id")
    scenario_id = args.get("scenario_id")

    session = db.get_session()
    try:
        existing = session.query(Perspective).filter(Perspective.name == name).first()
        if existing and not overwrite:
            return json.dumps({
                "error": (
                    f"Perspective '{name}' already exists (id={existing.id}). "
                    "Ask the user for confirmation, then call create_perspective again "
                    "with overwrite=true to replace it."
                ),
            })

        if existing and overwrite:
            existing.description = description
            existing.project_id = project_id
            existing.scenario_id = scenario_id
            # config_json will be populated by the frontend when it captures current state
            existing.config_json = existing.config_json or "{}"
            session.commit()
            db.save_to_disk()
            return json.dumps({
                "__create_perspective__": True,
                "perspective_id": existing.id,
                "name": name,
                "overwritten": True,
                "message": f"Perspective '{name}' updated (id={existing.id}). The frontend will capture the current view state.",
            })

        p = Perspective(
            name=name,
            description=description,
            owner="ai",
            project_id=project_id,
            scenario_id=scenario_id,
            config_json="{}",
        )
        session.add(p)
        session.commit()
        db.save_to_disk()
        return json.dumps({
            "__create_perspective__": True,
            "perspective_id": p.id,
            "name": name,
            "overwritten": False,
            "message": f"Perspective '{name}' created (id={p.id}). The frontend will capture the current view state.",
        })
    except Exception as e:
        session.rollback()
        return json.dumps({"error": str(e)})
    finally:
        session.close()


def _exec_list_stories(args: dict, db: Any | None) -> str:
    """List all saved stories."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Story, StoryStep

    session = db.get_session()
    try:
        q = session.query(Story)
        project_id = args.get("project_id")
        if project_id:
            q = q.filter(Story.project_id == project_id)
        stories = q.all()
        result = []
        for s in stories:
            step_count = session.query(StoryStep).filter(StoryStep.story_id == s.id).count()
            result.append({
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "project_id": s.project_id,
                "step_count": step_count,
            })
        return json.dumps(result, default=str)
    finally:
        session.close()


def _exec_apply_story(args: dict, db: Any | None) -> str:
    """Apply a story by ID. Returns a marker for the frontend."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Story

    story_id = args.get("story_id")
    if not story_id:
        return json.dumps({"error": "story_id is required"})

    session = db.get_session()
    try:
        s = session.query(Story).filter(Story.id == story_id).first()
        if not s:
            return json.dumps({"error": f"Story {story_id} not found"})
        # Also drive synced displays via the same 'mcp' command MCP uses; the
        # marker still applies locally (both set the active story; idempotent).
        _inject_bus("mcp", {"type": "apply-story", "storyId": s.id})
        return json.dumps({
            "__apply_story__": True,
            "story_id": s.id,
            "name": s.name,
            "message": f"Playing story '{s.name}'.",
        }, default=str)
    finally:
        session.close()


def _exec_list_projects_and_scenarios(db: Any | None) -> str:
    """List all projects and their scenarios."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Project, Scenario

    session = db.get_session()
    try:
        projects = session.query(Project).all()
        result = []
        for p in projects:
            scenarios = session.query(Scenario).filter(Scenario.project_id == p.id).all()
            result.append({
                "project_id": p.id,
                "name": p.name,
                "display_name": p.display_name,
                "description": p.description,
                "extension_name": p.extension_name,
                "scenarios": [
                    {
                        "scenario_id": s.id,
                        "name": s.name,
                        "display_name": s.display_name,
                        "description": s.description,
                    }
                    for s in scenarios
                ],
            })
        return json.dumps(result, default=str)
    finally:
        session.close()


def _exec_switch_project_scenario(args: dict, db: Any | None) -> str:
    """Switch active project/scenario. Returns a marker for the frontend."""
    extension = args.get("extension")
    project = args.get("project")
    scenario = args.get("scenario")

    if not all([extension, project, scenario]):
        return json.dumps({"error": "extension, project, and scenario are all required"})

    # Also drive synced displays via the same 'scenario' channel MCP uses; the
    # marker still applies locally (and expands the sidebar ext). Both call
    # updateScenarioState, so re-applying is idempotent.
    _inject_bus("scenario", {"project": project, "scenario": scenario})
    return json.dumps({
        "__switch_scenario__": True,
        "extension": extension,
        "project": project,
        "scenario": scenario,
        "message": f"Switched to {extension}/{project}/{scenario}.",
    })


def _exec_update_project_description(args: dict, db: Any | None) -> str:
    """Update project or scenario description."""
    if not db:
        return json.dumps({"error": "Database not available"})

    from models.orm import Project, Scenario

    project_id = args.get("project_id")
    if not project_id:
        return json.dumps({"error": "project_id is required"})

    session = db.get_session()
    try:
        scenario_id = args.get("scenario_id")
        if scenario_id:
            s = session.query(Scenario).filter(Scenario.id == scenario_id).first()
            if not s:
                return json.dumps({"error": f"Scenario {scenario_id} not found"})
            if args.get("scenario_description"):
                s.description = args["scenario_description"]
            session.commit()
            db.save_to_disk()
            return json.dumps({"success": True, "message": f"Updated scenario '{s.name}' description."})

        p = session.query(Project).filter(Project.id == project_id).first()
        if not p:
            return json.dumps({"error": f"Project {project_id} not found"})
        if args.get("description"):
            p.description = args["description"]
        session.commit()
        db.save_to_disk()
        return json.dumps({"success": True, "message": f"Updated project '{p.name}' description."})
    except Exception as e:
        session.rollback()
        return json.dumps({"error": str(e)})
    finally:
        session.close()


def _exec_create_hover_chart(args: dict, db: Any | None) -> str:
    """Attach a SQL-template-driven chart to a layer's click/hover events."""
    layer_name = args.get("layer_name")
    sql_template = args.get("sql_template")
    chart_type = args.get("chart_type", "bar")
    x_column = args.get("x_column")
    y_column = args.get("y_column")
    title_template = args.get("title_template", "")
    trigger = args.get("trigger", "click")
    color_column = args.get("color_column")

    if not layer_name or not sql_template:
        return json.dumps({"error": "layer_name and sql_template are required"})

    # Verify layer exists
    if db:
        from models.orm import Layer
        session = db.get_session()
        try:
            lyr = session.query(Layer).filter(Layer.name == layer_name).first()
            if not lyr:
                return json.dumps({"error": f"Layer '{layer_name}' not found"})
        finally:
            session.close()

    return json.dumps({
        "__hover_chart__": True,
        "layer_name": layer_name,
        "sql_template": sql_template,
        "chart_type": chart_type,
        "x_column": x_column,
        "y_column": y_column,
        "title_template": title_template,
        "trigger": trigger,
        "color_column": color_column,
        "message": f"Attached {trigger} chart to layer '{layer_name}'. {trigger.capitalize()} a feature to see it.",
    }, default=str)


def _exec_set_category_colors(args: dict) -> str:
    """Apply a category color palette. Returns a marker for the frontend."""
    colors = args.get("colors")
    if not colors or not isinstance(colors, dict):
        return json.dumps({
            "error": (
                "Missing 'colors' field. You must provide a JSON object mapping each "
                "category name (exactly as listed) to a hex color string like '#FF5733'. "
                "Example: {\"colors\": {\"Operational\": \"#2ECC71\", \"Planned\": \"#3498DB\"}}"
            )
        })

    if len(colors) == 0:
        return json.dumps({
            "error": "The 'colors' object is empty. Provide a hex color for each category."
        })

    # Validate hex colors
    validated = {}
    for key, val in colors.items():
        if isinstance(val, str) and val.startswith("#") and len(val) in (7, 4):
            validated[str(key)] = val
        else:
            return json.dumps({"error": f"Invalid hex color for '{key}': {val}. Use format '#RRGGBB'."})

    palette_name = args.get("palette_name", "AI Palette")

    return json.dumps({
        "__category_colors__": True,
        "colors": validated,
        "palette_name": palette_name,
        "count": len(validated),
    })


# Keep references to fire-and-forget inject tasks so the event loop doesn't
# garbage-collect them before they run.
_bg_inject_tasks: set = set()


def _inject_bus(channel: str, payload: dict, action: str = "update") -> int | None:
    """Send a server-originated stateBus message to every connected client
    (the local Atlas tab AND any synced wall displays), mirroring how the MCP
    control tools drive the UI.

    execute_tool() is synchronous but runs inside the async chat_stream
    generator, so a running event loop is available: schedule the async
    sync_manager.inject() on it as a fire-and-forget task. Returns None
    (count isn't awaited) on the scheduled path."""
    import asyncio
    from lib.sync import sync_manager

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        task = loop.create_task(sync_manager.inject(channel, payload, action))
        _bg_inject_tasks.add(task)
        task.add_done_callback(_bg_inject_tasks.discard)
        return None

    # No running loop (e.g. called from a sync test harness): block briefly.
    return asyncio.run(sync_manager.inject(channel, payload, action))


def _exec_fit_map_to_bounds(args: dict) -> str:
    """Frame a geographic bounding box on the map (and synced displays)."""
    try:
        west = float(args["west"])
        south = float(args["south"])
        east = float(args["east"])
        north = float(args["north"])
    except (KeyError, TypeError, ValueError):
        return json.dumps({"error": "west, south, east, north (numbers) are required"})

    _inject_bus("viewport", {
        "bounds": {"w": west, "s": south, "e": east, "n": north},
        "fit": True,
        "latitude": (south + north) / 2.0,
        "longitude": (west + east) / 2.0,
    })
    return json.dumps({
        "message": f"Framed the map to bounds W={west}, S={south}, E={east}, N={north}.",
    })


def _exec_pan_map(args: dict) -> str:
    """Pan/zoom the map to a center point (and synced displays)."""
    try:
        latitude = float(args["latitude"])
        longitude = float(args["longitude"])
    except (KeyError, TypeError, ValueError):
        return json.dumps({"error": "latitude and longitude (numbers) are required"})
    zoom = args.get("zoom", 5.0)
    try:
        zoom = float(zoom)
    except (TypeError, ValueError):
        zoom = 5.0

    _inject_bus("viewport", {
        "latitude": latitude,
        "longitude": longitude,
        "zoom": zoom,
        "bearing": 0,
        "pitch": 0,
    })
    return json.dumps({
        "message": f"Panned the map to {latitude}, {longitude} at zoom {zoom}.",
    })


_BASEMAP_IDS = ("dark-matter", "positron", "voyager", "satellite")


# Semantic buckets the vector basemaps expose (web/src/lib/basemaps.js).
BASEMAP_FEATURE_CATEGORIES = {
    "roads_major": "Highways & interstates",
    "roads_minor": "Streets & minor roads",
    "water": "Water bodies",
    "waterways": "Waterways (rivers / streams)",
    "labels": "Labels & POIs",
}


def _exec_set_basemap_detail(args: dict) -> str:
    """Set which basemap feature categories are drawn, as a complete set.

    Declarative like set_visible_layers: state what should be ON and the rest
    go off, so "just the water" is one call rather than four toggles whose
    intermediate states flash on screen.
    """
    visible = args.get("visible")
    hidden = args.get("hidden")
    known = set(BASEMAP_FEATURE_CATEGORIES)

    if visible is not None:
        if not isinstance(visible, list):
            return json.dumps({"error": "visible must be a list of category ids"})
        unknown = sorted(set(visible) - known)
        hidden_set = known - set(visible)
    elif hidden is not None:
        if not isinstance(hidden, list):
            return json.dumps({"error": "hidden must be a list of category ids"})
        unknown = sorted(set(hidden) - known)
        hidden_set = set(hidden)
    else:
        return json.dumps({
            "error": "Pass either `visible` (everything else is hidden) or `hidden`.",
            "categories": BASEMAP_FEATURE_CATEGORIES,
        })

    if unknown:
        return json.dumps({
            "error": f"Unknown basemap categories: {unknown}. Nothing was changed.",
            "categories": BASEMAP_FEATURE_CATEGORIES,
        })

    _inject_bus("mcp", {"type": "set-basemap-detail", "hidden": sorted(hidden_set)})
    shown = sorted(known - hidden_set)
    return json.dumps({
        "message": (
            f"Basemap detail — showing: {', '.join(shown) if shown else 'nothing'}; "
            f"hiding: {', '.join(sorted(hidden_set)) if hidden_set else 'nothing'}."
        ),
        "visible": shown,
        "hidden": sorted(hidden_set),
        "note": "Only vector basemaps have these; satellite imagery has no categories to toggle.",
    })


def _exec_set_basemap(args: dict) -> str:
    """Switch the map's base layer (and synced displays). Payload mirrors the
    MCP set_basemap tool so both surfaces drive the same frontend handler."""
    basemap = str(args.get("basemap") or "").strip()
    if basemap not in _BASEMAP_IDS:
        return json.dumps({
            "error": f"Unknown basemap '{basemap}'.",
            "valid_basemaps": list(_BASEMAP_IDS),
        })
    _inject_bus("mcp", {"type": "set-basemap", "basemap": basemap})
    return json.dumps({"message": f"Switched the base map to '{basemap}'."})


def _exec_zoom_map(args: dict) -> str:
    """Zoom the map by a relative delta, keeping center (and synced displays)."""
    try:
        delta = float(args["delta"])
    except (KeyError, TypeError, ValueError):
        return json.dumps({"error": "delta (a number) is required"})
    _inject_bus("viewport", {"zoomDelta": delta})
    direction = "in" if delta >= 0 else "out"
    return json.dumps({"message": f"Zoomed {direction} by {abs(delta)}."})


def _exec_set_clock_year(args: dict) -> str:
    """Set the animation clock to a year/index and pause (and synced displays)."""
    try:
        year = int(args["year"])
    except (KeyError, TypeError, ValueError):
        return json.dumps({"error": "year (integer) is required"})
    _inject_bus("clock", {"index": year, "playing": False})
    return json.dumps({"message": f"Set the clock to {year}."})


def _exec_close_charts(_args: dict) -> str:
    """Close all open chart panels (and synced displays)."""
    _inject_bus("charts", {"type": "chart:close-all"})
    return json.dumps({"message": "Closed all chart panels."})


def _exec_arrange_charts(args: dict) -> str:
    """Re-anchor all chart panels to one dock (and synced displays)."""
    anchor = args.get("anchor", "right")
    _inject_bus("charts", {"type": "chart:reanchor-all", "anchorMode": anchor})
    return json.dumps({"message": f"Arranged charts to '{anchor}'."})


def _exec_list_charts(registry: ExtensionRegistry) -> str:
    """List pre-configured charts from all extensions (preferred over custom SQL)."""
    if registry is None:
        return json.dumps({"error": "Extension registry not available"})
    charts = []
    for name, ext in registry.items():
        try:
            specs = ext.list_chart_specs() or []
        except Exception:
            continue
        for s in specs:
            charts.append({
                "extension": name,
                "chart_name": s.name,
                "display_name": s.display_name,
                "scope": s.scope,
                # Spelled out rather than left implicit in `scope`: an
                # entity chart opened without an entity_id renders an empty
                # panel, which is indistinguishable from a broken chart.
                "requires_entity_id": s.scope == "entity",
                "chart_type": s.chart_type,
                "project": s.project or None,
                "scenario": s.scenario or None,
            })
    return json.dumps(charts, default=str)


def _resolve_chart_sql(spec_dict: dict, entity_id: str, project: str = "", scenario: str = "") -> str:
    """Substitute the placeholders the chart-data endpoint substitutes.

    Mirrors routes/extensions.py::getExtensionChartData so a dry run here
    executes exactly the SQL the frontend will run.
    """
    sql = spec_dict.get("sql_template") or ""
    for placeholder, value in (
        ("{entity_id}", entity_id), ("{project}", project), ("{scenario}", scenario),
    ):
        safe = str(value).replace("'", "").replace('"', "").replace(";", "")
        sql = sql.replace(placeholder, safe)
    return sql


def _exec_open_chart(
    args: dict,
    registry: ExtensionRegistry,
    engine: DuckDBEngine | None = None,
) -> str:
    """Open a pre-configured extension chart as a draggable/resizable panel by
    injecting the same 'chart:open-frame' the MCP open_chart and the map-click
    pop-out use — so it's Plotly, correctly labelled, and slider-reactive.

    The chart's SQL is dry-run first. Opening a frame is fire-and-forget — the
    bus message carries no result — so without this the tool reported success
    for a chart that renders "No chart data available", and the assistant had
    no way to know. The most common cause is an entity-scoped chart opened
    with no entity_id: its WHERE clause collapses to `= ''` and matches
    nothing.
    """
    from dataclasses import asdict

    if registry is None:
        return json.dumps({"error": "Extension registry not available"})
    chart_name = args.get("chart_name")
    if not chart_name:
        return json.dumps({"error": "chart_name is required"})
    extension = args.get("extension", "")
    entity_id = str(args.get("entity_id", "") or "").strip()
    # Unset by default, NOT "floating". The frontend resolves placement as
    # `payload.anchorMode || defaultAnchor`, so any value here wins over the
    # app's own default ('tray') — an AI-opened chart floated over the map
    # while the tray stayed empty, which reads as the tray being broken.
    # Omitting the key lets each surface place the chart where its own
    # charts go.
    anchor = args.get("anchor") or ""

    # Search the named extension first, else every extension.
    candidates = (
        [(extension, registry.get(extension))] if extension else list(registry.items())
    )
    spec_dict = None
    ext_name = None
    for nm, ext in candidates:
        if ext is None:
            continue
        try:
            for s in (ext.list_chart_specs() or []):
                if s.name == chart_name:
                    spec_dict = asdict(s)
                    ext_name = nm
                    break
        except Exception:
            continue
        if spec_dict is not None:
            break

    if spec_dict is None:
        return json.dumps({"error": f"Chart '{chart_name}' not found. Call list_charts first."})

    label = spec_dict.get("display_name") or chart_name

    # An entity chart with no entity_id can only render empty. Refuse before
    # opening, and point at the scenario-wide charts in the same extension —
    # several are deliberate system-wide counterparts of an entity chart
    # (e.g. "Top 15 Counties (2025)" per state vs "Top 15 Counties — US").
    if spec_dict.get("scope") == "entity" and not entity_id:
        alternatives = []
        try:
            for s in (registry.get(ext_name).list_chart_specs() or []):
                if s.scope == "scenario":
                    alternatives.append({"chart_name": s.name, "display_name": s.display_name})
        except Exception:
            pass
        return json.dumps({
            "error": (
                f"'{label}' is an entity-scoped chart: it needs entity_id (e.g. a state "
                f"FIPS like '48' for Texas, or a county GEOID). Opening it without one "
                f"renders an empty panel, so nothing was opened."
            ),
            "retry_with": "open_chart(chart_name=..., entity_id=<id>)",
            "scenario_wide_charts_in_this_extension": alternatives,
        })

    # Dry-run the SQL the frontend will run. Verification is best-effort: if
    # it cannot run (unresolved placeholder, engine unavailable) that is not a
    # reason to withhold the chart, only to stop claiming it has data.
    rows = None
    if engine is not None:
        try:
            rows = len(engine.query_json(_resolve_chart_sql(spec_dict, entity_id)))
        except Exception as e:
            logger.debug("open_chart dry run failed for %s: %s", chart_name, e)

    if rows == 0:
        return json.dumps({
            "error": (
                f"'{label}' returns no rows for entity_id={entity_id!r}, so it would "
                f"render an empty panel. Nothing was opened. Check the id is valid for "
                f"this chart, or query the underlying table to find one that has data."
            ),
        })

    frame: dict = {
        "type": "chart:open-frame",
        "charts": [{"extName": ext_name, "spec": spec_dict, "entityId": entity_id}],
    }
    if anchor:
        frame["anchorMode"] = anchor
    _inject_bus("charts", frame)
    result = {"message": f"Opened pre-configured chart '{label}'."}
    if rows is not None:
        result["rows"] = rows
    else:
        result["note"] = "Could not pre-verify this chart's data."
    return json.dumps(result)
