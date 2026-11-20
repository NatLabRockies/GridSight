"""User preferences — generic per-user key→JSON store.

Currently used for default map/layer styling (colormap, opacity, point color)
so layers created via the API/AI honor the user's taste instead of hardcoded
defaults. Single-tenant today (the default "admin" user), but keyed by user_id
so it generalizes when accounts arrive.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import db
from lib.auth import require_api_key
from lib.responses import make_response
from routes.extensions import _get_or_create_default_user
from models.orm import UserPreference

logger = logging.getLogger("gridsight")
router = APIRouter()

# Defaults applied when the user hasn't set a style preference.
DEFAULT_STYLE = {
    "colormap": "viridis",
    "opacity": 0.85,
    "point_color": [33, 150, 243, 200],  # RGBA
}


def get_user_style_prefs(session: Session) -> dict:
    """Return the effective style prefs (defaults merged with any saved values).
    Safe to call from layer-creation code — never raises."""
    out = dict(DEFAULT_STYLE)
    try:
        uid = _get_or_create_default_user(session)
        pref = session.query(UserPreference).filter(
            UserPreference.user_id == uid, UserPreference.key == "style",
        ).first()
        if pref and pref.value_json:
            saved = json.loads(pref.value_json)
            if isinstance(saved, dict):
                out.update({k: v for k, v in saved.items() if v is not None})
    except Exception:
        logger.debug("get_user_style_prefs failed; using defaults", exc_info=True)
    return out


@router.get("/api/preferences")
async def getPreferences(session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    uid = _get_or_create_default_user(session)
    rows = session.query(UserPreference).filter(UserPreference.user_id == uid).all()
    prefs = {}
    for r in rows:
        try:
            prefs[r.key] = json.loads(r.value_json)
        except Exception:
            prefs[r.key] = {}
    # Always expose effective style (defaults merged) for convenience.
    prefs.setdefault("style", {})
    prefs["style"] = {**DEFAULT_STYLE, **prefs.get("style", {})}
    return make_response(prefs)


@router.patch("/api/preferences/{key}")
async def setPreference(key: str, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    """Upsert a preference. Body is the JSON value (merged into any existing
    value for that key, so partial updates work — e.g. set just `colormap`)."""
    if not isinstance(body, dict):
        return make_response("preference value must be a JSON object", status=400)
    try:
        uid = _get_or_create_default_user(session)
        pref = session.query(UserPreference).filter(
            UserPreference.user_id == uid, UserPreference.key == key,
        ).first()
        existing = {}
        if pref and pref.value_json:
            try:
                existing = json.loads(pref.value_json)
            except Exception:
                existing = {}
        merged = {**existing, **body}
        now = datetime.now(timezone.utc).isoformat()
        if pref:
            pref.value_json = json.dumps(merged)
            pref.updated_at = now
        else:
            session.add(UserPreference(
                user_id=uid, key=key, value_json=json.dumps(merged), updated_at=now,
            ))
        session.commit()
        db.save_to_disk()
        return make_response({"key": key, "value": merged})
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)
