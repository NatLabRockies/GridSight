import React from "react";
import Box from "@mui/material/Box";
import CreateScenarioDialog from "../controllers/CreateScenarioDialog.jsx";
import BusGeometryDialog from "../controllers/BusGeometryDialog.jsx";
import SystemViewerDialog from "../controllers/SystemViewerDialog.jsx";
import DisplayGroupManager from "../controllers/DisplayGroupManager.jsx";
import CategoryColorPanel from "../controllers/CategoryColorPanel.jsx";
import QuickStylePanel from "../controllers/QuickStylePanel.jsx";
import SyncSettingsPanel from "../controllers/SyncSettingsPanel.jsx";
import GiveControlDialog from "../dialogs/GiveControlDialog.jsx";

export default function DialogsHost({
  extDialogs,
  ui,
  scenarioState,
  currentDrawerWidth,
  mapConfigs,
  mapVisibility,
  mapLocalStyle,
  onColorPanelClose,
  onColorPanelAskAI,
  onCreateScenarioCreated,
  onBusGeoCreated,
  onQuickStyleVisibilityChange,
  onQuickStyleLocalStyleChange,
  onQuickStyleMappingChange,
  onSyncSettingsClose,
  onGiveControlClose,
  onDisplayGroupsInvalidated,
}) {
  return (
    <>
      <CreateScenarioDialog
        open={!!extDialogs.state.createScenario}
        onClose={() => extDialogs.closeCreateScenario()}
        onCreated={onCreateScenarioCreated}
        extension={extDialogs.state.createScenario ?? { name: "gat" }}
      />
      <SystemViewerDialog
        open={!!extDialogs.state.inspectSystem}
        onClose={() => extDialogs.closeInspectSystem()}
        project={scenarioState.project}
        scenario={scenarioState.scenario}
        extension={extDialogs.state.inspectSystem ?? { name: "gat" }}
        initialComponent="ACBus"
      />
      <BusGeometryDialog
        open={!!extDialogs.state.busGeo}
        onClose={() => extDialogs.closeBusGeo()}
        project={scenarioState.project}
        scenario={scenarioState.scenario}
        extension={extDialogs.state.busGeo ?? { name: "gat" }}
        onCreated={onBusGeoCreated}
      />
      <DisplayGroupManager
        open={!!extDialogs.state.displayGroups}
        onClose={() => extDialogs.closeDisplayGroups()}
        project={scenarioState.project}
        scenario={scenarioState.scenario}
        onInvalidated={onDisplayGroupsInvalidated}
      />
      {ui.state.colorPanelOpen && (
        <Box sx={{
          position: 'fixed',
          bottom: 16,
          left: currentDrawerWidth + 16,
          zIndex: 1200,
        }}>
          <CategoryColorPanel
            onClose={onColorPanelClose}
            onAskAI={onColorPanelAskAI}
          />
        </Box>
      )}
      {ui.state.syncSettingsOpen && (
        <SyncSettingsPanel onClose={onSyncSettingsClose} />
      )}
      <GiveControlDialog open={ui.state.giveControlOpen} onClose={onGiveControlClose} />
      {ui.state.quickStyleOpen && (
        <QuickStylePanel
          layers={mapConfigs}
          visibility={mapVisibility}
          localStyles={mapLocalStyle}
          onVisibilityChange={onQuickStyleVisibilityChange}
          onLocalStyleChange={onQuickStyleLocalStyleChange}
          onStyleMappingChange={onQuickStyleMappingChange}
          onClose={() => ui.setQuickStyleOpen(false)}
        />
      )}
    </>
  );
}
