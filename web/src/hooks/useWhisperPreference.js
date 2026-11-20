/**
 * useWhisperPreference — React binding for the whisperPreference store.
 * Re-renders the component whenever the enabled flag or selected model change
 * (from this tab or another), so the Developer Settings toggle and the ChatPanel
 * mic button stay in sync without prop-drilling.
 */
import { useSyncExternalStore, useCallback } from 'react';
import {
  isWhisperEnabled,
  getWhisperModel,
  setWhisperEnabled,
  setWhisperModel,
  subscribeWhisper,
} from '../lib/whisperPreference.js';

// A single snapshot string so useSyncExternalStore's identity check is stable
// (it compares snapshots by ===; returning a fresh object each call would loop).
function getSnapshot() {
  return `${isWhisperEnabled() ? '1' : '0'}|${getWhisperModel()}`;
}

export default function useWhisperPreference() {
  const snapshot = useSyncExternalStore(subscribeWhisper, getSnapshot, getSnapshot);
  const [enabledFlag, model] = snapshot.split('|');
  return {
    enabled: enabledFlag === '1',
    model,
    setEnabled: useCallback((v) => setWhisperEnabled(!!v), []),
    setModel: useCallback((id) => setWhisperModel(id), []),
  };
}
