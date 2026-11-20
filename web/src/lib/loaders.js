/**
 * loaders.js
 *
 * Data-fetching helpers that talk to the Bun API server.
 * All requests include credentials (session cookie) so the Bun server can
 * validate the session before proxying to the Python backend.
 */
import { logger } from '@lib/logger';
import { apiFetch } from './apiFetch.js';
import { applyRoleDefaults, setLastRemoteHost } from './stateBus.js';

// ── Process-level request dedup + cache ───────────────────────────────────
//
// Many UI events (anchor-mode change, frame remount, opening the same
// chart twice) re-trigger the same loader call. Dedup pending fetches so
// concurrent callers share one request, and cache resolved results so
// remounts hit memory instead of the network. Cache is module-scoped:
// invalidates on browser refresh, which is the right granularity for
// session-stable data (per-(ext,chart,project,scenario) etc.).
//
// Caches that need to vary by user input (e.g. chart data per scenario)
// already encode that in the cache key — different keys, different
// entries, no staleness. If the same key needs forced re-fetch later,
// callers can call invalidateCache(key) or invalidateCachePrefix(prefix).
const _loaderResults = new Map();
const _loaderInflight = new Map();

/**
 * Dedup + cache a fetcher by stable key.
 * @param {string} key — stable identifier (typically include all params)
 * @param {() => Promise<T>} fetcher — invoked only on cache miss
 * @returns {Promise<T>}
 */
export function cachedRequest(key, fetcher) {
  if (_loaderResults.has(key)) {
    return Promise.resolve(_loaderResults.get(key));
  }
  if (_loaderInflight.has(key)) return _loaderInflight.get(key);
  const p = (async () => {
    try {
      const result = await fetcher();
      _loaderResults.set(key, result);
      return result;
    } finally {
      _loaderInflight.delete(key);
    }
  })();
  _loaderInflight.set(key, p);
  return p;
}

export function invalidateCache(key) {
  _loaderResults.delete(key);
}
export function invalidateCachePrefix(prefix) {
  for (const k of _loaderResults.keys()) {
    if (k.startsWith(prefix)) _loaderResults.delete(k);
  }
}

/**
 * Fetch all layers (with nested datasets + style mappings) for a scenario.
 *
 * @param {string} project
 * @param {string} scenario
 * @returns {Promise<object[]>}
 */
export async function fetchScenarioLayers(project, scenario) {
  return apiFetch(
    `/api/layers/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}`,
    { name: 'fetchScenarioLayers' },
  );
}

/**
 * Fetch all layers across all projects and scenarios.
 * Used by the Map Layers panel to show a unified view.
 * @returns {Promise<object[]>}
 */
export async function fetchAllLayers({ signal } = {}) {
  return apiFetch('/api/layers/all', { name: 'fetchAllLayers', signal });
}

/**
 * Fetch the GeoJSON data for a registered geometry file by its DB id.
 *
 * @param {number} geoId
 * @returns {Promise<object>} GeoJSON FeatureCollection
 */
export async function fetchGeometryData(geoId, { signal } = {}) {
  return apiFetch(`/api/geometry/${geoId}/data`, { name: 'fetchGeometryData', signal });
}

/**
 * Fetch dataset data as an array of row objects (suitable for static datasets).
 *
 * @param {number} datasetId
 * @returns {Promise<object[]>}
 */
export async function fetchDatasetData(datasetId, { signal } = {}) {
  // cache: 'no-store' so an extension control change always sees fresh data —
  // the server endpoint has no Cache-Control header, and Chrome/Safari's
  // heuristic cache will otherwise serve stale rows mid-session.
  return apiFetch(`/api/datasets/${datasetId}/data`, {
    name: 'fetchDatasetData',
    cache: 'no-store',
    signal,
  });
}

/**
 * Fetch the column names available in a dataset.
 *
 * @param {number} datasetId
 * @returns {Promise<string[]>}
 */
export async function fetchDatasetColumns(datasetId) {
  const schema = await fetchDatasetSchema(datasetId);
  return schema.columns ?? [];
}

/**
 * Fetch the full column schema for a dataset, including dtype strings and
 * smart suggestions for join key and timestamp column.
 *
 * @param {number} datasetId
 * @returns {Promise<{
 *   columns: string[],
 *   dtypes: Record<string, string>,
 *   suggested_join_key: string|null,
 *   suggested_timestamp_col: string|null,
 * }>}
 */
export async function fetchDatasetSchema(datasetId) {
  return apiFetch(`/api/datasets/${datasetId}/columns`, { name: 'fetchDatasetSchema' });
}

/**
 * Fetch the GeoJSON feature property names and a suggested join key for a
 * registered geometry file.
 *
 * @param {number} geoId
 * @returns {Promise<{ properties: string[], suggested_join_key: string|null }>}
 */
export async function fetchGeometrySchema(geoId) {
  return apiFetch(`/api/geometry/${geoId}/schema`, { name: 'fetchGeometrySchema' });
}

/**
 * Fetch all registered geometry files.
 *
 * @returns {Promise<object[]>}
 */
export async function fetchGeometryFiles() {
  return apiFetch('/api/geometry', { name: 'fetchGeometryFiles' });
}

/**
 * Fetch all registered datasets.
 *
 * @returns {Promise<object[]>}
 */
export async function fetchDatasets() {
  return apiFetch('/api/datasets', { name: 'fetchDatasets' });
}

// ── Data preview (paginated inspection) ──────────────────────────────────────

export async function previewGeometry(geoId, { offset = 0, limit = 20 } = {}) {
  const result = await apiFetch(
    `/api/geometry/${geoId}/preview?offset=${offset}&limit=${limit}`,
    { name: 'previewGeometry' },
  );
  return result.data ?? result;
}

export async function previewDataset(datasetId, { offset = 0, limit = 20, partition = null } = {}) {
  let url = `/api/datasets/${datasetId}/preview?offset=${offset}&limit=${limit}`;
  if (partition) url += `&partition=${encodeURIComponent(partition)}`;
  const result = await apiFetch(url, { name: 'previewDataset' });
  return result.data ?? result;
}

/**
 * Create a new layer for a project/scenario.
 *
 * @param {{ project, scenario, geometry_id, name, deck_layer_type, display_name? }} params
 * @returns {Promise<object>} created layer record
 */
export async function createLayer(params) {
  return apiFetch('/api/layers', {
    method: 'POST',
    body: params,
    name: 'createLayer',
  });
}

