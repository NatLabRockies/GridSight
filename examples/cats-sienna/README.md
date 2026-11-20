# CATS + Sienna demo data

This example makes the data for the GridSight CATS demo. It runs a one-week
production-cost simulation of the **California Test System (CATS)** with
**Sienna** (PowerSystems.jl and PowerSimulations.jl), and writes the files
that the GAT extension loads into GridSight.

- **System:** CATS, a synthetic grid on California's real geography: 8,870
  buses, 10,823 lines and transformers, and 3,892 generators.
- **Week:** 2019-08-12 to 2019-08-18, hourly (168 hours). The 2019 peak load
  is in this week.
- **Model:** economic dispatch, DC power flow with network slacks, HiGHS.
  One decision step for each day.

## Run it

You need Docker with about 16 GB of memory for the container.

```bash
docker build -t gridsight-cats-sienna examples/cats-sienna
docker run --rm \
  -v gridsight-cats-data:/data \
  -v "$PWD/cats-output:/output" \
  gridsight-cats-sienna
```

- The first run downloads the CATS repository and the 2019 load and
  renewable profiles (about 600 MB) into the `gridsight-cats-data` volume.
  Later runs use the cached copy.
- The run takes about 25 minutes on a laptop CPU (Apple M-series, Colima).
  Most of the time is the seven daily LP solves (3 to 5 minutes each).

**Behind a TLS-intercepting proxy?** The profile download can fail with a
certificate error. Download the two files from the
[CATS data folder](https://tinyurl.com/SyntheticCaliforniaGridData) yourself,
put them in a folder, and add `-v /path/to/that/folder:/data/profiles` to
`docker run`. The script checks their SHA-256 and does not download them again.

### Options (`docker run -e NAME=value`)

| Name | Default | Description |
|---|---|---|
| `START_HOUR` | `5352` | First hour, counted from 2019-01-01 00:00. `5352` is 2019-08-12 00:00. |
| `HOURS` | `168` | Number of hours. Use a multiple of 24. |
| `STEPS` | all days | Number of daily steps to solve. Use `STEPS=1` for a quick test. |
| `HIGHS_SOLVER` | `ipm` | `ipm` (interior point) or `simplex`. |

## Output

| File | Description |
|---|---|
| `system.json`, `system_time_series_storage.h5`, `system_metadata.json` | The Sienna system, with the week of profiles, bus coordinates and line routes. |
| `simulation_store.h5` | The PowerSimulations results. |
| `bus_coordinates.csv` | CATS bus coordinates. Use it with the GAT extension's geometry upload if your GAT version does not read coordinates from `system.json`. |

## Load it into GridSight

1. Install the GAT extension. See the
   [GAT `gridsight-ext` README](https://github.com/NatLabRockies/GridAnalysisToolkit/tree/main/gridsight-ext).
2. In GridSight, open the GAT extension's upload, and select
   `cats-output/system.json` and `cats-output/simulation_store.h5`.
3. Lines are drawn on their real routes, and buses at their real positions.

## The story

[`story/cats-summer-peak.json`](story/cats-summer-peak.json) is the agent-built story shown in the
main README: 8 chapters (generation capacity, lines by voltage, wildfire exposure, the week of
dispatch with the chart tray, and the peak hour). An agent made it with GridSight's MCP tools;
nothing in it was configured by hand.

To play it:

1. Load the simulation output as above. The scenario must be named `CATS` / `Summer peak 2019`.
2. Add the two wildfire overlays from [`overlays/`](overlays) (the agent used `create_geojson_layer`;
   you can also use **Upload Geometry** in the app's data manager and make a layer from each file).
3. Import the story with **Import** under the story picker in the sidebar, or ask your agent to
   `import_story` with the path to the file. Chapters that need a layer you do not have are listed
   as warnings.

## How the inputs are mapped

The profile mapping follows the CATS scripts
(`Script/test_eval_functions.jl` in the CATS repository):

- **Load:** row *b* of `Load_Agg_Post_Assignment_v3_latest.csv` is the hourly
  load (MW) of bus *b*. Only buses that have a load in the case are used.
- **Solar and wind:** each unit gets the statewide hourly solar or wind
  output from `HourlyProduction2019.csv`, scaled by its share of the fleet's
  capacity. All solar units have the same profile shape, and all wind units
  have the same profile shape.
- **Fuel types:** from `FuelType` in `GIS/CATS_gens.csv`, so that the dispatch
  can be grouped by fuel.

## Simplifications

This is a visualization demo, not a study.

- Quadratic generator costs are replaced by their marginal cost at half of
  the unit's maximum output, so each step is a linear program.
- There is no unit commitment and there are no ramp limits.
- Batteries, pumped storage and synchronous condensers are not available.
- Network slacks keep each step feasible. Large slack values mean that the
  case cannot serve the load at that place and time.

## Credits

CATS is by Taylor, Rangarajan, Rhodes, Snodgrass, Lesieutre and Roald
(BSD-3-Clause, https://github.com/WISPO-POP/CATS-CaliforniaTestSystem). If you
use this data, cite:

> S. Taylor, A. Rangarajan, N. Rhodes, J. Snodgrass, B. C. Lesieutre and
> L. A. Roald, "California Test System (CATS): A Geographically Accurate Test
> System Based on the California Grid," *IEEE Transactions on Energy Markets,
> Policy and Regulation*, vol. 2, no. 1, pp. 107–118, 2024,
> doi:10.1109/TEMPR.2023.3338568.
