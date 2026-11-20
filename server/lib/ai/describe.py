"""Auto-description of uploaded datasets.

When a dataset is uploaded we kick off a background LLM call that inspects the
columns + sample values and writes a table/column description so the AI has
context for future queries without re-discovering the data each time.

If the model can't confidently make sense of the data it sets ``needs_review``
and stashes a ``review_question``. The chat system prompt surfaces that question
so the AI asks the user ONCE; the answer is persisted (source="user") and the
flag is cleared, so it never re-asks.
"""
from __future__ import annotations

import io
import json
import logging
from datetime import datetime, timezone

import polars as pl

import db
from lib.serializers import file_suffix
from lib.state import storage

logger = logging.getLogger("meridian")

_SAMPLE_ROWS = 50
_VALUES_PER_COL = 5


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_sample(ds) -> tuple[list[str], dict[str, str], str]:
    """Return (columns, dtypes, sample_text) for a dataset's stored bytes."""
    raw = storage.read_file_bytes(ds.content_hash)
    suffix = file_suffix(ds.original_filename)
    df = (
        pl.read_parquet(io.BytesIO(raw), n_rows=_SAMPLE_ROWS)
        if suffix == "parquet"
        else pl.read_csv(io.BytesIO(raw), n_rows=_SAMPLE_ROWS, ignore_errors=True)
    )
    columns = df.columns
    dtypes = {c: str(df[c].dtype) for c in columns}
    lines = []
    for c in columns:
        vals = [v for v in df[c].to_list() if v is not None][:_VALUES_PER_COL]
        sample = ", ".join(str(v) for v in vals) if vals else "(no non-null sample)"
        lines.append(f"  - {c} ({dtypes[c]}): {sample}")
    return columns, dtypes, "\n".join(lines)


async def generate_dataset_descriptions(ds_id: int, table_name: str) -> dict:
    """Generate + persist descriptions for a dataset. Keyed by ``table_name``
    (the DuckDB-qualified name, e.g. ``user.baxtel_us_sites``) so it matches
    what the AI actually queries. Returns a summary dict."""
    from lib.ai.chat import get_llm_config
    from lib.ai.openai_client import llm_chat
    from models.orm import ColumnDescription, Dataset, TableDescription

    session = db.get_session()
    try:
        ds = session.query(Dataset).filter(Dataset.id == ds_id).first()
        if not ds:
            return {"error": f"dataset {ds_id} not found"}
        try:
            columns, dtypes, sample_text = _build_sample(ds)
        except Exception as e:
            logger.warning("[describe] sample read failed for %s: %s", table_name, e)
            columns, dtypes, sample_text = [], {}, "(could not read sample)"

        user_provided_desc = (ds.description or "").strip()
        llm_config = get_llm_config()

        parsed: dict = {}
        if llm_config and columns:
            prompt = (
                f"You are documenting a tabular dataset named '{ds.name}'.\n"
                f"Columns with sample values:\n{sample_text}\n\n"
                "Infer what this dataset is and what each column means. If the "
                "column names suggest a known public dataset (Census, EIA, EPA, "
                "NREL, Baxtel, etc.), use that knowledge.\n\n"
                "Assess your CONFIDENCE honestly. If the data is too ambiguous to "
                "describe meaningfully, set needs_user_input=true and write a "
                "specific question_for_user.\n\n"
                "Respond with ONLY a JSON object (no markdown), exactly:\n"
                '{"table_description": "one sentence", '
                '"confidence": "high|medium|low", '
                '"needs_user_input": false, '
                '"question_for_user": "", '
                '"columns": {"col": "description", ...}}\n'
                f"Include all {len(columns)} columns."
            )
            messages = [
                {"role": "system", "content": "You are a data documentation assistant. Respond with ONLY valid JSON — no markdown fences, no prose."},
                {"role": "user", "content": prompt},
            ]
            try:
                result = await llm_chat(
                    llm_config["provider"], llm_config["model"], messages, tools=[], timeout=120,
                )
                content = (result.get("content") or "").strip()
                if content.startswith("```"):
                    content = "\n".join(content.split("\n")[1:])
                if content.endswith("```"):
                    content = "\n".join(content.split("\n")[:-1])
                parsed = json.loads(content.strip())
            except Exception as e:
                logger.warning("[describe] LLM/parse failed for %s: %s", table_name, e)
                parsed = {}

        # Decide confidence / review state.
        confidence = str(parsed.get("confidence") or "").lower()
        needs_input = bool(parsed.get("needs_user_input"))
        table_desc = (parsed.get("table_description") or "").strip()
        question = (parsed.get("question_for_user") or "").strip()

        if not llm_config:
            needs_review = 1
            question = question or f"What is the dataset '{ds.name}' about, and what do its columns represent?"
        elif not table_desc or needs_input or confidence == "low":
            needs_review = 1
            question = question or f"I wasn't sure what '{ds.name}' represents. Can you tell me what this data is and what its key columns mean?"
        else:
            needs_review = 0

        # Persist. A user-provided description always wins and clears review.
        td = session.query(TableDescription).filter(
            TableDescription.table_name == table_name,
        ).first()
        if not td:
            td = TableDescription(table_name=table_name)
            session.add(td)
            session.flush()

        if user_provided_desc:
            td.description = user_provided_desc
            td.source = "user"
            td.confidence = "high"
            td.needs_review = 0
            td.review_question = None
        else:
            if table_desc:
                td.description = table_desc
            td.source = "ai"
            td.confidence = confidence or None
            td.needs_review = needs_review
            td.review_question = question if needs_review else None
        td.updated_at = _now()

        col_descs = parsed.get("columns") or {}
        lower_map = {c.lower(): c for c in columns}
        written = 0
        for raw_name, desc in col_descs.items():
            if not raw_name or not desc:
                continue
            matched = lower_map.get(str(raw_name).lower())
            if not matched:
                continue
            cd = session.query(ColumnDescription).filter(
                ColumnDescription.table_description_id == td.id,
                ColumnDescription.column_name == matched,
            ).first()
            if not cd:
                cd = ColumnDescription(table_description_id=td.id, column_name=matched, source="ai")
                session.add(cd)
            cd.description = str(desc).strip()
            cd.data_type = dtypes.get(matched)
            cd.source = "ai"
            cd.updated_at = _now()
            written += 1

        session.commit()
        db.save_to_disk()
        logger.info(
            "[describe] %s: confidence=%s needs_review=%s cols=%d",
            table_name, td.confidence, td.needs_review, written,
        )
        return {
            "table_name": table_name,
            "table_description": td.description,
            "confidence": td.confidence,
            "needs_review": bool(td.needs_review),
            "review_question": td.review_question,
            "columns_written": written,
        }
    except Exception as e:
        session.rollback()
        logger.exception("[describe] failed for %s", table_name)
        return {"error": str(e)}
    finally:
        session.close()