/**
 * Attach a dataset to a layer with join key configuration.
 *
 * @param {number} layerId
 * @param {{ dataset_id, geom_join_key?, data_join_key? }} params
 * @returns {Promise<object>} created LayerDataset record
 */
export async function attachDatasetToLayer(layerId, params) {
  return apiFetch(`/api/layers/${layerId}/datasets`, {
    method: 'POST',
    body: params,
    name: 'attachDatasetToLayer',
  });
}

/**
 * Add a style mapping to a layer (links a visual property to a data column).
 *
 * @param {number} layerId
 * @param {{ layer_dataset_id, visual_property, column, colormap?, scale_type?, domain_min?, domain_max? }} mapping
 * @returns {Promise<object>}
 */
export async function addStyleMapping(layerId, mapping) {
  return apiFetch(`/api/layers/${layerId}/style`, {
    method: 'POST',
    body: mapping,
    name: 'addStyleMapping',
  });
}

/**
 * Delete a style mapping from a layer.
 *
 * @param {number} layerId
 * @param {number} styleId
 */
export async function deleteStyleMapping(layerId, styleId) {
  return apiFetch(`/api/layers/${layerId}/style/${styleId}`, {
    method: 'DELETE',
    name: 'deleteStyleMapping',
  });
}

/**
 * Update fields on an existing style mapping (e.g. category_map_id, aggregation_mode).
 */
export async function updateStyleMapping(layerId, styleId, updates) {
  return apiFetch(`/api/layers/${layerId}/style/${styleId}`, {
    method: 'PATCH',
    body: updates,
    name: 'updateStyleMapping',
  });
}

/**
 * Fetch available category maps, optionally filtered by scenario.
 *
 * @param {number} [scenarioId]
 * @returns {Promise<object[]>}
 */
export async function fetchCategoryMaps(scenarioId) {
  const params = scenarioId ? `?scenario_id=${scenarioId}` : '';
  return apiFetch(`/api/category-maps${params}`, { name: 'fetchCategoryMaps' });
}

/**
 * Delete a layer (and its dataset associations + style mappings).
 * Does NOT delete the underlying geometry or dataset files.
 *
 * @param {number} layerId
 */
export async function deleteLayer(layerId) {
  return apiFetch(`/api/layers/${layerId}`, {
    method: 'DELETE',
    name: 'deleteLayer',
  });
}

/**
 * Update mutable fields on a geometry file (e.g. join_key, name).
 *
 * @param {number} geoId
 * @param {{ join_key?: string, name?: string }} updates
 * @returns {Promise<object>} updated GeometryFile record
 */
export async function updateGeometry(geoId, updates) {
  return apiFetch(`/api/geometry/${geoId}`, {
    method: 'PATCH',
    body: updates,
    name: 'updateGeometry',
  });
}

/**
 * Upload a geometry file and register it in the database.
 *
 * @param {File} file
 * @param {{ name?, format?, join_key? }} meta
 * @returns {Promise<object>} created GeometryFile record
 */
/**
 * One-click layer creation from a geometry file. Creates a layer in the
 * default catalog project, auto-attaches the best matching dataset, and
 * applies default styling.
 * @param {number} geometryId
 * @returns {Promise<Object>} Full layer record
 */
export async function quickLayerFromGeometry(geometryId) {
  return apiFetch(`/api/geometry/${geometryId}/quick-layer`, {
    method: 'POST',
    name: 'quickLayerFromGeometry',
  });
}

export async function uploadGeometryFile(file, meta = {}) {
  const form = new FormData();
  form.append('file', file);
  if (meta.name) form.append('name', meta.name);
  if (meta.format) form.append('format', meta.format);
  if (meta.join_key) form.append('join_key', meta.join_key);
  if (meta.scope) form.append('scope', meta.scope);
  if (meta.lat_col) form.append('lat_col', meta.lat_col);
  if (meta.lon_col) form.append('lon_col', meta.lon_col);
  if (meta.display_name) form.append('display_name', meta.display_name);
  if (meta.description) form.append('description', meta.description);
  // Spatial (shapefile/fgb/gpkg) ingest hints — see lib/geometry_spatial.py.
  if (meta.category_col) form.append('category_col', meta.category_col);
  if (meta.source_srs) form.append('source_srs', meta.source_srs);

  return apiFetch('/api/geometry', {
    method: 'POST',
    body: form,
    name: 'uploadGeometryFile',
  });
}

/**
 * Fetch only the features of a spatial geometry that fall inside the current
 * map viewport, at a zoom-appropriate simplification, with optional per-category
 * zoom gating. Backed by GET /api/geometry/{id}/viewport (DuckDB spatial).
 *
 * @param {number} geoId
 * @param {{ bbox: [number,number,number,number], zoom: number,
 *           columns?: string[], categoryMinZoom?: Record<string,number>,
 *           cap?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{type:'FeatureCollection', features:object[], count:number, truncated:boolean, cap:number}>}
 */
export async function fetchGeometryViewport(geoId, { bbox, zoom, columns, categoryMinZoom, cap, signal } = {}) {
  const [w, s, e, n] = bbox;
  const params = new URLSearchParams({ bbox: `${w},${s},${e},${n}`, zoom: String(zoom) });
  if (columns?.length) params.set('columns', columns.join(','));
  if (categoryMinZoom && Object.keys(categoryMinZoom).length) {
    params.set('filters', JSON.stringify({ category_min_zoom: categoryMinZoom }));
  }
  if (cap != null) params.set('cap', String(cap));
  // No caching layer here: the server caches by snapped bbox/zoom, and results
  // change as the user pans — a client cache would just leak memory.
  return apiFetch(`/api/geometry/${geoId}/viewport?${params.toString()}`, {
    name: 'fetchGeometryViewport',
    signal,
  });
}

/**
 * Preview CSV columns for geometry upload — returns column names and
 * auto-detected lat/lon columns.
 * @param {File} file
 * @returns {Promise<{columns: string[], detected_lat_col: string|null, detected_lon_col: string|null}>}
 */
export async function previewGeometryCsv(file) {
  const form = new FormData();
  form.append('file', file);
  return apiFetch('/api/geometry/preview-csv', {
    method: 'POST',
    body: form,
    name: 'previewGeometryCsv',
  });
}

