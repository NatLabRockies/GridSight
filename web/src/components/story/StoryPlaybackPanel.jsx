/**
 * StoryPlaybackPanel — prev / chapter-title / next control surface.
 *
 * Mounts inside a ChartFrame (inline, tray, bottom, side, floating, or in
 * a popped-out tab). Touch-first layout: large hit targets for Prev and
 * Next, big chapter title. Keyboard ←/→ also advance.
 *
 * State model:
 *   - The story and active chapter are owned by App.jsx (activeStory +
 *     activePerspective), which passes them in as props. The panel is a
 *     thin reader/writer — it calls onApplyChapter(perspective_id) to
 *     advance. That flows through handleApplyPerspective which in turn
 *     dispatches applyViewState.
 *   - Drift: each time the panel re-renders we compare the live captured
 *     blob to the current chapter's saved blob (viewStateMatches). If
 *     they differ, show a small "modified" dot + Reset button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import ArrowForwardIosIcon from '@mui/icons-material/ArrowForwardIos';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

import { fetchStories, fetchStorySteps } from '../../lib/loaders.js';
import { viewStateMatches } from '../../lib/viewState.js';

// Larger hit targets for touch. 44px is Apple's guideline minimum;
// 56px gives comfortable tap room for presenter / tablet use.
const NAV_HIT = 56;

export default function StoryPlaybackPanel({
  storyId,
  activePerspectiveId,
  onApplyChapter,
  onCapture,
  onChangeStory,   // (storyId | null) => void — switch stories from the panel
}) {
  const [steps, setSteps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [, forceTick] = useState(0);   // manual re-render for drift poll
  const lastStoryRef = useRef(null);

  // Story catalog for the dropdown. Fetched once on mount and refreshed
  // when the active story changes (covers newly-created or deleted stories
  // without requiring the operator to reload the tab).
  const [stories, setStories] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetchStories({})
      .then((list) => { if (!cancelled) setStories(Array.isArray(list) ? list : []); })
      .catch((e) => console.warn('[StoryPlaybackPanel] fetchStories:', e));
    return () => { cancelled = true; };
  }, [storyId]);

  useEffect(() => {
    if (!storyId) { setSteps([]); return; }
    let cancelled = false;
    setLoading(true);
    fetchStorySteps(storyId)
      .then((list) => { if (!cancelled) setSteps(Array.isArray(list) ? list : []); })
      .catch((e) => console.warn('[StoryPlaybackPanel] fetchStorySteps:', e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [storyId]);

  const currentIndex = useMemo(() => {
    if (!steps.length || activePerspectiveId == null) return -1;
    return steps.findIndex((s) => s.perspective_id === activePerspectiveId);
  }, [steps, activePerspectiveId]);

  const currentStep = currentIndex >= 0 ? steps[currentIndex] : null;
  const currentTitle = currentStep?.perspective?.name
    ?? (currentStep ? `Chapter ${currentIndex + 1}` : 'No chapter selected');

  // Auto-apply the first chapter when a story is freshly opened and no
  // chapter is active yet. Keeps the presentation flow linear without
  // making the user hunt for the first step. Only fire once per story.
  useEffect(() => {
    if (!storyId || !steps.length || !onApplyChapter) return;
    if (lastStoryRef.current === storyId) return;
    lastStoryRef.current = storyId;
    if (currentIndex < 0) onApplyChapter(steps[0].perspective_id);
  }, [storyId, steps, currentIndex, onApplyChapter]);

  const goTo = useCallback((idx) => {
    if (idx < 0 || idx >= steps.length) return;
    const step = steps[idx];
    if (!step?.perspective_id) return;
    onApplyChapter?.(step.perspective_id);
  }, [steps, onApplyChapter]);

  const handlePrev = useCallback(() => goTo(currentIndex - 1), [goTo, currentIndex]);
  const handleNext = useCallback(() => goTo(currentIndex + 1), [goTo, currentIndex]);
  const handleReset = useCallback(() => {
    // Re-apply the current chapter's perspective. handleApplyPerspective
    // fetches + applies, so calling it with the same id snaps us back.
    if (currentStep?.perspective_id) onApplyChapter?.(currentStep.perspective_id);
  }, [currentStep, onApplyChapter]);

  // Keyboard nav — only when this panel (or a descendant) isn't inside a
  // text input. We listen on window so it works regardless of focus, but
  // bail if the user is typing.
  useEffect(() => {
    function onKey(ev) {
      const tag = ev.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.target?.isContentEditable) return;
      if (ev.key === 'ArrowRight') { handleNext(); }
      else if (ev.key === 'ArrowLeft') { handlePrev(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleNext, handlePrev]);

  // Drift detection — poll once per second. Too fine-grained polling
  // isn't needed for a presentation tool, and re-running capture on
  // every React render would be wasteful.
  const drift = useMemo(() => {
    if (!currentStep || !onCapture) return false;
    try {
      const live = onCapture();
      const saved = currentStep.perspective?.config_json;
      const savedBlob = typeof saved === 'string' ? JSON.parse(saved) : saved;
      if (!live || !savedBlob) return false;
      return !viewStateMatches(live, savedBlob);
    } catch { return false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, activePerspectiveId, forceTick]);

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < steps.length - 1;

  // Story picker — rendered only when the host exposes onChangeStory
  // (i.e. command-center / panel-host use cases). The inline sidebar
  // uses its own StoryPicker, so we keep the playback bar clean there.
  const showPicker = !!onChangeStory;

  const pickerRow = showPicker && (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', px: 1, pt: 0.5 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
        Story
      </Typography>
      <FormControl size="small" sx={{ flex: 1 }}>
        <Select
          value={storyId ?? ''}
          onChange={(e) => onChangeStory?.(e.target.value || null)}
          displayEmpty
          sx={{ '& .MuiSelect-select': { py: 0.75 } }}
        >
          <MenuItem value="">
            <Typography variant="body2" color="text.secondary">
              {stories.length === 0 ? 'No stories saved' : 'None'}
            </Typography>
          </MenuItem>
          {stories.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              <Typography variant="body2" noWrap>{s.name ?? `Story ${s.id}`}</Typography>
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Box>
  );

  // Chapter dropdown — quick jump to any chapter without stepping through
  // prev/next. Only rendered alongside the story picker (same pop-out
  // surfaces) so the inline sidebar stays uncluttered.
  const chapterPickerRow = showPicker && storyId && steps.length > 0 && (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', px: 1, pt: 0.5 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
        Chapter
      </Typography>
      <FormControl size="small" sx={{ flex: 1 }}>
        <Select
          value={currentIndex >= 0 ? currentIndex : ''}
          onChange={(e) => {
            const idx = e.target.value;
            if (idx !== '' && Number.isInteger(idx)) goTo(idx);
          }}
          displayEmpty
          sx={{ '& .MuiSelect-select': { py: 0.75 } }}
        >
          <MenuItem value="">
            <Typography variant="body2" color="text.secondary">Select a chapter</Typography>
          </MenuItem>
          {steps.map((s, i) => (
            <MenuItem key={s.id} value={i}>
              <Typography variant="body2" noWrap>
                {i + 1}. {s.perspective?.name ?? `Chapter ${i + 1}`}
              </Typography>
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Box>
  );

  if (!storyId) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
        {pickerRow}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, p: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {showPicker ? 'Pick a story to begin playback.' : 'Select a story to begin playback.'}
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
      }}
    >
      {pickerRow}
      {chapterPickerRow}
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        width: '100%',
        flex: 1,
        px: 1,
        minHeight: 72,
      }}>
      <Tooltip title="Previous chapter (←)">
        <span>
          <IconButton
            onClick={handlePrev}
            disabled={!hasPrev}
            sx={{
              width: NAV_HIT, height: NAV_HIT,
              bgcolor: 'action.hover',
              '&:hover': { bgcolor: 'action.selected' },
              flexShrink: 0,
            }}
          >
            <ArrowBackIosNewIcon />
          </IconButton>
        </span>
      </Tooltip>

      <Box sx={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
        {loading ? (
          <CircularProgress size={18} />
        ) : (
          <>
            <Typography
              variant="caption"
              sx={{ color: 'text.secondary', display: 'block', letterSpacing: 0.5 }}
            >
              {currentIndex >= 0
                ? `Chapter ${currentIndex + 1} of ${steps.length}`
                : `${steps.length} chapter${steps.length === 1 ? '' : 's'}`}
              {drift && (
                <Box
                  component="span"
                  sx={{
                    display: 'inline-block',
                    width: 8, height: 8,
                    borderRadius: '50%',
                    bgcolor: 'warning.main',
                    ml: 0.75, verticalAlign: 'middle',
                  }}
                  title="View has drifted from this chapter"
                />
              )}
            </Typography>
            <Typography
              variant="subtitle1"
              noWrap
              sx={{ fontWeight: 600, lineHeight: 1.2 }}
            >
              {currentTitle}
            </Typography>
            {currentStep?.narration && (
              <Typography
                variant="caption"
                noWrap
                sx={{ color: 'text.secondary', display: 'block' }}
              >
                {currentStep.narration}
              </Typography>
            )}
          </>
        )}
      </Box>

      {drift && (
        <Tooltip title="Reset to this chapter's saved view">
          <IconButton
            onClick={handleReset}
            sx={{
              width: NAV_HIT, height: NAV_HIT,
              flexShrink: 0,
            }}
          >
            <RestartAltIcon />
          </IconButton>
        </Tooltip>
      )}

      <Tooltip title="Next chapter (→)">
        <span>
          <IconButton
            onClick={handleNext}
            disabled={!hasNext}
            sx={{
              width: NAV_HIT, height: NAV_HIT,
              bgcolor: 'action.hover',
              '&:hover': { bgcolor: 'action.selected' },
              flexShrink: 0,
            }}
          >
            <ArrowForwardIosIcon />
          </IconButton>
        </span>
      </Tooltip>
      </Box>
    </Box>
  );
}
