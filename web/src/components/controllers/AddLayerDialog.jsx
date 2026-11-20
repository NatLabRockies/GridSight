import React, { useEffect } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import CircularProgress from "@mui/material/CircularProgress";
import {
  fetchGeometryFiles,
  fetchDatasets,
  fetchDatasetColumns,
  createLayer,
  attachDatasetToLayer,
  addStyleMapping,
} from "../../lib/loaders.js";
import { useAddLayerState } from "../../state/addLayerState.js";

const DECK_LAYER_TYPES = ["GeoJsonLayer", "ScatterplotLayer", "ArcLayer"];

const VISUAL_PROPERTIES = [
  "getFillColor",
  "getLineColor",
  "getLineWidth",
  "getRadius",
  "getElevation",
  "getPointRadius",
];

const COLORMAPS = ["viridis", "plasma", "coolwarm", "rdylgn"];

const SCALE_TYPES = ["linear", "log", "quantile"];

/**
 * AddLayerDialog
 *
 * A two-step dialog for creating a new generic geo layer within the current
 * project/scenario. Step 1 configures geometry + deck layer type. Step 2
 * optionally attaches a dataset and style mappings.
 *
 * Props:
 *   open           – boolean
 *   onClose        – () => void
 *   onLayerCreated – (layerConfig) => void  called after the layer is saved
 *   project        – string
 *   scenario       – string
 */
