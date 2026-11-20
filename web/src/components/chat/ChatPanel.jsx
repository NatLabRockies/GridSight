import { useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { zoomAnchorProps } from '../../lib/zoomAnchor.js';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Tooltip from '@mui/material/Tooltip';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import KeyIcon from '@mui/icons-material/Key';
import CameraAltIcon from '@mui/icons-material/CameraAlt';
import MicIcon from '@mui/icons-material/Mic';
import MicNoneIcon from '@mui/icons-material/MicNone';
import StorageIcon from '@mui/icons-material/Storage';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import PersonIcon from '@mui/icons-material/Person';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ChartTabs from '../interaction/ChartTabs.jsx';
import { useTheme } from '@mui/material/styles';
import Select from '@mui/material/Select';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListSubheader from '@mui/material/ListSubheader';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import PsychologyIcon from '@mui/icons-material/Psychology';
import BuildIcon from '@mui/icons-material/Build';
import PushPinIcon from '@mui/icons-material/PushPin';
import ScreenShareIcon from '@mui/icons-material/ScreenShare';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import InsertChartOutlinedIcon from '@mui/icons-material/InsertChartOutlined';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import { sendChatMessage, cancelChat, clearChat, fetchChatConfig, fetchChatModels } from '../../lib/loaders';
import { useCategoryColors } from '../../lib/categoryColors.jsx';
import { useChatPanelState } from '../../state/chatPanelState.js';
import useVoiceInput from '../../hooks/useVoiceInput.js';
import { isSecretsAvailable } from '../../lib/desktopSecrets';
import {
  aiRequestOverrides, REASONING_EFFORTS,
  getReasoningEffort, setReasoningEffort,
} from '../../lib/aiSettings.js';
import LLMKeysDialog from '../dialogs/LLMKeysDialog.jsx';

// Width of the expanded chat drawer. Exported because the chart tray has to
// reserve exactly this much room on the right — when the two disagree they
// overlap, so there must be one source of truth.
export const DRAWER_WIDTH = 540;

// Markdown renderer (tables/lists/code) for assistant messages. Lazy so
// react-markdown + remark plugins don't weigh down the initial bundle.
const Markdown = lazy(() => import('./Markdown.jsx'));

function parseSSE(text) {
  const events = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {}
    }
  }
  return events;
}

function ToolCallChip({ name }) {
  const labels = {
    query_duckdb: 'Running SQL query…',
    query_data: 'Running SQL query…',
    get_table_catalog: 'Reading table catalog…',
    update_control: 'Updating control…',
    update_input_control: 'Updating input control…',
    create_chart: 'Creating chart…',
    list_charts: 'Listing charts…',
    open_chart: 'Opening chart…',
    get_lineage: 'Reading lineage…',
    list_layers: 'Listing layers…',
    update_layer_style: 'Updating layer style…',
    configure_layer_interaction: 'Configuring layer interaction…',
    toggle_layer_visibility: 'Toggling layer visibility…',
    set_layer_visibility: 'Toggling layer visibility…',
    update_description: 'Updating data description…',
    save_memory: 'Saving to memory…',
    search_memory: 'Searching memory…',
    search_artifacts: 'Searching artifacts…',
    list_perspectives: 'Listing perspectives…',
    apply_perspective: 'Applying perspective…',
    create_perspective: 'Creating perspective…',
    list_stories: 'Listing stories…',
    apply_story: 'Playing story…',
    list_projects_and_scenarios: 'Listing projects…',
    list_scenarios: 'Listing projects…',
    switch_project_scenario: 'Switching scenario…',
    set_scenario: 'Switching scenario…',
    fit_map_to_bounds: 'Framing the map…',
    pan_map: 'Panning the map…',
    update_project_description: 'Updating description…',
    create_hover_chart: 'Creating interactive chart…',
  };
  return (
    <Chip
      icon={<StorageIcon sx={{ fontSize: 14 }} />}
      label={labels[name] || name}
      size="small"
      variant="outlined"
      sx={{ my: 0.5, fontSize: 12 }}
    />
  );
}

/**
 * ToolCallSummary — one line for a whole run of tool calls.
 *
 * A composed view now takes six to ten calls, and a chip per call buried the
 * assistant's actual answer under a wall of "Reading table catalog…". The
 * count is what matters at a glance; the breakdown is one click away for when
 * something looks wrong.
 */
function ToolCallSummary({ names }) {
  const [open, setOpen] = useState(false);
  const n = names.length;
  return (
    <Box sx={{ my: 0.5 }}>
      <Chip
        icon={<StorageIcon sx={{ fontSize: 14 }} />}
        label={`${n} tool call${n === 1 ? '' : 's'}`}
        size="small"
        variant="outlined"
        onClick={() => setOpen((v) => !v)}
        onDelete={() => setOpen((v) => !v)}
        deleteIcon={(
          <ExpandMoreIcon
            sx={{ fontSize: 16, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
          />
        )}
        sx={{ fontSize: 12, cursor: 'pointer' }}
      />
      {open && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5, ml: 0.5 }}>
          {names.map((tc, i) => <ToolCallChip key={i} name={tc} />)}
        </Box>
      )}
    </Box>
  );
}

/**
 * Renders an inline chart from a __chart__ tool result with tabbed views.
 * Tabs: Chart | JSON | Data | SQL | DAG
 */
