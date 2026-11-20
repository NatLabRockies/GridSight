"""
EIA SEDS (State Energy Data System) loader.

Downloads the complete SEDS dataset on demand, caches it locally as Parquet,
and exposes query helpers. SEDS is annual state-level energy data,
1960–present, indexed by 5-character MSN codes (fuel × sector × unit).

The fuel/sector/unit dicts here are a curated v1 covering the most common
combinations. SEDS publishes ~600 MSNs; most users care about a few dozen.
Invalid combinations gracefully resolve to no data on the map.
"""
from __future__ import annotations

import io
import json
import logging
import os
import time
import zipfile
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

logger = logging.getLogger("demand_tldr_ext.seds")

CACHE_FILE_NAME = "complete_seds.parquet"
CACHE_TTL_DAYS = 180

# US-states polygons, downloaded + cached on first use (the boundaries are
# static, so this runs once). Feature `id` is the 2-digit state FIPS and
# `properties.name` is the state name; we normalize both into STATEFP/NAME —
# the join key + label the SEDS layer expects. Point SEDS_GEOJSON_URL at a
# self-hosted copy to avoid the public dependency.
STATES_GEOJSON_CACHE_NAME = "us-states.geojson"
DEFAULT_STATES_GEOJSON_URL = (
    # Census Bureau 5m Cartographic Boundary file — much higher resolution
    # than the old PublicaMundi 20m source, so state borders render cleanly
    # on the large display wall. Properties: GEO_ID, STATE (2-digit FIPS),
    # NAME — all picked up by _normalize_states_geojson without changes.
    "https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_040_00_5m.json"
)

# EIA's "complete_seds" alias was removed; use_all_btu is the current
# all-states all-MSN BTU file (wide format, one column per year).
# The page lists this URL at
# https://www.eia.gov/state/seds/seds-data-complete.cfm?sid=US
DIRECT_URLS = [
    "https://www.eia.gov/state/seds/sep_use/total/csv/use_all_btu.zip",
    "https://www.eia.gov/state/seds/sep_use/total/csv/use_all_btu.csv",
]


def _inject_system_trust() -> None:
    """Make `requests` trust the OS CA store. eia.gov's chain is sometimes
    rejected by certifi's Mozilla bundle but is valid against the macOS
    keychain / Linux ca-certificates. Idempotent and a no-op if truststore
    isn't installed."""
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        logger.debug("[seds] truststore not installed; using default certifi bundle")


def _normalize_states_geojson(gj: dict) -> dict:
    """Ensure every feature carries STATEFP (2-digit FIPS) + NAME, derived
    from whatever the source provides — a feature-level `id` (FIPS), or
    STATE/STATEFP and name/NAME properties. The SEDS layer joins on STATEFP
    and labels by NAME, so we normalize once at download time."""
    for feat in gj.get("features", []):
        props = feat.setdefault("properties", {})
        fid = feat.get("id")
        statefp = (
            props.get("STATEFP")
            or props.get("STATE")
            or (str(fid).zfill(2) if fid is not None and str(fid).isdigit() else None)
        )
        if statefp is not None:
            props["STATEFP"] = str(statefp).zfill(2)
        name = props.get("NAME") or props.get("name") or props.get("STATE_NAME")
        if name:
            props["NAME"] = name
    return gj


