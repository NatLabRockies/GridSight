// Built-in colormaps (sampled at 11 stops, 0.0–1.0).
// Shared across layer_generators.js and any custom layer (e.g. TransmissionLayer)
// so the same set of named colormaps is available everywhere.

export const COLORMAPS = {
  viridis: [
    [68,1,84],[72,40,120],[62,74,137],[49,104,142],[38,130,142],
    [31,158,137],[53,183,121],[109,205,89],[180,222,44],[253,231,37],[253,231,37],
  ],
  plasma: [
    [13,8,135],[75,3,161],[125,3,168],[168,34,150],[203,70,121],
    [229,107,93],[248,148,65],[253,195,40],[240,249,33],[240,249,33],[240,249,33],
  ],
  coolwarm: [
    [59,76,192],[90,113,228],[134,156,249],[181,197,254],[214,220,255],
    [255,255,255],[255,220,198],[249,168,130],[228,111,84],[192,59,59],[192,59,59],
  ],
  rdylgn: [
    [165,0,38],[215,48,39],[244,109,67],[253,174,97],[254,224,139],
    [255,255,191],[217,239,139],[166,217,106],[102,189,99],[26,152,80],[0,104,55],
  ],
  loading: [
    [46,125,50],[76,175,80],[139,195,74],[255,235,59],[255,152,0],[244,67,54],[183,28,28],
  ],
};

/**
 * Sample a named colormap at value t ∈ [0, 1].
 * Returns an [r, g, b, a] tuple.
 */
export function sampleColormap(name, t, alpha = 220) {
  const stops = COLORMAPS[name] ?? COLORMAPS.viridis;
  const clamped = Math.max(0, Math.min(1, t));
  const idx = clamped * (stops.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, stops.length - 1);
  const frac = idx - lo;
  const c = stops[lo].map((v, i) => Math.round(v + frac * (stops[hi][i] - v)));
  return [...c, alpha];
}

/**
 * Normalise a raw value to [0, 1] given domain and scale type.
 */
export function normalise(value, domainMin, domainMax, scaleType = 'linear') {
  if (domainMin === domainMax) return 0.5;
  if (scaleType === 'log') {
    const lo = Math.log(Math.max(domainMin, 1e-10));
    const hi = Math.log(Math.max(domainMax, 1e-10));
    const v = Math.log(Math.max(value, 1e-10));
    return (v - lo) / (hi - lo);
  }
  return (value - domainMin) / (domainMax - domainMin);
}
