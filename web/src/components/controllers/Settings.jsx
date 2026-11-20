import React, { useState, useEffect } from 'react';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import ApiOutlinedIcon from '@mui/icons-material/ApiOutlined';
import { ExtensionIcon } from '../primitives/index.jsx';
import ExtensionInstaller from './ExtensionInstaller.jsx';
import AgentSetupDialog from '../dialogs/AgentSetupDialog.jsx';
import { useTheme } from '@mui/material/styles';
import { BASEMAPS, FEATURE_CATEGORIES, basemapById } from '../../lib/basemaps.js';
import { useMeridianTheme } from '../../lib/ThemeContext.jsx';
import { useDisplayScale, SCALE_MODES } from '../../lib/DisplayScaleContext.jsx';
import { THEMES, THEME_NAMES } from '../../lib/themes.js';
import { FONTS, FONT_IDS } from '../../lib/fonts.js';
import { getExtraInstructions, setExtraInstructions } from '../../lib/aiSettings.js';
import { fetchExtensionPreferences, setExtensionPreference } from '../../lib/loaders.js';
import LinearProgress from '@mui/material/LinearProgress';
import useWhisperPreference from '../../hooks/useWhisperPreference.js';
import { WHISPER_MODELS } from '../../lib/whisperPreference.js';
import { isWhisperInputSupported } from '../../hooks/useWhisperInput.js';

// ── Shared panel shell ──────────────────────────────────────────────────────

function PanelShell({ title, children }) {
  const theme = useTheme();
  return (
    <Paper elevation={1} sx={{ width: 500, borderRadius: 2 }}>
      <Box sx={{ bgcolor: theme.custom?.sectionHeader?.bgcolor ?? 'primary.main', px: 1, py: 0.25 }}>
        <Typography
          variant="subtitle1"
          fontWeight={600}
          align="center"
          sx={{ color: theme.custom?.sectionHeader?.color ?? 'primary.contrastText' }}
        >
          {title}
        </Typography>
      </Box>
      <Box sx={{ p: 2 }}>{children}</Box>
    </Paper>
  );
}

// ── Theme swatch ────────────────────────────────────────────────────────────

function ThemeSwatch({ themeDef, selected, onClick }) {
  const c = themeDef.custom;
  const bg = themeDef.palette.background.paper;
  const accent = themeDef.palette.primary.main;
  const text = themeDef.palette.text.primary;

  return (
    <ToggleButton
      value={c.name}
      selected={selected}
      onClick={onClick}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.5,
        p: 1.5,
        textTransform: 'none',
        borderRadius: 2,
        border: selected ? `2px solid ${accent}` : '2px solid transparent',
      }}
    >
      <Box
        sx={{
          width: 64,
          height: 40,
          borderRadius: 1,
          bgcolor: bg,
          border: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <Box sx={{ display: 'flex', gap: 0.3 }}>
          <Box sx={{ width: 8, height: 20, borderRadius: 0.5, bgcolor: accent }} />
          <Stack spacing={0.3}>
            <Box sx={{ width: 30, height: 4, borderRadius: 0.5, bgcolor: text, opacity: 0.6 }} />
            <Box sx={{ width: 22, height: 4, borderRadius: 0.5, bgcolor: text, opacity: 0.3 }} />
            <Box sx={{ width: 26, height: 4, borderRadius: 0.5, bgcolor: text, opacity: 0.3 }} />
          </Stack>
        </Box>
      </Box>
      <Typography variant="caption" sx={{ fontWeight: selected ? 700 : 400 }}>
        {c.displayName}
      </Typography>
    </ToggleButton>
  );
}

// ── Display ─────────────────────────────────────────────────────────────────

