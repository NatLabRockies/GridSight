"""Layer + painting routes (CRUD, style mappings, quick-layer, datasets)."""
from __future__ import annotations

import hashlib
import io
import json
import logging
import math
from typing import Optional

import polars as pl
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import db
from lib.auth import require_api_key
from lib.responses import make_response
from lib.serializers import serialize_dataset, serialize_geometry, file_suffix
from lib.state import storage
from models.orm import (
    Dataset, GeometryFile, JoinHint, Layer, LayerDataset, LayerStyleMapping,
    Painting, Project, Scenario,
)

logger = logging.getLogger("meridian")
router = APIRouter()

# Qualitative palette for categorical layer coloring (Tableau-10-ish, RGBA).
_CATEGORICAL_PALETTE = [
    [78, 121, 167, 220], [242, 142, 43, 220], [89, 161, 79, 220],
    [225, 87, 89, 220], [118, 183, 178, 220], [237, 201, 72, 220],
    [176, 122, 161, 220], [255, 157, 167, 220], [156, 117, 95, 220],
    [0, 191, 196, 220], [186, 176, 172, 220], [255, 99, 255, 220],
]
_OTHER_COLOR = [158, 158, 158, 180]


def _resolve_category(raw, groups: dict | None) -> str:
    """Map a raw cell value to its category label. With groups, the value joins
    the first group having a case-insensitive substring match; unmatched →
    'Other'. Without groups, the raw string value is its own category."""
    s = "" if raw is None else str(raw)
    if groups:
        low = s.lower()
        for label, patterns in groups.items():
            for p in (patterns or []):
                if str(p).lower() in low:
                    return str(label)
        return "Other"
    return s if s != "" else "(none)"


# ---------------------------------------------------------------------------
# Pydantic bodies
# ---------------------------------------------------------------------------


class CreateLayerBody(BaseModel):
    project: str
    scenario: str
    geometry_id: int
    name: str
    deck_layer_type: str
    display_name: Optional[str] = None
    description: Optional[str] = None


class AttachDatasetBody(BaseModel):
    dataset_id: int
    geom_join_key: Optional[str] = None
    data_join_key: Optional[str] = None


class AddStyleMappingBody(BaseModel):
    layer_dataset_id: int
    visual_property: str
    column: str
    colormap: Optional[str] = None
    scale_type: Optional[str] = None
    domain_min: Optional[float] = None
    domain_max: Optional[float] = None
    category_map_id: Optional[int] = None
    aggregation_mode: Optional[str] = None
    shared_legend_group: Optional[str] = None


class UpdateStyleMappingBody(BaseModel):
    category_map_id: Optional[int] = None
    aggregation_mode: Optional[str] = None
    colormap: Optional[str] = None
    scale_type: Optional[str] = None
    domain_min: Optional[float] = None
    domain_max: Optional[float] = None
    column: Optional[str] = None
    shared_legend_group: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _find_or_create_scenario(session, project_name: str, scenario_name: str) -> int:
    proj = session.query(Project).filter(Project.name == project_name).first()
    if not proj:
        proj = Project(name=project_name, owner="system", public=1)
        session.add(proj)
        session.flush()

    scen = (
        session.query(Scenario)
        .filter(Scenario.project_id == proj.id, Scenario.name == scenario_name)
        .first()
    )
    if not scen:
        scen = Scenario(project_id=proj.id, name=scenario_name, public=1)
        session.add(scen)
        session.flush()

    return scen.id


