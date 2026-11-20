import { lazy, Suspense } from 'react';
import useGpuPreference from '../../hooks/useGpuPreference.js';

/**
 * LineScrubber — chooser between the Plotly default and the deprecated
 * ChartGPU implementation. See StackedAreaScrubber.jsx for details.
 */
const Plotly = lazy(() => import('./LineScrubberPlotly.jsx'));
const Gpu = lazy(() => import('./LineScrubberGPU.jsx'));

export default function LineScrubber(props) {
  const gpu = useGpuPreference();
  const useGpu = props.webgpu !== undefined ? !!props.webgpu : gpu.active;
  const Impl = useGpu ? Gpu : Plotly;
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}
