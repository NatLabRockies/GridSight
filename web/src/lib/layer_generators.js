import {GeoJsonLayer, ScatterplotLayer} from 'deck.gl';
import {DataFilterExtension} from '@deck.gl/extensions';
import { createDirectionalLineLayer } from './DirectionalLineLayer.js';
import { createTransmissionLayer, resolveLowUsagePalette } from './TransmissionLayer.js';
import { createGeneratorLayer } from './GeneratorLayer.js';
import { sampleColormap, normalise } from './colormaps.js';
import { NO_DEPTH } from './drawParams.js';

/**
 * Build an index from the dataset rows: { joinKeyValue → { column → value } }
 *
 * @param {object[]} rows         – array of row objects from /api/datasets/:id/data
 * @param {string}   joinKey      – the column that maps to geometry feature join key
 * @returns {Map<string, object>}
 */
export function buildDataIndex(rows, joinKey) {
  const index = new Map();
  for (const row of rows) {
    const key = String(row[joinKey]);
    index.set(key, row);
  }
  return index;
}

/**
 * Creates a highlight ring layer around a selected entity.
 */
export function createHighlightLayer(coordinates) {
  if (!coordinates) return null;
  return new ScatterplotLayer({
    id: 'entity-highlight',
    data: [{ position: coordinates }],
    getPosition: (d) => d.position,
    getFillColor: [0, 0, 0, 0],
    getLineColor: [0, 200, 255, 220],
    getRadius: 800,
    lineWidthMinPixels: 3,
    stroked: true,
    filled: false,
    pickable: false,
    parameters: NO_DEPTH,
  });
}

// Visual properties that drive sizes (not colors) — used to apply radiusScale.
const SIZE_VISUAL_PROPS = new Set(['getRadius', 'getPointRadius', 'getLineWidth', 'getElevation']);
const COLOR_VISUAL_PROPS = new Set(['getFillColor', 'getLineColor']);

/**
 * Create a generic deck.gl layer from a layer config record returned by
 * GET /api/layers/:project/:scenario.
 *
 * localStyle shape:
 *   opacity, pickable, autoHighlight, filled, stroked
 *   radiusScale, radiusMinPixels, radiusMaxPixels, radiusUnits
 *   lineWidthScale, lineWidthMinPixels, lineWidthMaxPixels, lineWidthUnits
 *   staticFillColor [r,g,b,a], staticLineColor [r,g,b,a], staticRadius, staticLineWidth
 *   geoMappings: { [visualProp]: { property, colormap?, scale_type?, domain_min?, domain_max? } }
 *   mappingOverrides: { [mappingId]: { colormap?, scale_type?, domain_min?, domain_max? } }
 *   filterEnabled, filterProperty, filterCategories
 */