def _serialize_layer_full(session, lyr, extension_name=None):
    geo = session.query(GeometryFile).filter(GeometryFile.id == lyr.geometry_id).first()
    lds = session.query(LayerDataset).filter(LayerDataset.layer_id == lyr.id).all()
    ld_role_lookup = {ld.id: ld.role for ld in lds}
    styles = session.query(LayerStyleMapping).filter(LayerStyleMapping.layer_id == lyr.id).all()
    return {
        "id": lyr.id,
        "name": lyr.name,
        "display_name": lyr.display_name,
        "deck_layer_type": lyr.deck_layer_type,
        "extension_name": extension_name,
        "source_type": getattr(lyr, "source_type", None),
        "source_extension": getattr(lyr, "source_extension", None),
        "geometry": serialize_geometry(geo) if geo else None,
        "layer_datasets": [
            {
                "id": ld.id,
                "dataset_id": ld.dataset_id,
                "geom_join_key": ld.geom_join_key,
                "data_join_key": ld.data_join_key,
                "role": ld.role,
                "dataset": serialize_dataset(
                    session.query(Dataset).filter(Dataset.id == ld.dataset_id).first()
                ),
            }
            for ld in lds
        ],
        "style_mappings": [
            {
                "id": s.id,
                "layer_dataset_id": s.layer_dataset_id,
                "visual_property": s.visual_property,
                "column": s.column,
                "colormap": s.colormap,
                "scale_type": s.scale_type,
                "domain_min": s.domain_min,
                "domain_max": s.domain_max,
                "category_map_id": s.category_map_id,
                "aggregation_mode": s.aggregation_mode,
                "dataset_role": ld_role_lookup.get(s.layer_dataset_id),
                "shared_legend_group": s.shared_legend_group,
            }
            for s in styles
        ],
        "default_style": (
            json.loads(lyr.default_style_json) if lyr.default_style_json else None
        ),
        # The layer's default painting (if the user marked one) — applied over
        # default_style on load so a saved look survives a reload.
        "default_painting": _default_painting_for(session, lyr.id),
    }


def _default_painting_for(session, layer_id):
    """The painting to auto-apply on load: the explicitly-marked default, or —
    when a layer has exactly one painting — that lone painting (implicit
    default). Returns None when there are several and none is marked."""
    rows = (
        session.query(Painting)
        .filter(Painting.layer_id == layer_id)
        .order_by(Painting.sort_order, Painting.id)
        .all()
    )
    if not rows:
        return None
    chosen = next((p for p in rows if p.is_default), None)
    if chosen is None and len(rows) == 1:
        chosen = rows[0]
    if chosen is None:
        return None
    try:
        style = json.loads(chosen.style_json)
    except Exception:
        style = {}
    return {"id": chosen.id, "name": chosen.name, "style": style}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/api/layers")
