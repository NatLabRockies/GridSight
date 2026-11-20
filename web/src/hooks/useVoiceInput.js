/**
 * useVoiceInput — single entry point the ChatPanel uses for speech-to-text.
 * Delegates to on-device Whisper (WASM) when the user has enabled it in
 * Developer Settings, otherwise to the native Web Speech API. Both share the
 * same onResult/onEnd contract, so the composer + auto-send logic is unchanged.
 *
 * Both underlying hooks are always instantiated (React hook rules) but are inert
 * until start() is called, so the unused one costs nothing.
 *
 * Returns: { supported, listening, loading, progress, engine, start, stop, cancel }
 *   engine   — 'whisper' | 'native'
 *   loading  — model download / transcription in flight (whisper only)
 *   progress — 0..100 during the one-time model download (whisper only)
 */
import { useSpeechInput } from './useSpeechInput.js';
import { useWhisperInput } from './useWhisperInput.js';
import useWhisperPreference from './useWhisperPreference.js';

export default function useVoiceInput({ onResult, onEnd, lang = 'en-US' } = {}) {
  const { enabled: whisperEnabled } = useWhisperPreference();
  const native = useSpeechInput({ onResult, onEnd, lang });
  const whisper = useWhisperInput({ onResult, onEnd });

  if (whisperEnabled) {
    return {
      engine: 'whisper',
      supported: whisper.supported,
      listening: whisper.listening,
      loading: whisper.loading,
      progress: whisper.progress,
      start: whisper.start,
      stop: whisper.stop,
      cancel: whisper.cancel,
    };
  }
  return {
    engine: 'native',
    supported: native.supported,
    listening: native.listening,
    loading: false,
    progress: 0,
    start: native.start,
    stop: native.stop,
    cancel: native.stop,   // native has no distinct cancel; stopping aborts
  };
}
