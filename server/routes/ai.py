"""AI chat, DuckDB query, and chart execution routes."""
from __future__ import annotations

import io
import logging
from typing import Optional

import pyarrow as pa
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

import db
from lib.auth import require_api_key
from lib.extensions.duckdb_engine import DuckDBEngine
from lib.extensions.registry import ExtensionRegistry
from lib.lineage import LineageManager
from lib.responses import make_response

logger = logging.getLogger("meridian")
router = APIRouter()


class QueryBody(BaseModel):
    sql: str
    format: str = "json"  # "json", "arrow", "chartjs"


class ChatBody(BaseModel):
    message: str
    conversation_id: str = "default"
    images: list[str] | None = None
    webgpu_available: bool = False
    active_extensions: list[str] | None = None
    active_story_id: int | None = None
    active_perspective_id: int | None = None
    visible_layer_ids: list[int] | None = None
    reasoning_effort: str | None = None   # low | medium | high
    extra_instructions: str | None = None
    provider: str | None = None
    model: str | None = None
    think: bool | None = None


class AIChartBody(BaseModel):
    sql: str
    chart_type: str = "bar"  # bar | line | scatter | pie | stacked_bar | stacked_area
    x_column: str = ""
    y_column: str = ""
    title: str = ""
    color_column: str | None = None
    format: str = "plotly"  # "plotly" | "vega-lite"
    anchor: str = "floating"  # floating | right | bottom | left


def _to_chartjs(rows: list[dict]) -> dict:
    if not rows:
        return {"labels": [], "datasets": []}

    columns = list(rows[0].keys())

    label_col = None
    for candidate in ("label", "x", "name"):
        if candidate in columns:
            label_col = candidate
            break
    if not label_col:
        label_col = columns[0]

    labels = [r[label_col] for r in rows]

    value_cols = [c for c in columns if c != label_col and c != "color"]
    color_values = [r.get("color") for r in rows] if "color" in columns else None

    datasets = []
    for col in value_cols:
        ds = {"label": col, "data": [r[col] for r in rows]}
        if color_values:
            ds["backgroundColor"] = color_values
            ds["borderColor"] = color_values
        datasets.append(ds)

    return {"labels": labels, "datasets": datasets}


def _record_manual_query_lineage(sql: str, row_count: int, lm: LineageManager):
    try:
        from lib.ai.tools import extract_table_refs
        from lib.lineage.manager import TransformKind, CreatorType

        table_refs = extract_table_refs(sql)
        parent_ids = []
        for table_name in table_refs:
            node_id = lm.find_data_source_id(table_name)
            if node_id is not None:
                parent_ids.append(node_id)

        lm.record_transform(
            kind=TransformKind.SQL_MANUAL,
            content={"sql": sql, "row_count": row_count, "tables": table_refs},
            parent_node_ids=parent_ids,
            creator_type=CreatorType.USER,
            creator_user_id=lm.get_default_user_id(),
            label=f"Manual query: {sql[:80]}{'...' if len(sql) > 80 else ''}",
        )
    except Exception:
        logger.warning("Failed to record manual query lineage", exc_info=True)


def record_tiered_response_lineage(lm: LineageManager, tiered_response, transform_node_id: int):
    """Create RESULT and optional VIZ_CONFIG lineage nodes from a TieredResponse.

    Exposed publicly because routes.extensions also needs to invoke it
    when an input control returns a tiered response.
    """
    from dataclasses import asdict
    from lib.lineage.manager import CreatorType

    tr = tiered_response
    tier = tr.tier if hasattr(tr.tier, 'value') else tr.tier

    result_content = {"table": tr.table, "column": tr.column, "columns": tr.columns}
    parent_ids = [transform_node_id]

    if tr.table:
        ds_id = lm.find_data_source_id(tr.table)
        if ds_id is not None:
            parent_ids.append(ds_id)

    result_node = lm.record_result(
        content=result_content,
        parent_node_ids=parent_ids,
        label=f"Result: {tr.table or 'data'}" + (f".{tr.column}" if tr.column else ""),
    )

    if tier >= 2:
        viz_content = {}
        if tr.hint:
            viz_content = asdict(tr.hint) if hasattr(tr.hint, '__dataclass_fields__') else {"hint": str(tr.hint)}
        if tier >= 3 and tr.config:
            viz_content["chart_type"] = tr.chart_type
            viz_content["config"] = tr.config

        lm.record_viz_config(
            content=viz_content,
            parent_node_ids=[result_node.id],
            tier=tier,
            label=f"Viz hint: {tr.hint.hint_type}" if (tr.hint and hasattr(tr.hint, 'hint_type')) else f"Viz config (tier {tier})",
        )