async def createLayer(body: CreateLayerBody, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        scenario_id = _find_or_create_scenario(session, body.project, body.scenario)
        layer = Layer(
            scenario_id=scenario_id,
            geometry_id=body.geometry_id,
            name=body.name,
            deck_layer_type=body.deck_layer_type,
            display_name=body.display_name,
            description=body.description,
        )
        session.add(layer)
        session.commit()
        session.refresh(layer)
        db.save_to_disk()
        return make_response({
            "id": layer.id,
            "name": layer.name,
            "deck_layer_type": layer.deck_layer_type,
            "geometry_id": layer.geometry_id,
            "scenario_id": layer.scenario_id,
        }, status=201)
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


class PointLayerBody(BaseModel):
    sql: str                              # SELECT producing lon/lat + property columns
    name: str
    lon_column: str = "longitude"
    lat_column: str = "latitude"
    radius_column: Optional[str] = None   # numeric column → bubble size
    color_column: Optional[str] = None    # numeric column → colormap fill
    colormap: str = ""                    # blank → use user style preference
    fill_color: Optional[list] = None     # static [r,g,b,a] when no color_column
    # Categorical coloring: color dots by a category column with a generated
    # qualitative palette + interactive legend. Takes precedence over
    # color_column. category_groups optionally merges raw values into labeled
    # buckets: {"Planned": ["Planned"], ...} — a raw value joins the first
    # group with a case-insensitive substring match; unmatched → "Other".
    category_column: Optional[str] = None
    category_groups: Optional[dict] = None
    radius_min_px: float = 4.0
    radius_max_px: float = 40.0
    project: str = "_catalog"
    scenario: str = "default"
    display_name: Optional[str] = None
    description: Optional[str] = None


@router.post("/api/layers/point")
async def createPointLayer(
    body: PointLayerBody,
    request: Request,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
):
    """Create a bubble (point) map layer from an arbitrary SELECT query.

    Runs the SQL against DuckDB, converts each row's lon/lat into a GeoJSON
    Point with the remaining columns as properties, and registers a user
    GeoJsonLayer. Bubble radius is precomputed in pixels (sqrt-scaled so area
    is proportional to the value) and color is mapped from an optional numeric
    column. No geometry upload or dataset join required by the caller.
    """
    engine = request.app.state.duckdb_engine
    try:
        rows = engine.query_json(body.sql)
    except Exception as e:
        return make_response(f"query failed: {e}", status=400)
    if not rows:
        return make_response("query returned no rows", status=400)

    lon_c, lat_c = body.lon_column, body.lat_column
    cols = list(rows[0].keys())
    if lon_c not in cols or lat_c not in cols:
        return make_response(
            f"lon/lat columns '{lon_c}'/'{lat_c}' not in result columns {cols}",
            status=400,
        )

    # Radius scaling: sqrt so circle AREA is ~proportional to the value.
    rcol = body.radius_column
    rvals = []
    if rcol:
        for r in rows:
            try:
                fv = float(r.get(rcol))
                if math.isfinite(fv) and fv > 0:
                    rvals.append(fv)
            except (TypeError, ValueError):
                pass
    smin = math.sqrt(min(rvals)) if rvals else 0.0
    smax = math.sqrt(max(rvals)) if rvals else 0.0

    def _radius_px(v) -> float:
        try:
            fv = float(v)
        except (TypeError, ValueError):
            return body.radius_min_px
        if not math.isfinite(fv) or fv <= 0 or smax <= smin:
            return body.radius_min_px
        frac = (math.sqrt(fv) - smin) / (smax - smin)
        return round(body.radius_min_px + frac * (body.radius_max_px - body.radius_min_px), 2)

    # Color domain (numeric color column only).
    ccol = body.color_column
    cvals = []
    if ccol:
        for r in rows:
            try:
                cvals.append(float(r.get(ccol)))
            except (TypeError, ValueError):
                pass
    cmin = min(cvals) if cvals else 0.0
    cmax = max(cvals) if cvals else 1.0

    catcol = body.category_column
    cat_labels: set[str] = set()

    features = []
    for r in rows:
        lon, lat = r.get(lon_c), r.get(lat_c)
        try:
            lonf, latf = float(lon), float(lat)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(lonf) and math.isfinite(latf)):
            continue
        props = {k: v for k, v in r.items() if k not in (lon_c, lat_c)}
        if rcol:
            props["__radius_px"] = _radius_px(r.get(rcol))
        if catcol:
            label = _resolve_category(r.get(catcol), body.category_groups)
            props["__category"] = label
            cat_labels.add(label)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lonf, latf]},
            "properties": props,
        })
    if not features:
        return make_response("no valid lat/lon points in query result", status=400)

    geojson_bytes = json.dumps(
        {"type": "FeatureCollection", "features": features}, default=str
    ).encode("utf-8")
    sha = hashlib.sha256(geojson_bytes).hexdigest()
    try:
        content_hash = storage.upload_file("geometry", sha, geojson_bytes)
    except Exception as e:
        return make_response(f"storage error: {e}", status=500)

    join_key = "id" if "id" in features[0]["properties"] else None

    # User style preferences supply defaults (colormap, opacity, point color)
    # when the caller didn't specify them.
    from routes.preferences import get_user_style_prefs

    prefs = get_user_style_prefs(session)
    colormap = body.colormap or prefs.get("colormap", "viridis")

    # Build the categorical palette (generated qualitative colors → interactive
    # legend). "Other" always renders gray; the rest get distinct palette colors
    # in sorted order for stable assignment.
    category_colors: dict = {}
    if catcol:
        labels = sorted(lbl for lbl in cat_labels if lbl != "Other")
        for i, lbl in enumerate(labels):
            category_colors[lbl] = _CATEGORICAL_PALETTE[i % len(_CATEGORICAL_PALETTE)]
        if "Other" in cat_labels:
            category_colors["Other"] = _OTHER_COLOR

    default_style: dict = {
        "radiusUnits": "pixels",
        "radiusScale": 1,
        "radiusMinPixels": 1,
        "radiusMaxPixels": max(body.radius_max_px + 8, 60),
        "staticRadius": body.radius_min_px,
        "stroked": True,
        "staticLineColor": [255, 255, 255, 140],
        "opacity": prefs.get("opacity", 0.85),
        "interaction": {"hoverContent": ["infocard"], "clickContent": ["infocard"]},
        "geoMappings": {},
    }
    if rcol:
        default_style["geoMappings"]["getPointRadius"] = {
            "property": "__radius_px",
            "scale_type": "linear",
        }
    if catcol and category_colors:
        # Categorical fill → drives the interactive legend (LegendPanel reads
        # geoMappings categorical). Map renders via resolveStyle geoMappings.
        default_style["geoMappings"]["getFillColor"] = {
            "property": "__category",
            "scale_type": "categorical",
            "categoryColors": category_colors,
            "label": catcol,  # friendly legend title (the source column name)
        }
    elif ccol:
        default_style["geoMappings"]["getFillColor"] = {
            "property": ccol,
            "colormap": colormap,
            "scale_type": "linear",
            "domain_min": cmin,
            "domain_max": cmax,
        }
    else:
        default_style["staticFillColor"] = body.fill_color or prefs.get("point_color", [33, 150, 243, 200])

    try:
        geo = GeometryFile(
            name=body.name,
            content_hash=content_hash,
            original_filename=f"{body.name}.geojson",
            format="geojson",
            join_key=join_key,
            scope="scenario",
            display_name=body.display_name or body.name,
            description=body.description,
        )
        session.add(geo)
        session.flush()

        scenario_id = _find_or_create_scenario(session, body.project, body.scenario)
        layer = Layer(
            scenario_id=scenario_id,
            geometry_id=geo.id,
            name=body.name.lower().replace(" ", "-"),
            deck_layer_type="GeoJsonLayer",
            display_name=body.display_name or body.name,
            description=body.description,
            source_type="user",
            default_style_json=json.dumps(default_style),
        )
        session.add(layer)
        session.commit()
        session.refresh(layer)
        session.refresh(geo)
        db.save_to_disk()
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)

    return make_response({
        "id": layer.id,
        "name": layer.name,
        "display_name": layer.display_name,
        "deck_layer_type": layer.deck_layer_type,
        "source_type": layer.source_type,
        "geometry_id": geo.id,
        "scenario_id": layer.scenario_id,
        "feature_count": len(features),
        "radius_column": rcol,
        "color_column": ccol,
        "category_column": catcol,
        "categories": (
            {lbl: cat_counts for lbl, cat_counts in sorted(
                ((l, sum(1 for f in features if f["properties"].get("__category") == l))
                 for l in cat_labels), key=lambda x: -x[1])}
            if catcol else None
        ),
    }, status=201)


