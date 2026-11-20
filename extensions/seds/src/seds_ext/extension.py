"""
SEDS Meridian extension — EIA State Energy Data System historical data.

State-level annual energy statistics, 1960–present, indexed by MSN codes
(fuel × sector × unit). Ships alongside the DemandTldr forecast extension
in the same repo but is fully self-contained: users who want only historical
data can disable the forecast extension and still use SEDS.

Data is fetched on demand from eia.gov and cached locally as Parquet; no
data ships with the extension.
"""
from __future__ import annotations

import io
import logging
import os
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from meridian.extensions import (
    Capability,
    ChartSpec,
    ControlType,
    ControlUpdateResult,
    DatasetDescriptor,
    DuckDBTableInfo,
    ExtensionContext,
    ExtensionManifest,
    ExtensionProject,
    ExtensionScenario,
    GeometryDescriptor,
    LayerDefinition,
    MeridianExtensionBase,
    input_control,
)
from meridian.extensions.ai import AIControlSchema, AISchema, AITableSchema

from . import seds as seds_mod


logger = logging.getLogger("seds_ext")

_PACKAGED_DATA_DIR = Path(__file__).parent / "data"


def _resolve_cache_dir() -> Path:
    """SEDS cache lives under SEDS_CACHE_DIR or DATA_DIR/cache/seds."""
    explicit = os.environ.get("SEDS_CACHE_DIR")
    if explicit:
        return Path(explicit)
    server_data = os.environ.get("DATA_DIR")
    if server_data:
        return Path(server_data) / "cache" / "seds"
    return Path("/tmp/seds_cache")


CACHE_DIR = _resolve_cache_dir()
SEDS_MIN_YEAR = 1960
SEDS_MAX_YEAR = 2023

# Map SEDS 2-letter state codes → 2-digit FIPS used by the bundled
# us-states geometry's STATEFP join key.
FUEL_LABELS = seds_mod.FUEL_CODES
SECTOR_LABELS = seds_mod.SECTOR_CODES
UNIT_LABELS = seds_mod.UNIT_CODES



def _scaled_unit(unit_code: str, unit_label: str) -> tuple[float | None, str]:
    """Return (value_scale, display unit) for a SEDS unit selection.

    SEDS reports energy in Billion BTU, which at state scale runs to seven
    figures — a "Top 15 States" axis reading 1,456,457 is unreadable, and the
    number is not even in the unit the field uses. 1e6 Billion BTU is exactly
    one Quadrillion BTU (a "quad"), the conventional unit for state and
    national energy totals.

    Only BTU is rescaled: physical units, dollars and prices are already at
    human scale and dividing them would be wrong, not just ugly.
    """
    if unit_code == "B":
        return 1e6, "Quadrillion BTU"
    return None, unit_label


_STATE_TO_FIPS: dict[str, str] = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08",
    "CT": "09", "DE": "10", "DC": "11", "FL": "12", "GA": "13", "HI": "15",
    "ID": "16", "IL": "17", "IN": "18", "IA": "19", "KS": "20", "KY": "21",
    "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27",
    "MS": "28", "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33",
    "NJ": "34", "NM": "35", "NY": "36", "NC": "37", "ND": "38", "OH": "39",
    "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46",
    "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53",
    "WV": "54", "WI": "55", "WY": "56",
}

_FIPS_TO_STATE: dict[str, str] = {v: k for k, v in _STATE_TO_FIPS.items()}


