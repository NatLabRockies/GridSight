"""Perspective and story routes."""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import db
from lib.auth import require_api_key
from lib.lineage import LineageManager
from lib.responses import make_response
from models.orm import Layer, Perspective, Project, Scenario, Story, StoryStep

logger = logging.getLogger("meridian")
router = APIRouter()


def _serialize_story(s: Story) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "guiding_prompt": getattr(s, "guiding_prompt", None),
        "owner": s.owner,
        "project_id": s.project_id,
    }


def _parse_prompts(raw: str | None) -> list[str]:
    """Decode the stored suggested_prompts JSON into a list of strings.
    Tolerates legacy/garbage values by returning an empty list."""
    if not raw:
        return []
    try:
        val = json.loads(raw)
        return [str(p) for p in val if str(p).strip()] if isinstance(val, list) else []
    except Exception:
        return []


def _dump_prompts(value) -> str | None:
    """Encode an incoming suggested_prompts value (a list of strings) to a
    JSON string for storage. None/empty becomes NULL."""
    if value is None:
        return None
    if isinstance(value, str):
        # Accept a pre-serialized JSON string as-is.
        return value or None
    try:
        cleaned = [str(p).strip() for p in value if str(p).strip()]
        return json.dumps(cleaned) if cleaned else None
    except Exception:
        return None


def _serialize_step(st: StoryStep, persp: Perspective | None = None) -> dict:
    out = {
        "id": st.id,
        "story_id": st.story_id,
        "perspective_id": st.perspective_id,
        "sort_order": st.sort_order,
        "transition_type": st.transition_type,
        "transition_duration_ms": st.transition_duration_ms,
        "narration": st.narration,
        "auto_advance_ms": st.auto_advance_ms,
        "suggested_prompts": _parse_prompts(st.suggested_prompts),
    }
    if persp is not None:
        out["perspective"] = {
            "id": persp.id,
            "name": persp.name,
            "description": persp.description,
            "config_json": persp.config_json,
        }
    return out