/**
 * Fetch partition metadata for a timeseries dataset.
 *
 * @param {number} datasetId
 * @returns {Promise<{
 *   dates: string[],
 *   entity_columns: string[],
 *   row_counts: Record<string, number>,
 *   timestamp_col: string,
 * }>}
 */
export async function fetchDatasetPartitions(datasetId) {
  return cachedRequest(`partitions:${datasetId}`, () => apiFetch(
    `/api/datasets/${datasetId}/partitions`,
    { name: 'fetchDatasetPartitions' },
  ));
}

/**
 * Fetch one date partition as an ArrayBuffer (Arrow IPC stream).
 *
 * @param {number} datasetId
 * @param {string} dateStr   – YYYY-MM-DD
 * @returns {Promise<ArrayBuffer>}
 */
export async function streamDatasetPartition(datasetId, dateStr) {
  return cachedRequest(`stream:${datasetId}:${dateStr}`, () => apiFetch(
    `/api/datasets/${datasetId}/stream/${encodeURIComponent(dateStr)}`,
    { responseType: 'arrayBuffer', name: 'streamDatasetPartition' },
  ));
}

/**
 * Fetch single rows from one or more timeseries datasets (sparse lookup).
 *
 * Use this for scrubbing / jumping to a specific timestep.
 * For continuous animation, use TimeseriesBuffer partition streaming instead.
 *
 * @param {Array<{dataset_id: number, row_id: number}>} requests
 * @returns {Promise<Record<string, Record<string, any>>>}
 *   Keyed by dataset_id (string). Each value is { col: val, ... } for one row.
 */
export async function fetchDatasetRows(requests) {
  return apiFetch('/api/datasets/rows', {
    method: 'POST',
    body: requests,
    name: 'fetchDatasetRows',
  });
}

/**
 * Fetch the full timeseries for a single entity across all partitions.
 *
 * @param {number} datasetId
 * @param {string} entityId
 * @returns {Promise<{ timestamps: string[], values: number[] }>}
 */
export async function fetchEntityTimeseries(datasetId, entityId, { signal } = {}) {
  // Not cachedRequest: this is on the entity-click hot path where the caller
  // supersedes (aborts) prior loads, and a shared cached promise can't carry a
  // per-caller signal. An aborted fetch simply rejects; nothing is cached.
  return apiFetch(
    `/api/datasets/${datasetId}/entity/${encodeURIComponent(entityId)}/timeseries`,
    { name: 'fetchEntityTimeseries', signal },
  );
}

/**
 * Windowed single-entity timeseries — returns an Arrow Table with two
 * columns (``timestamp``, ``value``) covering ``[fromIso, toIso]``.
 *
 * Backs the entity-inspector chart's rolling-window playback: a click
 * issues one request for the visible 72 h around the cursor, then the
 * chunked cache (entitySeriesCache.js) issues follow-ups as the cursor
 * advances. Server projects only the requested timestamp columns from
 * the wide-format table, so the response is small (~864 floats for
 * 72 h at 5-min) and arrives in milliseconds.
 *
 * @param {number} datasetId
 * @param {string} entityId
 * @param {string|null} fromIso  inclusive ISO 8601 lower bound, or null
 * @param {string|null} toIso    inclusive ISO 8601 upper bound, or null
 * @param {number|null} maxPoints optional server-side downsample cap
 * @returns {Promise<import('apache-arrow').Table>}
 */
export async function fetchEntitySeriesWindow(
  datasetId, entityId, fromIso, toIso, maxPoints = null,
) {
  const params = new URLSearchParams();
  if (fromIso) params.set('from_ts', fromIso);
  if (toIso) params.set('to_ts', toIso);
  if (maxPoints) params.set('max_points', String(maxPoints));
  const qs = params.toString();
  const url = `/api/datasets/${datasetId}/entity/${encodeURIComponent(entityId)}/series`
    + (qs ? `?${qs}` : '');
  const buf = await apiFetch(url, {
    responseType: 'arrayBuffer',
    name: 'fetchEntitySeriesWindow',
  });
  const { tableFromIPC } = await import('apache-arrow');
  return tableFromIPC(new Uint8Array(buf));
}

/**
 * Upload a dataset file and register it in the database.
 *
 * @param {File} file
 * @param {{ name?, format?, join_key?, timestamp_col? }} meta
 * @returns {Promise<object>} created Dataset record
 */
// ── Paintings (per-layer style snapshots) ────────────────────────────────────

export async function fetchPaintings(layerId) {
  logger.debug('[loaders] GET /api/layers/' + layerId + '/paintings');
  try {
    const data = await apiFetch(`/api/layers/${layerId}/paintings`, { name: 'fetchPaintings' });
    logger.info('[loaders] fetchPaintings returned', data?.length, 'item(s)', data);
    return data;
  } catch (err) {
    logger.error('[loaders] fetchPaintings failed', { layerId, error: err.message });
    throw err;
  }
}

export async function createPainting(layerId, name, style) {
  const payload = { name, style };
  logger.debug('[loaders] POST /api/layers/' + layerId + '/paintings', payload);
  try {
    const data = await apiFetch(`/api/layers/${layerId}/paintings`, {
      method: 'POST',
      body: payload,
      name: 'createPainting',
    });
    logger.info('[loaders] createPainting server response', data);
    return data;
  } catch (err) {
    logger.error('[loaders] createPainting failed', { layerId, name, error: err.message });
    throw err;
  }
}

export async function updatePainting(paintingId, updates) {
  logger.debug('[loaders] PATCH /api/paintings/' + paintingId, updates);
  try {
    const data = await apiFetch(`/api/paintings/${paintingId}`, {
      method: 'PATCH',
      body: updates,
      name: 'updatePainting',
    });
    logger.info('[loaders] updatePainting server response', data);
    return data;
  } catch (err) {
    logger.error('[loaders] updatePainting failed', { paintingId, error: err.message });
    throw err;
  }
}

export async function deletePainting(paintingId) {
  logger.debug('[loaders] DELETE /api/paintings/' + paintingId);
  try {
    const data = await apiFetch(`/api/paintings/${paintingId}`, {
      method: 'DELETE',
      name: 'deletePainting',
    });
    logger.info('[loaders] deletePainting server response', data);
    return data;
  } catch (err) {
    logger.error('[loaders] deletePainting failed', { paintingId, error: err.message });
    throw err;
  }
}

// ── Extensions ───────────────────────────────────────────────────────────────

