/**
 * AIChatPanel — registered panel that hosts the same ChatPanel the main
 * tab's right drawer uses, in `embedded` mode so the ChartFrame chrome
 * supplies the title + close.
 *
 * The control tab carries its own conversation (ChatPanel generates a
 * fresh `chat-${Date.now()}` conversationId on mount) — separate from
 * the host's. AI tool-call results that mutate synced state are forwarded
 * by the parent's handlers; whatever rides existing channels (layer
 * visibility/style, scenario, story) propagates to the host display
 * automatically. Tool calls that need host-only state (live map capture
 * for create_perspective, hover charts on deck.gl layers) are best-effort
 * and may no-op in this tab.
 */

import ChatPanel from '../chat/ChatPanel.jsx';

export default function AIChatPanel({
  chartDAG,
  onMirrorToMain,
  // host-supplied side-effect callbacks (analogues of App.jsx handlers)
  onInputControlChanged,
  onLayerStyleChanged,
  onLayerVisibilityChanged,
  onCrossLayerConfig,
  onApplyPerspective,
  onCreatePerspective,
  onApplyStory,
  onSwitchScenario,
  onHoverChart,
  // contextual props
  activeExtensions,
  activeStoryId = null,
  activePerspectiveId = null,
  anchoredLayers,
  webgpu,
}) {
  return (
    <ChatPanel
      embedded
      open
      onClose={undefined}
      chartDAG={chartDAG}
      onMirrorToMain={onMirrorToMain}
      onInputControlChanged={onInputControlChanged}
      onLayerStyleChanged={onLayerStyleChanged}
      onLayerVisibilityChanged={onLayerVisibilityChanged}
      onCrossLayerConfig={onCrossLayerConfig}
      onApplyPerspective={onApplyPerspective}
      onCreatePerspective={onCreatePerspective}
      onApplyStory={onApplyStory}
      onSwitchScenario={onSwitchScenario}
      onHoverChart={onHoverChart}
      activeExtensions={activeExtensions}
      activeStoryId={activeStoryId}
      activePerspectiveId={activePerspectiveId}
      anchoredLayers={anchoredLayers}
      webgpu={webgpu}
    />
  );
}
