#!/usr/bin/env bash
# Rebuild the wildfire overlays used by the CATS story (fixed copies are
# committed next to this script; run it only to refresh them).
#
#   calfire_perimeters_2019.geojson         CAL FIRE fire perimeters, YEAR_ = 2019
#   cpuc_high_fire_threat_districts.geojson CPUC High Fire-Threat District (Tier 2, Tier 3)
#
# Both come from public ArcGIS feature services. Geometry is simplified on the
# server (maxAllowableOffset, degrees) to keep the files small.
set -euo pipefail
cd "$(dirname "$0")"

FIRES="https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/California_Historic_Fire_Perimeters/FeatureServer/0/query"
HFTD="https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/CPUC_Fire_Threat_Areas/FeatureServer"

curl -fsS --max-time 120 -o raw_fires.geojson \
  "$FIRES?where=YEAR_%3D2019&outFields=YEAR_,FIRE_NAME,AGENCY,UNIT_ID,ALARM_DATE,CONT_DATE,CAUSE,GIS_ACRES&outSR=4326&maxAllowableOffset=0.002&geometryPrecision=5&f=geojson"
for i in 0 1; do  # 0 = Tier 3 (Extreme), 1 = Tier 2 (Elevated)
  curl -fsS --max-time 120 -o "raw_hftd_$i.geojson" \
    "$HFTD/$i/query?where=1%3D1&outFields=*&outSR=4326&maxAllowableOffset=0.005&geometryPrecision=5&f=geojson"
done

python3 - <<'EOF'
import datetime, json

def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).date().isoformat() if ms else None

d = json.load(open("raw_fires.geojson"))
feats = []
for f in d["features"]:
    p = f["properties"]
    f["properties"] = {
        "fire_name": (p.get("FIRE_NAME") or "").title(),
        "year": p.get("YEAR_"),
        "agency": p.get("AGENCY"),
        "unit_id": p.get("UNIT_ID"),
        "alarm_date": iso(p.get("ALARM_DATE")),
        "containment_date": iso(p.get("CONT_DATE")),
        "cause_code": p.get("CAUSE"),
        "acres": round(p.get("GIS_ACRES") or 0, 1),
    }
    feats.append(f)
json.dump({"type": "FeatureCollection", "features": feats},
          open("calfire_perimeters_2019.geojson", "w"), separators=(",", ":"))

out = []
for i, tier, label in ((0, 3, "Tier 3 - Extreme"), (1, 2, "Tier 2 - Elevated")):
    for f in json.load(open(f"raw_hftd_{i}.geojson"))["features"]:
        out.append({"type": "Feature", "geometry": f["geometry"],
                    "properties": {"tier": tier, "tier_label": label}})
json.dump({"type": "FeatureCollection", "features": out},
          open("cpuc_high_fire_threat_districts.geojson", "w"), separators=(",", ":"))
print(f"{len(feats)} fire perimeters, {len(out)} fire-threat tiers")
EOF
rm -f raw_fires.geojson raw_hftd_*.geojson
