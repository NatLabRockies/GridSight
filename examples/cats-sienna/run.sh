#!/usr/bin/env bash
# Container entry point: fetch inputs, build the Sienna system, run the
# week of economic dispatch. Outputs land in $OUTPUT_DIR (default /output).
set -euo pipefail
cd /work

export DATA_DIR="${DATA_DIR:-/data}"
export OUTPUT_DIR="${OUTPUT_DIR:-/output}"
export CATS_DIR="$DATA_DIR/CATS-CaliforniaTestSystem"
export DATA_DIR_PROFILES="$DATA_DIR/profiles"

start=$(date +%s)
bash fetch_data.sh
DATA_DIR="$DATA_DIR_PROFILES" julia --project=. build_system.jl
julia --project=. run_ed.jl
cp "$CATS_DIR/GIS/CATS_buses.csv" "$OUTPUT_DIR/bus_coordinates.csv"
echo
echo "✓ Done in $(( ($(date +%s) - start) / 60 )) min. Outputs in $OUTPUT_DIR:"
ls -lh "$OUTPUT_DIR" | sed 1d
