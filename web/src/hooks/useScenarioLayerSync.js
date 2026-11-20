import { useEffect, useRef } from 'react';
import { TimeseriesBuffer } from '../lib/TimeseriesBuffer.js';
import {
  fetchAllLayers,
  fetchGeometryData,
  fetchDatasetData,
} from '../lib/loaders.js';
import { buildDataIndex } from '../lib/layer_generators.js';
import { isAbortError } from '../lib/requestControl.js';

// Scope the loaded layer set to the active selection. `/api/layers/all` returns
// every layer across every project+scenario, so without this a multi-project /
// multi-scenario extension (e.g. Grid, which has Demo/Base, Demo/test AND
// test/test) would load every combination at once. Rule: the ACTIVE extension
// (the one owning the current project) shows only its selected project+scenario;
// OTHER extensions pass through with their own layers (multi-extension
// coexistence). Layer entries carry `.project`/`.scenario`/`.source_extension`
// from getAllLayers.
export function scenarioScopedLayers(layers, scenarioState, activeExtName) {
  const proj = scenarioState?.project;
  const scen = scenarioState?.scenario;
  if (!proj || !scen || !Array.isArray(layers)) return layers;
  return layers.filter((l) => {
    const ext = l.source_extension || l.extension_name;
    if (activeExtName && ext) {
      // Active extension → only its selected project+scenario; others pass.
      return ext !== activeExtName || (l.project === proj && l.scenario === scen);
    }
    // Unknown active extension → scope by project only (previous behavior).
    return l.project !== proj || !l.scenario || l.scenario === scen;
  });
}