export default function AddLayerDialog({ open, onClose, onLayerCreated, project, scenario }) {
  const al = useAddLayerState();

  useEffect(() => {
    if (!open) return;
    fetchGeometryFiles().then(al.setGeometryFiles).catch(console.error);
    fetchDatasets().then(al.setDatasets).catch(console.error);
    // Reset state on open
    al.setStep(1);
    al.setLayerName("");
    al.setSelectedGeoId("");
    al.setDeckLayerType("GeoJsonLayer");
    al.setSelectedDatasetId("");
    al.setGeomJoinKey("");
    al.setDataJoinKey("");
    al.setDataColumns([]);
    al.patch({ styleMappings: [], createdLayerId: null, createdLayerDatasetId: null });
    al.setError("");
  }, [open]);

  useEffect(() => {
    if (!al.state.selectedDatasetId) { al.setDataColumns([]); return; }
    const ds = al.state.datasets.find(d => d.id === Number(al.state.selectedDatasetId));
    if (ds?.timestamp_col) { al.setDataColumns([]); return; } // timeseries — no column picker
    fetchDatasetColumns(Number(al.state.selectedDatasetId))
      .then(al.setDataColumns)
      .catch(console.error);
  }, [al.state.selectedDatasetId, al.state.datasets]);

  // --- Step 1: save layer + optionally attach dataset ---
  async function handleSaveStep1() {
    if (!al.state.layerName || !al.state.selectedGeoId) {
      al.setError("Layer name and geometry are required.");
      return;
    }
    al.setSaving(true);
    al.setError("");
    try {
      const layer = await createLayer({
        project,
        scenario,
        geometry_id: Number(al.state.selectedGeoId),
        name: al.state.layerName,
        deck_layer_type: al.state.deckLayerType,
      });

      if (al.state.selectedDatasetId) {
        const ld = await attachDatasetToLayer(layer.id, {
          dataset_id: Number(al.state.selectedDatasetId),
          geom_join_key: al.state.geomJoinKey || undefined,
          data_join_key: al.state.dataJoinKey || undefined,
        });
        al.advanceToStep2(layer.id, ld.id);
      } else {
        onLayerCreated({ id: layer.id, name: al.state.layerName, deck_layer_type: al.state.deckLayerType });
        onClose();
        al.setSaving(false);
      }
    } catch (e) {
      al.setError(String(e));
      al.setSaving(false);
    }
  }

  // --- Step 2: add a style mapping ---
  async function handleAddMapping() {
    const isTs = !!al.state.datasets.find(d => d.id === Number(al.state.selectedDatasetId))?.timestamp_col;
    const effectiveColumn = isTs ? '__timeseries__' : al.state.newMapping.column;
    if (!isTs && !al.state.newMapping.column) { al.setError("Column is required."); return; }
    al.setSaving(true);
    al.setError("");
    try {
      const sm = await addStyleMapping(al.state.createdLayerId, {
        layer_dataset_id: al.state.createdLayerDatasetId,
        visual_property: al.state.newMapping.visual_property,
        column: effectiveColumn,
        colormap: al.state.newMapping.colormap || undefined,
        scale_type: al.state.newMapping.scale_type || undefined,
        domain_min: al.state.newMapping.domain_min !== "" ? Number(al.state.newMapping.domain_min) : undefined,
        domain_max: al.state.newMapping.domain_max !== "" ? Number(al.state.newMapping.domain_max) : undefined,
      });
      al.appendStyleMapping({ ...al.state.newMapping, column: effectiveColumn, id: sm.id });
      al.setNewMapping({ column: "", domain_min: "", domain_max: "" });
    } catch (e) {
      al.setError(String(e));
    } finally {
      al.setSaving(false);
    }
  }

  function handleFinish() {
    onLayerCreated({ id: al.state.createdLayerId, name: al.state.layerName, deck_layer_type: al.state.deckLayerType });
    onClose();
  }

  const selectedGeo = al.state.geometryFiles.find(g => g.id === Number(al.state.selectedGeoId));
  const isTimeseries = !!al.state.datasets.find(d => d.id === Number(al.state.selectedDatasetId))?.timestamp_col;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {al.state.step === 1 ? "Add Layer — Geometry & Dataset" : "Add Layer — Style Mappings"}
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2}>
          {al.state.step === 1 && (
            <>
              <TextField
                label="Layer Name"
                value={al.state.layerName}
                onChange={e => al.setLayerName(e.target.value)}
                fullWidth
                required
              />

              <FormControl fullWidth required>
                <InputLabel>Geometry File</InputLabel>
                <Select
                  value={al.state.selectedGeoId}
                  label="Geometry File"
                  onChange={e => al.setSelectedGeoId(e.target.value)}
                >
                  {al.state.geometryFiles.map(g => (
                    <MenuItem key={g.id} value={g.id}>
                      {g.display_name || g.name} ({g.format})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth>
                <InputLabel>Deck.gl Layer Type</InputLabel>
                <Select
                  value={al.state.deckLayerType}
                  label="Deck.gl Layer Type"
                  onChange={e => al.setDeckLayerType(e.target.value)}
                >
                  {DECK_LAYER_TYPES.map(t => (
                    <MenuItem key={t} value={t}>{t}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Divider />
              <Typography variant="subtitle1">Dataset (optional)</Typography>

              <FormControl fullWidth>
                <InputLabel>Dataset</InputLabel>
                <Select
                  value={al.state.selectedDatasetId}
                  label="Dataset"
                  onChange={e => al.setSelectedDatasetId(e.target.value)}
                >
                  <MenuItem value=""><em>None</em></MenuItem>
                  {al.state.datasets.map(d => (
                    <MenuItem key={d.id} value={d.id}>
                      {d.name} ({d.format}{d.timestamp_col ? ", timeseries" : ", static"})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              {al.state.selectedDatasetId && (
                <>
                  <TextField
                    label="Geometry Join Key"
                    helperText={`Feature property to join on${selectedGeo?.join_key ? ` (default: ${selectedGeo.join_key})` : ""}`}
                    value={al.state.geomJoinKey}
                    onChange={e => al.setGeomJoinKey(e.target.value)}
                    fullWidth
                  />
                  <TextField
                    label="Dataset Join Key"
                    helperText={`Column in dataset to join on${al.state.datasets.find(d => d.id === Number(al.state.selectedDatasetId))?.join_key ? ` (default: ${al.state.datasets.find(d => d.id === Number(al.state.selectedDatasetId)).join_key})` : ""}`}
                    value={al.state.dataJoinKey}
                    onChange={e => al.setDataJoinKey(e.target.value)}
                    fullWidth
                  />
                </>
              )}
            </>
          )}

          {al.state.step === 2 && (
            <>
              <Typography variant="body2" color="text.secondary">
                Optionally map deck.gl visual properties to columns in your dataset.
                You can add multiple mappings.
              </Typography>

              {al.state.styleMappings.length > 0 && (
                <Stack spacing={0.5}>
                  {al.state.styleMappings.map((m, i) => (
                    <Typography key={i} variant="caption" color="text.secondary">
                      ✓ {m.visual_property} ← {m.column === '__timeseries__' ? 'timeseries values' : m.column}
                      {m.colormap ? ` (${m.colormap})` : ""}
                    </Typography>
                  ))}
                </Stack>
              )}

              <Divider />
              <Typography variant="subtitle2">New Mapping</Typography>

              <FormControl fullWidth>
                <InputLabel>Visual Property</InputLabel>
                <Select
                  value={al.state.newMapping.visual_property}
                  label="Visual Property"
                  onChange={e => al.setNewMapping({ visual_property: e.target.value })}
                >
                  {VISUAL_PROPERTIES.map(p => (
                    <MenuItem key={p} value={p}>{p}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              {isTimeseries ? (
                <Typography variant="body2" sx={{ px: 1, py: 0.75, bgcolor: 'action.hover', borderRadius: 1 }}>
                  Timeseries dataset: values are animated per timestep and joined to features by entity ID
                  (column names = entity IDs). No column selection needed.
                </Typography>
              ) : (
                <FormControl fullWidth>
                  <InputLabel>Data Column</InputLabel>
                  <Select
                    value={al.state.newMapping.column}
                    label="Data Column"
                    onChange={e => al.setNewMapping({ column: e.target.value })}
                  >
                    {al.state.dataColumns.map(c => (
                      <MenuItem key={c} value={c}>{c}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}

              <FormControl fullWidth>
                <InputLabel>Colormap</InputLabel>
                <Select
                  value={al.state.newMapping.colormap}
                  label="Colormap"
                  onChange={e => al.setNewMapping({ colormap: e.target.value })}
                >
                  <MenuItem value=""><em>None (numeric)</em></MenuItem>
                  {COLORMAPS.map(c => (
                    <MenuItem key={c} value={c}>{c}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth>
                <InputLabel>Scale Type</InputLabel>
                <Select
                  value={al.state.newMapping.scale_type}
                  label="Scale Type"
                  onChange={e => al.setNewMapping({ scale_type: e.target.value })}
                >
                  {SCALE_TYPES.map(s => (
                    <MenuItem key={s} value={s}>{s}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Stack direction="row" spacing={2}>
                <TextField
                  label="Domain Min"
                  type="number"
                  value={al.state.newMapping.domain_min}
                  onChange={e => al.setNewMapping({ domain_min: e.target.value })}
                  helperText="Leave blank to auto-detect"
                  fullWidth
                />
                <TextField
                  label="Domain Max"
                  type="number"
                  value={al.state.newMapping.domain_max}
                  onChange={e => al.setNewMapping({ domain_max: e.target.value })}
                  helperText="Leave blank to auto-detect"
                  fullWidth
                />
              </Stack>

              <Button variant="outlined" onClick={handleAddMapping} disabled={al.state.saving || (!isTimeseries && !al.state.newMapping.column)}>
                {al.state.saving ? <CircularProgress size={18} /> : "Add Mapping"}
              </Button>
            </>
          )}

          {al.state.error && (
            <Typography color="error" variant="body2">{al.state.error}</Typography>
          )}
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        {al.state.step === 1 && (
          <Button variant="contained" onClick={handleSaveStep1} disabled={al.state.saving}>
            {al.state.saving ? <CircularProgress size={18} /> : al.state.selectedDatasetId ? "Next →" : "Create Layer"}
          </Button>
        )}
        {al.state.step === 2 && (
          <Button variant="contained" onClick={handleFinish}>
            Done
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