export function DisplaySettings({
  baseLayerProp, onBaseLayerChange,
  hiddenBasemapCategories, onToggleBasemapCategory,
}) {
  const { themeName, setThemeName, fontName, setFontName } = useMeridianTheme();
  const { mode: scaleMode, scale, autoScale, setMode: setScaleMode } = useDisplayScale();

  return (
    <PanelShell title="Display">
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="body2" fontWeight={500} gutterBottom>Base Map</Typography>
          <FormControl fullWidth size="small">
            <InputLabel id="base-map-label">Base Map</InputLabel>
            <Select
              labelId="base-map-label"
              value={baseLayerProp ?? ''}
              label="Base Map"
              onChange={(e) => onBaseLayerChange?.(e.target.value)}
            >
              {BASEMAPS.map((b) => (
                <MenuItem key={b.id} value={b.id}>{b.label}</MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Per-category detail toggles — declutter the basemap to the task:
              streets on for a distribution view, waterways for a hydro study,
              everything off for the wall. Only vector styles expose these
              layers; satellite has no vector categories to toggle. */}
          {basemapById(baseLayerProp).kind === 'vector' && onToggleBasemapCategory && (
            <Box sx={{ mt: 1.5 }}>
              <Typography variant="caption" color="text.secondary">
                Basemap detail
              </Typography>
              <Stack sx={{ mt: 0.25 }}>
                {FEATURE_CATEGORIES.map((cat) => (
                  <FormControlLabel
                    key={cat.id}
                    sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
                    control={(
                      <Switch
                        size="small"
                        checked={!(hiddenBasemapCategories?.has?.(cat.id))}
                        onChange={() => onToggleBasemapCategory(cat.id)}
                      />
                    )}
                    label={cat.label}
                  />
                ))}
              </Stack>
            </Box>
          )}
        </Box>

        <Divider />

        <Box>
          <Typography variant="body2" fontWeight={500} gutterBottom>Theme</Typography>
          <ToggleButtonGroup
            value={themeName}
            exclusive
            onChange={(_, val) => { if (val) setThemeName(val); }}
            sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
          >
            {THEME_NAMES.map((name) => (
              <ThemeSwatch
                key={name}
                themeDef={THEMES[name]}
                selected={themeName === name}
                onClick={() => setThemeName(name)}
              />
            ))}
          </ToggleButtonGroup>
        </Box>

        <Divider />

        <Box>
          <Typography variant="body2" fontWeight={500} gutterBottom>Font</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Interface typeface. All options use fonts already on this machine —
            nothing is downloaded — so an unavailable face falls back to the
            system one.
          </Typography>
          <Select
            size="small"
            fullWidth
            value={fontName}
            onChange={(e) => setFontName(e.target.value)}
          >
            {FONT_IDS.map((id) => (
              <MenuItem key={id} value={id} sx={{ fontFamily: FONTS[id].stack }}>
                {FONTS[id].label}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ ml: 1, fontFamily: 'inherit' }}
                >
                  — {FONTS[id].hint}
                </Typography>
              </MenuItem>
            ))}
          </Select>
        </Box>

        <Divider />

        <AssistantSettings />

        <Divider />

        <Box>
          <Typography variant="body2" fontWeight={500} gutterBottom>Display Scale</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Scale the entire UI for very large displays.{' '}
            <strong>Auto</strong> picks a factor from the viewport size (currently {autoScale}×).
          </Typography>
          <ToggleButtonGroup
            value={scaleMode}
            exclusive
            onChange={(_, val) => { if (val) setScaleMode(val); }}
            size="small"
            sx={{ flexWrap: 'wrap', gap: 0.5 }}
          >
            {SCALE_MODES.map((m) => (
              <ToggleButton key={m} value={m} sx={{ textTransform: 'none', px: 1.5 }}>
                {m}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Active scale: {scale}×.
          </Typography>
        </Box>
      </Stack>
    </PanelShell>
  );
}

// ── Extensions ───────────────────────────────────────────────────────────────

export function ExtensionsSettings({ onExtensionPrefChanged }) {
  const [extPrefs, setExtPrefs] = useState([]);
  useEffect(() => {
    fetchExtensionPreferences()
      .then(setExtPrefs)
      .catch((e) => console.error('[Settings] fetchExtensionPreferences:', e));
  }, []);

  async function handleExtStateChange(extName, newState) {
    try {
      await setExtensionPreference(extName, newState);
      setExtPrefs((prev) =>
        prev.map((p) => (p.name === extName ? { ...p, state: newState } : p))
      );
      onExtensionPrefChanged?.();
    } catch (e) {
      console.error('[Settings] setExtensionPreference:', e);
    }
  }

  return (
    <PanelShell title="Extensions">
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="body2" fontWeight={500} gutterBottom>Install</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Install Python extensions into the desktop venv. Restart the backend
            after install to pick up new entry-points.
          </Typography>
          <ExtensionInstaller />
        </Box>

        {extPrefs.length > 0 && (
          <>
            <Divider />
            <Box>
              <Typography variant="body2" fontWeight={500} gutterBottom>Visibility</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Control which extensions are active. Hidden extensions are removed
                from the sidebar entirely.
              </Typography>
              <Stack spacing={1}>
                {extPrefs.map((ext) => (
                  <Stack key={ext.name} direction="row" alignItems="center" spacing={1.5} sx={{ py: 0.25 }}>
                    <ExtensionIcon ext={ext} fontSize="small" color="action" />
                    <Typography variant="body2" sx={{ flex: 1 }}>{ext.display_name}</Typography>
                    <FormControl size="small" sx={{ minWidth: 110 }}>
                      <Select
                        value={ext.state}
                        onChange={(e) => handleExtStateChange(ext.name, e.target.value)}
                        size="small"
                        sx={{ fontSize: 13 }}
                      >
                        <MenuItem value="enabled">
                          <Chip label="Enabled" size="small" color="success" variant="outlined" sx={{ fontSize: 11 }} />
                        </MenuItem>
                        <MenuItem value="disabled">
                          <Chip label="Disabled" size="small" color="warning" variant="outlined" sx={{ fontSize: 11 }} />
                        </MenuItem>
                        <MenuItem value="hidden">
                          <Chip label="Hidden" size="small" color="error" variant="outlined" sx={{ fontSize: 11 }} />
                        </MenuItem>
                      </Select>
                    </FormControl>
                  </Stack>
                ))}
              </Stack>
            </Box>
          </>
        )}
      </Stack>
    </PanelShell>
  );
}

// ── Agent Integration ────────────────────────────────────────────────────────

export function AgentSettings() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <PanelShell title="Agent Integration">
      <Stack spacing={1.5}>
        <Typography variant="body2" color="text.secondary">
          Connect AI agents (Claude, Claude Code, and others) to Meridian via MCP
          so they can read data and control the map directly.
        </Typography>
        <Box>
          <Button
            variant="outlined"
            startIcon={<ApiOutlinedIcon />}
            onClick={() => setDialogOpen(true)}
            size="small"
          >
            Set up agent integration
          </Button>
        </Box>
      </Stack>
      <AgentSetupDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </PanelShell>
  );
}

// ── On-device voice input (Whisper WASM) ────────────────────────────────────
// Opt-in speech-to-text that runs entirely in the browser, for environments
// where the native Web Speech API is unavailable (the Electron table, offline,
// non-Chromium). The model downloads once — on first toggle-on — from this
// origin, then is cached.
/**
 * AssistantSettings — extra system-prompt instructions.
 *
 * Reasoning effort lives in the chat bar instead: it is a per-turn speed/depth
 * trade made while working, not something to hunt for in a settings panel.
 *
 * The editor opens in a dialog because writing prompt text in a four-line box
 * is miserable — instructions are paragraphs, and you need to see the whole
 * thing to judge whether it says what you meant.
 */
function AssistantSettings() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const saved = getExtraInstructions();

  const openEditor = () => { setDraft(getExtraInstructions()); setOpen(true); };
  const commit = () => { setExtraInstructions(draft); setOpen(false); };

  const preview = saved.trim()
    ? `${saved.trim().split('\n')[0].slice(0, 60)}${saved.length > 60 ? '…' : ''}`
    : 'None set';

  return (
    <Box>
      <Typography variant="body2" fontWeight={500} gutterBottom>Assistant instructions</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Appended to the assistant&apos;s system prompt, last, so they outrank its
        general guidance. Use them for house rules and domain conventions —
        preferred units, which layers matter, how to treat a dataset.
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography
          variant="caption"
          color={saved.trim() ? 'text.primary' : 'text.secondary'}
          sx={{ flex: 1, fontStyle: saved.trim() ? 'normal' : 'italic' }}
          noWrap
        >
          {preview}
        </Typography>
        <Button size="small" variant="outlined" onClick={openEditor}>
          {saved.trim() ? 'Edit' : 'Add'}
        </Button>
      </Box>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Assistant instructions</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            These are appended to the system prompt for every message. They do
            not replace it — the tool descriptions, data catalog and current
            view state stay in place.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={16}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={'Always report demand in TWh.\n\nTreat "industrial" as all carriers, not electricity alone.\n\nWhen showing a state, hide the national layers.'}
            InputProps={{ sx: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.6 } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={commit}>Save</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function WhisperVoiceSetting() {
  const { enabled, model, setEnabled, setModel } = useWhisperPreference();
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const micSupported = isWhisperInputSupported();

  // Download (or switch) the model whenever it's enabled and the selection
  // changes. Preloading on toggle means the mic is ready before first use.
  useEffect(() => {
    if (!enabled) { setStatus('idle'); setProgress(0); return; }
    let cancelled = false;
    setStatus('loading'); setProgress(0);
    import('../../lib/whisperEngine.js')
      .then(({ preload }) => preload(model, (pct) => { if (!cancelled) setProgress(pct); }))
      .then(() => { if (!cancelled) setStatus('ready'); })
      .catch((e) => { if (!cancelled) { console.warn('[whisper] preload failed:', e); setStatus('error'); } });
    return () => { cancelled = true; };
  }, [enabled, model]);

  return (
    <>
      <Divider sx={{ my: 0.5 }} />
      <Typography variant="body2" fontWeight={500}>Voice input</Typography>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        }
        label="On-device voice input (Whisper)"
      />
      {enabled && (
        <Stack spacing={0.75} sx={{ pl: 1 }}>
          <FormControl size="small" sx={{ maxWidth: 320 }}>
            <InputLabel id="whisper-model-label">Model</InputLabel>
            <Select
              labelId="whisper-model-label"
              label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {WHISPER_MODELS.map((m) => (
                <MenuItem key={m.id} value={m.id}>{m.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
          {status === 'loading' && (
            <Box sx={{ maxWidth: 320 }}>
              <Typography variant="caption" color="text.secondary">
                Downloading model… {progress}%
              </Typography>
              <LinearProgress variant={progress > 0 ? 'determinate' : 'indeterminate'} value={progress} />
            </Box>
          )}
          {status === 'ready' && (
            <Chip size="small" color="success" label="Model ready — cached for next time" sx={{ alignSelf: 'flex-start' }} />
          )}
          {status === 'error' && (
            <Chip size="small" color="error" label="Model download failed — check network / assets" sx={{ alignSelf: 'flex-start' }} />
          )}
          {!micSupported && (
            <Typography variant="caption" color="warning.main">
              Mic capture needs a secure context (HTTPS / file:// / app://). Whisper
              runs locally, but the browser blocks the microphone on plain http://.
            </Typography>
          )}
        </Stack>
      )}
      <Typography variant="caption" color="text.secondary">
        Runs speech-to-text fully on-device — no cloud, works in the Electron
        table where the native mic API doesn't. The model (~40–140 MB depending
        on choice) downloads once on first enable, then is cached.
      </Typography>
    </>
  );
}

// ── Developer ─────────────────────────────────────────────────────────────────

export function DeveloperSettings({ gpu, stats, forceDpr1, maxCanvasSize, workerPrecompute, gpuTimeseries }) {
  return (
    <PanelShell title="Developer">
      <Stack spacing={1.25}>
        <Typography variant="body2" fontWeight={500}>Renderer</Typography>

        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" sx={{ minWidth: 140 }}>WebGPU support</Typography>
          {!gpu?.checked ? (
            <Chip size="small" label="Detecting…" />
          ) : gpu.supported ? (
            <Chip
              size="small"
              color="success"
              label={gpu.adapter?.vendor
                ? `Available (${gpu.adapter.vendor}${gpu.adapter.architecture ? ' / ' + gpu.adapter.architecture : ''})`
                : 'Available'}
            />
          ) : (
            <Chip size="small" color="default" label="Not supported by this browser" />
          )}
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" sx={{ minWidth: 140 }}>Currently using</Typography>
          <Chip
            size="small"
            color={gpu?.active ? 'warning' : 'primary'}
            label={gpu?.active ? 'ChartGPU (experimental)' : 'Plotly (default, WebGL via scattergl)'}
          />
        </Stack>

        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={gpu?.preferred ?? false}
              disabled={!gpu?.supported}
              onChange={(e) => gpu?.setPreferred(e.target.checked)}
            />
          }
          label="Experimental: WebGPU charts (ChartGPU)"
        />
        <Typography variant="caption" color="text.secondary">
          Deprecated. ChartGPU requires a secure context (HTTPS) which our
          deployment can't provide, so the default renderer is Plotly. Toggling
          this on switches the scrubber and histogram panels to ChartGPU; useful
          only for local dev or when the page is served over HTTPS/localhost in a
          WebGPU-capable browser (Chrome/Edge 113+, Safari 18+).
        </Typography>

        {stats && (
          <>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={!!stats.show}
                  onChange={(e) => stats.setShow(e.target.checked)}
                />
              }
              label="Show FPS / GPU stats overlay"
            />
            <Typography variant="caption" color="text.secondary">
              Mounts deck.gl's StatsWidget in the upper-right of the map. Opens
              expanded; click the HUD header to collapse.
            </Typography>
          </>
        )}

        {forceDpr1 && (
          <>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={!!forceDpr1.enabled}
                  onChange={(e) => forceDpr1.setEnabled(e.target.checked)}
                />
              }
              label="Force 1× device pixel ratio"
            />
            <Typography variant="caption" color="text.secondary">
              On high-DPR displays (especially the 100 MP video wall), rendering at
              native DPR can be 4× the fragment work. Forcing 1× sacrifices a touch
              of edge crispness for substantial GPU headroom — try this first if the
              wall is jittering.
            </Typography>
          </>
        )}

        {maxCanvasSize && <MaxCanvasSizeControl maxCanvasSize={maxCanvasSize} />}

        {workerPrecompute && (
          <>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={!!workerPrecompute.enabled}
                  onChange={(e) => workerPrecompute.setEnabled(e.target.checked)}
                />
              }
              label="Web Worker timeseries precompute"
            />
            <Typography variant="caption" color="text.secondary">
              Precomputes per-(timestep × feature) style buffers off the main thread
              once per partition load. Per-tick CPU becomes a memcpy from the worker
              buffer into the cached path slots. Currently applies to
              TransmissionLayer; reload to switch paths cleanly.
            </Typography>
          </>
        )}

        {gpuTimeseries && (
          <>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={!!gpuTimeseries.enabled}
                  disabled={!workerPrecompute?.enabled}
                  onChange={(e) => gpuTimeseries.setEnabled(e.target.checked)}
                />
              }
              label="GPU-resident timeseries (Phase 3)"
            />
            <Typography variant="caption" color="text.secondary">
              Uploads the worker's whole-partition style buffer as a Float32 texture
              and indexes into it from the vertex shader by feature index. Per-tick
              CPU becomes a single uniform write — the only path that scales
              sublinearly with feature count. Requires Web Worker precompute above
              plus an <code> EXT_color_buffer_float </code> capable WebGL2 context.
            </Typography>
          </>
        )}

        <WhisperVoiceSetting />
      </Stack>
    </PanelShell>
  );
}

// ── MapLibre maxCanvasSize control ──────────────────────────────────────────

function MaxCanvasSizeControl({ maxCanvasSize }) {
  const { width, height, setSize, reset, defaultWidth, defaultHeight } = maxCanvasSize;
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));

  useEffect(() => { setW(String(width)); setH(String(height)); }, [width, height]);

  const dirty = String(width) !== w || String(height) !== h;
  const apply = () => {
    const nw = parseInt(w, 10);
    const nh = parseInt(h, 10);
    if (Number.isFinite(nw) && nw > 0 && Number.isFinite(nh) && nh > 0) setSize(nw, nh);
  };

  return (
    <Box sx={{ mt: 0.5 }}>
      <Typography variant="body2" sx={{ mb: 0.5 }}>MapLibre max canvas size</Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          size="small"
          label="Width (px)"
          value={w}
          onChange={(e) => setW(e.target.value)}
          inputProps={{ inputMode: 'numeric', pattern: '[0-9]*' }}
          sx={{ width: 120 }}
        />
        <TextField
          size="small"
          label="Height (px)"
          value={h}
          onChange={(e) => setH(e.target.value)}
          inputProps={{ inputMode: 'numeric', pattern: '[0-9]*' }}
          sx={{ width: 120 }}
        />
        <Button size="small" variant="contained" disabled={!dirty} onClick={apply}>Apply</Button>
        <Button
          size="small"
          variant="outlined"
          onClick={reset}
          disabled={width === defaultWidth && height === defaultHeight}
        >
          Reset
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        Caps the maplibre-gl drawing canvas. The cap is a ceiling, not an allocation —
        MapLibre only sizes its buffer up to <code>min(viewport × DPR, cap)</code>, so a
        larger cap doesn't cost memory until the viewport actually needs it. Default{' '}
        <strong>{defaultWidth}×{defaultHeight}</strong>. <strong>maplibre reads this
        value at map construction</strong> — reload after Apply for the change to take effect.
      </Typography>
    </Box>
  );
}
