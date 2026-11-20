/**
 * EntityPicker — shared dropdown chrome for the project's CRUD pickers
 * (StoryPicker, PerspectivePicker, …). Wraps a single MUI Select with
 * the project's standard layout and accepts action buttons as children.
 *
 * Async list loading is handled by the `useEntityList` hook in the same
 * file: pass a fetcher and a deps array, get back `{ items, loading,
 * refresh }`. Action handlers call `refresh()` after a successful create/
 * delete so the dropdown reflects the latest state.
 */

import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import ListItemIcon from '@mui/material/ListItemIcon';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';

/**
 * Async list loader with a refresh tick. The fetcher runs on mount and
 * whenever any value in `deps` changes; calling `refresh()` increments
 * an internal tick that re-runs the fetcher (used after CRUD mutations).
 *
 * @param {() => Promise<any[]>} fetcher
 * @param {any[]} deps - re-fetch when these change
 * @returns {{ items: any[], loading: boolean, refresh: () => void }}
 */
export function useEntityList(fetcher, deps = []) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetcher()
      .then((list) => {
        if (!cancelled) setItems(Array.isArray(list) ? list : []);
      })
      .catch((e) => console.error('[useEntityList] fetch error:', e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { items, loading, refresh };
}

export default function EntityPicker({
  label,
  value,
  onChange,
  items,
  loading,
  itemLabel = (item) => item.name,
  loadingLabel = 'Loading…',
  emptyLabel = 'None saved',
  noneLabel = 'None',
  showNone = true,          // set false to drop the "None" row (e.g. a top action replaces it)
  actions = [],             // in-menu action items: { id, label, icon, onClick, placement: 'top'|'bottom', color, divider }
  children,
}) {
  // Action items live inside the menu as MenuItems carrying a sentinel value
  // (their id). We intercept those in onChange and run the handler instead of
  // treating it as a selection, so the picked story/perspective is untouched.
  const actionById = Object.fromEntries(actions.map((a) => [a.id, a]));
  const topActions = actions.filter((a) => (a.placement ?? 'top') === 'top');
  const bottomActions = actions.filter((a) => a.placement === 'bottom');

  const handleChange = (e) => {
    const v = e.target.value;
    const action = actionById[v];
    if (action) { action.onClick?.(); return; }  // an action, not a selection
    onChange?.(v || null);
  };

  const renderAction = (a) => (
    <MenuItem key={a.id} value={a.id} disabled={a.disabled} divider={a.divider} sx={a.color ? { color: a.color } : undefined}>
      {a.icon && (
        <ListItemIcon sx={{ minWidth: 28, color: 'inherit' }}>{a.icon}</ListItemIcon>
      )}
      <Typography variant="body2" sx={{ color: 'inherit' }}>{a.label}</Typography>
    </MenuItem>
  );

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
      <FormControl size="small" sx={{ flex: 1 }}>
        <InputLabel>{label}</InputLabel>
        <Select
          value={value ?? ''}
          label={label}
          onChange={handleChange}
          disabled={loading}
        >
          {topActions.map(renderAction)}
          {showNone ? (
            <MenuItem value="">
              <Typography variant="body2" color="text.secondary">
                {loading ? loadingLabel : items.length === 0 ? emptyLabel : noneLabel}
              </Typography>
            </MenuItem>
          ) : (
            // Hidden empty target so a null selection still matches a MenuItem
            // (avoids MUI's out-of-range-value warning) without showing "None".
            <MenuItem value="" sx={{ display: 'none' }} />
          )}
          {items.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              <Typography variant="body2" noWrap>{itemLabel(item)}</Typography>
            </MenuItem>
          ))}
          {bottomActions.length > 0 && <Divider />}
          {bottomActions.map(renderAction)}
        </Select>
      </FormControl>
      {children}
    </Box>
  );
}
