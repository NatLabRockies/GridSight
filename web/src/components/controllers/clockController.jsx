import React, { useState, useEffect, useMemo } from 'react';
import Paper from '@mui/material/Paper';
import dayjs from 'dayjs';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import Box from '@mui/material/Box';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SpeedIcon from '@mui/icons-material/Speed';
import Divider from '@mui/material/Divider';
import Switch from '@mui/material/Switch';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a timestamp string for display, stripping fractional seconds. */
function fmtTimestamp(ts) {
  if (!ts) return '—';
  return ts.split('.')[0].replace('T', ' ');
}

/**
 * Map a speed slider value (1–10) to a tick interval in ms.
 * 1 = slowest (2000 ms), 10 = fastest (50 ms).  Logarithmic curve.
 */
function speedToFrequency(speed) {
  // log curve: freq = 2000 * (50/2000)^((speed-1)/9) ≈ 2000 → 50
  return Math.round(2000 * Math.pow(50 / 2000, (speed - 1) / 9));
}

/** Inverse: frequency → speed slider value. */
function frequencyToSpeed(freq) {
  const clamped = Math.max(50, Math.min(2000, freq));
  return 1 + 9 * Math.log(2000 / clamped) / Math.log(2000 / 50);
}

// Speed tick marks
const SPEED_MARKS = [
  { value: 1,  label: 'Slow' },
  { value: 10, label: 'Fast' },
];

// ---------------------------------------------------------------------------
// ClockController
// ---------------------------------------------------------------------------