def ensure_states_geojson(cache_dir: Path) -> Path:
    """Path to the US-states GeoJSON, downloaded + cached (normalized to
    STATEFP/NAME) on first use. Override the source with SEDS_GEOJSON_URL.
    Falls back to a packaged copy only if a download fails and one exists."""
    cache_dir = Path(cache_dir)
    cached = cache_dir / STATES_GEOJSON_CACHE_NAME
    if cached.exists():
        return cached
    url = os.environ.get("SEDS_GEOJSON_URL", DEFAULT_STATES_GEOJSON_URL)
    try:
        _inject_system_trust()
        import requests
        resp = requests.get(url, timeout=120, headers={"User-Agent": "meridian-seds"})
        resp.raise_for_status()
        gj = _normalize_states_geojson(resp.json())
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(gj))
        logger.info("[seds] cached states geometry from %s (%d features)",
                    url, len(gj.get("features", [])))
        return cached
    except Exception as exc:
        packaged = Path(__file__).parent / "data" / "states.geojson"
        if packaged.exists():
            logger.warning("[seds] states geojson download failed (%s); using packaged copy", exc)
            return packaged
        raise RuntimeError(
            f"Could not obtain US-states geometry: download from {url} failed "
            f"({exc}) and no packaged fallback is present"
        ) from exc

# Curated MSN component dictionaries. These cover ~80% of common queries.
# The MSN structure (positions 1–2 fuel, 3–4 sector, 5 unit) is an EIA
# convention; some codes use 3-char fuel prefixes (e.g. CO2).
FUEL_CODES: dict[str, str] = {
    "TE": "Total Energy",
    "ES": "Electricity",
    "CL": "Coal",
    "NN": "Natural Gas",
    "PA": "Petroleum",
    "NU": "Nuclear",
    "RE": "Renewables",
    "SO": "Solar",
    "WY": "Wind",
    "HY": "Hydro",
    "GE": "Geothermal",
    "BM": "Biomass",
}

SECTOR_CODES: dict[str, str] = {
    "TC": "Total Consumption",
    "RC": "Residential",
    "CC": "Commercial",
    "IC": "Industrial",
    "AC": "Transportation",
    "EI": "Electric Power",
    "TP": "Total Production",
    "TX": "Total Expenditures",
}

UNIT_CODES: dict[str, str] = {
    "B": "Billion BTU",
    "P": "Physical Units",
    "D": "Dollars (Million)",
    "K": "Price ($/MMBtu)",
}

# MSN codes that match `{fuel}{sector}` but use a non-standard unit suffix
# for electricity-aligned series (used by the shared-legend path).
ELECTRICITY_MSN = "ESTCB"  # Electricity, Total Consumption, BTU


def _is_cache_fresh(path: Path, ttl_days: int = CACHE_TTL_DAYS) -> bool:
    if not path.exists():
        return False
    age_seconds = time.time() - path.stat().st_mtime
    return age_seconds < ttl_days * 86400


def _download_csv() -> pa.Table:
    """Download SEDS use_all_btu (wide CSV), reshape to long format.
    Raises on total failure across all candidate URLs.
    """
    import requests
    _inject_system_trust()

    last_error: Exception | None = None
    for url in DIRECT_URLS:
        try:
            logger.info("[seds] downloading %s", url)
            resp = requests.get(url, timeout=120)
            resp.raise_for_status()
            content = resp.content
            if url.endswith(".zip") or resp.headers.get("Content-Type", "").startswith("application/zip"):
                with zipfile.ZipFile(io.BytesIO(content)) as z:
                    names = [n for n in z.namelist() if n.endswith(".csv")]
                    target = next((n for n in names if "use_all_btu" in n.lower()), names[0])
                    with z.open(target) as f:
                        return _wide_csv_to_long(f.read())
            return _wide_csv_to_long(content)
        except Exception as e:
            last_error = e
            logger.warning("[seds] download failed for %s: %s", url, e)
    raise RuntimeError(f"SEDS download failed: {last_error}")


