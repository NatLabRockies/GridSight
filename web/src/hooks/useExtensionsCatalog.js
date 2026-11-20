import { useCallback, useEffect, useState } from "react";
import { fetchExtensions, fetchExtensionCharts, invalidateCache } from "../lib/loaders.js";

/**
 * Loads the extension manifest list and, once that completes, fetches each
 * extension's scenario-scoped chart specs in parallel.
 *
 * Returns:
 *   extensions             — array of extension manifests (empty until load)
 *   extensionsLoaded       — true once the manifest fetch has completed (success or fail)
 *   scenarioChartSpecs     — { [extName]: ChartSpec[] } filtered to scope === "scenario"
 *   setExtensions          — setter exposed because callers (extension toggle,
 *                            scenario-create handlers) need to optimistically
 *                            update the local list after backend writes.
 *   refreshScenarioCharts  — busts the cached spec list for one (or all)
 *                            extensions and re-fetches. Call after any
 *                            change to an extension's chart_options
 *                            (e.g. GAT's display-group colours) — without
 *                            this, the ChartsMenu would keep serving the
 *                            original colours captured at first load.
 *
 * Self-contained: only reads/writes its own state.
 */
export default function useExtensionsCatalog() {
  const [extensions, setExtensions] = useState([]);
  const [extensionsLoaded, setExtensionsLoaded] = useState(false);
  const [scenarioChartSpecs, setScenarioChartSpecs] = useState({});
  // Monotonic counter consumers can bump to force a re-fetch of the spec
  // list — see `refreshScenarioCharts` below.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    fetchExtensions()
      .then((exts) => { setExtensions(exts); setExtensionsLoaded(true); })
      .catch((e) => { console.warn("[App] fetchExtensions:", e); setExtensionsLoaded(true); });
  }, []);

  useEffect(() => {
    if (!extensionsLoaded) return;
    let cancelled = false;
    Promise.all(
      extensions.map(async (ext) => {
        try {
          const all = await fetchExtensionCharts(ext.name);
          const scenarioOnly = (all || []).filter(
            (c) => (c.scope ?? c.chart_options?.scope) === "scenario"
          );
          return [ext.name, scenarioOnly];
        } catch {
          return [ext.name, []];
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      const map = {};
      for (const [name, specs] of entries) map[name] = specs;
      setScenarioChartSpecs(map);
    });
    return () => { cancelled = true; };
  }, [extensions, extensionsLoaded, refreshTick]);

  const refreshScenarioCharts = useCallback((extName) => {
    // Bust the loader-level cache so the next fetch hits the sidecar
    // (without this, cachedRequest would happily serve the stale spec
    // list back from memory).
    if (extName) {
      invalidateCache(`ext-charts:${extName}`);
    } else {
      for (const ext of extensions) {
        invalidateCache(`ext-charts:${ext.name}`);
      }
    }
    setRefreshTick((t) => t + 1);
  }, [extensions]);

  return {
    extensions, extensionsLoaded, scenarioChartSpecs,
    setExtensions, refreshScenarioCharts,
  };
}
