"""
Chart and shader specification types for frontend visualization extensions.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ChartSpec:
    """Describes a chart type an extension can render via SQL."""

    name: str  # e.g. "dispatch_stack"
    display_name: str  # e.g. "Dispatch Stack"
    chart_type: str  # "bar", "line", "scatter", "plotly", or any registered chart_type
    sql_template: str  # SQL with {entity_id}, {project}, {scenario} placeholders
    chart_options: dict = field(default_factory=dict)  # Chart.js options or Plotly layout
    width: int = 300
    height: int = 200
    datasets: list[str] = field(default_factory=list)  # dataset names this chart depends on
    format: str = "plotly"  # "plotly", "vega-lite", "chartgpu", or "custom"
    scope: str = "entity"  # "entity" (per-entity tooltip) or "scenario" (system-wide panel)
    # Optional scoping fields. When non-empty, the frontend filters the
    # per-extension charts menu to those matching the active scenario.
    # Empty strings mean "applies to any project/scenario" (legacy behavior).
    project: str = ""
    scenario: str = ""


@dataclass
class ShaderSpec:
    """Describes a GLSL shader or deck.gl layer extension."""

    name: str  # e.g. "flow_arrows"
    display_name: str
    shader_type: str  # "vertex", "fragment", "deck_extension"
    js_module: str | None = None  # for deck extensions
    js_export: str | None = None