export default function ClockController({
  props, onChange, clockColor, onClockColorChange, currentTimeLabel,
  // When true, drop the Paper wrapper and the primary-color "Animation"
  // banner. The caller (e.g. a panel host) supplies its own chrome and
  // a second header looks noisy.
  embedded = false,
}) {
  const ts = props.timestamps ?? [];

  // Local index for smooth slider dragging (synced from props).
  const [localIndex, setLocalIndex] = useState(props.index);
  useEffect(() => { setLocalIndex(props.index); }, [props.index]);

  // Date pickers — sync from props, allow user edits to narrow the window.
  const [windowStart, setWindowStart] = useState(dayjs(props.startDate));
  const [windowEnd, setWindowEnd]     = useState(dayjs(props.endDate));
  useEffect(() => { setWindowStart(dayjs(props.startDate)); }, [props.startDate]);
  useEffect(() => { setWindowEnd(dayjs(props.endDate)); }, [props.endDate]);

  // Speed slider (1–10, logarithmic mapping to frequency ms)
  const speed = frequencyToSpeed(props.frequency);

  // Derive current timestamp label — prefer the buffer-derived label from App.
  const currentLabel = currentTimeLabel || fmtTimestamp(ts[localIndex]);

  // Playback slider value-label formatter: show the timestamp instead of the index.
  const valueLabelFormat = useMemo(() => {
    return (val) => fmtTimestamp(ts[val]) || String(val);
  }, [ts]);

  // --- Date range → index mapping ---
  function handleWindowStartChange(newVal) {
    if (!newVal) return;
    setWindowStart(newVal);
    const iso = newVal.format('YYYY-MM-DDTHH:mm');
    // Find the first timestamp >= iso
    let idx = 0;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] >= iso) { idx = i; break; }
    }
    onChange({ ...props, start_index: idx, startDate: ts[idx] ?? iso });
  }

  function handleWindowEndChange(newVal) {
    if (!newVal) return;
    setWindowEnd(newVal);
    const iso = newVal.format('YYYY-MM-DDTHH:mm');
    // Find the last timestamp <= iso
    let idx = ts.length - 1;
    for (let i = ts.length - 1; i >= 0; i--) {
      if (ts[i] <= iso) { idx = i; break; }
    }
    onChange({ ...props, end_index: idx, endDate: ts[idx] ?? iso });
  }

  // --- Slider handlers ---
  function handleSliderChange(_, newValue) {
    setLocalIndex(newValue[1]);
  }

  function handleSliderCommit(_, newValue) {
    onChange({
      ...props,
      start_index: newValue[0],
      index: newValue[1],
      end_index: newValue[2],
    });
  }

  function handleSpeedChange(_, newSpeed) {
    onChange({ ...props, frequency: speedToFrequency(newSpeed) });
  }

  // Reset the start/end window to the full data range. The start/end indices
  // are shared clock state that filters every timeseries chart (existing and
  // newly opened), so a narrowed window "sticks" and silently constrains new
  // charts — this gives a one-click way to clear it back to the full range.
  const loIndex = props.min_index ?? 0;
  const hiIndex = props.max_index ?? (ts.length ? ts.length - 1 : 0);
  const rangeNarrowed = props.start_index > loIndex || props.end_index < hiIndex;
  function resetRange() {
    onChange({
      ...props,
      start_index: loIndex,
      end_index: hiIndex,
      index: Math.min(Math.max(props.index, loIndex), hiIndex),
      startDate: ts[loIndex] ?? props.startDate,
      endDate: ts[hiIndex] ?? props.endDate,
    });
  }

  // --- Playback controls ---
  function stepBack()  { onChange({ ...props, index: Math.max(props.start_index, props.index - 1) }); }
  function stepFwd()   { onChange({ ...props, index: Math.min(props.end_index,   props.index + 1) }); }
  function togglePlay() { onChange({ ...props, animate: !props.animate }); }

  const Wrapper = embedded ? Box : Paper;
  const wrapperProps = embedded
    ? { sx: { width: '100%', height: '100%', overflow: 'auto' } }
    : { elevation: 2, sx: { minWidth: 560, borderRadius: 2, overflow: 'hidden' } };

  return (
    <Wrapper {...wrapperProps}>
      {!embedded && (
        <Box
          sx={{
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            py: 0.75,
            px: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Typography variant="subtitle1" fontWeight={600}>Animation</Typography>
          <Chip
            label={currentLabel}
            size="small"
            sx={{
              bgcolor: 'rgba(255,255,255,0.15)',
              color: 'primary.contrastText',
              fontFamily: 'monospace',
              fontWeight: 600,
              fontSize: 13,
            }}
          />
        </Box>
      )}

      <Stack spacing={2} sx={{ px: 2.5, py: 2 }}>

        {/* ── Date window pickers ─────────────────────────────────── */}
        <LocalizationProvider dateAdapter={AdapterDayjs}>
          <Stack direction="row" spacing={2}>
            <DateTimePicker
              label="Window start"
              value={windowStart}
              minDateTime={dayjs(ts[props.min_index] ?? props.startDate)}
              maxDateTime={windowEnd}
              onChange={handleWindowStartChange}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            <DateTimePicker
              label="Window end"
              value={windowEnd}
              minDateTime={windowStart}
              maxDateTime={dayjs(ts[props.max_index] ?? props.endDate)}
              onChange={handleWindowEndChange}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
          </Stack>
        </LocalizationProvider>

        {/* ── Timeline slider ────────────────────────────────────── */}
        <Box sx={{ px: 1 }}>
          <Slider
            value={[props.start_index, localIndex, props.end_index]}
            onChange={handleSliderChange}
            onChangeCommitted={handleSliderCommit}
            valueLabelDisplay="auto"
            valueLabelFormat={valueLabelFormat}
            disableSwap
            min={props.min_index}
            max={props.max_index}
            step={1}
            sx={{
              '& .MuiSlider-thumb': {
                '&:nth-of-type(4)': {  /* middle thumb — the playhead */
                  width: 16,
                  height: 16,
                },
              },
              '& .MuiSlider-valueLabel': {
                fontSize: 11,
                fontFamily: 'monospace',
                whiteSpace: 'nowrap',
              },
            }}
          />
        </Box>

        {/* Reset the shared start/end window to the full range. Shown only
            when narrowed so it doesn't add noise at full range. */}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1, mt: -0.5, mb: 0.5, minHeight: 28 }}>
          {rangeNarrowed && (
            <Tooltip title="Reset the date window to the full range (clears the filter applied to all timeseries charts)">
              <Button
                size="small"
                onClick={resetRange}
                startIcon={<RestartAltIcon sx={{ fontSize: 16 }} />}
                sx={{ fontSize: 11, textTransform: 'none' }}
              >
                Full range
              </Button>
            </Tooltip>
          )}
        </Box>

        <Divider />

        {/* ── Playback controls ──────────────────────────────────── */}
        <Stack direction="row" alignItems="center" justifyContent="center" spacing={1}>
          <Tooltip title="Step back">
            <IconButton onClick={stepBack} size="small" disabled={props.animate}>
              <SkipPreviousIcon />
            </IconButton>
          </Tooltip>

          <IconButton
            onClick={togglePlay}
            sx={{
              bgcolor: props.animate ? 'error.main' : 'primary.main',
              color: '#fff',
              '&:hover': {
                bgcolor: props.animate ? 'error.dark' : 'primary.dark',
              },
              width: 44,
              height: 44,
            }}
          >
            {props.animate ? <PauseIcon /> : <PlayArrowIcon />}
          </IconButton>

          <Tooltip title="Step forward">
            <IconButton onClick={stepFwd} size="small" disabled={props.animate}>
              <SkipNextIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        <Divider />

        {/* ── Speed slider ───────────────────────────────────────── */}
        <Stack direction="row" spacing={2} alignItems="center" sx={{ px: 1 }}>
          <SpeedIcon color="action" fontSize="small" />
          <Slider
            value={speed}
            onChange={handleSpeedChange}
            min={1}
            max={10}
            step={0.1}
            marks={SPEED_MARKS}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) => `${speedToFrequency(v)} ms`}
            sx={{ flex: 1 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 50, textAlign: 'right' }}>
            {props.frequency} ms
          </Typography>
        </Stack>

        <Divider />

        {/* ── Show clock toggle + color ─────────────────────────── */}
        <Stack direction="row" alignItems="center" spacing={1}>
          <Switch
            size="small"
            checked={props.showClock}
            onChange={(e) => onChange({ ...props, showClock: e.target.checked })}
          />
          <Typography variant="body2">Show overlay clock</Typography>
          {props.showClock && (
            <input
              type="color"
              value={clockColor ?? '#f0f0f0'}
              onChange={(e) => onClockColorChange?.(e.target.value)}
              title="Clock text color"
              style={{ width: 28, height: 28, border: 'none', padding: 0, cursor: 'pointer', background: 'transparent' }}
            />
          )}
        </Stack>

      </Stack>
    </Wrapper>
  );
}