@router.post("/api/geometry/{geo_id}/quick-layer")
async def quickLayerFromGeometry(geo_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        geo = session.query(GeometryFile).filter(GeometryFile.id == geo_id).first()
        if not geo:
            return make_response("geometry not found", status=404)

        geo_style_property = None
        geo_domain_min = None
        geo_domain_max = None
        geo_property_cols = []
        if geo.content_hash:
            try:
                raw = storage.read_file_bytes(geo.content_hash)
                geojson_data = json.loads(raw)
                features = geojson_data.get("features", [])
                if features:
                    geo_property_cols = list(features[0].get("properties", {}).keys())
                    for prop in geo_property_cols:
                        if prop == geo.join_key:
                            continue
                        sample_vals = []
                        is_numeric = True
                        for f in features[:200]:
                            v = f.get("properties", {}).get(prop)
                            if v is not None:
                                try:
                                    sample_vals.append(float(v))
                                except (ValueError, TypeError):
                                    is_numeric = False
                                    break
                        if is_numeric and sample_vals:
                            geo_style_property = prop
                            geo_domain_min = min(sample_vals)
                            geo_domain_max = max(sample_vals)
                            break
            except Exception:
                logger.debug("Could not inspect geometry %d properties", geo_id, exc_info=True)

        deck_type = "GeoJsonLayer"
        is_point = False
        if geo.content_hash:
            try:
                raw = storage.read_file_bytes(geo.content_hash)
                geojson_data = json.loads(raw)
                features = geojson_data.get("features", [])
                if features:
                    geo_type = features[0].get("geometry", {}).get("type", "")
                    is_point = geo_type in ("Point", "MultiPoint")
            except Exception:
                pass

        default_style = {}
        if geo_style_property:
            default_style["geoMappings"] = {
                "getFillColor": {
                    "property": geo_style_property,
                    "colormap": "viridis",
                    "scale_type": "linear",
                    "domain_min": geo_domain_min,
                    "domain_max": geo_domain_max,
                },
            }
        if is_point:
            default_style["staticRadius"] = 4

        scenario_id = _find_or_create_scenario(session, "_catalog", "default")

        layer = Layer(
            scenario_id=scenario_id,
            geometry_id=geo.id,
            name=geo.name.lower().replace(" ", "-"),
            deck_layer_type=deck_type,
            display_name=geo.display_name or geo.name,
            source_type="user",
            default_style_json=json.dumps(default_style) if default_style else None,
        )
        session.add(layer)
        session.flush()

        best_hint = (
            session.query(JoinHint)
            .filter(JoinHint.geometry_id == geo.id, JoinHint.status != "rejected")
            .order_by(JoinHint.overlap.desc())
            .first()
        )

        if best_hint:
            ds = session.query(Dataset).filter(Dataset.id == best_hint.dataset_id).first()
            if ds:
                ld = LayerDataset(
                    layer_id=layer.id,
                    dataset_id=ds.id,
                    geom_join_key=best_hint.geometry_key,
                    data_join_key=best_hint.dataset_column,
                )
                session.add(ld)
                session.flush()

                try:
                    ds_raw = storage.read_file_bytes(ds.content_hash)
                    suffix = file_suffix(ds.original_filename)
                    ds_df = (
                        pl.read_parquet(io.BytesIO(ds_raw), n_rows=5)
                        if suffix == "parquet"
                        else pl.read_csv(io.BytesIO(ds_raw), n_rows=5)
                    )
                    for col in ds_df.columns:
                        if col == best_hint.dataset_column:
                            continue
                        if ds_df[col].dtype.is_numeric():
                            sm = LayerStyleMapping(
                                layer_id=layer.id,
                                layer_dataset_id=ld.id,
                                visual_property="getFillColor",
                                column=col,
                                colormap="viridis",
                                scale_type="linear",
                            )
                            session.add(sm)
                            break
                except Exception:
                    pass

        session.commit()
        session.refresh(layer)
        db.save_to_disk()

        lds = session.query(LayerDataset).filter(LayerDataset.layer_id == layer.id).all()
        styles = session.query(LayerStyleMapping).filter(LayerStyleMapping.layer_id == layer.id).all()
        result = {
            "id": layer.id,
            "name": layer.name,
            "display_name": layer.display_name,
            "deck_layer_type": layer.deck_layer_type,
            "source_type": layer.source_type,
            "geometry": serialize_geometry(geo),
            "geometry_properties": geo_property_cols,
            "layer_datasets": [
                {
                    "id": ld_row.id,
                    "dataset_id": ld_row.dataset_id,
                    "geom_join_key": ld_row.geom_join_key,
                    "data_join_key": ld_row.data_join_key,
                    "dataset": serialize_dataset(
                        session.query(Dataset).filter(Dataset.id == ld_row.dataset_id).first()
                    ),
                }
                for ld_row in lds
            ],
            "style_mappings": [
                {
                    "id": s.id,
                    "layer_dataset_id": s.layer_dataset_id,
                    "visual_property": s.visual_property,
                    "column": s.column,
                    "colormap": s.colormap,
                    "scale_type": s.scale_type,
                    "domain_min": s.domain_min,
                    "domain_max": s.domain_max,
                }
                for s in styles
            ],
            "default_style": default_style,
            "scenario": {"project": "_catalog", "scenario": "default"},
        }
        return make_response(result, status=201)

    except Exception as e:
        session.rollback()
        logging.exception("quick-layer failed for geometry %d", geo_id)
        return make_response(str(e), status=500)


# Paintings — MUST be registered before /api/layers/{project}/{scenario}.


@router.get("/api/layers/{layer_id}/paintings")
async def listPaintings(layer_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    rows = (
        session.query(Painting)
        .filter(Painting.layer_id == layer_id)
        .order_by(Painting.sort_order, Painting.id)
        .all()
    )
    return [
        {"id": r.id, "name": r.name, "style": json.loads(r.style_json),
         "is_default": bool(getattr(r, "is_default", False))}
        for r in rows
    ]


@router.post("/api/layers/{layer_id}/paintings")
async def createPainting(layer_id: int, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    name = body.get("name", "").strip()
    style = body.get("style", {})
    if not name:
        raise HTTPException(400, "name is required")
    max_order = (
        session.query(Painting.sort_order)
        .filter(Painting.layer_id == layer_id)
        .order_by(Painting.sort_order.desc())
        .first()
    )
    order = (max_order[0] + 1) if max_order else 0
    p = Painting(
        layer_id=layer_id,
        name=name,
        style_json=json.dumps(style),
        sort_order=order,
    )
    session.add(p)
    session.commit()
    db.save_to_disk()
    return {"id": p.id, "name": p.name, "style": style, "is_default": bool(p.is_default)}


@router.get("/api/layers/all")
async def getAllLayers(session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    layers = session.query(Layer).all()
    result = []
    for lyr in layers:
        scen = session.query(Scenario).filter(Scenario.id == lyr.scenario_id).first()
        proj = session.query(Project).filter(Project.id == scen.project_id).first() if scen else None
        entry = _serialize_layer_full(session, lyr, extension_name=proj.extension_name if proj else None)
        entry["project"] = proj.name if proj else None
        entry["scenario"] = scen.name if scen else None
        result.append(entry)
    return make_response(result)


@router.get("/api/layers/{project}/{scenario}")
async def getScenarioLayers(project: str, scenario: str, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    proj = session.query(Project).filter(Project.name == project).first()
    if not proj:
        return make_response([])

    scen = (
        session.query(Scenario)
        .filter(Scenario.project_id == proj.id, Scenario.name == scenario)
        .first()
    )
    if not scen:
        return make_response([])

    layers = session.query(Layer).filter(Layer.scenario_id == scen.id).all()
    result = [_serialize_layer_full(session, lyr, extension_name=proj.extension_name) for lyr in layers]
    return make_response(result)


@router.post("/api/layers/{layer_id}/datasets")
async def attachDatasetToLayer(layer_id: int, body: AttachDatasetBody, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        ld = LayerDataset(
            layer_id=layer_id,
            dataset_id=body.dataset_id,
            geom_join_key=body.geom_join_key,
            data_join_key=body.data_join_key,
        )
        session.add(ld)
        session.commit()
        session.refresh(ld)
        db.save_to_disk()
        return make_response({"id": ld.id, "layer_id": ld.layer_id, "dataset_id": ld.dataset_id}, status=201)
    except Exception as e:
        logging.exception("attachDatasetToLayer failed")
        session.rollback()
        return make_response(str(e), status=500)


@router.post("/api/layers/{layer_id}/style")
async def addLayerStyleMapping(layer_id: int, body: AddStyleMappingBody, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        sm = LayerStyleMapping(
            layer_id=layer_id,
            layer_dataset_id=body.layer_dataset_id,
            visual_property=body.visual_property,
            column=body.column,
            colormap=body.colormap,
            scale_type=body.scale_type,
            domain_min=body.domain_min,
            domain_max=body.domain_max,
            category_map_id=body.category_map_id,
            aggregation_mode=body.aggregation_mode,
            shared_legend_group=body.shared_legend_group,
        )
        session.add(sm)
        session.commit()
        session.refresh(sm)
        db.save_to_disk()
        return make_response({"id": sm.id}, status=201)
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.delete("/api/layers/{layer_id}/style/{style_id}")
async def deleteLayerStyleMapping(layer_id: int, style_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        sm = (
            session.query(LayerStyleMapping)
            .filter(LayerStyleMapping.id == style_id, LayerStyleMapping.layer_id == layer_id)
            .first()
        )
        if not sm:
            return make_response("not found", status=404)
        session.delete(sm)
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.patch("/api/layers/{layer_id}/style/{style_id}")
async def updateLayerStyleMapping(layer_id: int, style_id: int, body: UpdateStyleMappingBody, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        sm = (
            session.query(LayerStyleMapping)
            .filter(LayerStyleMapping.id == style_id, LayerStyleMapping.layer_id == layer_id)
            .first()
        )
        if not sm:
            return make_response("not found", status=404)
        for field in ("category_map_id", "aggregation_mode", "colormap", "scale_type", "domain_min", "domain_max", "column", "shared_legend_group"):
            if field in body.model_fields_set:
                setattr(sm, field, getattr(body, field))
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.delete("/api/layers/{layer_id}")
async def deleteLayer(layer_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        layer = session.query(Layer).filter(Layer.id == layer_id).first()
        if not layer:
            return make_response("not found", status=404)
        session.delete(layer)
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.patch("/api/paintings/{painting_id}")
async def updatePainting(painting_id: int, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    p = session.query(Painting).get(painting_id)
    if not p:
        raise HTTPException(404, "Painting not found")
    if "name" in body:
        p.name = body["name"].strip() or p.name
    if "style" in body:
        p.style_json = json.dumps(body["style"])
    if "is_default" in body:
        if body["is_default"]:
            # Exactly one default per layer — clear the others first.
            session.query(Painting).filter(
                Painting.layer_id == p.layer_id, Painting.id != p.id,
            ).update({"is_default": False})
            p.is_default = True
        else:
            p.is_default = False
    session.commit()
    db.save_to_disk()
    return {"id": p.id, "name": p.name, "style": json.loads(p.style_json),
            "is_default": bool(p.is_default)}


@router.delete("/api/paintings/{painting_id}")
async def deletePainting(painting_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    p = session.query(Painting).get(painting_id)
    if not p:
        raise HTTPException(404, "Painting not found")
    session.delete(p)
    session.commit()
    db.save_to_disk()
    return {"ok": True}
