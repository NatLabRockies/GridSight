"""
Shared test configuration and fixtures.

Environment variables are set at module-import time (before any app module is
imported) so that app.py's module-level side effects — storage = create_storage_handler()
and db.init_db() — pick up the test values.
"""

import json
import os
import tempfile

# ── Must come before any app import ────────────────────────────────────────
_TMP_DATA_DIR = tempfile.mkdtemp(prefix="meridian_test_data_")
_TMP_DB_DIR   = tempfile.mkdtemp(prefix="meridian_test_db_")

os.environ["DATA_DIR"]        = _TMP_DATA_DIR
os.environ["DB_PATH"]         = os.path.join(_TMP_DB_DIR, "test.db")
os.environ["API_KEY"]         = "test-key-abc123"
os.environ["STORAGE_BACKEND"] = "filesystem"

import pytest
from fastapi.testclient import TestClient

import app as _app_module
import db as _db_module
from models.orm import (
    Dataset,
    GeometryFile,
    Layer,
    LayerDataset,
    LayerStyleMapping,
    Project,
    Scenario,
)

# ── Shared constants ────────────────────────────────────────────────────────

TEST_API_KEY = "test-key-abc123"
AUTH_HEADERS = {"X-MyApp-ApiKey": TEST_API_KEY}

GEOJSON_BYTES = json.dumps({
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"id": "zone-1", "name": "Zone 1"},
            "geometry": {"type": "Point", "coordinates": [-105.0, 39.0]},
        }
    ],
}).encode()

STATIC_CSV_BYTES = b"id,value\nzone-1,100\nzone-2,200\n"

TIMESERIES_CSV_BYTES = (
    b"datetime,zone-1,zone-2\n"
    b"2024-01-01 00:00:00,100,200\n"
    b"2024-01-01 01:00:00,110,210\n"
    b"2024-01-02 00:00:00,120,220\n"
)

# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def client():
    """FastAPI TestClient shared for the entire test session."""
    with TestClient(_app_module.app) as c:
        yield c


@pytest.fixture(autouse=True)
def clean_db():
    """
    Truncate all tables before every test so each test starts with an empty
    database.  Deletion order respects foreign-key constraints.
    """
    session = _db_module.get_session()
    try:
        session.query(LayerStyleMapping).delete()
        session.query(LayerDataset).delete()
        session.query(Layer).delete()
        session.query(Dataset).delete()
        session.query(GeometryFile).delete()
        session.query(Scenario).delete()
        session.query(Project).delete()
        session.commit()
    finally:
        session.close()
    yield
