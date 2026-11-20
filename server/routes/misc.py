"""Health check and catch-all scenario config route."""
from fastapi import APIRouter

from lib.responses import make_response
from lib.state import storage

router = APIRouter()


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/api/{project}/{scenario}")
async def loadScenarioConfig(project: str, scenario: str):
    config = storage.get_scenario_config(project, scenario)
    return make_response(config)
