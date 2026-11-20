#!/usr/bin/env node
/**
 * fetch-whisper-assets — populate self-hosted Whisper assets under web/public
 * so the on-device voice input works on the locked-down lab network (where the
 * HuggingFace + jsDelivr CDNs transformers.js normally uses are blocked).
 *
 * Produces:
 *   public/ort/*.wasm                      — ONNX Runtime Web binaries (copied
 *                                            from node_modules, no download)
 *   public/models/<repo>/…                 — Whisper model files (from HF)
 *
 * vite copies public/ into dist/ at build, so these ship inside the web image
 * and are served same-origin at /ort/… and /models/…. Set VITE_WHISPER_OFFLINE=1
 * for the build so transformers.js never falls back to the CDN.
 *
 * Run from web/:  node scripts/fetch-whisper-assets.mjs [--models tiny.en,base.en] [--force]
 * Defaults to just whisper-tiny.en (the app default) to keep the image lean.
 *
 * Requires network access ON THE BUILD MACHINE only — the runtime (table) never
 * fetches these from the internet.
 *
 * On networks that TLS-intercept the HuggingFace LFS CDN, Node can reject its
 * cert ("certificate has expired"). Either point Node at your network's
 * root CA — `NODE_EXTRA_CA_CERTS=/path/to/root.pem` — or, as a
 * build-time-only escape hatch, run with `WHISPER_FETCH_INSECURE=1` to skip TLS
 * verification for this fetch (safe enough: public model weights, build host only).
 */
// Build-time-only: allow skipping TLS verification behind a TLS-intercepting proxy.
if (process.env.WHISPER_FETCH_INSECURE === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('⚠ WHISPER_FETCH_INSECURE=1 — TLS verification disabled for this fetch.');
}
import { mkdir, copyFile, readdir, stat, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const PUBLIC = join(WEB, 'public');
const HF = 'https://huggingface.co';

// The files transformers.js requests for a quantized ASR pipeline. Missing ones
// (some repos omit generation_config) are skipped, not fatal.
const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

const ALL = {
  'tiny.en': 'Xenova/whisper-tiny.en',
  'base.en': 'Xenova/whisper-base.en',
  'tiny': 'Xenova/whisper-tiny',
};

function parseArgs() {
  const args = process.argv.slice(2);
  let models = ['tiny.en'];
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--models') models = (args[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (args[i] === '--all') models = Object.keys(ALL);
    else if (args[i] === '--force') force = true;
  }
  return { models, force };
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function copyOrtWasm() {
  const src = join(WEB, 'node_modules', 'onnxruntime-web', 'dist');
  const dest = join(PUBLIC, 'ort');
  await mkdir(dest, { recursive: true });
  const files = (await readdir(src)).filter((f) => f.endsWith('.wasm'));
  if (!files.length) throw new Error(`no ORT wasm in ${src} — run \`bun install\` first`);
  for (const f of files) {
    await copyFile(join(src, f), join(dest, f));
    const { size } = await stat(join(dest, f));
    console.log(`  ort/${f}  (${(size / 1e6).toFixed(1)} MB)`);
  }
}

async function fetchModel(repo, force) {
  const base = join(PUBLIC, 'models', repo);
  for (const rel of MODEL_FILES) {
    const out = join(base, rel);
    if (!force && await exists(out)) { console.log(`  skip  ${repo}/${rel} (exists)`); continue; }
    const url = `${HF}/${repo}/resolve/main/${rel}`;
    const res = await fetch(url);
    if (res.status === 404) { console.log(`  n/a   ${repo}/${rel}`); continue; }
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    await mkdir(dirname(out), { recursive: true });
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(out, buf);
    console.log(`  get   ${repo}/${rel}  (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
}

async function main() {
  const { models, force } = parseArgs();
  const repos = models.map((m) => ALL[m]).filter(Boolean);
  if (!repos.length) { console.error(`Unknown model(s). Choose from: ${Object.keys(ALL).join(', ')}`); process.exit(1); }

  console.log('→ ONNX Runtime Web wasm → public/ort/');
  await copyOrtWasm();
  for (const repo of repos) {
    console.log(`→ ${repo} → public/models/${repo}/`);
    await fetchModel(repo, force);
  }
  console.log('\n✓ Whisper assets staged under web/public. Build with VITE_WHISPER_OFFLINE=1 to force fully-local.');
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
