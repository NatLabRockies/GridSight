import React, { useState, useEffect, useCallback, useRef } from "react";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Divider from "@mui/material/Divider";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import TextField from "@mui/material/TextField";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import RefreshIcon from "@mui/icons-material/Refresh";
import LinkIcon from "@mui/icons-material/Link";
import TerrainIcon from "@mui/icons-material/Terrain";
import TableChartIcon from "@mui/icons-material/TableChart";
import UploadDialog from "./UploadDialog.jsx";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import EditIcon from "@mui/icons-material/Edit";
import MapIcon from "@mui/icons-material/Map";
import SearchIcon from "@mui/icons-material/Search";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import DescriptionIcon from "@mui/icons-material/Description";
import DeleteIcon from "@mui/icons-material/Delete";
import {
  fetchGeometryFiles,
  fetchDatasets,
  fetchGeometrySchema,
  fetchDatasetSchema,
  fetchJoinHints,
  quickLayerFromGeometry,
  createLayer,
  attachDatasetToLayer,
  updateGeometry,
  updateDataset,
  deleteDataset,
  generateDescription,
  uploadDescriptionFile,
} from "../../lib/loaders.js";

// ---------------------------------------------------------------------------
// File list sub-components
// ---------------------------------------------------------------------------

function FileTable({ rows, emptyMessage, columns }) {
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>
        {emptyMessage}
      </Typography>
    );
  }
  return (
    <Box>
      <Table size="small" sx={{ tableLayout: "auto" }}>
        <TableHead>
          <TableRow>
            {columns.map(c => <TableCell key={c.key}>{c.label}</TableCell>)}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.id} hover>
              {columns.map(c => (
                <TableCell key={c.key}>
                  {c.render ? c.render(row) : (row[c.key] ?? "—")}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab panels
// ---------------------------------------------------------------------------

function GeometryTab({ geometryFiles, loading, onUploadClick, onGeometryUpdated, onQuickLayer, onInspectData }) {
  const [editingId, setEditingId] = useState(null);
  const [editJoinKey, setEditJoinKey] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [geoSchema, setGeoSchema] = useState(null);
  const [saving, setSaving] = useState(false);
  const [visualizing, setVisualizing] = useState(null);
  const [describing, setDescribing] = useState(null);
  const [uploadingDesc, setUploadingDesc] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null); // { severity: 'success'|'error', text: '...' }
  const descFileRef = useRef(null);
  const [descTarget, setDescTarget] = useState(null);

  // Load property names when editing starts
  useEffect(() => {
    if (editingId == null) { setGeoSchema(null); return; }
    fetchGeometrySchema(editingId)
      .then(s => setGeoSchema(s))
      .catch(e => console.error("[GeometryTab] schema error:", e));
  }, [editingId]);

  function handleEditClick(row) {
    setEditingId(row.id);
    setEditJoinKey(row.join_key ?? "");
    setEditDescription(row.description ?? "");
  }

  async function handleSave() {
    if (editingId == null) return;
    setSaving(true);
    try {
      await updateGeometry(editingId, { join_key: editJoinKey || null, description: editDescription || null });
      onGeometryUpdated?.();
      setEditingId(null);
    } catch (e) {
      console.error("[GeometryTab] update error:", e);
    } finally {
      setSaving(false);
    }
  }

  async function handleAIDescribe(row) {
    setDescribing(row.id);
    setStatusMsg(null);
    try {
      const result = await generateDescription("geometry", row.id);
      onGeometryUpdated?.();
      setStatusMsg({ severity: "success", text: `AI generated ${result.descriptions_written ?? 0} description(s) for "${row.name}".` });
    } catch (e) {
      console.error("[GeometryTab] AI describe error:", e);
      setStatusMsg({ severity: "error", text: `AI describe failed: ${e.message}` });
    } finally {
      setDescribing(null);
    }
  }

  async function handleDescFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !descTarget) return;
    setUploadingDesc(descTarget);
    setStatusMsg(null);
    const targetRow = geometryFiles.find(g => g.id === descTarget);
    try {
      const result = await uploadDescriptionFile(file, { targetType: "geometry", targetId: descTarget });
      onGeometryUpdated?.();
      const method = result.method === "direct_match" ? "direct CSV match" : "AI";
      setStatusMsg({ severity: "success", text: `${result.descriptions_written ?? 0} description(s) written via ${method} for "${targetRow?.name || descTarget}".` });
    } catch (err) {
      console.error("[GeometryTab] description file upload error:", err);
      setStatusMsg({ severity: "error", text: `Description upload failed: ${err.message}` });
    } finally {
      setUploadingDesc(null);
    }
    setDescTarget(null);
    if (descFileRef.current) descFileRef.current.value = "";
  }

  const isProcessing = describing != null || uploadingDesc != null;

  const columns = [
    { key: "name", label: "Name", render: r => (
      <Box>
        {/* Prefer the user-given title (display_name); show the underlying
            file name as a muted subtitle when it differs so the source file
            is still identifiable. */}
        <Typography variant="body2" fontWeight={500} noWrap>{r.display_name || r.name}</Typography>
        {r.display_name && r.display_name !== r.name && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
            {r.name}
          </Typography>
        )}
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.25 }}>
          <Chip label={r.format} size="small" sx={{ fontSize: 10, height: 18 }} />
          <Chip
            label={r.scope === "global" ? "Global" : r.scope === "extension" ? r.extension_name || "Ext" : "Scenario"}
            size="small"
            color={r.scope === "global" ? "info" : r.scope === "extension" ? "secondary" : "default"}
            variant="outlined"
            sx={{ fontSize: 10, height: 18 }}
          />
          {r.join_key && <Chip label={r.join_key} size="small" color="primary" variant="outlined" sx={{ fontSize: 10, height: 18 }} />}
        </Stack>
      </Box>
    )},
    { key: "description", label: "Description", render: r => (
      editingId === r.id ? (
        <Stack spacing={0.5}>
          <TextField
            size="small"
            value={editDescription}
            onChange={e => setEditDescription(e.target.value)}
            multiline
            maxRows={3}
            fullWidth
            placeholder="Describe this geometry…"
          />
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>Join Key</InputLabel>
            <Select
              value={editJoinKey}
              onChange={e => setEditJoinKey(e.target.value)}
              label="Join Key"
              displayEmpty
              size="small"
            >
              <MenuItem value=""><em>— none —</em></MenuItem>
              {(geoSchema?.properties ?? []).map(p => (
                <MenuItem key={p} value={p}>{p}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <Stack direction="row" spacing={0.5}>
            <Button size="small" variant="contained" onClick={handleSave} disabled={saving}>Save</Button>
            <Button size="small" onClick={() => setEditingId(null)}>Cancel</Button>
          </Stack>
        </Stack>
      ) : (
        <Typography variant="caption" sx={{ color: r.description ? "text.secondary" : "text.disabled", fontStyle: r.description ? "normal" : "italic", whiteSpace: "normal", wordBreak: "break-word" }}>
          {r.description || "No description"}
        </Typography>
      )
    )},
    { key: "actions", label: "", render: r => (
      <Stack direction="row" spacing={0.25}>
        <Tooltip title="Edit">
          <IconButton size="small" onClick={() => handleEditClick(r)}>
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Inspect rows">
          <IconButton size="small" onClick={() => onInspectData?.({ type: "geometry", id: r.id, name: r.name })}>
            <SearchIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Add to map">
          <IconButton
            size="small"
            color="primary"
            disabled={visualizing === r.id}
            onClick={async () => {
              setVisualizing(r.id);
              try {
                const layer = await quickLayerFromGeometry(r.id);
                onQuickLayer?.(layer);
              } catch (e) {
                console.error("[GeometryTab] quick layer error:", e);
              } finally {
                setVisualizing(null);
              }
            }}
          >
            {visualizing === r.id ? <CircularProgress size={16} /> : <MapIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="AI describe">
          <IconButton size="small" disabled={describing === r.id} onClick={() => handleAIDescribe(r)}>
            {describing === r.id ? <CircularProgress size={16} /> : <AutoFixHighIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title={uploadingDesc === r.id ? "Processing descriptions…" : "Upload field descriptions (CSV/PDF)"}>
          <IconButton size="small" disabled={uploadingDesc === r.id} onClick={() => { setDescTarget(r.id); descFileRef.current?.click(); }}>
            {uploadingDesc === r.id ? <CircularProgress size={16} /> : <DescriptionIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>
    )},
  ];
  return (
    <Stack spacing={1} sx={{ pt: 1 }}>
      <Stack direction="row" justifyContent="flex-end">
        <Button
          size="small"
          variant="outlined"
          startIcon={<UploadFileIcon />}
          onClick={onUploadClick}
        >
          Upload Geometry
        </Button>
      </Stack>
      {isProcessing && (
        <Alert severity="info" icon={<CircularProgress size={16} />} sx={{ py: 0.5 }}>
          {describing != null ? "AI is generating descriptions…" : "Processing description file (PDF parsing + AI)…"}
        </Alert>
      )}
      {loading
        ? <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}><CircularProgress size={24} /></Box>
        : <FileTable rows={geometryFiles} emptyMessage="No geometry files uploaded yet." columns={columns} />
      }
      <input ref={descFileRef} type="file" accept=".csv,.pdf" style={{ display: "none" }} onChange={handleDescFileUpload} />
      <Snackbar open={!!statusMsg} autoHideDuration={8000} onClose={() => setStatusMsg(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        {statusMsg && <Alert onClose={() => setStatusMsg(null)} severity={statusMsg.severity} variant="filled" sx={{ width: "100%" }}>{statusMsg.text}</Alert>}
      </Snackbar>
    </Stack>
  );
}

function DatasetTab({ datasets, loading, onUploadClick, onDatasetUpdated, onInspectData }) {
  const [editingId, setEditingId] = useState(null);
  const [editDescription, setEditDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [describing, setDescribing] = useState(null);
  const [uploadingDesc, setUploadingDesc] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);
  const descFileRef = useRef(null);
  const [descTarget, setDescTarget] = useState(null);
  const [deleting, setDeleting] = useState(null);

  function handleEditClick(row) {
    setEditingId(row.id);
    setEditDescription(row.description ?? "");
  }

  async function handleDelete(row) {
    if (!window.confirm(`Delete dataset "${row.name}"? This removes it from any layers and drops its queryable table.`)) return;
    setDeleting(row.id);
    setStatusMsg(null);
    try {
      await deleteDataset(row.id);
      onDatasetUpdated?.();
      setStatusMsg({ severity: "success", text: `Deleted dataset "${row.name}".` });
    } catch (e) {
      console.error("[DatasetTab] delete error:", e);
      setStatusMsg({ severity: "error", text: `Delete failed: ${e.message}` });
    } finally {
      setDeleting(null);
    }
  }

  async function handleSave() {
    if (editingId == null) return;
    setSaving(true);
    try {
      await updateDataset(editingId, { description: editDescription || null });
      onDatasetUpdated?.();
      setEditingId(null);
    } catch (e) {
      console.error("[DatasetTab] update error:", e);
    } finally {
      setSaving(false);
    }
  }

  async function handleAIDescribe(row) {
    setDescribing(row.id);
    setStatusMsg(null);
    try {
      const result = await generateDescription("dataset", row.id);
      onDatasetUpdated?.();
      setStatusMsg({ severity: "success", text: `AI generated ${result.descriptions_written ?? 0} description(s) for "${row.name}".` });
    } catch (e) {
      console.error("[DatasetTab] AI describe error:", e);
      setStatusMsg({ severity: "error", text: `AI describe failed: ${e.message}` });
    } finally {
      setDescribing(null);
    }
  }

  async function handleDescFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !descTarget) return;
    setUploadingDesc(descTarget);
    setStatusMsg(null);
    const targetRow = datasets.find(d => d.id === descTarget);
    try {
      const result = await uploadDescriptionFile(file, { targetType: "dataset", targetId: descTarget });
      onDatasetUpdated?.();
      const method = result.method === "direct_match" ? "direct CSV match" : "AI";
      setStatusMsg({ severity: "success", text: `${result.descriptions_written ?? 0} description(s) written via ${method} for "${targetRow?.name || descTarget}".` });
    } catch (err) {
      console.error("[DatasetTab] description file upload error:", err);
      setStatusMsg({ severity: "error", text: `Description upload failed: ${err.message}` });
    } finally {
      setUploadingDesc(null);
    }
    setDescTarget(null);
    if (descFileRef.current) descFileRef.current.value = "";
  }

  const isProcessing = describing != null || uploadingDesc != null;

  const columns = [
    { key: "name", label: "Name", render: r => (
      <Box>
        <Typography variant="body2" fontWeight={500} noWrap>{r.display_name || r.name}</Typography>
        {r.display_name && r.display_name !== r.name && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
            {r.name}
          </Typography>
        )}
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.25 }}>
          <Chip label={r.format} size="small" sx={{ fontSize: 10, height: 18 }} />
          <Chip
            label={r.scope === "global" ? "Global" : r.scope === "extension" ? r.extension_name || "Ext" : "Scenario"}
            size="small"
            color={r.scope === "global" ? "info" : r.scope === "extension" ? "secondary" : "default"}
            variant="outlined"
            sx={{ fontSize: 10, height: 18 }}
          />
          <Chip
            label={r.timestamp_col ? "timeseries" : "static"}
            size="small"
            color={r.timestamp_col ? "primary" : "default"}
            variant="outlined"
            sx={{ fontSize: 10, height: 18 }}
          />
        </Stack>
      </Box>
    )},
    { key: "description", label: "Description", render: r => (
      editingId === r.id ? (
        <Stack spacing={0.5}>
          <TextField
            size="small"
            value={editDescription}
            onChange={e => setEditDescription(e.target.value)}
            multiline
            maxRows={3}
            fullWidth
            placeholder="Describe this dataset…"
          />
          <Stack direction="row" spacing={0.5}>
            <Button size="small" variant="contained" onClick={handleSave} disabled={saving}>Save</Button>
            <Button size="small" onClick={() => setEditingId(null)}>Cancel</Button>
          </Stack>
        </Stack>
      ) : (
        <Typography variant="caption" sx={{ color: r.description ? "text.secondary" : "text.disabled", fontStyle: r.description ? "normal" : "italic", whiteSpace: "normal", wordBreak: "break-word" }}>
          {r.description || "No description"}
        </Typography>
      )
    )},
    { key: "actions", label: "", render: r => (
      <Stack direction="row" spacing={0.25}>
        <Tooltip title="Edit">
          <IconButton size="small" onClick={() => handleEditClick(r)}>
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Inspect rows">
          <IconButton size="small" onClick={() => onInspectData?.({ type: "dataset", id: r.id, name: r.name, timestamp_col: r.timestamp_col })}>
            <SearchIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="AI describe">
          <IconButton size="small" disabled={describing === r.id} onClick={() => handleAIDescribe(r)}>
            {describing === r.id ? <CircularProgress size={16} /> : <AutoFixHighIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title={uploadingDesc === r.id ? "Processing descriptions…" : "Upload field descriptions (CSV/PDF)"}>
          <IconButton size="small" disabled={uploadingDesc === r.id} onClick={() => { setDescTarget(r.id); descFileRef.current?.click(); }}>
            {uploadingDesc === r.id ? <CircularProgress size={16} /> : <DescriptionIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete dataset">
          <IconButton size="small" color="error" disabled={deleting === r.id} onClick={() => handleDelete(r)}>
            {deleting === r.id ? <CircularProgress size={16} /> : <DeleteIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>
    )},
  ];
  return (
    <Stack spacing={1} sx={{ pt: 1 }}>
      <Stack direction="row" justifyContent="flex-end">
        <Button
          size="small"
          variant="outlined"
          startIcon={<UploadFileIcon />}
          onClick={onUploadClick}
        >
          Upload Dataset
        </Button>
      </Stack>
      {isProcessing && (
        <Alert severity="info" icon={<CircularProgress size={16} />} sx={{ py: 0.5 }}>
          {describing != null ? "AI is generating descriptions…" : "Processing description file (PDF parsing + AI)…"}
        </Alert>
      )}
      {loading
        ? <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}><CircularProgress size={24} /></Box>
        : <FileTable rows={datasets} emptyMessage="No datasets uploaded yet." columns={columns} />
      }
      <input ref={descFileRef} type="file" accept=".csv,.pdf" style={{ display: "none" }} onChange={handleDescFileUpload} />
      <Snackbar open={!!statusMsg} autoHideDuration={8000} onClose={() => setStatusMsg(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        {statusMsg && <Alert onClose={() => setStatusMsg(null)} severity={statusMsg.severity} variant="filled" sx={{ width: "100%" }}>{statusMsg.text}</Alert>}
      </Snackbar>
    </Stack>
  );
}

function SchemaSelect({ label, value, onChange, options, helperText, disabled, loading }) {
  return (
    <FormControl fullWidth size="small" disabled={disabled || loading}>
      <InputLabel>{label}{loading ? " (loading…)" : ""}</InputLabel>
      <Select value={value} label={label} onChange={e => onChange(e.target.value)}>
        <MenuItem value=""><em>— none —</em></MenuItem>
        {options.map(opt => (
          <MenuItem key={opt.value} value={opt.value}>
            <Stack direction="row" spacing={1} alignItems="center">
              <span>{opt.value}</span>
              {opt.tag && (
                <Chip label={opt.tag} size="small" variant="outlined" sx={{ fontSize: 10 }} />
              )}
            </Stack>
          </MenuItem>
        ))}
      </Select>
      {helperText && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, ml: 1 }}>
          {helperText}
        </Typography>
      )}
    </FormControl>
  );
}

function AssociateTab({ geometryFiles, datasets, scenarioProp, onLinkCreated }) {
  const [linkName,      setLinkName]      = useState("");
  const [selectedGeoId, setSelectedGeoId] = useState("");
  const [selectedDsId,  setSelectedDsId]  = useState("");
  const [geomJoinKey,   setGeomJoinKey]   = useState("");
  const [dataJoinKey,   setDataJoinKey]   = useState("");
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState("");
  const [success,       setSuccess]       = useState("");

  // Schema state
  const [geoSchema,     setGeoSchema]     = useState(null);
  const [dsSchema,      setDsSchema]      = useState(null);
  const [schemaLoading, setSchemaLoading] = useState(false);

  // Join hints state
  const [joinHints, setJoinHints] = useState([]);

  const noScenario = !scenarioProp?.project || !scenarioProp?.scenario;

  // Load geometry schema and join hints when selection changes.
  useEffect(() => {
    if (!selectedGeoId) { setGeoSchema(null); setGeomJoinKey(""); setJoinHints([]); return; }
    setSchemaLoading(true);
    const geo = geometryFiles.find(g => String(g.id) === String(selectedGeoId));
    fetchGeometrySchema(Number(selectedGeoId))
      .then(schema => {
        setGeoSchema(schema);
        setGeomJoinKey(geo?.join_key || schema.suggested_join_key || "");
      })
      .catch(e => console.error("[AssociateTab] geo schema error:", e))
      .finally(() => setSchemaLoading(false));
    // Fetch join hints for this geometry
    fetchJoinHints(Number(selectedGeoId))
      .then(hints => setJoinHints(Array.isArray(hints) ? hints : []))
      .catch(e => { console.error("[AssociateTab] join hints error:", e); setJoinHints([]); });
  }, [selectedGeoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load dataset schema when selection changes
  useEffect(() => {
    if (!selectedDsId) { setDsSchema(null); setDataJoinKey(""); return; }
    setSchemaLoading(true);
    fetchDatasetSchema(Number(selectedDsId))
      .then(schema => {
        setDsSchema(schema);
        setDataJoinKey(schema.suggested_join_key ?? "");
      })
      .catch(e => console.error("[AssociateTab] dataset schema error:", e))
      .finally(() => setSchemaLoading(false));
  }, [selectedDsId]);

  // Derived state
  const selectedDs = datasets.find(d => String(d.id) === String(selectedDsId));
  const isTimeseries = !!selectedDs?.timestamp_col;
  const geoOptions = (geoSchema?.properties ?? []).map(p => ({ value: p }));
  const dsColOptions = (dsSchema?.columns ?? []).map(col => ({
    value: col,
    tag: dsSchema.dtypes?.[col],
  }));

  async function handleCreateLink() {
    if (noScenario) {
      setError("Select a project and scenario first (use the Scenarios panel).");
      return;
    }
    if (!linkName || !selectedGeoId || !selectedDsId) {
      setError("Link name, geometry file, and dataset are all required.");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const layer = await createLayer({
        project:         scenarioProp.project,
        scenario:        scenarioProp.scenario,
        geometry_id:     Number(selectedGeoId),
        name:            linkName,
        deck_layer_type: "GeoJsonLayer",
      });

      await attachDatasetToLayer(layer.id, {
        dataset_id:    Number(selectedDsId),
        geom_join_key: geomJoinKey || undefined,
        data_join_key: isTimeseries ? undefined : (dataJoinKey || undefined),
      });

      setSuccess(`Link "${linkName}" created. Open the Layers panel to configure styling.`);
      setLinkName("");
      setSelectedGeoId("");
      setSelectedDsId("");
      setGeomJoinKey("");
      setDataJoinKey("");
      setGeoSchema(null);
      setDsSchema(null);
      onLinkCreated?.(layer);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Compute join key overlap between geometry feature values and dataset entity IDs.
  const overlapInfo = (() => {
    if (!geoSchema || !dsSchema || !geomJoinKey) return null;
    const geoValues = new Set(geoSchema.unique_values?.[geomJoinKey] ?? []);
    if (geoValues.size === 0) return null;

    if (isTimeseries) {
      const dsEntities = (dsSchema.columns ?? []).filter(c => c !== dsSchema.suggested_timestamp_col);
      if (dsEntities.length === 0) return null;
      const overlap = dsEntities.filter(e => geoValues.has(e));
      return { geoCount: geoValues.size, dsCount: dsEntities.length, overlapCount: overlap.length };
    }
    return null;
  })();

  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      {noScenario && (
        <Typography variant="body2" color="warning.main">
          Select a project and scenario in the Scenarios panel before linking files.
        </Typography>
      )}

      <TextField
        label="Link Name"
        value={linkName}
        onChange={e => setLinkName(e.target.value)}
        fullWidth
        size="small"
        required
        disabled={noScenario}
      />

      {/* Geometry selector */}
      <Stack direction="row" spacing={1} alignItems="center">
        <TerrainIcon color="action" fontSize="small" />
        <FormControl fullWidth size="small" required disabled={noScenario}>
          <InputLabel>Geometry File</InputLabel>
          <Select
            value={selectedGeoId}
            label="Geometry File"
            onChange={e => setSelectedGeoId(e.target.value)}
          >
            {geometryFiles.length === 0
              ? <MenuItem value="" disabled>No geometry files uploaded</MenuItem>
              : geometryFiles.map(g => (
                  <MenuItem key={g.id} value={g.id}>
                    {g.display_name || g.name}
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      ({g.format})
                    </Typography>
                  </MenuItem>
                ))
            }
          </Select>
        </FormControl>
      </Stack>

      {/* Compatible datasets (from join hints) */}
      {selectedGeoId && joinHints.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary" fontWeight={600}>
            Compatible Datasets (auto-detected)
          </Typography>
          <Stack spacing={0.5}>
            {joinHints.map(hint => (
              <Button
                key={hint.id}
                variant={String(hint.dataset_id) === String(selectedDsId) ? "contained" : "outlined"}
                size="small"
                fullWidth
                sx={{ justifyContent: "space-between", textTransform: "none" }}
                onClick={() => {
                  setSelectedDsId(String(hint.dataset_id));
                  setGeomJoinKey(hint.geometry_key);
                  setDataJoinKey(hint.dataset_column);
                  if (!linkName) setLinkName(hint.dataset?.name || "");
                }}
              >
                <span>{hint.dataset?.name || `Dataset #${hint.dataset_id}`}</span>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Chip
                    label={`${hint.geometry_key} → ${hint.dataset_column}`}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: 10 }}
                  />
                  <Chip
                    label={`${Math.round(hint.overlap * 100)}%`}
                    size="small"
                    color={hint.overlap > 0.8 ? "success" : hint.overlap > 0.5 ? "warning" : "default"}
                  />
                </Stack>
              </Button>
            ))}
          </Stack>
          <Divider />
        </>
      )}

      {/* Dataset selector (manual) */}
      <Stack direction="row" spacing={1} alignItems="center">
        <TableChartIcon color="action" fontSize="small" />
        <FormControl fullWidth size="small" required disabled={noScenario}>
          <InputLabel>Dataset</InputLabel>
          <Select
            value={selectedDsId}
            label="Dataset"
            onChange={e => setSelectedDsId(e.target.value)}
          >
            {datasets.map(d => (
              <MenuItem key={d.id} value={d.id}>
                {d.name}
                <Chip
                  label={d.timestamp_col ? "timeseries" : "static"}
                  size="small"
                  sx={{ ml: 1 }}
                  variant="outlined"
                />
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {/* Join key selectors — shown when both files are selected */}
      {selectedGeoId && selectedDsId && (
        <>
          <Divider />
          <Typography variant="caption" color="text.secondary">
            Join keys for this link. Pre-filled from file defaults — override per-link if
            this dataset joins on a different property.
          </Typography>

          <SchemaSelect
            label="Geometry join key"
            value={geomJoinKey}
            onChange={setGeomJoinKey}
            options={geoOptions}
            helperText="Feature property to match on"
            loading={schemaLoading && !geoSchema}
          />

          {isTimeseries ? (
            <Typography variant="caption" color="text.secondary">
              Timeseries dataset: column names are entity IDs (joined to geometry key above)
            </Typography>
          ) : (
            <SchemaSelect
              label="Dataset join key"
              value={dataJoinKey}
              onChange={setDataJoinKey}
              options={dsColOptions}
              helperText="Dataset column to match on"
              loading={schemaLoading && !dsSchema}
            />
          )}

          {dsSchema?.suggested_timestamp_col && (
            <Typography variant="caption" color="text.secondary">
              Detected timestamp column:{" "}
              <strong>{dsSchema.suggested_timestamp_col}</strong>
              {" "}({dsSchema.dtypes?.[dsSchema.suggested_timestamp_col]})
            </Typography>
          )}

          {overlapInfo && (
            <Typography
              variant="caption"
              color={overlapInfo.overlapCount === 0 ? "error" : overlapInfo.overlapCount < overlapInfo.geoCount * 0.5 ? "warning.main" : "success.main"}
            >
              Join key overlap: <strong>{overlapInfo.overlapCount}</strong> of {overlapInfo.geoCount} geometry features
              match {overlapInfo.dsCount} dataset entities
              {overlapInfo.overlapCount === 0 && " — wrong join key?"}
            </Typography>
          )}
        </>
      )}

      <Divider />

      <Button
        variant="contained"
        startIcon={saving ? <CircularProgress size={16} /> : <LinkIcon />}
        onClick={handleCreateLink}
        disabled={saving || noScenario || !linkName || !selectedGeoId || !selectedDsId}
        fullWidth
      >
        Create Link
      </Button>

      {error   && <Typography color="error"        variant="body2">{error}</Typography>}
      {success && <Typography color="success.main" variant="body2">{success}</Typography>}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// DataManager
// ---------------------------------------------------------------------------

/**
 * DataManager
 *
 * Three-tab panel for managing geospatial + tabular files and creating layer
 * associations between them.
 *
 * Props:
 *   scenarioProp      – { project, scenario }
 *   onLayerCreated    – (layer) => void   called after Associate creates a layer
 */
export default function DataManager({ scenarioProp, onLayerCreated, onInspectData }) {
  const [tab,           setTab]           = useState(0);
  const [geometryFiles, setGeometryFiles] = useState([]);
  const [datasets,      setDatasets]      = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [uploadType,    setUploadType]    = useState(null); // 'geometry' | 'dataset'

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [geos, dsets] = await Promise.all([fetchGeometryFiles(), fetchDatasets()]);
      setGeometryFiles(Array.isArray(geos) ? geos : []);
      setDatasets(Array.isArray(dsets) ? dsets : []);
    } catch (e) {
      console.error("[DataManager] refresh error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function handleUploaded(_record) {
    refresh();
  }

  return (
    <Paper elevation={1} sx={{ width: 620, maxHeight: 740, overflowX: "hidden", overflowY: "auto", borderRadius: 2 }}>
      {/* Header */}
      <Stack direction="row" alignItems="center" bgcolor="primary.main" sx={{ px: 1, py: 0.25 }}>
        <Typography
          variant="subtitle1"
          fontWeight={600}
          color="primary.contrastText"
          sx={{ flex: 1, textAlign: "center" }}
        >
          Data Catalog
        </Typography>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={refresh} sx={{ color: "primary.contrastText" }}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Tab bar */}
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="fullWidth"
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Tab icon={<TerrainIcon fontSize="small" />} iconPosition="start" label="Geometry" />
        <Tab icon={<TableChartIcon fontSize="small" />} iconPosition="start" label="Datasets" />
        <Tab icon={<LinkIcon fontSize="small" />} iconPosition="start" label="Link" />
      </Tabs>

      <Box sx={{ p: 2 }}>
        {tab === 0 && (
          <GeometryTab
            geometryFiles={geometryFiles}
            loading={loading}
            onUploadClick={() => setUploadType("geometry")}
            onGeometryUpdated={refresh}
            onQuickLayer={onLayerCreated}
            onInspectData={onInspectData}
          />
        )}
        {tab === 1 && (
          <DatasetTab
            datasets={datasets}
            loading={loading}
            onUploadClick={() => setUploadType("dataset")}
            onDatasetUpdated={refresh}
            onInspectData={onInspectData}
          />
        )}
        {tab === 2 && (
          <AssociateTab
            geometryFiles={geometryFiles}
            datasets={datasets}
            scenarioProp={scenarioProp}
            onLinkCreated={onLayerCreated}
          />
        )}
      </Box>

      {/* Upload dialogs */}
      <UploadDialog
        open={uploadType === "geometry"}
        type="geometry"
        onClose={() => setUploadType(null)}
        onUploaded={handleUploaded}
      />
      <UploadDialog
        open={uploadType === "dataset"}
        type="dataset"
        onClose={() => setUploadType(null)}
        onUploaded={handleUploaded}
      />
    </Paper>
  );
}
