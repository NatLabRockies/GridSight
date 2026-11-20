/**
 * whisperPreference — shared, localStorage-backed preference for on-device
 * (WASM) voice input via Whisper. Separate from the native Web Speech API path
 * (see useSpeechInput.js): the native API needs Google's cloud speech backend
 * and a secure context, neither of which exists in the Electron table wrapper.
 * Whisper runs entirely in the renderer, so it works there and offline.
 *
 * This is a tiny pub/sub store (not a React context) so both the Developer
 * Settings toggle and the ChatPanel voice hook stay in lockstep the instant the
 * user flips it — including across tabs via the `storage` event. Mirrors the
 * localStorage style of useGpuPreference, with live subscription added.
 */

const ENABLED_KEY = 'gridsight.whisper.enabled';
const MODEL_KEY = 'gridsight.whisper.model';

// The models offered in Developer Settings. `id` is the transformers.js repo
// id; assets are resolved from the self-hosted `/models/<id>/…` path in
// production (HuggingFace/jsDelivr CDNs are blocked on the lab network) with a
// remote fallback in dev. Sizes are approximate quantized download sizes.
export const WHISPER_MODELS = [
  { id: 'Xenova/whisper-tiny.en', label: 'tiny.en — fastest (~40 MB)', sizeMb: 40, lang: 'en' },
  { id: 'Xenova/whisper-base.en', label: 'base.en — more accurate (~140 MB)', sizeMb: 140, lang: 'en' },
  { id: 'Xenova/whisper-tiny', label: 'tiny — multilingual (~45 MB)', sizeMb: 45, lang: 'multi' },
];

export const DEFAULT_WHISPER_MODEL = 'Xenova/whisper-tiny.en';

const listeners = new Set();

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function isWhisperEnabled() {
  return read(ENABLED_KEY, '0') === '1';
}

export function getWhisperModel() {
  const stored = read(MODEL_KEY, DEFAULT_WHISPER_MODEL);
  return WHISPER_MODELS.some((m) => m.id === stored) ? stored : DEFAULT_WHISPER_MODEL;
}

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* a bad listener shouldn't break the others */ }
  }
}

export function setWhisperEnabled(enabled) {
  try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); } catch { /* noop */ }
  emit();
}

export function setWhisperModel(id) {
  const next = WHISPER_MODELS.some((m) => m.id === id) ? id : DEFAULT_WHISPER_MODEL;
  try { localStorage.setItem(MODEL_KEY, next); } catch { /* noop */ }
  emit();
}

/** Subscribe to preference changes. Returns an unsubscribe fn. */
export function subscribeWhisper(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Keep tabs in sync — a toggle in one tab/window (e.g. the control iPad vs the
// table) propagates to the others.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === ENABLED_KEY || e.key === MODEL_KEY) emit();
  });
}