def _resolve_sql_control_placeholders(sql: str, input_controls: list[dict], registry: ExtensionRegistry) -> str:
    for ctrl in input_controls:
        placeholder = "{" + ctrl.get("name", "") + "}"
        if placeholder not in sql:
            continue
        ext_name = ctrl.get("extension", "")
        ext = registry.get(ext_name) if ext_name else None
        if not ext:
            continue
        try:
            projects = ext.list_projects() if hasattr(ext, "list_projects") else []
            proj = projects[0].name if projects else None
            scenarios = ext.list_scenarios(proj) if proj and hasattr(ext, "list_scenarios") else []
            scen = scenarios[0].name if scenarios else None
            if proj and scen:
                for dc in ext.get_input_controls(proj, scen):
                    if dc.name == ctrl["name"]:
                        sql = sql.replace(placeholder, str(dc.current_value))
                        break
        except Exception:
            pass
    return sql


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/api/query")
async def queryDuckDB(body: QueryBody, request: Request, _=Depends(require_api_key)):
    engine: DuckDBEngine = request.app.state.duckdb_engine
    lm: LineageManager = request.app.state.lineage_manager
    try:
        if body.format == "arrow":
            arrow_table = engine.query(body.sql)
            _record_manual_query_lineage(body.sql, arrow_table.num_rows, lm)
            buf = io.BytesIO()
            writer = pa.ipc.new_stream(buf, arrow_table.schema)
            writer.write_table(arrow_table)
            writer.close()
            return Response(content=buf.getvalue(), media_type="application/vnd.apache.arrow.stream")
        elif body.format == "chartjs":
            rows = engine.query_json(body.sql)
            _record_manual_query_lineage(body.sql, len(rows), lm)
            return make_response(_to_chartjs(rows))
        else:
            rows = engine.query_json(body.sql)
            _record_manual_query_lineage(body.sql, len(rows), lm)
            return make_response(rows)
    except Exception as e:
        return make_response({"error": str(e)}, status=400)


@router.post("/api/charts/execute")
async def executeChartSQL(body: dict, request: Request, _=Depends(require_api_key)):
    sql = body.get("sql", "").strip()
    if not sql.lower().startswith(("select", "with")):
        raise HTTPException(400, "Only SELECT/WITH queries allowed")
    engine: DuckDBEngine = request.app.state.duckdb_engine
    try:
        rows = engine.query_json(sql)
        return make_response(rows[:1000])
    except Exception as e:
        return make_response({"error": str(e)}, status=400)


@router.post("/api/charts/batch-execute")
async def batchExecuteCharts(body: dict, request: Request, _=Depends(require_api_key)):
    charts = body.get("charts", [])
    engine: DuckDBEngine = request.app.state.duckdb_engine
    registry: ExtensionRegistry = request.app.state.extension_registry
    results = {}
    for entry in charts:
        chart_id = entry.get("chart_id", "")
        sql = entry.get("sql", "").strip()
        input_controls = entry.get("input_controls")
        # The title needs the same treatment as the SQL: a chart titled with
        # "{forecast_year}" has to re-resolve when the slider moves, or it
        # keeps announcing the year it was created for while its data moves on.
        title = entry.get("title_template") or None
        if input_controls:
            sql = _resolve_sql_control_placeholders(sql, input_controls, registry)
            if title:
                title = _resolve_sql_control_placeholders(title, input_controls, registry)
        if not sql.lower().startswith(("select", "with")):
            results[chart_id] = {"error": "Only SELECT/WITH queries allowed"}
            continue
        try:
            rows = engine.query_json(sql)[:1000]
            # Envelope, not a bare list, so a refreshed title can travel with
            # the rows. The client accepts either shape.
            results[chart_id] = {"rows": rows, "title": title}
        except Exception as e:
            results[chart_id] = {"error": str(e)}
    return make_response(results)


