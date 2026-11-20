import React, { useState, useRef } from "react";
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
import CircularProgress from "@mui/material/CircularProgress";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Chip from "@mui/material/Chip";
import { uploadGeometryFile, uploadDatasetFile, previewGeometryCsv } from "../../lib/loaders.js";

const GEO_FORMATS = ["geojson", "csv", "shapefile", "geoparquet", "gpkg", "flatgeobuf"];
const DATASET_FORMATS = ["csv", "parquet", "tsv"];
// Formats ingested into DuckDB spatial and served per-viewport (see
// server/lib/geometry_spatial.py). These expose a category column for
// zoom-based visibility gating.
const SPATIAL_FORMATS = ["shapefile", "geoparquet", "gpkg", "flatgeobuf"];

/**
 * UploadDialog
 *
 * Reusable upload dialog for geometry files and tabular datasets.
 * Join keys and timestamp columns are auto-detected server-side from the file
 * schema and are not required here — they are configured during the Associate step.
 *
 * Props:
 *   open        – boolean
 *   onClose     – () => void
 *   onUploaded  – (record) => void  called with the created DB record
 *   type        – "geometry" | "dataset"
 */
export default function UploadDialog({ open, onClose, onUploaded, type = "geometry" }) {
  const isGeo = type === "geometry";
  const fileRef = useRef(null);

  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [format, setFormat] = useState(isGeo ? "geojson" : "csv");
  const [globalScope, setGlobalScope] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // CSV geometry state — lat/lon column selection
  const [csvColumns, setCsvColumns] = useState([]);
  const [latCol, setLatCol] = useState("");
  const [lonCol, setLonCol] = useState("");
  const [csvPreviewing, setCsvPreviewing] = useState(false);
  // Spatial geometry: optional categorical column (e.g. voltage class) used for
  // zoom-based visibility gating.
  const [categoryCol, setCategoryCol] = useState("");

  const isCsvGeo = isGeo && format === "csv";
  const isSpatialGeo = isGeo && SPATIAL_FORMATS.includes(format);
  // A shapefile is a multi-file bundle; a lone .shp can't be read.
  const isBareShapefile = !!file && /\.shp$/i.test(file.name);

  function reset() {
    setFile(null);
    setName("");
    setFormat(isGeo ? "geojson" : "csv");
    setGlobalScope(false);
    setDisplayName("");
    setDescription("");
    setCsvColumns([]);
    setLatCol("");
    setLonCol("");
    setCsvPreviewing(false);
    setCategoryCol("");
    setError("");
    setSaving(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleFileChange(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));

    // Auto-detect format from extension
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (isGeo) {
      if (ext === "csv" || ext === "tsv") {
        setFormat("csv");
        _previewCsvFile(f);
      } else if (ext === "geojson" || ext === "json") {
        setFormat("geojson");
      } else if (ext === "zip" || ext === "shp") {
        setFormat("shapefile");
      } else if (ext === "gpkg") {
        setFormat("gpkg");
      } else if (ext === "fgb") {
        setFormat("flatgeobuf");
      } else if (ext === "parquet") {
        setFormat("csv"); // parquet with lat/lon → treat as CSV path
        _previewCsvFile(f);
      }
    }
  }

  async function _previewCsvFile(f) {
    setCsvPreviewing(true);
    setCsvColumns([]);
    setLatCol("");
    setLonCol("");
    try {
      const preview = await previewGeometryCsv(f);
      setCsvColumns(preview.columns || []);
      setLatCol(preview.detected_lat_col || "");
      setLonCol(preview.detected_lon_col || "");
    } catch (err) {
      console.error("[UploadDialog] CSV preview failed:", err);
    } finally {
      setCsvPreviewing(false);
    }
  }

  async function handleUpload() {
    if (!file) { setError("Select a file first."); return; }
    if (!name) { setError("Name is required."); return; }
    if (isBareShapefile) {
      setError("A shapefile needs its .shx/.dbf/.prj too — zip them together and upload the .zip.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const meta = { name, format, scope: globalScope ? "global" : "scenario" };
      if (displayName) meta.display_name = displayName;
      if (description) meta.description = description;
      if (isCsvGeo) {
        if (latCol) meta.lat_col = latCol;
        if (lonCol) meta.lon_col = lonCol;
      }
      if (isSpatialGeo && categoryCol) meta.category_col = categoryCol;
      const record = isGeo
        ? await uploadGeometryFile(file, meta)
        : await uploadDatasetFile(file, meta);
      onUploaded(record);
      reset();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        Upload {isGeo ? "Geometry File" : "Dataset"}
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2}>
          {/* File picker */}
          <Box>
            <input
              ref={fileRef}
              type="file"
              style={{ display: "none" }}
              onChange={handleFileChange}
            />
            <Button
              variant="outlined"
              startIcon={<CloudUploadIcon />}
              onClick={() => fileRef.current?.click()}
              fullWidth
            >
              {file ? file.name : "Choose file…"}
            </Button>
          </Box>

          <TextField
            label="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            fullWidth
            required
            size="small"
          />

          <FormControl fullWidth size="small">
            <InputLabel>Format</InputLabel>
            <Select value={format} label="Format" onChange={e => {
              const newFmt = e.target.value;
              setFormat(newFmt);
              // Trigger CSV preview when switching to csv with a file already selected
              if (isGeo && newFmt === "csv" && file && csvColumns.length === 0) {
                _previewCsvFile(file);
              }
            }}>
              {(isGeo ? GEO_FORMATS : DATASET_FORMATS).map(f => (
                <MenuItem key={f} value={f}>{f}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            label="Display Name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            fullWidth
            size="small"
            helperText="Human-readable name shown in the UI (optional)"
          />

          <TextField
            label="Description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            fullWidth
            size="small"
            multiline
            minRows={2}
            maxRows={4}
            helperText="Brief description of this data (optional)"
          />

          {/* CSV geometry: lat/lon column selectors */}
          {isCsvGeo && file && (
            csvPreviewing ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={16} />
                <Typography variant="caption" color="text.secondary">Detecting columns...</Typography>
              </Stack>
            ) : csvColumns.length > 0 ? (
              <>
                <Typography variant="caption" color="text.secondary" fontWeight={600}>
                  Point geometry columns
                </Typography>
                <FormControl fullWidth size="small">
                  <InputLabel>Latitude column</InputLabel>
                  <Select value={latCol} label="Latitude column" onChange={e => setLatCol(e.target.value)}>
                    {csvColumns.map(c => (
                      <MenuItem key={c} value={c}>
                        {c}
                        {c === latCol && latCol && <Chip label="detected" size="small" sx={{ ml: 1 }} color="success" variant="outlined" />}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl fullWidth size="small">
                  <InputLabel>Longitude column</InputLabel>
                  <Select value={lonCol} label="Longitude column" onChange={e => setLonCol(e.target.value)}>
                    {csvColumns.map(c => (
                      <MenuItem key={c} value={c}>
                        {c}
                        {c === lonCol && lonCol && <Chip label="detected" size="small" sx={{ ml: 1 }} color="success" variant="outlined" />}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                {(!latCol || !lonCol) && (
                  <Typography variant="caption" color="warning.main">
                    Could not auto-detect lat/lon columns. Please select them manually.
                  </Typography>
                )}
              </>
            ) : null
          )}

          {/* Spatial geometry: shapefile packaging guidance + category column */}
          {isSpatialGeo && (
            <>
              {isBareShapefile ? (
                <Typography variant="caption" color="warning.main">
                  A shapefile is a bundle — zip the <code>.shp</code>, <code>.shx</code>,{" "}
                  <code>.dbf</code> and <code>.prj</code> together and upload the <code>.zip</code>.
                </Typography>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Large line/polygon data is served per map viewport (only what's in view loads).
                  {format === "shapefile" && " Upload the shapefile bundle as a single .zip."}
                </Typography>
              )}
              <TextField
                label="Category column (optional)"
                value={categoryCol}
                onChange={e => setCategoryCol(e.target.value)}
                fullWidth
                size="small"
                helperText="Column to gate by zoom later, e.g. a voltage class like VOLT_CAT."
              />
            </>
          )}

          <FormControlLabel
            control={
              <Switch
                checked={globalScope}
                onChange={e => setGlobalScope(e.target.checked)}
                size="small"
              />
            }
            label="Available globally"
          />
          <Typography variant="caption" color="text.secondary">
            {globalScope
              ? "This file will be available across all projects and scenarios."
              : isGeo
                ? "Join keys are auto-detected from the file's feature properties and can be configured in the Associate tab."
                : "Timestamp and join key columns are auto-detected from the file schema and can be configured in the Associate tab."}
          </Typography>

          {error && <Typography color="error" variant="body2">{error}</Typography>}
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="contained" onClick={handleUpload} disabled={saving || !file || isBareShapefile}>
          {saving ? <CircularProgress size={18} /> : "Upload"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