export async function fetchExtensions() {
  const result = await apiFetch('/api/extensions', { name: 'fetchExtensions' });
  return result.data ?? result;
}

/**
 * Get all extension preferences (including hidden) for the current user.
 * @returns {Promise<Array<{name, display_name, icon, state}>>}
 */
export async function fetchExtensionPreferences() {
  const result = await apiFetch('/api/extensions/preferences', {
    name: 'fetchExtensionPreferences',
  });
  return result.data ?? result;
}

/**
 * Set extension state for the current user.
 * @param {string} extName
 * @param {string} state - "enabled", "disabled", or "hidden"
 */
export async function setExtensionPreference(extName, state) {
  return apiFetch(`/api/extensions/${encodeURIComponent(extName)}/preference`, {
    method: 'PATCH',
    body: { state },
    name: 'setExtensionPreference',
  });
}

/**
 * Delete a scenario from an extension. The server invokes the extension's
 * own delete_scenario hook, then prunes the ORM rows so the UI no longer
 * lists it. Caller is responsible for refreshing whatever surfaces the
 * scenario was visible in (project list, scenario picker, etc.).
 *
 * Invalidates partition + stream caches so any rendered chart that was
 * pointed at the deleted scenario doesn't keep serving stale data.
 */
export async function deleteExtensionScenario(extName, project, scenario) {
  const result = await apiFetch(
    `/api/extensions/${encodeURIComponent(extName)}/scenarios/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}`,
    { method: 'DELETE', name: 'deleteExtensionScenario' },
  );
  invalidateCachePrefix('partitions:');
  invalidateCachePrefix('stream:');
  invalidateCachePrefix('chart-data:');
  invalidateCachePrefix('ext-charts:');
  return result;
}

// ── Extension Controls ───────────────────────────────────────────────────────

export async function fetchExtensionControls(extName, project, scenario, entityId, { signal } = {}) {
  return apiFetch(
    `/api/extensions/${encodeURIComponent(extName)}/controls/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}/${encodeURIComponent(entityId)}`,
    { name: 'fetchExtensionControls', signal },
  );
}

export async function setExtensionControl(extName, project, scenario, entityId, controlName, value) {
  return apiFetch(
    `/api/extensions/${encodeURIComponent(extName)}/controls/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}/${encodeURIComponent(entityId)}`,
    {
      method: 'POST',
      body: { control_name: controlName, value },
      name: 'setExtensionControl',
    },
  );
}

// ── Extension Input Controls (project/scenario-level) ────────────────────────

export async function fetchInputControls(extName, project, scenario) {
  return apiFetch(
    `/api/extensions/${encodeURIComponent(extName)}/input-controls/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}`,
    { name: 'fetchInputControls' },
  );
}

export async function setInputControl(extName, project, scenario, controlName, value) {
  return apiFetch(
    `/api/extensions/${encodeURIComponent(extName)}/input-controls/${encodeURIComponent(project)}/${encodeURIComponent(scenario)}`,
    {
      method: 'POST',
      body: { control_name: controlName, value },
      name: 'setInputControl',
    },
  );
}

// ── Extension Charts ─────────────────────────────────────────────────────────

export async function fetchExtensionCharts(extName) {
  return cachedRequest(`ext-charts:${extName}`, () => apiFetch(
    `/api/extensions/${encodeURIComponent(extName)}/charts`,
    { name: 'fetchExtensionCharts' },
  ));
}

export async function fetchChartData(extName, chartName, { entityId, project, scenario }) {
  return cachedRequest(
    `chart-data:${extName}::${chartName}::${project || ''}::${scenario || ''}::${entityId || ''}`,
    () => {
      const params = new URLSearchParams({
        entity_id: entityId || '',
        project: project || '',
        scenario: scenario || '',
      });
      return apiFetch(
        `/api/extensions/${encodeURIComponent(extName)}/charts/${encodeURIComponent(chartName)}/data?${params}`,
        { name: 'fetchChartData' },
      );
    },
  );
}

// ── Cross-Project Mapping ────────────────────────────────────────────────────

export async function searchProjects({ tag, q } = {}) {
  const params = new URLSearchParams();
  if (tag) params.set('tag', tag);
  if (q) params.set('q', q);
  return apiFetch(`/api/search/projects?${params}`, { name: 'searchProjects' });
}

export async function fetchProjectAliases(projectId) {
  return apiFetch(`/api/projects/${projectId}/aliases`, { name: 'fetchProjectAliases' });
}

export async function createProjectAlias(projectId, aliasData) {
  return apiFetch(`/api/projects/${projectId}/aliases`, {
    method: 'POST',
    body: aliasData,
    name: 'createProjectAlias',
  });
}

export async function deleteProjectAlias(aliasId) {
  return apiFetch(`/api/aliases/${aliasId}`, {
    method: 'DELETE',
    name: 'deleteProjectAlias',
  });
}

// ── Perspectives (multi-layer compositions) ──────────────────────────────────

export async function fetchPerspectives(params = {}) {
  const qs = new URLSearchParams();
  if (params.project_id != null) qs.set('project_id', params.project_id);
  if (params.scenario_id != null) qs.set('scenario_id', params.scenario_id);
  const url = '/api/perspectives' + (qs.toString() ? `?${qs}` : '');
  return cachedRequest(`perspectives:${qs.toString()}`, () => apiFetch(url, {
    name: 'fetchPerspectives',
  }));
}

export async function createPerspective(data) {
  const result = await apiFetch('/api/perspectives', {
    method: 'POST',
    body: data,
    name: 'createPerspective',
  });
  invalidateCachePrefix('perspectives:');
  return result;
}

export async function fetchPerspective(id) {
  return apiFetch(`/api/perspectives/${id}`, { name: 'fetchPerspective' });
}

export async function updatePerspective(id, updates) {
  const result = await apiFetch(`/api/perspectives/${id}`, {
    method: 'PATCH',
    body: updates,
    name: 'updatePerspective',
  });
  invalidateCachePrefix('perspectives:');
  return result;
}

export async function deletePerspective(id) {
  const result = await apiFetch(`/api/perspectives/${id}`, {
    method: 'DELETE',
    name: 'deletePerspective',
  });
  invalidateCachePrefix('perspectives:');
  return result;
}

// ── Stories (sequential perspectives) ───────────────────────────────────────