@router.get("/api/ai/capabilities")
async def aiCapabilities(request: Request, _=Depends(require_api_key)):
    """Describe every extension's queryable data for an external LLM driver.

    Returns the same context the in-app AI gets from each extension's
    get_ai_schema() (tables, columns, controls, example queries, plotting
    hints) plus the full DuckDB table catalog. The MCP server surfaces this
    so Claude Desktop can author SQL and charts against any extension's data.
    """
    from dataclasses import asdict

    registry: ExtensionRegistry = request.app.state.extension_registry
    engine: DuckDBEngine = request.app.state.duckdb_engine

    extensions = []
    for name, ext in registry.items():
        try:
            schema = ext.get_ai_schema()
        except Exception:
            logger.warning("get_ai_schema failed for %s", name, exc_info=True)
            schema = None
        if schema is None:
            continue
        entry = asdict(schema)
        entry["extension"] = name
        extensions.append(entry)

    tables = [
        {
            "table_name": t.table_name,
            "description": t.description,
            "columns": t.columns,
            "extension": getattr(t, "extension_name", None),
        }
        for t in engine.get_table_catalog()
    ]

    return make_response({"extensions": extensions, "tables": tables})


@router.post("/api/ai/chart")
async def aiCreateChart(body: AIChartBody, request: Request, _=Depends(require_api_key)):
    """Build a chart from a SQL query and push it to all connected displays.

    Reuses the in-app AI's chart builder (lib.ai.tools._exec_create_chart) so
    the spec — including reactive metadata for control-driven refresh — is
    identical to charts the in-app assistant produces, then injects it on the
    'charts' bus channel as a 'chart:open-ai' message.
    """
    import json as _json

    from fastapi.concurrency import run_in_threadpool

    from lib.ai.tools import _exec_create_chart
    from lib.sync import sync_manager

    engine: DuckDBEngine = request.app.state.duckdb_engine
    registry: ExtensionRegistry = request.app.state.extension_registry
    lm: LineageManager = request.app.state.lineage_manager

    args = {
        "sql": body.sql,
        "chart_type": body.chart_type,
        "x_column": body.x_column,
        "y_column": body.y_column,
        "title": body.title,
        "color_column": body.color_column,
        "format": body.format,
    }
    # _exec_create_chart runs SQL synchronously; keep it off the event loop.
    result_str = await run_in_threadpool(
        _exec_create_chart, args, engine, registry, lineage_manager=lm,
    )
    result = _json.loads(result_str)
    if "error" in result:
        return make_response({"error": result["error"]}, status=400)

    fmt = result.get("format", "plotly")
    reactive = result.get("reactive", {})
    payload: dict = {
        "type": "chart:open-ai",
        "spec": reactive,
        "datasets": reactive.get("datasets", []),
        "format": fmt,
        "anchorMode": body.anchor,
    }
    if fmt == "vega-lite":
        payload["vegaLiteSpec"] = result.get("spec")
    else:
        payload["plotlySpec"] = result.get("plotly")

    sent = await sync_manager.inject("charts", payload)
    return make_response({
        "sent": sent,
        "title": reactive.get("title") or body.title,
        "format": fmt,
    })


class MemorySaveBody(BaseModel):
    name: str
    description: str = ""
    memory_type: str = "insight"  # chart | query | insight | perspective_ref | story_ref
    content: dict = {}
    tags: list[str] | None = None


@router.post("/api/memory")
async def saveMemory(body: MemorySaveBody, _=Depends(require_api_key)):
    """Persist a reusable artifact to AI memory (reuses the in-app save_memory tool)."""
    import json as _json

    from lib.ai.tools import _exec_save_memory

    args = {
        "name": body.name,
        "description": body.description,
        "memory_type": body.memory_type,
        "content": body.content,
        "tags": body.tags or [],
    }
    return make_response(_json.loads(_exec_save_memory(args, db)))


@router.get("/api/memory/search")
async def searchMemory(
    query: str,
    memory_type: str | None = None,
    limit: int = 10,
    _=Depends(require_api_key),
):
    """Search AI memory (reuses the in-app search_memory tool)."""
    import json as _json

    from lib.ai.tools import _exec_search_memory

    args: dict = {"query": query, "limit": limit}
    if memory_type:
        args["memory_type"] = memory_type
    return make_response(_json.loads(_exec_search_memory(args, db)))


