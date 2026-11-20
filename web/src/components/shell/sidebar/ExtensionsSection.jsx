import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import AddIcon from "@mui/icons-material/Add";
import PlaceIcon from "@mui/icons-material/Place";
import TableViewIcon from "@mui/icons-material/TableView";
import TuneIcon from "@mui/icons-material/Tune";
import CategoryIcon from "@mui/icons-material/Category";
import BarChartIcon from "@mui/icons-material/BarChart";
import BuildIcon from "@mui/icons-material/Build";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import { ExtensionIcon } from "../../primitives/index.jsx";
import ExtensionScenarioPicker from "../../controllers/ExtensionScenarioPicker.jsx";

/**
 * Sidebar "Extensions" section — the per-extension icon row plus the
 * expand/collapse drawer of nested actions (project picker, create scenario,
 * add bus geometry, inspect system, input controls, charts).
 *
 * Renders nothing when there are no data_provider extensions.
 *
 * Self-contained: holds no state of its own. All interactions are dispatched
 * back to App.jsx via the provided handlers/state setters.
 */
export default function ExtensionsSection({
  extensions,
  showLabels,
  expandedExt,
  setExpandedExt,
  scenarioState,
  updateScenarioState,
  extDialogs,
  scenarioChartSpecs,
  setChartsMenu,
  onToggleExtension,
  onOpenInputControls,
}) {
  const dataProviders = extensions.filter(ext => ext.capabilities?.includes("data_provider"));
  if (dataProviders.length === 0) return null;

  return (
    <>
      <Divider />
      {showLabels && (
        <Typography variant="overline" color="text.secondary" sx={{ px: 2, pt: 1, display: "block", lineHeight: 1.5 }}>
          Extensions
        </Typography>
      )}
      <List>
        {dataProviders.map((ext) => (
          <React.Fragment key={ext.name}>
            <ListItem disablePadding secondaryAction={
              showLabels ? (
                <IconButton
                  size="small"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const newState = ext.state === "disabled" ? "enabled" : "disabled";
                    try {
                      await onToggleExtension(ext.name, newState);
                    } catch (err) {
                      console.error("[App] extension toggle error:", err);
                    }
                  }}
                  sx={{ opacity: ext.state === "disabled" ? 0.3 : 0.8 }}
                >
                  {ext.state === "disabled" ? <BuildOutlinedIcon fontSize="small" /> : <BuildIcon fontSize="small" />}
                </IconButton>
              ) : undefined
            }>
              <ListItemButton onClick={(e) => {
                if (ext.state === "disabled") return; // don't expand disabled extensions
                // Auto-select the extension's first project ONLY if the
                // user isn't already on one of this extension's
                // projects. Otherwise clicking the drawer entry to
                // expand a charts/uploads menu would clobber a
                // perfectly good current selection (and trigger the
                // scenario-change effect's full reload).
                const projects = ext.projects ?? [];
                const onThisExt = projects.includes(scenarioState.project);
                if (!onThisExt && projects.length > 0) {
                  updateScenarioState({ project: projects[0], scenario: "" });
                }
                // Toggle expand/collapse
                setExpandedExt(expandedExt === ext.name ? null : ext.name);
              }}>
                <ListItemIcon sx={{ minWidth: showLabels ? 56 : 'auto', opacity: ext.state === "disabled" ? 0.4 : 1 }}>
                  <ExtensionIcon ext={ext} />
                </ListItemIcon>
                {showLabels && <ListItemText primary={ext.display_name} sx={{ opacity: ext.state === "disabled" ? 0.4 : 1 }} />}
              </ListItemButton>
            </ListItem>
            {showLabels && (
              <Collapse in={expandedExt === ext.name} timeout="auto" unmountOnExit>
                <List disablePadding>
                  <ListItem sx={{ pl: 2, pr: 1 }}>
                    <ExtensionScenarioPicker
                      extension={ext}
                      scenarioProp={scenarioState}
                      onChange={updateScenarioState}
                    />
                  </ListItem>
                  {ext.capabilities?.includes('file_upload') && (
                    <ListItem disablePadding>
                      <ListItemButton sx={{ pl: 4 }} onClick={() => extDialogs.openCreateScenario(ext)}>
                        <ListItemIcon sx={{ minWidth: 40 }}><AddIcon fontSize="small" /></ListItemIcon>
                        <ListItemText primary="Create Scenario" primaryTypographyProps={{ variant: 'body2' }} />
                      </ListItemButton>
                    </ListItem>
                  )}
                  {/* GAT-specific: attach geo to a project. Scoping
                      is project-level (same physical system across
                      scenarios), so a selected project is enough — no
                      scenario required. */}
                  {ext.name === 'gat' && scenarioState.project && (
                    <ListItem disablePadding>
                      <ListItemButton sx={{ pl: 4 }} onClick={() => extDialogs.openBusGeo(ext)}>
                        <ListItemIcon sx={{ minWidth: 40 }}><PlaceIcon fontSize="small" /></ListItemIcon>
                        <ListItemText primary="Add Bus Geometry" primaryTypographyProps={{ variant: 'body2' }} />
                      </ListItemButton>
                    </ListItem>
                  )}
                  {ext.name === 'gat' && scenarioState.project && scenarioState.scenario && (
                    <ListItem disablePadding>
                      <ListItemButton sx={{ pl: 4 }} onClick={() => extDialogs.openInspectSystem(ext)}>
                        <ListItemIcon sx={{ minWidth: 40 }}><TableViewIcon fontSize="small" /></ListItemIcon>
                        <ListItemText primary="Inspect System" primaryTypographyProps={{ variant: 'body2' }} />
                      </ListItemButton>
                    </ListItem>
                  )}
                  {/* GAT-specific: per-project (and optional per-scenario)
                      entity → display-group overrides. Picked from the same
                      project context as Add Bus Geometry, so a project is
                      sufficient — scenario is only needed when the user
                      wants to override at the scenario level. */}
                  {ext.name === 'gat' && scenarioState.project && scenarioState.scenario && (
                    <ListItem disablePadding>
                      <ListItemButton sx={{ pl: 4 }} onClick={() => extDialogs.openDisplayGroups(ext)}>
                        <ListItemIcon sx={{ minWidth: 40 }}><CategoryIcon fontSize="small" /></ListItemIcon>
                        <ListItemText primary="Display Groups" primaryTypographyProps={{ variant: 'body2' }} />
                      </ListItemButton>
                    </ListItem>
                  )}
                  {ext.capabilities?.includes('input_controls') && (
                    <ListItem disablePadding>
                      <ListItemButton sx={{ pl: 4 }} onClick={(e) => onOpenInputControls(e)}>
                        <ListItemIcon sx={{ minWidth: 40 }}><TuneIcon fontSize="small" /></ListItemIcon>
                        <ListItemText primary="Input Controls" primaryTypographyProps={{ variant: 'body2' }} />
                      </ListItemButton>
                    </ListItem>
                  )}
                  {(scenarioChartSpecs[ext.name]?.length ?? 0) > 0 && (
                    <ListItem disablePadding>
                      <ListItemButton
                        sx={{ pl: 4 }}
                        onClick={(e) => setChartsMenu({ extName: ext.name, anchorEl: e.currentTarget })}
                      >
                        <ListItemIcon sx={{ minWidth: 40 }}><BarChartIcon fontSize="small" /></ListItemIcon>
                        <ListItemText primary="Charts" primaryTypographyProps={{ variant: 'body2' }} />
                      </ListItemButton>
                    </ListItem>
                  )}
                </List>
              </Collapse>
            )}
          </React.Fragment>
        ))}
      </List>
    </>
  );
}
