/**
 * Default draw order for map layers: areas at the bottom, then lines, then
 * points (the usual map convention). Without it, layers draw in config
 * order, so a wide line layer added after a point layer hides the points
 * (e.g. transmission lines over generator circles).
 */

const AREA = 0;
const LINE = 1;
const POINT = 2;

const BY_DECK_TYPE = {
  GeneratorLayer: POINT,
  ScatterplotLayer: POINT,
  IconLayer: POINT,
  TextLayer: POINT,
  ColumnLayer: POINT,
  TransmissionLayer: LINE,
  PathLayer: LINE,
  LineLayer: LINE,
  ArcLayer: LINE,
  TripsLayer: LINE,
  PolygonLayer: AREA,
  SolidPolygonLayer: AREA,
  H3HexagonLayer: AREA,
  HexagonLayer: AREA,
  HeatmapLayer: AREA,
  GridLayer: AREA,
};

const BY_GEOMETRY = {
  Point: POINT,
  MultiPoint: POINT,
  LineString: LINE,
  MultiLineString: LINE,
  Polygon: AREA,
  MultiPolygon: AREA,
};

/** Rank of a layer: 0 = area, 1 = line (also unknown), 2 = point. */
export function drawRank(layerConfig, geo) {
  const t = layerConfig?.deck_layer_type;
  if (t && t in BY_DECK_TYPE) return BY_DECK_TYPE[t];
  // GeoJsonLayer (and others): look at the first feature with a geometry.
  const features = geo?.features ?? (Array.isArray(geo) ? geo : null);
  if (features) {
    for (const f of features) {
      const g = f?.geometry?.type;
      if (g) return BY_GEOMETRY[g] ?? LINE;
    }
  }
  return LINE;
}

/**
 * Sort layer configs for drawing: by rank, then by their original order
 * (stable), so layers of the same kind keep the user's order.
 */
export function sortForDrawing(layerConfigs, geoById = {}) {
  return layerConfigs
    .map((lc, i) => ({ lc, i, r: drawRank(lc, geoById[lc.id]) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.lc);
}
