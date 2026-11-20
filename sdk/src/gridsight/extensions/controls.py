"""
Data control types for interactive entity-level and project-level controls.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ControlType(str, Enum):
    """Supported control widget types."""

    SLIDER = "slider"
    DROPDOWN = "dropdown"
    MULTI_SELECT = "multi_select"
    TEXT = "text"
    NUMBER = "number"
    TOGGLE = "toggle"


@dataclass
class DataControl:
    """A single interactive control for an entity."""

    name: str
    display_name: str
    type: ControlType
    current_value: Any
    default_value: Any = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: str | None = None
    options: list[dict] | None = None  # for dropdown: [{"label": ..., "value": ...}]
    group: str | None = None
    read_only: bool = False


# ---------------------------------------------------------------------------
# Three-tier extension response types
# ---------------------------------------------------------------------------


class ResponseTier(int, Enum):
    """How much visualization guidance the extension provides."""

    DATA_REF = 1          # Just a table/column reference — UI/AI decides viz
    DATA_WITH_HINTS = 2   # Table/column + visualization hints
    FULL_VIZ_CONFIG = 3   # Complete chart/map config (escape hatch)


@dataclass
class VizHint:
    """Visualization hints returned with Tier 2 responses."""

    hint_type: str  # "timeseries", "categorical", "geospatial", "scalar"
    animate: bool = False
    suggested_chart: str | None = None  # "line", "bar", "choropleth", "scatter"
    color_scheme: str | None = None     # "viridis", "plasma", etc.
    compare_with: str | None = None     # column name for side-by-side comparison


@dataclass
class TieredResponse:
    """
    Structured response from an input control handler.

    Tier 1 (DATA_REF): Just set ``table`` and optionally ``column``/``columns``.
    The UI or AI agent decides how to visualize the data.

    Tier 2 (DATA_WITH_HINTS): Also set ``hint`` to guide the UI toward a
    particular visualization style without dictating it.

    Tier 3 (FULL_VIZ_CONFIG): Set ``chart_type`` and ``config`` to provide a
    complete Plotly/Chart.js/deck.gl configuration. The UI renders it as-is.
    """

    tier: ResponseTier

    # Tier 1+: data reference
    table: str | None = None
    column: str | None = None
    columns: list[str] | None = None

    # Tier 2: visualization hints
    hint: VizHint | None = None

    # Tier 3: full visualization config
    chart_type: str | None = None  # "plotly", "chartjs", "vega", "deck"
    config: dict | None = None     # complete chart/layer config


@dataclass
class ControlUpdateResult:
    """Returned by set_control_value / set_input_control_value.

    Extensions may optionally include a ``tiered_response`` to instruct the UI
    how to display the result of the control change.  If omitted, the UI
    relies on ``invalidated_datasets`` to know what to refresh.
    """

    success: bool
    new_value: Any = None
    message: str | None = None
    invalidated_datasets: list[str] = field(default_factory=list)
    tiered_response: TieredResponse | None = None
    layer_actions: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# @input_control decorator
# ---------------------------------------------------------------------------

# Sentinel attribute name set on decorated methods.
_INPUT_CONTROL_ATTR = "_input_control_meta"


def input_control(
    *,
    name: str,
    display_name: str,
    type: ControlType,
    default: Any = None,
    min: float | None = None,
    max: float | None = None,
    step: float | None = None,
    unit: str | None = None,
    options: list[dict] | None = None,
    group: str | None = None,
    read_only: bool = False,
    invalidates: list[str] | None = None,
    sql_column: str | None = None,
):
    """Decorator that tags an extension method as an input control handler.

    Usage::

        class MyExtension(GridSightExtensionBase):

            @input_control(
                name="ev_stock_share",
                display_name="EV Stock Share",
                type=ControlType.SLIDER,
                default=10, min=0, max=100, step=1, unit="%",
                group="Transport Assumptions",
                invalidates=["forecast"],
            )
            def handle_ev_stock_share(self, value: float):
                self._ev_stock_share = value

    The decorated method receives the new value and may optionally return a
    ``ControlUpdateResult``.  If it returns ``None`` the framework builds a
    default success result using *invalidates* and the new value.
    """

    def decorator(fn):
        setattr(fn, _INPUT_CONTROL_ATTR, {
            "name": name,
            "display_name": display_name,
            "type": type,
            "default": default,
            "min": min,
            "max": max,
            "step": step,
            "unit": unit,
            "options": options,
            "group": group,
            "read_only": read_only,
            "invalidates": invalidates or [],
            "sql_column": sql_column,
        })
        return fn

    return decorator


def _collect_input_controls(instance: Any) -> dict[str, tuple[dict, Any]]:
    """Scan *instance* for methods decorated with ``@input_control``.

    Returns ``{control_name: (meta_dict, bound_method)}``.
    """
    result: dict[str, tuple[dict, Any]] = {}
    for _name in dir(instance):
        try:
            attr = getattr(instance, _name)
        except Exception:
            continue
        meta = getattr(attr, _INPUT_CONTROL_ATTR, None)
        if meta is not None:
            result[meta["name"]] = (meta, attr)
    return result
