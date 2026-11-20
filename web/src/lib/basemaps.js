/**
 * basemaps.js — basemap registry + per-category feature visibility.
 *
 * Two things live here:
 *   1. A small registry of selectable basemaps. Each entry is either a Carto
 *      vector style (a MapLibre style URL) or a constructed MapLibre style
 *      object (the Esri satellite raster). Adding a provider later = one row.
 *   2. A categorizer that groups a MapLibre style's layers into semantic
 *      buckets (streets, highways, water bodies, waterways, labels) so the UI
 *      can toggle each independently — e.g. streets on for a distribution
 *      view, waterways on for a hydro study, everything off for the wall.
 *
 * The categorizer targets the OpenMapTiles layer schema that all three Carto
 * gl-styles (Positron / Voyager / Dark Matter) share, so one set of id
 * patterns works across every vector basemap. Raster basemaps (satellite)
 * expose no vector categories — the toggles simply don't apply and the panel
 * hides them.
 */

import { BASEMAP } from '@deck.gl/carto';

// Esri World Imagery — free, no API key. Muted slightly (brightness/saturation)
// so bright imagery doesn't fight the data layers drawn over it. Attribution
// is carried on the source so MapLibre's AttributionControl renders it.
export const SATELLITE_STYLE = {
  version: 8,
  sources: {
    'esri-world-imagery': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        'Imagery © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
  },
  layers: [
    {
      id: 'esri-world-imagery',
      type: 'raster',
      source: 'esri-world-imagery',
      paint: {
        'raster-brightness-max': 0.82,
        'raster-saturation': -0.2,
        'raster-contrast': -0.05,
      },
    },
  ],
};

/**
 * Selectable basemaps. `kind` drives whether feature toggles apply:
 * 'vector' styles expose the OpenMapTiles categories; 'raster' (satellite)
 * exposes none.
 */
export const BASEMAPS = [
  { id: 'dark-matter', label: 'Dark Matter', kind: 'vector', style: BASEMAP.DARK_MATTER },
  { id: 'positron', label: 'Positron', kind: 'vector', style: BASEMAP.POSITRON },
  { id: 'voyager', label: 'Voyager', kind: 'vector', style: BASEMAP.VOYAGER },
  { id: 'satellite', label: 'Satellite (Esri)', kind: 'raster', style: SATELLITE_STYLE },
];

export const DEFAULT_BASEMAP_ID = 'dark-matter';

/** Resolve a basemap entry by id. Tolerates a legacy style URL (matches by
 *  `style`) so a synced/persisted value from before this registry still works.
 *  Falls back to the default entry. */
export function basemapById(idOrStyle) {
  return (
    BASEMAPS.find((b) => b.id === idOrStyle)
    || BASEMAPS.find((b) => b.style === idOrStyle)
    || BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP_ID)
    || BASEMAPS[0]
  );
}

/**
 * Toggle-able basemap feature categories, in display order. `id` values are
 * the keys used in the hidden-set and returned by categorizeLayer().
 */
export const FEATURE_CATEGORIES = [
  { id: 'roads_major', label: 'Highways & interstates' },
  { id: 'roads_minor', label: 'Streets & minor roads' },
  { id: 'water', label: 'Water bodies' },
  { id: 'waterways', label: 'Waterways (rivers / streams)' },
  { id: 'labels', label: 'Labels & POIs' },
];

/**
 * Classify a single MapLibre style layer into a feature category id, or null
 * if it belongs to the always-on base (land, boundaries, landuse, buildings,
 * background). Keyed on the shared OpenMapTiles schema:
 *   - every `symbol` layer is text/icons → labels & POIs
 *   - `waterway` (line) → waterways; `water` (fill) → water bodies
 *   - transportation layers carry the road class in their id
 *     (road_/tunnel_/bridge_ + mot|trunk|pri = major; sec|minor|service|path
 *     + rail/aeroway = minor)
 */
export function categorizeLayer(layer) {
  if (!layer) return null;
  const id = String(layer.id || '').toLowerCase();
  const type = layer.type;
  const sl = String(layer['source-layer'] || '').toLowerCase();

  // Labels & POIs — all symbol (text/icon) layers: place names, water names,
  // road shields, POIs.
  if (type === 'symbol') return 'labels';

  // Waterways — rivers/streams drawn as lines.
  if (id === 'waterway' || (type === 'line' && sl === 'waterway')) return 'waterways';

  // Water bodies — filled polygons (lakes, oceans, reservoirs).
  if (sl === 'water' || /^water(_|$)/.test(id)) return 'water';

  // Roads — transportation layers, split by class encoded in the id.
  if (sl === 'transportation' || /^(road|tunnel|bridge)_/.test(id)) {
    if (/_(mot|trunk|pri)(_|$)/.test(id)) return 'roads_major';
    return 'roads_minor';
  }
  // Runways/taxiways ride with minor roads.
  if (sl === 'aeroway' || /^aeroway/.test(id)) return 'roads_minor';

  return null;
}

/**
 * Apply a hidden-category set to a live MapLibre map by flipping each matching
 * layer's `visibility`. Idempotent and cheap (only writes when a value
 * actually changes). Safe to call before the style is fully parsed — it
 * no-ops if the style isn't readable yet. Re-run after any style swap, since a
 * new style resets visibility.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {Set<string>} hiddenSet   category ids to hide
 */
export function applyFeatureVisibility(map, hiddenSet) {
  if (!map || typeof map.getStyle !== 'function') return;
  let layers;
  try {
    layers = map.getStyle()?.layers;
  } catch {
    return; // style not ready
  }
  if (!Array.isArray(layers)) return;
  const hidden = hiddenSet || new Set();
  for (const layer of layers) {
    const cat = categorizeLayer(layer);
    if (!cat) continue;
    const want = hidden.has(cat) ? 'none' : 'visible';
    try {
      const cur = map.getLayoutProperty(layer.id, 'visibility') ?? 'visible';
      if (cur !== want) map.setLayoutProperty(layer.id, 'visibility', want);
    } catch {
      /* layer without a visibility property — skip */
    }
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────
// The decluttered look is a per-operator preference (esp. on the wall), so
// persist the hidden set across reloads.
const HIDDEN_KEY = 'meridian.basemapHiddenCategories';

export function loadHiddenCategories() {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function saveHiddenCategories(hiddenSet) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...(hiddenSet || [])]));
  } catch {
    /* storage disabled — in-memory only */
  }
}