export async function fetchStories(params = {}) {
  const qs = new URLSearchParams();
  if (params.project_id != null) qs.set('project_id', params.project_id);
  const url = '/api/stories' + (qs.toString() ? `?${qs}` : '');
  return cachedRequest(`stories:${qs.toString()}`, () => apiFetch(url, {
    name: 'fetchStories',
  }));
}

/**
 * Download a story as a self-contained bundle (story + steps + each step's full
 * perspective config), suitable for sharing with another GridSight instance.
 */
export async function exportStory(id) {
  return apiFetch(`/api/stories/${id}/export`, { name: 'exportStory' });
}

/**
 * Rehydrate a bundle from exportStory() into this instance. Creates fresh
 * perspectives + story + steps. `overrides` may carry {name, project_id, owner}.
 * Resolves to {id, name, steps, warnings}.
 */
export async function importStory(bundle, overrides = {}) {
  const result = await apiFetch('/api/stories/import', {
    method: 'POST',
    body: { ...bundle, ...overrides },
    name: 'importStory',
  });
  invalidateCachePrefix('stories:');
  return result;
}

export async function fetchStory(id) {
  return apiFetch(`/api/stories/${id}`, { name: 'fetchStory' });
}

export async function createStory(data) {
  const result = await apiFetch('/api/stories', {
    method: 'POST',
    body: data,
    name: 'createStory',
  });
  invalidateCachePrefix('stories:');
  return result;
}

export async function updateStory(id, updates) {
  const result = await apiFetch(`/api/stories/${id}`, {
    method: 'PATCH',
    body: updates,
    name: 'updateStory',
  });
  invalidateCachePrefix('stories:');
  return result;
}

export async function deleteStory(id) {
  const result = await apiFetch(`/api/stories/${id}`, {
    method: 'DELETE',
    name: 'deleteStory',
  });
  invalidateCachePrefix('stories:');
  return result;
}

export async function fetchStorySteps(storyId) {
  return cachedRequest(`story-steps:${storyId}`, () => apiFetch(
    `/api/stories/${storyId}/steps`,
    { name: 'fetchStorySteps' },
  ));
}

export async function addStoryStep(storyId, data) {
  const result = await apiFetch(`/api/stories/${storyId}/steps`, {
    method: 'POST',
    body: data,
    name: 'addStoryStep',
  });
  invalidateCachePrefix(`story-steps:${storyId}`);
  return result;
}

export async function updateStoryStep(storyId, stepId, updates) {
  const result = await apiFetch(`/api/stories/${storyId}/steps/${stepId}`, {
    method: 'PATCH',
    body: updates,
    name: 'updateStoryStep',
  });
  invalidateCachePrefix(`story-steps:${storyId}`);
  return result;
}

export async function deleteStoryStep(storyId, stepId) {
  const result = await apiFetch(`/api/stories/${storyId}/steps/${stepId}`, {
    method: 'DELETE',
    name: 'deleteStoryStep',
  });
  invalidateCachePrefix(`story-steps:${storyId}`);
  return result;
}

export async function reorderStorySteps(storyId, ordering) {
  const result = await apiFetch(`/api/stories/${storyId}/steps/reorder`, {
    method: 'PUT',
    body: { ordering },
    name: 'reorderStorySteps',
  });
  invalidateCachePrefix(`story-steps:${storyId}`);
  return result;
}

// ── AI Chat ──────────────────────────────────────────────────────────────────

export async function fetchChatConfig() {
  return apiFetch('/api/chat/config', { name: 'fetchChatConfig' });
}

export async function fetchChatModels() {
  const data = await apiFetch('/api/chat/models', { name: 'fetchChatModels' });
  return data.providers || [];
}

export async function fetchProviderCatalog() {
  const data = await apiFetch('/api/chat/providers/catalog', { name: 'fetchProviderCatalog' });
  return data.providers || [];
}

// ── Graph topologies (extension-supplied non-geospatial network views) ──────

export async function fetchGraphTopologies(extensionName, { project, scenario } = {}) {
  const qs = new URLSearchParams();
  if (project) qs.set('project', project);
  if (scenario) qs.set('scenario', scenario);
  const tail = qs.toString() ? `?${qs.toString()}` : '';
  const data = await apiFetch(
    `/api/extensions/${encodeURIComponent(extensionName)}/graph-topologies${tail}`,
    { name: 'fetchGraphTopologies' },
  );
  return data.topologies || [];
}

export async function fetchGraphTopologyData(extensionName, topologyName, { project, scenario } = {}) {
  const qs = new URLSearchParams();
  if (project) qs.set('project', project);
  if (scenario) qs.set('scenario', scenario);
  const tail = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(
    `/api/extensions/${encodeURIComponent(extensionName)}/graph-topology/${encodeURIComponent(topologyName)}/data${tail}`,
    { name: 'fetchGraphTopologyData' },
  );
}

/**
 * Send a chat message and return a ReadableStream of SSE events.
 *
 * @param {string} message
 * @param {string} conversationId
 * @param {string[]} [images] - base64-encoded images for vision models
 * @returns {Promise<ReadableStream>}
 */
export async function sendChatMessage(message, conversationId = 'default', images = null, { webgpuAvailable = false, activeExtensions = null, activeStoryId = null, activePerspectiveId = null, visibleLayerIds = null, reasoningEffort = null, extraInstructions = null, model = null, provider = null, think = null } = {}) {
  const body = { message, conversation_id: conversationId, webgpu_available: webgpuAvailable };
  if (images?.length) body.images = images;
  if (activeExtensions) body.active_extensions = activeExtensions;
  if (activeStoryId != null) body.active_story_id = activeStoryId;
  if (activePerspectiveId != null) body.active_perspective_id = activePerspectiveId;
  if (visibleLayerIds) body.visible_layer_ids = visibleLayerIds;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (extraInstructions) body.extra_instructions = extraInstructions;
  if (model) body.model = model;
  if (provider) body.provider = provider;
  if (think !== null) body.think = think;
  const response = await apiFetch('/api/chat', {
    method: 'POST',
    body,
    responseType: 'response',
    name: 'sendChatMessage',
  });
  return response.body;
}

export async function cancelChat(conversationId = 'default') {
  return apiFetch(`/api/chat/${encodeURIComponent(conversationId)}/cancel`, {
    method: 'POST',
    name: 'cancelChat',
  });
}

