import { useRef, useEffect } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import {
  fetchExtensionUploadSpecs,
  previewExtensionUpload,
  uploadToExtension,
} from "../../lib/loaders.js";
import UploadProgressPane from "./UploadProgressPane.jsx";
import { useBusGeometryFormState } from '../../state/busGeometryFormState.js';
import { useUploadProgress } from '../../state/uploadProgressState.js';
import { isTauri, pickFilesNative } from "../../lib/desktopBridge.js";

/**
 * BusGeometryDialog — attach lat/lon to an existing GAT system.
 *
 * Two-step flow:
 *   1. User picks a CSV or GeoJSON. We POST to /preview to fetch detected
 *      columns, sample rows, and a join-match preview.
 *   2. User confirms (or overrides) the column mapping; we commit via
 *      uploadToExtension('gat', 'bus_geometry', …).
 *
 * Props:
 *   open       – boolean
 *   onClose    – () => void
 *   onCreated  – (result) => void   called after successful commit
 *   project    – string (current GAT project)
 *   scenario   – string (current GAT scenario; used to resolve system_path)
 *   extension  – { name } the extension; defaults to "gat"
 */
export default function BusGeometryDialog({ open, onClose, onCreated, project, scenario, extension }) {
  const extName = extension?.name ?? "gat";

  const form = useBusGeometryFormState();
  const upload = useUploadProgress();

  const fileRef = useRef(null);
  const rateSampleRef = useRef({ ts: 0, loaded: 0, ema: 0 });
  const abortRef = useRef(null);

  const { spec: _spec, loadingSpec, file, preview, previewing, previewError,
    busIdCol, latCol, lonCol, systemBusIdCol, reMatching } = form.state;
  const { phase: uploadPhase, loaded: uploadLoaded, total: uploadTotal,
    rateBytesPerSec, message: progressMsg, error, saving } = upload.state;

  // Fetch upload specs on open — we need spec.meta.scenario_systems to map
  // (project, scenario) → system_path. The list is keyed by `{p}/{s}`.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    form.setLoadingSpec(true);
    fetchExtensionUploadSpecs(extName)
      .then((specs) => {
        if (cancelled) return;
        const s = (specs || []).find((x) => x.name === "bus_geometry");
        form.setSpec(s ?? null);
      })
      .catch((e) => console.error("[BusGeometryDialog] fetch specs error:", e))
      .finally(() => { if (!cancelled) form.setLoadingSpec(false); });
    return () => { cancelled = true; };
  }, [open, extName]);

  // Project scope: bus geo lives at the project level, not per-scenario.
  // The dialog only needs the active project name; the extension picks a
  // representative system file under it for join validation.
  const projectName = project || "";

  // Re-run preview when any column choice changes (debounced) so the
  // match-count chip reflects the actual mapping rather than the
  // initial auto-detected one. Skip until the first preview has
  // populated everything; skip if the file or scenario isn't ready.
  useEffect(() => {
    if (!file || !preview || !projectName) return;
    if (!busIdCol) return;
    // Required CSV-only fields: skip if the user hasn't picked them yet.
    if (preview.kind === "csv" && (!latCol || !lonCol)) return;
    let cancelled = false;
    form.setReMatching(true);
    const t = setTimeout(async () => {
      try {
        const data = await previewExtensionUpload(
          extName, "bus_geometry",
          { geo_file: [file] },
          {
            project: projectName,
            bus_id_column: busIdCol,
            ...(preview.kind === "csv" ? { lat_column: latCol, lon_column: lonCol } : {}),
            ...(systemBusIdCol ? { system_bus_id_column: systemBusIdCol } : {}),
          },
        );
        if (cancelled) return;
        // Merge: keep file-side fields stable, refresh match_preview +
        // system_bus_columns so any changes flow through.
        form.patch({ preview: { ...(preview || {}), ...data } });
      } catch (e) {
        if (!cancelled) {
          // Surface as preview error but keep the existing data so the
          // user can keep adjusting columns.
          form.setPreviewError(String(e?.message || e));
        }
      } finally {
        if (!cancelled) form.setReMatching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); form.setReMatching(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busIdCol, latCol, lonCol, systemBusIdCol]);

  function reset() {
    form.reset();
    upload.reset();
    rateSampleRef.current = { ts: 0, loaded: 0, ema: 0 };
    abortRef.current = null;
  }

  function handleClose() {
    if (saving && abortRef.current) {
      try { abortRef.current.abort(); } catch { /* noop */ }
    }
    reset();
    onClose();
  }

  function handleCancelUpload() {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { /* noop */ }
    }
  }

  async function handleFileChange(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    await ingestSelectedFile(f);
  }

  // Tauri-mode picker. Returns a File-shaped object with ``.path`` set
  // so ``previewExtensionUpload`` + ``uploadToExtension`` route to the
  // ``/preview-local`` and ``/upload-local`` endpoints — keeps multi-MB
  // GeoJSON bytes out of wry's custom URL scheme handler.
  async function pickFileNative() {
    try {
      const files = await pickFilesNative({
        multiple: false,
        title: 'Select bus-geometry CSV or GeoJSON',
        filters: [{ name: 'Geometry', extensions: ['csv', 'geojson', 'json'] }],
      });
      if (files.length > 0) await ingestSelectedFile(files[0]);
    } catch (err) {
      form.setPreviewError(String(err?.message || err));
    }
  }

  async function ingestSelectedFile(f) {
    form.patch({ file: f, preview: null, previewError: "", previewing: true });
    try {
      const data = await previewExtensionUpload(
        extName, "bus_geometry",
        { geo_file: [f] },
        projectName ? { project: projectName } : {},
      );
      form.patch({
        preview: data,
        busIdCol: data?.detected_id_col || "",
        latCol: data?.detected_lat_col || "",
        lonCol: data?.detected_lon_col || "",
        systemBusIdCol: data?.detected_system_bus_col || data?.match_preview?.used_system_column || "",
      });
    } catch (err) {
      form.setPreviewError(String(err?.message || err));
    } finally {
      form.setPreviewing(false);
    }
  }

  async function handleCommit() {
    if (!file) { upload.error("Pick a file first."); return; }
    if (!projectName) { upload.error("No project selected."); return; }
    if (!busIdCol) { upload.error("Pick a bus-ID column."); return; }
    if (preview?.kind === "csv" && (!latCol || !lonCol)) {
      upload.error("Pick latitude and longitude columns.");
      return;
    }

    upload.startUploading("Uploading…");
    rateSampleRef.current = { ts: Date.now(), loaded: 0, ema: 0 };
    const abortController = new AbortController();
    abortRef.current = abortController;
    try {
      const formData = {
        project: projectName,
        bus_id_column: busIdCol,
      };
      if (preview?.kind === "csv") {
        formData.lat_column = latCol;
        formData.lon_column = lonCol;
      }
      if (systemBusIdCol) {
        formData.system_bus_id_column = systemBusIdCol;
      }
      const result = await uploadToExtension(
        extName, "bus_geometry",
        { geo_file: [file] },
        formData,
        {
          signal: abortController.signal,
          onProgress: (p) => {
            if (p?.phase === "uploading") {
              const now = Date.now();
              const sample = rateSampleRef.current;
              if (sample.ts && now - sample.ts >= 200) {
                const dt = (now - sample.ts) / 1000;
                const dBytes = p.loaded - sample.loaded;
                if (dt > 0 && dBytes >= 0) {
                  const inst = dBytes / dt;
                  const ema = sample.ema > 0 ? sample.ema * 0.7 + inst * 0.3 : inst;
                  rateSampleRef.current = { ts: now, loaded: p.loaded, ema };
                  upload.setRate(ema);
                }
              } else if (!sample.ts) {
                rateSampleRef.current = { ts: now, loaded: p.loaded, ema: 0 };
              }
              upload.uploadProgress(p.loaded, p.total ?? 0);
            } else if (p?.phase === "pending") {
              upload.pending("Queued on server…");
            } else if (p?.phase === "running") {
              upload.running("Joining geometry on server…");
            }
          },
        },
      );
      if (result.success) {
        upload.success();
        onCreated?.(result);
        reset();
        onClose();
      } else {
        upload.error(result.error || "Upload failed.");
      }
    } catch (e) {
      if (e?.name === "AbortError") upload.error("Upload canceled.");
      else upload.error(String(e?.message || e));
    } finally {
      abortRef.current = null;
    }
  }

  const matchPreview = preview?.match_preview;
  const isCsv = preview?.kind === "csv";

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add Bus Geometry</DialogTitle>

      <DialogContent dividers>
        {loadingSpec ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        ) : !projectName ? (
          <Alert severity="warning">
            No project selected. Bus geometry is shared across all
            scenarios in a project — pick one in the sidebar first.
          </Alert>
        ) : (
          <Stack spacing={2.5}>
            <Typography variant="body2" color="text.secondary">
              Attaching bus geometry to project <b>{projectName}</b>.
              Coords apply to every scenario in this project — same
              physical system, different parameter sets. Upload a CSV
              with bus-ID + lat/lon columns, or a GeoJSON FeatureCollection
              of Point features keyed by a property. Generator and
              transmission-line geometries are derived per scenario from
              the system's component graph.
            </Typography>

            <Box>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.geojson,.json"
                style={{ display: "none" }}
                onChange={handleFileChange}
              />
              <Button
                variant="outlined"
                startIcon={<CloudUploadIcon />}
                onClick={() => (isTauri() ? pickFileNative() : fileRef.current?.click())}
                fullWidth
                size="small"
              >
                {file ? file.name : "Choose CSV or GeoJSON…"}
              </Button>
            </Box>

            {previewing && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={16} />
                <Typography variant="caption" color="text.secondary">
                  Reading file…
                </Typography>
              </Stack>
            )}

            {previewError && <Alert severity="error" variant="outlined">{previewError}</Alert>}

            {preview && (
              <>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    size="small"
                    label={preview.kind?.toUpperCase()}
                    color="default"
                    variant="outlined"
                  />
                  <Typography variant="caption" color="text.secondary">
                    {preview.row_count} {preview.kind === "csv" ? "rows" : "features"}
                    {preview.columns?.length > 0 && ` · ${preview.columns.length} columns`}
                  </Typography>
                </Stack>

                <Stack direction="row" spacing={1}>
                  <FormControl fullWidth size="small">
                    <InputLabel>{isCsv ? "Your CSV: bus ID column" : "Your GeoJSON: bus ID property"}</InputLabel>
                    <Select
                      value={busIdCol}
                      label={isCsv ? "Your CSV: bus ID column" : "Your GeoJSON: bus ID property"}
                      onChange={(e) => form.setBusIdCol(e.target.value)}
                    >
                      {(preview.columns || []).map((c) => (
                        <MenuItem key={c} value={c}>
                          {c}
                          {c === preview.detected_id_col && (
                            <Chip label="detected" size="small" color="success" variant="outlined" sx={{ ml: 1 }} />
                          )}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Box sx={{ display: "flex", alignItems: "center", color: "text.secondary", px: 0.5 }}>
                    <Typography variant="body2">→</Typography>
                  </Box>
                  <FormControl fullWidth size="small">
                    <InputLabel>System bus column</InputLabel>
                    <Select
                      value={systemBusIdCol}
                      label="System bus column"
                      onChange={(e) => form.setSystemBusIdCol(e.target.value)}
                    >
                      {(preview.system_bus_columns || []).map((c) => (
                        <MenuItem key={c} value={c}>
                          {c}
                          {c === preview.detected_system_bus_col && (
                            <Chip label="suggested" size="small" color="success" variant="outlined" sx={{ ml: 1 }} />
                          )}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Stack>

                {isCsv && (
                  <>
                    <FormControl fullWidth size="small">
                      <InputLabel>Latitude column</InputLabel>
                      <Select
                        value={latCol}
                        label="Latitude column"
                        onChange={(e) => form.setLatCol(e.target.value)}
                      >
                        {(preview.columns || []).map((c) => (
                          <MenuItem key={c} value={c}>
                            {c}
                            {c === preview.detected_lat_col && (
                              <Chip label="detected" size="small" color="success" variant="outlined" sx={{ ml: 1 }} />
                            )}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl fullWidth size="small">
                      <InputLabel>Longitude column</InputLabel>
                      <Select
                        value={lonCol}
                        label="Longitude column"
                        onChange={(e) => form.setLonCol(e.target.value)}
                      >
                        {(preview.columns || []).map((c) => (
                          <MenuItem key={c} value={c}>
                            {c}
                            {c === preview.detected_lon_col && (
                              <Chip label="detected" size="small" color="success" variant="outlined" sx={{ ml: 1 }} />
                            )}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </>
                )}

                {matchPreview && (
                  <Alert
                    severity={
                      matchPreview.matched > 0
                        && matchPreview.matched >= 0.5 * (matchPreview.system_bus_count || 1)
                        ? "success" : "warning"
                    }
                    variant="outlined"
                    icon={reMatching ? <CircularProgress size={18} /> : undefined}
                  >
                    Matched {matchPreview.matched} of {matchPreview.system_bus_count} system buses
                    {matchPreview.used_system_column && (
                      <> on <code>{matchPreview.used_system_column}</code></>
                    )}.
                    {matchPreview.unmatched_input > 0
                      && ` ${matchPreview.unmatched_input} input rows didn't match.`}
                    {matchPreview.unmatched_input_examples?.length > 0 && (
                      <Box sx={{ mt: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">
                          Unmatched examples: {matchPreview.unmatched_input_examples.slice(0, 5).join(", ")}
                        </Typography>
                      </Box>
                    )}
                  </Alert>
                )}
              </>
            )}

            {error && <Alert severity="error" variant="outlined">{error}</Alert>}

            {saving && (
              <UploadProgressPane
                phase={uploadPhase}
                loaded={uploadLoaded}
                total={uploadTotal}
                rateBytesPerSec={rateBytesPerSec}
                message={progressMsg}
              />
            )}
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        {saving && uploadPhase === "uploading" ? (
          <Button onClick={handleCancelUpload} color="warning">Cancel upload</Button>
        ) : (
          <Button onClick={handleClose} disabled={saving}>Cancel</Button>
        )}
        <Button
          variant="contained"
          onClick={handleCommit}
          disabled={!preview || saving || previewing || !projectName}
        >
          {saving ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} color="inherit" />
              <span>{uploadPhase === "uploading" ? "Uploading…" : (progressMsg || "Working…")}</span>
            </Stack>
          ) : "Commit"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
