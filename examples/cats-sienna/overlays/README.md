# Wildfire overlays for the CATS story

The story adds public wildfire data on top of the CATS grid, to show how an agent can bring in data from another source. These are fixed copies, so the story can be rebuilt with the same data. To refresh them, run `./fetch_overlays.sh`. It needs `curl` and `python3`.

| File | Contents | Source |
|---|---|---|
| `calfire_perimeters_2019.geojson` | 318 fire perimeters from 2019: name, agency, alarm and containment dates, cause code, acres | CAL FIRE (FRAP), *California Fire Perimeters (all)*, ArcGIS feature service `California_Historic_Fire_Perimeters/FeatureServer/0`, filter `YEAR_ = 2019` |
| `cpuc_high_fire_threat_districts.geojson` | CPUC High Fire-Threat District: Tier 3 (Extreme) and Tier 2 (Elevated), property `tier` | CPUC Fire-Threat Map, published by Cal OES as *Utilities Fire Threat Areas* (`CPUC_Fire_Threat_Areas/FeatureServer`, layers 0 and 1) |

Downloaded in November 2026. The servers simplified the geometry (about 200 m for the fire perimeters and 500 m for the fire-threat tiers), so do not use these files for engineering work.

## Notes

- **CPUC map:** the fire-threat map comes from CPUC Rulemaking R.15-05-006 (D.17-01-009, revised by D.17-06-024). It sets where stricter fire-safety rules apply to utility lines.
- **Dates:** the CATS demo week is 12–18 August 2019. Most of the large 2019 fires (Kincade, Saddle Ridge, Maria) started in October, so the story uses the perimeters to show exposure in the 2019 fire year, not fires that burned during the simulated week.
- **Terms of use:** see the source pages of CAL FIRE FRAP and the CPUC. Both datasets are published as public data.