class DescriptionBody(BaseModel):
    table_name: str
    description: Optional[str] = None
    column_name: Optional[str] = None
    column_description: Optional[str] = None
    column_type: Optional[str] = None
    is_joinable: Optional[bool] = None
    join_target_table: Optional[str] = None
    join_target_column: Optional[str] = None


@router.post("/api/descriptions")
async def setDescription(body: DescriptionBody, _=Depends(require_api_key)):
    """Create/update a table or column description (reuses the in-app
    update_description tool). Descriptions are merged into the AI system prompt
    so the agent reliably understands user-loaded data."""
    import json as _json

    from lib.ai.tools import _exec_update_description

    args = {k: v for k, v in body.model_dump().items() if v is not None}
    return make_response(_json.loads(_exec_update_description(args, db)))


@router.post("/api/chat")
async def chatStream(body: ChatBody, request: Request, _=Depends(require_api_key)):
    from lib.ai.chat import chat_stream

    registry: ExtensionRegistry = request.app.state.extension_registry
    duckdb_engine: DuckDBEngine = request.app.state.duckdb_engine
    lineage_manager: LineageManager = request.app.state.lineage_manager

    return StreamingResponse(
        chat_stream(
            body.message, body.conversation_id, registry, duckdb_engine,
            images=body.images,
            lineage_manager=lineage_manager,
            webgpu_available=body.webgpu_available,
            db=db,
            active_extensions=body.active_extensions,
            active_story_id=body.active_story_id,
            active_perspective_id=body.active_perspective_id,
            visible_layer_ids=body.visible_layer_ids,
            model_override=body.model,
            provider_override=body.provider,
            think=body.think,
            reasoning_effort=body.reasoning_effort,
            extra_instructions=body.extra_instructions,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/api/chat/{conversation_id}/cancel")
async def cancelChat(conversation_id: str, _=Depends(require_api_key)):
    from lib.ai.chat import cancel_chat

    cancelled = cancel_chat(conversation_id)
    return make_response({"ok": True, "was_active": cancelled})


@router.delete("/api/chat/{conversation_id}")
async def clearChat(conversation_id: str, _=Depends(require_api_key)):
    from lib.ai.chat import clear_conversation

    clear_conversation(conversation_id)
    return make_response({"ok": True})


@router.get("/api/chat/config")
async def getChatConfig(_=Depends(require_api_key)):
    from lib.ai.providers import get_active_providers, get_default_provider, is_ai_disabled

    if is_ai_disabled():
        return make_response({
            "enabled": False,
            "disabled_reason": "AI has been disabled by the deployment administrator (MERIDIAN_DISABLE_AI).",
            "providers": [],
            "default_provider": None,
            "default_model": None,
        })

    providers = await get_active_providers()
    default = get_default_provider()
    return make_response({
        "enabled": len(providers) > 0,
        "providers": [{"id": k, "display_name": v["display_name"]} for k, v in providers.items()],
        "default_provider": default[0] if default else None,
        "default_model": default[1] if default else None,
    })


@router.get("/api/chat/models")
async def listChatModels(_=Depends(require_api_key)):
    from lib.ai.providers import get_active_providers
    from lib.ai.openai_client import llm_list_models

    providers = await get_active_providers()
    result = []
    for pid, pconfig in providers.items():
        models = await llm_list_models(pid)
        result.append({
            "id": pid,
            "display_name": pconfig["display_name"],
            "models": models,
        })
    return make_response({"providers": result})


@router.get("/api/chat/providers/catalog")
async def getProviderCatalog(_=Depends(require_api_key)):
    """Return every provider declared in llm_providers.json with the env
    var name it expects for its API key. The desktop Settings UI uses
    this to know which secrets to offer (and under what name to store
    them in the OS keychain). Providers whose key lives outside an env
    var (e.g. Ollama) are excluded since there's nothing for the user
    to enter."""
    from lib.ai.providers import _get_providers  # noqa: PLC2701

    catalog = []
    for p in _get_providers():
        env_var = p.get("api_key_env")
        if not env_var:
            continue
        catalog.append({
            "id": p["id"],
            "display_name": p.get("display_name", p["id"]),
            "api_key_env": env_var,
        })
    return make_response({"providers": catalog})