class SedsExtension(MeridianExtensionBase):
    def __init__(self) -> None:
        self._context: ExtensionContext | None = None
        self._duckdb_conn: Any = None
        self._table: pa.Table | None = None

        # Control state (electricity / total consumption / BTU by default —
        # the most common "how much energy did this state use?" view).
        # `_sectors` is a list because the UI now exposes sector as a
        # multi-select. When the user picks multiple, the map (and the
        # state-click chart) shows the sum of the matching MSNs.
        self._fuel: str = "ES"
        self._sectors: list[str] = ["TC"]
        self._unit: str = "B"
        self._year: int = 2020

    # ── Manifest / lifecycle ─────────────────────────────────────────────

    def get_manifest(self) -> ExtensionManifest:
        return ExtensionManifest(
            name="seds",
            display_name="SEDS",
            version="0.1.0",
            description=(
                "EIA State Energy Data System: state-level historical energy "
                "consumption, production, prices, and expenditures, 1960–present."
            ),
            capabilities=[
                Capability.DATA_PROVIDER,
                Capability.DUCKDB_TABLES,
                Capability.AI_QUERYABLE,
                Capability.INPUT_CONTROLS,
            ],
            icon=None,
        )

    def get_icon_bytes(self) -> bytes | None:
        return (Path(__file__).parent / "static" / "icon.svg").read_bytes()

    def on_startup(self, context: ExtensionContext) -> None:
        self._context = context
        self._duckdb_conn = context.duckdb_conn

    # ── Data helpers ─────────────────────────────────────────────────────

    def _ensure_loaded(self) -> pa.Table | None:
        if self._table is not None:
            return self._table
        try:
            self._table = seds_mod.load_seds(CACHE_DIR)
        except Exception as e:
            logger.warning("[seds] load failed: %s", e)
            return None
        return self._table

    def _msns(self) -> list[str]:
        """One MSN per currently selected sector. Drops candidates that
        don't exist in SEDS, never returns an empty list — falls back to
        ESTCB if nothing matched, so downstream queries always have at
        least one MSN to look up.
        """
        table = self._ensure_loaded()
        candidates = [f"{self._fuel}{s}{self._unit}" for s in (self._sectors or [])]
        if table is None:
            return candidates or [seds_mod.ELECTRICITY_MSN]
        avail = seds_mod.available_msn_codes(table)
        kept = [c for c in candidates if c in avail]
        if not kept:
            logger.info("[seds] no selected MSN present; using ESTCB")
            return [seds_mod.ELECTRICITY_MSN]
        return kept

    def _msn(self) -> str:
        """Single-MSN compatibility helper for code paths that don't yet
        sum across sectors (e.g. the entity-click chart display name)."""
        return self._msns()[0]

    def _build_state_dataset(self, year: int) -> bytes:
        table = self._ensure_loaded()
        if table is None:
            return b""
        # Sum per-state values across all selected sector MSNs. Skips MSNs
        # that have no data for this year cleanly.
        totals: dict[str, float] = {}
        for msn in self._msns():
            values = seds_mod.state_values_for_msn(table, msn, year, _STATE_TO_FIPS)
            for fp, v in values.items():
                totals[fp] = totals.get(fp, 0.0) + v
        if not totals:
            return b""
        rows = [{"STATEFP": fp, "seds_value": v} for fp, v in sorted(totals.items())]
        buf = io.BytesIO()
        pq.write_table(pa.Table.from_pylist(rows), buf)
        return buf.getvalue()

    # ── Input Controls ───────────────────────────────────────────────────

    @input_control(
        name="fuel", display_name="Fuel", type=ControlType.DROPDOWN,
        default="ES",
        options=[{"label": label, "value": code}
                 for code, label in seds_mod.FUEL_CODES.items()],
        group="MSN",
        invalidates=["state-view"],
    )
    def handle_fuel(self, value: str) -> ControlUpdateResult:
        self._fuel = str(value)
        return ControlUpdateResult(
            success=True, new_value=str(value),
            invalidated_datasets=["state-view"],
        )

    @input_control(
        name="sector", display_name="Sectors", type=ControlType.MULTI_SELECT,
        default=["TC"],
        options=[{"label": label, "value": code}
                 for code, label in seds_mod.SECTOR_CODES.items()],
        group="MSN",
        invalidates=["state-view"],
    )
    def handle_sector(self, value: Any) -> ControlUpdateResult:
        # Accept either a list (from the multi-select widget) or a single
        # string (back-compat for older callers / AI). Coerce + dedup.
        if isinstance(value, str):
            sectors = [value]
        elif isinstance(value, (list, tuple)):
            sectors = [str(v) for v in value if v]
        else:
            sectors = ["TC"]
        # Drop unknown sector codes silently.
        valid = set(seds_mod.SECTOR_CODES.keys())
        sectors = [s for s in sectors if s in valid] or ["TC"]
        # Preserve insertion order while removing duplicates.
        seen: set[str] = set()
        self._sectors = [s for s in sectors if not (s in seen or seen.add(s))]
        return ControlUpdateResult(
            success=True, new_value=list(self._sectors),
            invalidated_datasets=["state-view"],
        )

    @input_control(
        name="unit", display_name="Unit", type=ControlType.DROPDOWN,
        default="B",
        options=[{"label": label, "value": code}
                 for code, label in seds_mod.UNIT_CODES.items()],
        group="MSN",
        invalidates=["state-view"],
    )
    def handle_unit(self, value: str) -> ControlUpdateResult:
        self._unit = str(value)
        return ControlUpdateResult(
            success=True, new_value=str(value),
            invalidated_datasets=["state-view"],
        )

    @input_control(
        name="year", display_name="Year", type=ControlType.SLIDER,
        default=2020, min=SEDS_MIN_YEAR, max=SEDS_MAX_YEAR, step=1,
        group="Time",
        invalidates=["state-view"],
    )
    def handle_year(self, value: float) -> ControlUpdateResult:
        self._year = int(value)
        return ControlUpdateResult(
            success=True, new_value=int(value),
            invalidated_datasets=["state-view"],
        )

    # ── Discovery ────────────────────────────────────────────────────────

    def list_projects(self) -> list[ExtensionProject]:
        return [ExtensionProject(
            name="seds-historical",
            display_name="SEDS Historical",
            description="EIA state-level energy statistics, 1960–present.",
            tags=["energy", "historical", "eia", "seds"],
        )]

    def list_scenarios(self, project: str) -> list[ExtensionScenario]:
        if project != "seds-historical":
            return []
        return [ExtensionScenario(
            name="all", display_name="All MSN Series",
            project_name="seds-historical",
            description="All ~600 SEDS MSN codes; pick fuel/sector/unit/year.",
        )]

    # ── Geometry ─────────────────────────────────────────────────────────

    def list_geometries(self, project=None, scenario=None) -> list[GeometryDescriptor]:
        return [
            GeometryDescriptor(
                name="us-states", display_name="US States", format="geojson",
                join_key="STATEFP",
                description="US state boundaries (Census Bureau 20m).",
            ),
        ]

    def get_geometry_data(self, geometry_name: str) -> bytes:
        if geometry_name == "us-states":
            # Downloaded + cached on first use (see seds.ensure_states_geojson)
            # rather than shipped in the package.
            return seds_mod.ensure_states_geojson(CACHE_DIR).read_bytes()
        raise NotImplementedError(f"Unknown geometry: {geometry_name}")

    # ── Layers ───────────────────────────────────────────────────────────

    def list_layers(self, project=None, scenario=None) -> list[LayerDefinition]:
        return [
            LayerDefinition(
                name="seds-states-layer", display_name="SEDS Historical (State)",
                deck_layer_type="GeoJsonLayer", geom_join_key="STATEFP",
                dataset_ref="state-view", data_join_key="STATEFP",
                # `shared_legend_group="energy_demand_btu"` lets this layer
                # share a legend domain with any other layer (e.g. DemandTldr's
                # state forecast) that opts into the same group. v1: matching
                # domain assumes electricity carrier / BTU unit.
                style_mappings=[{
                    "visual_property": "getFillColor",
                    "column": "seds_value",
                    "colormap": "viridis", "scale_type": "log",
                    "domain_min": 1.0e5, "domain_max": 1.0e9,
                    "shared_legend_group": "energy_demand_btu",
                }],
                default_style={
                    "staticFillColor": [180, 180, 180, 30],
                    "staticLineColor": [60, 60, 60, 60],
                    "interaction": {
                        "hoverContent": [],
                        "clickContent": ["infocard", "charts"],
                        # Drill from the SEDS state choropleth into the
                        # DemandTldr county-demand layer: clicking a state
                        # filters the county layer to that STATEFP, shows it,
                        # hides this state layer, and flies to the bounds.
                        # Targets demand-county-choropleth (DemandTldr) — both
                        # extensions must be enabled for the drill to land.
                        "crossLayerActions": [
                            {"action": "filter",
                             "targetLayerName": "demand-county-choropleth",
                             "filterProperty": "STATEFP", "sourceProperty": "STATEFP"},
                            {"action": "show",
                             "targetLayerName": "demand-county-choropleth"},
                            {"action": "hide_self"},
                            {"action": "fly_to_bounds"},
                        ],
                    },
                },
            ),
        ]

    def get_layer_geometry(self, layer_name: str) -> bytes:
        if layer_name == "seds-states-layer":
            return self.get_geometry_data("us-states")
        raise NotImplementedError(f"Unknown layer geometry: {layer_name}")

    # ── Datasets ─────────────────────────────────────────────────────────

    def list_datasets(self, project=None, scenario=None) -> list[DatasetDescriptor]:
        return [
            DatasetDescriptor(
                name="state-view", display_name="SEDS State View",
                format="parquet", join_key="STATEFP",
                # Static dataset: the year is chosen by the `year` input
                # control, not by a global animation clock. Setting
                # timestamp_col would route the frontend through the
                # timeseries buffer path (driven by clockState.index) and
                # the choropleth wouldn't render because the clock domain
                # doesn't span 1960–2023.
                columns=["STATEFP", "seds_value"],
                description=(
                    "Per-state EIA SEDS value for the currently-selected MSN "
                    "(fuel × sector × unit) and year."
                ),
            ),
        ]

    def get_dataset_data(self, dataset_name: str) -> bytes:
        if dataset_name == "state-view":
            return self._build_state_dataset(self._year)
        raise NotImplementedError(f"Unknown dataset: {dataset_name}")

    # ── Charts ───────────────────────────────────────────────────────────

    # Stable colors for the US fuel-mix area chart so the legend doesn't
    # shuffle between renders. Aligned to the NLR-standard fuel palette (the set
    # GAT uses and the Demand extension's CARRIER_COLORS mirror) so a fuel reads
    # the same color across every Meridian view. Coal/Natural Gas/Petroleum match
    # CARRIER_COLORS directly; Nuclear + Renewables aren't demand carriers so
    # they come from GAT's `standard` set (NUCLEAR, VRE).
    _FUEL_MIX_COLORS = {
        "Coal":        "#222222",  # NLR/GAT Coal
        "Natural Gas": "#C2A1DB",  # NLR/GAT Gas
        "Petroleum":   "#3D3376",  # NLR/GAT Oil
        "Nuclear":     "#820000",  # GAT Nuclear
        "Renewables":  "#7FC340",  # GAT VRE
    }
    _FUEL_MIX_ORDER = ["Coal", "Natural Gas", "Petroleum", "Nuclear", "Renewables"]
    _FUEL_MIX_MSNS = {
        "Coal":        "CLTCB",
        "Natural Gas": "NNTCB",
        "Petroleum":   "PATCB",
        "Nuclear":     "NUETB",
        "Renewables":  "RETCB",
    }

    def list_chart_specs(self) -> list[ChartSpec]:
        """One state-click chart + three scenario-scope charts.

        State click (entity scope) — yearly time series for the current MSN
        filtered to the clicked state.

        Scenario scope (visible from the SEDS charts menu):
          * `seds__us_total_energy` — US total energy consumption (TETCB),
            1960–present, line.
          * `seds__top_states_current` — Top 15 states by the currently
            selected MSN at the currently selected year, horizontal bar.
          * `seds__us_fuel_mix` — US consumption by fuel (coal, gas, oil,
            nuclear, renewables), 1960–present, stacked area.
        """
        msns = self._msns()
        msn = msns[0]
        fuel = FUEL_LABELS.get(self._fuel, self._fuel)
        # Sector label collapses single-pick to its name, multi-pick to
        # "Sector A + Sector B + …".
        if len(self._sectors) == 1:
            sector_label = SECTOR_LABELS.get(self._sectors[0], self._sectors[0])
        else:
            sector_label = " + ".join(
                SECTOR_LABELS.get(s, s) for s in self._sectors
            )
        unit = UNIT_LABELS.get(self._unit, self._unit)
        value_scale, unit = _scaled_unit(self._unit, unit)
        _scale_opt = {"value_scale": value_scale} if value_scale else {}
        # Embed control state in the chart name so changes to fuel/sector/unit
        # force EntityInteractionManager to re-fetch — the chart's identity
        # tracks the user's current MSN selection.
        token = f"{self._fuel}_{'-'.join(self._sectors)}_{self._unit}"
        msn_list_sql = ", ".join(f"'{m}'" for m in msns)

        multi_sector = len(self._sectors) > 1

        # Single sector → line of year × summed value (one MSN).
        # Multi sector → stacked bar of year × sector, one stacked column
        # per year showing each selected sector's contribution. The join
        # against ext_seds.sectors turns the MSN's middle two chars
        # (positions 3–4) back into a human-readable label.
        if multi_sector:
            entity_sql = (
                "SELECT s.year, sec.sector_label, s.value FROM ext_seds.data s "
                "JOIN ext_seds.sectors sec ON substr(s.msn, 3, 2) = sec.sector_code "
                "WHERE s.state_code = (SELECT state_code FROM ext_seds.states "
                "WHERE statefp = '{entity_id}') "
                f"AND s.msn IN ({msn_list_sql}) "
                "ORDER BY s.year, sec.sector_label"
            )
        else:
            entity_sql = (
                "SELECT year, SUM(value) AS value FROM ext_seds.data "
                "WHERE state_code = (SELECT state_code FROM ext_seds.states "
                "WHERE statefp = '{entity_id}') "
                f"AND msn IN ({msn_list_sql}) GROUP BY year ORDER BY year"
            )

        # Stable per-sector colors so the stacked-bar legend doesn't
        # reshuffle between renders.
        sector_colors = {
            SECTOR_LABELS["TC"]: "#264653",
            SECTOR_LABELS["RC"]: "#2a9d8f",
            SECTOR_LABELS["CC"]: "#e9c46a",
            SECTOR_LABELS["IC"]: "#f4a261",
            SECTOR_LABELS["AC"]: "#e76f51",
            SECTOR_LABELS["EI"]: "#9b59b6",
            SECTOR_LABELS["TP"]: "#5b4b3a",
            SECTOR_LABELS["TX"]: "#7d7d7d",
        }

        # ── Scenario-scope chart 1: US total energy over time ────────────
        us_total_sql = (
            "SELECT year, value FROM ext_seds.data "
            "WHERE state_code = 'US' AND msn = 'TETCB' ORDER BY year"
        )

        # ── Scenario-scope chart 2: top 15 states by the current MSN/year ──
        # Embeds the current MSN list + year as literals — the chart name
        # carries both so the frontend re-fetches when controls change.
        top_n_sql = (
            "SELECT state_code, SUM(value) AS value FROM ext_seds.data "
            f"WHERE msn IN ({msn_list_sql}) AND year = {int(self._year)} "
            "AND state_code <> 'US' AND value IS NOT NULL "
            "GROUP BY state_code ORDER BY value DESC LIMIT 15"
        )

        # ── Scenario-scope chart 3: US fuel mix area chart ───────────────
        # UNION ALL one fuel category per MSN — the value_axis on each row
        # is in Billion BTU. PlotlyChart sees the category_axis and emits
        # one stacked-area trace per fuel.
        mix_parts = [
            (
                f"SELECT year, '{fuel}' AS fuel, value FROM ext_seds.data "
                f"WHERE state_code = 'US' AND msn = '{mix_msn}'"
            )
            for fuel, mix_msn in self._FUEL_MIX_MSNS.items()
        ]
        fuel_mix_sql = " UNION ALL ".join(mix_parts) + " ORDER BY year, fuel"

        # `click_control` opts the chart into the two-way binding —
        # clicking any point sends the x-value to the named input control.
        # For the SEDS year axis that's the `year` slider, which the user
        # also drives from the controls dock.
        if multi_sector:
            entity_chart_options = {
                "time_axis": "year",
                "value_axis": "value",
                "category_axis": "sector_label",
                "category_colors": sector_colors,
                "value_label": fuel,
                "value_unit": unit,
                **_scale_opt,
                "click_control": "year",
                "layout": {
                    "barmode": "stack",
                    "xaxis": {"title": "Year"},
                    "yaxis": {"title": unit},
                    "showlegend": True,
                    "legend": {"orientation": "h", "y": -0.18},
                    "margin": {"l": 70, "r": 20, "t": 30, "b": 60},
                },
            }
            entity_chart_type = "bar"
        else:
            entity_chart_options = {
                "time_axis": "year",
                "value_axis": "value",
                "value_label": fuel,
                "value_unit": unit,
                **_scale_opt,
                "click_control": "year",
                "layout": {
                    "xaxis": {"title": "Year"},
                    "yaxis": {"title": unit},
                    "showlegend": False,
                    "margin": {"l": 70, "r": 20, "t": 30, "b": 50},
                },
            }
            entity_chart_type = "line"

        return [
            ChartSpec(
                # Stable name (no control-state token). The chart re-fetches
                # on the input-control refresh key instead of via a changing
                # name, and the data endpoint rebuilds SQL from current state
                # each request — so the chart stays reactive without baking
                # mutable state into its identity (which used to 404 across
                # synced clients and break cross-display data sync).
                name="seds_state_history",
                display_name=f"{fuel} · {sector_label}",
                chart_type=entity_chart_type,
                sql_template=entity_sql,
                chart_options=entity_chart_options,
                datasets=["state-view"],
                format="plotly",
                scope="entity",
                project="seds-historical",
                scenario="all",
                width=520,
                height=320,
            ),
            ChartSpec(
                name="seds__us_total_energy",
                display_name="US Total Energy Consumption",
                chart_type="line",
                sql_template=us_total_sql,
                chart_options={
                    "time_axis": "year",
                    "value_axis": "value",
                    "value_label": "Total Energy",
                    # Data is Billion BTU; present Quadrillion BTU (÷1e6) so
                    # US-scale totals read ~0–110 instead of "100M".
                    "value_scale": 1e6,
                    "value_unit": "Quadrillion BTU",
                    "layout": {
                        "xaxis": {"title": "Year"},
                        "yaxis": {"title": "Quadrillion BTU"},
                        "showlegend": False,
                    },
                },
                datasets=[],
                format="plotly",
                scope="scenario",
                project="seds-historical",
                scenario="all",
                width=720,
                height=320,
            ),
            ChartSpec(
                name="seds__top_states_current",
                display_name=f"Top 15 States — {fuel} · {sector_label} ({int(self._year)})",
                chart_type="bar",
                sql_template=top_n_sql,
                chart_options={
                    "time_axis": "state_code",
                    "value_axis": "value",
                    "value_label": fuel,
                    "value_unit": unit,
                    **_scale_opt,
                    "orientation": "h",
                    "bar_outline": True,  # match the fuel-mix chart's segment edge
                    "layout": {
                        "xaxis": {"title": unit},
                        # No `automargin` here: combined with `autorange:
                        # 'reversed'` on this 15-label category axis it fails
                        # to converge under the app's repeated redraws (esp.
                        # at large-display CSS zoom) and Plotly bails with
                        # "Too many auto-margin redraws", leaving the plot
                        # squished. A fixed left margin wide enough for state
                        # names is stable and loop-free.
                        "yaxis": {"title": "State", "type": "category",
                                  "autorange": "reversed"},
                        "showlegend": False,
                        "margin": {"l": 48, "r": 20, "t": 30, "b": 40},
                    },
                },
                datasets=[],
                format="plotly",
                scope="scenario",
                project="seds-historical",
                scenario="all",
                width=560,
                height=480,
            ),
            ChartSpec(
                name="seds__us_fuel_mix",
                display_name="US Energy Mix by Fuel",
                chart_type="bar",  # stacked-bar by year × fuel
                sql_template=fuel_mix_sql,
                chart_options={
                    "time_axis": "year",
                    "value_axis": "value",
                    "category_axis": "fuel",
                    "category_colors": self._FUEL_MIX_COLORS,
                    "category_order": self._FUEL_MIX_ORDER,
                    "value_label": "Consumption",
                    # Billion BTU → Quadrillion BTU (÷1e6) for human-scale ticks.
                    "value_scale": 1e6,
                    "value_unit": "Quadrillion BTU",
                    "bar_outline": True,  # hairline edge so dark fuels don't blend into bg
                    "layout": {
                        "barmode": "stack",
                        "xaxis": {"title": "Year"},
                        "yaxis": {"title": "Quadrillion BTU"},
                        "showlegend": True,
                        "legend": {"orientation": "h", "y": -0.15},
                        "margin": {"l": 70, "r": 20, "t": 30, "b": 50},
                    },
                },
                datasets=[],
                format="plotly",
                scope="scenario",
                project="seds-historical",
                scenario="all",
                width=720,
                height=360,
            ),
        ]

    # ── Stateless chart resolution ───────────────────────────────────────
    def _parse_chart_token(self, chart_name: str):
        """Parse (fuel, sectors, unit, year) back out of a tokenized chart
        name; None for names that don't carry a token.

        Token format ``{fuel}_{sector1-sector2-…}_{unit}`` (fuel and unit
        carry no underscore; sectors are dash-joined), embedded as:
          * ``seds_state_history__<token>``                (entity)
          * ``seds__top_states_current__<token>__y<year>`` (scenario)
        """
        try:
            year = None
            if chart_name.startswith("seds_state_history__"):
                token = chart_name[len("seds_state_history__"):]
            elif chart_name.startswith("seds__top_states_current__"):
                rest = chart_name[len("seds__top_states_current__"):]
                token, _, ypart = rest.partition("__y")
                year = int(ypart) if ypart else None
            else:
                return None
            parts = token.split("_")
            if len(parts) != 3:
                return None
            fuel, sectors_part, unit = parts
            sectors = [s for s in sectors_part.split("-") if s]
            if not (fuel and unit and sectors):
                return None
            return fuel, sectors, unit, year
        except Exception:
            return None

    def resolve_chart_spec(self, chart_name: str):
        """Resolve a tokenized chart name to its spec regardless of current
        control state (see base class). Temporarily applies the parsed
        control state, rebuilds the specs, returns the match, and restores.

        Concurrency-safe: runs fully synchronously (no await), so the
        FastAPI event loop cannot interleave another request between the
        state swap and its restore.
        """
        parsed = self._parse_chart_token(chart_name)
        if parsed is None:
            return None
        fuel, sectors, unit, year = parsed
        saved_fuel, saved_sectors = self._fuel, list(self._sectors)
        saved_unit, saved_year = self._unit, self._year
        try:
            self._fuel, self._sectors, self._unit = fuel, sectors, unit
            if year is not None:
                self._year = year
            specs = self.list_chart_specs()
            return next((s for s in specs if s.name == chart_name), None)
        finally:
            self._fuel, self._sectors = saved_fuel, saved_sectors
            self._unit, self._year = saved_unit, saved_year

    # ── DuckDB ───────────────────────────────────────────────────────────

    def register_duckdb_tables(self, conn: Any) -> list[DuckDBTableInfo]:
        self._duckdb_conn = conn
        seds_path = CACHE_DIR / seds_mod.CACHE_FILE_NAME
        try:
            if not seds_path.exists():
                seds_mod.ensure_seds_cache(CACHE_DIR)
            if seds_path.exists():
                conn.execute(
                    "CREATE OR REPLACE VIEW ext_seds.data "
                    f"AS SELECT * FROM read_parquet('{seds_path}')"
                )
            # Reverse mapping so chart specs can resolve a clicked state's
            # STATEFP (from us-states geometry) back to SEDS's 2-letter
            # state_code. Materialized in DuckDB so SQL templates can join
            # without server-side string mangling.
            values = ", ".join(
                f"('{sc}','{fp}')" for sc, fp in _STATE_TO_FIPS.items()
            )
            conn.execute(
                "CREATE OR REPLACE VIEW ext_seds.states AS "
                f"SELECT * FROM (VALUES {values}) AS t(state_code, statefp)"
            )
            # MSN-prefix → sector label lookup, used by the multi-sector
            # stacked-bar state-click chart to split summed values back into
            # named series. Keyed by the 2-char sector code embedded at
            # positions 3–4 of every MSN.
            sec_values = ", ".join(
                f"('{code}','{label}')" for code, label in seds_mod.SECTOR_CODES.items()
            )
            conn.execute(
                "CREATE OR REPLACE VIEW ext_seds.sectors AS "
                f"SELECT * FROM (VALUES {sec_values}) AS t(sector_code, sector_label)"
            )
            # MSN-prefix → fuel label lookup (2-char fuel code at positions
            # 1–2 of every MSN), so queries can show readable fuel names.
            fuel_values = ", ".join(
                f"('{code}','{label}')" for code, label in seds_mod.FUEL_CODES.items()
            )
            conn.execute(
                "CREATE OR REPLACE VIEW ext_seds.fuels AS "
                f"SELECT * FROM (VALUES {fuel_values}) AS t(fuel_code, fuel_label)"
            )
        except Exception:
            logger.exception("[seds] DuckDB view registration failed")

        return [DuckDBTableInfo(
            table_name="ext_seds.data",
            description="EIA SEDS historical state energy data, 1960–present. "
                        "One row per (state, MSN, year). MSN encodes fuel × sector × unit.",
            columns=[
                {"name": "data_status", "type": "VARCHAR",
                 "description": "Vintage marker (e.g. '2023F')"},
                {"name": "msn", "type": "VARCHAR",
                 "description": "5-char mnemonic series (e.g. ESTCB = Electricity, "
                                "Total Consumption, BTU)"},
                {"name": "state_code", "type": "VARCHAR",
                 "description": "2-letter state abbreviation; US = national total"},
                {"name": "year", "type": "INTEGER", "description": "Calendar year"},
                {"name": "value", "type": "DOUBLE",
                 "description": "Value in units implied by MSN suffix"},
            ],
            extension_name="seds",
        )]

    # ── AI ───────────────────────────────────────────────────────────────

    def get_ai_schema(self) -> AISchema:
        return AISchema(
            description=(
                "SEDS extension providing EIA state-level historical energy "
                "data. MSN codes encode fuel × sector × unit "
                "(e.g. ESTCB = Electricity, Total Consumption, BTU)."
            ),
            tables=[
                AITableSchema(
                    table_name="ext_seds.data",
                    description=(
                        "EIA SEDS state-level historical energy data, 1960–present. "
                        "MSN is 5 chars: fuel=substr(msn,1,2), sector=substr(msn,3,2), "
                        "unit=substr(msn,5,1). To show READABLE fuel/sector names "
                        "(never the 2-letter codes), JOIN the ext_seds.fuels / "
                        "ext_seds.sectors lookup views below."
                    ),
                    columns=[
                        {"name": "data_status", "type": "VARCHAR"},
                        {"name": "msn", "type": "VARCHAR"},
                        {"name": "state_code", "type": "VARCHAR"},
                        {"name": "year", "type": "INTEGER"},
                        {"name": "value", "type": "DOUBLE"},
                    ],
                    example_queries=[
                        "SELECT state_code, value FROM ext_seds.data WHERE msn='ESTCB' AND year=2020 AND state_code <> 'US' ORDER BY value DESC LIMIT 10",
                        "SELECT year, value FROM ext_seds.data WHERE msn='TETCB' AND state_code='US' ORDER BY year",
                        # Readable sector names via JOIN (NOT the 2-letter code):
                        "SELECT s.year, sec.sector_label, s.value FROM ext_seds.data s JOIN ext_seds.sectors sec ON substr(s.msn,3,2)=sec.sector_code WHERE substr(s.msn,1,2)='ES' AND substr(s.msn,5,1)='B' AND s.state_code='TX' AND sec.sector_code <> 'TC' ORDER BY s.year, sec.sector_label",
                        # Readable fuel names via JOIN:
                        "SELECT f.fuel_label, s.value FROM ext_seds.data s JOIN ext_seds.fuels f ON substr(s.msn,1,2)=f.fuel_code WHERE substr(s.msn,3,2)='TC' AND substr(s.msn,5,1)='B' AND s.state_code='CA' AND s.year=2020 ORDER BY s.value DESC",
                    ],
                ),
                AITableSchema(
                    table_name="ext_seds.sectors",
                    description="Lookup: 2-char sector_code → readable sector_label (e.g. 'RC'→'Residential'). JOIN on substr(msn,3,2)=sector_code.",
                    columns=[
                        {"name": "sector_code", "type": "VARCHAR"},
                        {"name": "sector_label", "type": "VARCHAR"},
                    ],
                ),
                AITableSchema(
                    table_name="ext_seds.fuels",
                    description="Lookup: 2-char fuel_code → readable fuel_label (e.g. 'ES'→'Electricity'). JOIN on substr(msn,1,2)=fuel_code.",
                    columns=[
                        {"name": "fuel_code", "type": "VARCHAR"},
                        {"name": "fuel_label", "type": "VARCHAR"},
                    ],
                ),
            ],
            controls=[
                AIControlSchema(control_name="fuel",
                    description="2-char fuel code: TE/ES/CL/NN/PA/NU/RE/SO/WY/HY/GE/BM.",
                    value_type="string"),
                AIControlSchema(control_name="sector",
                    description="List of 2-char sector codes — values are SUMMED on "
                                "the map / chart. Codes: TC/RC/CC/IC/AC/EI/TP/TX. "
                                "Example: ['RC','CC'] for residential+commercial.",
                    value_type="list[string]"),
                AIControlSchema(control_name="unit",
                    description="1-char unit code: B=BTU, P=Physical, D=Dollars, K=Price.",
                    value_type="string"),
                AIControlSchema(control_name="year",
                    description="Historical year, 1960 through latest available.",
                    value_type="integer", value_range="1960-2023 step 1"),
            ],
            example_prompts=[
                "What were the top 5 states for electricity consumption in 2020?",
                "Show coal consumption trends for West Virginia since 1970.",
                "Compare natural gas consumption across CA, TX, NY over time.",
            ],
        )
