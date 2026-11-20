/**
 * ChartTray — resizable right-side dock panel for pinned charts.
 *
 * Renders charts in a vertical scrollable list. Three view states:
 *
 *   minimized  — thin 36px strip (click to restore)
 *   normal     — fixed width (user-resizable between MIN_WIDTH and maxTrayWidth())
 *   maximized  — ~90vw, useful for dense inspection
 *
 * Accepts two classes of children:
 *   - `charts`         AI-generated chart objects (chartDAG entries), rendered
 *                      with the legacy ChartTabs-based cards.
 *   - `scenarioFrames` ReactNode — extension scenario charts in 'tray' anchor
 *                      mode. Already-rendered ChartFrame elements; the tray
 *                      is just a layout container for them.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import BarChartIcon from '@mui/icons-material/BarChart';
import AddIcon from '@mui/icons-material/AddCircleOutline';
import { ResponsiveGridLayout, useContainerWidth } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './ChartTray.css';
import { zoomAnchorProps } from '../../lib/zoomAnchor.js';
import { openSyncedTab } from '../../lib/stateBus.js';
import bus from '../../lib/stateBus.js';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';

// Drag handle selector. Matches the className we set on the
// DragIndicatorIcon inside ChartFrame (tray mode).
const GRID_DRAG_HANDLE = '.chart-frame-grid-handle';
const GRID_COLS = { lg: 12, md: 12, sm: 8, xs: 4, xxs: 2 };
const GRID_BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };
const GRID_ROW_HEIGHT = 30;

// Wraps ResponsiveGridLayout with the v2 useContainerWidth hook (which
// replaced the old WidthProvider HOC). Renders a ref'd div so the hook
// can measure available width and feed it into RGL.
//
// `useContainerWidth` returns an object (NOT an array) with
// { width, mounted, containerRef, measureWidth }. measureBeforeMount
// avoids RGL using the placeholder initialWidth on first render.
function ScenarioFramesGrid({ layouts, setLayouts, scenarioFrames, scenarioFrameKeys, dataGridFor }) {
  const { containerRef, width, mounted } = useContainerWidth({ measureBeforeMount: true });
  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {mounted && width > 0 && (
        <ResponsiveGridLayout
          width={width}
          layouts={layouts}
          breakpoints={GRID_BREAKPOINTS}
          cols={GRID_COLS}
          rowHeight={GRID_ROW_HEIGHT}
          margin={[8, 8]}
          containerPadding={[0, 0]}
          draggableHandle={GRID_DRAG_HANDLE}
          // Defense in depth: even with draggableHandle scoping drag to
          // the drag-indicator icon, some interactive widgets (MUI
          // Slider, native inputs, selects) use pointerdown+capture in
          // ways that can still race the grid-item drag path. Exclude
          // them explicitly so slider motion never nudges the tile.
          draggableCancel="input, textarea, select, button, .MuiSlider-root, .MuiSelect-select, .MuiInputBase-root, .MuiCheckbox-root, .MuiSwitch-root, .MuiAutocomplete-root, [data-no-grid-drag]"
          onLayoutChange={(_currentLayout, allLayouts) => setLayouts(allLayouts)}
          compactType="vertical"
          preventCollision={false}
        >
          {React.Children.map(scenarioFrames, (child, i) => {
            const k = scenarioFrameKeys[i];
            // Only attach data-grid for items NOT yet in `layouts` — RGL
            // forbids switching the data-grid prop after first render, and
            // `layouts` is the source of truth once the user has touched
            // the item or onLayoutChange has reported its position.
            const dg = dataGridFor[k];
            return (
              <div key={k} {...(dg ? { 'data-grid': dg } : {})}>
                {child}
              </div>
            );
          })}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}

const MIN_WIDTH = 360;
const MAXIMIZED_WIDTH_VW = 90;

// Max tray width scales with the LOGICAL viewport (window px ÷ display
// zoom) instead of a fixed pixel cap. The old 1200px constant meant the
// tray couldn't reach even a quarter of the wall (15360px @ zoom 3 →
// 5120 logical px, quarter = 1280 > 1200). 60% of the logical viewport
// keeps the map usable while never being the binding constraint on big
// displays; small displays keep the familiar 1200px floor.
function maxTrayWidth(displayScale = 1) {
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1440;
  return Math.max(1200, Math.round((vw / (displayScale || 1)) * 0.6));
}

// Default tray width = one quarter of the LOGICAL viewport (clamped to the
// resize bounds), matching the map/charts split most users land on by hand.
// Computed lazily so it tracks the actual window the tray opens in.
function defaultTrayWidth(displayScale = 1) {
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1440;
  const logical = vw / (displayScale || 1);
  return Math.round(Math.min(maxTrayWidth(displayScale), Math.max(MIN_WIDTH, logical / 4)));
}

export default function ChartTray({
  // `charts` is kept for backwards-compat with callers; the tray no longer
  // renders its own chart cards. All charts (AI + scenario) flow in
  // through `scenarioFrames` as ChartFrame elements wrapped by their host.
  charts,                  // eslint-disable-line no-unused-vars
  rightOffset = 0,
  fullscreen = false,
  webgpu = false,          // eslint-disable-line no-unused-vars
  scenarioFrames,           // ReactNode children pre-rendered by the host
  useGridLayout = false,    // when true, render scenarioFrames inside react-grid-layout
  panelAddOptions,          // Array<{ id, title, icon, disabled }> for the "+ Panel" menu
  onAddPanel,               // (panelId) => void
  onWidthChange,            // (px) => void — the tray's current occupied width (0 when empty),
                            //                so siblings (chat) can sit to its left
}) {
  const { scale: displayScale } = useDisplayScale();
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [panelMenuEl, setPanelMenuEl] = useState(null);
  const [width, setWidth] = useState(() => defaultTrayWidth(displayScale));
  // Per-frame grid layout (keyed by frame key) — survives React-tree
  // remounts of individual frames and grows automatically as new frames
  // are added (with sensible defaults at the first available grid slot).
  const [layouts, setLayouts] = useState({}); // { lg: [{i, x, y, w, h}], ... }

  const currentWidth = collapsed
    ? 36
    : maximized ? `${MAXIMIZED_WIDTH_VW}vw` : width;

  // Sync the tray width across windows over the 'charts' channel. The bus
  // doesn't echo a tab's own publishes back to it (receive() drops
  // sourceId === self), so applying an incoming width never re-publishes —
  // no feedback loop. We publish only on resize-end (see the pointer
  // handler), not on every drag tick, to keep the channel quiet.
  useEffect(() => {
    const unsub = bus.subscribe('charts', (payload) => {
      if (payload?.type === 'chart:set-tray-width' && Number.isFinite(payload.width)) {
        setWidth(Math.min(maxTrayWidth(displayScale), Math.max(MIN_WIDTH, payload.width)));
      }
    });
    return unsub;
  }, [displayScale]);

  const handleResizePointerDown = useCallback((e) => {
    // Manual drag-resize only applies at "normal" width — skip when the
    // tray is maximized (the whole thing is a fixed viewport fraction) or
    // collapsed (no resize handle is shown).
    if (maximized || collapsed) return;
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    let latestW = startWidth;
    function onMove(ev) {
      // Drag movement arrives in screen px; under body{zoom} the tray is
      // laid out in logical px, so divide by the scale to track 1:1.
      const dx = (ev.clientX - startX) / (displayScale || 1);
      latestW = Math.min(maxTrayWidth(displayScale), Math.max(MIN_WIDTH, startWidth - dx));
      setWidth(latestW);
    }
    function onUp(ev) {
      e.target.releasePointerCapture(ev.pointerId);
      e.target.removeEventListener('pointermove', onMove);
      e.target.removeEventListener('pointerup', onUp);
      // Publish the settled width to peer windows (no-op when not in a
      // sync session). The 'charts' channel publish flag still gates it.
      bus.publish('charts', { type: 'chart:set-tray-width', width: latestW }, 'update');
    }
    e.target.addEventListener('pointermove', onMove);
    e.target.addEventListener('pointerup', onUp);
  }, [width, maximized, collapsed, displayScale]);

  const scenarioCount = React.Children.count(scenarioFrames);
  const hasAny = scenarioCount > 0;

  // Report the tray's occupied width up so the chat can dock to its left.
  // 0 when empty (the tray renders nothing below). Right-side offset uses
  // logical px to match the CSS `right` on the chat, so no displayScale math.
  const reportedWidth = !hasAny ? 0
    : collapsed ? 36
    : maximized ? Math.round((document.documentElement.clientWidth * MAXIMIZED_WIDTH_VW) / 100)
    : width;
  useEffect(() => { onWidthChange?.(reportedWidth); }, [reportedWidth, onWidthChange]);
  useEffect(() => () => onWidthChange?.(0), []);  // report 0 on unmount
  const totalCount = scenarioCount;

  // Pull stable React keys out of scenarioFrames so we can use them as
  // RGL item ids. Falls back to index — but every host should be passing
  // keyed children, so this should never trigger.
  const scenarioFrameKeys = React.Children.map(
    scenarioFrames || [],
    (child, i) => (child?.key ?? `frame-${i}`),
  ) || [];

  // For each scenario frame, compute the layout entry that RGL should use
  // as its DEFAULT (via the `data-grid` prop on the child wrapper). RGL
  // prefers `layouts` state where it has an entry for the item, and falls
  // back to `data-grid` when it doesn't. This eliminates the race that
  // happened when we tried to pre-populate `layouts` from a useEffect:
  // RGL would auto-default a missing item BEFORE the effect committed,
  // then fight our update via onLayoutChange.
  const lgKnown = new Set((layouts.lg || []).map((l) => l.i));
  let cursorX = 0;
  const maxYExisting = (layouts.lg || []).reduce(
    (m, l) => Math.max(m, l.y + l.h), 0,
  );
  const dataGridFor = {};
  for (const k of scenarioFrameKeys) {
    if (lgKnown.has(k)) continue;
    dataGridFor[k] = {
      i: k, x: cursorX, y: maxYExisting,
      w: 6, h: 12, minW: 3, minH: 6,
    };
    cursorX = (cursorX + 6) % GRID_COLS.lg;
  }

  // Early return AFTER all hooks have run, so React's hook-order check is
  // stable across renders even when the tray switches between empty and
  // populated states.
  if (!hasAny) return null;

  return (
    <Paper
      elevation={8}
      sx={{
        position: fullscreen ? 'relative' : 'fixed',
        top: fullscreen ? undefined : 0,
        right: fullscreen ? undefined : rightOffset,
        bottom: fullscreen ? undefined : 0,
        width: fullscreen ? '100%' : currentWidth,
        height: fullscreen ? '100%' : undefined,
        zIndex: fullscreen ? undefined : 1300,
        transition: fullscreen ? undefined : 'right 0.2s ease, width 0.15s ease',
        display: 'flex',
        flexDirection: 'row',
        bgcolor: 'background.paper',
        borderLeft: fullscreen ? 0 : 1,
        borderColor: 'divider',
      }}
    >
      {/* Resize handle (left edge) — only in normal (non-collapsed, non-maximized) mode */}
      {!collapsed && !maximized && (
        <Box
          onPointerDown={handleResizePointerDown}
          sx={{
            width: 6,
            cursor: 'ew-resize',
            bgcolor: 'transparent',
            flexShrink: 0,
            '&:hover': { bgcolor: 'primary.main', opacity: 0.3 },
            transition: 'background-color 0.15s',
          }}
        />
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        {/* Header bar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: collapsed ? 0.5 : 1.5,
            py: 0.5,
            borderBottom: collapsed ? 0 : 1,
            borderColor: 'divider',
            minHeight: 36,
            justifyContent: collapsed ? 'center' : 'flex-start',
          }}
        >
          {collapsed ? (
            <Tooltip title={`Chart Tray (${totalCount}) — click to expand`} placement="left">
              <IconButton size="small" onClick={() => setCollapsed(false)} sx={{ p: 0.25 }}>
                <BarChartIcon sx={{ fontSize: 18, color: 'primary.main' }} />
              </IconButton>
            </Tooltip>
          ) : (
            <>
              <BarChartIcon sx={{ fontSize: 16, color: 'primary.main', mr: 0.5 }} />
              <Typography variant="caption" fontWeight={600} sx={{ flex: 1 }}>
                Chart Tray ({totalCount})
              </Typography>
              {panelAddOptions?.length > 0 && (
                <>
                  <Tooltip title="Add panel">
                    <IconButton size="small" onClick={(e) => setPanelMenuEl(e.currentTarget)} sx={{ p: 0.25 }}>
                      <AddIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Menu
                    anchorEl={panelMenuEl}
                    open={!!panelMenuEl}
                    onClose={() => setPanelMenuEl(null)}
                    {...zoomAnchorProps(panelMenuEl, { vertical: 'top', horizontal: 'left' })}
                  >
                    {panelAddOptions.map((o) => {
                      const Icon = o.icon;
                      return (
                        <MenuItem
                          key={o.id}
                          disabled={o.disabled}
                          onClick={() => { onAddPanel?.(o.id); setPanelMenuEl(null); }}
                        >
                          {Icon && <ListItemIcon><Icon fontSize="small" /></ListItemIcon>}
                          <ListItemText>{o.title}</ListItemText>
                        </MenuItem>
                      );
                    })}
                  </Menu>
                </>
              )}
              <Tooltip title="Pop out to new tab">
                <IconButton size="small" onClick={() => openSyncedTab({ view: 'chartTray', sync: { viewport: false, 'layers:visibility': false, 'layers:style': false } })} sx={{ p: 0.25 }}>
                  <OpenInNewIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              {!fullscreen && (
                <Tooltip title={maximized ? 'Restore width' : 'Maximize'}>
                  <IconButton size="small" onClick={() => setMaximized((m) => !m)} sx={{ p: 0.25 }}>
                    {maximized
                      ? <CloseFullscreenIcon sx={{ fontSize: 14 }} />
                      : <OpenInFullIcon sx={{ fontSize: 14 }} />}
                  </IconButton>
                </Tooltip>
              )}
              {!fullscreen && (
                <Tooltip title="Minimize">
                  <IconButton size="small" onClick={() => setCollapsed(true)} sx={{ p: 0.25 }}>
                    <ExpandMoreIcon sx={{ fontSize: 16, transform: 'rotate(-90deg)' }} />
                  </IconButton>
                </Tooltip>
              )}
            </>
          )}
        </Box>

        {/* Chart list. AI charts no longer have a separate inline-card
            section here — they flow through `scenarioFrames` along with
            extension scenario charts, both wrapped in ChartFrame. */}
        {!collapsed && (
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {/* Scenario frames. */}
            {scenarioCount > 0 && (
              useGridLayout ? (
                <ScenarioFramesGrid
                  layouts={layouts}
                  setLayouts={setLayouts}
                  scenarioFrames={scenarioFrames}
                  scenarioFrameKeys={scenarioFrameKeys}
                  dataGridFor={dataGridFor}
                />
              ) : (
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: fullscreen ? 'row' : 'column',
                    flexWrap: fullscreen ? 'wrap' : 'nowrap',
                    alignContent: 'flex-start',
                    alignItems: 'flex-start',
                    gap: 1,
                  }}
                >
                  {scenarioFrames}
                </Box>
              )
            )}
          </Box>
        )}
      </Box>
    </Paper>
  );
}
