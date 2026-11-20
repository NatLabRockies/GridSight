import { useCallback } from 'react';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/AddCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import {
  createPerspective,
  deletePerspective,
  fetchPerspectives,
  updatePerspective,
} from '../../lib/loaders.js';
import EntityPicker, { useEntityList } from './EntityPicker.jsx';
import { usePrompt, useConfirm, useAlert } from '../../lib/dialogs.jsx';

/**
 * Compact perspective dropdown + save/update/delete affordances.
 *
 * Props:
 *   value          string | null   — active perspective id
 *   onChange       (id) => void
 *   onCapture      () => blob | null  — returns the live view-state blob
 *                                       to save when the user clicks "+".
 *                                       If omitted, save creates an empty
 *                                       perspective row.
 *   project_id?    optional filter
 *   scenario_id?   optional filter
 */
export default function PerspectivePicker({
  value, onChange, onCapture, project_id, scenario_id,
}) {
  const { items, loading, refresh } = useEntityList(
    () => fetchPerspectives({ project_id, scenario_id }),
    [project_id, scenario_id],
  );
  const prompt = usePrompt();
  const confirm = useConfirm();
  const alert = useAlert();

  const handleSave = useCallback(async () => {
    const name = await prompt({
      title: 'Save view as perspective',
      label: 'Perspective name',
      confirmText: 'Save',
    });
    if (!name) return;
    try {
      const blob = onCapture ? await onCapture() : null;
      const created = await createPerspective({
        name,
        project_id,
        scenario_id,
        config: blob || {},
      });
      const newId = created?.id;
      if (blob && newId != null) {
        // The create endpoint accepts config directly, but PATCH it again
        // for safety (some servers may ignore the field on create).
        await updatePerspective(newId, { config: blob });
      }
      refresh();
      if (newId != null) onChange?.(newId);
    } catch (e) {
      console.error('[PerspectivePicker] save failed:', e);
      await alert({ title: 'Save failed', message: e?.message || String(e) });
    }
  }, [onCapture, onChange, project_id, scenario_id, refresh, prompt, alert]);

  const handleUpdate = useCallback(async () => {
    if (value == null || value === '') return;
    const target = items.find((p) => p.id === value);
    const label = target?.name ?? `Perspective ${value}`;
    const ok = await confirm({
      title: `Overwrite "${label}"?`,
      message: 'The current view will replace the saved one.',
      confirmText: 'Overwrite',
    });
    if (!ok) return;
    try {
      const blob = onCapture ? await onCapture() : null;
      if (!blob) {
        await alert({ title: 'Capture failed', message: 'No view-state to capture.' });
        return;
      }
      await updatePerspective(value, { config: blob });
      refresh();
    } catch (e) {
      console.error('[PerspectivePicker] update failed:', e);
      await alert({ title: 'Update failed', message: e?.message || String(e) });
    }
  }, [value, items, onCapture, refresh, confirm, alert]);

  const handleDelete = useCallback(async () => {
    if (value == null || value === '') return;
    const target = items.find((p) => p.id === value);
    const label = target?.name ?? `Perspective ${value}`;
    const ok = await confirm({
      title: 'Delete perspective?',
      message: `"${label}" will be permanently removed.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deletePerspective(value);
      onChange?.(null);
      refresh();
    } catch (e) {
      console.error('[PerspectivePicker] delete failed:', e);
      await alert({ title: 'Delete failed', message: e?.message || String(e) });
    }
  }, [value, items, onChange, refresh, confirm, alert]);

  return (
    <EntityPicker
      label="Perspective"
      value={value}
      onChange={onChange}
      items={items}
      loading={loading}
      itemLabel={(p) => p.name ?? `Perspective ${p.id}`}
    >
      <Tooltip title="Save current view as a new perspective">
        <IconButton size="small" onClick={handleSave}>
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {value && (
        <Tooltip title="Overwrite the selected perspective with the current view">
          <IconButton size="small" onClick={handleUpdate}>
            <SaveOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {value && (
        <Tooltip title="Delete the selected perspective">
          <IconButton size="small" onClick={handleDelete}>
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </EntityPicker>
  );
}
