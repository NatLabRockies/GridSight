import React, { useState, useEffect } from "react";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { deleteExtensionScenario, queryExtension } from "../../lib/loaders.js";

async function fetchScenarios(project) {
  const response = await fetch(`/api/projects/${encodeURIComponent(project)}`, {
    credentials: "include",
  });
  if (!response.ok)
    throw new Error(`Failed to fetch scenarios: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : (data?.body ?? []);
}

/**
 * Compact project/scenario picker for inline use in the sidebar extension collapse.
 *
 * Props:
 *   extension     { name, projects, ... }
 *   scenarioProp  { project, scenario }
 *   onChange       (newScenarioProp) => void
 */
export default function ExtensionScenarioPicker({ extension, scenarioProp, onChange }) {
  const projects = extension.projects ?? [];
  const [scenarios, setScenarios] = useState([]);
  const [loadingScenarios, setLoadingScenarios] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null); // { project, scenario } | null
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Model dropdown — Sienna H5 files contain multiple optimization
  // stages (UC / RAUC / Emulation Model / ...); each is ingested into
  // its own DuckDB schema. The dropdown lists models the backend has
  // ingested for this (project, scenario); switching flips the
  // ``is_default`` flag in the registry so every subsequent query
  // resolves to the chosen model without threading a ``model=`` param
  // through every endpoint. Only relevant for GAT today.
  const supportsModels = extension.name === "gat";
  const [models, setModels] = useState([]); // [{model, status, is_default}]
  const [switchingModel, setSwitchingModel] = useState(false);

  const refreshModels = async () => {
    if (!supportsModels) return;
    if (!scenarioProp.project || !scenarioProp.scenario) {
      setModels([]);
      return;
    }
    try {
      const res = await queryExtension(extension.name, "available_models", {
        project: scenarioProp.project,
        scenario: scenarioProp.scenario,
      });
      setModels(Array.isArray(res?.models) ? res.models : []);
    } catch (e) {
      console.warn("[ExtensionScenarioPicker] available_models:", e);
      setModels([]);
    }
  };

  const refreshScenarios = async (project) => {
    if (!project) return [];
    setLoadingScenarios(true);
    try {
      const list = await fetchScenarios(project);
      setScenarios(list);
      return list;
    } finally {
      setLoadingScenarios(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const { project, scenario } = confirmDelete;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteExtensionScenario(extension.name, project, scenario);
      const remaining = await refreshScenarios(project);
      const next = remaining[0] || "";
      // Move off the deleted scenario before closing — if we were
      // viewing it, the parent app's downstream queries would otherwise
      // 404 against a now-missing schema.
      if (scenarioProp.scenario === scenario) {
        onChange({ ...scenarioProp, scenario: next });
      }
      setConfirmDelete(null);
    } catch (e) {
      console.error("[ExtensionScenarioPicker] delete failed:", e);
      setDeleteError(String(e?.message || e));
    } finally {
      setDeleting(false);
    }
  };

  // Auto-select first project if current selection isn't in this extension's projects
  useEffect(() => {
    if (projects.length > 0 && !projects.includes(scenarioProp.project)) {
      onChange({ ...scenarioProp, project: projects[0], scenario: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch scenarios when project changes OR when the parent forces the
  // selection onto a scenario name we don't yet have in the list (e.g.
  // immediately after a CreateScenarioDialog upload completes — App.jsx
  // calls updateScenarioState() with the brand-new scenario name, but
  // the project hasn't changed, so the project-only dependency below
  // wouldn't re-run on its own).
  useEffect(() => {
    if (!scenarioProp.project || !projects.includes(scenarioProp.project)) {
      setScenarios([]);
      return;
    }

    let cancelled = false;
    setLoadingScenarios(true);

    fetchScenarios(scenarioProp.project)
      .then((list) => {
        if (cancelled) return;
        setScenarios(list);
        if (!list.includes(scenarioProp.scenario) && list.length > 0) {
          onChange({ ...scenarioProp, scenario: list[0] });
        }
      })
      .catch((e) => console.error("[ExtensionScenarioPicker] fetchScenarios error:", e))
      .finally(() => { if (!cancelled) setLoadingScenarios(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioProp.project]);

  // After upload, the parent flips scenarioProp.scenario to the newly
  // created name. If it isn't in our cached list, the parent created
  // it just now — refetch so the dropdown shows the new entry.
  useEffect(() => {
    if (!scenarioProp.project || !scenarioProp.scenario) return;
    if (scenarios.includes(scenarioProp.scenario)) return;
    let cancelled = false;
    fetchScenarios(scenarioProp.project)
      .then((list) => { if (!cancelled) setScenarios(list); })
      .catch((e) => console.error("[ExtensionScenarioPicker] post-upload refetch:", e));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioProp.scenario]);

  // Re-fetch models when (project, scenario) settles.
  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioProp.project, scenarioProp.scenario]);

  const activeModel = (models.find((m) => m.is_default) || models[0] || {}).model || "";

  const handleModelChange = async (newModel) => {
    if (!newModel || newModel === activeModel) return;
    setSwitchingModel(true);
    try {
      await queryExtension(extension.name, "set_default_model", {
        project: scenarioProp.project,
        scenario: scenarioProp.scenario,
        model: newModel,
      });
      await refreshModels();
      // Force the parent to reload data against the new default model
      // by re-emitting the current scenario (same value triggers the
      // App.jsx scenario-change effect that rebuilds layers).
      onChange({ ...scenarioProp });
    } catch (e) {
      console.error("[ExtensionScenarioPicker] set_default_model:", e);
    } finally {
      setSwitchingModel(false);
    }
  };

  const canDelete = !!(scenarioProp.project && scenarioProp.scenario && projects.includes(scenarioProp.project));

  const projectValue = projects.includes(scenarioProp.project) ? scenarioProp.project : "";
  const scenarioValue = scenarios.includes(scenarioProp.scenario) ? scenarioProp.scenario : "";

  // Collapse the picker entirely for extensions that ship a single
  // project + single scenario — the dropdowns are noise when there's
  // nothing to choose. We still render the model selector + delete
  // affordance below.
  const singleOption = projects.length <= 1 && scenarios.length <= 1;

  return (
    <Stack spacing={0.5} sx={{ width: '100%', py: 0.5 }}>
      {!singleOption && (<>
      <FormControl size="small" fullWidth>
        <InputLabel id={`ext-proj-${extension.name}`}>Project</InputLabel>
        <Select
          labelId={`ext-proj-${extension.name}`}
          value={projectValue}
          label="Project"
          onChange={(e) => onChange({ ...scenarioProp, project: e.target.value, scenario: "" })}
        >
          {projects.map((name) => (
            <MenuItem key={name} value={name}>{name}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <Stack direction="row" spacing={0.5} alignItems="center">
        <FormControl size="small" sx={{ flex: 1 }}>
          <InputLabel id={`ext-scn-${extension.name}`}>Scenario</InputLabel>
          {loadingScenarios ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
              <CircularProgress size={18} />
            </Box>
          ) : (
            <Select
              labelId={`ext-scn-${extension.name}`}
              value={scenarioValue}
              label="Scenario"
              onChange={(e) => onChange({ ...scenarioProp, scenario: e.target.value })}
              disabled={!scenarioProp.project || scenarios.length === 0}
            >
              {scenarios.length === 0 && (
                <MenuItem value="" disabled>
                  {scenarioProp.project ? "No scenarios" : "Select project"}
                </MenuItem>
              )}
              {scenarios.map((name) => (
                <MenuItem key={name} value={name}>{name}</MenuItem>
              ))}
            </Select>
          )}
        </FormControl>
        <Tooltip title={canDelete ? "Delete scenario" : "Pick a scenario to delete"}>
          <span>
            <IconButton
              size="small"
              disabled={!canDelete}
              onClick={() => setConfirmDelete({
                project: scenarioProp.project,
                scenario: scenarioProp.scenario,
              })}
              aria-label="Delete scenario"
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      </>)}

      {/* Per-scenario optimization-model picker. Only shown for
          extensions that report multiple ingested models (today: GAT
          Sienna with UC / Emulation / etc.). Hidden otherwise to avoid
          a useless dropdown next to single-model extensions. */}
      {supportsModels && models.length > 1 && (
        <FormControl size="small" fullWidth>
          <InputLabel id={`ext-model-${extension.name}`}>Model</InputLabel>
          <Select
            labelId={`ext-model-${extension.name}`}
            value={activeModel}
            label="Model"
            disabled={switchingModel}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            {models.map((m) => (
              <MenuItem key={m.model} value={m.model}>
                {m.model}
                {m.status !== "ready" ? ` (${m.status})` : ""}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      <Dialog
        open={!!confirmDelete}
        onClose={() => !deleting && setConfirmDelete(null)}
      >
        <DialogTitle>Delete scenario?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will permanently remove <b>{confirmDelete?.project}/{confirmDelete?.scenario}</b>{' '}
            from the {extension.display_name || extension.name} extension. Underlying tables and
            registry entries are dropped and cannot be recovered without re-uploading the source files.
          </DialogContentText>
          {deleteError && (
            <Box sx={{ mt: 2, color: 'error.main', fontSize: '0.85rem' }}>
              {deleteError}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)} disabled={deleting}>Cancel</Button>
          <Button onClick={handleDelete} color="error" disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
