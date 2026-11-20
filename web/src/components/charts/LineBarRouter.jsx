import { lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import useGpuPreference from '../../hooks/useGpuPreference.js';

const PlotlyChart = lazy(() => import('../interaction/PlotlyChart.jsx'));
const ChartGPUChart = lazy(() => import('./ChartGPUChart.jsx'));

/**
 * LineBarRouter — picks the renderer for line/bar/scatter chart specs.
 *
 * Follows the WebGPU preference (Developer Settings → "WebGPU charts"), the
 * same way the scrubber routers do: ChartGPU when WebGPU is available AND
 * enabled, Plotly otherwise. ChartGPU sidesteps Plotly's DOM-measured
 * tick/margin heuristics that misbehave under the wall's body{zoom} display
 * scale — the reason to pivot back to it on a WebGPU-capable (secure-context)
 * deployment. Plotly stays the default wherever WebGPU is off/unsupported.
 *
 * EXCEPTION — year-axis charts (SEDS / Demand100 forecasts, x = integer years)
 * stay on Plotly even when WebGPU is on: @chartgpu/chartgpu@0.2.9 can't format
 * year-only tick labels (its time axis hardcodes "YYYY/MM" and AxisConfig
 * exposes no formatter or tick-position control), so Plotly's clean year ticks
 * win for those. Everything else follows the WebGPU preference.
 *
 * EXCEPTION — horizontal bars (orientation: 'h', e.g. the "Top N" ranked-bar
 * charts) also stay on Plotly: ChartGPU v0.2.9 has no horizontal-bar layout, so
 * it renders them vertically with the category on the x-axis AND mislabels the
 * axes (the spec's Plotly-oriented xaxis/yaxis titles land on the wrong axes),
 * which is why their unit labels went missing. Plotly honors orientation and
 * the axis titles, so ranked bars belong there.
 *
 * A spec can still force a renderer regardless of the above via
 *   chart_options.renderer = "gpu" | "plotly"
 * and `props.webgpu` overrides for callers that already resolved it.
 *
 * Both implementations share the same prop signature
 * (data, chartSpec, onPointClick, fillParent, hiddenCategories)
 * so the choice is transparent to ScenarioChartBody.
 */
function isHorizontalBar(props) {
  return props.chartSpec?.chart_type === 'bar'
    && props.chartSpec?.chart_options?.orientation === 'h';
}

function isYearAxisSpec(props) {
  const xCol = props.chartSpec?.chart_options?.time_axis;
  if (!xCol) return false;
  if (/year/i.test(xCol)) return true; // works before data has loaded
  const data = props.data;
  if (!Array.isArray(data) || !data.length) return false;
  return data.every((r) => {
    const v = r[xCol];
    return typeof v === 'number' && Number.isInteger(v) && v >= 1800 && v <= 2200;
  });
}

export default function LineBarRouter(props) {
  const gpu = useGpuPreference();
  const pin = props.chartSpec?.chart_options?.renderer;
  const useGpu = pin === 'gpu' ? true
    : pin === 'plotly' ? false
    : isYearAxisSpec(props) ? false          // year charts → Plotly (clean year ticks)
    : isHorizontalBar(props) ? false         // ranked h-bars → Plotly (orientation + axis titles)
    : (props.webgpu !== undefined ? !!props.webgpu : gpu.active);
  const Component = useGpu ? ChartGPUChart : PlotlyChart;
  return (
    <Suspense fallback={
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    }>
      <Component {...props} />
    </Suspense>
  );
}