def _wide_csv_to_long(raw: bytes) -> pa.Table:
    """Reshape EIA's wide CSV (Data_Status, State, MSN, 1960, 1961, ...) into
    long format (data_status, state_code, msn, year, value).

    Uses polars if available (server has it); falls back to a manual loop.
    """
    text = raw.decode("utf-8", errors="replace")
    try:
        import polars as pl
        df = pl.read_csv(io.BytesIO(text.encode()), infer_schema_length=10000)
        id_cols = [c for c in ("Data_Status", "State", "MSN") if c in df.columns]
        year_cols = [c for c in df.columns if c.isdigit() and 1900 <= int(c) <= 2100]
        long = df.unpivot(
            on=year_cols, index=id_cols,
            variable_name="year", value_name="value",
        )
        long = long.with_columns(
            pl.col("year").cast(pl.Int32),
            pl.col("value").cast(pl.Float64, strict=False),
        ).rename({"Data_Status": "data_status", "State": "state_code", "MSN": "msn"})
        return long.to_arrow()
    except ImportError:
        return _wide_csv_to_long_pure(text)


def _wide_csv_to_long_pure(text: str) -> pa.Table:
    """Fallback reshape using stdlib csv. Slower but no extra deps."""
    import csv as _csv

    reader = _csv.reader(io.StringIO(text))
    header = next(reader)
    try:
        ds_i, st_i, msn_i = header.index("Data_Status"), header.index("State"), header.index("MSN")
    except ValueError as e:
        raise RuntimeError(f"SEDS CSV missing required columns: {header[:5]}") from e
    year_idx = [(i, int(c)) for i, c in enumerate(header) if c.isdigit() and 1900 <= int(c) <= 2100]

    ds_list, st_list, msn_list, yr_list, val_list = [], [], [], [], []
    for row in reader:
        if not row:
            continue
        ds, st, msn = row[ds_i], row[st_i], row[msn_i]
        for i, yr in year_idx:
            cell = row[i] if i < len(row) else ""
            try:
                v = float(cell) if cell not in ("", "NA", "--", "NM") else None
            except ValueError:
                v = None
            ds_list.append(ds); st_list.append(st); msn_list.append(msn)
            yr_list.append(yr); val_list.append(v)
    return pa.table({
        "data_status": pa.array(ds_list, pa.string()),
        "state_code": pa.array(st_list, pa.string()),
        "msn": pa.array(msn_list, pa.string()),
        "year": pa.array(yr_list, pa.int32()),
        "value": pa.array(val_list, pa.float64()),
    })


def ensure_seds_cache(cache_dir: Path, force: bool = False) -> Path:
    """Ensure complete_seds.parquet exists under cache_dir; download if missing
    or older than CACHE_TTL_DAYS. Returns the parquet path.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / CACHE_FILE_NAME
    if not force and _is_cache_fresh(out):
        return out

    table = _download_csv()
    pq.write_table(table, out)
    logger.info("[seds] wrote %d rows to %s", table.num_rows, out)
    return out


def load_seds(cache_dir: Path) -> pa.Table:
    path = ensure_seds_cache(cache_dir)
    return pq.read_table(path)


def state_values_for_msn(
    table: pa.Table,
    msn: str,
    year: int,
    state_to_fips: dict[str, str],
) -> dict[str, float]:
    """Filter SEDS rows for one MSN × year and return {STATEFP: value}.

    Drops the synthetic "US" state code and any state not in state_to_fips.
    Caller maps STATEFP → state_to_fips["AL"] etc.
    """
    import pyarrow.compute as pc

    mask = pc.and_(
        pc.equal(table.column("msn"), msn),
        pc.equal(table.column("year"), year),
    )
    sub = table.filter(mask)
    out: dict[str, float] = {}
    for sc, val in zip(
        sub.column("state_code").to_pylist(),
        sub.column("value").to_pylist(),
    ):
        if val is None:
            continue
        fips = state_to_fips.get(sc)
        if fips is None:
            continue
        out[fips] = float(val)
    return out


def available_msn_codes(table: pa.Table) -> set[str]:
    """Return the set of MSN codes present in the loaded data."""
    return set(table.column("msn").unique().to_pylist())


def year_range(table: pa.Table) -> tuple[int, int]:
    import pyarrow.compute as pc

    yrs = table.column("year")
    return int(pc.min(yrs).as_py()), int(pc.max(yrs).as_py())
