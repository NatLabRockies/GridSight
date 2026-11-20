"""Project + project-alias + search routes."""
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import db
from lib.auth import require_api_key
from lib.responses import make_response
from lib.state import storage
from models.orm import Project, Scenario

logger = logging.getLogger("gridsight")
router = APIRouter()


@router.get("/api/projects")
async def listProjects():
    try:
        fs_projects = storage.list_projects()
        session = db.get_session()
        try:
            ext_projects = [
                p.name for p in session.query(Project)
                .filter(Project.extension_name.isnot(None))
                .all()
            ]
        finally:
            session.close()
        all_projects = list(dict.fromkeys(fs_projects + ext_projects))
        return make_response(all_projects)
    except Exception as e:
        logger.exception("projects route error")
        return make_response("internal error", 500)


@router.get("/api/projects/{project}")
async def listScenarios(project: str):
    try:
        session = db.get_session()
        try:
            proj = session.query(Project).filter(
                Project.name == project, Project.extension_name.isnot(None)
            ).first()
            if proj:
                ext_scenarios = [
                    s.name for s in session.query(Scenario)
                    .filter(Scenario.project_id == proj.id)
                    .all()
                ]
                return make_response(ext_scenarios)
        finally:
            session.close()
        return make_response(storage.list_scenarios(project))
    except Exception as e:
        logger.exception("projects route error")
        return make_response("internal error", 500)


@router.get("/api/search/projects")
async def searchProjects(tag: str = "", q: str = "", session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    """Search projects by tag or name/description."""
    from models.orm import ProjectTag
    if tag:
        tag_rows = session.query(ProjectTag).filter(ProjectTag.tag == tag).all()
        project_ids = [t.project_id for t in tag_rows]
        projects = session.query(Project).filter(Project.id.in_(project_ids)).all() if project_ids else []
    elif q:
        projects = session.query(Project).filter(
            Project.name.contains(q) | Project.display_name.contains(q)
        ).all()
    else:
        projects = session.query(Project).all()
    return make_response([
        {"id": p.id, "name": p.name, "display_name": p.display_name, "extension_name": p.extension_name}
        for p in projects
    ])


@router.get("/api/projects/{project_id}/aliases")
async def getProjectAliases(project_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    from models.orm import ProjectAlias
    aliases = session.query(ProjectAlias).filter(ProjectAlias.project_id == project_id).all()
    return make_response([
        {"id": a.id, "alias_name": a.alias_name, "target_extension": a.target_extension, "target_project": a.target_project}
        for a in aliases
    ])


@router.post("/api/projects/{project_id}/aliases")
async def createProjectAlias(project_id: int, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    from models.orm import ProjectAlias
    try:
        alias = ProjectAlias(
            project_id=project_id,
            alias_name=body["alias_name"],
            target_extension=body["target_extension"],
            target_project=body["target_project"],
        )
        session.add(alias)
        session.commit()
        session.refresh(alias)
        db.save_to_disk()
        return make_response({"id": alias.id}, status=201)
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.delete("/api/aliases/{alias_id}")
async def deleteProjectAlias(alias_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    from models.orm import ProjectAlias
    try:
        alias = session.query(ProjectAlias).filter(ProjectAlias.id == alias_id).first()
        if not alias:
            raise HTTPException(404, "Alias not found")
        session.delete(alias)
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)
