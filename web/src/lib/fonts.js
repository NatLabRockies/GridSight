/**
 * GridSight UI font options.
 *
 * Every stack resolves from fonts already present on the host — nothing is
 * fetched from a CDN. That is deliberate: GridSight ships to air-gapped and
 * kiosk deployments (the display wall, k8s) where a webfont request would
 * either fail or hang the first paint, and the published-artifact CSP blocks
 * external hosts outright. Each entry ends in a generic family so an unusual
 * host still lands somewhere sane.
 *
 * `system` is the default: it resolves to the platform's own UI face (SF Pro on
 * macOS, Segoe UI on Windows), which is what the surrounding OS chrome uses and
 * is hinted for small sizes — the right baseline for a dense dashboard.
 */

const SYSTEM_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, '
  + 'Cantarell, "Open Sans", "Helvetica Neue", sans-serif';

export const FONTS = {
  system: {
    id: 'system',
    label: 'System',
    hint: 'Native UI face — matches the OS',
    stack: SYSTEM_STACK,
  },
  helvetica: {
    id: 'helvetica',
    label: 'Helvetica Neue',
    hint: 'Neutral grotesque',
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  avenir: {
    id: 'avenir',
    label: 'Avenir Next',
    hint: 'Geometric, wider counters',
    stack: '"Avenir Next", Avenir, "Segoe UI", ' + SYSTEM_STACK,
  },
  plex: {
    id: 'plex',
    label: 'IBM Plex Sans',
    hint: 'Technical; falls back to system if not installed',
    stack: '"IBM Plex Sans", "Segoe UI", ' + SYSTEM_STACK,
  },
  mono: {
    id: 'mono',
    label: 'Monospace',
    hint: 'Fixed width — figures line up in tables',
    stack: '"SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
};

export const FONT_IDS = Object.keys(FONTS);
export const DEFAULT_FONT = 'system';

/** Resolve a font id to its CSS stack, falling back to the default. */
export function fontStack(id) {
  return (FONTS[id] ?? FONTS[DEFAULT_FONT]).stack;
}
