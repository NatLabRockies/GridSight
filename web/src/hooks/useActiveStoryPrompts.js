/**
 * useActiveStoryPrompts — suggested chat prompts for the currently-active
 * story step.
 *
 * Mirrors StoryPlaybackPanel's active-step derivation: fetch the active
 * story's steps and match the active perspective to find the current step,
 * then return that step's ``suggested_prompts`` (authored in the story
 * editor). Returns ``[]`` when no story is active or the step has none.
 *
 * Kept separate from StoryPlaybackPanel so the Atlas chat can surface the
 * prompts without depending on the playback panel being mounted.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchStorySteps } from '../lib/loaders.js';

export function useActiveStoryPrompts(storyId, activePerspectiveId) {
  const [steps, setSteps] = useState([]);

  useEffect(() => {
    if (!storyId) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    fetchStorySteps(storyId)
      .then((list) => {
        if (!cancelled) setSteps(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setSteps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [storyId]);

  return useMemo(() => {
    if (!steps.length || activePerspectiveId == null) return [];
    const step = steps.find((s) => s.perspective_id === activePerspectiveId);
    return Array.isArray(step?.suggested_prompts) ? step.suggested_prompts : [];
  }, [steps, activePerspectiveId]);
}
