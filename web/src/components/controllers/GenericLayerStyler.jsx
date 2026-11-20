import React, { useState, useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Slider from '@mui/material/Slider';
import CommittedSlider from './CommittedSlider.jsx';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import FormGroup from '@mui/material/FormGroup';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Switch from '@mui/material/Switch';
import RadioGroup from '@mui/material/RadioGroup';
import Radio from '@mui/material/Radio';
import Checkbox from '@mui/material/Checkbox';
import ListItemText from '@mui/material/ListItemText';
import OutlinedInput from '@mui/material/OutlinedInput';
import Chip from '@mui/material/Chip';
import PaletteIcon from '@mui/icons-material/Palette';
import TuneIcon from '@mui/icons-material/Tune';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import Tooltip from '@mui/material/Tooltip';
import { InfoTip, SectionHeader } from '../primitives/index.jsx';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import PsychologyIcon from '@mui/icons-material/Psychology';
import {
  addStyleMapping, deleteStyleMapping, updateStyleMapping, fetchDatasetColumns,
  fetchCategoryMaps,
  fetchPaintings, createPainting, updatePainting, deletePainting,
} from '@lib/loaders.js';
import { logger } from '@lib/logger';
import { CATEGORY10, hexToRgb, rgbToHex, autoAssignColors, useCategoryColors } from '@lib/categoryColors.jsx';

// ── Constants ─────────────────────────────────────────────────────────────────

const VISUAL_PROPERTIES = [
  { value: 'getFillColor',   label: 'Fill Color',   isColor: true  },
  { value: 'getLineColor',   label: 'Line Color',   isColor: true  },
  { value: 'getRadius',      label: 'Radius',       isColor: false },
  { value: 'getPointRadius', label: 'Point Radius', isColor: false },
  { value: 'getLineWidth',   label: 'Line Width',   isColor: false },
  { value: 'getElevation',   label: 'Elevation',    isColor: false },
];
const VISUAL_PROP_MAP = Object.fromEntries(VISUAL_PROPERTIES.map(p => [p.value, p]));

const COLORMAPS   = ['viridis', 'plasma', 'coolwarm', 'rdylgn'];
const SCALE_TYPES = ['linear', 'log'];
const COLOR_SCALE_TYPES = ['linear', 'log', 'categorical'];
const UNITS = ['meters', 'pixels', 'common'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractGeoProps(geoData) {
  const feat = geoData?.features?.[0];
  return feat?.properties ? Object.keys(feat.properties) : [];
}

function extractPropValues(geoData, prop) {
  const seen = new Set();
  for (const f of geoData?.features ?? []) {
    const v = f.properties?.[prop];
    if (v !== null && v !== undefined) seen.add(String(v));
    if (seen.size >= 200) break;
  }
  return [...seen].sort();
}

/** Compute { min, max } for a numeric geo property. Returns null if non-numeric. */
function extractPropRange(geoData, prop) {
  if (!geoData?.features?.length || !prop) return null;
  let min = Infinity, max = -Infinity, count = 0;
  for (const f of geoData.features) {
    const v = parseFloat(f.properties?.[prop]);
    if (!isNaN(v)) { if (v < min) min = v; if (v > max) max = v; count++; }
  }
  return count > 0 ? { min, max } : null;
}

/** Compute { min, max } for a numeric column in a static data index (Map<key → row>). */
function extractDataColumnRange(dataIndex, column) {
  if (!dataIndex || !column) return null;
  let min = Infinity, max = -Infinity, count = 0;
  for (const entry of dataIndex.values()) {
    if (typeof entry !== 'object' || entry === null) return null; // timeseries
    const v = parseFloat(entry[column]);
    if (!isNaN(v)) { if (v < min) min = v; if (v > max) max = v; count++; }
  }
  return count > 0 ? { min, max } : null;
}

/**
 * Extract unique string values for a specific column from a dataIndex Map.
 * Works only for static datasets (values are row objects).
 * Returns [] for timeseries data (values are numbers).
 */
function extractDatasetColumnValues(dataIndex, column) {
  if (!dataIndex || !column) return [];
  const seen = new Set();
  for (const entry of dataIndex.values()) {
    if (typeof entry !== 'object' || entry === null) return []; // timeseries — bail out
    const v = entry[column];
    if (v !== null && v !== undefined) seen.add(String(v));
    if (seen.size >= 200) break;
  }
  return [...seen].sort();
}

// ── Palette persistence ───────────────────────────────────────────────────────

const PALETTES_KEY = 'meridian_palettes';

function readPalettes() {
  try { return JSON.parse(localStorage.getItem(PALETTES_KEY) ?? '{}'); } catch { return {}; }
}
function writePalette(name, colors) {
  const existing = readPalettes();
  localStorage.setItem(PALETTES_KEY, JSON.stringify({ ...existing, [name]: colors }));
}
function deletePaletteByName(name) {
  const existing = readPalettes();
  const { [name]: _, ...rest } = existing;
  localStorage.setItem(PALETTES_KEY, JSON.stringify(rest));
}

// ── Painting persistence (server-backed) ─────────────────────────────────────
// Paintings are stored in the database via /api/layers/{id}/paintings.
// Each painting has a server-assigned `id` used for update/delete.

// ── Tooltip descriptions ──────────────────────────────────────────────────────

const TIPS = {
  opacity: 'Layer transparency. 0 = fully transparent, 1 = fully opaque.',
  pickable: 'Allow features to be selected/hovered for tooltips and click events.',
  autoHighlight: 'Highlight features on mouse hover.',
  filled: 'Fill polygon/point interiors with color.',
  stroked: 'Draw outlines around polygons and points.',
  radiusScale: 'Multiplier applied to all point radii. Useful for global sizing adjustments.',
  radiusMinPixels: 'Minimum rendered size in screen pixels, regardless of zoom level.',
  radiusMaxPixels: 'Maximum rendered size in screen pixels, regardless of zoom level.',
  radiusUnits: 'Unit system for radius values. "meters" scales with zoom; "pixels" is fixed on screen.',
  lineWidthScale: 'Multiplier applied to all line widths.',
  lineWidthMinPixels: 'Minimum line width in screen pixels.',
  lineWidthMaxPixels: 'Maximum line width in screen pixels.',
  lineWidthUnits: 'Unit system for line width values.',
  staticFillColor: 'Default fill color when no dataset or geometry mapping overrides it.',
  staticLineColor: 'Default outline/line color when no mapping overrides it.',
  staticRadius: 'Default point radius when no dataset mapping drives it.',
  staticLineWidth: 'Default line width when no mapping drives it.',
  scaleType: 'How raw values are mapped to visual output. "linear" = proportional, "log" = logarithmic (good for wide ranges), "categorical" = discrete color per value.',
  colormap: 'Color ramp used to visualize continuous numeric values.',
  domainMin: 'Minimum data value for normalization. Values below this are clamped.',
  domainMax: 'Maximum data value for normalization. Values above this are clamped.',
  visualProperty: 'The deck.gl accessor this mapping drives (e.g. fill color, point radius).',
  datasetColumn: 'The dataset column whose values drive this visual property.',
  featureProperty: 'The GeoJSON feature property whose values drive this visual property.',
  filterProperty: 'GeoJSON feature property to filter on. Only features matching selected categories are shown.',
  filterCategories: 'Which category values to include. Unchecked values are hidden.',
  painting: 'Named snapshots of your entire style configuration. Save, switch, and compare different looks.',
  colorScaleMode: 'How the color domain is chosen. "Global" keeps a fixed scale across the whole time range, so the map stays comparable frame-to-frame and brightens as values grow (best for animation and for controls that scale values uniformly). "Per-year" re-fits the scale to the currently loaded data, maximizing contrast within a single frame.',
};

// ── Sub-components ────────────────────────────────────────────────────────────
// (InfoTip + SectionHeader live in components/primitives/ now.)

function RgbaColorInput({ label, value, onChange }) {
  const [r, g, b, a] = value ?? [100, 149, 237, 180];
  return (
    <Box>
      {label && <Typography variant="caption" color="text.secondary">{label}</Typography>}
      <Stack direction="row" spacing={1} alignItems="center">
        <input type="color" value={rgbToHex(r, g, b)}
          onChange={e => { const [nr,ng,nb] = hexToRgb(e.target.value); onChange([nr,ng,nb,a]); }}
          style={{ width: 36, height: 32, border: 'none', padding: 0, cursor: 'pointer', borderRadius: 4 }} />
        <Typography variant="caption" sx={{ minWidth: 32 }}>Alpha</Typography>
        <CommittedSlider size="small" value={a} min={0} max={255} step={1}
          onChange={(_, v) => onChange([r, g, b, v])} sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ minWidth: 24, textAlign: 'right' }}>{a}</Typography>
      </Stack>
    </Box>
  );
}

