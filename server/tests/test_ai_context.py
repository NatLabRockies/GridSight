"""
Unit tests for the agent-context renderer in lib/ai/context.py.

The DuckDB catalog is rebuilt into the system prompt on every chat message and
grows ~80 tables per loaded scenario, so these tests pin the two properties
that make that affordable: same-shaped table families collapse to one line,
and the collapse stays *lossless in capability* — every collapsed group still
names the pattern an agent can pass to get_table_catalog() to expand it.
"""

import json
from dataclasses import dataclass, field

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from lib.ai.context import render_story_context, render_table_catalog
from models.orm import (
    Base,
    GeometryFile,
    Layer,
    Perspective,
    Project,
    Scenario,
    Story,
    StoryStep,
)

# ── Helpers ─────────────────────────────────────────────────────────────────


@dataclass
class Table:
    """Stand-in for the SDK's DuckDBTableInfo (duck-typed by the renderer)."""

    table_name: str
    description: str = ""
    columns: list = field(default_factory=list)


def _scenario_tables(scenario: str, n_sim: int = 20) -> list[Table]:
    """A GAT-shaped family: a few bare tables plus a large sim__ group."""
    tables = [
        Table(f"ext_gat.{scenario}__availability", f"[{scenario}] availability"),
        Table(f"ext_gat.{scenario}__reserve", f"[{scenario}] reserve"),
    ]
    tables += [
        Table(f"ext_gat.{scenario}__sim__Var{i}", f"[{scenario}] Raw simulation: Var{i}")
        for i in range(n_sim)
    ]
    return tables


def _text(lines: list[str]) -> str:
    return "\n".join(lines)


# ── Tests ───────────────────────────────────────────────────────────────────


def test_empty_catalog_renders_nothing():
    assert render_table_catalog([]) == []


def test_small_schema_is_listed_table_by_table():
    catalog = [Table("ext_seds.data", "SEDS rows"), Table("user.uploads", "an upload")]
    out = _text(render_table_catalog(catalog))
    assert "`ext_seds.data`: SEDS rows" in out
    assert "`user.uploads`: an upload" in out


def test_large_family_collapses_and_names_its_pattern():
    out = _text(render_table_catalog(_scenario_tables("Demo_Base")))

    # The big sim__ group is summarised, not enumerated...
    assert "20 × `ext_gat.Demo_Base__sim__*`" in out
    assert "Demo_Base__sim__Var7" not in out
    # ...but the agent is told exactly how to expand it.
    assert 'get_table_catalog(pattern="Demo_Base__sim__")' in out
    # Small groups inside the family stay fully visible.
    assert "Demo_Base__availability" in out


def test_documented_tables_are_not_repeated():
    catalog = [Table("ext_seds.data", "SEDS rows"), Table("user.uploads", "an upload")]
    out = _text(render_table_catalog(catalog, documented={"ext_seds.data"}))
    assert "ext_seds.data" not in out
    assert "user.uploads" in out


def test_everything_documented_renders_nothing():
    catalog = [Table("ext_seds.data", "SEDS rows")]
    assert render_table_catalog(catalog, documented={"ext_seds.data"}) == []


def test_active_prefixes_filter_extension_tables_only():
    catalog = [
        Table("ext_gat.Demo_Base__reserve", "gat"),
        Table("ext_seds.data", "seds"),
        Table("user.uploads", "an upload"),
    ]
    out = _text(render_table_catalog(catalog, active_prefixes={"ext_seds."}))
    assert "ext_seds.data" in out
    assert "ext_gat" not in out
    # Non-extension tables are never filtered out by the extension scope.
    assert "user.uploads" in out


def test_budget_overflow_falls_back_to_terse_families():
    catalog = _scenario_tables("Demo_Base") + _scenario_tables("test_test")
    normal = render_table_catalog(catalog)
    terse = render_table_catalog(catalog, budget_chars=200)

    assert len(_text(terse)) < len(_text(normal))
    # Terse mode still accounts for every table and stays expandable.
    body = _text(terse)
    assert "sim×20" in body
    assert 'get_table_catalog(pattern="Demo_Base__")' in body


def test_collapse_never_drops_a_family_silently():
    """Every scenario family must appear, however aggressive the budget."""
    catalog = _scenario_tables("Demo_Base") + _scenario_tables("test_test")
    for budget in (10, 200, 6000):
        body = _text(render_table_catalog(catalog, budget_chars=budget))
        assert "Demo_Base__" in body, budget
        assert "test_test__" in body, budget


def test_unqualified_and_undescribed_tables_do_not_crash():
    out = _text(render_table_catalog([Table("bare_table"), Table("a.b")]))
    assert "bare_table" in out
    assert "`a.b`" in out


# ── Story / chapter context ─────────────────────────────────────────────────

