import { useRef, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import ChartGPURenderer from './ChartGPURenderer.jsx';
import VegaLiteRenderer from './VegaLiteRenderer.jsx';
import PlotlyChart, { buildThemedPlotlyLayout, unhideTickLabels } from './PlotlyChart.jsx';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';
import { tagChartDraw } from '../../lib/chartDebug.js';

/**
 * ChartRenderer — routing component that picks the right renderer based on format.
 * All sub-renderers inherit the active MUI theme automatically.
 *
 * Props:
 *   format: 'chartgpu' | 'vega-lite' | 'plotly' (default: 'plotly')
 *   spec: the chart spec in the appropriate format
 *   plotlySpec: { data, layout } for Plotly charts (used when format is 'plotly')
 *   width: container width
 *   height: container height
 *   webgpu: boolean — whether WebGPU is available
 *   chartSpec: passed to PlotlyChart for extension charts
 *   data: row data passed to PlotlyChart for extension charts
 */
export default function ChartRenderer({
  format = 'plotly',
  spec,
  plotlySpec,
  width = 480,
  height = 340,
  webgpu = false,
  chartSpec,
  data,
}) {
  switch (format) {
    case 'chartgpu':
      if (!webgpu) {
        if (spec?.$schema || spec?.mark) {
          return <VegaLiteRenderer spec={spec} width={width} height={height} />;
        }
        if (plotlySpec) {
          return <PlotlyInline plotlySpec={plotlySpec} width={width} height={height} />;
        }
        return (
          <Typography variant="caption" color="text.secondary" sx={{ p: 1 }}>
            WebGPU not available
          </Typography>
        );
      }
      return <ChartGPURenderer spec={spec} width={width} height={height} />;

    case 'vega-lite':
      return <VegaLiteRenderer spec={spec} width={width} height={height} />;

    case 'plotly':
    default:
      if (plotlySpec) {
        return <PlotlyInline plotlySpec={plotlySpec} width={width} height={height} />;
      }
      if (data || chartSpec) {
        return <PlotlyChart data={data} chartSpec={chartSpec || { width, height }} />;
      }
      return (
        <Typography variant="caption" color="text.secondary" sx={{ p: 1 }}>
          No chart data available
        </Typography>
      );
  }
}

/**
 * PlotlyInline — renders a pre-built { data, layout } Plotly spec.
 * Applies theme-appropriate background and font colors from MUI theme.
 */
export function PlotlyInline({ plotlySpec, width, height }) {
  const chartRef = useRef(null);
  const [error, setError] = useState(null);
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { scale: displayScale } = useDisplayScale();

  useEffect(() => {
    if (!chartRef.current || !plotlySpec) return;
    let cancelled = false;
    import('plotly.js-basic-dist-min').then((mod) => {
      if (cancelled || !chartRef.current) return;
      const Plotly = mod.default || mod;

      // Same chrome as PlotlyChart (extension charts) so pre-built AI specs
      // render identically: legend below, unified hover, tight margins, no
      // drag-zoom. width/height pin to the resizable container. displayScale
      // lets the shared helper add ticks for the zoomed (wall) size. Under
      // body{zoom} (displayScale !== 1) responsive autosize measures the
      // container in zoomed/fractional px and automargin loops ("Too many
      // auto-margin redraws") — pin autosize off and let the explicit
      // integer width/height from ResizableChartContainer rule, exactly like
      // PlotlyChart's explicit-size path.
      const useExplicitSize = displayScale !== 1;
      const themedLayout = {
        ...buildThemedPlotlyLayout(plotlySpec.layout, {
          isDark, displayScale, width, height,
          traceCount: (plotlySpec.data || []).length,
          traces: plotlySpec.data,
          bgColor: theme.palette.background.paper,
          // Without this the generated charts fell back to Plotly's stock
          // typeface while every extension chart used the app font — the
          // single loudest reason the two looked like different plotting
          // libraries side by side.
          fontFamily: theme.typography?.fontFamily,
          textColor: theme.palette.text.primary,
          borderColor: theme.palette.divider,
        }),
        width,
        height,
        ...(useExplicitSize ? { autosize: false } : {}),
      };

      tagChartDraw(chartRef.current, 'PlotlyInline', {
        displayScale, w: width, h: height, explicit: useExplicitSize,
      });
      Plotly.react(chartRef.current, plotlySpec.data, themedLayout, {
        responsive: !useExplicitSize,
        displayModeBar: false,
        scrollZoom: false,
        doubleClick: false,
      }).then(() => unhideTickLabels(chartRef.current, displayScale))
        .catch((err) => setError(err.message));
    }).catch((err) => setError(`Failed to load Plotly: ${err.message}`));
    return () => { cancelled = true; };
  }, [plotlySpec, width, height, isDark, displayScale]);

  if (error) {
    return (
      <Typography variant="caption" color="error" sx={{ p: 1 }}>
        Chart error: {error}
      </Typography>
    );
  }

  return <Box ref={chartRef} sx={{ width, height }} />;
}
