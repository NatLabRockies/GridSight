/**
 * useSpeechInput — push-to-talk speech-to-text via the Web Speech API.
 *
 * Wraps the browser's SpeechRecognition (Chrome/Edge expose it as
 * ``webkitSpeechRecognition``). Unsupported browsers (and most non-Chromium
 * webviews) report ``supported: false`` so callers can hide the mic button.
 *
 * The recognizer runs in single-utterance mode: it starts on ``start()``,
 * streams interim results, and auto-stops on a natural pause (or an explicit
 * ``stop()``). ``onResult(text, isFinal)`` fires with the recognized text —
 * interim strings while the user is still speaking, then the final string.
 *
 * ``onEnd({ manual })`` fires when recognition stops. ``manual`` is true when
 * the caller invoked ``stop()`` (e.g. the user tapped the mic to cancel) and
 * false when the recognizer ended on its own (the speaker paused). Callers use
 * this to auto-send a dictated message only on a natural end.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition || null
    : null;

export function isSpeechInputSupported() {
  return !!SpeechRecognitionImpl;
}

export function useSpeechInput({ onResult, onEnd, lang = 'en-US' } = {}) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  // True once stop() was called for the current session, so onEnd can tell a
  // user-cancelled stop apart from a natural pause-driven end.
  const manualRef = useRef(false);
  // Keep the latest callbacks without re-creating the recognizer each render.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  const stop = useCallback(() => {
    manualRef.current = true;
    try {
      recRef.current?.stop();
    } catch {}
  }, []);

  const start = useCallback(() => {
    if (!SpeechRecognitionImpl) return;
    // Tear down any prior instance so we never run two recognizers at once.
    try {
      recRef.current?.abort();
    } catch {}

    manualRef.current = false;
    const rec = new SpeechRecognitionImpl();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false; // one utterance; stops on a natural pause

    rec.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (finalText) onResultRef.current?.(finalText.trim(), true);
      else if (interim) onResultRef.current?.(interim.trim(), false);
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      onEndRef.current?.({ manual: manualRef.current });
    };
    rec.onerror = () => {
      // An error (e.g. no-speech) counts as a non-natural end so we don't
      // auto-send an empty/garbled utterance.
      manualRef.current = true;
      setListening(false);
      recRef.current = null;
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws if already started — ignore.
    }
  }, [lang]);

  // Abort any in-flight recognition when the component unmounts.
  useEffect(
    () => () => {
      try {
        recRef.current?.abort();
      } catch {}
    },
    [],
  );

  return { supported: !!SpeechRecognitionImpl, listening, start, stop };
}
