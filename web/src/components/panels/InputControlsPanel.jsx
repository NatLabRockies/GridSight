/**
 * InputControlsPanel — registered panel that hosts the same
 * InputControlPanel the main tab's tray uses, in `embedded` mode so the
 * ChartFrame chrome supplies the title.
 *
 * Identical UX to the sidebar control: project/scenario-level sliders,
 * dropdowns, toggles, and number inputs declared by data-provider
 * extensions. In a popped-out tab the commit POSTs the same endpoint;
 * we forward the result's `invalidated_datasets` and `layer_actions`
 * back to the host via callbacks so the display reacts (re-init buffers,
 * apply layer visibility/filter).
 */

import InputControlPanel from '../controllers/InputControlPanel.jsx';

export default function InputControlsPanel({
  extensions,
  scenarioState,
  inputControlRefreshKey,
  onDatasetsInvalidated,
  onLayerActions,
}) {
  return (
    <InputControlPanel
      embedded
      extensions={extensions}
      scenarioProp={scenarioState}
      refreshKey={inputControlRefreshKey}
      onDatasetsInvalidated={onDatasetsInvalidated}
      onLayerActions={onLayerActions}
    />
  );
}
