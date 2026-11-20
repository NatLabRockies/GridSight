import React from "react";
import ClockController from "./controllers/clockController.jsx";
import LayerFactory from "./controllers/Layers.jsx";
import DataManager from "./controllers/DataManager.jsx";
import InputControlPanel from "./controllers/InputControlPanel.jsx";
import {
  DisplaySettings,
  ExtensionsSettings,
  AgentSettings,
  DeveloperSettings,
} from "./controllers/Settings.jsx";
import Box from "@mui/material/Box";

export default function Tray({
  trayFlags,
  userState,
  baseLayerProp,
  onBaseLayerChange,
  hiddenBasemapCategories,
  onToggleBasemapCategory,
  scenarioProp,
  clockState,
  onClockChange,
  clockColor,
  onClockColorChange,
  currentTimeLabel,
  genericLayers,
  genericLayerVisibility,
  onGenericLayerVisibilityChange,
  onGenericLayerAdded,
  genericLayerLocalStyle,
  onGenericLayerLocalStyleChange,
  onGenericLayerStyleMappingChange,
  onGenericLayerDeleted,
  genericLayerGeo,
  genericLayerData,
  extensions,
  activeExtName,
  onDatasetsInvalidated,
  onLayerActions,
  inputControlRefreshKey,
  onExtensionPrefChanged,
  onAskAI,
  onPopoutLegend,
  onQuickStyleOpen,
  anchoredLayers,
  onAnchorToggle,
  onInspectData,
  gpu,
  stats,
  forceDpr1,
  maxCanvasSize,
  workerPrecompute,
  gpuTimeseries,
}) {
  return (
    // No maxHeight here — the parent in App.jsx already constrains height
    // via maxHeight: calc(100vh - trayTop) and owns the scroll container
    // (overflowY: 'auto'). A maxHeight: 95% here used to clip taller panels
    // (e.g. the Developer settings list) because the percentage was
    // resolved against the parent's *visible* area, so overflowing content
    // had no scrollable extent.
    <Box sx={{ width: "100%", boxShadow: 3 }}>
      <Box sx={{ width: "100%", boxShadow: 3 }}>
        {trayFlags.layers && (
          <LayerFactory
            scenarioProp={scenarioProp}
            genericLayers={genericLayers}
            genericLayerVisibility={genericLayerVisibility}
            onGenericLayerVisibilityChange={onGenericLayerVisibilityChange}
            onGenericLayerAdded={onGenericLayerAdded}
            genericLayerLocalStyle={genericLayerLocalStyle}
            onGenericLayerLocalStyleChange={onGenericLayerLocalStyleChange}
            onGenericLayerStyleMappingChange={onGenericLayerStyleMappingChange}
            onGenericLayerDeleted={onGenericLayerDeleted}
            genericLayerGeo={genericLayerGeo}
            genericLayerData={genericLayerData}
            onAskAI={onAskAI}
            onPopoutLegend={onPopoutLegend}
            onQuickStyleOpen={onQuickStyleOpen}
            anchoredLayers={anchoredLayers}
            onAnchorToggle={onAnchorToggle}
          />
        )}
      </Box>

      <Box sx={{ width: "100%", boxShadow: 3 }}>
        {trayFlags.data && (
          <DataManager
            scenarioProp={scenarioProp}
            onLayerCreated={onGenericLayerAdded}
            onInspectData={onInspectData}
          />
        )}
      </Box>

      <Box sx={{ width: "100%", boxShadow: 3 }}>
        {trayFlags.inputControls && (
          <InputControlPanel
            scenarioProp={scenarioProp}
            extensions={extensions}
            activeExtName={activeExtName}
            onDatasetsInvalidated={onDatasetsInvalidated}
            onLayerActions={onLayerActions}
            refreshKey={inputControlRefreshKey}
          />
        )}
      </Box>

      <Box sx={{ width: "100%", boxShadow: 3 }}>
        {trayFlags.animation && (
          <ClockController props={clockState} onChange={onClockChange} clockColor={clockColor} onClockColorChange={onClockColorChange} currentTimeLabel={currentTimeLabel} />
        )}
      </Box>

      <Box sx={{ width: "100%", boxShadow: 3 }}>
        {trayFlags.display && (
          <DisplaySettings
            baseLayerProp={baseLayerProp}
            onBaseLayerChange={onBaseLayerChange}
            hiddenBasemapCategories={hiddenBasemapCategories}
            onToggleBasemapCategory={onToggleBasemapCategory}
          />
        )}
      </Box>

      <Box sx={{ width: "100%", boxShadow: 3 }}>
        {trayFlags.extensions && (
          <ExtensionsSettings
            onExtensionPrefChanged={onExtensionPrefChanged}
          />
        )}
      </Box>

      <Box sx={{ width: "100%", boxShadow: 3 }}>
        {trayFlags.agentIntegration && (
          <AgentSettings />
        )}
      </Box>

      <Box sx={{ width: "100%", boxShadow: 3 }}>
        {trayFlags.developer && (
          <DeveloperSettings
            gpu={gpu}
            stats={stats}
            forceDpr1={forceDpr1}
            maxCanvasSize={maxCanvasSize}
            workerPrecompute={workerPrecompute}
            gpuTimeseries={gpuTimeseries}
          />
        )}
      </Box>
    </Box>
  );
}
