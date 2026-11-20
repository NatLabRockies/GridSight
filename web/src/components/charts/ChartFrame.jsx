/**
 * ChartFrame — shared chrome for any chart, anywhere.
 *
 * Wraps chart content with a consistent header row (drag handle, title,
 * host-provided extras, anchor-mode menu, transfer menu, close) and positions
 * itself based on `anchorMode`:
 *
 *   floating   — position: fixed, draggable, resizable (default)
 *   tray       — embedded as a flex child (no positioning of its own)
 *   bottom     — flex child of the bottom ChartDock; own width resizable
 *   side-left  — flex child of the left ChartDock; own height resizable
 *   side-right — flex child of the right ChartDock; own height resizable
 *
 * Docked modes DO NOT self-position. They expect to be mounted inside a
 * ChartDock component — the dock owns edge positioning + perpendicular
 * resize; the frame owns its own band-resize along the stack axis.
 *
 * The frame does NOT know how to render a chart — children render whatever
 * the host wants (AI ChartTabs, extension ChartComponent, etc.). State that
 * belongs to the chart (zoom, unit selector, window size, …) lives in the
 * host and is passed through `headerExtras`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Menu from '@mui/material/Menu';
import Popover from '@mui/material/Popover';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import CloseIcon from '@mui/icons-material/Close';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import PushPinIcon from '@mui/icons-material/PushPin';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import BorderLeftIcon from '@mui/icons-material/BorderLeft';
import BorderRightIcon from '@mui/icons-material/BorderRight';
import SendIcon from '@mui/icons-material/Send';
import TuneIcon from '@mui/icons-material/Tune';
import AddIcon from '@mui/icons-material/Add';
import ScreenShareIcon from '@mui/icons-material/ScreenShare';
import StopScreenShareIcon from '@mui/icons-material/StopScreenShare';
import { useTheme } from '@mui/material/styles';
import { useDrag, usePinch } from '@use-gesture/react';

import { ANCHOR_MODE } from '../../lib/chartDescriptor.js';
import { bus } from '../../lib/stateBus.js';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';
import { zoomAnchorProps } from '../../lib/zoomAnchor.js';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import VisibilityIcon from '@mui/icons-material/Visibility';

const ANCHOR_OPTIONS = [
  { mode: ANCHOR_MODE.FLOATING,   label: 'Float',       Icon: OpenInFullIcon },
  { mode: ANCHOR_MODE.TRAY,       label: 'Pin to Tray', Icon: PushPinIcon },
  { mode: ANCHOR_MODE.BOTTOM,     label: 'Bottom',      Icon: VerticalAlignBottomIcon },
  { mode: ANCHOR_MODE.SIDE_LEFT,  label: 'Side Left',   Icon: BorderLeftIcon },
  { mode: ANCHOR_MODE.SIDE_RIGHT, label: 'Side Right',  Icon: BorderRightIcon },
];

// Menu portals to document.body with default z-index 1300, which is BELOW
// the frame's 1400. Bump it above or the popover disappears behind the chart.
const MENU_Z_INDEX = 1500;

// Custom drag MIME type used by the drag-to-combine flow so we don't collide
// with native text / file drops. The payload value is the source frame's
// `frameKey` (the App-level entry key).
const DRAG_MIME = 'application/x-meridian-chart-frame';

// Fraction of the frame's height, measured from the top, that counts as the
// header's hover zone. Scrubbing or reading the plot below it must NOT summon
// the chrome — the title should stay legible while you work in the chart.
const CHROME_ZONE = 0.2;
// Floor for that band. On a short tray frame 20% can be less than the header
// itself, which would leave the controls unreachable — you'd hover the title
// and nothing would open. Logical px, scaled below for the wall's body{zoom}.
const CHROME_ZONE_MIN_PX = 44;

// Grace period before the header's hover-revealed groups collapse again. Long
// enough to cross a gap or clip a corner without the chrome snapping shut,
// short enough that it doesn't feel stuck open.
const HIDE_DELAY = '0.45s';

const DEFAULT_FLOAT = { x: 320, y: 140, w: 760, h: 440 };
// Default floating geometry as VIEWPORT FRACTIONS (used when no explicit px
// size/position is supplied). Keeps charts a sensible proportion of the
// screen on both a laptop and the 15k wall instead of a fixed pixel size
// that becomes a sliver on the big display.
const DEFAULT_FLOAT_FRAC = { x: 0.18, y: 0.14, w: 0.40, h: 0.38 };

// Logical (pre-zoom) viewport dimensions. Under DisplayScaleProvider's
// `body { zoom: scale }`, an element styled at L logical px renders at L*scale
// device px, so the logical viewport is window.inner* / scale.
function vpW(scale) {
  return (typeof window !== 'undefined' ? window.innerWidth : 1920) / (scale || 1);
}
function vpH(scale) {
  return (typeof window !== 'undefined' ? window.innerHeight : 1080) / (scale || 1);
}
function fracToPos(geom, initialPos, scale) {
  if (geom) return { x: geom.xFrac * vpW(scale), y: geom.yFrac * vpH(scale) };
  if (initialPos) return { x: initialPos.x, y: initialPos.y };
  return { x: DEFAULT_FLOAT_FRAC.x * vpW(scale), y: DEFAULT_FLOAT_FRAC.y * vpH(scale) };
}
function fracToSize(geom, initialSize, scale) {
  if (geom) return { w: geom.wFrac * vpW(scale), h: geom.hFrac * vpH(scale) };
  if (initialSize) return { w: initialSize.w, h: initialSize.h };
  return { w: DEFAULT_FLOAT_FRAC.w * vpW(scale), h: DEFAULT_FLOAT_FRAC.h * vpH(scale) };
}
// Band sizes — how much space a frame claims along the dock's stack axis.
// Side docks stack vertically, so each frame defaults to a height band.
// Bottom dock stacks horizontally, so each frame defaults to a width band.
const DEFAULT_SIDE_BAND_H = 320;
const DEFAULT_BOTTOM_BAND_W = 520;

export default function ChartFrame({
  descriptor,                     // ChartDescriptor (unused today; carried for transfer)
  anchorMode = ANCHOR_MODE.FLOATING,
  onAnchorModeChange,
  onClose,
  // Cross-window transfer — when set, a "Send to window" icon appears in the
  // header. Callback receives the chosen peer's tabId and a `mode` of
  // either 'move' (close local afterwards) or 'mirror' (keep local). The
  // host is responsible for broadcasting on the 'charts' channel and
  // (for 'move') closing the local frame.
  onTransfer,                      // (targetTabId, mode) => void
  // Combine — when set, the frame shows a "+" menu next to the anchor menu
  // that lists other open frames the user can merge into this one. The host
  // is responsible for the data-model merge; the frame just renders the UI.
  combineCandidates,               // Array<{ key, title }>
  onCombine,                       // (sourceKey) => void
  // Mirror — when `onMirrorToggle` is set, a screen-share button appears
  // in the header. The host owns the side effect of pushing/closing the
  // chart on the paired display via the 'charts' bus channel.
  mirrored = false,
  onMirrorToggle,                  // (next: boolean) => void
  // Stable identifier for this frame (App-level entry key). Used as the
  // drag payload for drag-to-combine — grab a frame's title and drop it on
  // another frame to merge them.
  frameKey,
  title,
  headerExtras,                    // host-provided toolbar ReactNode
  // Move headerExtras behind an always-visible options button that opens a
  // popover, instead of rendering it inline in the header. Opt-in, for a wide
  // toolbar of controls (the scrubber charts' window/unit/stack): inline it
  // crowded the title out, and hover-revealing it was undiscoverable and
  // unusable on touch. Hosts whose extras convey STATE — the AI panel's
  // lock indicator — leave this off and stay inline.
  collapseHeaderExtras = false,
  initialFloatPosition,
  initialFloatSize,
  // Cross-display geometry sync. `geom` is the floating position+size as
  // VIEWPORT FRACTIONS ({ xFrac, yFrac, wFrac, hFrac }) so a chart occupies
  // the same proportion of every screen regardless of pixel size/scale.
  // `onGeomChange(frac)` fires on drag/resize/pinch END for the host to
  // store + broadcast. Takes precedence over initialFloatPosition/Size.
  geom,
  onGeomChange,
  children,
}) {
  const theme = useTheme();
  const panel = theme.custom?.panel ?? {};
  const panelRef = useRef(null);
  const { scale: displayScale } = useDisplayScale();

  // Float position / size are internal (uncontrolled). Initialized from the
  // synced `geom` fraction if present, else explicit px props, else a
  // percentage-of-viewport default (so charts don't shrink to a tiny sliver
  // on a huge wall — a fixed-px default that looks right at 1080p is ~10% of
  // a 9999px screen).
  const posRef = useRef(fracToPos(geom, initialFloatPosition, displayScale));
  const sizeRef = useRef(fracToSize(geom, initialFloatSize, displayScale));

  const [anchorMenuEl, setAnchorMenuEl] = useState(null);
  const [extrasMenuEl, setExtrasMenuEl] = useState(null);
  const [transferMenuEl, setTransferMenuEl] = useState(null);
  const [combineMenuEl, setCombineMenuEl] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  // Live peer list for the transfer popover. Subscribed only while the
  // menu is open to avoid rerendering every 2s for every ChartFrame.
  // Filter to tabs sharing THIS tab's session — cross-session tabs won't
  // receive our BroadcastChannel messages anyway.
  const [peers, setPeers] = useState([]);
  useEffect(() => {
    if (!transferMenuEl) return;
    const mySession = bus.getSessionId();
    const filter = (tabs) =>
      tabs.filter((t) => !mySession || t.sessionId === mySession);
    setPeers(filter(bus.discovery.getTabs()));
    const unsub = bus.discovery.onChange((tabs) => setPeers(filter(tabs)));
    return unsub;
  }, [transferMenuEl]);

  // ── Drag-to-combine handlers ────────────────────────────────────────────
  // Source: user picks up the title text. We stash the frame's key in
  // dataTransfer so the drop target knows which frame to merge with.
  const canDrag = !!frameKey;
  function onTitleDragStart(e) {
    if (!canDrag) return;
    try {
      e.dataTransfer.setData(DRAG_MIME, String(frameKey));
      // Plain text fallback so dragging into a text field doesn't crash
      e.dataTransfer.setData('text/plain', String(frameKey));
      e.dataTransfer.effectAllowed = 'move';
    } catch { /* noop */ }
  }
  function onTitleDragEnd() {
    // The drag may have left a stale text-selection range that includes
    // the title and extends across whatever the user dropped onto. The
    // browser then paints ::selection over those nodes — including chart
    // canvases — until the user clicks elsewhere. Clear it explicitly.
    try { window.getSelection?.()?.removeAllRanges(); } catch { /* noop */ }
  }

  // Target: accept a drop only if the dataTransfer carries our MIME type
  // AND the source isn't us. Can't reliably read the payload during
  // dragover (browsers hide it for security), so we accept and rely on
  // onCombine's own dedupe.
  function onFrameDragOver(e) {
    if (!onCombine) return;
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOver) setDragOver(true);
  }
  function onFrameDragLeave(e) {
    // Only clear when leaving the Paper itself, not moving between
    // descendant nodes (enter/leave fire for every child).
    if (e.currentTarget.contains(e.relatedTarget)) return;
    if (dragOver) setDragOver(false);
  }
  function onFrameDrop(e) {
    setDragOver(false);
    if (!onCombine) return;
    const sourceKey = e.dataTransfer.getData(DRAG_MIME);
    if (!sourceKey || sourceKey === frameKey) return;
    e.preventDefault();
    onCombine(sourceKey);
  }

  // Floating-mode drag sets inline `left` / `top` on the DOM node so we can
  // update position without a React re-render. But inline styles override
  // `sx`, so when switching to bottom/side modes those leftover inline
  // values pin the Paper to the old float position. Clear them on every
  // anchor change, and also zero the `width`/`height` inline overrides
  // the browser's `resize: both` handle may have written while floating.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (anchorMode !== ANCHOR_MODE.FLOATING) {
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
    }
  }, [anchorMode]);

  // ── Gesture-driven drag + resize (floating mode), mouse AND touch ─────────
  // @use-gesture/react unifies pointer/touch/pen and (with touch-action:none
  // on the targets) stops the browser hijacking touches for scroll/zoom — so
  // the same handles work from a mouse or the wall's control tablet. Movement
  // arrives in screen px; under DisplayScaleProvider's `body { zoom: scale }`
  // the frame is laid out in logical px, so we divide by displayScale to
  // track the finger 1:1.
  const MIN_FLOAT_W = 480;
  const MIN_FLOAT_H = 240;

  // Report current floating geometry as viewport FRACTIONS on gesture END, so
  // the host can store + broadcast it for cross-display % sync.
  const reportGeom = () => {
    if (!onGeomChange) return;
    onGeomChange({
      xFrac: posRef.current.x / vpW(displayScale),
      yFrac: posRef.current.y / vpH(displayScale),
      wFrac: sizeRef.current.w / vpW(displayScale),
      hFrac: sizeRef.current.h / vpH(displayScale),
    });
  };

  const bindDrag = useDrag(({ movement: [mx, my], memo, first, last }) => {
    if (anchorMode !== ANCHOR_MODE.FLOATING) return memo;
    const base = first ? { ...posRef.current } : memo;
    const x = base.x + mx / displayScale;
    const y = base.y + my / displayScale;
    posRef.current = { x, y };
    if (panelRef.current) {
      panelRef.current.style.left = `${x}px`;
      panelRef.current.style.top = `${y}px`;
    }
    if (last) reportGeom();
    return base;
  }, {
    filterTaps: true,
    // capture: false — let pointer events through to child elements (buttons,
    // menus) instead of setPointerCapture-ing them onto the drag handle. The
    // gesture still tracks movement via window-level listeners once started, so
    // drag fidelity is unaffected; we just stop hijacking clicks on the action
    // icons that sit in the same header row.
    pointer: { touch: true, capture: false },
  });

  const applyFloatSize = (w, h) => {
    const W = Math.max(MIN_FLOAT_W, w);
    const H = Math.max(MIN_FLOAT_H, h);
    sizeRef.current = { w: W, h: H };
    if (panelRef.current) {
      panelRef.current.style.width = `${W}px`;
      panelRef.current.style.height = `${H}px`;
    }
  };

  const bindResize = useDrag(({ movement: [mx, my], memo, first, last }) => {
    const base = first ? { ...sizeRef.current } : memo;
    applyFloatSize(base.w + mx / displayScale, base.h + my / displayScale);
    if (last) reportGeom();
    return base;
  }, { filterTaps: true, pointer: { touch: true, capture: false } });

  const bindPinch = usePinch(({ offset: [s], memo, first, last }) => {
    if (anchorMode !== ANCHOR_MODE.FLOATING) return memo;
    const base = first ? { ...sizeRef.current } : memo;
    applyFloatSize(base.w * s, base.h * s);
    if (last) reportGeom();
    return base;
  }, { scaleBounds: { min: 0.3, max: 6 }, from: () => [1, 0], pointer: { touch: true } });

  // Docked single-axis resize (bottom = width band, side = height band).
  // Replaces the old mouse-only native CSS resize so it works on touch AND
  // can report its size for cross-display sync. offsetWidth/Height read the
  // logical (pre-zoom) size; movement is divided by displayScale to match.
  const isDocked = anchorMode === ANCHOR_MODE.BOTTOM
    || anchorMode === ANCHOR_MODE.SIDE_LEFT
    || anchorMode === ANCHOR_MODE.SIDE_RIGHT;

  const reportDockGeom = () => {
    if (!onGeomChange || !panelRef.current) return;
    const r = panelRef.current.getBoundingClientRect();
    // getBoundingClientRect + window.inner* are both device px under CSS
    // zoom, so the ratio is the scale-independent viewport fraction.
    onGeomChange({
      xFrac: 0,
      yFrac: 0,
      wFrac: r.width / (window.innerWidth || 1),
      hFrac: r.height / (window.innerHeight || 1),
    });
  };

  const bindDockResize = useDrag(({ movement: [mx, my], memo, first, last }) => {
    const el = panelRef.current;
    if (!el || !isDocked) return memo;
    const base = first ? { w: el.offsetWidth, h: el.offsetHeight } : memo;
    if (anchorMode === ANCHOR_MODE.BOTTOM) {
      el.style.width = `${Math.max(320, base.w + mx / displayScale)}px`;
    } else {
      el.style.height = `${Math.max(200, base.h + my / displayScale)}px`;
    }
    if (last) reportDockGeom();
    return base;
  }, { filterTaps: true, pointer: { touch: true, capture: false } });

  // Apply incoming synced geometry (peer update, or a viewport/scale change).
  // Floating syncs full position+size; docked syncs only the band dimension
  // (the dock owns the other axis + position). Idempotent for our own values.
  useEffect(() => {
    if (!geom) return;
    const el = panelRef.current;
    if (!el) return;
    if (anchorMode === ANCHOR_MODE.FLOATING) {
      const x = geom.xFrac * vpW(displayScale);
      const y = geom.yFrac * vpH(displayScale);
      const w = geom.wFrac * vpW(displayScale);
      const h = geom.hFrac * vpH(displayScale);
      posRef.current = { x, y };
      sizeRef.current = { w, h };
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    } else if (anchorMode === ANCHOR_MODE.BOTTOM) {
      el.style.width = `${Math.max(320, geom.wFrac * vpW(displayScale))}px`;
    } else if (anchorMode === ANCHOR_MODE.SIDE_LEFT || anchorMode === ANCHOR_MODE.SIDE_RIGHT) {
      el.style.height = `${Math.max(200, geom.hFrac * vpH(displayScale))}px`;
    }
  }, [geom, anchorMode, displayScale]);

  // ── Anchor-mode-specific container styling ──────────────────────────────
  //
  // Docked modes (side-left/right, bottom) render as flex children of a
  // ChartDock — `position: relative` only. The dock positions itself at the
  // edge. Each frame has its own axis-aligned resize grip so stacked frames
  // within a dock can be rebalanced independently.
  const containerSx = useMemo(() => {
    const common = {
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      // Sides are tighter than top/bottom: the plot brings its own left margin
      // for the y-axis, so frame padding on top of it read as wasted space.
      px: 0.75,
      py: 1,
      bgcolor: panel.bgcolor,
      backdropFilter: panel.backdropFilter,
      border: panel.border,
      color: panel.color,
      // Block text selection across the entire frame. After a drag-to-
      // combine the browser would otherwise leave a selection range
      // spanning the title and the drop target — and paint the selection
      // color (often translucent blue) over every element inside it,
      // including the rendered canvases. Nothing in the chrome benefits
      // from being selectable; charts are pixel output, not text.
      userSelect: 'none',
      WebkitUserSelect: 'none',
      MozUserSelect: 'none',
      // Re-enable pointer events on the frame itself — its dock wrapper is
      // pointerEvents:none so empty dock space passes clicks through, but the
      // frame (and its resize grips/controls) must stay interactive.
      pointerEvents: 'auto',
    };
    switch (anchorMode) {
      case ANCHOR_MODE.TRAY:
        // Embedded inside react-grid-layout (when the tray uses grid mode).
        // The grid container drives sizing — the frame fills 100% of the
        // RGL item bounds. RGL renders its own corner resize handle, so we
        // explicitly disable the native CSS `resize` grip to avoid two
        // conflicting handles on the same corner.
        return {
          ...common,
          position: 'relative',
          width: '100%',
          height: '100%',
          flexShrink: 0,
        };
      case ANCHOR_MODE.BOTTOM:
        // Full dock height; own width band; resize horizontally.
        // maxWidth matches the dock's viewport width so a single chart can
        // be dragged to span the full screen.
        return {
          ...common,
          position: 'relative',
          height: '100%',
          width: initialFloatSize?.w ?? DEFAULT_BOTTOM_BAND_W,
          flexShrink: 0,
          // Native CSS resize is mouse-only and emits no end event (so it
          // can't sync). Replaced by a touch-capable gesture grip below.
          touchAction: 'none',
          minWidth: 320,
          maxWidth: '100vw',
        };
      case ANCHOR_MODE.SIDE_LEFT:
      case ANCHOR_MODE.SIDE_RIGHT:
        // Full dock width; own height band; resize vertically.
        // Same idea as bottom: maxHeight tracks the viewport so a single
        // side chart can fill the vertical space.
        return {
          ...common,
          position: 'relative',
          width: '100%',
          height: initialFloatSize?.h ?? DEFAULT_SIDE_BAND_H,
          flexShrink: 0,
          touchAction: 'none',
          minHeight: 200,
          maxHeight: '100vh',
        };
      case ANCHOR_MODE.FLOATING:
      default:
        return {
          ...common,
          position: 'fixed',
          left: posRef.current.x,
          top: posRef.current.y,
          zIndex: 1400,
          width: sizeRef.current.w,
          height: sizeRef.current.h,
          minWidth: MIN_FLOAT_W,
          minHeight: MIN_FLOAT_H,
          maxWidth: '95vw',
          maxHeight: '90vh',
          // Native CSS resize is mouse-only; we provide a touch-capable resize
          // handle (useDrag) + pinch instead. touch-action:none lets the pinch
          // gesture work without the browser hijacking it for page zoom.
          touchAction: 'none',
        };
    }
  }, [anchorMode, panel, initialFloatSize]);

  const isFloating = anchorMode === ANCHOR_MODE.FLOATING;
  const isTray = anchorMode === ANCHOR_MODE.TRAY;
  // Show the drag-indicator icon in floating mode (for self-positioning)
  // OR in tray mode (where it acts as the drag handle for react-grid-layout
  // to pick up — the className below is what RGL listens for).
  const showDragHandle = isFloating || isTray;

  // Border highlight while a compatible frame is being dragged over us.
  // Pointer is within the frame's top CHROME_ZONE band. Driven from the
  // frame's own rect rather than a CSS :hover on a child, for two reasons:
  // CSS can't express "top 20%", and a child sized by its own reveal would
  // move out from under the cursor as it opened (the flicker this replaces).
  // The frame's box is independent of its contents, so the band is stable.
  const [chromeNear, setChromeNear] = useState(false);

  const handleFrameMouseMove = useCallback((e) => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!(r.height > 0)) return;
    // getBoundingClientRect and clientY are both in VISUAL px, so the
    // percentage needs no correction; the px floor does — it's authored in
    // logical px. See the CSS-zoom notes in DisplayScaleContext.
    const band = Math.max(r.height * CHROME_ZONE, CHROME_ZONE_MIN_PX * (displayScale || 1));
    const near = (e.clientY - r.top) <= band;
    // Only commit real transitions — mousemove fires continuously and this
    // sits above a chart that re-renders every animation tick.
    setChromeNear((prev) => (prev === near ? prev : near));
  }, [displayScale]);

  const handleFrameMouseLeave = useCallback(() => setChromeNear(false), []);

  // Hover-reveal for the header's collapsible groups (action icons, and the
  // scrubber toolbar when the host opts in).
  //
  // These rules live on the FRAME, not on the header row. Revealing reflows the
  // header — the title yields space — which moves the trigger element out from
  // under the cursor near its edge: hover is lost, it collapses, the layout
  // springs back, hover returns, and it flickers. The frame's own box does not
  // change when its contents reflow, so triggering from here is stable by
  // construction. It also matches how media players behave: chrome appears
  // while the pointer is over the thing it belongs to.
  //
  // Opening is immediate; closing waits HIDE_DELAY so brushing past an edge or
  // crossing a gap doesn't snap it shut. Both groups share the timing, or the
  // header would reflow twice on the way out.
  const revealSx = {
    '& .chart-frame-actions': {
      maxWidth: 0,
      overflow: 'hidden',
      opacity: 0,
      pointerEvents: 'none',
      transition: `max-width 0.18s ease ${HIDE_DELAY}, opacity 0.15s ease ${HIDE_DELAY}`,
      display: 'flex',
      alignItems: 'center',
      flexShrink: 0,
    },
    '&.chrome-near .chart-frame-actions, &:focus-within .chart-frame-actions': {
      maxWidth: 180,
      opacity: 1,
      pointerEvents: 'auto',
      transition: 'max-width 0.18s ease, opacity 0.15s ease',
    },
  };

  const containerSxFinal = dragOver
    ? {
        ...containerSx,
        ...revealSx,
        outline: '2px dashed',
        outlineColor: 'primary.main',
        outlineOffset: -2,
      }
    : { ...containerSx, ...revealSx };

  return (
    <Paper
      ref={panelRef}
      elevation={12}
      sx={containerSxFinal}
      className={chromeNear ? 'chrome-near' : undefined}
      onMouseMove={handleFrameMouseMove}
      onMouseLeave={handleFrameMouseLeave}
      {...(isFloating ? bindPinch() : {})}
      onDragOver={onFrameDragOver}
      onDragLeave={onFrameDragLeave}
      onDrop={onFrameDrop}
    >
      {/* Header row. Its height is deliberately independent of the host's
          controls — those live behind the options button's popover — so two
          charts with different control sets get the same header, and opening
          them doesn't reflow it. The action icons collapse to zero width and
          slide in when the pointer is near the top of the frame; those rules
          live on the FRAME (revealSx), not here — see the note there. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          mb: 0.5,
          flexShrink: 0,
        }}
      >
        {showDragHandle && (
          <Box
            // Floating mode: @use-gesture useDrag for mouse+touch
            // self-positioning. Tray mode: the parent uses the
            // `chart-frame-grid-handle` className as react-grid-layout's drag
            // handle, so we don't bind our own gesture there.
            {...(isFloating ? bindDrag() : {})}
            className={isTray ? 'chart-frame-grid-handle' : undefined}
            sx={{
              cursor: 'grab',
              touchAction: isFloating ? 'none' : undefined,
              display: 'flex',
              alignItems: 'center',
              color: panel.dragHandleColor,
              flexShrink: 0,
              '&:active': { cursor: 'grabbing' },
            }}
          >
            <DragIndicatorIcon fontSize="small" />
          </Box>
        )}
        {title && (
          <Typography
            draggable={canDrag}
            onDragStart={onTitleDragStart}
            onDragEnd={onTitleDragEnd}
            variant="subtitle1"
            fontWeight={600}
            noWrap
            title={canDrag ? 'Drag onto another chart to combine them' : undefined}
            sx={{
              // Bigger + centered. Title now grows to fill the middle
              // slot of the header row (between drag handle on the left
              // and the action icons on the right) and centers its text
              // within that span.
              flex: 1,
              minWidth: 0,
              fontSize: 18,
              textAlign: 'center',
              cursor: canDrag ? 'grab' : 'default',
              userSelect: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              '&:active': { cursor: canDrag ? 'grabbing' : 'default' },
            }}
          >
            {title}
          </Typography>
        )}

        {/* Host-provided extras, rendered inline for hosts that did NOT opt
            into the popover (the AI panel's lock indicator — state, which has
            to stay readable). Only allocate the flex slot when something is
            actually rendered into it, or the empty slot would push the
            centered title off to the left. */}
        {headerExtras && !collapseHeaderExtras && (
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            {headerExtras}
          </Box>
        )}

        {/* Chart options — ALWAYS visible (not in the hover-revealed group) so
            the controls are discoverable and reachable by touch, which has no
            hover state. Keeping the toolbar out of the header also decouples
            the header's height from how many control chips a given chart has:
            inline, a wrapped toolbar made the header taller for charts with
            more controls, and taller again when revealed. */}
        {(onAnchorModeChange || (headerExtras && collapseHeaderExtras)) && (
          <>
            <Tooltip title="Chart options">
              <IconButton
                size="small"
                onClick={(e) => setExtrasMenuEl(e.currentTarget)}
                sx={{ p: 0.25, flexShrink: 0 }}
                aria-label="Chart options"
              >
                <TuneIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Popover
              open={Boolean(extrasMenuEl)}
              anchorEl={extrasMenuEl}
              onClose={() => setExtrasMenuEl(null)}
              sx={{ zIndex: MENU_Z_INDEX }}
              {...zoomAnchorProps(extrasMenuEl, { vertical: 'top', horizontal: 'right' })}
            >
              <Box sx={{ p: 1, maxWidth: 420 }}>
                {/* Placement. Duplicated from the hover-revealed anchor menu on
                    purpose: that menu is unreachable without a pointer, so on a
                    touch device a chart could never be popped out, pinned or
                    docked. Same handler, so the two stay in sync. */}
                {onAnchorModeChange && (
                  <>
                    <Typography
                      variant="caption"
                      sx={{ opacity: 0.7, fontSize: 10, fontWeight: 600, display: 'block', mb: 0.5 }}
                    >
                      Placement
                    </Typography>
                    <Stack direction="row" spacing={0.5} sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
                      {ANCHOR_OPTIONS.map(({ mode, label, Icon }) => (
                        <Tooltip key={mode} title={label}>
                          <IconButton
                            size="small"
                            onClick={() => {
                              onAnchorModeChange(mode);
                              setExtrasMenuEl(null);
                            }}
                            sx={{
                              p: 0.5,
                              color: mode === anchorMode ? 'primary.main' : undefined,
                              bgcolor: mode === anchorMode ? 'action.selected' : undefined,
                            }}
                            aria-label={label}
                          >
                            <Icon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      ))}
                    </Stack>
                    {headerExtras && collapseHeaderExtras && <Divider sx={{ mb: 1 }} />}
                  </>
                )}
                {collapseHeaderExtras && headerExtras}
              </Box>
            </Popover>
          </>
        )}

        {/* Action icons — hover/focus-reveal group */}
        <Box className="chart-frame-actions">
        {/* Combine menu — merges another open frame into this one */}
        {onCombine && (combineCandidates?.length ?? 0) > 0 && (
          <>
            <Tooltip title="Combine with another open chart">
              <IconButton
                size="small"
                onClick={(e) => setCombineMenuEl(e.currentTarget)}
                sx={{ p: 0.25, color: panel.closeBtnColor }}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={combineMenuEl}
              open={!!combineMenuEl}
              onClose={() => setCombineMenuEl(null)}
              {...zoomAnchorProps(combineMenuEl, { vertical: 'top', horizontal: 'left' })}
              slotProps={{ root: { sx: { zIndex: MENU_Z_INDEX } } }}
            >
              {combineCandidates.map((c) => (
                <MenuItem
                  key={c.key}
                  onClick={() => {
                    onCombine(c.key);
                    setCombineMenuEl(null);
                  }}
                >
                  {c.title}
                </MenuItem>
              ))}
            </Menu>
          </>
        )}

        {/* Anchor-mode menu */}
        {onAnchorModeChange && (
          <>
            <Tooltip title="Change anchor">
              <IconButton
                size="small"
                onClick={(e) => setAnchorMenuEl(e.currentTarget)}
                sx={{ p: 0.25, color: panel.closeBtnColor }}
              >
                {(() => {
                  const cur = ANCHOR_OPTIONS.find((o) => o.mode === anchorMode)
                    ?? ANCHOR_OPTIONS[0];
                  return <cur.Icon fontSize="small" />;
                })()}
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={anchorMenuEl}
              open={!!anchorMenuEl}
              onClose={() => setAnchorMenuEl(null)}
              {...zoomAnchorProps(anchorMenuEl, { vertical: 'top', horizontal: 'left' })}
              slotProps={{ root: { sx: { zIndex: MENU_Z_INDEX } } }}
            >
              {ANCHOR_OPTIONS.map(({ mode, label, Icon }) => (
                <MenuItem
                  key={mode}
                  selected={mode === anchorMode}
                  onClick={() => {
                    onAnchorModeChange(mode);
                    setAnchorMenuEl(null);
                  }}
                >
                  <ListItemIcon><Icon fontSize="small" /></ListItemIcon>
                  <ListItemText>{label}</ListItemText>
                </MenuItem>
              ))}
            </Menu>
          </>
        )}

        {/* Mirror toggle — when the host opts in (command center hosts a
            chart with a paired display), one click pushes the chart over
            the bus; another click pulls it back. */}
        {onMirrorToggle && (
          <Tooltip title={mirrored ? 'Stop mirroring to display' : 'Mirror to display'}>
            <IconButton
              size="small"
              onClick={() => onMirrorToggle(!mirrored)}
              sx={{
                p: 0.25,
                color: mirrored ? 'primary.main' : panel.closeBtnColor,
              }}
            >
              {mirrored ? <StopScreenShareIcon fontSize="small" /> : <ScreenShareIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}

        {/* Transfer menu — lists discovered peer tabs in this session and
            lets the user send (move) or mirror (copy) the chart there. */}
        {onTransfer && (
          <>
            <Tooltip title="Send to another window…">
              <IconButton
                size="small"
                onClick={(e) => setTransferMenuEl(e.currentTarget)}
                sx={{ p: 0.25, color: panel.closeBtnColor }}
              >
                <SendIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={transferMenuEl}
              open={!!transferMenuEl}
              onClose={() => setTransferMenuEl(null)}
              {...zoomAnchorProps(transferMenuEl, { vertical: 'top', horizontal: 'left' })}
              slotProps={{ root: { sx: { zIndex: MENU_Z_INDEX } } }}
            >
              {peers.length === 0 ? (
                <MenuItem disabled>
                  {bus.isConnected()
                    ? 'No other windows in this session'
                    : 'Not in a sync session'}
                </MenuItem>
              ) : (
                peers.map((p) => (
                  <Box key={p.tabId} sx={{ px: 1, py: 0.5 }}>
                    <Stack direction="row" alignItems="center" spacing={0.5}>
                      <Typography
                        variant="caption"
                        sx={{ flex: 1, minWidth: 160, fontWeight: 600 }}
                        noWrap
                      >
                        {p.title || p.tabId}
                      </Typography>
                      <Tooltip title="Flash this tab to identify it">
                        <IconButton
                          size="small"
                          onClick={() => bus.discovery.flashTab(p.tabId)}
                          sx={{ p: 0.25 }}
                        >
                          <VisibilityIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Move (close local)">
                        <IconButton
                          size="small"
                          onClick={() => {
                            onTransfer(p.tabId, 'move');
                            setTransferMenuEl(null);
                          }}
                          sx={{ p: 0.25 }}
                        >
                          <DriveFileMoveIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Mirror (keep both)">
                        <IconButton
                          size="small"
                          onClick={() => {
                            onTransfer(p.tabId, 'mirror');
                            setTransferMenuEl(null);
                          }}
                          sx={{ p: 0.25 }}
                        >
                          <ContentCopyIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Box>
                ))
              )}
              <Divider />
              <MenuItem
                disabled
                sx={{ fontSize: 10, opacity: 0.6, whiteSpace: 'normal' }}
              >
                Move sends the chart and closes it here. Mirror keeps a
                copy in both windows.
              </MenuItem>
            </Menu>
          </>
        )}

        </Box>

        {/* Close stays OUTSIDE the hover-revealed group and is always visible.
            Dismissing is frequent, conventionally sits at the top right, and is
            the one action a touch user must never have to hunt for — burying it
            behind the options popover would be worse, not better. */}
        {onClose && (
          <IconButton
            size="small"
            onClick={onClose}
            sx={{ p: 0.25, color: panel.closeBtnColor, flexShrink: 0 }}
            aria-label="Close chart"
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        )}
      </Box>

      {/* Body — flex column so hosts can stack chart + legend/etc. vertically.
          Children decide their own flex: the plot area typically uses flex:1,
          legend/footer use auto height.

          In tray mode we swallow pointerdown/touchstart bubbling out of the
          body. react-grid-layout listens for these on its item wrappers to
          start a grid drag; even with draggableHandle scoped to the drag
          indicator, widgets like MUI Slider capture the pointer and RGL's
          handler can still fire. Stopping propagation here keeps the grid
          tile static unless the user grabs the drag icon, the title, or the
          resize corner (those are outside this body or render their own
          stopPropagation). */}
      <Box
        onPointerDown={isTray ? (e) => e.stopPropagation() : undefined}
        onTouchStart={isTray ? (e) => e.stopPropagation() : undefined}
        onMouseDown={isTray ? (e) => e.stopPropagation() : undefined}
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </Box>

      {/* Floating-mode resize grip — touch + mouse via useDrag (replaces the
          mouse-only native CSS resize corner). Pinch also resizes. */}
      {isFloating && (
        <Box
          {...bindResize()}
          aria-label="Resize chart"
          sx={{
            position: 'absolute',
            right: 2,
            bottom: 2,
            width: 24,
            height: 24,
            cursor: 'nwse-resize',
            touchAction: 'none',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'flex-end',
            opacity: 0.45,
            zIndex: 2,
            color: panel.dragHandleColor,
            '&:hover': { opacity: 0.9 },
          }}
        >
          <svg width="12" height="12" viewBox="0 0 10 10">
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          </svg>
        </Box>
      )}

      {/* Bottom-dock resize grip — drag the right edge to widen the band
          (touch + mouse). Reports band width as a viewport fraction. */}
      {anchorMode === ANCHOR_MODE.BOTTOM && (
        <Box
          {...bindDockResize()}
          aria-label="Resize chart width"
          sx={{
            position: 'absolute', top: 0, right: 0, bottom: 0, width: 12,
            cursor: 'ew-resize', touchAction: 'none', zIndex: 3,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        />
      )}

      {/* Side-dock resize grip — drag the bottom edge to change the band
          height (touch + mouse). Reports band height as a viewport fraction. */}
      {(anchorMode === ANCHOR_MODE.SIDE_LEFT || anchorMode === ANCHOR_MODE.SIDE_RIGHT) && (
        <Box
          {...bindDockResize()}
          aria-label="Resize chart height"
          sx={{
            position: 'absolute', left: 0, right: 0, bottom: 0, height: 12,
            cursor: 'ns-resize', touchAction: 'none', zIndex: 3,
            '&:hover': { bgcolor: 'action.hover' },
          }}
        />
      )}
    </Paper>
  );
}
