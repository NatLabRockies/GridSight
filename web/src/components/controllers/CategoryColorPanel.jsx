import { useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Slider from '@mui/material/Slider';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteIcon from '@mui/icons-material/Delete';
import CloseIcon from '@mui/icons-material/Close';
import PsychologyIcon from '@mui/icons-material/Psychology';

import { useCategoryColors, hexToRgb, rgbToHex } from '../../lib/categoryColors.jsx';

// ── Palette persistence (localStorage) ───────────────────────────────────────

const PALETTES_KEY = 'meridian_category_palettes';

function readPalettes() {
  try { return JSON.parse(localStorage.getItem(PALETTES_KEY) ?? '{}'); } catch { return {}; }
}
function writePalette(name, colors) {
  const existing = readPalettes();
  localStorage.setItem(PALETTES_KEY, JSON.stringify({ ...existing, [name]: colors }));
}
function deletePaletteByName(name) {
  const existing = readPalettes();
  const { [name]: _, ...rest } = existing;
  localStorage.setItem(PALETTES_KEY, JSON.stringify(rest));
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * CategoryColorPanel — Tray panel for viewing / editing the shared categorical
 * color map.  Only renders when at least one category has been registered
 * (typically by an AI-generated chart).
 */
export default function CategoryColorPanel({ onAskAI, onClose }) {
  const { colorMap, categories, setColors } = useCategoryColors();
  const [palettes, setPalettes] = useState(readPalettes);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);

  if (categories.length === 0) return null;

  const paletteNames = Object.keys(palettes);

  function handleLoadPalette(name) {
    const palette = palettes[name] ?? {};
    const merged = { ...colorMap };
    Object.keys(merged).forEach(k => { if (palette[k]) merged[k] = palette[k]; });
    setColors(merged);
  }

  function handleSavePalette() {
    if (!saveName.trim()) return;
    writePalette(saveName.trim(), colorMap);
    setPalettes(readPalettes());
    setSaveName('');
    setShowSave(false);
  }

  function handleDeletePalette(name) {
    deletePaletteByName(name);
    setPalettes(readPalettes());
  }

  return (
    <Paper elevation={1} sx={{ minWidth: 400, borderRadius: 2, overflow: 'hidden' }}>
      <Stack direction="row" alignItems="center" bgcolor="primary.main" sx={{ px: 1, py: 0.25 }}>
        <Typography
          variant="subtitle1"
          fontWeight={600}
          color="primary.contrastText"
          sx={{ flex: 1 }}
        >
          Category Colors
        </Typography>
        {onAskAI && categories.length > 0 && (
          <Tooltip title="Ask AI to suggest a palette">
            <IconButton
              size="small"
              sx={{ color: "primary.contrastText" }}
              onClick={() => {
                const catList = categories.map(c => `  - "${c}"`).join("\n");
                const prompt = [
                  "Generate a visually appealing color palette for these categories using the set_category_colors tool.",
                  "Group related categories with similar hues but keep them distinguishable.",
                  "Use the EXACT category names as keys (including any special characters).",
                  "Give the palette a descriptive name.\n",
                  `There are ${categories.length} categories:\n${catList}`,
                ].join("\n");
                onAskAI(prompt);
              }}
            >
              <PsychologyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {onClose && (
          <IconButton size="small" sx={{ color: "primary.contrastText" }} onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        )}
      </Stack>

      <Box sx={{ p: 1.5 }}>
        {/* Palette controls */}
        <Stack direction="row" spacing={1} sx={{ mb: 1 }} alignItems="center" flexWrap="wrap">
          {paletteNames.length > 0 && (
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>Load Palette</InputLabel>
              <Select value="" label="Load Palette" onChange={e => handleLoadPalette(e.target.value)}>
                {paletteNames.map(n => (
                  <MenuItem key={n} value={n}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ width: '100%' }}>
                      <span>{n}</span>
                      <IconButton size="small" onMouseDown={e => { e.stopPropagation(); handleDeletePalette(n); }}>
                        <DeleteIcon fontSize="inherit" />
                      </IconButton>
                    </Stack>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Button size="small" variant="text" onClick={() => setShowSave(s => !s)}>
            {showSave ? 'Cancel' : 'Save Palette'}
          </Button>
        </Stack>

        {showSave && (
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            <TextField size="small" label="Palette name" value={saveName}
              onChange={e => setSaveName(e.target.value)} sx={{ flex: 1 }} />
            <Button size="small" variant="contained" disabled={!saveName.trim()} onClick={handleSavePalette}>
              Save
            </Button>
          </Stack>
        )}

        {/* Value → color rows */}
        <Stack spacing={0.75}>
          {categories.map(v => {
            const [r, g, b, a] = colorMap[v] ?? [100, 149, 237, 220];
            return (
              <Stack key={v} direction="row" spacing={1} alignItems="center">
                <input type="color" value={rgbToHex(r, g, b)}
                  onChange={e => {
                    const [nr, ng, nb] = hexToRgb(e.target.value);
                    setColors({ [v]: [nr, ng, nb, a] });
                  }}
                  style={{ width: 28, height: 28, border: 'none', padding: 0, cursor: 'pointer', borderRadius: 4 }} />
                <Typography variant="caption" sx={{ flex: 1 }}>{v}</Typography>
                <Slider size="small" value={a} min={0} max={255} step={1}
                  onChange={(_, newA) => setColors({ [v]: [r, g, b, newA] })}
                  sx={{ width: 60 }} />
              </Stack>
            );
          })}
        </Stack>
      </Box>
    </Paper>
  );
}
