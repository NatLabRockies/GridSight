import { createTheme } from '@mui/material/styles';

/**
 * GridSight theme definitions.
 *
 * Each theme provides a full MUI palette plus a `custom` block for
 * app-specific surface tokens (glassmorphism panels, chart colors, etc.).
 *
 * Components should use:
 *   - Standard MUI tokens (background.paper, text.primary, etc.) for most styling
 *   - theme.custom.panel.* for popup/floating panel glassmorphism
 *   - theme.custom.chart.* for chart color integration (ChartGPU, Vega-Lite)
 */

const panelDark = {
  bgcolor: 'rgba(24, 24, 32, 0.94)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: '#e0e0e0',
  backdropFilter: 'blur(10px)',
  closeBtnColor: 'rgba(255,255,255,0.5)',
  dragHandleColor: 'rgba(255,255,255,0.35)',
};

const chartDark = {
  gridColor: 'rgba(255,255,255,0.06)',
  tickColor: '#999',
  lineColor: '#4fc3f7',
  lineFill: 'rgba(79, 195, 247, 0.1)',
  annotationColor: 'rgba(255, 82, 82, 0.8)',
  annotationBg: 'rgba(255, 82, 82, 0.7)',
};

const panelLight = {
  bgcolor: 'rgba(255, 255, 255, 0.92)',
  border: '1px solid rgba(0,0,0,0.12)',
  color: '#1a1a1a',
  backdropFilter: 'blur(10px)',
  closeBtnColor: 'rgba(0,0,0,0.45)',
  dragHandleColor: 'rgba(0,0,0,0.3)',
};

const chartLight = {
  gridColor: 'rgba(0,0,0,0.08)',
  tickColor: '#555',
  lineColor: '#1976d2',
  lineFill: 'rgba(25, 118, 210, 0.08)',
  annotationColor: 'rgba(211, 47, 47, 0.8)',
  annotationBg: 'rgba(211, 47, 47, 0.7)',
};

// ─── Midnight ────────────────────────────────────────────────────────────────
// Dark blue-gray with cyan accents. The default theme.
const midnight = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#4fc3f7', contrastText: '#0a0a0f' },
    secondary: { main: '#80cbc4' },
    background: {
      default: '#0e1117',
      paper: '#1a1e2e',
    },
    text: { primary: '#e4e6eb', secondary: '#9aa0a8' },
  },
  custom: {
    name: 'midnight',
    displayName: 'Midnight',
    panel: panelDark,
    chart: chartDark,
    sectionHeader: { bgcolor: '#4fc3f7', color: '#0a0a0f' },
    chatBubbleAI: { bgcolor: 'rgba(255,255,255,0.07)', color: '#e4e6eb' },
  },
});

// ─── Slate ───────────────────────────────────────────────────────────────────
// Neutral dark gray with teal/green accents.
const slate = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#66bb6a', contrastText: '#0a0f0a' },
    secondary: { main: '#a5d6a7' },
    background: {
      default: '#121212',
      paper: '#1e1e1e',
    },
    text: { primary: '#e0e0e0', secondary: '#9e9e9e' },
  },
  custom: {
    name: 'slate',
    displayName: 'Slate',
    panel: panelDark,
    chart: { ...chartDark, lineColor: '#66bb6a', lineFill: 'rgba(102, 187, 106, 0.1)' },
    sectionHeader: { bgcolor: '#66bb6a', color: '#0a0f0a' },
    chatBubbleAI: { bgcolor: 'rgba(255,255,255,0.07)', color: '#e0e0e0' },
  },
});

// ─── Ember ───────────────────────────────────────────────────────────────────
// Warm dark tones with amber/orange accents.
const ember = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#ffb74d', contrastText: '#1a0e00' },
    secondary: { main: '#ff8a65' },
    background: {
      default: '#141110',
      paper: '#211c18',
    },
    text: { primary: '#ede0d4', secondary: '#a89888' },
  },
  custom: {
    name: 'ember',
    displayName: 'Ember',
    panel: {
      ...panelDark,
      bgcolor: 'rgba(30, 24, 20, 0.94)',
      border: '1px solid rgba(255,180,100,0.1)',
    },
    chart: { ...chartDark, lineColor: '#ffb74d', lineFill: 'rgba(255, 183, 77, 0.1)' },
    sectionHeader: { bgcolor: '#ffb74d', color: '#1a0e00' },
    chatBubbleAI: { bgcolor: 'rgba(255,255,255,0.06)', color: '#ede0d4' },
  },
});

// ─── NLR ─────────────────────────────────────────────────────────────────────
// Dark theme with NLR brand blue accent.
const nlr = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#0088CE', contrastText: '#ffffff' },
    secondary: { main: '#5bc0de' },
    background: {
      default: '#0d1117',
      paper: '#161b22',
    },
    text: { primary: '#e6edf3', secondary: '#8b949e' },
  },
  custom: {
    name: 'nlr',
    displayName: 'NLR',
    panel: panelDark,
    chart: { ...chartDark, lineColor: '#0088CE', lineFill: 'rgba(0, 136, 206, 0.1)' },
    sectionHeader: { bgcolor: '#0088CE', color: '#ffffff' },
    chatBubbleAI: { bgcolor: 'rgba(255,255,255,0.07)', color: '#e6edf3' },
  },
});

// ─── Daylight ────────────────────────────────────────────────────────────────
// Light theme for daytime / projector use.
const daylight = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1565c0', contrastText: '#ffffff' },
    secondary: { main: '#26a69a' },
    background: {
      default: '#f5f5f5',
      paper: '#ffffff',
    },
  },
  custom: {
    name: 'daylight',
    displayName: 'Daylight',
    panel: panelLight,
    chart: chartLight,
    sectionHeader: { bgcolor: '#1565c0', color: '#ffffff' },
    chatBubbleAI: { bgcolor: '#f0f0f0', color: '#1a1a1a' },
  },
});

// Shared component defaults merged into every theme. On large displays the UI
// is scaled with `body { zoom }`, which makes MUI's internally-anchored menus
// (Select dropdowns) double-apply the zoom and drift off their control. They
// can't use the per-menu zoomAnchorProps helper (no accessible anchorEl), so
// we tag their portal root with `zoom-counter-menu`; DisplayScaleProvider
// injects a matching counter-zoom rule that lands them back on the anchor.
// (Menus with an explicit anchorEl use zoomAnchorProps instead — they are NOT
// tagged, so they don't get double-corrected.)
const SCALE_AWARE_COMPONENTS = {
  MuiSelect: {
    defaultProps: {
      MenuProps: { slotProps: { root: { className: 'zoom-counter-menu' } } },
    },
  },
};

const withScaleFixes = (theme) => createTheme(theme, { components: SCALE_AWARE_COMPONENTS });

export const THEMES = {
  midnight: withScaleFixes(midnight),
  slate: withScaleFixes(slate),
  ember: withScaleFixes(ember),
  nlr: withScaleFixes(nlr),
  daylight: withScaleFixes(daylight),
};
export const THEME_NAMES = Object.keys(THEMES);
export const DEFAULT_THEME = 'midnight';
