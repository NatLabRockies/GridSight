/**
 * GPU draw parameters for 2-D map overlays.
 *
 * deck.gl 9 / luma.gl 9 use WebGPU-style parameter names. The old WebGL
 * name `depthTest: false` is silently ignored, so in interleaved MapLibre
 * mode layers kept the overlay default (depthCompare: 'less-equal'). Paths
 * carry a per-vertex z (the path fraction used for the flow gradient), so
 * where two lines overlap the depth test picked a different winner pixel by
 * pixel along the segment: the "switching" stripes on shared corridors.
 *
 * NO_DEPTH turns the depth test and depth writes off. Overlapping features
 * then draw in data order and blend with alpha, the same in every frame.
 */
export const NO_DEPTH = Object.freeze({
  depthCompare: 'always',
  depthWriteEnabled: false,
});
