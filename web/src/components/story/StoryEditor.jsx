/**
 * StoryEditor — chapter-first authoring panel for a story.
 *
 * Two tabs:
 *   • Chapters — the running order. Click a chapter to apply it; drag the
 *     handle to reorder; the only inline control is "overwrite with current
 *     view" (Save). Titles wrap so long chapter names stay readable.
 *   • Settings — everything destructive or occasional: the AI guiding prompt,
 *     the story description, and per-chapter edit-description / edit-prompts /
 *     delete. Deleting a chapter lives here on purpose, behind the tab.
 *
 * Each chapter is a (story_step → perspective) pair. The underlying
 * perspective is shared if the same one is referenced from multiple
 * chapters; "overwrite" updates the perspective itself, so all chapters
 * pointing at it see the change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import AddIcon from '@mui/icons-material/AddCircleOutline';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import NotesIcon from '@mui/icons-material/Notes';
import PsychologyIcon from '@mui/icons-material/Psychology';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import IosShareIcon from '@mui/icons-material/IosShare';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import Button from '@mui/material/Button';
import {
  fetchStorySteps,
  addStoryStep,
  updateStoryStep,
  deleteStoryStep,
  reorderStorySteps,
  fetchStory,
  updateStory,
  exportStory,
  importStory,
} from '../../lib/loaders.js';
import {
  createPerspective,
  updatePerspective,
} from '../../lib/loaders.js';
import { usePrompt, useConfirm, useAlert } from '../../lib/dialogs.jsx';

export default function StoryEditor({
  storyId,
  activePerspectiveId,
  onApplyChapter,           // (perspectiveId) => void — apply a chapter
  onCapture,                // () => blob — capture live view-state
  projectId,                // optional: project_id for new perspectives
  scenarioId,               // optional: scenario_id for new perspectives
}) {
  const [steps, setSteps] = useState([]);
  const [story, setStory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [tab, setTab] = useState('chapters');
  // Drag-to-reorder state: which row is being dragged, which row it's over.
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const prompt = usePrompt();
  const confirm = useConfirm();
  const alert = useAlert();
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  // Export → download a self-contained bundle. Done client-side from the
  // parsed JSON (rather than pointing the browser at the URL) because the API
  // requires the auth cookie and we want a friendly filename.
  const handleExport = useCallback(async () => {
    if (!storyId) return;
    setBusy(true);
    try {
      const bundle = await exportStory(storyId);
      const safe = (bundle?.story?.name || 'story').replace(/[^\w.-]+/g, '-');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safe}.meridian-story.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [storyId, alert]);

  const handleImportClick = useCallback(() => fileInputRef.current?.click(), []);

  const handleImportFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';           // let the same file be picked again
    if (!file) return;
    setBusy(true);
    try {
      const bundle = JSON.parse(await file.text());
      const result = await importStory(bundle, { project_id: projectId ?? null });
      // Import can only wire up what this instance actually has — a missing
      // extension or dataset comes back as a warning rather than a failure, so
      // surface it instead of letting the story look silently broken.
      const warn = result?.warnings?.length
        ? `\n\nImported with warnings:\n- ${result.warnings.join('\n- ')}`
        : '';
      alert(`Imported "${result.name}" (${result.steps} chapters).${warn}`);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [projectId, alert]);

  useEffect(() => {
    if (!storyId) { setSteps([]); return; }
    let cancelled = false;
    setLoading(true);
    fetchStorySteps(storyId)
      .then((list) => { if (!cancelled) setSteps(Array.isArray(list) ? list : []); })
      .catch((e) => console.warn('[StoryEditor] fetchStorySteps:', e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [storyId, refreshTick]);

  // Story-level metadata (description + AI guiding prompt) is fetched
  // separately from the steps so the "Guide the assistant" editor can show and
  // save it. These feed the assistant's context when this story is active.
  useEffect(() => {
    if (!storyId) { setStory(null); return; }
    let cancelled = false;
    fetchStory(storyId)
      .then((s) => { if (!cancelled) setStory(s || null); })
      .catch((e) => console.warn('[StoryEditor] fetchStory:', e));
    return () => { cancelled = true; };
  }, [storyId, refreshTick]);

  const handleEditGuide = useCallback(async () => {
    const text = await prompt({
      title: 'Guide the assistant',
      message:
        'A brief the AI assistant reads whenever this story is the active ' +
        'context — audience, the narrative arc, domain background, and what a ' +
        'good answer looks like. Loaded alongside each chapter’s description.',
      label: 'Guiding prompt',
      defaultValue: story?.guiding_prompt ?? '',
      multiline: true,
      maxWidth: 'md',
      minRows: 14,
      maxRows: 28,
      confirmText: 'Save',
    });
    if (text == null) return;  // cancelled
    try {
      await updateStory(storyId, { guiding_prompt: text });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      console.error('[StoryEditor] save guiding prompt failed:', e);
      await alert({ title: 'Save failed', message: e?.message || String(e) });
    }
  }, [storyId, story, prompt, alert]);

  const handleEditStoryDescription = useCallback(async () => {
    const text = await prompt({
      title: 'Story description',
      message: 'A short summary of what this story shows. Also given to the assistant.',
      label: 'Description',
      defaultValue: story?.description ?? '',
      multiline: true,
      rows: 3,
      confirmText: 'Save',
    });
    if (text == null) return;
    try {
      await updateStory(storyId, { description: text });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      console.error('[StoryEditor] save description failed:', e);
      await alert({ title: 'Save failed', message: e?.message || String(e) });
    }
  }, [storyId, story, prompt, alert]);

  const handleEditChapterDescription = useCallback(async (step) => {
    if (!step?.perspective_id) return;
    const text = await prompt({
      title: 'Chapter description',
      message:
        'A one-line description of this chapter — what it shows and why. Given ' +
        'to the assistant as part of the story context.',
      label: 'Description',
      defaultValue: step.perspective?.description ?? '',
      multiline: true,
      rows: 3,
      confirmText: 'Save',
    });
    if (text == null) return;
    try {
      await updatePerspective(step.perspective_id, { description: text });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      console.error('[StoryEditor] save chapter description failed:', e);
      await alert({ title: 'Save failed', message: e?.message || String(e) });
    }
  }, [prompt, alert]);

  const handleAddNew = useCallback(async () => {
    if (!storyId) return;
    const defaultName = `Chapter ${steps.length + 1}`;
    const name = await prompt({
      title: 'New chapter',
      label: 'Chapter name',
      defaultValue: defaultName,
      confirmText: 'Add',
    });
    if (!name) return;
    try {
      const blob = onCapture ? await onCapture() : null;
      const persp = await createPerspective({
        name,
        project_id: projectId,
        scenario_id: scenarioId,
        config: blob || {},
      });
      const perspectiveId = persp?.id;
      if (perspectiveId == null) throw new Error('createPerspective returned no id');
      // Re-PATCH for safety (some endpoints ignore config on create).
      if (blob) await updatePerspective(perspectiveId, { config: blob });
      await addStoryStep(storyId, { perspective_id: perspectiveId });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      console.error('[StoryEditor] add chapter failed:', e);
      await alert({ title: 'Add chapter failed', message: e?.message || String(e) });
    }
  }, [storyId, steps.length, onCapture, projectId, scenarioId, prompt, alert]);

  const handleOverwrite = useCallback(async (step) => {
    if (!step?.perspective_id) return;
    const label = step.perspective?.name ?? `Chapter ${step.id}`;
    const ok = await confirm({
      title: `Overwrite "${label}"?`,
      message:
        'This updates the underlying perspective; any other chapters that ' +
        'reference it will also see the new view.',
      confirmText: 'Overwrite',
    });
    if (!ok) return;
    try {
      const blob = onCapture ? await onCapture() : null;
      if (!blob) { await alert({ title: 'Capture failed', message: 'No view-state to capture.' }); return; }
      await updatePerspective(step.perspective_id, { config: blob });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      console.error('[StoryEditor] overwrite failed:', e);
      await alert({ title: 'Overwrite failed', message: e?.message || String(e) });
    }
  }, [onCapture, confirm, alert]);

  const handleEditPrompts = useCallback(async (step) => {
    const existing = Array.isArray(step.suggested_prompts) ? step.suggested_prompts : [];
    const text = await prompt({
      title: 'Suggested prompts',
      message:
        'One prompt per line. These appear as tap-to-send chips in Atlas ' +
        'when this chapter is active.',
      label: 'Prompts',
      defaultValue: existing.join('\n'),
      multiline: true,
      rows: 5,
      confirmText: 'Save',
    });
    if (text == null) return;  // cancelled
    const prompts = text.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await updateStoryStep(storyId, step.id, { suggested_prompts: prompts });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      console.error('[StoryEditor] save prompts failed:', e);
      await alert({ title: 'Save failed', message: e?.message || String(e) });
    }
  }, [storyId, prompt, alert]);

  const handleDelete = useCallback(async (stepId) => {
    const ok = await confirm({
      title: 'Remove chapter?',
      message: 'The underlying perspective will not be deleted.',
      confirmText: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteStoryStep(storyId, stepId);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      console.error('[StoryEditor] deleteStoryStep failed:', e);
      await alert({ title: 'Remove failed', message: e?.message || String(e) });
    }
  }, [storyId, confirm, alert]);

  // Commit a reordering (from a drag drop). Optimistic local update, then
  // persist; on failure just re-fetch to snap back to the server truth.
  const commitOrder = useCallback(async (next) => {
    setSteps(next);
    try {
      await reorderStorySteps(storyId, next.map((s) => s.id));
      setRefreshTick((t) => t + 1);
    } catch (e) {
      console.error('[StoryEditor] reorder failed:', e);
      setRefreshTick((t) => t + 1);
    }
  }, [storyId]);

  const handleDrop = useCallback((targetIdx) => {
    setOverIdx(null);
    setDragIdx((from) => {
      if (from == null || from === targetIdx) return null;
      const next = [...steps];
      const [moved] = next.splice(from, 1);
      next.splice(targetIdx, 0, moved);
      commitOrder(next);
      return null;
    });
  }, [steps, commitOrder]);

  if (!storyId) return null;

  const chapterCount = steps.length;

  return (
    <Box sx={{ mt: 0.5, mb: 0.5 }}>
      <Tabs
        value={tab}
        onChange={(_e, v) => setTab(v)}
        variant="fullWidth"
        sx={{
          minHeight: 30,
          mb: 0.5,
          '& .MuiTab-root': { minHeight: 30, py: 0, fontSize: 12, textTransform: 'none' },
        }}
      >
        <Tab value="chapters" label={`Chapters (${chapterCount})`} />
        <Tab value="settings" label="Settings" />
      </Tabs>

      {tab === 'chapters' && (
        <Box>
          {steps.length > 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.25 }}>
              Drag to reorder · click to apply
            </Typography>
          )}
          {loading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
              <CircularProgress size={16} />
            </Box>
          )}
          {!loading && steps.length === 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
              No chapters yet — set up the view, then add a chapter below.
            </Typography>
          )}
          {/* Scrollable list — preserves reasonable height in the side drawer
              while letting longer stories flow past the visible area. */}
          <Box sx={{ maxHeight: 320, overflowY: 'auto', mx: -0.5 }}>
            {steps.map((step, i) => {
              const active = step.perspective_id === activePerspectiveId;
              const dragging = dragIdx === i;
              const dropTarget = overIdx === i && dragIdx != null && dragIdx !== i;
              return (
                <Box
                  key={step.id}
                  onClick={() => onApplyChapter?.(step.perspective_id)}
                  onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i); }}
                  onDrop={(e) => { e.preventDefault(); handleDrop(i); }}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.25,
                    px: 0.5, py: 0.25,
                    borderRadius: 0.75,
                    cursor: 'pointer',
                    opacity: dragging ? 0.4 : 1,
                    // Insertion indicator: a rule on top of the row you're over.
                    boxShadow: dropTarget ? (t) => `inset 0 2px 0 0 ${t.palette.primary.main}` : 'none',
                    bgcolor: active ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
                    '&:hover .chapter-actions': { opacity: 1 },
                  }}
                >
                  {/* Drag handle — the only draggable element, so text stays
                      selectable and rows still take clicks to apply. */}
                  <Box
                    className="chapter-drag"
                    draggable
                    onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; setDragIdx(i); }}
                    onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                    onClick={(e) => e.stopPropagation()}
                    sx={{
                      display: 'flex', alignItems: 'center',
                      cursor: 'grab',
                      color: 'text.disabled',
                      '&:active': { cursor: 'grabbing' },
                      '&:hover': { color: 'text.secondary' },
                    }}
                  >
                    <DragIndicatorIcon sx={{ fontSize: 16 }} />
                  </Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: active ? 'primary.main' : 'text.secondary',
                      minWidth: 16, fontWeight: active ? 700 : 400,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {i + 1}.
                  </Typography>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="caption"
                      sx={{
                        display: 'block',
                        fontWeight: active ? 600 : 400,
                        color: 'text.primary',
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                        lineHeight: 1.25,
                      }}
                    >
                      {step.perspective?.name ?? `Perspective ${step.perspective_id}`}
                    </Typography>
                    {step.perspective?.description && (
                      <Typography
                        variant="caption"
                        sx={{
                          display: 'block', color: 'text.secondary', fontSize: 10, lineHeight: 1.2,
                          whiteSpace: 'normal', overflowWrap: 'anywhere',
                        }}
                      >
                        {step.perspective.description}
                      </Typography>
                    )}
                  </Box>
                  {/* Only the "overwrite with current view" control lives on the
                      row now — reorder is drag, everything else is in Settings. */}
                  <Box
                    className="chapter-actions"
                    onClick={(e) => e.stopPropagation()}
                    sx={{
                      display: 'flex', alignItems: 'center',
                      opacity: 0,
                      transition: 'opacity 0.12s',
                    }}
                  >
                    <Tooltip title="Overwrite this chapter with the current view">
                      <IconButton size="small" onClick={() => handleOverwrite(step)} sx={{ p: 0.25 }}>
                        <SaveOutlinedIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>
              );
            })}
          </Box>
          {/* Add lives at the bottom of the list, after the running order. */}
          <Box
            onClick={handleAddNew}
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.5,
              mt: 0.5, px: 0.5, py: 0.5,
              borderRadius: 0.75,
              cursor: 'pointer',
              color: 'text.secondary',
              '&:hover': { bgcolor: 'action.hover', color: 'primary.main' },
            }}
          >
            <AddIcon sx={{ fontSize: 16 }} />
            <Typography variant="caption">Add chapter from current view</Typography>
          </Box>
        </Box>
      )}

      {tab === 'settings' && (
        <Box>
          {/* Guide the assistant — story-level description + AI guiding prompt.
              Both are injected into the assistant's context when this story is
              active, so the author can steer how the agent behaves within it. */}
          <Box sx={{ mb: 0.75, p: 0.75, borderRadius: 0.75, bgcolor: 'action.hover' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.25 }}>
              <PsychologyIcon sx={{ fontSize: 14, color: 'text.secondary', mr: 0.5 }} />
              <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1, fontWeight: 600 }}>
                Guide the assistant
              </Typography>
              <Tooltip title="Edit the story description (shown to the assistant)">
                <IconButton size="small" onClick={handleEditStoryDescription} sx={{ p: 0.25 }}>
                  <NotesIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Edit the AI guiding prompt">
                <IconButton size="small" onClick={handleEditGuide} sx={{ p: 0.25 }}>
                  <EditOutlinedIcon
                    sx={{ fontSize: 14, color: story?.guiding_prompt ? 'primary.main' : 'inherit' }}
                  />
                </IconButton>
              </Tooltip>
            </Box>
            <Typography
              variant="caption"
              sx={{
                color: story?.guiding_prompt ? 'text.primary' : 'text.disabled',
                fontStyle: story?.guiding_prompt ? 'normal' : 'italic',
                // Preview only — clamp to two lines with an ellipsis so a long
                // prompt doesn't fill the side tray. Edit it via the pencil.
                overflow: 'hidden', textOverflow: 'ellipsis',
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflowWrap: 'anywhere',
              }}
            >
              {story?.guiding_prompt || 'No guiding prompt yet — click the pencil to add one.'}
            </Typography>
          </Box>

          {/* Share — a story is only steps pointing at perspective rows, and
              those ids mean nothing on another machine (stories live in each
              checkout's own SQLite DB). The bundle inlines every step's full
              perspective config so the file stands alone. */}
          <Box sx={{ mb: 0.75, p: 0.75, borderRadius: 0.75, bgcolor: 'action.hover' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
              <IosShareIcon sx={{ fontSize: 14, color: 'text.secondary', mr: 0.5 }} />
              <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1, fontWeight: 600 }}>
                Share
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Button
                size="small" variant="outlined" fullWidth
                startIcon={<FileDownloadOutlinedIcon sx={{ fontSize: 14 }} />}
                disabled={!storyId || busy}
                onClick={handleExport}
                sx={{ textTransform: 'none', fontSize: 12, py: 0.25 }}
              >
                Export
              </Button>
              <Button
                size="small" variant="outlined" fullWidth
                startIcon={<FileUploadOutlinedIcon sx={{ fontSize: 14 }} />}
                disabled={busy}
                onClick={handleImportClick}
                sx={{ textTransform: 'none', fontSize: 12, py: 0.25 }}
              >
                Import
              </Button>
            </Box>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
          </Box>

          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.25 }}>
            Chapter settings
          </Typography>
          {steps.length === 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
              No chapters yet.
            </Typography>
          )}
          <Box sx={{ maxHeight: 320, overflowY: 'auto', mx: -0.5 }}>
            {steps.map((step, i) => (
              <Box
                key={step.id}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 0.25,
                  px: 0.5, py: 0.25, borderRadius: 0.75,
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Typography
                  variant="caption"
                  sx={{ color: 'text.secondary', minWidth: 16, fontVariantNumeric: 'tabular-nums' }}
                >
                  {i + 1}.
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    flex: 1, minWidth: 0, color: 'text.primary',
                    whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.25,
                  }}
                >
                  {step.perspective?.name ?? `Perspective ${step.perspective_id}`}
                </Typography>
                <Tooltip title="Edit chapter description (shown to the assistant)">
                  <IconButton size="small" onClick={() => handleEditChapterDescription(step)} sx={{ p: 0.25 }}>
                    <NotesIcon
                      sx={{ fontSize: 14, color: step.perspective?.description ? 'primary.main' : 'inherit' }}
                    />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Edit suggested chat prompts">
                  <IconButton size="small" onClick={() => handleEditPrompts(step)} sx={{ p: 0.25 }}>
                    <ChatBubbleOutlineIcon
                      sx={{ fontSize: 14, color: step.suggested_prompts?.length ? 'primary.main' : 'inherit' }}
                    />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete chapter">
                  <IconButton size="small" onClick={() => handleDelete(step.id)} sx={{ p: 0.25 }}>
                    <DeleteOutlineIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
