#!/usr/bin/env bash
# scripts/cleanup_stale_layers.sh
#
# Removes orphan layer / geometry / dataset rows from gridsight.db. Two classes
# of orphan are cleaned up:
#
#   1. Deprecated layer types — e.g. the legacy ScatterplotLayer-based
#      `*__generation` layer that was superseded by the dual-radius
#      GeneratorLayer-based `*__renewable` + `*__thermal` pair. These rows
#      never serve real geometry once the extension is restarted (the
#      registration was removed in code) but they sit in gridsight.db until
#      explicitly deleted.
#
#   2. Stale extension references — gridsight.db rows whose
#      `(extension_name, project, scenario)` triple doesn't appear in the
#      extension's current scenario registry. Most common cause: ingest data
#      moved (e.g. switching GAT_DB_PATH from S3 to local) leaves rows
#      pointing at scenarios that no longer exist locally.
#
# Idempotent — safe to run repeatedly. Run after restarting the server so
# extensions reload from their current source-of-truth.
#
# Usage:
#   ./scripts/cleanup_stale_layers.sh                # dry-run (default)
#   ./scripts/cleanup_stale_layers.sh --apply        # actually delete
#   GRIDSIGHT_DB=/path/to/gridsight.db ./scripts/cleanup_stale_layers.sh
#   GAT_DB=/path/to/gat_server.duckdb ./scripts/cleanup_stale_layers.sh

set -euo pipefail
cd "$(dirname "$0")/.."

GRIDSIGHT_DB="${GRIDSIGHT_DB:-./data/gridsight.db}"
GAT_DB="${GAT_DB:-${HOME}/.gat/server/gat_server.duckdb}"
APPLY=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help)
      sed -n 's/^# \{0,1\}//p' "$0" | head -25
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$GRIDSIGHT_DB" ]; then
  echo "gridsight.db not found at $GRIDSIGHT_DB" >&2
  exit 1
fi

PYTHON=./server/.venv/bin/python
if [ ! -x "$PYTHON" ]; then
  PYTHON=python3
fi

APPLY="$APPLY" GRIDSIGHT_DB="$GRIDSIGHT_DB" GAT_DB="$GAT_DB" "$PYTHON" - <<'PYEOF'
import os, sqlite3, sys

apply = os.environ.get("APPLY") == "1"
mer_path = os.environ["GRIDSIGHT_DB"]
gat_path = os.environ["GAT_DB"]

mer = sqlite3.connect(mer_path)
mer.row_factory = sqlite3.Row

# ── 1. Deprecated layer types ─────────────────────────────────────────────
# Anything matching `*__generation` from a `gat` extension is the legacy
# ScatterplotLayer that was removed from list_layers(). Rows in `layers`,
# `layer_datasets`, `layer_style_mappings`, and the matching
# `geometry_files` row.
deprecated_layer_rows = list(mer.execute(
    "SELECT id, name, deck_layer_type FROM layers "
    "WHERE name LIKE '%\\_\\_generation' ESCAPE '\\' "
    "  AND source_extension = 'gat' "
    "  AND deck_layer_type = 'ScatterplotLayer'"
))
deprecated_geom_rows = list(mer.execute(
    "SELECT id, name, extension_ref FROM geometry_files "
    "WHERE extension_ref LIKE '\\_\\_layer\\_geo\\_\\_%\\_\\_generation' ESCAPE '\\' "
    "  AND extension_name = 'gat'"
))

# ── 2. Stale GAT extension refs ───────────────────────────────────────────
# Read the GAT registry's currently-valid (project, scenario) pairs and
# treat anything in gridsight.db with a `gat` extension and a different
# `prefix__` as stale.
valid_prefixes = set()
try:
    import duckdb
    conn = duckdb.connect(gat_path, read_only=True)
    rows = conn.execute(
        "SELECT project, scenario FROM _gat_registry.scenarios WHERE status = 'ready'"
    ).fetchall()
    valid_prefixes = {f"{p}__{s}" for p, s in rows}
    conn.close()
except Exception as e:
    print(f"  warning: could not read GAT registry at {gat_path} ({e}); skipping stale-prefix cleanup")

def has_valid_prefix(extension_ref):
    """True if extension_ref starts with `prefix__` for some live scenario."""
    if not extension_ref:
        return True
    # Geometry refs look like `__layer_geo__{project}__{scenario}__{type}`.
    # Dataset/layer refs look like `{project}__{scenario}__{type}`.
    s = extension_ref.replace("__layer_geo__", "", 1)
    parts = s.split("__")
    if len(parts) < 2:
        return True
    return f"{parts[0]}__{parts[1]}" in valid_prefixes

stale_layers = []
stale_datasets = []
stale_geoms = []
if valid_prefixes:
    for r in mer.execute("SELECT id, name FROM layers WHERE source_extension = 'gat'"):
        if not has_valid_prefix(r["name"]):
            stale_layers.append(r)
    for r in mer.execute("SELECT id, name, extension_ref FROM datasets WHERE extension_name = 'gat'"):
        if not has_valid_prefix(r["extension_ref"]):
            stale_datasets.append(r)
    for r in mer.execute("SELECT id, name, extension_ref FROM geometry_files WHERE extension_name = 'gat'"):
        if not has_valid_prefix(r["extension_ref"]):
            stale_geoms.append(r)

# ── Report ───────────────────────────────────────────────────────────────
def report(title, rows, fields):
    print(f"\n{title}: {len(rows)}")
    for r in rows[:20]:
        vals = "  ".join(f"{f}={r[f]!r}" for f in fields)
        print(f"  - {vals}")
    if len(rows) > 20:
        print(f"  … ({len(rows) - 20} more)")

report("Deprecated layers (*__generation)", deprecated_layer_rows, ["id", "name"])
report("Deprecated geometry_files",          deprecated_geom_rows,  ["id", "name", "extension_ref"])
report("Stale GAT layers",                   stale_layers,           ["id", "name"])
report("Stale GAT datasets",                 stale_datasets,         ["id", "name", "extension_ref"])
report("Stale GAT geometry_files",           stale_geoms,            ["id", "name", "extension_ref"])

if not apply:
    print("\n(dry-run — pass --apply to delete)")
    sys.exit(0)

# ── Apply ───────────────────────────────────────────────────────────────
def delete_layer(layer_id):
    mer.execute("DELETE FROM layer_style_mappings WHERE layer_id = ?", [layer_id])
    mer.execute("DELETE FROM layer_datasets       WHERE layer_id = ?", [layer_id])
    mer.execute("DELETE FROM layers                WHERE id       = ?", [layer_id])

def delete_geom(geom_id):
    mer.execute("DELETE FROM scenario_geometries WHERE geometry_id = ?", [geom_id])
    mer.execute("DELETE FROM geometry_files      WHERE id          = ?", [geom_id])

def delete_dataset(ds_id):
    mer.execute("DELETE FROM scenario_datasets WHERE dataset_id = ?", [ds_id])
    mer.execute("DELETE FROM layer_datasets    WHERE dataset_id = ?", [ds_id])
    mer.execute("DELETE FROM datasets          WHERE id          = ?", [ds_id])

for r in deprecated_layer_rows: delete_layer(r["id"])
for r in deprecated_geom_rows:   delete_geom(r["id"])
for r in stale_layers:           delete_layer(r["id"])
for r in stale_datasets:         delete_dataset(r["id"])
for r in stale_geoms:            delete_geom(r["id"])

mer.commit()
print(f"\nApplied. {mer.total_changes} rows touched.")
PYEOF