/** Editor for categorical (value → RGBA) mappings with palette save/load. */
function CategoryColorsEditor({ values, colors, onChange, onAskAI }) {
  const [palettes, setPalettes] = useState(readPalettes);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const { getColor, setColors: setSharedColors } = useCategoryColors();

  // Ensure every value has a color assigned — pull from shared context first.
  const effectiveColors = useMemo(() => {
    const out = { ...colors };
    values.forEach((v) => { if (!out[v]) out[v] = getColor(v); });
    return out;
  }, [colors, values, getColor]);

  if (values.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        No values found — make sure geometry/data is loaded.
      </Typography>
    );
  }

  const paletteNames = Object.keys(palettes);

  function handleLoadPalette(name) {
    const palette = palettes[name] ?? {};
    const merged = { ...effectiveColors };
    Object.keys(merged).forEach(k => { if (palette[k]) merged[k] = palette[k]; });
    onChange(merged);
    setSharedColors(merged);
  }

  function handleSavePalette() {
    if (!saveName.trim()) return;
    writePalette(saveName.trim(), effectiveColors);
    setPalettes(readPalettes());
    setSaveName('');
    setShowSave(false);
  }

  function handleDeletePalette(name) {
    deletePaletteByName(name);
    setPalettes(readPalettes());
  }

  return (
    <Box>
      {/* Palette controls */}
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} alignItems="center" flexWrap="wrap">
        {paletteNames.length > 0 && (
          <FormControl size="small" sx={{ minWidth: 130 }}>
            <InputLabel>Load Palette</InputLabel>
            <Select value="" label="Load Palette" onChange={e => handleLoadPalette(e.target.value)}>
              {paletteNames.map(n => (
                <MenuItem key={n} value={n}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ width: '100%' }}>
                    <span>{n}</span>
                    <IconButton size="small" onMouseDown={e => { e.stopPropagation(); handleDeletePalette(n); }}>
                      <DeleteIcon fontSize="inherit" />
                    </IconButton>
                  </Stack>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        <Button size="small" variant="text" onClick={() => setShowSave(s => !s)}>
          {showSave ? 'Cancel' : 'Save'}
        </Button>
        {onAskAI && values.length > 0 && (
          <Tooltip title="Ask AI to generate a palette for these categories">
            <IconButton
              size="small"
              color="primary"
              onClick={() => {
                const catList = values.map(c => `  - "${c}"`).join("\n");
                const prompt = [
                  "Generate a visually appealing color palette for these categories using the set_category_colors tool.",
                  "Group related categories with similar hues but keep them distinguishable.",
                  "Use the EXACT category names as keys (including any special characters).",
                  "Give the palette a descriptive name.\n",
                  `There are ${values.length} categories:\n${catList}`,
                ].join("\n");
                onAskAI(prompt);
              }}
            >
              <PsychologyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {showSave && (
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          <TextField size="small" label="Palette name" value={saveName}
            onChange={e => setSaveName(e.target.value)} sx={{ flex: 1 }} />
          <Button size="small" variant="contained" disabled={!saveName.trim()} onClick={handleSavePalette}>
            Save
          </Button>
        </Stack>
      )}

      {/* Value → color rows */}
      <Stack spacing={0.75}>
        {values.map((v, i) => {
          const [r, g, b, a] = effectiveColors[v] ?? CATEGORY10[i % CATEGORY10.length];
          return (
            <Stack key={v} direction="row" spacing={1} alignItems="center">
              <input type="color" value={rgbToHex(r, g, b)}
                onChange={e => {
                  const [nr,ng,nb] = hexToRgb(e.target.value);
                  const newColor = [nr, ng, nb, a];
                  onChange({ ...effectiveColors, [v]: newColor });
                  setSharedColors({ [v]: newColor });
                }}
                style={{ width: 28, height: 28, border: 'none', padding: 0, cursor: 'pointer', borderRadius: 4 }} />
              <Typography variant="caption" sx={{ flex: 1 }}>{v}</Typography>
              <CommittedSlider size="small" value={a} min={0} max={255} step={1}
                onChange={(_, newA) => {
                  const newColor = [r, g, b, newA];
                  onChange({ ...effectiveColors, [v]: newColor });
                  setSharedColors({ [v]: newColor });
                }}
                sx={{ width: 60 }} />
            </Stack>
          );
        })}
      </Stack>
    </Box>
  );
}

/**
 * Controls for colormap, scale type, and domain — used by both dataset and geo mappings.
 * When isColor && scaleType === 'categorical', shows CategoryColorsEditor instead.
 */
function MappingStyleControls({
  isColor, colormap, scaleType, domainMin, domainMax,
  categoryColors, categoryValues,
  categoryMapId, aggregationMode, categoryMaps,
  datasetRange,  // { min, max } from dataset metadata — used for display + defaults
  onChange,
  onAskAI,
}) {
  const availableScaleTypes = isColor ? COLOR_SCALE_TYPES : SCALE_TYPES;
  const isCategorical = isColor && scaleType === 'categorical';

  function handleScaleTypeChange(newStype) {
    if (newStype === 'categorical' && isColor) {
      // Auto-assign colors on first switch to categorical
      const existing = categoryColors ?? {};
      const hasAssignments = Object.keys(existing).length > 0;
      if (!hasAssignments && categoryValues.length > 0) {
        onChange({ scale_type: 'categorical', colormap: null, categoryColors: autoAssignColors(categoryValues) });
      } else {
        onChange({ scale_type: 'categorical', colormap: null });
      }
    } else {
      onChange({ scale_type: newStype });
    }
  }

  const hasRange = datasetRange && datasetRange.min != null && datasetRange.max != null;

  return (
    <Stack spacing={1} sx={{ mt: 0.5 }}>
      <Stack direction="row" alignItems="center">
        <FormControl size="small" fullWidth>
          <InputLabel>Scale Type</InputLabel>
          <Select value={scaleType ?? 'linear'} label="Scale Type"
            onChange={e => handleScaleTypeChange(e.target.value)}>
            {availableScaleTypes.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </Select>
        </FormControl>
        <InfoTip tip={TIPS.scaleType} />
      </Stack>

      {isCategorical ? (
        <>
          {categoryMaps && categoryMaps.length > 0 && (
            <FormControl size="small" fullWidth>
              <InputLabel>Category Map</InputLabel>
              <Select
                value={categoryMapId ?? ''}
                label="Category Map"
                onChange={e => onChange({
                  category_map_id: e.target.value || null,
                })}
              >
                <MenuItem value=""><em>None (manual)</em></MenuItem>
                {categoryMaps.map(cm => (
                  <MenuItem key={cm.id} value={cm.id}>
                    {cm.display_name || cm.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          {categoryMapId && (
            <FormControl size="small" fullWidth>
              <InputLabel>Aggregation</InputLabel>
              <Select
                value={aggregationMode ?? 'sum'}
                label="Aggregation"
                onChange={e => onChange({ aggregation_mode: e.target.value })}
              >
                <MenuItem value="sum">Sum</MenuItem>
                <MenuItem value="mean">Mean</MenuItem>
                <MenuItem value="max">Max</MenuItem>
              </Select>
            </FormControl>
          )}
          {categoryValues.length > 0 ? (
            <CategoryColorsEditor
              values={categoryValues}
              colors={categoryColors ?? {}}
              onChange={cc => onChange({ categoryColors: cc })}
              onAskAI={onAskAI}
            />
          ) : (
            <Typography variant="caption" color="text.secondary">
              No values found for this property — load geometry/data first.
            </Typography>
          )}
        </>
      ) : (
        <>
          {isColor && (
            <Stack direction="row" alignItems="center">
              <FormControl size="small" fullWidth>
                <InputLabel>Colormap</InputLabel>
                <Select value={colormap ?? 'viridis'} label="Colormap"
                  onChange={e => onChange({ colormap: e.target.value })}>
                  {COLORMAPS.map(c => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                </Select>
              </FormControl>
              <InfoTip tip={TIPS.colormap} />
            </Stack>
          )}
          {hasRange && (
            <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
              Dataset range: <strong>{datasetRange.min.toFixed(2)}</strong> — <strong>{datasetRange.max.toFixed(2)}</strong>
            </Typography>
          )}
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField label="Domain Min" type="number" size="small" value={domainMin ?? 0}
              onChange={e => onChange({ domain_min: parseFloat(e.target.value) || 0 })} sx={{ flex: 1 }} />
            <TextField label="Domain Max" type="number" size="small" value={domainMax ?? 1}
              onChange={e => onChange({ domain_max: parseFloat(e.target.value) || 1 })} sx={{ flex: 1 }} />
            <InfoTip tip={TIPS.domainMin} />
          </Stack>
          {hasRange && (
            <Button size="small" variant="text"
              onClick={() => onChange({ domain_min: datasetRange.min, domain_max: datasetRange.max })}>
              Reset to dataset range
            </Button>
          )}
        </>
      )}
    </Stack>
  );
}

// ── Form defaults ─────────────────────────────────────────────────────────────

const DEFAULT_NEW_DATASET_MAPPING = {
  visual_property: 'getFillColor', column: '',
  colormap: 'viridis', scale_type: 'linear', domain_min: 0, domain_max: 1,
};
const DEFAULT_NEW_GEO_MAPPING = {
  visual_property: 'getFillColor', property: '',
  colormap: 'viridis', scale_type: 'linear', domain_min: 0, domain_max: 1,
};

// ── Main component ────────────────────────────────────────────────────────────

export default function GenericLayerStyler({
  layerConfig,
  geoData,
  layerData,            // Map<joinKey → row|number> from genericLayerData[layerId]
  localStyle,
  onLocalStyleChange,
  onStyleMappingsChange,
  onAskAI,
  onPopoutLegend,
}) {
  const [tab, setTab] = useState(0);
  const [datasetColumns, setDatasetColumns] = useState([]);
  const [newDatasetMapping, setNewDatasetMapping] = useState(DEFAULT_NEW_DATASET_MAPPING);
  const [newGeoMapping, setNewGeoMapping] = useState(DEFAULT_NEW_GEO_MAPPING);
  const [showAddDataset, setShowAddDataset] = useState(false);
  const [showAddGeo, setShowAddGeo] = useState(false);
  const [paintingName, setPaintingName] = useState('');
  const [paintings, setPaintings] = useState([]);
  const [editingIdx, setEditingIdx] = useState(null);
  const [categoryMaps, setCategoryMaps] = useState([]);
  const [collapsedMappings, setCollapsedMappings] = useState({});  // { mappingKey → boolean }
  const setPopoutLegend = onPopoutLegend ?? (() => {});

  // Load category maps on mount
  useEffect(() => {
    fetchCategoryMaps()
      .then(setCategoryMaps)
      .catch(e => logger.error('[GenericLayerStyler] fetchCategoryMaps failed:', e));
  }, []);

  // Load paintings from server on mount / layer change
  useEffect(() => {
    logger.debug('[paintings] fetching for layer', layerConfig.id);
    fetchPaintings(layerConfig.id)
      .then(data => {
        logger.info('[paintings] loaded', data.length, 'painting(s) for layer', layerConfig.id, data);
        setPaintings(data);
      })
      .catch(e => logger.error('[paintings] fetchPaintings failed for layer', layerConfig.id, e));
  }, [layerConfig.id]);
  const [editName, setEditName] = useState('');

  const layerDataset   = layerConfig.layer_datasets?.[0];
  const layerDatasetId = layerDataset?.id;
  const layerType      = layerConfig.deck_layer_type;
  const isTimeseries   = !!layerDataset?.dataset?.timestamp_col;
  const datasetRange   = useMemo(() => {
    const ds = layerDataset?.dataset;
    if (ds?.value_min != null && ds?.value_max != null) return { min: ds.value_min, max: ds.value_max };
    return null;
  }, [layerDataset?.dataset]);

  useEffect(() => {
    if (!layerDataset?.dataset?.id || isTimeseries) return; // skip for timeseries datasets
    fetchDatasetColumns(layerDataset.dataset.id)
      .then(setDatasetColumns)
      .catch(e => console.warn('[GenericLayerStyler] fetchDatasetColumns failed:', e));
  }, [layerDataset?.dataset?.id, isTimeseries]);

  const geoProps = useMemo(() => extractGeoProps(geoData), [geoData]);

  const filterPropValues = useMemo(() => {
    if (!localStyle.filterProperty || !geoData) return [];
    return extractPropValues(geoData, localStyle.filterProperty);
  }, [geoData, localStyle.filterProperty]);

  useEffect(() => {
    if (!localStyle.filterProperty) return;
    onLocalStyleChange({ ...localStyle, filterAllCategories: filterPropValues, filterCategories: filterPropValues });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localStyle.filterProperty]);

  const overrides    = localStyle.mappingOverrides ?? {};
  const geoMappings  = localStyle.geoMappings ?? {};

  function update(updates) { onLocalStyleChange({ ...localStyle, ...updates }); }

  // ── Color scale mode (global-across-time vs per-year) ─────────────────────
  // 'global' keeps each numeric color mapping's declared domain fixed across
  // the whole time range so the map stays comparable frame-to-frame (and
  // responds to control changes that scale values uniformly); 'per-year'
  // re-fits the domain to whatever data is currently loaded. autoRescaleColormap
  // (in useScenarioLayerSync) reads this same flag on every dataset fetch.
  const colorScaleMode = localStyle.colorScaleMode
    ?? layerConfig.default_style?.colorScaleMode
    ?? 'per-year';

  const numericColorMappings = useMemo(
    () => (layerConfig.style_mappings ?? []).filter(
      (m) => VISUAL_PROP_MAP[m.visual_property]?.isColor
        && (overrides[m.id]?.scale_type ?? m.scale_type ?? 'linear') !== 'categorical',
    ),
    [layerConfig.style_mappings, overrides],
  );

  function setColorScaleMode(mode) {
    // Also move the current overrides so the switch is visible immediately:
    // per-year pins to the loaded frame's range, global reverts to the
    // declared domain. Subsequent fetches keep it consistent via autoRescale.
    const nextOverrides = { ...overrides };
    for (const m of numericColorMappings) {
      const cur = nextOverrides[m.id] ?? {};
      if (mode === 'per-year') {
        const range = extractDataColumnRange(layerData, m.column);
        if (range) nextOverrides[m.id] = { ...cur, domain_min: range.min, domain_max: range.max };
      } else {
        nextOverrides[m.id] = { ...cur, domain_min: m.domain_min, domain_max: m.domain_max };
      }
    }
    onLocalStyleChange({ ...localStyle, colorScaleMode: mode, mappingOverrides: nextOverrides });
  }

  function updateMappingOverride(mappingId, updates) {
    // Persist server-side fields via PATCH
    const serverFields = {};
    for (const k of ['category_map_id', 'aggregation_mode']) {
      if (k in updates) serverFields[k] = updates[k];
    }
    if (Object.keys(serverFields).length > 0) {
      updateStyleMapping(layerConfig.id, mappingId, serverFields)
        .catch(e => logger.error('[GenericLayerStyler] updateStyleMapping failed:', e));
    }
    onLocalStyleChange({
      ...localStyle,
      mappingOverrides: { ...overrides, [mappingId]: { ...(overrides[mappingId] ?? {}), ...updates } },
    });
  }

  function updateGeoMapping(vp, updates) {
    onLocalStyleChange({
      ...localStyle,
      geoMappings: { ...geoMappings, [vp]: { ...(geoMappings[vp] ?? {}), ...updates } },
    });
  }

  function removeGeoMapping(vp) {
    const { [vp]: _, ...rest } = geoMappings;
    onLocalStyleChange({ ...localStyle, geoMappings: rest });
  }

  async function handleAddDatasetMapping() {
    const effectiveColumn = isTimeseries ? '__timeseries__' : newDatasetMapping.column;
    if (!layerDatasetId || (!isTimeseries && !newDatasetMapping.column)) return;
    const isColor = VISUAL_PROP_MAP[newDatasetMapping.visual_property]?.isColor;
    const isCat   = isColor && newDatasetMapping.scale_type === 'categorical';
    const payload = {
      layer_dataset_id: layerDatasetId,
      visual_property:  newDatasetMapping.visual_property,
      column:           effectiveColumn,
      scale_type:       newDatasetMapping.scale_type,
      domain_min:       newDatasetMapping.domain_min,
      domain_max:       newDatasetMapping.domain_max,
      colormap:         (!isCat && isColor) ? newDatasetMapping.colormap : null,
    };
    try {
      const result  = await addStyleMapping(layerConfig.id, payload);
      const created = { id: result.id, ...payload };
      onStyleMappingsChange([...(layerConfig.style_mappings ?? []), created]);
      // Persist categoryColors in localStyle overrides (not in the DB)
      if (isCat && newDatasetMapping.categoryColors) {
        updateMappingOverride(result.id, { categoryColors: newDatasetMapping.categoryColors });
      }
      // Auto-collapse the new mapping card
      setCollapsedMappings(p => ({ ...p, [`ds-${result.id}`]: true }));
      setNewDatasetMapping(DEFAULT_NEW_DATASET_MAPPING);
      setShowAddDataset(false);
    } catch (e) {
      console.error('[GenericLayerStyler] addStyleMapping failed:', e);
    }
  }

  async function handleDeleteDatasetMapping(mappingId) {
    try {
      await deleteStyleMapping(layerConfig.id, mappingId);
      onStyleMappingsChange((layerConfig.style_mappings ?? []).filter(m => m.id !== mappingId));
    } catch (e) {
      console.error('[GenericLayerStyler] deleteStyleMapping failed:', e);
    }
  }

  function handleAddGeoMapping() {
    if (!newGeoMapping.property) return;
    const isColor = VISUAL_PROP_MAP[newGeoMapping.visual_property]?.isColor;
    const isCat   = isColor && newGeoMapping.scale_type === 'categorical';
    updateGeoMapping(newGeoMapping.visual_property, {
      property:       newGeoMapping.property,
      colormap:       (!isCat && isColor) ? newGeoMapping.colormap : null,
      scale_type:     newGeoMapping.scale_type,
      domain_min:     newGeoMapping.domain_min,
      domain_max:     newGeoMapping.domain_max,
      categoryColors: isCat ? (newGeoMapping.categoryColors ?? {}) : undefined,
    });
    // Auto-collapse the new mapping card
    setCollapsedMappings(p => ({ ...p, [`geo-${newGeoMapping.visual_property}`]: true }));
    setNewGeoMapping(DEFAULT_NEW_GEO_MAPPING);
    setShowAddGeo(false);
  }

  function handleSavePainting() {
    if (!paintingName.trim()) return;
    const name = paintingName.trim();
    const style = { ...localStyle };
    logger.info('[paintings] saving new painting', { layerId: layerConfig.id, name, style });
    createPainting(layerConfig.id, name, style)
      .then(saved => {
        logger.info('[paintings] server confirmed save', saved);
        logger.debug('[paintings] local paintings list after save', [...paintings, saved]);
        setPaintings(prev => [...prev, saved]);
        setPaintingName('');
      })
      .catch(e => logger.error('[paintings] createPainting failed', e));
  }

  function handleApplyPainting(p) {
    logger.info('[paintings] applying painting', { id: p.id, name: p.name, style: p.style });
    onLocalStyleChange({ ...p.style });
  }

  // Mark (or unmark) a painting as the layer's default — it auto-applies on
  // reload. Exactly one default per layer; the server clears the others.
  async function handleSetDefaultPainting(p) {
    try {
      await updatePainting(p.id, { is_default: !p.is_default });
      const fresh = await fetchPaintings(layerConfig.id);
      setPaintings(fresh);
    } catch (e) {
      logger.error('[paintings] set default failed', e);
    }
  }

  function handleUpdatePainting(idx) {
    const p = paintings[idx];
    if (!p?.id) return;
    const style = { ...localStyle };
    logger.info('[paintings] overwriting painting', { id: p.id, name: p.name, style });
    updatePainting(p.id, { style })
      .then(updated => {
        logger.info('[paintings] server confirmed update', updated);
        setPaintings(prev => prev.map((item, i) => i === idx ? updated : item));
      })
      .catch(e => logger.error('[paintings] updatePainting failed', { id: p.id }, e));
  }

  function handleDeletePainting(idx) {
    const p = paintings[idx];
    if (!p?.id) return;
    logger.info('[paintings] deleting painting', { id: p.id, name: p.name });
    deletePainting(p.id)
      .then(() => {
        logger.info('[paintings] deleted painting id', p.id);
        setPaintings(prev => prev.filter((_, i) => i !== idx));
      })
      .catch(e => logger.error('[paintings] deletePainting failed', { id: p.id }, e));
  }

  function handleRenamePainting(idx, newName) {
    if (!newName.trim()) { setEditingIdx(null); return; }
    const p = paintings[idx];
    if (!p?.id) return;
    logger.info('[paintings] renaming painting', { id: p.id, from: p.name, to: newName.trim() });
    updatePainting(p.id, { name: newName.trim() })
      .then(updated => {
        logger.info('[paintings] server confirmed rename', updated);
        setPaintings(prev => prev.map((item, i) => i === idx ? updated : item));
        setEditingIdx(null);
      })
      .catch(e => logger.error('[paintings] renamePainting failed', { id: p.id }, e));
  }

  // ── Tab 0: Style ────────────────────────────────────────────────────────────
  const styleTab = (
    <Box sx={{ px: 1 }}>
      <SectionHeader>General</SectionHeader>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
        <Stack direction="row" alignItems="center" sx={{ minWidth: 72 }}>
          <Typography variant="caption">Opacity</Typography>
          <InfoTip tip={TIPS.opacity} />
        </Stack>
        <CommittedSlider size="small" value={localStyle.opacity ?? 0.8} min={0} max={1} step={0.01}
          onChange={(_, v) => update({ opacity: v })} sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ minWidth: 30, textAlign: 'right' }}>
          {(localStyle.opacity ?? 0.8).toFixed(2)}
        </Typography>
      </Stack>
      <FormControl component="fieldset" variant="standard" sx={{ mb: 1 }}>
        <FormGroup row>
          {[['pickable','Pickable'],['autoHighlight','Auto-Highlight'],['filled','Filled'],['stroked','Stroked']].map(([k, lbl]) => (
            <FormControlLabel key={k}
              control={<Switch size="small" checked={localStyle[k] ?? true}
                onChange={e => update({ [k]: e.target.checked })} />}
              label={<Stack direction="row" alignItems="center"><Typography variant="caption">{lbl}</Typography><InfoTip tip={TIPS[k]} /></Stack>} />
          ))}
        </FormGroup>
      </FormControl>

      <SectionHeader>Point Sizing</SectionHeader>
      {/* Slider range adapts to radiusUnits: pixels need fine sub-1
          granularity (0.001 step) because per-feature value × scale lands
          directly in pixels; meters need a much wider range (up to 100×)
          since at typical world zooms a meter is well below a pixel. */}
      {(() => {
        // Fallback matches the layer factory's default in layer_generators.js;
        // GAT renewable/thermal layers set radiusUnits explicitly, so this
        // fallback only kicks in for legacy localStyle without a units key.
        const isPixels = (localStyle.radiusUnits ?? 'meters') === 'pixels';
        const sliderCfg = isPixels
          ? { min: 0.001, max: 0.5,  step: 0.001, defaultValue: 0.05, format: (v) => v.toFixed(3) }
          : { min: 0.1,   max: 100,  step: 0.5,   defaultValue: 1,    format: (v) => v.toFixed(1) };
        const cur = localStyle.radiusScale ?? sliderCfg.defaultValue;
        return (
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
            <Stack direction="row" alignItems="center" sx={{ minWidth: 72 }}>
              <Typography variant="caption">Scale</Typography>
              <InfoTip tip={TIPS.radiusScale} />
            </Stack>
            <CommittedSlider size="small" value={cur}
              min={sliderCfg.min} max={sliderCfg.max} step={sliderCfg.step}
              onChange={(_, v) => update({ radiusScale: v })} sx={{ flex: 1 }} />
            <Typography variant="caption" sx={{ minWidth: 50, textAlign: 'right' }}>
              {sliderCfg.format(cur)}×
            </Typography>
          </Stack>
        );
      })()}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Tooltip title={TIPS.radiusMinPixels} placement="top" arrow>
          <TextField label="Min Pixels" type="number" size="small"
            value={localStyle.radiusMinPixels ?? 0}
            onChange={e => update({ radiusMinPixels: parseInt(e.target.value) || 0 })} sx={{ flex: 1 }} />
        </Tooltip>
        <Tooltip title={TIPS.radiusMaxPixels} placement="top" arrow>
          <TextField label="Max Pixels" type="number" size="small"
            value={localStyle.radiusMaxPixels ?? 100}
            onChange={e => update({ radiusMaxPixels: parseInt(e.target.value) || 100 })} sx={{ flex: 1 }} />
        </Tooltip>
      </Stack>
      <FormControl component="fieldset">
        <Stack direction="row" alignItems="center">
          <FormLabel><Typography variant="caption">Units</Typography></FormLabel>
          <InfoTip tip={TIPS.radiusUnits} />
        </Stack>
        <RadioGroup row value={localStyle.radiusUnits ?? 'meters'}
          onChange={e => {
            const next = e.target.value;
            // Reset radiusScale to the unit's sane default on unit switch —
            // a value tuned for meters (1.0×) is wildly oversized in pixels,
            // and vice versa. Saves the user a guaranteed slider reach.
            const unitDefault = next === 'pixels' ? 0.05 : 1.0;
            update({ radiusUnits: next, radiusScale: unitDefault });
          }}>
          {UNITS.map(u => (
            <FormControlLabel key={u} value={u} control={<Radio size="small" />}
              label={<Typography variant="caption">{u}</Typography>} />
          ))}
        </RadioGroup>
      </FormControl>

      {layerType !== 'ScatterplotLayer' && (<>
        <SectionHeader>Line Sizing</SectionHeader>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
          <Stack direction="row" alignItems="center" sx={{ minWidth: 72 }}>
            <Typography variant="caption">Scale</Typography>
            <InfoTip tip={TIPS.lineWidthScale} />
          </Stack>
          <CommittedSlider size="small" value={localStyle.lineWidthScale ?? 1} min={0.1} max={20} step={0.1}
            onChange={(_, v) => update({ lineWidthScale: v })} sx={{ flex: 1 }} />
          <Typography variant="caption" sx={{ minWidth: 34, textAlign: 'right' }}>
            {(localStyle.lineWidthScale ?? 1).toFixed(1)}×
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Tooltip title={TIPS.lineWidthMinPixels} placement="top" arrow>
            <TextField label="Min Pixels" type="number" size="small"
              value={localStyle.lineWidthMinPixels ?? 0}
              onChange={e => update({ lineWidthMinPixels: parseInt(e.target.value) || 0 })} sx={{ flex: 1 }} />
          </Tooltip>
          <Tooltip title={TIPS.lineWidthMaxPixels} placement="top" arrow>
            <TextField label="Max Pixels" type="number" size="small"
              value={localStyle.lineWidthMaxPixels ?? 20}
              onChange={e => update({ lineWidthMaxPixels: parseInt(e.target.value) || 20 })} sx={{ flex: 1 }} />
          </Tooltip>
        </Stack>
        <FormControl component="fieldset">
          <Stack direction="row" alignItems="center">
            <FormLabel><Typography variant="caption">Units</Typography></FormLabel>
            <InfoTip tip={TIPS.lineWidthUnits} />
          </Stack>
          <RadioGroup row value={localStyle.lineWidthUnits ?? 'pixels'}
            onChange={e => update({ lineWidthUnits: e.target.value })}>
            {UNITS.map(u => (
              <FormControlLabel key={u} value={u} control={<Radio size="small" />}
                label={<Typography variant="caption">{u}</Typography>} />
            ))}
          </RadioGroup>
        </FormControl>
      </>)}

      {layerType === 'TransmissionLayer' && (<>
        <SectionHeader>Low-usage color</SectionHeader>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Color of idle / barely-loaded lines. Steel blue keeps them distinct
          from grey basemap streets; dim grey is the classic look.
        </Typography>
        <RadioGroup row value={localStyle.lowUsageColor ?? 'steel'}
          onChange={e => update({ lowUsageColor: e.target.value })}>
          <FormControlLabel value="steel" control={<Radio size="small" />}
            label={<Typography variant="caption">Steel blue</Typography>} />
          <FormControlLabel value="grey" control={<Radio size="small" />}
            label={<Typography variant="caption">Dim grey</Typography>} />
        </RadioGroup>
      </>)}

      {numericColorMappings.length > 0 && (
        <>
          <SectionHeader>Color Scale</SectionHeader>
          <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              How the color domain is chosen across time steps.
            </Typography>
            <InfoTip tip={TIPS.colorScaleMode} />
          </Stack>
          <RadioGroup
            value={colorScaleMode}
            onChange={(e) => setColorScaleMode(e.target.value)}
          >
            <FormControlLabel value="global" control={<Radio size="small" />}
              label={<Typography variant="caption">Global — fixed across the whole time range</Typography>} />
            <FormControlLabel value="per-year" control={<Radio size="small" />}
              label={<Typography variant="caption">Per-year — re-fit to the current frame</Typography>} />
          </RadioGroup>
        </>
      )}

      {layerConfig.geometry?.is_spatial && (
        <>
          <SectionHeader>Data Loading</SectionHeader>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            {layerConfig.geometry?.feature_count != null
              ? `${layerConfig.geometry.feature_count.toLocaleString()} features.`
              : ''} How much of this spatial layer to load.
          </Typography>
          <RadioGroup
            value={(localStyle.spatialLoadAll ?? layerConfig.default_style?.spatialLoadAll ?? true) ? 'all' : 'viewport'}
            onChange={(e) => update({ spatialLoadAll: e.target.value === 'all' })}
          >
            <FormControlLabel value="all" control={<Radio size="small" />}
              label={<Typography variant="caption">Whole dataset (heavier, no viewport filtering)</Typography>} />
            <FormControlLabel value="viewport" control={<Radio size="small" />}
              label={<Typography variant="caption">Current viewport only (streams as you pan/zoom)</Typography>} />
          </RadioGroup>
        </>
      )}

      <SectionHeader>Default Colors &amp; Sizes</SectionHeader>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Used when no mapping is configured for a property.
      </Typography>
      <Stack spacing={1.5}>
        <RgbaColorInput label={<>Fill Color <InfoTip tip={TIPS.staticFillColor} /></>}
          value={localStyle.staticFillColor ?? [100, 149, 237, 180]}
          onChange={v => update({ staticFillColor: v })} />
        <RgbaColorInput label={<>Line Color <InfoTip tip={TIPS.staticLineColor} /></>}
          value={localStyle.staticLineColor ?? [0, 0, 0, 120]}
          onChange={v => update({ staticLineColor: v })} />
        <Stack direction="row" spacing={1}>
          <Tooltip title={TIPS.staticRadius} placement="top" arrow>
            <TextField label="Point Radius" type="number" size="small"
              value={localStyle.staticRadius ?? 5}
              onChange={e => update({ staticRadius: parseFloat(e.target.value) || 5 })} sx={{ flex: 1 }} />
          </Tooltip>
          {layerType !== 'ScatterplotLayer' && (
            <Tooltip title={TIPS.staticLineWidth} placement="top" arrow>
              <TextField label="Line Width" type="number" size="small"
                value={localStyle.staticLineWidth ?? 1}
                onChange={e => update({ staticLineWidth: parseFloat(e.target.value) || 1 })} sx={{ flex: 1 }} />
            </Tooltip>
          )}
        </Stack>
      </Stack>
    </Box>
  );

  // ── Tab 1: Mappings ─────────────────────────────────────────────────────────
  const mappingsTab = (
    <Box sx={{ px: 1 }}>
      <SectionHeader>Dataset Mappings</SectionHeader>
      {(layerConfig.style_mappings ?? []).length === 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          No dataset mappings.
        </Typography>
      )}
      {(layerConfig.style_mappings ?? []).map(m => {
        const ovr     = overrides[m.id] ?? {};
        const isColor = VISUAL_PROP_MAP[m.visual_property]?.isColor;
        const stype   = ovr.scale_type ?? m.scale_type ?? 'linear';
        const catVals = (isColor && stype === 'categorical')
          ? extractDatasetColumnValues(layerData, m.column)
          : [];
        const colRange = extractDataColumnRange(layerData, m.column) ?? datasetRange;
        const dsKey = `ds-${m.id}`;
        const dsCollapsed = collapsedMappings[dsKey];
        return (
          <Paper key={m.id} variant="outlined" sx={{ p: 1, mb: 1 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flex: 1, cursor: 'pointer' }}
                onClick={() => setCollapsedMappings(p => ({ ...p, [dsKey]: !p[dsKey] }))}>
                {dsCollapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
                <Typography variant="body2" fontWeight="medium">
                  {VISUAL_PROP_MAP[m.visual_property]?.label ?? m.visual_property}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  ← {m.column === '__timeseries__'
                    ? `${layerDataset?.dataset?.name ?? 'timeseries'} (timeseries)`
                    : m.column}
                </Typography>
                <Chip label="dataset" size="small" color="primary" variant="outlined" />
              </Stack>
              <Stack direction="row" spacing={0}>
                {isColor && (
                  <Tooltip title="Pop out as map legend">
                    <IconButton size="small" onClick={() => setPopoutLegend({
                      layerId: layerConfig.id,
                      filterProperty: m.column,
                      label: m.column,
                      ...(stype === 'categorical'
                        ? { categoryColors: ovr.categoryColors ?? {}, categories: catVals }
                        : {
                            colormap: ovr.colormap ?? m.colormap ?? 'viridis',
                            domainMin: ovr.domain_min ?? m.domain_min ?? (colRange?.min ?? 0),
                            domainMax: ovr.domain_max ?? m.domain_max ?? (colRange?.max ?? 1),
                          }),
                    })}>
                      <OpenInNewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                <IconButton size="small" onClick={() => handleDeleteDatasetMapping(m.id)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Stack>
            </Stack>
            {!dsCollapsed && <MappingStyleControls
              isColor={isColor}
              colormap={ovr.colormap ?? m.colormap ?? 'viridis'}
              scaleType={stype}
              domainMin={ovr.domain_min ?? m.domain_min ?? (colRange?.min ?? 0)}
              domainMax={ovr.domain_max ?? m.domain_max ?? (colRange?.max ?? 1)}
              categoryColors={ovr.categoryColors}
              categoryValues={catVals}
              categoryMapId={m.category_map_id}
              onAskAI={onAskAI}
              aggregationMode={m.aggregation_mode}
              categoryMaps={categoryMaps}
              datasetRange={colRange}
              onChange={u => updateMappingOverride(m.id, u)}
            />}
          </Paper>
        );
      })}

      {layerDatasetId ? (
        showAddDataset ? (
          <Paper variant="outlined" sx={{ p: 1, mb: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>New Dataset Mapping</Typography>
            <Stack spacing={1.5}>
              <Stack direction="row" alignItems="center">
                <FormControl size="small" fullWidth>
                  <InputLabel>Visual Property</InputLabel>
                  <Select value={newDatasetMapping.visual_property} label="Visual Property"
                    onChange={e => setNewDatasetMapping(m => ({ ...m, visual_property: e.target.value }))}>
                    {VISUAL_PROPERTIES.map(p => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
                  </Select>
                </FormControl>
                <InfoTip tip={TIPS.visualProperty} />
              </Stack>
              {isTimeseries ? (
                <Typography variant="body2" sx={{ px: 1, py: 0.75, bgcolor: 'action.hover', borderRadius: 1 }}>
                  <strong>{layerDataset?.dataset?.name ?? 'Timeseries dataset'}</strong>: values are animated
                  per timestep and joined to features by entity ID (column names = entity IDs). No column
                  selection needed.
                </Typography>
              ) : (
                <FormControl size="small" fullWidth>
                  <InputLabel>Dataset Column</InputLabel>
                  <Select value={newDatasetMapping.column} label="Dataset Column"
                    onChange={e => {
                      const col = e.target.value;
                      const colRange = extractDataColumnRange(layerData, col);
                      setNewDatasetMapping(m => ({
                        ...m,
                        column: col,
                        domain_min: colRange?.min ?? m.domain_min,
                        domain_max: colRange?.max ?? m.domain_max,
                      }));
                    }}>
                    {datasetColumns.map(c => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                  </Select>
                </FormControl>
              )}
              <MappingStyleControls
                isColor={VISUAL_PROP_MAP[newDatasetMapping.visual_property]?.isColor}
                colormap={newDatasetMapping.colormap}
                scaleType={newDatasetMapping.scale_type}
                domainMin={newDatasetMapping.domain_min}
                domainMax={newDatasetMapping.domain_max}
                categoryColors={newDatasetMapping.categoryColors}
                categoryMapId={newDatasetMapping.category_map_id}
                aggregationMode={newDatasetMapping.aggregation_mode}
                onAskAI={onAskAI}
                categoryMaps={categoryMaps}
                datasetRange={newDatasetMapping.column ? (extractDataColumnRange(layerData, newDatasetMapping.column) ?? datasetRange) : datasetRange}
                categoryValues={
                  (VISUAL_PROP_MAP[newDatasetMapping.visual_property]?.isColor && newDatasetMapping.column)
                    ? extractDatasetColumnValues(layerData, newDatasetMapping.column)
                    : []
                }
                onChange={u => setNewDatasetMapping(m => ({ ...m, ...u }))}
              />
              <Stack direction="row" spacing={1}>
                <Button size="small" variant="contained" startIcon={<AddIcon />}
                  disabled={!isTimeseries && !newDatasetMapping.column} onClick={handleAddDatasetMapping}>Add</Button>
                <Button size="small" onClick={() => setShowAddDataset(false)}>Cancel</Button>
              </Stack>
            </Stack>
          </Paper>
        ) : (
          <Button size="small" variant="outlined" startIcon={<AddIcon />} fullWidth
            onClick={() => {
              setNewDatasetMapping({
                ...DEFAULT_NEW_DATASET_MAPPING,
                domain_min: datasetRange?.min ?? 0,
                domain_max: datasetRange?.max ?? 1,
              });
              setShowAddDataset(true);
            }} sx={{ mb: 2 }}>
            Add Dataset Mapping
          </Button>
        )
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Attach a dataset to enable dataset mappings.
        </Typography>
      )}

      <SectionHeader>Geometry Property Mappings</SectionHeader>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Drive visual properties from GeoJSON feature properties (local — not saved to database).
      </Typography>

      {Object.entries(geoMappings).map(([vp, gm]) => {
        const isColor = VISUAL_PROP_MAP[vp]?.isColor;
        const stype   = gm.scale_type ?? 'linear';
        const catVals = (isColor && stype === 'categorical' && gm.property)
          ? extractPropValues(geoData, gm.property)
          : [];
        const geoPropRange = gm.property ? extractPropRange(geoData, gm.property) : null;
        const geoKey = `geo-${vp}`;
        const geoCollapsed = collapsedMappings[geoKey];
        return (
          <Paper key={vp} variant="outlined" sx={{ p: 1, mb: 1 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flex: 1, cursor: 'pointer' }}
                onClick={() => setCollapsedMappings(p => ({ ...p, [geoKey]: !p[geoKey] }))}>
                {geoCollapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
                <Typography variant="body2" fontWeight="medium">
                  {VISUAL_PROP_MAP[vp]?.label ?? vp}
                </Typography>
                <Typography variant="caption" color="text.secondary">← {gm.property}</Typography>
                <Chip label="geometry" size="small" color="secondary" variant="outlined" />
              </Stack>
              <Stack direction="row" spacing={0}>
                {isColor && (
                  <Tooltip title="Pop out as map legend">
                    <IconButton size="small" onClick={() => setPopoutLegend({
                      layerId: layerConfig.id,
                      filterProperty: gm.property,
                      label: gm.property,
                      ...(stype === 'categorical'
                        ? { categoryColors: gm.categoryColors ?? {}, categories: catVals }
                        : {
                            colormap: gm.colormap ?? 'viridis',
                            domainMin: gm.domain_min ?? (geoPropRange?.min ?? 0),
                            domainMax: gm.domain_max ?? (geoPropRange?.max ?? 1),
                          }),
                    })}>
                      <OpenInNewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                <IconButton size="small" onClick={() => removeGeoMapping(vp)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Stack>
            </Stack>
            {!geoCollapsed && <MappingStyleControls
              isColor={isColor}
              colormap={gm.colormap ?? 'viridis'}
              scaleType={stype}
              domainMin={gm.domain_min ?? (geoPropRange?.min ?? 0)}
              domainMax={gm.domain_max ?? (geoPropRange?.max ?? 1)}
              categoryColors={gm.categoryColors}
              categoryValues={catVals}
              categoryMaps={categoryMaps}
              datasetRange={geoPropRange}
              onAskAI={onAskAI}
              onChange={u => updateGeoMapping(vp, u)}
            />}
          </Paper>
        );
      })}

      {geoProps.length > 0 ? (
        showAddGeo ? (
          <Paper variant="outlined" sx={{ p: 1 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>New Geometry Mapping</Typography>
            <Stack spacing={1.5}>
              <FormControl size="small" fullWidth>
                <InputLabel>Visual Property</InputLabel>
                <Select value={newGeoMapping.visual_property} label="Visual Property"
                  onChange={e => setNewGeoMapping(m => ({ ...m, visual_property: e.target.value }))}>
                  {VISUAL_PROPERTIES.map(p => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel>Feature Property</InputLabel>
                <Select value={newGeoMapping.property} label="Feature Property"
                  onChange={e => {
                    const prop = e.target.value;
                    const range = extractPropRange(geoData, prop);
                    setNewGeoMapping(m => ({
                      ...m,
                      property: prop,
                      domain_min: range?.min ?? m.domain_min,
                      domain_max: range?.max ?? m.domain_max,
                    }));
                  }}>
                  {geoProps.map(p => <MenuItem key={p} value={p}>{p}</MenuItem>)}
                </Select>
              </FormControl>
              <MappingStyleControls
                isColor={VISUAL_PROP_MAP[newGeoMapping.visual_property]?.isColor}
                colormap={newGeoMapping.colormap}
                scaleType={newGeoMapping.scale_type}
                domainMin={newGeoMapping.domain_min}
                domainMax={newGeoMapping.domain_max}
                categoryColors={newGeoMapping.categoryColors}
                categoryMaps={categoryMaps}
                datasetRange={newGeoMapping.property ? extractPropRange(geoData, newGeoMapping.property) : null}
                onAskAI={onAskAI}
                categoryValues={
                  (VISUAL_PROP_MAP[newGeoMapping.visual_property]?.isColor && newGeoMapping.property)
                    ? extractPropValues(geoData, newGeoMapping.property)
                    : []
                }
                onChange={u => setNewGeoMapping(m => ({ ...m, ...u }))}
              />
              <Stack direction="row" spacing={1}>
                <Button size="small" variant="contained" startIcon={<AddIcon />}
                  disabled={!newGeoMapping.property} onClick={handleAddGeoMapping}>Add</Button>
                <Button size="small" onClick={() => setShowAddGeo(false)}>Cancel</Button>
              </Stack>
            </Stack>
          </Paper>
        ) : (
          <Button size="small" variant="outlined" startIcon={<AddIcon />} fullWidth
            onClick={() => setShowAddGeo(true)}>
            Add Geometry Mapping
          </Button>
        )
      ) : (
        <Typography variant="caption" color="text.secondary">No geometry data loaded.</Typography>
      )}
    </Box>
  );

  // ── Tab 2: Filter ───────────────────────────────────────────────────────────
  const filterTab = (
    <Box sx={{ px: 1 }}>
      <SectionHeader>Category Filter</SectionHeader>
      <Stack spacing={1.5}>
        <FormControlLabel
          control={<Switch checked={localStyle.filterEnabled ?? false}
            onChange={e => update({ filterEnabled: e.target.checked })} />}
          label="Enable Filter" />

        <Stack direction="row" alignItems="center">
          <FormControl size="small" fullWidth>
            <InputLabel>Filter Property</InputLabel>
            <Select value={localStyle.filterProperty ?? ''} label="Filter Property"
              onChange={e => update({ filterProperty: e.target.value || null, filterCategories: [], filterAllCategories: [] })}>
              <MenuItem value=""><em>None</em></MenuItem>
              {geoProps.map(p => <MenuItem key={p} value={p}>{p}</MenuItem>)}
            </Select>
          </FormControl>
          <InfoTip tip={TIPS.filterProperty} />
        </Stack>

        {localStyle.filterProperty && (
          <Stack direction="row" alignItems="center">
            <FormControl size="small" fullWidth>
              <InputLabel>Show Categories</InputLabel>
              <Select multiple value={localStyle.filterCategories ?? []}
                onChange={e => update({ filterCategories: e.target.value })}
                input={<OutlinedInput label="Show Categories" />}
                renderValue={sel => sel.length === filterPropValues.length ? 'All' : sel.join(', ')}>
                {filterPropValues.map(v => (
                  <MenuItem key={v} value={v}>
                    <Checkbox checked={(localStyle.filterCategories ?? []).includes(v)} />
                    <ListItemText primary={v} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <InfoTip tip={TIPS.filterCategories} />
          </Stack>
        )}

        {localStyle.filterProperty && (
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="text" onClick={() => update({ filterCategories: filterPropValues })}>Select All</Button>
            <Button size="small" variant="text" onClick={() => update({ filterCategories: [] })}>Clear</Button>
          </Stack>
        )}
      </Stack>
    </Box>
  );

  // ── Tab 3: Paintings ─────────────────────────────────────────────────────────
  const paintingsTab = (
    <Box sx={{ px: 1 }}>
      <SectionHeader>Paintings</SectionHeader>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Save and restore named style snapshots. Switch between views without reloading the layer.
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }} alignItems="center">
        <TextField size="small" label="New painting name" value={paintingName}
          onChange={e => setPaintingName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSavePainting(); }}
          sx={{ flex: 1 }} />
        <Button size="small" variant="contained" disabled={!paintingName.trim()}
          onClick={handleSavePainting}>
          Save
        </Button>
      </Stack>

      {paintings.length === 0 && (
        <Typography variant="caption" color="text.secondary">No saved paintings yet.</Typography>
      )}

      {paintings.map((p, idx) => {
        const s = p.style ?? {};
        const chips = [];
        if (s.opacity != null && s.opacity !== 0.8) chips.push(`opacity: ${s.opacity.toFixed(2)}`);
        if (s.radiusScale != null && s.radiusScale !== 1) chips.push(`scale: ${s.radiusScale.toFixed(1)}x`);
        if (s.filterEnabled) chips.push(`filter: ${s.filterProperty ?? 'on'}`);
        const geoCount = Object.keys(s.geoMappings ?? {}).length;
        if (geoCount > 0) chips.push(`${geoCount} geo mapping${geoCount > 1 ? 's' : ''}`);
        const overCount = Object.keys(s.mappingOverrides ?? {}).length;
        if (overCount > 0) chips.push(`${overCount} override${overCount > 1 ? 's' : ''}`);

        return (
          <Paper key={idx} variant="outlined" sx={{ p: 1, mb: 1 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              {editingIdx === idx ? (
                <TextField size="small" value={editName} autoFocus
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRenamePainting(idx, editName); if (e.key === 'Escape') setEditingIdx(null); }}
                  onBlur={() => handleRenamePainting(idx, editName)}
                  sx={{ flex: 1, mr: 1 }} />
              ) : (
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ cursor: 'pointer' }}
                  onClick={() => { setEditingIdx(idx); setEditName(p.name); }}>
                  <Typography variant="body2" fontWeight="medium">{p.name}</Typography>
                  <EditIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                </Stack>
              )}
              <Stack direction="row" spacing={0.5}>
                <Tooltip title={p.is_default ? 'Default painting — auto-applied on load. Click to unset.' : 'Make this the default (auto-applies on load)'}>
                  <Button size="small" variant={p.is_default ? 'contained' : 'outlined'}
                    color={p.is_default ? 'primary' : 'inherit'}
                    onClick={() => handleSetDefaultPainting(p)}>
                    {p.is_default ? '★ Default' : 'Default'}
                  </Button>
                </Tooltip>
                <Button size="small" variant="outlined" onClick={() => handleApplyPainting(p)}>
                  Apply
                </Button>
                <Button size="small" variant="outlined" onClick={() => handleUpdatePainting(idx)}>
                  Update
                </Button>
                <IconButton size="small" onClick={() => handleDeletePainting(idx)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Stack>
            </Stack>
            {chips.length > 0 && (
              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} flexWrap="wrap">
                {chips.map(c => <Chip key={c} label={c} size="small" variant="outlined" />)}
              </Stack>
            )}
          </Paper>
        );
      })}
    </Box>
  );

  // ── Interaction tab ────────────────────────────────────────────────────────
  const interaction = localStyle.interaction ?? {};
  const updateInteraction = (updates) => {
    update({ interaction: { ...interaction, ...updates } });
  };

  const ALL_CONTENT_ITEMS = [
    { value: 'infocard',   label: 'Info Card (properties + current value)' },
    { value: 'timeseries', label: 'Timeseries Chart' },
    { value: 'heatmap',    label: 'Heatmap Chart' },
    { value: 'histogram',  label: 'Histogram Chart' },
  ];

  function toggleContentItem(key, items, setter) {
    const current = items;
    const next = current.includes(key)
      ? current.filter((c) => c !== key)
      : [...current, key];
    setter(next);
  }

  const hoverContent = interaction.hoverContent ?? ['infocard'];
  const clickContent = interaction.clickContent ?? ['infocard', 'timeseries'];

  const interactionTab = (
    <Box sx={{ p: 1 }}>
      <Typography variant="subtitle2" gutterBottom>Hover Content</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
        Select what to show when hovering over a map entity
      </Typography>
      <FormGroup>
        {ALL_CONTENT_ITEMS.map(({ value, label }) => (
          <FormControlLabel key={value}
            control={<Checkbox size="small" checked={hoverContent.includes(value)}
              onChange={() => toggleContentItem(value, hoverContent, (v) => updateInteraction({ hoverContent: v }))} />}
            label={<Typography variant="body2">{label}</Typography>}
          />
        ))}
      </FormGroup>

      <Divider sx={{ my: 1.5 }} />

      <Typography variant="subtitle2" gutterBottom>Click Content</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
        Select what to show when clicking a map entity (persists until closed)
      </Typography>
      <FormGroup>
        {ALL_CONTENT_ITEMS.map(({ value, label }) => (
          <FormControlLabel key={value}
            control={<Checkbox size="small" checked={clickContent.includes(value)}
              onChange={() => toggleContentItem(value, clickContent, (v) => updateInteraction({ clickContent: v }))} />}
            label={<Typography variant="body2">{label}</Typography>}
          />
        ))}
      </FormGroup>

      <Divider sx={{ my: 1.5 }} />

      <Tooltip title="How the popup/panel is displayed on the map">
        <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
          <InputLabel>Panel Placement</InputLabel>
          <Select value={interaction.panelPlacement ?? 'floating'} label="Panel Placement"
            onChange={(e) => updateInteraction({ panelPlacement: e.target.value })}>
            <MenuItem value="floating">Floating Panel</MenuItem>
            <MenuItem value="drawer">Side Drawer</MenuItem>
          </Select>
        </FormControl>
      </Tooltip>

      {(hoverContent.includes('heatmap') || clickContent.includes('heatmap')) && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Tooltip title="Time resolution for the Y-axis of the heatmap (like pandas resample)">
            <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
              <InputLabel>Heatmap Time Bin</InputLabel>
              <Select value={interaction.heatmapBinMode ?? 'hour'} label="Heatmap Time Bin"
                onChange={(e) => updateInteraction({ heatmapBinMode: e.target.value })}>
                <MenuItem value="hour">Hour of Day (0-23)</MenuItem>
                <MenuItem value="4hour">4-Hour Blocks (0-5)</MenuItem>
                <MenuItem value="15min">15-Minute Bins (0-95)</MenuItem>
                <MenuItem value="minute">Minute of Day (0-1439)</MenuItem>
              </Select>
            </FormControl>
          </Tooltip>
        </>
      )}

      {(hoverContent.includes('histogram') || clickContent.includes('histogram')) && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Tooltip title="Full = entire entity timeseries, Rolling = animated window around current time">
            <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
              <InputLabel>Histogram Mode</InputLabel>
              <Select value={interaction.histogramMode ?? 'full'} label="Histogram Mode"
                onChange={(e) => updateInteraction({ histogramMode: e.target.value })}>
                <MenuItem value="full">Full Distribution</MenuItem>
                <MenuItem value="rolling">Rolling Window (Animated)</MenuItem>
              </Select>
            </FormControl>
          </Tooltip>
        </>
      )}

      {(hoverContent.includes('timeseries') || clickContent.includes('timeseries')) && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Tooltip title="Number of timesteps to show before/after current time in the timeseries chart">
            <Box>
              <Typography variant="caption">Timeseries Window (half-width)</Typography>
              <Slider size="small" value={interaction.timeseriesDelta ?? 168}
                min={24} max={2000} step={24}
                onChange={(_, v) => updateInteraction({ timeseriesDelta: v })} />
              <Typography variant="caption" color="text.secondary">
                {interaction.timeseriesDelta ?? 168} timesteps
              </Typography>
            </Box>
          </Tooltip>
        </>
      )}
    </Box>
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto"
        sx={{ mb: 1, '& .MuiTab-root': { minWidth: 0, px: 1.5, fontSize: '0.75rem' } }}>
        <Tab icon={<PaletteIcon fontSize="small" />} iconPosition="start" label="Style" />
        <Tab icon={<TuneIcon fontSize="small" />} iconPosition="start" label="Mappings" />
        <Tab icon={<FilterAltIcon fontSize="small" />} iconPosition="start" label="Filter" />
        <Tab icon={<BookmarkIcon fontSize="small" />} iconPosition="start" label="Saves" />
        <Tab icon={<TouchAppIcon fontSize="small" />} iconPosition="start" label="Interact" />
      </Tabs>
      {tab === 0 && styleTab}
      {tab === 1 && mappingsTab}
      {tab === 2 && filterTab}
      {tab === 3 && paintingsTab}
      {tab === 4 && interactionTab}
    </Box>
  );
}
