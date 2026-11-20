import { useCallback } from 'react';
import AddIcon from '@mui/icons-material/AddCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { createStory, deleteStory, fetchStories } from '../../lib/loaders.js';
import EntityPicker, { useEntityList } from './EntityPicker.jsx';
import { usePrompt, useConfirm, useAlert } from '../../lib/dialogs.jsx';

/**
 * Compact story dropdown + create/delete affordances.
 *
 * Props:
 *   value         string | null    — active story id
 *   onChange      (id) => void
 *   project_id?   filter by project
 */
export default function StoryPicker({ value, onChange, project_id }) {
  const { items, loading, refresh } = useEntityList(
    () => fetchStories({ project_id }),
    [project_id],
  );
  const prompt = usePrompt();
  const confirm = useConfirm();
  const alert = useAlert();

  const handleCreate = useCallback(async () => {
    const name = await prompt({
      title: 'New story',
      label: 'Story name',
      confirmText: 'Create',
    });
    if (!name) return;
    try {
      const created = await createStory({ name, project_id });
      refresh();
      if (created?.id != null) onChange?.(created.id);
    } catch (e) {
      console.error('[StoryPicker] create failed:', e);
      await alert({ title: 'Create failed', message: e?.message || String(e) });
    }
  }, [prompt, alert, refresh, onChange, project_id]);

  const handleDelete = useCallback(async () => {
    if (value == null || value === '') return;
    const target = items.find((s) => s.id === value);
    const label = target?.name ?? `Story ${value}`;
    const ok = await confirm({
      title: 'Delete story?',
      message: `"${label}" and all its chapters will be removed.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteStory(value);
      onChange?.(null);
      refresh();
    } catch (e) {
      console.error('[StoryPicker] delete failed:', e);
      await alert({ title: 'Delete failed', message: e?.message || String(e) });
    }
  }, [value, items, confirm, alert, onChange, refresh]);

  // Create + delete live inside the dropdown: "New story…" replaces the "None"
  // row at the top, delete sits at the bottom (only when a story is selected).
  const actions = [
    {
      id: '__create_story__',
      label: 'New story…',
      icon: <AddIcon fontSize="small" />,
      onClick: handleCreate,
      placement: 'top',
    },
    ...(value
      ? [{
          id: '__delete_story__',
          label: 'Delete story…',
          icon: <DeleteOutlineIcon fontSize="small" />,
          onClick: handleDelete,
          placement: 'bottom',
          color: 'error.main',
        }]
      : []),
  ];

  return (
    <EntityPicker
      label="Story"
      value={value}
      onChange={onChange}
      items={items}
      loading={loading}
      showNone={false}
      actions={actions}
      itemLabel={(s) => s.name ?? `Story ${s.id}`}
    />
  );
}