export async function clearChat(conversationId = 'default') {
  return apiFetch(`/api/chat/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    name: 'clearChat',
  });
}

// ── Lineage ──────────────────────────────────────────────────────────────────

export async function fetchLineageForPerspective(perspectiveId) {
  return apiFetch(`/api/lineage/perspective/${perspectiveId}`, {
    name: 'fetchLineageForPerspective',
  });
}

export async function fetchLineageNode(nodeId) {
  return apiFetch(`/api/lineage/node/${nodeId}`, { name: 'fetchLineageNode' });
}

export async function fetchLineageAncestors(nodeId) {
  return apiFetch(`/api/lineage/node/${nodeId}/ancestors`, {
    name: 'fetchLineageAncestors',
  });
}

export async function fetchLineageNodeReviews(nodeId) {
  return apiFetch(`/api/lineage/node/${nodeId}/reviews`, {
    name: 'fetchLineageNodeReviews',
  });
}

export async function addLineageReview(nodeId, review) {
  return apiFetch(`/api/lineage/node/${nodeId}/reviews`, {
    method: 'POST',
    body: review,
    name: 'addLineageReview',
  });
}

export async function searchLineageNodes(params = {}) {
  const qs = new URLSearchParams();
  if (params.node_type) qs.set('node_type', params.node_type);
  if (params.extension_name) qs.set('extension_name', params.extension_name);
  if (params.creator_type) qs.set('creator_type', params.creator_type);
  const url = '/api/lineage/search' + (qs.toString() ? `?${qs}` : '');
  return apiFetch(url, { name: 'searchLineageNodes' });
}

export async function uploadDatasetFile(file, meta = {}) {
  const form = new FormData();
  form.append('file', file);
  if (meta.name) form.append('name', meta.name);
  if (meta.format) form.append('format', meta.format);
  if (meta.join_key) form.append('join_key', meta.join_key);
  if (meta.timestamp_col) form.append('timestamp_col', meta.timestamp_col);
  if (meta.scope) form.append('scope', meta.scope);
  if (meta.display_name) form.append('display_name', meta.display_name);
  if (meta.description) form.append('description', meta.description);

  return apiFetch('/api/datasets', {
    method: 'POST',
    body: form,
    name: 'uploadDatasetFile',
  });
}

export async function updateDataset(datasetId, updates) {
  return apiFetch(`/api/datasets/${datasetId}`, {
    method: 'PATCH',
    body: updates,
    name: 'updateDataset',
  });
}

/**
 * Delete an uploaded dataset and everything it spawned: layer associations,
 * join hints, descriptions, and the registered DuckDB table.
 *
 * @param {number} datasetId
 */
export async function deleteDataset(datasetId) {
  return apiFetch(`/api/datasets/${datasetId}`, {
    method: 'DELETE',
    name: 'deleteDataset',
  });
}

export async function generateDescription(targetType, targetId, { columnName, source } = {}) {
  return apiFetch('/api/descriptions/generate', {
    method: 'POST',
    body: {
      target_type: targetType,
      target_id: targetId,
      column_name: columnName || null,
      source: source || 'data',
    },
    name: 'generateDescription',
  });
}

export async function fetchColumnDescriptions(tableName) {
  // Soft-fail: missing description rows aren't an error condition; the UI
  // shows "no descriptions yet" rather than blowing up.
  try {
    return await apiFetch(`/api/descriptions/${encodeURIComponent(tableName)}`, {
      name: 'fetchColumnDescriptions',
    });
  } catch {
    return { table_name: tableName, description: null, columns: {} };
  }
}

export async function uploadDescriptionFile(file, { targetType, targetId } = {}) {
  const form = new FormData();
  form.append('file', file);
  form.append('target_type', targetType);
  form.append('target_id', String(targetId));
  return apiFetch('/api/descriptions/upload', {
    method: 'POST',
    body: form,
    name: 'uploadDescriptionFile',
  });
}

// ---------------------------------------------------------------------------
// Join Hints
// ---------------------------------------------------------------------------

/**
 * Fetch auto-discovered join compatibility hints for a geometry.
 * @param {number} geometryId
 * @returns {Promise<Array>} Array of join hint objects sorted by overlap desc
 */
export async function fetchJoinHints(geometryId) {
  return apiFetch(`/api/join-hints?geometry_id=${geometryId}`, { name: 'fetchJoinHints' });
}

/**
 * Update the status of a join hint (confirm or reject).
 * @param {number} hintId
 * @param {string} status - "suggested", "confirmed", or "rejected"
 */
export async function updateJoinHintStatus(hintId, status) {
  return apiFetch(`/api/join-hints/${hintId}`, {
    method: 'PATCH',
    body: { status },
    name: 'updateJoinHintStatus',
  });
}


// ---------------------------------------------------------------------------
// Extension File Uploads
// ---------------------------------------------------------------------------

/**
 * Fetch upload specifications for an extension.
 * @param {string} extName
 * @returns {Promise<object[]>} Array of FileUploadSpec objects
 */
export async function fetchExtensionUploadSpecs(extName) {
  const data = await apiFetch(`/api/extensions/${encodeURIComponent(extName)}/upload-specs`, {
    name: 'fetchExtensionUploadSpecs',
  });
  return Array.isArray(data) ? data : (data?.body ?? []);
}

/**
 * Generic synchronous query into an extension's `handle_query(kind, params)`.
 *
 * @param {string} extName
 * @param {string} kind   extension-defined query kind, e.g. "system_components"
 * @param {object} params JSON body forwarded to the extension method
 */
export async function queryExtension(extName, kind, params = {}) {
  const body = await apiFetch(
    `/api/extensions/${encodeURIComponent(extName)}/query/${encodeURIComponent(kind)}`,
    {
      method: 'POST',
      body: params,
      name: 'queryExtension',
    },
  );
  return body?.body ?? body;
}

/**
 * Preview an extension upload before commit.
 *
 * Mirrors `uploadToExtension`'s multipart submit but hits the synchronous
 * preview endpoint, which dispatches to `ext.handle_preview`. Returns the
 * `PreviewResult.data` dict on success, throws on `success=false` or HTTP
 * error.
 *
 * @param {string} extName
 * @param {string} specName
 * @param {Object.<string, File[]>} fileGroups
 * @param {Object.<string, string>} formData
 * @returns {Promise<object>} preview-result data
 */
export async function previewExtensionUpload(extName, specName, fileGroups, formData = {}) {
  // Desktop short-circuit: if every selected file already has an
  // absolute path (Tauri's file picker returns paths; ``desktopBridge``
  // attaches them to File objects), skip the multipart POST and hand
  // the paths straight to the sidecar's ``/preview-local`` endpoint.
  const filePathGroups = collectLocalFilePaths(fileGroups);
  if (filePathGroups) {
    const body = await apiFetch(
      `/api/extensions/${encodeURIComponent(extName)}/preview-local/${encodeURIComponent(specName)}`,
      {
        method: 'POST',
        body: { file_paths: filePathGroups, form_data: formData },
        name: 'previewExtensionUpload (local)',
      },
    );
    const result = body?.body ?? body;
    if (result?.success === false) throw new Error(result.error || 'Preview failed');
    return result?.data ?? result;
  }

  const form = new FormData();
  for (const [groupName, files] of Object.entries(fileGroups)) {
    for (const file of files) form.append(groupName, file);
  }
  for (const [key, value] of Object.entries(formData)) {
    form.append(key, value);
  }
  const body = await apiFetch(
    `/api/extensions/${encodeURIComponent(extName)}/preview/${encodeURIComponent(specName)}`,
    { method: 'POST', body: form, name: 'previewExtensionUpload' },
  );
  const result = body?.body ?? body;
  if (result?.success === false) {
    throw new Error(result.error || 'Preview failed');
  }
  return result?.data ?? result;
}

/** Inspect a fileGroups object and, if every entry carries an absolute
 * ``.path`` string (set by ``desktopBridge`` after picking files via
 * Tauri's native dialog), return a ``{ group: [paths] }`` shape ready
 * for the ``-local`` endpoints. Otherwise return ``null`` so the
 * caller falls back to multipart upload.
 *
 * Lives here so both upload helpers share the detection rule.
 */
function collectLocalFilePaths(fileGroups) {
  if (!fileGroups || typeof fileGroups !== 'object') return null;
  const out = {};
  for (const [groupName, files] of Object.entries(fileGroups)) {
    if (!Array.isArray(files) || files.length === 0) continue;
    const paths = [];
    for (const f of files) {
      const p = f && typeof f === 'object' ? f.path : null;
      if (typeof p !== 'string' || !p.startsWith('/')) return null;
      paths.push(p);
    }
    out[groupName] = paths;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Upload files to an extension's upload handler.
 *
 * Two-stage: POST submits the upload and gets a `job_id` back; the server
 * runs the (possibly multi-minute) ingest on a background thread. We then
 * poll until the job reaches a terminal state. This avoids the Bun proxy
 * idle-timeout that used to silently kill long uploads.
 *
 * Submit goes via XHR (not fetch) so we can surface byte-level upload
 * progress — fetch has no upload-progress event. The polling phase still
 * uses fetch.
 *
 * @param {string} extName - Extension name
 * @param {string} specName - Upload spec name (e.g. "sienna_scenario")
 * @param {Object.<string, File[]>} fileGroups - Map of group name → File array
 * @param {Object.<string, string>} formData - Map of form field name → value
 * @param {object} [opts]
 * @param {(progress: {phase: string, loaded?: number, total?: number, job?: object}) => void} [opts.onProgress]
 *        Called with `{ phase: 'uploading', loaded, total }` during the XHR
 *        upload, then with `{ phase: <job.status>, job }` during polling.
 * @param {AbortSignal} [opts.signal] - Aborts the XHR upload and stops polling.
 * @param {number} [opts.pollIntervalMs=2000]
 * @param {number} [opts.timeoutMs=20*60*1000]
 * @returns {Promise<object>} UploadResult
 */
export async function uploadToExtension(extName, specName, fileGroups, formData, opts = {}) {
  const { onProgress, signal, pollIntervalMs = 2000, timeoutMs = 20 * 60 * 1000 } = opts;

  // Desktop short-circuit: when files carry absolute paths (Tauri
  // dialog → desktopBridge), skip the multipart POST entirely. We
  // POST a JSON body to ``/upload-local`` which hands paths straight
  // to the extension; the same job-id polling loop below handles the
  // background ingest. No upload-progress phase — the bytes are
  // already on the sidecar's disk — so we report 'pending'
  // immediately so the UI moves past the upload spinner.
  const filePathGroups = collectLocalFilePaths(fileGroups);
  if (filePathGroups) {
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
    if (onProgress) {
      try { onProgress({ phase: 'pending', loaded: 0, total: 0 }); } catch { /* swallow */ }
    }
    const submitBody = await apiFetch(
      `/api/extensions/${encodeURIComponent(extName)}/upload-local/${encodeURIComponent(specName)}`,
      {
        method: 'POST',
        body: { file_paths: filePathGroups, form_data: formData },
        signal,
        name: 'uploadToExtension (local)',
      },
    );
    const localJobId = submitBody?.body?.job_id ?? submitBody?.job_id;
    if (!localJobId) return submitBody;
    return pollExtensionUploadJob(localJobId, { onProgress, signal, pollIntervalMs, timeoutMs });
  }

  const form = new FormData();
  for (const [groupName, files] of Object.entries(fileGroups)) {
    for (const file of files) {
      form.append(groupName, file);
    }
  }
  for (const [key, value] of Object.entries(formData)) {
    form.append(key, value);
  }

  // ── Stage 1: XHR submit with upload progress ──
  // NOTE: kept as raw XHR (not migrated to apiFetch) because fetch has no
  // upload-progress event; we need byte-level progress for multi-GB uploads.
  const submitBody = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/extensions/${encodeURIComponent(extName)}/upload/${encodeURIComponent(specName)}`;
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (ev) => {
        try {
          // `loaded` is always reported; `total` may be 0 if lengthComputable
          // flickers off mid-upload (rare, but seen). Pass undefined in that
          // case so the UI can fall back to indeterminate without losing the
          // byte counter.
          onProgress({
            phase: 'uploading',
            loaded: ev.loaded,
            total: ev.lengthComputable ? ev.total : undefined,
          });
        } catch { /* swallow */ }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data?.body ?? data);
        } catch (e) {
          reject(new Error(`[loaders] uploadToExtension parse failed: ${e}`));
        }
      } else {
        reject(new Error(
          `[loaders] uploadToExtension submit failed: ${xhr.status} ${xhr.responseText || ''}`,
        ));
      }
    };
    xhr.onerror = () => reject(new Error('[loaders] uploadToExtension network error'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });

  const jobId = submitBody?.job_id;
  if (!jobId) {
    // Backward compatibility — older servers returned the result inline.
    return submitBody;
  }
  return pollExtensionUploadJob(jobId, { onProgress, signal, pollIntervalMs, timeoutMs });
}

