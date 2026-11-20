import { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Slider from '@mui/material/Slider';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';

function ControlWidget({ control, onChange, disabled }) {
  const { name, display_name, type, current_value, min, max, step, unit, options, read_only } = control;
  const isDisabled = disabled || read_only;

  switch (type) {
    case 'slider':
      return (
        <Box sx={{ px: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ color: '#ccc' }}>{display_name}</Typography>
            <Typography variant="caption" sx={{ color: '#aaa' }}>
              {current_value}{unit ? ` ${unit}` : ''}
            </Typography>
          </Box>
          <Slider
            size="small"
            value={current_value ?? min ?? 0}
            min={min ?? 0}
            max={max ?? 100}
            step={step ?? 1}
            disabled={isDisabled}
            onChange={(_, val) => onChange(name, val)}
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
            onChange={(e) => onChange(name, e.target.value)}
            sx={{ fontSize: 13 }}
          >
            {(options || []).map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>{opt.label}</MenuItem>
            ))}
          </Select>
        </Box>
      );

    case 'text':
      return (
        <Box sx={{ px: 1 }}>
          <TextField
            label={display_name}
            size="small"
            fullWidth
            value={current_value ?? ''}
            disabled={isDisabled}
            onChange={(e) => onChange(name, e.target.value)}
            sx={{ '& .MuiInputBase-input': { fontSize: 13 } }}
          />
        </Box>
      );

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
            onChange={(e) => onChange(name, parseFloat(e.target.value))}
            InputProps={{
              endAdornment: unit ? (
                <Typography variant="caption" sx={{ color: '#888', ml: 0.5 }}>{unit}</Typography>
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
                onChange={(e) => onChange(name, e.target.checked)}
              />
            }
            label={<Typography variant="caption" sx={{ color: '#ccc' }}>{display_name}</Typography>}
          />
        </Box>
      );

    default:
      return (
        <Typography variant="caption" sx={{ color: '#888', px: 1 }}>
          Unknown control type: {type}
        </Typography>
      );
  }
}

/**
 * DataControlPanel — renders interactive controls for an entity from an extension.
 *
 * @param {object[]} controls - array of DataControl objects from the API
 * @param {boolean} loading - whether controls are being fetched
 * @param {function} onControlChange - (controlName, newValue) => void
 * @param {string|null} error - error message to display
 */
export default function DataControlPanel({ controls, loading, onControlChange, error }) {
  const [updating, setUpdating] = useState(null);

  const handleChange = useCallback((name, value) => {
    setUpdating(name);
    Promise.resolve(onControlChange(name, value))
      .finally(() => setUpdating(null));
  }, [onControlChange]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error" sx={{ fontSize: 12 }}>{error}</Alert>;
  }

  if (!controls?.length) {
    return (
      <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
        No controls available
      </Typography>
    );
  }

  // Group controls by group field
  const groups = {};
  for (const ctrl of controls) {
    const group = ctrl.group || 'General';
    if (!groups[group]) groups[group] = [];
    groups[group].push(ctrl);
  }

  const groupNames = Object.keys(groups);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {groupNames.map((group) => (
        <Box key={group}>
          {groupNames.length > 1 && (
            <Typography variant="caption" sx={{ color: '#aaa', fontWeight: 600, px: 1, mb: 0.5, display: 'block' }}>
              {group}
            </Typography>
          )}
          {groups[group].map((ctrl) => (
            <ControlWidget
              key={ctrl.name}
              control={ctrl}
              onChange={handleChange}
              disabled={updating === ctrl.name}
            />
          ))}
        </Box>
      ))}
    </Box>
  );
}
