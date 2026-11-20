/**
 * whisperEngine — lazy, singleton wrapper around transformers.js Whisper.
 *
 * Nothing here is imported until the very first call to `preload()` /
 * `transcribe()` (i.e. when the user turns the toggle on), so normal page load
 * pays zero cost. The heavy `@xenova/transformers` chunk and the model weights
 * download on demand and are then cached (Cache API) for subsequent utterances
 * and reloads.
 *
 * Asset hosting on the lab network: HuggingFace + jsDelivr CDNs are blocked, so
 * the model files and the ONNX-Runtime `.wasm` binaries are served from THIS
 * origin under `/models/<repo>/…` and `/ort/…` (populated by
 * scripts/fetch-whisper-assets.mjs and baked into the web image). In dev we
 * allow the CDN as a fallback so it works without running that script. Set
 * `VITE_WHISPER_OFFLINE=1` to force fully-local (no CDN) for the deployment.
 */

let _transformers = null;      // memoised module import
const _pipelines = new Map();  // modelId -> Promise<pipeline>

const BASE = (import.meta.env.BASE_URL || '/');
const OFFLINE = import.meta.env.VITE_WHISPER_OFFLINE === '1';

async function loadTransformers() {
  if (_transformers) return _transformers;
  const mod = await import('@xenova/transformers');
  const { env } = mod;
  // Serve model files from our own origin first.
  env.allowLocalModels = true;
  env.localModelPath = `${BASE}models/`;
  env.useBrowserCache = true;
  // In production (offline) never touch the CDN; in dev fall back to it so the
  // feature works before the assets are fetched locally.
  env.allowRemoteModels = !OFFLINE;
  if (OFFLINE) {
    env.backends.onnx.wasm.wasmPaths = `${BASE}ort/`;
  }
  // Whisper is small; a single WASM thread avoids the cross-origin-isolation
  // (COOP/COEP) headers that multi-threaded ORT would otherwise require.
  try { env.backends.onnx.wasm.numThreads = 1; } catch { /* older builds */ }
  _transformers = mod;
  return mod;
}

/**
 * Ensure the ASR pipeline for `modelId` is loaded. `onProgress(percent, info)`
 * is called during the one-time download (percent 0..100). Resolves to the
 * pipeline. Cached per model so switching models re-downloads only once.
 */
export function ensurePipeline(modelId, onProgress) {
  if (_pipelines.has(modelId)) return _pipelines.get(modelId);

  const p = (async () => {
    const { pipeline } = await loadTransformers();
    // Track per-file bytes so we can report one overall percentage.
    const files = new Map();
    const report = () => {
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) { loaded += f.loaded || 0; total += f.total || 0; }
      const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      onProgress?.(pct, { loaded, total });
    };
    return pipeline('automatic-speech-recognition', modelId, {
      quantized: true,
      progress_callback: (info) => {
        if (info?.status === 'progress' || info?.status === 'download' || info?.status === 'done') {
          if (info.file) {
            files.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
            report();
          }
        }
      },
    });
  })();

  _pipelines.set(modelId, p);
  // If the load fails, drop the cached rejected promise so a retry can start clean.
  p.catch(() => _pipelines.delete(modelId));
  return p;
}

/** Kick off the model download without transcribing (used on toggle-on). */
export async function preload(modelId, onProgress) {
  await ensurePipeline(modelId, onProgress);
}

/** True once the pipeline for `modelId` has finished loading. */
export function isModelReady(modelId) {
  // Map holds a Promise; readiness is tracked by the hook/caller after await.
  return _pipelines.has(modelId);
}

/**
 * Transcribe 16 kHz mono PCM (Float32Array) → trimmed text.
 * Loads the model first if needed (reporting progress).
 */
export async function transcribe(modelId, audioFloat32, onProgress) {
  const pipe = await ensurePipeline(modelId, onProgress);
  const out = await pipe(audioFloat32, {
    // Short single-utterance prompts; defaults handle chunking fine.
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : (out?.text || '');
  return text.trim();
}
