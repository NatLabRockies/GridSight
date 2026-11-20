import { useState, useEffect, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Slider from '@mui/material/Slider';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';

import { fetchInputControls, setInputControl } from '../../lib/loaders.js';
import bus from '../../lib/stateBus.js';

/**
 * A single input control widget. Sliders use committed-change behavior
 * (smooth drag locally, POST only on release) since changes may trigger
 * expensive operations like simulation re-runs.
 */
function InputWidget({ control, onCommit, disabled }) {
  const { name, display_name, type, current_value, min, max, step, unit, options, read_only } = control;
  const isDisabled = disabled || read_only;

  // Local state for smooth slider dragging without server round-trips.
  const [localValue, setLocalValue] = useState(current_value);

  // Sync local value when the server-side value changes.
  useEffect(() => { setLocalValue(current_value); }, [current_value]);

  switch (type) {
    case 'slider':
      return (
        <Box sx={{ px: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="caption" color="text.primary">{display_name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {localValue}{unit ? ` ${unit}` : ''}
            </Typography>
          </Box>
          <Slider
            size="small"
            value={localValue ?? min ?? 0}
            min={min ?? 0}
            max={max ?? 100}
            step={step ?? 1}
            disabled={isDisabled}
            onChange={(_, val) => setLocalValue(val)}
            onChangeCommitted={(_, val) => onCommit(name, val)}
            sx={{ py: 0.5 }}
          />
        </Box>
      );

    case 'dropdown':
      return (
        <Box sx={{ px: 1 }}>
          <Typography variant="caption" sx={{ color: '#ccc', mb: 0.5, display: 'block' }}>{display_name}</Typography>
          <Select
            size="small"
            fullWidth
            value={current_value ?? ''}
            disabled={isDisabled}
            onChange={(e) => onCommit(name, e.target.value)}
            sx={{ fontSize: 13 }}
          >
            {(options || []).map((opt) => (
              // An extension can mark an option `disabled` when the current
              // state makes it meaningless (e.g. a fuel no selected sector
              // carries) — greyed out rather than hidden, so the full
              // vocabulary stays visible and the list doesn't jump around.
              <MenuItem key={opt.value} value={opt.value} disabled={!!opt.disabled}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </Box>
      );

    case 'multi_select': {
      // Server stores the selection as a list. We hand the same shape back
      // through onCommit and render check-marked menu items + a rendered
      // string summary in the closed Select. Empty list → "(none)".
      const arr = Array.isArray(current_value) ? current_value : [];
      const labelFor = (v) => (options || []).find((o) => o.value === v)?.label ?? v;
      // "All" selects every SELECTABLE option — skipping ones the extension
      // disabled (no data behind them) keeps the click from re-introducing an
      // empty combination the greying just ruled out.
      const selectable = (options || []).filter((o) => !o.disabled).map((o) => o.value);
      const allSelected = selectable.length > 0 && selectable.every((v) => arr.includes(v));
      return (
        <Box sx={{ px: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" sx={{ color: '#ccc' }}>{display_name}</Typography>
            <Box sx={{ display: 'flex', gap: 0.75 }}>
              <Link
                component="button" type="button" variant="caption" underline="hover"
                disabled={isDisabled || allSelected}
                onClick={() => onCommit(name, selectable)}
                sx={{ color: isDisabled || allSelected ? 'text.disabled' : 'primary.light',
                      cursor: isDisabled || allSelected ? 'default' : 'pointer' }}
              >
                All
              </Link>
              <Typography variant="caption" sx={{ color: 'text.disabled' }}>/</Typography>
              <Link
                component="button" type="button" variant="caption" underline="hover"
                disabled={isDisabled || arr.length === 0}
                onClick={() => onCommit(name, [])}
                sx={{ color: isDisabled || arr.length === 0 ? 'text.disabled' : 'primary.light',
                      cursor: isDisabled || arr.length === 0 ? 'default' : 'pointer' }}
              >
                None
              </Link>
            </Box>
          </Box>
          <Select
            size="small"
            fullWidth
            multiple
            value={arr}
            disabled={isDisabled}
            onChange={(e) => {
              // MUI emits either an array or a comma-joined string.
              const v = e.target.value;
              onCommit(name, Array.isArray(v) ? v : String(v).split(','));
            }}
            renderValue={(sel) => (sel.length ? sel.map(labelFor).join(', ') : '(none)')}
            sx={{ fontSize: 13 }}
          >
            {(options || []).map((opt) => (
              // Same extension-driven `disabled` contract as the single-select
              // dropdown: an option with no data behind it greys out. A value
              // that is currently selected is never disabled by the extension,
              // so a checked box can always be unchecked.
              <MenuItem key={opt.value} value={opt.value} disabled={!!opt.disabled}>
                <Checkbox size="small" checked={arr.includes(opt.value)} />
                <ListItemText primary={opt.label} primaryTypographyProps={{ fontSize: 13 }} />
              </MenuItem>
            ))}
          </Select>
        </Box>
      );
    }

    case 'number':
      return (
        <Box sx={{ px: 1 }}>
          <TextField
            label={display_name}
            size="small"
            fullWidth
            type="number"
            value={current_value ?? ''}
            disabled={isDisabled}
            inputProps={{ min, max, step }}
            onChange={(e) => onCommit(name, parseFloat(e.target.value))}
            InputProps={{
              endAdornment: unit ? (
                <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>{unit}</Typography>
              ) : null,
            }}
            sx={{ '& .MuiInputBase-input': { fontSize: 13 } }}
          />
        </Box>
      );

    case 'toggle':
      return (
        <Box sx={{ px: 1 }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={!!current_value}
                disabled={isDisabled}
                onChange={(e) => onCommit(name, e.target.checked)}
              />
            }
            label={<Typography variant="caption" color="text.primary">{display_name}</Typography>}
          />
        </Box>
      );

    default:
      return (
        <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
          Unknown control type: {type}
        </Typography>
      );
  }
}

/**
 * InputControlPanel — renders project/scenario-level controls declared by extensions.
 *
 * Unlike entity-level DataControlPanel, these controls appear in the sidebar
 * without requiring a map click. Extensions declare them via get_input_controls().
 *
 * `embedded` drops the Paper wrapper + primary-color "Input Controls"
 * banner so the panel can mount inside a ChartFrame whose chrome already
 * supplies the title.
 */
export default function InputControlPanel({
  scenarioProp, extensions, activeExtName,
  onDatasetsInvalidated, onLayerActions, refreshKey,
  embedded = false,
}) {
  const [controlsByExt, setControlsByExt] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(null);

  const project = scenarioProp?.project || '';
  const scenario = scenarioProp?.scenario || '';

  // Find extensions that declare input_controls capability.
  // If activeExtName is set, show only that extension's controls.
  const inputExts = (extensions || []).filter(
    (ext) => ext.capabilities?.includes('input_controls') &&
             (!activeExtName || ext.name === activeExtName),
  );

  // Fetch controls from all qualifying extensions when project/scenario changes.
  useEffect(() => {
    if (!project || !scenario || inputExts.length === 0) {
      setControlsByExt({});
      return;
    }
    setLoading(true);
    setError(null);

    Promise.all(
      inputExts.map((ext) =>
        fetchInputControls(ext.name, project, scenario)
          .then((controls) => ({ extName: ext.name, displayName: ext.display_name, controls }))
          .catch((e) => {
            console.warn(`[InputControlPanel] fetchInputControls error for ${ext.name}:`, e);
            return { extName: ext.name, displayName: ext.display_name, controls: [] };
          }),
      ),
    )
      .then((results) => {
        const map = {};
        for (const { extName, displayName, controls } of results) {
          if (controls.length > 0) {
            map[extName] = { displayName, controls };
          }
        }
        setControlsByExt(map);
      })
      .finally(() => setLoading(false));
  }, [project, scenario, inputExts.map((e) => e.name).join(','), refreshKey]);

  const handleCommit = useCallback(
    async (extName, controlName, value) => {
      setUpdating(`${extName}:${controlName}`);
      try {
        const result = await setInputControl(extName, project, scenario, controlName, value);
        console.warn('[InputControlPanel] control update result:', JSON.stringify(result));
        if (result.success !== false) {
          // Update local control state with confirmed value.
          setControlsByExt((prev) => {
            const entry = prev[extName];
            if (!entry) return prev;
            return {
              ...prev,
              [extName]: {
                ...entry,
                controls: entry.controls.map((c) =>
                  c.name === controlName ? { ...c, current_value: result.new_value ?? value } : c,
                ),
              },
            };
          });
          // Signal dataset invalidation if the extension reports it.
          console.log('[InputControlPanel] result:', result);
          if (result.invalidated_datasets?.length > 0) {
            console.log('[InputControlPanel] calling onDatasetsInvalidated:', extName, result.invalidated_datasets);
            onDatasetsInvalidated?.(extName, result.invalidated_datasets);
          }
          // Forward layer actions (filter, show, hide, fly_to_bounds) if present.
          if (result.layer_actions?.length > 0) {
            console.log('[InputControlPanel] forwarding layer_actions:', result.layer_actions);
            onLayerActions?.(result.layer_actions);
          }
          // Broadcast the actual VALUE so peers can sync their control widgets.
          // The 'controls' channel only carries a refresh-key; control state
          // lives in a per-backend singleton, so a peer on a DIFFERENT backend
          // (e.g. the desktop sidecar vs the wall) would otherwise re-fetch
          // stale values. A follower applies this to its own backend.
          bus.publish('controls:effects', {
            type: 'control-set',
            extName,
            controlName,
            value: result.new_value ?? value,
            project,
            scenario,
          });
        }
        if (result.message) {
          console.info(`[InputControlPanel] ${extName}/${controlName}: ${result.message}`);
        }
      } catch (e) {
        console.warn(`[InputControlPanel] setInputControl error:`, e);
        setError(e.message);
      } finally {
        setUpdating(null);
      }
    },
    [project, scenario, onDatasetsInvalidated, onLayerActions],
  );

  const extNames = Object.keys(controlsByExt);

  const Wrapper = embedded ? Box : Paper;
  const wrapperProps = embedded
    ? { sx: { width: '100%', height: '100%', overflow: 'auto' } }
    : { elevation: 1, sx: { minWidth: 400, borderRadius: 2, overflow: 'hidden' } };

  return (
    <Wrapper {...wrapperProps}>
      {!embedded && (
        <Box sx={{ bgcolor: 'primary.main', px: 1, py: 0.25 }}>
          <Typography
            variant="subtitle1"
            fontWeight={600}
            align="center"
            color="primary.contrastText"
          >
            Input Controls
          </Typography>
        </Box>
      )}

      {/* Only show the spinner on the initial load. A refreshKey bump
          (after a local commit, or a remote-tab commit landing via bus)
          re-runs the fetch effect with `loading=true`, but if we already
          have controls rendered we keep them visible — React reconciles
          the new current_value into the same slider/select widgets in
          place, which reads as a value update instead of a flicker. */}
      {loading && extNames.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      ) : error ? (
        <Alert severity="error" sx={{ fontSize: 12, m: 1 }}>{error}</Alert>
      ) : extNames.length === 0 ? (
        <Box sx={{ p: 2 }}>
          <Typography variant="body2" color="text.secondary">
            {!project || !scenario
              ? 'Select a project and scenario to see input controls.'
              : 'No input controls available for this scenario.'}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {extNames.map((extName) => {
            const { displayName, controls } = controlsByExt[extName];
            const groups = {};
            for (const ctrl of controls) {
              const group = ctrl.group || 'General';
              if (!groups[group]) groups[group] = [];
              groups[group].push(ctrl);
            }
            const groupNames = Object.keys(groups);

            return (
              <Box key={extName}>
                {extNames.length > 1 && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, px: 0.5, mb: 0.5, display: 'block' }}>
                    {displayName}
                  </Typography>
                )}
                {groupNames.map((group) => (
                  <Box key={group} sx={{ mb: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ px: 1, mb: 0.5, display: 'block' }}>
                      {group}
                    </Typography>
                    {groups[group].map((ctrl) => (
                      <InputWidget
                        key={ctrl.name}
                        control={ctrl}
                        onCommit={(name, value) => handleCommit(extName, name, value)}
                        disabled={updating === `${extName}:${ctrl.name}`}
                      />
                    ))}
                  </Box>
                ))}
              </Box>
            );
          })}
        </Box>
      )}
    </Wrapper>
  );
}
