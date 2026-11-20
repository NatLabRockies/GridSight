/**
 * chartDebug — diagnostics for the Plotly auto-margin/zoom sizing bugs.
 *
 * Plotly's "WARN: Too many auto-margin redraws." goes through console.log with
 * no element context, which makes the wall/display-scale sizing bugs miserable
 * to attribute. This module:
 *
 *   1. lets every Plotly draw site tag its DOM node with WHO drew it and the
 *      exact sizing parameters it used (tagChartDraw), and
 *   2. hooks console.log so that when the warning fires, one enriched line is
 *      emitted (throttled per burst) listing every mounted plot: component,
 *      container vs figure size, margins, responsive/explicit mode, zoom.
 *
 * The dump line is prefixed [chartDebug] — when reporting a repro, copy that
 * line; it identifies the culprit component and the sizes it saw.
 *
 * Always installed (the hook is a cheap string test per console.log call and
 * the dump is throttled to one per 2s burst).
 */

const state = { installed: false, count: 0, lastDump: 0 };

/** Tag a plotly node with the component + parameters of its latest draw. */
export function tagChartDraw(node, source, info) {
  if (!node) return;
  try {
    node.dataset.chartSource = source;
    node.__gridsightDraw = { ...info, at: new Date().toISOString() };
  } catch { /* noop */ }
}

function dumpPlots(reason) {
  const plots = [...document.querySelectorAll('.js-plotly-plot')].map((p) => {
    const fl = p._fullLayout || {};
    const d = p.__gridsightDraw || null;
    return {
      source: p.dataset.chartSource || 'UNTAGGED',
      client: `${p.clientWidth}x${p.clientHeight}`,
      figure: `${fl.width}x${fl.height}`,
      margin: fl.margin ? `l${fl.margin.l} r${fl.margin.r} t${fl.margin.t} b${fl.margin.b}` : '?',
      draw: d,
    };
  });
  // Compact per-plot summary inlined into the message so a plain copy-paste
  // of the single line carries everything (the structured array is attached
  // too, for expanding in DevTools).
  const summary = plots.map((p) => {
    const d = p.draw || {};
    return `${p.source}[client=${p.client} fig=${p.figure} margin=${p.margin}`
      + ` drawn(scale=${d.displayScale ?? '?'} ${d.w ?? '?'}x${d.h ?? '?'}`
      + ` explicit=${String(d.explicit ?? '?')})]`;
  }).join(' ');
  // console.warn so it stands out from Plotly's console.log spam (and isn't
  // re-captured by our own console.log hook).
  console.warn(
    `[chartDebug] ${reason} — body.zoom=${document.body.style.zoom || '1'}`
    + ` inner=${window.innerWidth}x${window.innerHeight}`
    + ` dpr=${window.devicePixelRatio}`
    + (summary ? ` :: ${summary}` : ' :: (no plots mounted)'),
    plots,
  );
}

/** Install the console hooks once (idempotent). Call at app boot. */
export function installChartDebug() {
  if (state.installed || typeof window === 'undefined') return;
  state.installed = true;
  // plotly.js's Lib.warn emits via console.TRACE when available — as
  // `console.trace('WARN:', 'Too many auto-margin redraws.')` (message split
  // across arguments) — falling back to console.log otherwise. Hook both and
  // match against the JOINED args, not just args[0].
  const hook = (method) => {
    const orig = console[method]?.bind(console);
    if (!orig) return;
    console[method] = (...args) => {
      orig(...args);
      try {
        const joined = args.map((a) => String(a)).join(' ');
        if (!/auto-margin redraws/i.test(joined)) return;
        state.count += 1;
        const now = Date.now();
        if (now - state.lastDump < 2000) return; // one dump per warning burst
        state.lastDump = now;
        dumpPlots(`auto-margin redraw loop (warning #${state.count} this session)`);
      } catch { /* diagnostics must never break the app */ }
    };
  };
  hook('trace');
  hook('log');
}
