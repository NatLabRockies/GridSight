/**
 * logger.js – unified client-side logging
 *
 * Every log call:
 *   1. Always writes to the browser console (survives even if the relay fails)
 *   2. In development, relays the message to the Bun server so it appears in
 *      the terminal alongside Python server logs.
 *
 * Log level is controlled by the VITE_LOG_LEVEL env var:
 *   debug | info | warn | error   (default: debug in dev, warn in prod)
 *
 * Usage:
 *   import { logger } from '@lib/logger';
 *   logger.debug('fetchPaintings result', data);
 *   logger.info('Layer mounted', layerId);
 *   logger.warn('Missing join key', layerId);
 *   logger.error('Failed to save painting', err);
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const IS_DEV = import.meta.env.DEV;
const configuredLevel = import.meta.env.VITE_LOG_LEVEL ?? (IS_DEV ? 'debug' : 'warn');
const MIN_LEVEL = LEVELS[configuredLevel] ?? (IS_DEV ? 0 : 2);

function serialize(arg) {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }
  return String(arg);
}

function relay(level, message) {
  // Fire-and-forget. Never throw — logging must never break the app.
  fetch('/api/logs/client', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, ts: new Date().toISOString() }),
  }).catch(() => {});
}

const CONSOLE_FNS = {
  debug: console.debug.bind(console),
  info:  console.info.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
};

function makeLogger(level) {
  const num = LEVELS[level];
  const consoleFn = CONSOLE_FNS[level];
  return (...args) => {
    if (num < MIN_LEVEL) return;
    // Browser console always fires first — relay failure is non-fatal.
    consoleFn('[web]', ...args);
    if (IS_DEV) {
      relay(level, args.map(serialize).join(' '));
    }
  };
}

export const logger = {
  debug: makeLogger('debug'),
  info:  makeLogger('info'),
  warn:  makeLogger('warn'),
  error: makeLogger('error'),
};
