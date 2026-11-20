import { useRef, useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { useDrag, usePinch } from '@use-gesture/react';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';

/**
 * ResizableChartContainer — wraps a chart in a container that can be resized
 * by dragging the bottom-right corner (mouse OR touch) or by a two-finger
 * pinch anywhere on the chart. Tracks the container size via ResizeObserver
 * and passes the current { width, height } to the children render function.
 *
 * Gestures use @use-gesture/react so the same handles work for mouse, pen,
 * and touch — important for the Insight2D wall, which is driven from a
 * touch tablet. `touch-action: none` on the gesture targets stops the
 * browser from stealing the touch for scrolling. Gesture movement arrives in
 * screen pixels; under the DisplayScaleProvider's `body { zoom: scale }` the
 * container is laid out in logical (pre-zoom) pixels, so drag movement is
 * divided by `displayScale` to track the finger 1:1.
 *
 * Props:
 *   initialWidth, initialHeight: starting size in px
 *   minWidth, minHeight: resize minimums (default 200 / 120)
 *   maxWidth, maxHeight: resize maximums (default Infinity)
 *   onResize: optional callback receiving { width, height } on every change
 *   children: render function receiving { width, height }
 */
export default function ResizableChartContainer({
  initialWidth = 480,
  initialHeight = 340,
  minWidth = 200,
  minHeight = 120,
  maxWidth = Infinity,
  maxHeight = Infinity,
  onResize,
  // `embedded` = rendered inside a host that already owns resizing (e.g. a
  // floating/docked ChartFrame). The container then fills its parent and hides
  // its own resize handle + pinch so there aren't two competing resize affordances
  // (the frame's corner handle and this one). The ResizeObserver still reports the
  // host-driven size to children so the chart fills the frame and grows with it.
  embedded = false,
  children,
}) {
  const containerRef = useRef(null);
  const [size, setSize] = useState({ width: initialWidth, height: initialHeight });
  const { scale: displayScale } = useDisplayScale();

  // Notify parent of size changes
  useEffect(() => {
    onResize?.(size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  // ResizeObserver to track actual size (e.g. flex/layout-driven changes)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setSize({ width: Math.round(width), height: Math.round(height) });
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const clamp = (w, h) => ({
    width: Math.round(Math.min(maxWidth, Math.max(minWidth, w))),
    height: Math.round(Math.min(maxHeight, Math.max(minHeight, h))),
  });

  const applySize = (w, h) => {
    const next = clamp(w, h);
    if (containerRef.current) {
      containerRef.current.style.width = `${next.width}px`;
      containerRef.current.style.height = `${next.height}px`;
    }
    setSize(next);
  };

  // Corner drag-resize (mouse + touch). `memo` carries the size at gesture
  // start so movement is applied relative to it.
  const bindResize = useDrag(({ movement: [mx, my], memo, first }) => {
    const base = first ? { w: size.width, h: size.height } : memo;
    applySize(base.w + mx / displayScale, base.h + my / displayScale);
    return base;
  }, { filterTaps: true, pointer: { touch: true } });

  // Two-finger pinch-resize anywhere on the chart. offset[0] is the
  // cumulative scale factor (1 = unchanged) since the gesture began.
  const bindPinch = usePinch(({ offset: [s], memo, first }) => {
    const base = first ? { w: size.width, h: size.height } : memo;
    applySize(base.w * s, base.h * s);
    return base;
  }, { scaleBounds: { min: 0.25, max: 8 }, from: () => [1, 0], pointer: { touch: true } });

  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  return (
    <Box
      ref={containerRef}
      {...(embedded ? {} : bindPinch())}
      sx={{
        position: 'relative',
        width: embedded ? '100%' : initialWidth,
        height: embedded ? '100%' : initialHeight,
        overflow: 'visible',
        touchAction: embedded ? undefined : 'none',
      }}
    >
      {children(size)}

      {/* Resize handle — bottom-right corner. Mouse + touch via useDrag.
          Hidden when embedded: the host frame owns resizing. */}
      {!embedded && (
      <Box
        {...bindResize()}
        sx={{
          position: 'absolute',
          right: -4,
          bottom: -4,
          width: 22,
          height: 22,
          cursor: 'nwse-resize',
          touchAction: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: 0.5,
          zIndex: 10,
          borderRadius: '4px',
          bgcolor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
          '&:hover': {
            opacity: 1,
            bgcolor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.12)',
          },
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </Box>
      )}
    </Box>
  );
}
