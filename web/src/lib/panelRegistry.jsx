/**
 * panelRegistry — non-chart UI panels that mount inside a ChartFrame.
 *
 * A "panel" is a stateful UI surface (story playback, layer controls,
 * animation controls, extension toggles) that participates in the same
 * anchor/pop-out/transfer machinery as chart frames. The registry keeps
 * the set of known panel kinds + their renderers in one place so App.jsx
 * and ChartTrayApp can render them through identical code paths.
 *
 * Each entry:
 *   title         header title shown in the ChartFrame
 *   icon          MUI Icon component for the "+ Panel" menu
 *   defaultAnchor ANCHOR_MODE applied when the panel is first opened
 *   defaultSize   { w, h } for floating mode (ignored in docked modes)
 *   singleton     only one instance allowed at a time (dedup by panelId)
 *   syncChannels  bus channels the panel reads/writes when popped out
 *   Component     React component rendered inside the ChartFrame body
 *
 * Panels read their props from App.jsx (inline) or from the bus (popped-
 * out) — both sites pass the same prop shape so the component doesn't
 * know where it lives.
 *
 * Folder convention:
 *   - `components/controllers/` — the standalone UI components (sidebar
 *     LayerFactory, ClockController, etc.). Used directly inside App.jsx
 *     and reused by panels.
 *   - `components/panels/`      — thin adapters that wrap a controller
 *     for the panel-registry surface (ChartFrame chrome, anchor/transfer,
 *     pop-out). Add a panel here when an existing controller needs to be
 *     mountable as a frame. Don't duplicate the controller's logic — the
 *     adapter should be a shell that forwards props.
 */

import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import LayersIcon from '@mui/icons-material/Layers';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import ExtensionIcon from '@mui/icons-material/Extension';
import MapIcon from '@mui/icons-material/Map';
import TuneIcon from '@mui/icons-material/Tune';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

import StoryPlaybackPanel from '../components/story/StoryPlaybackPanel.jsx';
import LayerControlPanel from '../components/panels/LayerControlPanel.jsx';
import AnimationPanel from '../components/panels/AnimationPanel.jsx';
import ExtensionsPanel from '../components/panels/ExtensionsPanel.jsx';
import InputControlsPanel from '../components/panels/InputControlsPanel.jsx';
import AIChatPanel from '../components/panels/AIChatPanel.jsx';
import MapPanel from '../components/panels/MapPanel.jsx';
// GraphPanel kept on disk but not imported — see "Graph view is
// intentionally not registered" note below.
import { ANCHOR_MODE } from './chartDescriptor.js';

export const PANEL_REGISTRY = {
  'story-playback': {
    title: 'Story Playback',
    icon: PlayArrowIcon,
    defaultAnchor: ANCHOR_MODE.BOTTOM,
    defaultSize: { w: 720, h: 120 },
    singleton: true,
    syncChannels: ['story'],
    Component: StoryPlaybackPanel,
  },
  'layers': {
    title: 'Layers',
    icon: LayersIcon,
    defaultAnchor: ANCHOR_MODE.SIDE_RIGHT,
    defaultSize: { w: 320, h: 360 },
    singleton: true,
    syncChannels: ['layers:visibility', 'layers:style', 'scenario'],
    Component: LayerControlPanel,
  },
  'animation': {
    title: 'Animation',
    icon: PlayCircleOutlineIcon,
    defaultAnchor: ANCHOR_MODE.BOTTOM,
    defaultSize: { w: 600, h: 480 },
    singleton: true,
    syncChannels: ['clock'],
    Component: AnimationPanel,
  },
  'extensions': {
    title: 'Extensions',
    icon: ExtensionIcon,
    defaultAnchor: ANCHOR_MODE.SIDE_LEFT,
    defaultSize: { w: 360, h: 480 },
    singleton: true,
    syncChannels: ['extensions'],
    Component: ExtensionsPanel,
  },
  'input-controls': {
    title: 'Input Controls',
    icon: TuneIcon,
    defaultAnchor: ANCHOR_MODE.SIDE_LEFT,
    defaultSize: { w: 360, h: 480 },
    singleton: true,
    // Slider/dropdown commits POST to the server; the 'controls' channel
    // bumps a refresh key on both ends so the host's tray re-fetches and
    // 'controls:effects' carries the dataset-invalidation + layer-action
    // payload so the host applies the side effects on the display.
    syncChannels: ['controls', 'controls:effects', 'extensions'],
    Component: InputControlsPanel,
  },
  'ai-chat': {
    title: 'Atlas',
    icon: AutoAwesomeIcon,
    defaultAnchor: ANCHOR_MODE.SIDE_RIGHT,
    defaultSize: { w: 540, h: 600 },
    singleton: true,
    // Each tab keeps its own conversation; tool-call side effects ride
    // the existing synced channels (layers / scenario / story / controls)
    // when the parent's handlers update synced state. Listed channels
    // are illustrative — the panel itself doesn't subscribe directly,
    // but the parent's handlers route through them.
    syncChannels: ['scenario', 'story', 'layers:visibility', 'layers:style', 'controls'],
    Component: AIChatPanel,
  },
  'map': {
    title: 'Map',
    icon: MapIcon,
    defaultAnchor: ANCHOR_MODE.FLOATING,
    defaultSize: { w: 600, h: 420 },
    singleton: true,
    syncChannels: ['viewport', 'tooltip', 'layers:catalog', 'layers:visibility', 'layers:style'],
    Component: MapPanel,
  },
  // Graph view is intentionally not registered yet — the layout
  // engine and panel work, but the UX (force-directed for a real
  // Sienna scenario) isn't polished enough to expose. Re-add this
  // entry when the renderer / interaction story is ready. Component
  // file and SDK plumbing are kept so re-enabling is a one-line
  // change here.
};

export function isPanelKind(entry) {
  return entry?.kind === 'panel' && !!PANEL_REGISTRY[entry.panelId];
}

export function getPanelDef(panelId) {
  return PANEL_REGISTRY[panelId] || null;
}
