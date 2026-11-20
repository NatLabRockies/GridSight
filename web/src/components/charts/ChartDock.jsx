/**
 * ChartDock — edge container that stacks ChartFrames along one edge.
 *
 *   edge='left'   — fixed to left edge, flex column; frames stack top→bottom
 *   edge='right'  — fixed to right edge, flex column; frames stack top→bottom
 *   edge='bottom' — fixed to bottom edge, flex row; frames stack left→right
 *
 * The dock itself is resizable on its perpendicular axis (the edge that
 * faces the map). Each ChartFrame inside the dock owns its own axis-aligned
 * resize grip so users can rebalance heights (side) or widths (bottom)
 * between stacked charts independently.
 *
 * Docks render nothing when empty, so App.jsx can unconditionally mount all
 * three — they appear only when a chart adopts that anchor mode.
 */

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { useDrag } from '@use-gesture/react';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';
import bus from '../../lib/stateBus.js';

const DEFAULT_SIZE = { left: 480, right: 480, bottom: 320 };
const MIN_SIZE = 240;
const MAX_SIZE_VH = 0.9; // 90% of the perpendicular viewport dim

export default function ChartDock({
  edge,                // 'left' | 'right' | 'bottom'
  children,
  initialSize,
  topOffset = 0,       // room for toolbars / chrome above the dock
  rightOffset = 0,     // e.g. make room for the ChartTray on the right side
  onSizeChange,        // (size: number) => void — fires on every resize tick + on mount
}) {
  const [size, setSize] = useState(initialSize ?? DEFAULT_SIZE[edge]);
  const isSide = edge === 'left' || edge === 'right';
  const { scale: displayScale } = useDisplayScale();

  // Notify parent on mount and whenever the dock is resized so siblings
  // (map legends, chart tray) can offset themselves out of the way.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onSizeChange?.(size); }, [size]);

  const maxSize = () => {
    const dim = isSide ? window.innerWidth : window.innerHeight;
    return Math.floor(dim * MAX_SIZE_VH);
  };

  // Perpendicular (dock-size) resize. @use-gesture so it works on touch (the
  // wall's control tablet) as well as mouse; movement is divided by
  // displayScale because the dock is laid out in logical px under the body
  // zoom. `memo` carries the size at gesture start.
  const perpViewport = () => (edge === 'bottom' ? window.innerHeight : window.innerWidth) || 1;

  // Broadcast the dock size as a fraction of its perpendicular viewport
  // dimension so a paired display frames the dock at the same proportion
  // regardless of pixel size. This is the dock-axis counterpart to the
  // per-frame band sync in ChartFrame — together they keep a docked chart's
  // BOTH dimensions in sync across displays.
  const reportSize = (sz) => {
    bus.publish('charts', { type: 'dock:size', edge, frac: (sz * displayScale) / perpViewport() }, 'update');
  };

  const bindResize = useDrag(({ movement: [mx, my], memo, first, last }) => {
    const startSize = first ? size : memo;
    let delta;
    if (edge === 'left')       delta = mx / displayScale;       // drag right → wider
    else if (edge === 'right') delta = -mx / displayScale;      // drag left  → wider
    else                       delta = -my / displayScale;      // drag up    → taller (bottom)
    const next = Math.min(maxSize(), Math.max(MIN_SIZE, startSize + delta));
    setSize(next);
    if (last) reportSize(next);
    return startSize;
  }, { filterTaps: true, pointer: { touch: true } });

  // Apply a dock size synced from a paired display (same edge only).
  useEffect(() => {
    return bus.subscribe('charts', (payload) => {
      if (payload?.type !== 'dock:size' || payload.edge !== edge) return;
      const sz = (payload.frac * perpViewport()) / displayScale;
      setSize(Math.min(maxSize(), Math.max(MIN_SIZE, sz)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge, displayScale]);

  const containerSx = {
    position: 'fixed',
    zIndex: 1400,
    display: 'flex',
    bgcolor: 'transparent',
    pointerEvents: 'none',       // children re-enable; empty dock gaps don't block map interaction
    ...(edge === 'left'   && { left: 0, top: topOffset, bottom: 0, width: size, flexDirection: 'column' }),
    ...(edge === 'right'  && { right: rightOffset, top: topOffset, bottom: 0, width: size, flexDirection: 'column' }),
    ...(edge === 'bottom' && { left: 0, right: rightOffset, bottom: 0, height: size, flexDirection: 'row' }),
  };

  const handleSx = {
    position: 'absolute',
    pointerEvents: 'auto',
    touchAction: 'none',
    bgcolor: 'transparent',
    zIndex: 1,
    // 12px hit target (was 6px) — easier to grab with a finger on the wall.
    ...(edge === 'left'   && { right: -6, top: 0, bottom: 0, width: 12, cursor: 'ew-resize' }),
    ...(edge === 'right'  && { left: -6, top: 0, bottom: 0, width: 12, cursor: 'ew-resize' }),
    ...(edge === 'bottom' && { left: 0, right: 0, top: -6, height: 12, cursor: 'ns-resize' }),
    '&:hover': { bgcolor: 'primary.main', opacity: 0.4 },
    transition: 'background-color 0.15s',
  };

  const innerSx = {
    flex: 1,
    display: 'flex',
    flexDirection: isSide ? 'column' : 'row',
    gap: 0.5,
    p: 0.5,
    overflow: 'auto',
    // The inner wrapper stretches across the WHOLE dock span (flex:1), but the
    // frames inside have their own bands and don't fill it. Keep it transparent
    // to pointer events so the empty area (e.g. to the right of a single bottom
    // frame) doesn't swallow clicks meant for the chat/map below — each
    // ChartFrame re-enables pointerEvents on itself.
    pointerEvents: 'none',
  };

  return (
    <Box sx={containerSx}>
      <Box {...bindResize()} sx={handleSx} />
      <Box sx={innerSx}>
        {children}
      </Box>
    </Box>
  );
}