@router.get("/api/perspectives")
async def listPerspectives(project_id: int | None = None, scenario_id: int | None = None, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    q = session.query(Perspective)
    if project_id is not None:
        q = q.filter(Perspective.project_id == project_id)
    if scenario_id is not None:
        q = q.filter(Perspective.scenario_id == scenario_id)
    cps = q.all()
    return make_response([
        {"id": cp.id, "name": cp.name, "description": cp.description, "owner": cp.owner, "config_json": cp.config_json}
        for cp in cps
    ])


@router.post("/api/perspectives")
async def createPerspective(body: dict, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        config_json = json.dumps(body["config"]) if isinstance(body.get("config"), (list, dict)) else body.get("config_json", "[]")
        cp = Perspective(
            name=body["name"],
            description=body.get("description", ""),
            owner=body.get("owner", "admin"),
            project_id=body.get("project_id"),
            scenario_id=body.get("scenario_id"),
            config_json=config_json,
        )
        session.add(cp)
        session.commit()
        session.refresh(cp)
        db.save_to_disk()

        try:
            from lib.lineage.manager import CreatorType
            lm: LineageManager = request.app.state.lineage_manager
            lm.record_perspective_lineage(
                perspective_id=cp.id,
                perspective_name=cp.name,
                config_json=config_json,
                creator_type=CreatorType.USER,
                creator_user_id=lm.get_default_user_id(),
                project_id=body.get("project_id"),
                scenario_id=body.get("scenario_id"),
            )
        except Exception:
            logger.warning("Failed to record perspective lineage", exc_info=True)

        return make_response({"id": cp.id}, status=201)
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.get("/api/perspectives/{perspective_id}")
async def getPerspective(perspective_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    cp = session.query(Perspective).filter(Perspective.id == perspective_id).first()
    if not cp:
        raise HTTPException(404, "Perspective not found")
    return make_response({"id": cp.id, "name": cp.name, "description": cp.description, "owner": cp.owner, "config_json": cp.config_json})


@router.patch("/api/perspectives/{perspective_id}")
async def updatePerspective(perspective_id: int, body: dict, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        cp = session.query(Perspective).filter(Perspective.id == perspective_id).first()
        if not cp:
            raise HTTPException(404, "Perspective not found")
        if "name" in body:
            cp.name = body["name"]
        if "description" in body:
            cp.description = body["description"]

        config_changed = False
        if "config" in body:
            cp.config_json = json.dumps(body["config"])
            config_changed = True
        elif "config_json" in body:
            cp.config_json = body["config_json"]
            config_changed = True

        session.commit()
        db.save_to_disk()

        if config_changed:
            try:
                from lib.lineage.manager import CreatorType
                lm: LineageManager = request.app.state.lineage_manager
                lm.clear_perspective_lineage(perspective_id)
                lm.record_perspective_lineage(
                    perspective_id=cp.id,
                    perspective_name=cp.name,
                    config_json=cp.config_json,
                    creator_type=CreatorType.USER,
                    creator_user_id=lm.get_default_user_id(),
                    project_id=cp.project_id,
                    scenario_id=cp.scenario_id,
                )
            except Exception:
                logger.warning("Failed to update perspective lineage", exc_info=True)

        return make_response({"ok": True})
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.delete("/api/perspectives/{perspective_id}")
async def deletePerspective(perspective_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        cp = session.query(Perspective).filter(Perspective.id == perspective_id).first()
        if not cp:
            raise HTTPException(404, "Perspective not found")
        session.delete(cp)
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


# ---------------------------------------------------------------------------
# Stories
# ---------------------------------------------------------------------------


@router.get("/api/stories")
async def listStories(project_id: int | None = None, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    q = session.query(Story)
    if project_id is not None:
        # Include global (project-less) stories so a story seeded without a
        # project — e.g. the "AI Test Drive" — shows in every project's picker.
        from sqlalchemy import or_
        q = q.filter(or_(Story.project_id == project_id, Story.project_id.is_(None)))
    return make_response([_serialize_story(s) for s in q.all()])


@router.post("/api/stories")
async def createStory(body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        s = Story(
            name=body["name"],
            description=body.get("description", ""),
            guiding_prompt=body.get("guiding_prompt"),
            owner=body.get("owner", "admin"),
            project_id=body.get("project_id"),
        )
        session.add(s)
        session.commit()
        session.refresh(s)
        db.save_to_disk()
        return make_response({"id": s.id}, status=201)
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.get("/api/stories/{story_id}")
async def getStory(story_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    s = session.query(Story).filter(Story.id == story_id).first()
    if not s:
        raise HTTPException(404, "Story not found")
    return make_response(_serialize_story(s))


@router.patch("/api/stories/{story_id}")
async def updateStory(story_id: int, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        s = session.query(Story).filter(Story.id == story_id).first()
        if not s:
            raise HTTPException(404, "Story not found")
        if "name" in body: s.name = body["name"]
        if "description" in body: s.description = body["description"]
        if "guiding_prompt" in body: s.guiding_prompt = body["guiding_prompt"]
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.delete("/api/stories/{story_id}")
async def deleteStory(story_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        s = session.query(Story).filter(Story.id == story_id).first()
        if not s:
            raise HTTPException(404, "Story not found")
        session.query(StoryStep).filter(StoryStep.story_id == story_id).delete()
        session.delete(s)
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.get("/api/stories/{story_id}/steps")
async def listStorySteps(story_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    steps = (session.query(StoryStep, Perspective)
             .join(Perspective, Perspective.id == StoryStep.perspective_id)
             .filter(StoryStep.story_id == story_id)
             .order_by(StoryStep.sort_order.asc(), StoryStep.id.asc())
             .all())
    return make_response([_serialize_step(st, p) for (st, p) in steps])


@router.post("/api/stories/{story_id}/steps")
async def addStoryStep(story_id: int, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        if not session.query(Story).filter(Story.id == story_id).first():
            raise HTTPException(404, "Story not found")
        if "perspective_id" not in body:
            raise HTTPException(400, "perspective_id required")
        if not session.query(Perspective).filter(Perspective.id == body["perspective_id"]).first():
            raise HTTPException(404, "Perspective not found")

        sort_order = body.get("sort_order")
        if sort_order is None:
            from sqlalchemy import func
            current_max = (session.query(func.max(StoryStep.sort_order))
                           .filter(StoryStep.story_id == story_id).scalar())
            sort_order = (current_max or 0) + 1

        st = StoryStep(
            story_id=story_id,
            perspective_id=body["perspective_id"],
            sort_order=sort_order,
            transition_type=body.get("transition_type", "fade"),
            transition_duration_ms=body.get("transition_duration_ms", 1000),
            narration=body.get("narration"),
            auto_advance_ms=body.get("auto_advance_ms"),
            suggested_prompts=_dump_prompts(body.get("suggested_prompts")),
        )
        session.add(st)
        session.commit()
        session.refresh(st)
        db.save_to_disk()
        return make_response({"id": st.id}, status=201)
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.patch("/api/stories/{story_id}/steps/{step_id}")
async def updateStoryStep(story_id: int, step_id: int, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        st = (session.query(StoryStep)
              .filter(StoryStep.id == step_id, StoryStep.story_id == story_id)
              .first())
        if not st:
            raise HTTPException(404, "Story step not found")
        for key in ("perspective_id", "sort_order", "transition_type",
                    "transition_duration_ms", "narration", "auto_advance_ms"):
            if key in body:
                setattr(st, key, body[key])
        if "suggested_prompts" in body:
            st.suggested_prompts = _dump_prompts(body["suggested_prompts"])
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.delete("/api/stories/{story_id}/steps/{step_id}")
async def deleteStoryStep(story_id: int, step_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        st = (session.query(StoryStep)
              .filter(StoryStep.id == step_id, StoryStep.story_id == story_id)
              .first())
        if not st:
            raise HTTPException(404, "Story step not found")
        session.delete(st)
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.put("/api/stories/{story_id}/steps/reorder")
async def reorderStorySteps(story_id: int, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        ids = body.get("ordering") or []
        steps = {s.id: s for s in (session.query(StoryStep)
                                    .filter(StoryStep.story_id == story_id).all())}
        for i, step_id in enumerate(ids):
            s = steps.get(step_id)
            if s is not None:
                s.sort_order = i
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


# ---------------------------------------------------------------------------
# Story bundles (export / import)
# ---------------------------------------------------------------------------
#
# A story is only a list of steps pointing at perspective ROWS, so the story
# rows alone are meaningless on another machine — the perspective ids won't
# match, if they exist at all. A bundle inlines each step's full perspective
# (including config_json) so the file is self-contained and portable: export
# on one instance, import on another, no shared database.
#
# Portability rests on config_json referencing scenarios/layers/extensions by
# NAME rather than by row id. Anything the config names but the target instance
# lacks (an uninstalled extension, a missing dataset) still can't be conjured
# up — import reports those as warnings rather than failing, so a partially
# satisfiable story still lands and says what's missing.

BUNDLE_FORMAT = "meridian.story"
# v2 replaced numeric layer ids in perspective configs with portable
# "project::scenario::layer" refs and added a `requirements` block. v1 bundles
# still import, but their layer visibility/style can't be remapped — the ids
# mean whatever they happen to mean on the target instance.
BUNDLE_VERSION = 2
LAYER_REF_SEP = "::"

# Perspective config keys under `layers` that are dicts keyed by layer id.
_LAYER_KEYED = ("visibility", "localStyle", "opacity", "order")


def _layer_ref(layer: Layer, scen: Scenario | None, proj: Project | None) -> str:
    """Portable identity for a layer: project::scenario::name. Layer names are
    only unique within a scenario, so the qualification matters — two projects
    can each have a 'transmission' layer."""
    return LAYER_REF_SEP.join([
        (proj.name if proj else ""), (scen.name if scen else ""), layer.name,
    ])


def _layer_ref_index(session: Session) -> tuple[dict[int, str], dict[str, int]]:
    """Both directions at once: {layer_id: ref} and {ref: layer_id}."""
    rows = (session.query(Layer, Scenario, Project)
            .outerjoin(Scenario, Scenario.id == Layer.scenario_id)
            .outerjoin(Project, Project.id == Scenario.project_id)
            .all())
    by_id: dict[int, str] = {}
    by_ref: dict[str, int] = {}
    for layer, scen, proj in rows:
        ref = _layer_ref(layer, scen, proj)
        by_id[layer.id] = ref
        by_ref.setdefault(ref, layer.id)
    return by_id, by_ref


def _rewrite_layer_keys(config: dict, mapping: dict, *, drop_missing: bool) -> list[str]:
    """Rewrite the layer-keyed dicts in a perspective config through `mapping`
    (id->ref on export, ref->id on import). Returns human-readable notes about
    anything that couldn't be translated. Mutates `config` in place."""
    notes: list[str] = []
    layers = config.get("layers")
    if not isinstance(layers, dict):
        return notes
    for key in _LAYER_KEYED:
        section = layers.get(key)
        if not isinstance(section, dict):
            continue
        out = {}
        for k, v in section.items():
            # ids arrive as ints or numeric strings depending on JSON round-trip
            lookup = mapping.get(k, mapping.get(str(k)))
            if lookup is None:
                try:
                    lookup = mapping.get(int(k))
                except (TypeError, ValueError):
                    lookup = None
            if lookup is None:
                # Note the LAYER, not the layer x section x chapter product —
                # a story with 7 chapters would otherwise emit the same missing
                # layer dozens of times and bury the useful warnings.
                notes.append(str(k))
                if drop_missing:
                    continue
                out[str(k)] = v          # export: keep the raw id, flag it
            else:
                out[str(lookup)] = v
        layers[key] = out
    return notes


# Fingerprints shell out to git and walk site-packages, so compute once per
# process — extensions don't change version while the server is running.
_EXT_FINGERPRINTS: dict[str, dict] = {}


def _ext_fingerprint(registry, name: str) -> dict:
    """Identify the exact build of an extension a story was authored against.

    A story is view state over an extension's data model, so "has GAT" is not
    the same guarantee as "has the GAT this story was built on" — a renamed
    layer or reshaped table between versions renders the story wrong rather
    than empty. We record semver (from the manifest), the installed
    distribution version, and the source commit where we can find one:
    extensions are installed editable from sibling git repos in dev and from
    pinned `git+https` refs in the container, so a commit is usually available
    and is the only truly precise identifier.
    """
    if name in _EXT_FINGERPRINTS:
        return _EXT_FINGERPRINTS[name]

    info: dict = {"name": name}
    ext = registry.get(name) if registry is not None else None
    if ext is None:
        _EXT_FINGERPRINTS[name] = info
        return info
    try:
        info["version"] = ext.get_manifest().version
    except Exception:
        pass

    try:
        import subprocess
        import sys as _sys
        from importlib.metadata import distributions
        from pathlib import Path as _Path

        mod = _sys.modules.get(type(ext).__module__)
        src = _Path(getattr(mod, "__file__", "") or "").resolve()
        top = type(ext).__module__.split(".")[0]

        for dist in distributions():
            try:
                if (dist.metadata["Name"] or "").lower().replace("-", "_") == top.lower() \
                        or top in {(f.parts[0] if f.parts else "") for f in (dist.files or [])}:
                    info["distribution"] = dist.metadata["Name"]
                    info["dist_version"] = dist.version
                    break
            except Exception:
                continue

        # Editable installs point at a working tree: record the commit, and
        # whether it had uncommitted changes (a "commit" that isn't reproducible).
        d = src.parent
        while d != d.parent:
            if (d / ".git").exists():
                def _git(*a):
                    return subprocess.run(["git", "-C", str(d), *a], capture_output=True,
                                          text=True, timeout=5).stdout.strip()
                commit = _git("rev-parse", "HEAD")
                if commit:
                    info["commit"] = commit
                    info["dirty"] = bool(_git("status", "--porcelain"))
                    origin = _git("config", "--get", "remote.origin.url")
                    if origin:
                        info["repo"] = origin
                break
            d = d.parent
    except Exception:
        logger.debug("[story-export] could not fingerprint extension %s", name, exc_info=True)

    _EXT_FINGERPRINTS[name] = info
    return info


def _requirements(configs: list[dict], layer_refs: set[str], registry=None) -> dict:
    """What a target instance must already have for this story to render.

    A bundle carries VIEW STATE, never the underlying data — a GAT PCM run or a
    forecast parquet stays where it lives. Recording the dependencies explicitly
    is what lets import fail loudly instead of drawing an empty map.
    """
    exts: set[str] = set()
    scenarios: list[dict] = []
    seen_scen: set[tuple] = set()
    for c in configs:
        ext_block = c.get("extensions") or {}
        for name in (ext_block.get("enabled") or []):
            exts.add(str(name))
        ctrls = c.get("controls") or {}
        if isinstance(ctrls, dict) and ctrls.get("extName"):
            exts.add(str(ctrls["extName"]))
        scen = c.get("scenario") or {}
        if isinstance(scen, dict) and (scen.get("project") or scen.get("scenario")):
            key = (scen.get("project"), scen.get("scenario"))
            if key not in seen_scen:
                seen_scen.add(key)
                scenarios.append({"project": scen.get("project"),
                                  "scenario": scen.get("scenario")})
    return {
        "extensions": [_ext_fingerprint(registry, n) for n in sorted(exts)],
        "scenarios": scenarios,
        "layers": sorted(layer_refs),
    }


@router.get("/api/stories/{story_id}/export")
async def exportStory(story_id: int, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    """Return a self-contained, shareable JSON bundle for one story."""
    s = session.query(Story).filter(Story.id == story_id).first()
    if not s:
        raise HTTPException(404, "Story not found")

    steps = (session.query(StoryStep, Perspective)
             .outerjoin(Perspective, Perspective.id == StoryStep.perspective_id)
             .filter(StoryStep.story_id == story_id)
             .order_by(StoryStep.sort_order.asc(), StoryStep.id.asc())
             .all())

    id_to_ref, _ = _layer_ref_index(session)
    out_steps = []
    missing = []
    notes: list[str] = []
    configs: list[dict] = []
    used_refs: set[str] = set()
    for st, p in steps:
        if p is None:
            # Dangling reference — keep the step's own narration/timing so the
            # export still describes the story, and flag it for the importer.
            missing.append(st.id)
            perspective = None
        else:
            cfg = _safe_json(p.config_json)
            if isinstance(cfg, dict):
                # Numeric layer ids are meaningless on another instance — swap
                # them for project::scenario::name refs before shipping.
                notes.extend(_rewrite_layer_keys(cfg, id_to_ref, drop_missing=False))
                configs.append(cfg)
                for section in ("visibility", "localStyle", "opacity", "order"):
                    sec = (cfg.get("layers") or {}).get(section)
                    if isinstance(sec, dict):
                        used_refs.update(k for k in sec if LAYER_REF_SEP in str(k))
            perspective = {
                "name": p.name,
                "description": p.description,
                "config": cfg,
            }
        out_steps.append({
            "sort_order": st.sort_order,
            "transition_type": st.transition_type,
            "transition_duration_ms": st.transition_duration_ms,
            "narration": st.narration,
            "auto_advance_ms": st.auto_advance_ms,
            "suggested_prompts": _parse_prompts(st.suggested_prompts),
            "perspective": perspective,
        })

    bundle = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "story": {
            "name": s.name,
            "description": s.description,
            "guiding_prompt": getattr(s, "guiding_prompt", None),
        },
        "steps": out_steps,
        "requirements": _requirements(
            configs, used_refs,
            getattr(request.app.state, "extension_registry", None)),
    }
    warnings = []
    if notes:
        uniq = sorted(set(notes))
        shown = ", ".join(uniq[:8]) + (f" (+{len(uniq) - 8} more)" if len(uniq) > 8 else "")
        warnings.append(
            f"{len(uniq)} layer(s) referenced by this story no longer exist in this "
            f"database, so they export as raw ids and won't be portable: {shown}")
    if missing:
        warnings.append(
            f"{len(missing)} step(s) referenced a perspective that no longer exists")
    if warnings:
        bundle["warnings"] = warnings
    return make_response(bundle)


def _safe_json(raw):
    """config_json is stored as TEXT; hand back a real object when it parses so
    the bundle is readable/diffable, and the raw string when it doesn't."""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return raw


def _preflight(request: Request, session: Session, requirements: dict,
               ref_to_id: dict[str, int]) -> list[str]:
    """Check what the bundle says it needs against what this instance has.

    Returns human-readable problems. This is the difference between a story
    that silently renders an empty map and one that tells you the GAT
    simulation it was built on isn't loaded here.
    """
    problems: list[str] = []

    registry = getattr(request.app.state, "extension_registry", None)
    for req in requirements.get("extensions") or []:
        # v2 records a fingerprint dict; tolerate a bare name too.
        req = {"name": req} if isinstance(req, str) else (req or {})
        name = req.get("name")
        if not name:
            continue
        if registry is not None and registry.get(name) is None:
            problems.append(
                f"extension '{name}' is not installed here — chapters using it will be empty")
            continue
        have = _ext_fingerprint(registry, name)
        # Version drift is a WARNING, not a hard failure: the story may render
        # fine. But it's the likeliest cause of a story that loads yet looks
        # wrong (a renamed layer, a reshaped table), so never stay silent.
        want_commit, have_commit = req.get("commit"), have.get("commit")
        if want_commit and have_commit and want_commit != have_commit:
            problems.append(
                f"extension '{name}' is at commit {have_commit[:12]}, but this story was "
                f"authored against {want_commit[:12]} — layers or tables it relies on may "
                f"have changed")
        elif want_commit and not have_commit:
            problems.append(
                f"extension '{name}' has no resolvable commit here, so it can't be checked "
                f"against the {want_commit[:12]} this story was authored against")
        if req.get("dirty"):
            problems.append(
                f"extension '{name}' was exported from a working tree with uncommitted "
                f"changes ({(req.get('commit') or '?')[:12]}), so its exact build is not reproducible")
        want_v, have_v = req.get("version"), have.get("version")
        if want_v and have_v and want_v != have_v and not want_commit:
            problems.append(
                f"extension '{name}' is version {have_v} here; story was authored against {want_v}")

    for sc in requirements.get("scenarios") or []:
        proj_name, scen_name = sc.get("project"), sc.get("scenario")
        if not proj_name:
            continue
        proj = session.query(Project).filter(Project.name == proj_name).first()
        if not proj:
            problems.append(
                f"project '{proj_name}' not found — its data (e.g. a simulation "
                f"run) has to be loaded here separately; the bundle carries only view state")
            continue
        if scen_name and not (session.query(Scenario)
                              .filter(Scenario.project_id == proj.id,
                                      Scenario.name == scen_name).first()):
            problems.append(f"scenario '{proj_name}/{scen_name}' not found")

    missing_layers = [r for r in (requirements.get("layers") or []) if r not in ref_to_id]
    if missing_layers:
        shown = ", ".join(missing_layers[:5])
        more = f" (+{len(missing_layers) - 5} more)" if len(missing_layers) > 5 else ""
        problems.append(f"{len(missing_layers)} layer(s) not found here: {shown}{more}")
    return problems


@router.post("/api/stories/preflight")
async def preflightStory(body: dict, request: Request,
                         session: Session = Depends(db.get_db_session),
                         _=Depends(require_api_key)):
    """Report what a bundle needs that this instance lacks, without importing."""
    if body.get("format") != BUNDLE_FORMAT:
        return make_response(f"not a {BUNDLE_FORMAT} bundle", status=400)
    _, ref_to_id = _layer_ref_index(session)
    problems = _preflight(request, session, body.get("requirements") or {}, ref_to_id)
    return make_response({
        "ok": not problems,
        "problems": problems,
        "requirements": body.get("requirements") or {},
    })


@router.post("/api/stories/import")
async def importStory(body: dict, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    """Rehydrate a bundle from /export into this instance.

    Creates a fresh perspective per step (ids are never reused across
    instances) and a new story wired to them. Pass ``name`` to override the
    bundle's story name — useful when importing next to an existing copy.
    """
    try:
        if body.get("format") != BUNDLE_FORMAT:
            return make_response(
                f"not a {BUNDLE_FORMAT} bundle (got format={body.get('format')!r})",
                status=400,
            )
        if int(body.get("version", 0)) > BUNDLE_VERSION:
            return make_response(
                f"bundle version {body.get('version')} is newer than this server "
                f"supports ({BUNDLE_VERSION})", status=400)

        story_in = body.get("story") or {}
        if not story_in.get("name"):
            return make_response("bundle has no story.name", status=400)

        s = Story(
            name=body.get("name") or story_in["name"],
            description=story_in.get("description") or "",
            guiding_prompt=story_in.get("guiding_prompt"),
            owner=body.get("owner", "admin"),
            project_id=body.get("project_id"),
        )
        session.add(s)
        session.flush()  # need s.id before adding steps

        warnings = list(body.get("warnings") or [])

        # Preflight first: a bundle carries view state only, so anything it
        # names but this instance lacks (the GAT sim, an extension) becomes a
        # warning the caller can act on rather than an empty map.
        _, ref_to_id = _layer_ref_index(session)
        warnings.extend(_preflight(request, session,
                                   body.get("requirements") or {}, ref_to_id))
        unresolved: list[str] = []
        if int(body.get("version", 1)) < 2:
            warnings.append(
                "v1 bundle: layer visibility/style is keyed by numeric ids from the "
                "source instance and cannot be remapped; re-export from an updated "
                "Meridian for portable layer refs")

        created = 0
        for i, step in enumerate(body.get("steps") or []):
            pdata = step.get("perspective")
            if not pdata:
                warnings.append(f"step {i} had no perspective in the bundle; skipped")
                continue
            cfg = pdata.get("config")
            if isinstance(cfg, dict) and int(body.get("version", 1)) >= 2:
                # Portable refs -> this instance's layer ids.
                unresolved.extend(_rewrite_layer_keys(cfg, ref_to_id, drop_missing=True))
            p = Perspective(
                name=pdata.get("name") or f"{s.name} step {i + 1}",
                description=pdata.get("description") or "",
                owner=body.get("owner", "admin"),
                project_id=body.get("project_id"),
                config_json=cfg if isinstance(cfg, str) else json.dumps(cfg or {}),
            )
            session.add(p)
            session.flush()  # need p.id for the step
            prompts = step.get("suggested_prompts") or []
            session.add(StoryStep(
                story_id=s.id,
                perspective_id=p.id,
                sort_order=step.get("sort_order", i),
                transition_type=step.get("transition_type"),
                transition_duration_ms=step.get("transition_duration_ms"),
                narration=step.get("narration"),
                auto_advance_ms=step.get("auto_advance_ms"),
                suggested_prompts=json.dumps(prompts) if prompts else None,
            ))
            created += 1

        if unresolved:
            uniq = sorted(set(unresolved))
            shown = ", ".join(uniq[:8]) + (f" (+{len(uniq) - 8} more)" if len(uniq) > 8 else "")
            warnings.append(
                f"{len(uniq)} layer(s) in the bundle don't exist here; their "
                f"visibility/style was dropped: {shown}")

        session.commit()
        db.save_to_disk()
        return make_response(
            {"id": s.id, "name": s.name, "steps": created, "warnings": warnings},
            status=201,
        )
    except Exception as e:
        session.rollback()
        logger.exception("[story-import] failed")
        return make_response(str(e), status=500)