export function useScenarioLayerSync({
  scenarioState,
  extensions,
  extensionsLoaded,
  map,
  versions,
  updateClockState,
}) {
  const timeseriesBuffersRef = useRef(new Map());
  // Maps layerId → Map<role, datasetId> so the clock tick handler can fan out buffer data.
  // The "primary" role is always the first/default timeseries dataset.
  /** @type {React.MutableRefObject<Map<number, Map<string, number>>>} */
  const layerToDatasetsRef = useRef(new Map());
  // Monotonic counter bumped on every scenario-change effect run. Async
  // continuations inside `bootstrapLayers` (per-layer geo fetch, buffer
  // init, layer-data fetch) capture the value at start-of-run and bail
  // if the ref's current value has moved past it — that's how we keep
  // an old scenario's late-arriving writes from clobbering a new one's
  // clockState / layer data, and how we suppress StrictMode duplicates.
  const scenarioGenRef = useRef(0);
  // Tracks the last project the sync effect actually processed, so we can tell
  // a "focus switch" (clicking a different extension's drawer entry, which
  // changes the active project) apart from a genuine same-extension scenario
  // change. Focus switches must leave already-loaded layers untouched.
  const prevProjectRef = useRef(null);
  // Staged presentation state from a story-chapter apply. A chapter that
  // changes scenario/extensions triggers an async layer reload whose
  // default_style/painting patching would clobber the chapter's localStyle
  // that applyViewState set synchronously — the bug where the first click on a
  // chapter landed on defaults and only the second click (same scenario, no
  // reload) looked right. handleApplyPerspective stages the chapter here with a
  // short TTL; bootstrapLayers re-asserts it (idempotently) over the freshly
  // built defaults on every reload within the window, covering the concurrent
  // extension + scenario reloads a single apply can spawn.
  // Shape: { localStyle: {id:style}, visibility: {id:bool}, deadline: ms }.
  const pendingPerspectiveStyleRef = useRef(null);

  // Recompute domain_min/domain_max for a layer's fillColor/elevation/etc.
  // mappings from the actual values in the freshly-fetched rows. Stored as
  // mappingOverrides so the user can still manually re-override via the
  // layer styler. For log scales we exclude zero/negative values; if no
  // valid values remain we leave the existing override untouched.
  function autoRescaleColormap(lc, rows) {
    const mappings = lc.style_mappings ?? [];
    if (!mappings.length || !rows?.length) return;
    // 'global' color scale: keep the layer's declared domain fixed across the
    // whole time range instead of re-normalizing to each fetch's min/max. This
    // is what lets the Demand choropleth respond to the growth-assumption
    // sliders (which scale demand by a near-uniform per-sector factor a
    // per-frame rescale would cancel out) and brighten as load grows across
    // forecast years. Layers opt in via default_style.colorScaleMode; the
    // styler can flip it to 'per-year' per layer (stored in localStyle).
    const colorScaleMode = map.state.localStyle[lc.id]?.colorScaleMode
      ?? lc.default_style?.colorScaleMode
      ?? 'per-year';
    if (colorScaleMode === 'global') return;
    const overridesPatch = {};
    for (const m of mappings) {
      if (!m.column) continue;
      // Only auto-rescale value-axis-driven props (color/size/elevation),
      // not categorical swatches.
      if (m.scale_type === 'categorical') continue;
      const isLog = (m.scale_type === 'log');
      const vals = [];
      for (const r of rows) {
        const v = Number(r[m.column]);
        if (!Number.isFinite(v)) continue;
        if (isLog && v <= 0) continue;
        vals.push(v);
      }
      if (!vals.length) continue;
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      if (lo === hi) {
        // Degenerate range — open it up by ~10% so the colormap renders
        // a clear color rather than NaN/edge.
        const pad = isLog ? lo * 0.1 || 1 : Math.abs(lo) * 0.1 || 1;
        lo -= pad; hi += pad;
        if (isLog && lo <= 0) lo = hi / 10;
      }
      overridesPatch[m.id] = { domain_min: lo, domain_max: hi };
    }
    if (!Object.keys(overridesPatch).length) return;
    // Read mappingOverrides directly off whatever map.state we can see
    // here, but commit as a PATCH (not a full setLayerStyle replace).
    // Bootstrap's replaceLocalStyleMap dispatch may not have committed
    // yet when this runs — a setLayerStyle here would close over an
    // empty `cur` and wipe `interaction.clickContent`. patchLayerStyle
    // merges at reducer time against the *committed* state so the
    // bootstrap's interaction config survives.
    const curOvr = map.state.localStyle[lc.id]?.mappingOverrides || {};
    const merged = { ...curOvr };
    for (const [mid, patch] of Object.entries(overridesPatch)) {
      merged[mid] = { ...(curOvr[mid] || {}), ...patch };
    }
    map.patchLayerStyle(lc.id, { mappingOverrides: merged });
  }

  // Filter layers to exclude disabled/hidden extensions before bootstrapping
  function filterLayersByExtensions(layers, exts) {
    // Build set of known enabled extensions. Layers from extensions not in this
    // set (hidden) or marked disabled are excluded.
    const enabled = new Set(exts.filter(e => e.state !== "disabled").map(e => e.name));
    const disabled = new Set(exts.filter(e => e.state === "disabled").map(e => e.name));
    return layers.filter(l => {
      const ext = l.source_extension || l.extension_name;
      if (!ext) return true; // user-created layers (no extension) always pass
      if (disabled.has(ext)) return false; // explicitly disabled
      if (!enabled.has(ext)) return false; // not in extensions list (hidden)
      return true;
    });
  }

  // ── Layer data loading helper ────────────────────────────────────────────
  // Shared by initial mount, scenario change, and handleGenericLayerAdded.
  async function bootstrapLayers(layers, { replace = false, scenarioGen = null, signal = null } = {}) {
    // Single choke point for every load path (scenario-sync + enable/toggle +
    // reload-layers): scope to the active extension's selected project+scenario
    // so a multi-project/scenario extension (Grid) doesn't load every
    // combination (and stale-scenario layers don't linger / re-appear visible
    // on a story-chapter apply). The active extension owns the current project.
    const activeExtName = extensions.find(
      (e) => (e.projects || []).includes(scenarioState.project),
    )?.name;
    layers = scenarioScopedLayers(layers, scenarioState, activeExtName);
    // Stale-write guard. When `scenarioGen` is supplied, every async
    // continuation below checks `scenarioGenRef.current` against it and
    // bails when the user has navigated to a different scenario. When
    // omitted (callers like extension toggle / chat-driven actions
    // that aren't scenario-bound), the check is a no-op.
    const isStale = () => scenarioGen != null && scenarioGenRef.current !== scenarioGen;

    if (!Array.isArray(layers) || layers.length === 0) {
      if (replace && !isStale()) map.setConfigs([]);
      return;
    }

    if (isStale()) return;

    if (replace) {
      map.setConfigs(layers);
    } else {
      // Merge: add layers that don't already exist (by id)
      map.setConfigs((prev) => {
        const existingIds = new Set(prev.map(l => l.id));
        const newLayers = layers.filter(l => !existingIds.has(l.id));
        return newLayers.length > 0 ? [...prev, ...newLayers] : prev;
      });
    }

    // Bootstrap local styles and visibility from default_style. Apply per
    // layer via patchLayerStyle so each merge runs at reducer time against
    // the *committed* state — autoRescaleColormap fires concurrently from
    // dataset-load promises and would otherwise race the bootstrap and
    // clobber interaction config (or mappingOverrides, depending on which
    // closure wins).
    // Preserve the user's current visibility choices (spread map.state
    // .visibility); only force layers that declare default_visible:false to
    // start hidden. A scenario/extension switch must never flip a layer the
    // user turned on back off.
    const initVisibility = {};
    for (const layer of layers) {
      if (layer.default_style) {
        const { default_visible, ...style } = layer.default_style;
        map.patchLayerStyle(layer.id, style);
        if (default_visible === false) {
          initVisibility[layer.id] = false;
        }
      }
      // Auto-apply the layer's default painting (a saved style snapshot) over
      // default_style so a chosen look survives a reload.
      if (layer.default_painting?.style) {
        map.patchLayerStyle(layer.id, layer.default_painting.style);
      }
    }
    if (Object.keys(initVisibility).length > 0) {
      map.replaceVisibilityMap({ ...map.state.visibility, ...initVisibility });
    }

    // Re-assert a staged story-chapter's presentation over the defaults we just
    // built. The chapter is the authority: per layer its saved localStyle wins
    // wholesale; layers the chapter never saw keep their default_style (+ default
    // painting). Visibility is likewise chapter-authoritative (anything not
    // explicitly true is hidden). Kept idempotent + TTL-bounded so concurrent
    // reloads all converge and a stale stage can't leak into an unrelated later
    // scenario switch. Computed purely from `layers` + the stage (no dependence
    // on the not-yet-committed patchLayerStyle writes above).
    const staged = pendingPerspectiveStyleRef.current;
    if (staged) {
      if (Date.now() < staged.deadline) {
        const chapterLocal = staged.localStyle || {};
        const chapterVis = staged.visibility || {};
        const finalLocal = {};
        for (const layer of layers) {
          if (chapterLocal[layer.id]) {
            finalLocal[layer.id] = chapterLocal[layer.id];
          } else {
            const { default_visible, ...ds } = layer.default_style || {};
            finalLocal[layer.id] = { ...ds, ...(layer.default_painting?.style || {}) };
          }
        }
        for (const [id, st] of Object.entries(chapterLocal)) {
          if (!(id in finalLocal)) finalLocal[id] = st;
        }
        map.replaceLocalStyleMap(finalLocal);

        const finalVis = {};
        for (const layer of layers) finalVis[layer.id] = chapterVis[layer.id] === true;
        for (const [id, v] of Object.entries(chapterVis)) {
          if (!(id in finalVis)) finalVis[id] = v === true;
        }
        map.replaceVisibilityMap(finalVis);
      } else {
        // Past its window — drop it so it can't affect a later reload.
        pendingPerspectiveStyleRef.current = null;
      }
    }

    // Load geometry + dataset data for each layer — stream results as they arrive
    // so each layer renders as soon as its geometry is ready.
    const loadLayer = (layer) => {
      // Fire each layer's loading independently (no await — intentionally concurrent)
      (async () => {
        if (isStale()) return;
        // Spatial geometries are loaded per-viewport (bbox+zoom) by
        // useSpatialViewportLayers, not fetched whole here — the /data endpoint
        // would return the raw stored file (e.g. a shapefile zip), not GeoJSON.
        if (layer.geometry?.id && !layer.geometry?.is_spatial) {
          try {
            const geo = await fetchGeometryData(layer.geometry.id, { signal });
            if (isStale()) return;
            map.setLayerGeo(layer.id, geo);
          } catch (e) {
            if (isAbortError(e)) return;
            console.warn(`[App] failed to load geo for layer ${layer.id}:`, e);
          }
        }
        for (const ld of layer.layer_datasets ?? []) {
          if (!ld.dataset) continue;
          if (isStale()) return;
          if (ld.dataset.timestamp_col) {
            const dsId = ld.dataset.id;
            const role = ld.role ?? 'primary';
            if (!layerToDatasetsRef.current.has(layer.id))
              layerToDatasetsRef.current.set(layer.id, new Map());
            layerToDatasetsRef.current.get(layer.id).set(role, dsId);
            if (!timeseriesBuffersRef.current.has(dsId)) {
              const buf = new TimeseriesBuffer(dsId, ld.dataset.timestamp_col);
              buf.init()
                .then((b) => {
                  // Drop the entire init result if the user navigated away
                  // mid-flight. Stashing this buffer into the (now-belonging-
                  // to-a-different-scenario) ref or writing its timestamps
                  // into clockState is exactly the bug we're fixing.
                  if (isStale()) return;
                  timeseriesBuffersRef.current.set(dsId, b);
                  const loaded = b.getDataAtIndex(0);
                  console.log(`[App] buffer ready for ds ${dsId}: ${b.totalRows} rows, ${b.entityColumns.length} entities, loaded=${loaded}, currentValues=${b.currentValues.size}`);
                  versions.bumpTs();
                  if (b.totalRows > 0) {
                    const timestamps = [];
                    for (const date of b.dates) {
                      const count = b.rowCounts[date] ?? 0;
                      for (let i = 0; i < count; i++) timestamps.push(date);
                    }
                    updateClockState((prev) => {
                      // Only initialize the clock from the first buffer to load.
                      // Subsequent buffers (e.g. availability for renewable layers)
                      // share the same time axis and would otherwise reset index to 0.
                      if (prev.timestamps && prev.timestamps.length > 0) return prev;
                      return {
                        ...prev,
                        timestamps,
                        startDate: b.dates[0],
                        endDate: b.dates[b.dates.length - 1],
                        start_index: 0,
                        end_index: b.totalRows - 1,
                        min_index: 0,
                        max_index: b.totalRows - 1,
                        index: 0,
                      };
                    });
                  }
                })
                .catch((e) => console.warn(`[App] buffer init failed for dataset ${dsId}:`, e));
            }
          } else {
            try {
              const rows = await fetchDatasetData(ld.dataset.id, { signal });
              if (isStale()) return;
              const joinKey = ld.data_join_key ?? ld.dataset.join_key;
              if (joinKey) {
                map.setLayerData(layer.id, buildDataIndex(rows, joinKey));
                autoRescaleColormap(layer, rows);
                // Bump staticVersion so deck.gl's updateTriggers change and it
                // RE-EVALUATES getFillColor now that the data + colormap domain
                // are present. Without this the layer object rebuilds (data is
                // a memo dep) but deck.gl keeps the cached empty fill from
                // before the data arrived — the choropleth shows outlines only
                // until an extension toggle happens to bump this version. The
                // timeseries branch already does the equivalent via bumpTs().
                versions.bumpStatic();
              }
            } catch (e) {
              if (isAbortError(e)) return;
              console.warn(`[App] failed to load dataset for layer ${layer.id}:`, e);
            }
          }
        }
      })();
    };

    // Load every layer's geometry immediately, visible or not.
    //
    // A previous revision deferred hidden layers to requestIdleCallback to keep
    // a multi-MB hidden geometry off the critical path. That is unsafe here:
    // "hidden" is decided from the STAGED STORY CHAPTER, and applying the next
    // chapter can make a deferred layer visible before its idle callback runs
    // (or after isStale() has cancelled it). The layer then renders with no
    // geoData, which createGenericLayer drops from the deck list entirely — the
    // layer vanishes while its visibility still reads true, mid-story. Correct
    // beats fast: if this needs optimising again, load on demand when a layer
    // BECOMES visible rather than betting on an idle callback winning the race.
    layers.forEach(loadLayer);
  }

  // ── Reload layers when scenario changes — fetch only this scenario's layers
  //
  // A scenarioGen token gates async writes from this effect's body. Every
  // scenario change increments it; in-flight buffer init / layer fetches
  // captured the *previous* token check `scenarioGenRef.current` before
  // applying state and bail if the user has moved on. Without this:
  //   - Old scenario's buffer init can race in *after* the new effect ran,
  //     write its timestamps into clockState, and freeze the animation
  //     controller on the wrong project/scenario range.
  //   - StrictMode double-invocations duplicate fetches.
  useEffect(() => {
    if (!scenarioState.project || !scenarioState.scenario || !extensionsLoaded) return;

    // Focus switch: clicking a different extension's drawer entry changes the
    // active project (so its controls/scenario picker show), but the layers on
    // the map are the user's to arrange — a story may have several extensions'
    // layers visible at once. When the target's layers are already loaded,
    // leave the map exactly as-is: no reload, no visibility change, no flash.
    // Only the initial load and genuine same-extension scenario changes rebuild.
    const projectChanged = prevProjectRef.current != null
      && prevProjectRef.current !== scenarioState.project;
    prevProjectRef.current = scenarioState.project;
    if (projectChanged && (map.state.configs?.length ?? 0) > 0) return undefined;

    const myGen = ++scenarioGenRef.current;
    // Abort this run's in-flight network on supersession so a fast series of
    // scenario switches doesn't leave N layer/geo/dataset requests all running
    // to completion for scenarios the user has already left.
    const ctrl = new AbortController();

    // Clear stale state so the new scenario's first buffer can repopulate
    // clockState (the init guard inside bootstrapLayers only writes when
    // `prev.timestamps` is empty — so we have to clear it here).
    timeseriesBuffersRef.current = new Map();
    layerToDatasetsRef.current = new Map();
    map.replaceGeoMap({});
    map.replaceDataMap({});
    updateClockState({
      timestamps: [],
      startDate: null,
      endDate: null,
      start_index: 0,
      end_index: 0,
      min_index: 0,
      max_index: 0,
      index: 0,
      animate: false,
    });

    // Load ALL enabled extensions' layers (not just the active scenario's) so
    // every enabled extension stays listed and available on the map. Visibility
    // is preserved (bootstrapLayers only forces default_visible:false hidden),
    // so nothing the user turned on gets flipped off.
    fetchAllLayers({ signal: ctrl.signal })
      .then((layers) => {
        // User moved on while the fetch was in flight — drop this result.
        if (scenarioGenRef.current !== myGen) return;
        const filtered = filterLayersByExtensions(
          Array.isArray(layers) ? layers : (layers?.body ?? []),
          extensions,
        );
        return bootstrapLayers(filtered, { replace: true, scenarioGen: myGen, signal: ctrl.signal });
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        console.error("[App] fetchAllLayers error:", e);
      });

    return () => {
      // Effect cleanup increments the token so any pending async work in
      // this run becomes "stale" and bails, and aborts its in-flight network.
      // Belt-and-suspenders against StrictMode double-fires and rapid
      // scenario flips.
      scenarioGenRef.current++;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioState.project, scenarioState.scenario]);

  return {
    timeseriesBuffersRef,
    layerToDatasetsRef,
    scenarioGenRef,
    bootstrapLayers,
    filterLayersByExtensions,
    autoRescaleColormap,
    pendingPerspectiveStyleRef,
  };
}
