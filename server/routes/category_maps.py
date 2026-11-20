"""Category map routes (list, get, upload, delete)."""
from __future__ import annotations

import hashlib
import io
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy.orm import Session

import db
from lib.auth import require_api_key
from lib.state import storage
from models.orm import CategoryMap

router = APIRouter()


@router.get("/api/category-maps")
async def list_category_maps(
    scenario_id: int | None = None,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
):
    query = session.query(CategoryMap)
    if scenario_id:
        from models.orm import ScenarioCategoryMap
        query = query.join(
            ScenarioCategoryMap,
            ScenarioCategoryMap.category_map_id == CategoryMap.id,
        ).filter(ScenarioCategoryMap.scenario_id == scenario_id)
    maps = query.all()
    return [
        {
            "id": cm.id,
            "name": cm.name,
            "display_name": cm.display_name,
            "description": cm.description,
            "entity_column": cm.entity_column,
            "category_column": cm.category_column,
            "colors": json.loads(cm.colors_json) if cm.colors_json else None,
            "extension_name": cm.extension_name,
        }
        for cm in maps
    ]


@router.get("/api/category-maps/{cm_id}")
async def get_category_map(cm_id: int, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    cm = session.query(CategoryMap).get(cm_id)
    if not cm:
        raise HTTPException(404, "Category map not found")

    result = {
        "id": cm.id,
        "name": cm.name,
        "display_name": cm.display_name,
        "description": cm.description,
        "entity_column": cm.entity_column,
        "category_column": cm.category_column,
        "colors": json.loads(cm.colors_json) if cm.colors_json else None,
        "extension_name": cm.extension_name,
    }

    if cm.extension_name and hasattr(request.app.state, 'duckdb_engine'):
        try:
            rows = request.app.state.duckdb_engine.query_json(
                f"SELECT DISTINCT {cm.entity_column}, {cm.category_column} "
                f"FROM ext_{cm.extension_name.replace('-', '_')}.catmap__{cm.name}"
            )
            result["mappings"] = rows
        except Exception:
            pass

    return result


@router.post("/api/category-maps")
async def upload_category_map(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(...),
    display_name: str = Form(""),
    description: str = Form(""),
    entity_column: str = Form(...),
    category_column: str = Form(...),
    colors_json: str = Form(""),
    scenario_id: int | None = Form(None),
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
):
    raw = file.file.read()
    sha = hashlib.sha256(raw).hexdigest()

    storage.put_bytes(f"uploads/category_map/{sha}", raw)

    try:
        cm = CategoryMap(
            name=name,
            display_name=display_name or name,
            description=description,
            entity_column=entity_column,
            category_column=category_column,
            content_hash=sha,
            colors_json=colors_json if colors_json else None,
        )
        session.add(cm)
        session.flush()

        if scenario_id:
            from models.orm import ScenarioCategoryMap
            session.add(ScenarioCategoryMap(
                scenario_id=scenario_id, category_map_id=cm.id
            ))

        if hasattr(request.app.state, 'duckdb_engine'):
            fname = file.filename or ""
            if fname.endswith(".parquet"):
                import pyarrow.parquet as pq
                tbl = pq.read_table(io.BytesIO(raw))
                request.app.state.duckdb_engine.conn.register(f"_catmap_{cm.id}", tbl)
            else:
                import pandas as pd
                df = pd.read_csv(io.BytesIO(raw))
                request.app.state.duckdb_engine.conn.register(f"_catmap_{cm.id}", df)
            request.app.state.duckdb_engine.conn.execute(
                "CREATE SCHEMA IF NOT EXISTS catmaps"
            )
            request.app.state.duckdb_engine.conn.execute(
                f"CREATE OR REPLACE VIEW catmaps.catmap_{cm.id} "
                f"AS SELECT * FROM _catmap_{cm.id}"
            )

        session.commit()
        db.save_to_disk()
        return {"id": cm.id, "name": cm.name}
    except Exception:
        session.rollback()
        raise


@router.delete("/api/category-maps/{cm_id}")
async def delete_category_map(cm_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        cm = session.query(CategoryMap).get(cm_id)
        if not cm:
            raise HTTPException(404, "Category map not found")
        session.delete(cm)
        session.commit()
        db.save_to_disk()
        return {"deleted": cm_id}
    except Exception:
        session.rollback()
        raise