function ChartMessage({ spec, chartId, chartDAG, poppedOut, format: initialFormat, vegaLiteSpec: initialVLSpec, webgpu, onMirrorToMain }) {
  const activeChart = chartId && chartDAG ? chartDAG.getChart(chartId) : null;
  const format = activeChart?.format || initialFormat || 'plotly';
  const effectiveSpec = activeChart?.plotlySpec || spec;
  const [mirrorMenuAnchor, setMirrorMenuAnchor] = useState(null);

  if (poppedOut) {
    return (
      <Box sx={{ my: 1, p: 1.5, bgcolor: 'grey.900', borderRadius: 1, textAlign: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          Chart moved to map overlay
        </Typography>
      </Box>
    );
  }

  const chartObj = activeChart || { spec: {}, datasets: [], format };
  if (!activeChart && initialVLSpec) {
    chartObj.vegaLiteSpec = initialVLSpec;
  }

  // Two action surfaces for AI charts in chat:
  //   - main tab: pop out to map (floating) + pin to chart tray
  //   - control tab (onMirrorToMain provided): pop out to local tray
  //     + a "Mirror to main" menu with anchor sub-options. The control
  //     tab has no map of its own, so "pop out to map" is meaningless
  //     here; "mirror" is the way to push a chart to the host display.
  const isControlTab = !!onMirrorToMain;

  return (
    <Box sx={{ my: 1, minWidth: 500 }}>
      {chartId && chartDAG && (
        <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5 }}>
          {isControlTab ? (
            <>
              <Tooltip title="Pop out to chart tray">
                <IconButton
                  size="small"
                  onClick={() => chartDAG.setPlacement(chartId, 'tray')}
                  sx={{ p: 0.25 }}
                >
                  <OpenInNewIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Mirror to main display…">
                <IconButton
                  size="small"
                  onClick={(e) => setMirrorMenuAnchor(e.currentTarget)}
                  sx={{ p: 0.25 }}
                >
                  <ScreenShareIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Menu
                anchorEl={mirrorMenuAnchor}
                open={!!mirrorMenuAnchor}
                onClose={() => setMirrorMenuAnchor(null)}
                {...zoomAnchorProps(mirrorMenuAnchor, { vertical: 'top', horizontal: 'left' })}
              >
                <MenuItem onClick={() => { onMirrorToMain(chartId, 'bottom'); setMirrorMenuAnchor(null); }}>
                  Mirror to bottom
                </MenuItem>
                <MenuItem onClick={() => { onMirrorToMain(chartId, 'side-right'); setMirrorMenuAnchor(null); }}>
                  Mirror to right side
                </MenuItem>
                <MenuItem onClick={() => { onMirrorToMain(chartId, 'side-left'); setMirrorMenuAnchor(null); }}>
                  Mirror to left side
                </MenuItem>
                <MenuItem onClick={() => { onMirrorToMain(chartId, 'floating'); setMirrorMenuAnchor(null); }}>
                  Mirror as floating
                </MenuItem>
                <MenuItem onClick={() => { onMirrorToMain(chartId, 'tray'); setMirrorMenuAnchor(null); }}>
                  Mirror to chart tray
                </MenuItem>
              </Menu>
            </>
          ) : (
            <>
              <Tooltip title="Pop out to map">
                <IconButton
                  size="small"
                  onClick={() => chartDAG.setPlacement(chartId, 'floating')}
                  sx={{ p: 0.25 }}
                >
                  <OpenInNewIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Pin to chart tray">
                <IconButton
                  size="small"
                  onClick={() => chartDAG.setPlacement(chartId, 'tray')}
                  sx={{ p: 0.25 }}
                >
                  <PushPinIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </>
          )}
        </Box>
      )}
      <ChartTabs plotlySpec={effectiveSpec} chart={chartObj} width={480} height={340} webgpu={webgpu} />
    </Box>
  );
}

