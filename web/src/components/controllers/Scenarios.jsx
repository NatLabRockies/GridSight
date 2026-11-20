import React, { useState, useEffect } from "react";
import Box from "@mui/material/Box";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import FormControl from "@mui/material/FormControl";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import CircularProgress from "@mui/material/CircularProgress";
import { useTheme } from "@mui/material/styles";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchProjects() {
  const response = await fetch("/api/projects", { credentials: "include" });
  if (!response.ok)
    throw new Error(`Failed to fetch projects: ${response.status}`);
  const data = await response.json();
  // The Bun proxy unwraps the Flask envelope, so data should already be an array.
  // Guard against the envelope leaking through anyway.
  return Array.isArray(data) ? data : (data?.body ?? []);
}

async function fetchScenarios(project) {
  const response = await fetch(`/api/projects/${encodeURIComponent(project)}`, {
    credentials: "include",
  });
  if (!response.ok)
    throw new Error(`Failed to fetch scenarios: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : (data?.body ?? []);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ScenarioPicker
 *
 * Renders two dropdowns – Project and Scenario – populated from the
 * /api/projects backend routes.
 *
 * On first load it automatically selects the first available project and its
 * first scenario so the map always starts with real data.
 *
 * Props:
 *   scenarioProp  { project: string, scenario: string }
 *   onChange      (newScenarioProp) => void
 */
export default function ScenarioPicker({ scenarioProp, onChange }) {
  useTheme(); // keep theme context active for child components

  const [projects, setProjects] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingScenarios, setLoadingScenarios] = useState(false);

  // ── Load project list on mount ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadingProjects(true);

    fetchProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);

        // Auto-select the first project if nothing valid is chosen yet
        const currentIsValid = list.includes(scenarioProp.project);
        if (!currentIsValid && list.length > 0) {
          onChange({ ...scenarioProp, project: list[0], scenario: "" });
        }
      })
      .catch((e) => console.error("[ScenarioPicker] fetchProjects error:", e))
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });

    return () => {
      cancelled = true;
    };
    // We only want this to run once on mount – onChange and scenarioProp
    // are intentionally excluded from the dep array to avoid re-fetching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load scenario list whenever the selected project changes ────────────
  useEffect(() => {
    if (!scenarioProp.project) {
      setScenarios([]);
      return;
    }

    let cancelled = false;
    setLoadingScenarios(true);

    fetchScenarios(scenarioProp.project)
      .then((list) => {
        if (cancelled) return;
        setScenarios(list);

        // Auto-select the first scenario if nothing valid is chosen yet
        const currentIsValid = list.includes(scenarioProp.scenario);
        if (!currentIsValid && list.length > 0) {
          onChange({ ...scenarioProp, scenario: list[0] });
        }
      })
      .catch((e) => console.error("[ScenarioPicker] fetchScenarios error:", e))
      .finally(() => {
        if (!cancelled) setLoadingScenarios(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioProp.project]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleProjectChange = (event) => {
    // Clear scenario so the scenario effect re-runs and auto-selects
    onChange({ ...scenarioProp, project: event.target.value, scenario: "" });
  };

  const handleScenarioChange = (event) => {
    onChange({ ...scenarioProp, scenario: event.target.value });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Material UI Select requires the current value to be present in the items
  // to render correctly. Fall back to '' so it shows the label placeholder
  // instead of an invisible mismatched value.
  const projectValue = projects.includes(scenarioProp.project)
    ? scenarioProp.project
    : "";
  const scenarioValue = scenarios.includes(scenarioProp.scenario)
    ? scenarioProp.scenario
    : "";

  return (
    <Paper sx={{ minWidth: 500, width: "100%", borderRadius: 2 }}>
      <Box sx={{ mb: 2 }}>
        <Typography
          align="center"
          variant="h6"
          fontWeight={600}
          bgcolor="primary.main"
          color="primary.contrastText"
          borderRadius={2}
        >
          Projects and Scenarios
        </Typography>
      </Box>

      <Stack
        direction="row"
        spacing={3}
        divider={<Divider orientation="vertical" flexItem />}
        sx={{ px: 2, pb: 2 }}
      >
        {/* ── Project selector ─────────────────────────────────────────── */}
        <Box sx={{ width: "40%" }}>
          <FormControl fullWidth>
            <InputLabel id="project-select-label">Project</InputLabel>
            {loadingProjects ? (
              <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <Select
                labelId="project-select-label"
                id="project-select"
                value={projectValue}
                label="Project"
                onChange={handleProjectChange}
                displayEmpty
              >
                {projects.length === 0 && (
                  <MenuItem value="" disabled>
                    No projects available
                  </MenuItem>
                )}
                {projects.map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </Select>
            )}
          </FormControl>
        </Box>

        {/* ── Scenario selector ────────────────────────────────────────── */}
        <Box sx={{ width: "40%" }}>
          <FormControl fullWidth>
            <InputLabel id="scenario-select-label">Scenario</InputLabel>
            {loadingScenarios ? (
              <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <Select
                labelId="scenario-select-label"
                id="scenario-select"
                value={scenarioValue}
                label="Scenario"
                onChange={handleScenarioChange}
                displayEmpty
                disabled={!scenarioProp.project || scenarios.length === 0}
              >
                {scenarios.length === 0 && (
                  <MenuItem value="" disabled>
                    {scenarioProp.project
                      ? "No scenarios available"
                      : "Select a project first"}
                  </MenuItem>
                )}
                {scenarios.map((name) => (
                  <MenuItem key={name} value={name}>
                    <Typography variant="body1" noWrap={false}>
                      {name}
                    </Typography>
                  </MenuItem>
                ))}
              </Select>
            )}
          </FormControl>
        </Box>
      </Stack>
    </Paper>
  );
}