CHAPTER_CONFIG = {
    "view": {"latitude": 31.5, "longitude": -99.1, "zoom": 6.2, "pitch": 0},
    "basemap": "dark-matter",
    "scenario": {"project": "demand-forecast", "scenario": "base"},
    "extensions": {"enabled": ["seds", "demand-tldr"]},
    "layers": {"visibility": {"1": True, "2": False, "99": True}},
    "chartFrames": [{
        "anchorMode": "tray",
        "charts": [{
            "extName": "seds",
            "chartName": "seds_state_history",
            "chartSpec": {"display_name": "Total Energy"},
            "entityId": "48",
        }],
    }],
    "controls": {"extName": "demand-tldr", "values": {"forecast_year": 2029, "state": "TX"}},
    "clock": {"index": 0, "animate": False},
}


class _FakeDB:
    """Minimal stand-in for the app's db module: just get_session()."""

    def __init__(self, factory):
        self._factory = factory

    def get_session(self):
        return self._factory()


@pytest.fixture
def story_db():
    """An in-memory DB holding a two-chapter story over two named layers."""
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)

    session = factory()
    project = Project(name="p", owner="admin")
    session.add(project)
    session.flush()
    scenario = Scenario(project_id=project.id, name="base")
    geom = GeometryFile(name="g", content_hash="h", format="geojson")
    session.add_all([scenario, geom])
    session.flush()
    session.add_all([
        Layer(id=1, scenario_id=scenario.id, geometry_id=geom.id,
              name="counties", display_name="County Demand", deck_layer_type="GeoJsonLayer"),
        Layer(id=2, scenario_id=scenario.id, geometry_id=geom.id,
              name="states", display_name="State Demand", deck_layer_type="GeoJsonLayer"),
    ])
    session.add_all([
        Perspective(id=1, name="Opening", description="Sets the scene", config_json="{}"),
        Perspective(id=2, name="Texas Forecast", config_json=json.dumps(CHAPTER_CONFIG)),
    ])
    session.add(Story(id=1, name="Demo", description="A demo", guiding_prompt="Be brief."))
    session.add_all([
        StoryStep(story_id=1, perspective_id=1, sort_order=0),
        StoryStep(story_id=1, perspective_id=2, sort_order=1, narration="Now look at Texas."),
    ])
    session.commit()
    session.close()
    return _FakeDB(factory)


def test_no_scope_renders_nothing(story_db):
    assert render_story_context(story_db, story_id=None, perspective_id=None) == []
    assert render_story_context(None, story_id=1, perspective_id=1) == []


def test_unknown_ids_render_nothing(story_db):
    assert render_story_context(story_db, story_id=404, perspective_id=404) == []


def test_story_outline_marks_the_applied_chapter(story_db):
    out = _text(render_story_context(story_db, story_id=1, perspective_id=2))
    assert 'Active Story: "Demo"' in out
    assert "Be brief." in out
    assert '2. "Texas Forecast" (perspective_id=2)' in out
    # Only the applied chapter is marked.
    assert out.count("currently applied") == 1
    assert '1. "Opening" (perspective_id=1) — Sets the scene\n' in out + "\n"


def test_chapter_describes_what_is_on_screen(story_db):
    out = _text(render_story_context(story_db, story_id=1, perspective_id=2))
    assert "Current chapter — 2 of 2" in out
    assert "`demand-forecast` / `base`" in out
    assert "`County Demand` (layer_id=1)" in out
    assert "`State Demand`" in out           # listed as hidden
    assert "open_chart: seds/seds_state_history, entity 48" in out
    assert "forecast_year=2029" in out
    assert "zoom 6.2" in out
    assert "Now look at Texas." in out


def test_chapter_drops_layers_that_no_longer_exist(story_db):
    """A saved chapter can outlive its layers; id 99 has no row."""
    out = _text(render_story_context(story_db, story_id=1, perspective_id=2))
    assert "layer_id=99" not in out
    assert "`99`" not in out


def test_story_without_applied_chapter_says_so(story_db):
    out = _text(render_story_context(story_db, story_id=1, perspective_id=None))
    assert "No chapter is currently applied" in out
    assert "currently applied**" not in out


def test_perspective_outside_a_story_renders_as_current_view(story_db):
    out = _text(render_story_context(story_db, story_id=None, perspective_id=2))
    assert 'Current view: "Texas Forecast"' in out
    assert "What is on screen:" in out
    # No story means no story-reuse hierarchy.
    assert "Working from a story" not in out


def test_unparseable_config_still_renders_the_chapter(story_db):
    """A corrupt config must not cost the whole story block."""
    session = story_db.get_session()
    session.query(Perspective).filter(Perspective.id == 2).first().config_json = "{not json"
    session.commit()
    session.close()

    out = _text(render_story_context(story_db, story_id=1, perspective_id=2))
    assert "Current chapter — 2 of 2" in out
    assert 'Active Story: "Demo"' in out
    # Everything config-derived is gone...
    assert "Visible layers" not in out
    assert "forecast_year" not in out
    # ...but narration lives on the step, not the config, so it survives.
    assert "Now look at Texas." in out
