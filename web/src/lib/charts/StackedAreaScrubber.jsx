import { lazy, Suspense } from 'react';
import useGpuPreference from '../../hooks/useGpuPreference.js';

/**
 * StackedAreaScrubber — chooser between the Plotly default and the
 * deprecated ChartGPU implementation. The decision uses useGpuPreference
 * directly (Settings → "Experimental: WebGPU charts"). Callers can also
 * pass `webgpu` explicitly to override.
 */
const Plotly = lazy(() => import('./StackedAreaScrubberPlotly.jsx'));
const Gpu = lazy(() => import('./StackedAreaScrubberGPU.jsx'));

export default function StackedAreaScrubber(props) {
  const gpu = useGpuPreference();
  const useGpu = props.webgpu !== undefined ? !!props.webgpu : gpu.active;
  const Impl = useGpu ? Gpu : Plotly;
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}
