import { Suspense, lazy } from 'react';
import { PANEL_REGISTRY } from '../../lib/panelRegistry.jsx';
import { DRAWER_WIDTH as CHAT_DRAWER_WIDTH } from '../chat/ChatPanel.jsx';

const ChartTray = lazy(() => import('../interaction/ChartTray.jsx'));

/**
 * ChartTrayContainer — mounts the bottom ChartTray when the tray
 * isn't popped out to a separate window. Wraps the tray in a
 * Suspense boundary because some inner chart components lazy-load.
 *
 * Receives the already-grouped frame lists from App.jsx so the
 * grouping logic stays where the chart-frame state lives.
 */
export default function ChartTrayContainer({
  trayPoppedOut,
  chatExpanded,
  webgpu,
  trayScenarioFrames,
  trayAiFrames,
  openScenarioCharts,
  onAddPanel,
  onTrayWidthChange,
}) {
  if (trayPoppedOut) return null;
  return (
    <Suspense fallback={null}>
      <ChartTray
        charts={[]}
        // Only the EXPANDED chat drawer reserves space on the right (tray slides
        // left of it). In compact/bubble mode the tray stays flush right and the
        // chat bubble/FAB dock to its LEFT (via onTrayWidthChange → App).
        // Imported, not repeated: a literal here silently overlaps the drawer
        // the moment DRAWER_WIDTH changes.
        rightOffset={chatExpanded ? CHAT_DRAWER_WIDTH : 0}
        onWidthChange={onTrayWidthChange}
        webgpu={webgpu}
        // Use react-grid-layout in the in-app tray too (not just the
        // popped-out tab) so tray charts are draggable + RESIZABLE here.
        // Without this the in-app tray stacked frames with no resize handle,
        // so charts were only resizable after popping the tray to a new tab.
        useGridLayout
        scenarioFrames={[...trayScenarioFrames, ...trayAiFrames]}
        panelAddOptions={Object.entries(PANEL_REGISTRY).map(([id, def]) => ({
          id,
          title: def.title,
          icon: def.icon,
          disabled: def.singleton && openScenarioCharts.some(
            (e) => e.kind === 'panel' && e.panelId === id,
          ),
        }))}
        onAddPanel={onAddPanel}
      />
    </Suspense>
  );
}