/** Poll ``/api/extensions/upload-jobs/{job_id}`` until it reaches a
 * terminal state. Shared by the multipart and the desktop-local
 * upload paths since both submit returns the same ``{job_id}`` shape. */
async function pollExtensionUploadJob(jobId, { onProgress, signal, pollIntervalMs, timeoutMs }) {
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `[loaders] uploadToExtension timed out after ${Math.round(timeoutMs / 1000)}s — `
        + `the server may still be processing job ${jobId}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const statusData = await apiFetch(
      `/api/extensions/upload-jobs/${encodeURIComponent(jobId)}`,
      { name: 'uploadToExtension status' },
    );
    const job = statusData?.body ?? statusData;
    if (onProgress) {
      try { onProgress({ phase: job.status, job }); } catch { /* swallow */ }
    }
    if (job.status === 'success' || job.status === 'error') {
      return job.result || { success: job.status === 'success', error: job.error || '' };
    }
  }
}

/**
 * Fetch existing system file paths from GAT scenarios (for reuse).
 * @param {string} extName
 * @returns {Promise<object[]>} Array of { project, scenario, system_path }
 */
export async function fetchExtensionExistingSystems(extName) {
  let data;
  try {
    data = await apiFetch(`/api/extensions/${encodeURIComponent(extName)}/upload-specs`, {
      name: 'fetchExtensionExistingSystems',
    });
  } catch {
    return [];
  }
  const specs = Array.isArray(data) ? data : (data?.body ?? []);
  // existing_systems is populated by the backend alongside specs
  return specs?.[0]?.existing_systems ?? [];
}

// ---------------------------------------------------------------------------
// Reactive Chart SQL Execution
// ---------------------------------------------------------------------------

/**
 * Execute a single SQL query for chart rendering.
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
export async function executeChartSQL(sql) {
  return apiFetch('/api/charts/execute', {
    method: 'POST',
    body: { sql },
    name: 'executeChartSQL',
  });
}

/**
 * Execute multiple chart SQL queries in a single batch request.
 * @param {{ chart_id: string, sql: string }[]} specs
 * @returns {Promise<Record<string, object[]>>}
 */
export async function batchExecuteCharts(specs) {
  return apiFetch('/api/charts/batch-execute', {
    method: 'POST',
    body: { charts: specs },
    name: 'batchExecuteCharts',
  });
}

// ── Guest invites + auth ───────────────────────────────────────────────────

export async function createInvite({ permissions, sessionKey, label, maxUses }) {
  return apiFetch('/api/invites', {
    method: 'POST',
    body: { permissions, sessionKey, label, maxUses },
    name: 'createInvite',
  });
}

export async function listInvites() {
  return apiFetch('/api/invites', { name: 'listInvites' });
}

export async function revokeInvite(inviteId) {
  return apiFetch(`/api/invites/${encodeURIComponent(inviteId)}`, {
    method: 'DELETE',
    name: 'revokeInvite',
  });
}

export async function redeemGuest({ token, otp }) {
  // Custom error parsing: server returns a structured JSON error body with
  // `retryAfterMs`, which the caller surfaces to the user. Use raw fetch
  // here so we can read the JSON error body on non-2xx responses.
  const response = await fetch('/auth/guest', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, otp }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const err = new Error(data.error || `redeem failed: ${response.status}`);
    err.status = response.status;
    err.retryAfterMs = data.retryAfterMs;
    throw err;
  }
  return response.json();
}

export async function fetchGuestMe() {
  return apiFetch('/auth/guest/me', { name: 'fetchGuestMe' });
}

export async function fetchGuestWsTicket() {
  return apiFetch('/auth/guest/ws-ticket', {
    method: 'POST',
    name: 'fetchGuestWsTicket',
  });
}

// ── Cross-environment remote join ────────────────────────────────────────────
// Redeem a wall-issued control invite against a DIFFERENT backend (the wall's
// Bun proxy) — used when a desktop app or other-origin browser joins a wall's
// session. Returns { sessionKey, wsTicket, guestToken, permissions, label }.
// `guestToken` is sent as a bearer on later ws-ticket refreshes since a
// SameSite=Strict guest cookie won't survive cross-origin.
//
// `credential` is either a long invite token (from a scanned QR / pasted join
// code) or a 6-digit OTP the operator reads off the wall. The backend's
// /auth/guest handler accepts both shapes — token by exact match, OTP by
// rate-limited lookup — so the desktop never needs to transcribe the long blob.
export async function redeemRemoteInvite(host, credential) {
  const base = String(host).replace(/\/+$/, '');
  const value = typeof credential === 'object' && credential !== null
    ? credential
    : { token: credential };
  const body = /^\d{6}$/.test(String(value.token || value.otp || '').trim())
    ? { otp: String(value.token || value.otp).trim() }
    : { token: value.token };
  const response = await fetch(`${base}/auth/guest`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `remote join failed: ${response.status}`);
  }
  return response.json();
}

export async function fetchRemoteWsTicket(host, guestToken) {
  const base = String(host).replace(/\/+$/, '');
  const response = await fetch(`${base}/auth/guest/ws-ticket`, {
    method: 'POST',
    credentials: 'include',
    headers: guestToken ? { Authorization: `Bearer ${guestToken}` } : {},
  });
  if (!response.ok) throw new Error(`remote ws-ticket failed: ${response.status}`);
  return response.json();
}

// One place that redeems a wall invite (by token OR 6-digit OTP) against a
// remote host and wires the bus up as the control client. Shared by every
// desktop join path — typed code, pasted join code, and scanned QR — so they
// behave identically. Remembers the host on success for next time.
export async function joinRemoteCrossEnv(bus, { host, token, otp }) {
  const info = await redeemRemoteInvite(host, { token, otp });
  bus.joinRemoteSession(info.sessionKey, {
    wsBase: host,
    ticket: info.wsTicket,
    ticketRefresh: async () =>
      (await fetchRemoteWsTicket(host, info.guestToken)).ticket,
  });
  applyRoleDefaults(bus, 'control');
  setLastRemoteHost(host);
  return info;
}