export function createGenericLayer(layerConfig, geoData, dataIndex, localStyle = {}, timeseriesBuffer = null, tsVersion = 0, transitionDuration = 0, onHover = null, onClick = null, timeseriesBuffers = {}, isAnimating = false, useWorkerPrecompute = false, onWorkerUpdate = null, useGpuTimeseries = false, staticVersion = 0) {
  if (!geoData) {
    console.warn(`[layer_generators] no geoData for layer ${layerConfig.id} (${layerConfig.name}, type=${layerConfig.deck_layer_type})`);
    return null;
  }

  // If a timeseries buffer is attached, its currentValues Map IS the data source.
  const effectiveDataIndex = timeseriesBuffer?.currentValues?.size
    ? timeseriesBuffer.currentValues
    : dataIndex;

  const geomJoinKey    = layerConfig.geometry?.join_key;
  const styleMappings  = layerConfig.style_mappings ?? [];
  const mappingOverrides = localStyle.mappingOverrides ?? {};
  const geoMappings    = localStyle.geoMappings ?? {};

  const opacity         = localStyle.opacity        ?? 0.8;
  const radiusScale     = localStyle.radiusScale     ?? 1;
  const lineWidthScale  = localStyle.lineWidthScale  ?? 1;

  const staticFillColor  = localStyle.staticFillColor  ?? [100, 149, 237, 180];
  const staticLineColor  = localStyle.staticLineColor  ?? [0, 0, 0, 120];
  // NOT pre-multiplied by radiusScale/lineWidthScale. deck.gl applies those
  // via its own pointRadiusScale / radiusScale / lineWidthScale props, so
  // multiplying here too squares the scale: at radiusScale 0.1 a sized point
  // came out at 1% of its intended radius, under radiusMinPixels, and every
  // feature rendered at the identical floor — a size encoding that silently
  // flattened. Every size value below is the raw magnitude; deck.gl scales it
  // exactly once.
  const staticRadius     = localStyle.staticRadius    ?? 5;
  const staticLineWidth  = localStyle.staticLineWidth ?? 1;

  /**
   * Resolve a visual property for a GeoJSON feature.
   * Priority: 1) dataset mapping  2) geo property mapping  3) returns null (caller uses static fallback)
   */
  // getRadius (ScatterplotLayer) and getPointRadius (GeoJsonLayer) are aliases.
  const RADIUS_ALIASES = { getRadius: 'getPointRadius', getPointRadius: 'getRadius' };

  function resolveStyle(visualProperty, feature) {
    // 1. Dataset-backed mapping (persisted in DB)
    const mapping = styleMappings.find(m => m.visual_property === visualProperty)
      ?? styleMappings.find(m => m.visual_property === RADIUS_ALIASES[visualProperty]);
    if (mapping && effectiveDataIndex) {
      const featureKey = geomJoinKey ? String(feature.properties?.[geomJoinKey]) : null;
      if (featureKey) {
        const entry = effectiveDataIndex.get(featureKey);
        if (entry !== null && entry !== undefined) {
          // Wide timeseries: Map<id → number>; static: Map<id → rowObject>
          const raw = (typeof entry === 'number' || typeof entry === 'bigint')
            ? entry
            : entry[mapping.column];
          if (raw !== null && raw !== undefined) {
            const ovr = mappingOverrides[mapping.id] ?? {};
            const cmap  = ovr.colormap   ?? mapping.colormap;
            const stype = ovr.scale_type ?? mapping.scale_type;
            const dmin  = ovr.domain_min ?? mapping.domain_min ?? 0;
            const dmax  = ovr.domain_max ?? mapping.domain_max ?? 1;
            if (stype === 'categorical') {
              const color = (ovr.categoryColors ?? {})[String(raw)];
              return color ?? null; // null → caller uses static fallback
            }
            const num = parseFloat(raw);
            // Log-scale rows with value <= 0 (or below the lower bound)
            // can't be meaningfully placed on the colormap. Returning null
            // lets the caller fall back to the layer's staticFillColor —
            // which extensions typically style as a faint "no data" ghost.
            if (cmap && stype === 'log' && (!Number.isFinite(num) || num <= 0)) {
              return null;
            }
            if (cmap) return sampleColormap(cmap, normalise(num, dmin, dmax, stype));
            // Raw magnitude — deck.gl's *Scale prop applies the multiplier.
            return parseFloat(raw);
          }
        }
      }
    }

    // 2. Geo property mapping (local, not persisted)
    const gm = geoMappings[visualProperty] ?? geoMappings[RADIUS_ALIASES[visualProperty]];
    if (gm?.property) {
      const raw = feature.properties?.[gm.property];
      if (raw !== null && raw !== undefined) {
        if (gm.scale_type === 'categorical') {
          const color = (gm.categoryColors ?? {})[String(raw)];
          return color ?? null; // null → caller uses static fallback
        }
        if (gm.colormap) {
          return sampleColormap(gm.colormap, normalise(
            parseFloat(raw), gm.domain_min ?? 0, gm.domain_max ?? 1, gm.scale_type ?? 'linear',
          ));
        }
        const v = parseFloat(raw);
        if (!SIZE_VISUAL_PROPS.has(visualProperty)) return v;
        // Size encodings honour scale_type. Real-world quantities are heavily
        // skewed — data-centre capacity runs 0–11,000 MW with a median of 23 —
        // so a linear RADIUS puts almost every feature on the minimum-pixel
        // floor while one dot dominates. 'sqrt' makes AREA proportional to the
        // value, which is both the cartographic convention for point symbols
        // and the only way a long tail stays readable.
        const st = gm.scale_type;
        // Raw magnitude; deck.gl's *Scale prop applies the multiplier once.
        return st === 'sqrt' ? Math.sqrt(Math.max(0, v))
          : st === 'log' ? Math.log10(Math.max(1, v))
            : v;
      }
    }

    return null; // caller provides static fallback
  }

  // ── Typed array pre-computation for timeseries data ──────────────────────
  // When the data source is a Map<entityId → number> (timeseries), pre-build
  // Float32Arrays aligned to feature order for O(1) index lookups.
  // These arrays are rebuilt each render when tsVersion changes.
  const isTimeseriesData = effectiveDataIndex instanceof Map &&
    effectiveDataIndex.size > 0 &&
    typeof effectiveDataIndex.values().next().value === 'number';

  // ── updateTriggers signature builder ────────────────────────────────────
  // deck.gl re-walks accessors whenever a trigger value changes. Previously
  // we passed [tsVersion, effectiveDataIndex, styleMappings, localStyle]
  // for every property — every render produced a fresh `localStyle` object
  // identity, so deck.gl invalidated every accessor every tick regardless
  // of whether that property's output had actually changed. We now build
  // a content-derived primitive (string) per visual property and only
  // append `tsVersion` for properties that are actually time-driven.
  function _sigPart(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.join(',');
    if (typeof v === 'object') {
      return Object.keys(v).sort().map(k => `${k}:${_sigPart(v[k])}`).join(';');
    }
    return String(v);
  }
  function triggerSig(visualProperty) {
    const mapping = styleMappings.find(m => m.visual_property === visualProperty)
      ?? styleMappings.find(m => m.visual_property === RADIUS_ALIASES[visualProperty]);
    const ovr = mapping ? (mappingOverrides[mapping.id] ?? {}) : {};
    const gm  = geoMappings[visualProperty] ?? geoMappings[RADIUS_ALIASES[visualProperty]];
    const isSize = SIZE_VISUAL_PROPS.has(visualProperty);
    const fallback =
      visualProperty === 'getFillColor' ? _sigPart(staticFillColor) :
      visualProperty === 'getLineColor' ? _sigPart(staticLineColor) :
      visualProperty === 'getLineWidth' ? _sigPart(staticLineWidth) :
      isSize ? _sigPart(staticRadius) : '';
    const parts = [
      visualProperty,
      mapping ? [
        mapping.id, mapping.column, mapping.colormap, mapping.scale_type,
        mapping.domain_min, mapping.domain_max,
        ovr.colormap, ovr.scale_type, ovr.domain_min, ovr.domain_max,
        _sigPart(ovr.categoryColors),
      ].map(_sigPart).join('|') : '',
      gm ? [
        gm.property, gm.colormap, gm.scale_type, gm.domain_min, gm.domain_max,
        _sigPart(gm.categoryColors),
      ].map(_sigPart).join('|') : '',
      fallback,
      isSize ? _sigPart(radiusScale) : '',
      visualProperty === 'getLineWidth' ? _sigPart(lineWidthScale) : '',
    ];
    // Time-driven only when a styleMapping reads from a timeseries Map.
    // geoMapping reads geometry props which never animate.
    const isTimeDriven = isTimeseriesData && !!mapping;
    // Static data-bound mapping: include staticVersion so deck.gl re-runs
    // the accessor when an extension control change rebuilds the dataIndex
    // for this layer. Without this, updateTriggers don't change between
    // refetches and deck.gl serves cached colors from the first fetch.
    const isStaticDataDriven = !isTimeseriesData && !!mapping;
    const sig = parts.join('||');
    if (isTimeDriven) return `${sig}#${tsVersion}`;
    if (isStaticDataDriven) return `${sig}@${staticVersion}`;
    return sig;
  }

  const alignedArrays = {};       // size props: Float32Array(n)
  const alignedColorArrays = {};  // color props: Uint8Array(n*4)
  if (isTimeseriesData && geomJoinKey) {
    const allFeatures = geoData.features ?? (Array.isArray(geoData) ? geoData : []);
    const n = allFeatures.length;

    // Pre-resolve feature keys once — used by every per-property loop below.
    const keys = new Array(n);
    for (let i = 0; i < n; i++) {
      keys[i] = String(allFeatures[i].properties?.[geomJoinKey] ?? '');
    }

    for (const m of styleMappings) {
      const isSize  = SIZE_VISUAL_PROPS.has(m.visual_property);
      const isColor = COLOR_VISUAL_PROPS.has(m.visual_property);
      if (!isSize && !isColor) continue;

      const ovr = mappingOverrides[m.id] ?? {};
      const cmap  = ovr.colormap   ?? m.colormap;
      const stype = ovr.scale_type ?? m.scale_type;
      const dmin  = ovr.domain_min ?? m.domain_min ?? 0;
      const dmax  = ovr.domain_max ?? m.domain_max ?? 1;
      const isCategorical = stype === 'categorical';
      const categoryColors = ovr.categoryColors ?? {};
      const fallbackColor = m.visual_property === 'getLineColor' ? staticLineColor : staticFillColor;

      if (isSize) {
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const raw = effectiveDataIndex.get(keys[i]);
          if (raw != null && typeof raw === 'number' && !isNaN(raw)) {
            arr[i] = raw;   // scaled once by deck.gl's *Scale prop
          } else {
            arr[i] = staticRadius;
          }
        }
        alignedArrays[m.visual_property] = arr;
        continue;
      }

      // Color: Uint8Array (RGBA, 0-255)
      const arr = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const raw = effectiveDataIndex.get(keys[i]);
        let c;
        if (raw == null || (typeof raw === 'number' && isNaN(raw))) {
          c = fallbackColor;
        } else if (isCategorical) {
          c = categoryColors[String(raw)] ?? fallbackColor;
        } else if (cmap) {
          c = sampleColormap(cmap, normalise(parseFloat(raw), dmin, dmax, stype));
        } else {
          c = fallbackColor;
        }
        const j = i * 4;
        arr[j]     = c[0] ?? 0;
        arr[j + 1] = c[1] ?? 0;
        arr[j + 2] = c[2] ?? 0;
        arr[j + 3] = c[3] ?? 255;
      }
      alignedColorArrays[m.visual_property] = arr;
    }
  }

  const id = `generic-${layerConfig.id}`;

  // Filter extension setup — always include DataFilterExtension so it can be
  // toggled dynamically (deck.gl doesn't support adding extensions after creation).
  const filterActive     = (localStyle.filterEnabled ?? false) && !!localStyle.filterProperty;
  const filterProp       = localStyle.filterProperty;
  const filterCategories = localStyle.filterCategories ?? [];
  const filterCategoriesSet = new Set(filterCategories.map(String));
  // Always keep filterEnabled:true so deck.gl never tears down the extension.
  // Control visibility via getFilterValue: 1 = show, 0 = hide.
  // When filter is active with an empty categories list, hide everything.
  // Resolve filter value: check geometry properties first, then dataset row
  function _resolveFilterValue(f) {
    // 1. Direct geometry property
    const geoPropVal = f.properties?.[filterProp];
    if (geoPropVal !== null && geoPropVal !== undefined) return String(geoPropVal);
    // 2. Dataset column lookup via join key
    if (effectiveDataIndex && geomJoinKey) {
      const key = String(f.properties?.[geomJoinKey] ?? '');
      const row = effectiveDataIndex.get(key);
      if (row && typeof row === 'object') {
        const dsVal = row[filterProp];
        if (dsVal !== null && dsVal !== undefined) return String(dsVal);
      }
    }
    return '';
  }

  // Some feature properties hold a SET, not a scalar — the Baxtel data-centre
  // sites carry `stage` values like "{Construction,Land Bank,Planned}" because
  // one site can be in several stages at once. Exact matching can never select
  // those: "Construction" ≠ "{Construction,Planned}", so filtering to sites
  // under construction silently returned only the handful whose stage is
  // exactly "{Construction}".
  //
  // Treat a `{…}` / `[…]` value as its members and match if ANY member is
  // selected. Scalars are unaffected — they take the same exact-match path as
  // before — so this needs no configuration and can't change existing layers.
  function _matchesFilter(f) {
    const raw = _resolveFilterValue(f);
    if (filterCategoriesSet.has(raw)) return true;
    const n = raw.length;
    if (n < 2) return false;
    const open = raw[0], close = raw[n - 1];
    if (!((open === '{' && close === '}') || (open === '[' && close === ']'))) return false;
    for (const member of raw.slice(1, -1).split(',')) {
      // Trim whitespace and the quotes a JSON-ish array would carry.
      const cleaned = member.trim().replace(/^["']|["']$/g, '');
      if (cleaned && filterCategoriesSet.has(cleaned)) return true;
    }
    return false;
  }

  const filterProps = {
    extensions: [new DataFilterExtension({ filterSize: 1 })],
    getFilterValue: filterActive
      ? (filterCategories.length > 0
          ? f => (_matchesFilter(f) ? 1 : 0)
          : () => 0)
      : () => 1,
    filterRange: [1, 1],
    filterEnabled: true,
  };

  // Smooth transitions between timesteps when animating with a timeseries buffer.
  const hasTransitions = timeseriesBuffer && transitionDuration > 0;
  const transitionEntry = hasTransitions ? { duration: transitionDuration } : undefined;

  // Disable picking during animation playback to skip the per-tick picking-buffer
  // re-render. Users can pause to interact.
  const isPickable = !isAnimating && (localStyle.pickable ?? true);

  if (layerConfig.deck_layer_type === 'GeoJsonLayer') {
    // Accept both getPointRadius (GeoJsonLayer name) and getRadius (ScatterplotLayer
    // name) so that DB style_mappings with either visual_property value work correctly.
    const pointRadiusAligned = alignedArrays['getPointRadius'] ?? alignedArrays['getRadius'];
    const lineWidthAligned   = alignedArrays['getLineWidth'];
    const elevationAligned   = alignedArrays['getElevation'];
    const fillColorAligned   = alignedColorArrays['getFillColor'];
    const lineColorAligned   = alignedColorArrays['getLineColor'];
    return new GeoJsonLayer({
      id,
      data: geoData,
      opacity,
      pickable:       isPickable,
      autoHighlight:  localStyle.autoHighlight   ?? true,
      filled:         localStyle.filled          ?? true,
      stroked:        localStyle.stroked         ?? true,
      pointRadiusScale:     radiusScale,
      pointRadiusMinPixels: localStyle.radiusMinPixels    ?? 0,
      pointRadiusMaxPixels: localStyle.radiusMaxPixels    ?? 100,
      pointRadiusUnits:     localStyle.radiusUnits        ?? 'meters',
      lineWidthScale,
      lineWidthMinPixels:   localStyle.lineWidthMinPixels ?? 0,
      lineWidthMaxPixels:   localStyle.lineWidthMaxPixels ?? 20,
      lineWidthUnits:       localStyle.lineWidthUnits     ?? 'meters',
      getFillColor:   fillColorAligned
        ? (_, { index }) => {
            const j = index * 4;
            return [fillColorAligned[j], fillColorAligned[j+1], fillColorAligned[j+2], fillColorAligned[j+3]];
          }
        : f => resolveStyle('getFillColor', f) ?? staticFillColor,
      getLineColor:   lineColorAligned
        ? (_, { index }) => {
            const j = index * 4;
            return [lineColorAligned[j], lineColorAligned[j+1], lineColorAligned[j+2], lineColorAligned[j+3]];
          }
        : f => resolveStyle('getLineColor', f) ?? staticLineColor,
      getLineWidth:   lineWidthAligned
        ? (_, { index }) => lineWidthAligned[index] ?? staticLineWidth
        : f => resolveStyle('getLineWidth', f) ?? staticLineWidth,
      getElevation:   elevationAligned
        ? (_, { index }) => elevationAligned[index] ?? (localStyle.staticElevation ?? 0)
        : f => resolveStyle('getElevation', f) ?? (localStyle.staticElevation ?? 0),
      getPointRadius: pointRadiusAligned
        ? (_, { index }) => pointRadiusAligned[index] ?? staticRadius
        : f => resolveStyle('getPointRadius', f) ?? staticRadius,
      updateTriggers: {
        getFillColor:   triggerSig('getFillColor'),
        getLineColor:   triggerSig('getLineColor'),
        getLineWidth:   triggerSig('getLineWidth'),
        getElevation:   triggerSig('getElevation'),
        getPointRadius: triggerSig('getPointRadius'),
        getFilterValue: `${filterActive}|${filterProp ?? ''}|${filterCategories.join(',')}`,
      },
      ...(hasTransitions && {
        transitions: {
          getFillColor:   transitionEntry,
          getLineColor:   transitionEntry,
          getLineWidth:   transitionEntry,
          getElevation:   transitionEntry,
          getPointRadius: transitionEntry,
        },
      }),
      ...(onHover && { onHover: (info) => onHover({ ...info, layerId: layerConfig.id }) }),
      ...(onClick && { onClick: (info) => onClick({ ...info, layerId: layerConfig.id }) }),
      parameters: NO_DEPTH,
      ...filterProps,
    });
  }

  if (layerConfig.deck_layer_type === 'ScatterplotLayer') {
    const radiusAligned = alignedArrays['getRadius'];
    const fillColorAligned = alignedColorArrays['getFillColor'];
    const lineColorAligned = alignedColorArrays['getLineColor'];
    return new ScatterplotLayer({
      id,
      data: geoData.features ?? geoData,
      opacity,
      pickable:       isPickable,
      autoHighlight:  localStyle.autoHighlight  ?? true,
      filled:         localStyle.filled         ?? true,
      stroked:        localStyle.stroked        ?? true,
      radiusScale,
      radiusMinPixels: localStyle.radiusMinPixels ?? 0,
      radiusMaxPixels: localStyle.radiusMaxPixels ?? 100,
      radiusUnits:     localStyle.radiusUnits     ?? 'meters',
      getPosition: f => f.geometry?.coordinates ?? f.coordinates,
      // Binary attribute form: deck.gl uploads the typed array directly to
      // the GPU, skipping per-feature accessor invocation entirely. This is
      // where the bulk of Stage 5 perf comes from.
      getRadius:    radiusAligned
        ? { value: radiusAligned, size: 1 }
        : f => resolveStyle('getRadius',    f) ?? staticRadius,
      getFillColor: fillColorAligned
        ? { value: fillColorAligned, size: 4 }
        : f => resolveStyle('getFillColor', f) ?? staticFillColor,
      getLineColor: lineColorAligned
        ? { value: lineColorAligned, size: 4 }
        : f => resolveStyle('getLineColor', f) ?? staticLineColor,
      updateTriggers: {
        getRadius:    triggerSig('getRadius'),
        getFillColor: triggerSig('getFillColor'),
        getLineColor: triggerSig('getLineColor'),
        getFilterValue: `${filterActive}|${filterProp ?? ''}|${filterCategories.join(',')}`,
      },
      ...(hasTransitions && {
        transitions: {
          getRadius:    transitionEntry,
          getFillColor: transitionEntry,
          getLineColor: transitionEntry,
        },
      }),
      ...(onHover && { onHover: (info) => onHover({ ...info, layerId: layerConfig.id }) }),
      ...(onClick && { onClick: (info) => onClick({ ...info, layerId: layerConfig.id }) }),
      parameters: NO_DEPTH,
      ...filterProps,
    });
  }

  if (layerConfig.deck_layer_type === 'GeneratorLayer') {
    // GeneratorLayer: dual-radius scatterplot for generators with inner (generation)
    // and outer (capacity/availability) circles in a single shader pass.
    const genBuf = timeseriesBuffers?.primary ?? timeseriesBuffer;
    // capacitySource 'nameplate': size capacity circles by the static
    // capacityProperty (installed MW) instead of hourly availability, so a
    // capacity view shows solar at night too. Default 'availability'.
    const useNameplate = localStyle.capacitySource === 'nameplate' && !!localStyle.capacityProperty;
    const capBuf = useNameplate ? null : (timeseriesBuffers?.availability ?? null);
    const genIndex = genBuf?.currentValues?.size ? genBuf.currentValues : dataIndex;
    const capIndex = capBuf?.currentValues?.size ? capBuf.currentValues : null;

    // Build a color resolver that uses the same geoMappings/resolveStyle logic
    const colorResolver = (feature) => resolveStyle('getFillColor', feature) ?? staticFillColor;

    return createGeneratorLayer({
      id: `generic-${layerConfig.id}`,
      geoData,
      generationIndex: genIndex,
      capacityIndex: capIndex,
      capacityProperty: localStyle.capacityProperty ?? null,
      joinKey: geomJoinKey,
      colorResolver,
      generationVisible: localStyle.generationVisible ?? true,
      capacityVisible: localStyle.capacityVisible ?? true,
      curtailmentVisible: localStyle.curtailmentVisible ?? false,
      radiusScale,
      // Smart default for radiusMinPixels (only when user hasn't pinned a value):
      //   gen-only             → 0  (let small dots vanish at low zoom)
      //   cap-only             → 1  (always visible, single-source layer)
      //   any other combo      → 0  (multi-zone disc handles its own visibility)
      // Explicit user value (any number, including 0) wins over the default.
      radiusMinPixels: (() => {
        if (localStyle.radiusMinPixels != null) return localStyle.radiusMinPixels;
        const genOn  = localStyle.generationVisible  ?? true;
        const capOn  = localStyle.capacityVisible    ?? true;
        const curtOn = localStyle.curtailmentVisible ?? false;
        if (genOn && !capOn && !curtOn) return 0;
        if (!genOn && capOn && !curtOn) return 1;
        return 0;
      })(),
      radiusMaxPixels: localStyle.radiusMaxPixels ?? 100,
      radiusUnits: localStyle.radiusUnits ?? 'meters',
      // Capacity ring outline (only drawn in "both" mode). Uses the same
      // standard line-width controls as other layer types.
      staticLineWidth: localStyle.staticLineWidth ?? 2,
      lineWidthScale,
      lineWidthMinPixels: localStyle.lineWidthMinPixels ?? 1,
      lineWidthMaxPixels: localStyle.lineWidthMaxPixels ?? 10,
      ringAlpha: localStyle.ringAlpha ?? 220,
      opacity,
      transitionDuration: (genBuf || capBuf) ? transitionDuration : 0,
      onHover: onHover ? (info) => onHover({ ...info, layerId: layerConfig.id }) : null,
      onClick: onClick ? (info) => onClick({ ...info, layerId: layerConfig.id }) : null,
      filterProperty: filterActive ? filterProp : null,
      filterCategories: filterActive && filterCategories.length > 0 ? filterCategories : null,
      pickable: isPickable,
      tsVersion,
      // Phase 2 / Phase 3 plumbing — same toggles TransmissionLayer uses.
      // The primary buffer (generation MW) is the worker's required input;
      // availability is now also threaded through so the worker can pack
      // per-timestep cap into the styles texture instead of the static
      // nameplate. That makes the curtailment band reflect real dispatch
      // curtailment (avail − gen) for VRE features.
      useWorker: useWorkerPrecompute,
      useGpuTexture: useGpuTimeseries,
      timeseriesBuffer: genBuf,
      availabilityBuffer: capBuf,
      onWorkerUpdate,
    });
  }

  if (layerConfig.deck_layer_type === 'DirectionalLineLayer') {
    // DirectionalLineLayer: multi-segment lines with flow-based directional coloring.
    // Uses the first style mapping's column as the flow value for direction/magnitude.
    // See DirectionalLineLayer.js for full documentation.
    const flowMapping = styleMappings.find(m => m.visual_property === 'getColor' || m.column?.toLowerCase().includes('flow'));
    const flowColumn = flowMapping?.column ?? 'flow';
    return createDirectionalLineLayer({
      id: `generic-${layerConfig.id}`,
      geoData,
      dataIndex: effectiveDataIndex,
      joinKey: geomJoinKey,
      flowColumn,
      gradientMode: localStyle.gradientMode ?? 'segment',
      originColor: localStyle.originColor ?? [80, 80, 80, 60],
      terminusColor: localStyle.terminusColor ?? [0, 200, 255, 220],
      neutralColor: localStyle.neutralColor ?? [128, 128, 128, 80],
      widthScale: lineWidthScale,
      widthMinPixels: localStyle.lineWidthMinPixels ?? 1,
      widthMaxPixels: localStyle.lineWidthMaxPixels ?? 20,
      opacity,
      pickable: isPickable,
      onHover: onHover ? (info) => onHover({ ...info, layerId: layerConfig.id }) : null,
      onClick: onClick ? (info) => onClick({ ...info, layerId: layerConfig.id }) : null,
      transitionDuration: timeseriesBuffer ? transitionDuration : 0,
    });
  }

  if (layerConfig.deck_layer_type === 'TransmissionLayer') {
    // TransmissionLayer: power system transmission lines with loading-based coloring.
    if (effectiveDataIndex) {
      const sample = Array.from(effectiveDataIndex.entries()).slice(0, 3);
      console.log(`[TransmissionLayer] dataIndex: ${effectiveDataIndex.size} entries, sample:`, sample);
    } else {
      console.log(`[TransmissionLayer] dataIndex is null/empty, tsBuf=${!!timeseriesBuffer}, tsBufSize=${timeseriesBuffer?.currentValues?.size ?? 0}`);
    }
    return createTransmissionLayer({
      id: `generic-${layerConfig.id}`,
      geoData,
      dataIndex: effectiveDataIndex,
      timeseriesBuffer,
      useWorker: useWorkerPrecompute,
      useGpuTexture: useGpuTimeseries,
      onWorkerUpdate,
      joinKey: geomJoinKey,
      flowColumn: '__timeseries__',
      capacityProperty: localStyle.capacityProperty ?? 'capacity',
      neutralColor: localStyle.neutralColor ?? localStyle.staticLineColor
        ?? resolveLowUsagePalette(localStyle.lowUsageColor).neutral,
      // Low-load / idle base color, user-selectable per layer (steel-blue vs
      // dim grey) so idle lines stay distinct from grey basemap streets.
      idleColor: resolveLowUsagePalette(localStyle.lowUsageColor).idle,
      dimAlpha: localStyle.dimAlpha ?? undefined,
      brightAlpha: localStyle.brightAlpha ?? undefined,
      loadingRamp: localStyle.loadingRamp ?? undefined,
      loadingDomain: localStyle.loadingDomain ?? undefined,
      orangeThreshold: localStyle.orangeThreshold ?? 0.85,
      redThreshold: localStyle.redThreshold ?? 0.95,
      colorMode: localStyle.colorMode ?? 'piecewise',
      greyAlphaMax: localStyle.greyAlphaMax ?? 1.0,
      widthScale: lineWidthScale,
      widthMinPixels: localStyle.lineWidthMinPixels ?? 0.5,
      widthMaxPixels: localStyle.lineWidthMaxPixels ?? 14,
      widthUnits: localStyle.widthUnits ?? localStyle.lineWidthUnits ?? 'pixels',
      opacity,
      pickable: isPickable,
      onHover: onHover ? (info) => onHover({ ...info, layerId: layerConfig.id }) : null,
      onClick: onClick ? (info) => onClick({ ...info, layerId: layerConfig.id }) : null,
      transitionDuration: timeseriesBuffer ? transitionDuration : 0,
      filterProperty: filterActive ? filterProp : null,
      filterCategories: filterActive && filterCategories.length > 0 ? filterCategories : null,
      tsVersion,
      displayMode: localStyle.displayMode ?? 'flow',
      colorProperty: localStyle.colorProperty ?? null,
      categoryColors: localStyle.categoryColors ?? null,
      staticColor: localStyle.staticLineColor ?? undefined,
      capacityWidthFactor: localStyle.capacityWidthFactor ?? 0.3,
    });
  }

  // Fallback: plain GeoJson
  return new GeoJsonLayer({
    id,
    data: geoData,
    opacity,
    pickable:     isPickable,
    getFillColor: staticFillColor,
    ...(onHover && { onHover: (info) => onHover({ ...info, layerId: layerConfig.id }) }),
    ...(onClick && { onClick: (info) => onClick({ ...info, layerId: layerConfig.id }) }),
    parameters:   NO_DEPTH,
    ...filterProps,
  });
}
