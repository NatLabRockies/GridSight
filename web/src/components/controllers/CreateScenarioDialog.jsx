import React, { useRef, useEffect } from "react";
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
import Chip from "@mui/material/Chip";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import FormControlLabel from "@mui/material/FormControlLabel";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import { uploadToExtension, fetchExtensionUploadSpecs } from "../../lib/loaders.js";
import { isTauri, pickFilesNative } from "../../lib/desktopBridge.js";
import UploadProgressPane from "./UploadProgressPane.jsx";
import { useCreateScenarioFormState } from '../../state/createScenarioFormState.js';
import { useUploadProgress } from '../../state/uploadProgressState.js';

/**
 * CreateScenarioDialog
 *
 * Dialog for creating a new GAT scenario by uploading a system JSON
 * (or choosing an existing one) and one or more HDF5 simulation files.
 *
 * Props:
 *   open       – boolean
 *   onClose    – () => void
 *   onCreated  – (result) => void  called after successful creation
 *   extension  – { name, display_name, ... }
 */
export default function CreateScenarioDialog({ open, onClose, onCreated, extension }) {
  const extName = extension?.name ?? "gat";
  const systemFileRef = useRef(null);
  const simFilesRef = useRef(null);

  const form = useCreateScenarioFormState();
  const upload = useUploadProgress();

  // Upload progress (XHR-driven). `phase` distinguishes the byte-level
  // upload from the server-side ingest job phases. While 'uploading',
  // loaded/total drive the determinate bar; rateBytesPerSec is a
  // smoothed throughput estimate used for the rate + ETA readouts.
  const rateSampleRef = useRef({ ts: 0, loaded: 0, ema: 0 });
  const abortRef = useRef(null);

  // Load upload spec and existing systems when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    form.setLoadingSpec(true);
    fetchExtensionUploadSpecs(extName)
      .then((specs) => {
        if (cancelled) return;
        form.setSpec(specs?.[0] ?? null);
      })
      .catch((e) => console.error("[CreateScenarioDialog] fetch specs error:", e))
      .finally(() => { if (!cancelled) form.setLoadingSpec(false); });
    return () => { cancelled = true; };
  }, [open, extName]);

  const existingSystems = form.state.spec?.existing_systems ?? [];

  function reset() {
    form.reset();
    upload.reset();
    rateSampleRef.current = { ts: 0, loaded: 0, ema: 0 };
    abortRef.current = null;
  }

  function handleClose() {
    // If an upload is in flight, cancel it before resetting state.
    if (upload.state.saving && abortRef.current) {
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

  function handleSystemFileChange(e) {
    const f = e.target.files?.[0];
    if (f) form.setSystemFile(f);
  }

  function handleSimFilesChange(e) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) form.setSimFiles([...form.state.simFiles, ...files]);
  }

  // Tauri-mode pickers — open the native dialog and store File-shaped
  // objects with a ``.path`` field. ``uploadToExtension`` detects the
  // path and short-circuits to the ``/upload-local`` JSON endpoint, so
  // the multi-GB multipart body never goes through the wry custom URL
  // scheme handler (which overflows on macOS WKWebView for large
  // bodies).
  async function pickSystemFileNative() {
    try {
      const files = await pickFilesNative({
        multiple: false,
        title: 'Select system JSON',
        filters: [{ name: 'System JSON', extensions: ['json'] }],
      });
      if (files.length > 0) form.setSystemFile(files[0]);
    } catch (e) {
      upload.error(`Could not open file dialog: ${e}`);
    }
  }

  async function pickSimFilesNative() {
    try {
      const files = await pickFilesNative({
        multiple: true,
        title: 'Select simulation HDF5 files',
        filters: [{ name: 'HDF5', extensions: ['h5', 'hdf5', 'h5.gz'] }],
      });
      if (files.length > 0) form.setSimFiles([...form.state.simFiles, ...files]);
    } catch (e) {
      upload.error(`Could not open file dialog: ${e}`);
    }
  }

  function removeSimFile(index) {
    form.setSimFiles(form.state.simFiles.filter((_, i) => i !== index));
  }

  async function handleCreate() {
    const { projectName, scenarioName, description, systemMode, systemFile, existingSystemPath, simFiles } = form.state;
    if (!projectName.trim()) { upload.error("Project name is required."); return; }
    if (!scenarioName.trim()) { upload.error("Scenario name is required."); return; }
    if (systemMode === "upload" && !systemFile) { upload.error("Select a system JSON file."); return; }
    if (systemMode === "existing" && !existingSystemPath) { upload.error("Select an existing system file."); return; }
    if (simFiles.length === 0) { upload.error("Add at least one simulation HDF5 file."); return; }

    upload.startUploading("Uploading files…");
    rateSampleRef.current = { ts: Date.now(), loaded: 0, ema: 0 };
    const abortController = new AbortController();
    abortRef.current = abortController;
    try {
      const fileGroups = { simulation_files: simFiles };
      if (systemMode === "upload") {
        fileGroups.system_file = [systemFile];
      }

      const formData = {
        project_name: projectName.trim(),
        scenario_name: scenarioName.trim(),
      };
      if (description.trim()) {
        formData.description = description.trim();
      }
      if (systemMode === "existing") {
        formData.existing_system_path = existingSystemPath;
      }

      const result = await uploadToExtension(extName, "sienna_scenario", fileGroups, formData, {
        signal: abortController.signal,
        onProgress: (p) => {
          if (p?.phase === "uploading") {
            const now = Date.now();
            const sample = rateSampleRef.current;
            // Throughput estimate: instantaneous bytes/sec smoothed via EMA
            // (alpha=0.3) so the readout doesn't twitch on every event.
            // Sample at most ~5x/sec so very fast bursts don't dominate.
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
            upload.uploadProgress(p.loaded, p.total);
          } else if (p?.phase === "pending") {
            upload.pending("Queued on server…");
          } else if (p?.phase === "running") {
            const startedAt = p.job?.started_at;
            const elapsed = startedAt
              ? Math.max(0, Math.round(Date.now() / 1000 - startedAt))
              : 0;
            upload.running(`Ingesting on server… (${elapsed}s)`);
          }
        },
      });

      if (result.success) {
        onCreated?.(result);
        reset();
        onClose();
      } else {
        upload.error(result.error || "Upload failed.");
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        upload.error("Upload canceled.");
      } else {
        upload.error(String(e?.message || e));
      }
    } finally {
      abortRef.current = null;
    }
  }

  const hasExisting = existingSystems.length > 0;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Create New Scenario</DialogTitle>

      <DialogContent dividers>
        {form.state.loadingSpec ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Stack spacing={2.5}>
            {/* Project & Scenario names */}
            <Autocomplete
              freeSolo
              options={extension?.projects ?? []}
              value={form.state.projectName}
              onChange={(_e, newValue) => form.setProjectName(newValue ?? "")}
              onInputChange={(_e, newInput) => form.setProjectName(newInput)}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Project"
                  required
                  size="small"
                  helperText="Select an existing project or type a new name"
                />
              )}
            />

            <TextField
              label="Scenario Name"
              value={form.state.scenarioName}
              onChange={(e) => form.setScenarioName(e.target.value)}
              fullWidth
              required
              size="small"
            />

            <TextField
              label="Description"
              value={form.state.description}
              onChange={(e) => form.setDescription(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={2}
              maxRows={4}
              helperText="Describe this scenario (optional)"
            />

            {/* System JSON section */}
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                System Definition (JSON)
              </Typography>

              {hasExisting && (
                <RadioGroup
                  row
                  value={form.state.systemMode}
                  onChange={(e) => {
                    form.setSystemMode(e.target.value);
                    if (e.target.value === "existing") form.setSystemFile(null);
                    if (e.target.value === "upload") form.setExistingSystemPath("");
                  }}
                  sx={{ mb: 1 }}
                >
                  <FormControlLabel value="upload" control={<Radio size="small" />} label="Upload new" />
                  <FormControlLabel value="existing" control={<Radio size="small" />} label="Use existing" />
                </RadioGroup>
              )}

              {form.state.systemMode === "upload" ? (
                <Box>
                  <input
                    ref={systemFileRef}
                    type="file"
                    accept=".json"
                    style={{ display: "none" }}
                    onChange={handleSystemFileChange}
                  />
                  <Button
                    variant="outlined"
                    startIcon={<CloudUploadIcon />}
                    onClick={() => (isTauri() ? pickSystemFileNative() : systemFileRef.current?.click())}
                    fullWidth
                    size="small"
                  >
                    {form.state.systemFile ? form.state.systemFile.name : "Choose system JSON…"}
                  </Button>
                </Box>
              ) : (
                <FormControl fullWidth size="small">
                  <InputLabel>Existing system file</InputLabel>
                  <Select
                    value={form.state.existingSystemPath}
                    label="Existing system file"
                    onChange={(e) => form.setExistingSystemPath(e.target.value)}
                  >
                    {existingSystems.map((sys) => (
                      <MenuItem key={sys.system_path} value={sys.system_path}>
                        <Stack direction="column" spacing={0}>
                          <Typography variant="body2">{sys.label}</Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.7rem' }}>
                            {sys.system_path}
                          </Typography>
                        </Stack>
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
            </Box>

            {/* Simulation HDF5 files */}
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Simulation Results (HDF5)
              </Typography>
              <input
                ref={simFilesRef}
                type="file"
                accept=".h5,.hdf5"
                multiple
                style={{ display: "none" }}
                onChange={handleSimFilesChange}
              />
              <Button
                variant="outlined"
                startIcon={<CloudUploadIcon />}
                onClick={() => (isTauri() ? pickSimFilesNative() : simFilesRef.current?.click())}
                fullWidth
                size="small"
              >
                Add HDF5 files…
              </Button>

              {form.state.simFiles.length > 0 && (
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 1 }}>
                  {form.state.simFiles.map((f, i) => (
                    <Chip
                      key={`${f.name}-${i}`}
                      label={f.name}
                      size="small"
                      onDelete={() => removeSimFile(i)}
                    />
                  ))}
                </Box>
              )}
            </Box>

            {upload.state.error && <Alert severity="error" variant="outlined">{upload.state.error}</Alert>}

            {upload.state.saving && (
              <UploadProgressPane
                phase={upload.state.phase}
                loaded={upload.state.loaded}
                total={upload.state.total}
                rateBytesPerSec={upload.state.rateBytesPerSec}
                message={upload.state.message}
              />
            )}
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        {upload.state.saving && upload.state.phase === "uploading" ? (
          <Button onClick={handleCancelUpload} color="warning">Cancel upload</Button>
        ) : (
          <Button onClick={handleClose} disabled={upload.state.saving}>Cancel</Button>
        )}
        <Button
          variant="contained"
          onClick={handleCreate}
          disabled={upload.state.saving || form.state.loadingSpec}
        >
          {upload.state.saving ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} color="inherit" />
              <span>
                {upload.state.phase === "uploading"
                  ? "Uploading…"
                  : (upload.state.message || "Creating…")}
              </span>
            </Stack>
          ) : "Create Scenario"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
