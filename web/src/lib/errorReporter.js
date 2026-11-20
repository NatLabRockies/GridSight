/**
 * errorReporter — send the web app's errors to the backend, so that agents
 * (MCP `get_errors`, the in-app AI) can see what failed and correct it.
 *
 * Captures console.error, uncaught exceptions and unhandled promise
 * rejections, plus anything passed to reportError(). Batches them and POSTs
 * to /api/client-errors. Never throws, and never reports its own failures.
 */

const QUEUE_MAX = 50;
const FLUSH_MS = 1000;

let queue = [];
let timer = null;
let installed = false;
let sending = false;

function text(args) {
  return args.map((a) => {
    if (a == null) return String(a);
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function stackOf(args) {
  const err = args.find((a) => a instanceof Error);
  return err?.stack ? String(err.stack).slice(0, 4000) : undefined;
}

async function flush() {
  timer = null;
  if (sending || queue.length === 0) return;
  const errors = queue.splice(0, QUEUE_MAX);
  sending = true;
  try {
    // Plain fetch: apiFetch reports nothing, but keep this path independent
    // of every other wrapper so a broken loader can't silence the reporter.
    await fetch('/api/client-errors', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors }),
    });
  } catch {
    /* backend down or restarting: drop the batch */
  } finally {
    sending = false;
    if (queue.length) timer = setTimeout(flush, FLUSH_MS);
  }
}

export function reportError(source, message, detail) {
  try {
    if (queue.length >= QUEUE_MAX * 2) queue.shift();
    queue.push({ source: String(source || 'web'), message: String(message).slice(0, 2000), detail });
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  } catch {
    /* never throw from the reporter */
  }
}

export function installErrorReporter() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const originalError = console.error.bind(console);
  console.error = (...args) => {
    reportError('console', text(args), stackOf(args));
    originalError(...args);
  };
  window.addEventListener('error', (e) => {
    reportError('window', `${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
      e.error?.stack ? String(e.error.stack).slice(0, 4000) : undefined);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    reportError('promise', r?.message || String(r), r?.stack ? String(r.stack).slice(0, 4000) : undefined);
  });
}