function MessageBubble({ role, content, thinking, toolCalls, charts, images, theme, chartDAG, webgpu, onMirrorToMain, compact = false, onExpand }) {
  const isUser = role === 'user';
  const aiBubble = theme?.custom?.chatBubbleAI ?? { bgcolor: 'grey.800', color: 'text.primary' };
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        mb: 1.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
        {!isUser && <AutoAwesomeIcon sx={{ fontSize: 14, color: 'text.secondary' }} />}
        <Typography variant="caption" color="text.secondary">
          {isUser ? 'You' : 'Atlas'}
        </Typography>
        {isUser && <PersonIcon sx={{ fontSize: 14, color: 'text.secondary' }} />}
      </Box>
      {images?.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5, flexWrap: 'wrap', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
          {images.map((img, i) => (
            <Box
              key={i}
              component="img"
              src={`data:image/png;base64,${img}`}
              sx={{ maxWidth: 150, maxHeight: 100, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
            />
          ))}
        </Box>
      )}
      {thinking && !compact && (
        <Accordion
          disableGutters
          elevation={0}
          sx={{
            maxWidth: '90%',
            mb: 0.5,
            bgcolor: 'transparent',
            '&:before': { display: 'none' },
          }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon sx={{ fontSize: 14 }} />}
            sx={{
              minHeight: 0,
              px: 1,
              py: 0.25,
              '& .MuiAccordionSummary-content': { my: 0.25 },
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <PsychologyIcon sx={{ fontSize: 14, color: 'info.main' }} />
              <Typography variant="caption" color="text.secondary">
                Thinking
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 1.5, py: 1 }}>
            <Box
              sx={{
                bgcolor: 'action.hover',
                borderRadius: 1,
                px: 1.5,
                py: 1,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'text.secondary',
                maxHeight: 300,
                overflow: 'auto',
              }}
            >
              {thinking}
            </Box>
          </AccordionDetails>
        </Accordion>
      )}
      <Box
        sx={{
          bgcolor: isUser ? 'primary.main' : aiBubble.bgcolor,
          color: isUser ? 'primary.contrastText' : aiBubble.color,
          borderRadius: 2,
          px: 1.5,
          py: 1,
          maxWidth: '90%',
          // User text is shown verbatim (pre-wrap); assistant text is rendered
          // as markdown (tables/lists/code) by the Markdown component.
          whiteSpace: isUser ? 'pre-wrap' : 'normal',
          wordBreak: 'break-word',
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {isUser || !content ? content : (
          <Suspense fallback={<Box sx={{ whiteSpace: 'pre-wrap' }}>{content}</Box>}>
            <Markdown>{content}</Markdown>
          </Suspense>
        )}
      </Box>
      {toolCalls?.length > 0 && <ToolCallSummary names={toolCalls} />}
      {/* In the compact bubble a full chart won't fit; show a tap-to-expand
          chip instead and render the real chart once the chat is expanded. */}
      {compact && charts?.length > 0 && (
        <Chip
          icon={<InsertChartOutlinedIcon sx={{ fontSize: 14 }} />}
          label={charts.length > 1 ? `${charts.length} charts — expand to view` : 'Chart — expand to view'}
          size="small"
          variant="outlined"
          onClick={onExpand}
          sx={{ my: 0.5, fontSize: 12, cursor: 'pointer' }}
        />
      )}
      {!compact && charts?.map((entry, i) => {
        const isObj = entry && typeof entry === 'object' && entry.chartId;
        const chartId = isObj ? entry.chartId : null;
        const spec = isObj ? entry.spec : entry;
        const activeChart = chartId && chartDAG ? chartDAG.getChart(chartId) : null;
        const poppedOut = activeChart?.placement === 'floating';
        return (
          <ChartMessage
            key={chartId || i}
            spec={spec}
            chartId={chartId}
            chartDAG={chartDAG}
            poppedOut={poppedOut}
            format={isObj ? entry.format : undefined}
            vegaLiteSpec={isObj ? entry.vegaLiteSpec : undefined}
            webgpu={webgpu}
            onMirrorToMain={onMirrorToMain}
          />
        );
      })}
    </Box>
  );
}

/**
 * Capture the current map canvas as a base64-encoded PNG.
 * Looks for the maplibre/deck.gl canvas element in the DOM.
 */
function captureMapScreenshot() {
  // deck.gl renders on a canvas inside the map container
  const canvases = document.querySelectorAll('canvas');
  if (!canvases.length) return null;

  // Use the largest canvas (likely the map)
  let mapCanvas = null;
  let maxArea = 0;
  for (const c of canvases) {
    const area = c.width * c.height;
    if (area > maxArea) {
      maxArea = area;
      mapCanvas = c;
    }
  }
  if (!mapCanvas) return null;

  try {
    const dataUrl = mapCanvas.toDataURL('image/png');
    // Strip the data:image/png;base64, prefix
    return dataUrl.split(',')[1];
  } catch {
    // Canvas may be tainted by cross-origin tiles
    console.warn('[ChatPanel] Could not capture map screenshot (cross-origin canvas)');
    return null;
  }
}

export default function ChatPanel({
  open, onClose, chartDAG, webgpu = false,
  onInputControlChanged, onLayerStyleChanged, onLayerVisibilityChanged, onCrossLayerConfig,
  onApplyPerspective, onCreatePerspective, onApplyStory, onSwitchScenario, onHoverChart,
  anchoredLayers, activeExtensions, pendingMessage, onPendingMessageConsumed,
  // Active story id — forwarded to the chat request so the backend injects the
  // story's guide + chapter descriptions + reuse hierarchy into the assistant's
  // context (see build_system_prompt).
  activeStoryId = null,
  // Perspective id of the chapter currently applied. Forwarded alongside the
  // story so the backend can describe what is actually on screen — the
  // chapter's scenario, visible layers, open charts, controls and camera.
  activePerspectiveId = null,
  // Ids of the layers currently drawn. Without this the assistant cannot tell
  // an already-visible layer from a hidden one, so a drill-down request looks
  // like it needs no visibility change at all.
  visibleLayerIds = null,
  // Tap-to-send prompts for the active story step (authored in the story
  // editor). Rendered as chips above the composer.
  suggestedPrompts = [],
  // Reports the bubble↔drawer presentation up to App so the bottom-right
  // chat FAB can hide while the drawer covers that corner (avoids the FAB
  // overlapping the composer's send button).
  onExpandedChange,
  // Occupied width of the right-side chart tray (0 when absent). The compact
  // bubble docks to the LEFT of the tray instead of overlapping it.
  trayInset = 0,
  // `embedded` drops the right-side Drawer wrapper so the panel can mount
  // inside a ChartFrame whose chrome already supplies the title + close.
  // The `open` gate is bypassed (mounted = active) and the X button is
  // hidden — the host frame handles dismissal.
  embedded = false,
  // When set (control-tab mode), AI charts in chat show a "Mirror to
  // main display" menu instead of "Pop out to map". The callback receives
  // (chartId, anchorMode) where anchorMode ∈ 'bottom'|'side-left'|
  // 'side-right'|'floating'|'tray' and is responsible for forwarding a
  // chart-spec payload over the bus so the host registers a copy in its
  // own chartDAG at the requested anchor.
  onMirrorToMain,
}) {
  // Treat the panel as always-open when embedded so the fetch-config and
  // focus-on-open effects fire as soon as the frame mounts.
  const isOpen = embedded || open;
  const theme = useTheme();
  const { registerCategories, setColors: setCategoryColors } = useCategoryColors();
  // Initial values pulled from localStorage before the hook call so the
  // reducer's initial state matches the user's persisted selection.
  // - selectedModel: stored as "provider::model" composite string
  // - thinkingLevel: 'off' | 'on' (string toggle, not a numeric level)
  let initialModel = null;
  try { initialModel = localStorage.getItem('meridian-chat-model') || null; } catch {}
  let initialThinking = 'off';
  try { initialThinking = localStorage.getItem('meridian-chat-thinking') || 'off'; } catch {}
  const chat = useChatPanelState({ selectedModel: initialModel, thinkingLevel: initialThinking });
  const { messages, input, loading, chatConfig, providerGroups, selectedModel, thinkingLevel, pendingImages } = chat.state;
  const [conversationId] = useState(() => `chat-${Date.now()}`);
  const [keysOpen, setKeysOpen] = useState(false);
  // Non-embedded Atlas has two presentations that share this one chat state:
  //   expanded=false → compact bottom-right bubble (latest exchange + input)
  //   expanded=true  → full-height right drawer (scrollable history)
  // The component stays mounted across the toggle, so the conversation and
  // streaming state are preserved when switching between the two.
  const [expanded, setExpanded] = useState(false);

  // Tell App when the full drawer is covering the bottom-right corner so the
  // chat FAB can hide and not overlap the composer's send button.
  useEffect(() => {
    onExpandedChange?.(!embedded && open && expanded);
  }, [embedded, open, expanded, onExpandedChange]);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const readerRef = useRef(null);
  // Voice input: the text already in the box when dictation starts, so
  // streamed interim/final transcripts append to it rather than replace it.
  const speechBaseRef = useRef('');
  // handleSend is defined below and itself calls speech.stop(), so the
  // auto-send-on-pause path reaches it through a ref to avoid the cycle.
  const handleSendRef = useRef(null);
  const speech = useVoiceInput({
    onResult: (text, isFinal) => {
      const base = speechBaseRef.current;
      const joined = base ? `${base} ${text}` : text;
      if (isFinal) speechBaseRef.current = joined;
      chat.setInput(joined);
    },
    onEnd: ({ manual }) => {
      // Natural end (the speaker paused) auto-sends the dictated message; a
      // manual stop (tapping the mic to cancel) leaves it in the composer.
      if (manual) return;
      const text = speechBaseRef.current.trim();
      if (text) handleSendRef.current?.(text);
    },
  });

  // When a pending message arrives (e.g. from the palette brain button),
  // pre-fill the input so the user can review and send.
  useEffect(() => {
    if (pendingMessage && isOpen) {
      chat.setInput(pendingMessage);
      onPendingMessageConsumed?.();
      // Focus the input field
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [pendingMessage, isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleModelChange = useCallback((compositeValue) => {
    chat.setSelectedModel(compositeValue || null);
    try { if (compositeValue) localStorage.setItem('meridian-chat-model', compositeValue); } catch {}
  }, [chat]);

  const handleThinkingChange = useCallback((_, val) => {
    if (val !== null) {
      chat.setThinkingLevel(val);
      try { localStorage.setItem('meridian-chat-thinking', val); } catch {}
    }
  }, [chat]);

  // Parse the composite "provider::model" selection
  const defaultComposite = chatConfig?.default_provider && chatConfig?.default_model
    ? `${chatConfig.default_provider}::${chatConfig.default_model}` : '';
  const currentComposite = selectedModel || defaultComposite;
  const [currentProvider, currentModelName] = currentComposite.includes('::')
    ? currentComposite.split('::', 2) : ['', currentComposite];

  // Find the model info within provider groups
  const currentModelInfo = (() => {
    for (const pg of providerGroups) {
      if (currentProvider && pg.id !== currentProvider) continue;
      const found = pg.models?.find((m) => m.name === currentModelName);
      if (found) return found;
    }
    return null;
  })();
  const supportsTools = currentModelInfo?.supports_tools ?? true;
  const supportsThinking = currentModelInfo?.supports_thinking ?? false;

  useEffect(() => {
    if (isOpen) {
      fetchChatConfig().then(chat.setChatConfig).catch(() => {});
      fetchChatModels().then((groups) => {
        chat.setProviderGroups(groups);
        // If no cached selection (or cached model no longer available), use server default
        if (groups.length > 0 && selectedModel) {
          const [selProvider, selModel] = selectedModel.includes('::')
            ? selectedModel.split('::', 2) : ['', selectedModel];
          const stillAvailable = groups.some((pg) =>
            (!selProvider || pg.id === selProvider) && pg.models?.some((m) => m.name === selModel)
          );
          if (!stillAvailable) chat.setSelectedModel(null);
        }
      }).catch(() => {});
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleStop = useCallback(async () => {
    // Cancel the server-side processing
    cancelChat(conversationId).catch(() => {});
    // Also abort the reader to stop receiving events
    if (readerRef.current) {
      try { readerRef.current.cancel(); } catch {}
      readerRef.current = null;
    }
    chat.setLoading(false);
  }, [conversationId, chat]);

  const handleMicToggle = useCallback(() => {
    if (speech.listening) {
      speech.stop();
      return;
    }
    // Seed the base text with whatever is already typed so dictation appends.
    speechBaseRef.current = input.trim();
    speech.start();
  }, [speech, input]);

  // Scope sent with every chat request. These change as the user navigates
  // chapters, switches stories, or picks a model — none of which requires
  // typing, so they can't be captured in handleSend's closure: its deps are
  // keyed on `input`, and a suggested-prompt chip sends with no keystroke at
  // all. A ref keeps the memo intact while always reading the current scope.
  // Reasoning effort sits here rather than in Settings: it is a per-turn
  // speed/depth trade the user makes while working, alongside the model
  // picker, not deployment configuration buried two panels away.
  const [effort, setEffort] = useState(getReasoningEffort);
  const handleEffortChange = useCallback((value) => {
    setEffort(value);
    setReasoningEffort(value);   // persisted, so it survives a reload
  }, []);

  const requestScopeRef = useRef({});
  requestScopeRef.current = {
    webgpuAvailable: webgpu,
    activeExtensions,
    activeStoryId,
    activePerspectiveId,
    visibleLayerIds,
    // Read at send time, not render time: Settings can change mid-conversation
    // and the next message should use the new value.
    ...aiRequestOverrides(),
    model: currentModelName || null,
    provider: currentProvider || null,
    thinkingLevel,
  };

  const handleSend = useCallback(async (textArg) => {
    // textArg lets a suggested-prompt chip send its text directly (state
    // updates aren't synchronous). A click event passed by an onClick is
    // ignored since it isn't a string.
    const text = (typeof textArg === 'string' ? textArg : input).trim();
    if (!text || loading) return;
    // Abort any in-flight dictation (without transcribing) and reset its base
    // so the next utterance starts clean.
    speech.cancel();
    speechBaseRef.current = '';

    const imagesToSend = pendingImages.length > 0 ? [...pendingImages] : null;
    chat.setInput('');
    chat.clearImages();
    chat.appendMessage({ role: 'user', content: text, images: imagesToSend });
    chat.setLoading(true);

    try {
      const { thinkingLevel: level, ...scope } = requestScopeRef.current;
      const thinkParam = level === 'off' ? false : level === 'on' ? true : null;
      const stream = await sendChatMessage(text, conversationId, imagesToSend, { ...scope, think: thinkParam });
      const reader = stream.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();

      let assistantContent = '';
      let thinkingContent = '';
      let toolCalls = [];
      let charts = [];
      let buffer = '';

      // Add placeholder assistant message
      chat.appendMessage({ role: 'assistant', content: '', thinking: '', toolCalls: [], charts: [] });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = parseSSE(buffer);
        const lastNewline = buffer.lastIndexOf('\n');
        buffer = lastNewline >= 0 ? buffer.slice(lastNewline + 1) : buffer;

        for (const event of events) {
          if (event.type === 'thinking') {
            thinkingContent += event.content;
            chat.updateLastMessage({ thinking: thinkingContent });
          } else if (event.type === 'token') {
            assistantContent += event.content;
            chat.updateLastMessage({ content: assistantContent, toolCalls: [...toolCalls] });
          } else if (event.type === 'tool_call') {
            toolCalls.push(event.name);
            chat.updateLastMessage({ toolCalls: [...toolCalls] });
          } else if (event.type === 'tool_result') {
            // Check for chart data in tool results
            try {
              const parsed = JSON.parse(event.result);
              if (parsed?.__chart__) {
                const format = parsed.format || 'plotly';
                const plotlySpec = format === 'plotly' ? parsed.plotly : null;
                const vegaLiteSpec = format === 'vega-lite' ? parsed.spec : null;
                let chartEntry = { spec: plotlySpec, format, vegaLiteSpec, chartId: null };
                // Register category names in the shared color map.
                const cats = [];
                if (plotlySpec?.data) {
                  for (const t of plotlySpec.data) { if (t.name) cats.push(t.name); }
                }
                if (vegaLiteSpec?.data?.values && vegaLiteSpec?.encoding?.color?.field) {
                  const f = vegaLiteSpec.encoding.color.field;
                  for (const row of vegaLiteSpec.data.values) { if (row[f] != null) cats.push(String(row[f])); }
                }
                if (cats.length > 0) registerCategories([...new Set(cats)]);
                // Register in reactive DAG if reactive metadata is present
                if (parsed.reactive && chartDAG) {
                  const chartId = chartDAG.registerChart(
                    parsed.reactive,
                    'ai',
                    parsed.reactive.datasets || [],
                    plotlySpec,
                    format,
                    vegaLiteSpec,
                  );
                  chartEntry.chartId = chartId;
                }
                charts.push(chartEntry);
                chat.updateLastMessage({ charts: [...charts] });
              }
              if (parsed?.__input_control__) {
                onInputControlChanged?.(
                  parsed.extension,
                  parsed.control_name,
                  parsed.new_value,
                  parsed.invalidated_datasets || [],
                );
              }
              if (parsed?.__layer_visibility__) {
                if (!anchoredLayers?.has(parsed.layer_id)) {
                  onLayerVisibilityChanged?.(parsed.layer_id, parsed.visible);
                }
              }
              if (parsed?.__layer_style__) {
                if (!anchoredLayers?.has(parsed.layer_id)) {
                  onLayerStyleChanged?.(parsed.layer_id, parsed);
                }
              }
              if (parsed?.__category_colors__) {
                const { colors, palette_name } = parsed;
                if (colors && typeof colors === 'object') {
                  const rgbaMap = {};
                  for (const [key, hex] of Object.entries(colors)) {
                    if (typeof hex === 'string' && hex.startsWith('#')) {
                      const r = parseInt(hex.slice(1, 3), 16);
                      const g = parseInt(hex.slice(3, 5), 16);
                      const b = parseInt(hex.slice(5, 7), 16);
                      rgbaMap[key] = [r, g, b, 220];
                    }
                  }
                  if (Object.keys(rgbaMap).length > 0) {
                    // Apply to shared context (live update)
                    setCategoryColors(rgbaMap);

                    // Save to localStorage so palette persists across panel open/close.
                    // Write to both storage keys used by CategoryColorPanel and GenericLayerStyler.
                    const saveName = palette_name || 'AI Palette';
                    try {
                      for (const storageKey of ['meridian_category_palettes', 'meridian_palettes']) {
                        const existing = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
                        existing[saveName] = rgbaMap;
                        localStorage.setItem(storageKey, JSON.stringify(existing));
                      }
                    } catch (e) {
                      console.warn('[ChatPanel] Failed to save palette to localStorage:', e);
                    }
                  }
                }
              }
              if (parsed?.__cross_layer_config__) {
                onCrossLayerConfig?.(
                  parsed.source_layer_name,
                  parsed.actions,
                );
              }
              if (parsed?.__apply_perspective__) {
                onApplyPerspective?.(parsed.perspective_id, parsed.config);
              }
              if (parsed?.__create_perspective__) {
                onCreatePerspective?.(parsed.perspective_id, parsed.name);
              }
              if (parsed?.__apply_story__) {
                onApplyStory?.(parsed.story_id);
              }
              if (parsed?.__switch_scenario__) {
                onSwitchScenario?.(parsed.extension, parsed.project, parsed.scenario);
              }
              if (parsed?.__hover_chart__) {
                onHoverChart?.(parsed);
              }
            } catch {
              // Not JSON or no chart marker — ignore
            }
          } else if (event.type === 'error') {
            assistantContent += `\n\n${event.message}`;
            chat.updateLastMessage({ content: assistantContent });
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        chat.setMessages((prev) => [
          ...prev.filter((m) => m.role !== 'assistant' || m.content),
          { role: 'assistant', content: `Error: ${err.message}` },
        ]);
      }
    } finally {
      readerRef.current = null;
      chat.setLoading(false);
    }
  }, [input, loading, conversationId, pendingImages, chat, speech]);
  // Expose the latest handleSend to the speech hook's auto-send-on-pause path.
  handleSendRef.current = handleSend;

  const handleClear = useCallback(async () => {
    await handleStop();
    await clearChat(conversationId).catch(() => {});
    chat.replaceMessages([]);
  }, [conversationId, handleStop, chat]);

  const handleScreenshot = useCallback(() => {
    const img = captureMapScreenshot();
    if (img) {
      chat.appendImage(img);
    }
  }, [chat]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isConfigured = chatConfig?.enabled;

  // ---- Shared sub-elements (reused by the bubble and the full drawer) ----

  // Pending image thumbnails (map screenshots queued for the next send).
  const pendingImagesRow = pendingImages.length > 0 ? (
    <Box sx={{ px: 1.5, pt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
      {pendingImages.map((img, i) => (
        <Box key={i} sx={{ position: 'relative', display: 'inline-block' }}>
          <Box
            component="img"
            src={`data:image/png;base64,${img}`}
            sx={{ height: 48, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
          />
          <IconButton
            size="small"
            onClick={() => chat.removeImage(i)}
            sx={{
              position: 'absolute', top: -6, right: -6,
              bgcolor: 'background.paper', width: 18, height: 18,
              boxShadow: 1, '&:hover': { bgcolor: 'error.light', color: 'white' },
            }}
          >
            <CloseIcon sx={{ fontSize: 12 }} />
          </IconButton>
        </Box>
      ))}
    </Box>
  ) : null;

  // Tap-to-send chips for the active story step's authored prompts. Shown
  // above the composer in both the bubble and the drawer.
  const suggestedPromptsRow = suggestedPrompts?.length > 0 ? (
    <Box sx={{ px: 1.5, pt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
      <Typography variant="caption" color="text.secondary" sx={{ width: '100%', mb: 0.25 }}>
        Suggested
      </Typography>
      {suggestedPrompts.map((p, i) => (
        <Chip
          key={i}
          label={p}
          size="small"
          variant="outlined"
          onClick={() => handleSend(p)}
          disabled={!isConfigured || loading}
          sx={{
            fontSize: 12,
            cursor: 'pointer',
            maxWidth: '100%',
            height: 'auto',
            py: 0.25,
            '& .MuiChip-label': { whiteSpace: 'normal' },
          }}
        />
      ))}
    </Box>
  ) : null;

  // The composer row: screenshot attach + text field + send/stop. Shared so
  // the bubble and drawer stay in lockstep (and the mic button lands once).
  const inputRow = (
    <Box
      sx={{
        borderTop: 1,
        borderColor: 'divider',
        p: 1.5,
        display: 'flex',
        gap: 1,
        alignItems: 'flex-end',
      }}
    >
      <Tooltip title="Attach map screenshot">
        <span>
          <IconButton
            size="small"
            onClick={handleScreenshot}
            disabled={!isConfigured || loading}
            sx={{ mb: 0.5 }}
          >
            <CameraAltIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {speech.supported && (
        <Tooltip
          title={
            speech.loading
              ? (speech.progress > 0 && speech.progress < 100
                  ? `Loading voice model… ${speech.progress}%`
                  : 'Transcribing…')
              : speech.listening
                ? 'Stop dictation'
                : (speech.engine === 'whisper'
                    ? 'Speak your message (on-device)'
                    : 'Speak your message')
          }
        >
          <span>
            <IconButton
              size="small"
              onClick={handleMicToggle}
              disabled={!isConfigured || loading || speech.loading}
              color={speech.listening ? 'error' : 'default'}
              sx={{ mb: 0.5 }}
            >
              {speech.loading
                ? <CircularProgress size={16} />
                : speech.listening
                  ? <MicIcon fontSize="small" />
                  : <MicNoneIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      )}
      <TextField
        inputRef={inputRef}
        fullWidth
        multiline
        maxRows={4}
        size="small"
        placeholder={isConfigured ? 'Ask about your data…' : 'LLM not configured'}
        disabled={!isConfigured || loading}
        value={input}
        onChange={(e) => chat.setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        sx={{ '& .MuiInputBase-root': { fontSize: 14 } }}
      />
      {loading ? (
        <Tooltip title="Stop generation">
          <IconButton color="error" onClick={handleStop}>
            <StopIcon />
          </IconButton>
        </Tooltip>
      ) : (
        <IconButton
          color="primary"
          onClick={handleSend}
          disabled={!input.trim() || !isConfigured}
        >
          <SendIcon />
        </IconButton>
      )}
    </Box>
  );

  // ---- Closed / bubble presentations (non-embedded only) ----

  if (!embedded && !open) {
    // Atlas is closed — the bottom-right FAB is the entry point. The
    // component stays mounted so the conversation persists; render nothing.
    return null;
  }

  if (!embedded && !expanded) {
    // Compact bottom-right bubble: the latest exchange + composer, with an
    // expand control that swaps to the full drawer below.
    const recentMessages = messages.slice(-2);
    return (
      <Box
        sx={{
          position: 'fixed',
          bottom: 56,            // clear the 32px FAB at bottom:12
          // Dock to the LEFT of the chart tray when one is present, else the
          // usual bottom-right corner.
          right: 12 + (trayInset ? trayInset + 12 : 0),
          transition: 'right 0.2s ease',
          zIndex: 1500,
          width: 380,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: '60vh',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.paper',
          borderRadius: 2,
          border: 1,
          borderColor: 'divider',
          boxShadow: 6,
          overflow: 'hidden',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
          <AutoAwesomeIcon color="primary" sx={{ fontSize: 18 }} />
          <Typography variant="subtitle2" fontWeight={600}>Atlas</Typography>
          {currentModelName && (
            <Chip label={currentModelName} size="small" variant="outlined" sx={{ fontSize: 10, height: 20, maxWidth: 150 }} />
          )}
          <Box sx={{ flex: 1 }} />
          <Tooltip title="Expand chat">
            <IconButton size="small" onClick={() => setExpanded(true)}>
              <OpenInFullIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Close">
            <IconButton size="small" onClick={onClose}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>

        <Box ref={scrollRef} sx={{ flex: 1, overflowY: 'auto', px: 1.5, py: 1, minHeight: 0 }}>
          {!isConfigured && (
            <Typography variant="caption" color="text.secondary">
              {chatConfig?.disabled_reason || 'No AI providers detected — expand to configure.'}
            </Typography>
          )}
          {isConfigured && messages.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Ask about your data, or expand for the full conversation.
            </Typography>
          )}
          {recentMessages.map((msg, i) => (
            <MessageBubble
              key={i}
              {...msg}
              theme={theme}
              chartDAG={chartDAG}
              webgpu={webgpu}
              compact
              onExpand={() => setExpanded(true)}
            />
          ))}
          {loading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ml: 0.5 }}>
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary">Thinking…</Typography>
            </Box>
          )}
        </Box>

        {suggestedPromptsRow}
        {pendingImagesRow}
        {inputRow}
      </Box>
    );
  }

  // When embedded the host (ChartFrame) supplies width/height via its own
  // Box; we render a flex column that fills it. As a Drawer (the default
  // sidebar mount in App.jsx) we keep the persistent right-side surface.
  const Wrapper = embedded ? Box : Drawer;
  const wrapperProps = embedded
    ? {
        sx: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.paper',
        },
      }
    : {
        anchor: 'right',
        open,
        variant: 'persistent',
        sx: {
          width: open ? DRAWER_WIDTH : 0,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
          },
        },
      };

  return (
    <Wrapper {...wrapperProps}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <AutoAwesomeIcon color="primary" />
          <Typography variant="subtitle1" fontWeight={600}>
            Atlas
          </Typography>
          {providerGroups.length > 0 ? (
            <Select
              size="small"
              value={currentComposite}
              onChange={(e) => handleModelChange(e.target.value)}
              variant="outlined"
              sx={{ fontSize: 11, height: 28, minWidth: 160, '& .MuiSelect-select': { py: 0.5, px: 1 } }}
              renderValue={(val) => {
                const [, name] = val.includes('::') ? val.split('::', 2) : ['', val];
                return name || val;
              }}
            >
              {providerGroups.flatMap((pg) => [
                <ListSubheader key={`header-${pg.id}`} sx={{ fontSize: 11, lineHeight: '28px', fontWeight: 700, bgcolor: 'background.paper' }}>
                  {pg.display_name}
                </ListSubheader>,
                ...(pg.models || []).map((m) => (
                  <MenuItem key={`${pg.id}::${m.name}`} value={`${pg.id}::${m.name}`} sx={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 0.5, pl: 3 }}>
                    {m.name}
                    {m.supports_tools && (
                      <Tooltip title="Supports tool calls"><BuildIcon sx={{ fontSize: 12, color: 'success.main', ml: 0.5 }} /></Tooltip>
                    )}
                    {m.supports_thinking && (
                      <Tooltip title="Supports thinking"><PsychologyIcon sx={{ fontSize: 12, color: 'info.main' }} /></Tooltip>
                    )}
                  </MenuItem>
                )),
              ])}
            </Select>
          ) : chatConfig?.default_model ? (
            <Chip
              label={chatConfig.default_model}
              size="small"
              variant="outlined"
              sx={{ fontSize: 11 }}
            />
          ) : null}
        </Box>
        <Box>
          {isSecretsAvailable() && (
            <Tooltip title="LLM provider API keys">
              <IconButton size="small" onClick={() => setKeysOpen(true)}>
                <KeyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Clear conversation">
            <IconButton size="small" onClick={handleClear} disabled={!messages.length}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {!embedded && (
            <Tooltip title="Collapse to bubble">
              <IconButton size="small" onClick={() => setExpanded(false)}>
                <CloseFullscreenIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {!embedded && (
            <IconButton size="small" onClick={onClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      </Box>
      <LLMKeysDialog
        open={keysOpen}
        onClose={() => setKeysOpen(false)}
        onSaved={() => {
          // Sidecar just restarted — re-pull provider list + models.
          fetchChatConfig().then(chat.setChatConfig).catch(() => {});
          fetchChatModels().then(chat.setProviderGroups).catch(() => {});
        }}
      />

      {/* Model capabilities bar */}
      {currentModelName && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.5, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.default' }}>
          {!supportsTools && (
            <Chip icon={<BuildIcon sx={{ fontSize: 12 }} />} label="No tool support" size="small" color="warning" variant="outlined" sx={{ fontSize: 10, height: 22 }} />
          )}
          {supportsThinking && (
            <>
              <PsychologyIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              <ToggleButtonGroup
                size="small"
                value={thinkingLevel}
                exclusive
                onChange={handleThinkingChange}
                sx={{ height: 22 }}
              >
                <ToggleButton value="off" sx={{ fontSize: 10, px: 1, py: 0, textTransform: 'none' }}>Off</ToggleButton>
                <ToggleButton value="on" sx={{ fontSize: 10, px: 1, py: 0, textTransform: 'none' }}>Think</ToggleButton>
              </ToggleButtonGroup>
            </>
          )}
          <Tooltip title="Reasoning effort — lower is faster. Simple tool calls rarely need more than Low.">
            <Select
              size="small"
              value={effort}
              onChange={(e) => handleEffortChange(e.target.value)}
              variant="standard"
              disableUnderline
              renderValue={(v) => (
                REASONING_EFFORTS.find((o) => o.id === v)?.label ?? v
              )}
              sx={{ fontSize: 10, height: 22, ml: 'auto', color: 'text.secondary' }}
            >
              {REASONING_EFFORTS.map((o) => (
                <MenuItem key={o.id} value={o.id} sx={{ fontSize: 12 }}>
                  {o.label}
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    — {o.hint}
                  </Typography>
                </MenuItem>
              ))}
            </Select>
          </Tooltip>
        </Box>
      )}

      {/* Messages */}
      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          overflowY: 'auto',
          px: 2,
          py: 1.5,
        }}
      >
        {!isConfigured && (
          <Box sx={{ mt: 4, px: 3 }}>
            <Box sx={{ textAlign: 'center', mb: 3 }}>
              <AutoAwesomeIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
              <Typography variant="body2" color="text.secondary">
                {chatConfig?.disabled_reason || 'No AI providers detected.'}
              </Typography>
            </Box>
            {!chatConfig?.disabled_reason && (
              <Box sx={{ textAlign: 'left' }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                  Set one or more API keys to enable AI chat:
                </Typography>
                <Box component="pre" sx={{ fontSize: 11, bgcolor: 'action.hover', p: 1.5, borderRadius: 1, overflow: 'auto', lineHeight: 1.7 }}>
{`# Ollama (auto-detected when running locally)
# Install: https://ollama.com

# OpenAI
export OPENAI_API_KEY=sk-...

# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini
export GOOGLE_API_KEY=...

# xAI (Grok)
export XAI_API_KEY=xai-...

# AWS Bedrock
export AWS_BEDROCK_API_KEY=...

# Custom OpenAI-compatible endpoint (e.g. a self-hosted LiteLLM proxy)
export CUSTOM_LLM_BASE_URL=https://llm.example.org/v1
export CUSTOM_LLM_API_KEY=...                       # optional
export CUSTOM_LLM_MODELS=model-a,model-b            # optional: exact allowlist
export CUSTOM_LLM_MODEL_FILTER=                     # optional: regex/substring filter
export CUSTOM_LLM_REASONING_EFFORT=low              # optional: low|medium|high (less thinking = faster)`}
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                  Restart the server after setting environment variables.
                </Typography>
              </Box>
            )}
          </Box>
        )}
        {isConfigured && messages.length === 0 && (
          <Box sx={{ textAlign: 'center', mt: 4, px: 2 }}>
            <AutoAwesomeIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              Ask questions about your data. I can run SQL queries, analyze
              datasets, and help you understand patterns.
            </Typography>
            <Divider sx={{ my: 2 }} />
            <Typography variant="caption" color="text.secondary">
              Try: "What tables are available?" or "Show me the average EV
              adoption rate by state"
            </Typography>
          </Box>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} {...msg} theme={theme} chartDAG={chartDAG} webgpu={webgpu} onMirrorToMain={onMirrorToMain} />
        ))}
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ml: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">
              Thinking…
            </Typography>
          </Box>
        )}
      </Box>

      {suggestedPromptsRow}
      {pendingImagesRow}
      {inputRow}
    </Wrapper>
  );
}
