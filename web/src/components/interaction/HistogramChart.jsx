import { lazy, Suspense } from 'react';
import useGpuPreference from '../../hooks/useGpuPreference.js';

/**
 * HistogramChart — chooser between the Plotly default and the deprecated
 * ChartGPU implementation. See StackedAreaScrubber.jsx for details.
 */
const Plotly = lazy(() => import('./HistogramChartPlotly.jsx'));
const Gpu = lazy(() => import('./HistogramChartGPU.jsx'));

export default function HistogramChart(props) {
  const gpu = useGpuPreference();
  const useGpu = props.webgpu !== undefined ? !!props.webgpu : gpu.active;
  const Impl = useGpu ? Gpu : Plotly;
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}
