import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { zoomAnchorProps } from '../../lib/zoomAnchor.js';

/**
 * ChartsMenu — the per-extension "scenario charts" picker that pops
 * out of the sidebar's Charts button. Anchored to the button via
 * ``chartsMenu.anchorEl``; closing dispatches ``onClose``.
 *
 * Specs without a project/scenario (legacy/global) always show;
 * project/scenario-scoped specs filter to the active context.
 */
export default function ChartsMenu({
  chartsMenu,                 // { extName, anchorEl } | null
  onClose,
  scenarioChartSpecs,         // { [extName]: ChartSpec[] }
  scenarioState,              // { project, scenario }
  onOpenScenarioChart,        // (extName, spec) => void
}) {
  return (
    <Menu
      anchorEl={chartsMenu?.anchorEl ?? null}
      open={!!chartsMenu}
      onClose={onClose}
      anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
      transformOrigin={{ vertical: 'center', horizontal: 'left' }}
      // Under the large-display CSS `zoom`, MUI's anchorEl positioning double-
      // applies the zoom and the menu drifts off the button. zoomAnchorProps
      // switches to zoom-corrected explicit coordinates (no-op at scale 1).
      {...zoomAnchorProps(chartsMenu?.anchorEl, { vertical: 'center', horizontal: 'right' })}
    >
      {chartsMenu && (scenarioChartSpecs[chartsMenu.extName] ?? [])
        .filter((spec) => (
          (!spec.project || spec.project === scenarioState.project)
          && (!spec.scenario || spec.scenario === scenarioState.scenario)
        ))
        .map((spec) => (
          <MenuItem
            key={spec.name}
            onClick={() => onOpenScenarioChart(chartsMenu.extName, spec)}
          >
            {spec.display_name || spec.name}
          </MenuItem>
        ))}
    </Menu>
  );
}
