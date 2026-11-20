/**
 * useWhisperInput — push-to-talk STT backed by on-device Whisper (WASM), a
 * drop-in sibling of useSpeechInput for environments where the native Web
 * Speech API is unavailable (Electron table, non-Chromium, offline).
 *
 * UX: tap the mic to start recording, tap again to finish. On finish we resample
 * the captured audio to 16 kHz mono, run Whisper, emit the final text via
 * `onResult(text, true)`, then `onEnd({ manual:false })` so the caller can
 * auto-send — matching useSpeechInput's natural-end contract. An empty/garbled
 * result ends with `{ manual:true }` so nothing is auto-sent. `cancel()` aborts
 * without transcribing.
 *
 * Returns the useSpeechInput shape plus `loading` (model download / transcribe
 * in flight) and `progress` (0..100 during the one-time model download).
 *
 * Note: mic capture (getUserMedia) still requires a secure context — but Whisper
 * itself is fully local, so a secure-context Electron shell (file://, app://,
 * https://) works even though native SpeechRecognition does not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribe } from '../lib/whisperEngine.js';
import { getWhisperModel } from '../lib/whisperPreference.js';

const AudioCtx = typeof window !== 'undefined'
  ? (window.AudioContext || window.webkitAudioContext || null)
  : null;

export function isWhisperInputSupported() {
  return !!(
    AudioCtx
    && typeof window !== 'undefined'
    && typeof window.MediaRecorder !== 'undefined'
    && navigator?.mediaDevices?.getUserMedia
  );
}

// Voice-activity detection thresholds (RMS of the mic waveform, 0..1) used to
// auto-stop on a natural pause — the "end of speech" behavior the native
// recognizer had. Hysteresis: SPEECH_ON must be crossed for the utterance to
// count as started, then a sustained dip below SILENCE_OFF ends it. Tuned for a
// typical indoor mic; adjust if the room is noisy or the table mic is far.
const VAD_SPEECH_ON = 0.02;      // above this → speaking (utterance has begun)
const VAD_SILENCE_OFF = 0.012;   // below this → counting silence
const VAD_SILENCE_HOLD_MS = 1200; // sustained silence after speech → end
const VAD_MAX_UTTERANCE_MS = 20000; // hard cap so a stuck mic still finalizes
const VAD_POLL_MS = 100;

// Decode a recorded audio Blob to 16 kHz mono Float32 (what Whisper expects).
async function blobToFloat32Mono16k(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuf);
    const frames = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContext(1, Math.max(1, frames), 16000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    try { await ctx.close(); } catch { /* noop */ }
  }
}

export function useWhisperInput({ onResult, onEnd } = {}) {
  const [listening, setListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const cancelledRef = useRef(false);
  // Voice-activity detection (auto-stop on pause).
  const vadCtxRef = useRef(null);
  const vadTimerRef = useRef(null);

  const onResultRef = useRef(onResult); onResultRef.current = onResult;
  const onEndRef = useRef(onEnd); onEndRef.current = onEnd;

  const cleanupStream = useCallback(() => {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    streamRef.current = null;
  }, []);

  const stopVad = useCallback(() => {
    if (vadTimerRef.current) { clearInterval(vadTimerRef.current); vadTimerRef.current = null; }
    try { vadCtxRef.current?.close(); } catch { /* noop */ }
    vadCtxRef.current = null;
  }, []);

  // Watch the mic level and stop the recorder after a sustained pause (once the
  // speaker has actually started), so the utterance finalizes and auto-sends
  // without a manual tap — mirroring the native recognizer's end-of-speech.
  const startVad = useCallback((stream) => {
    try {
      const actx = new AudioCtx();
      vadCtxRef.current = actx;
      // start() runs inside the mic-click gesture, so resume() is allowed —
      // otherwise a suspended context feeds the analyser silence.
      try { actx.resume?.(); } catch { /* noop */ }
      const source = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // not connected to destination — no echo
      const data = new Uint8Array(analyser.fftSize);
      const startedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      let spoke = false;
      let silenceStart = null;
      vadTimerRef.current = setInterval(() => {
        const rec = recorderRef.current;
        if (!rec || rec.state !== 'recording') return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (rms > VAD_SPEECH_ON) { spoke = true; silenceStart = null; }
        else if (rms < VAD_SILENCE_OFF) { if (silenceStart == null) silenceStart = now; }
        else { silenceStart = null; }
        const ended = spoke && silenceStart != null && (now - silenceStart) > VAD_SILENCE_HOLD_MS;
        if (ended || (now - startedAt) > VAD_MAX_UTTERANCE_MS) {
          stopVad();
          try { rec.stop(); } catch { /* onstop handles the rest */ }
        }
      }, VAD_POLL_MS);
    } catch {
      // VAD is best-effort — tap-to-stop still finalizes the utterance.
    }
  }, [stopVad]);

  const start = useCallback(async () => {
    if (!isWhisperInputSupported()) return;
    cancelledRef.current = false;
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        setListening(false);
        stopVad();
        cleanupStream();
        if (cancelledRef.current) return;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (!blob.size) { onEndRef.current?.({ manual: true }); return; }
        setLoading(true);
        try {
          const audio = await blobToFloat32Mono16k(blob);
          const text = await transcribe(
            getWhisperModel(), audio,
            (pct) => setProgress(pct),
          );
          if (text) {
            onResultRef.current?.(text, true);
            onEndRef.current?.({ manual: false });   // natural finish → auto-send
          } else {
            onEndRef.current?.({ manual: true });    // nothing heard → don't send
          }
        } catch (err) {
          console.warn('[whisper] transcription failed:', err);
          onEndRef.current?.({ manual: true });
        } finally {
          setLoading(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      startVad(stream);
      setListening(true);
    } catch (err) {
      // Permission denied / no mic / insecure context.
      console.warn('[whisper] mic capture failed:', err);
      stopVad();
      cleanupStream();
      setListening(false);
      onEndRef.current?.({ manual: true });
    }
  }, [cleanupStream, startVad, stopVad]);

  const stop = useCallback(() => {
    try { recorderRef.current?.stop(); } catch { /* noop */ }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stopVad();
    try { recorderRef.current?.stop(); } catch { /* noop */ }
    cleanupStream();
    setListening(false);
  }, [cleanupStream, stopVad]);

  useEffect(() => () => {
    cancelledRef.current = true;
    stopVad();
    try { recorderRef.current?.stop(); } catch { /* noop */ }
    cleanupStream();
  }, [cleanupStream, stopVad]);

  return {
    supported: isWhisperInputSupported(),
    listening,
    loading,
    progress,
    start,
    stop,
    cancel,
  };
}
