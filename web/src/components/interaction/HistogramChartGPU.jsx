import React, { useMemo, useEffect, useState, useRef } from 'react';
import { useTheme } from '@mui/material/styles';
import { computeHistogram } from '../../lib/entityTimeseries.js';

/**
 * @deprecated WebGPU requires a secure context which our deployment can't
 * provide. Prefer HistogramChartPlotly. Kept for opt-in / local dev, gated
 * by the experimental WebGPU charts toggle in Settings.
 *
 * HistogramChartGPU — distribution of an entity's timeseries values.
 * Uses ChartGPU bar chart for GPU-accelerated rendering.
 * Adapts to the active MUI theme (dark/light) and primary color.
 *
 * @param {{
 *   timeseries: { timestamps: Date[], values: number[] },
 *   clockState: object,
 *   mode: 'full'|'rolling',
 *   windowSize: number,
 * }} props
 */
export default function HistogramChartGPU({ timeseries, clockState, mode = 'full', windowSize = 168, width: containerWidth, height: containerHeight }) {
  const [ChartGPUComponent, setChartGPUComponent] = useState(null);
  const gpuRef = useRef(null);
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const primaryColor = theme.palette.primary.main;

  useEffect(() => {
    console.info('[HistogramChartGPU] ChartGPU path is deprecated; enabled via user preference.');
    import('chartgpu-react').then((mod) => {
      setChartGPUComponent(() => mod.ChartGPU || mod.default);
    }).catch((err) => {
      console.warn('[HistogramChartGPU] failed to load chartgpu-react:', err);
    });
  }, []);

  const { edges, counts } = useMemo(() => {
    if (mode === 'rolling') {
      const start = Math.max(0, clockState.index - windowSize);
      const end = Math.min(timeseries.values.length, clockState.index + 1);
      return computeHistogram(timeseries.values.slice(start, end), 30);
    }
    return computeHistogram(timeseries.values, 50);
  }, [timeseries, clockState.index, mode, windowSize]);

  if (!edges.length) {
    return <div style={{ color: '#888', fontSize: 12, padding: 8 }}>No data for histogram</div>;
  }

  if (!ChartGPUComponent) {
    return <div style={{ height: containerHeight || 180, width: containerWidth || '100%', color: '#888', fontSize: 12 }}>Loading chart...</div>;
  }

  const labels = edges.slice(0, -1).map((e, i) =>
    `${e.toFixed(1)}–${edges[i + 1].toFixed(1)}`,
  );

  const options = {
    series: [
      {
        type: 'bar',
        data: { x: labels, y: counts },
        color: primaryColor,
      },
    ],
    xAxis: {
      type: 'category',
      name: 'Value',
      axisLabel: {
        formatter: (val) => {
          const idx = labels.indexOf(val);
          if (idx < 0) return '';
          const step = Math.max(1, Math.floor(labels.length / 8));
          return idx % step === 0 ? val : '';
        },
      },
    },
    yAxis: {
      type: 'value',
      name: 'Count',
    },
    tooltip: { show: true },
    gridLines: {
      show: true,
      color: isDark ? '#ffffff' : '#000000',
      opacity: isDark ? 0.05 : 0.08,
      horizontal: { show: true },
      vertical: { show: false },
    },
    legend: { show: false },
  };

  const w = containerWidth || '100%';
  const h = containerHeight || 180;

  return (
    <div style={{ height: h, width: w }}>
      <ChartGPUComponent
        ref={gpuRef}
        options={options}
        theme={isDark ? 'dark' : 'light'}
        width={w}
        height={h}
      />
    </div>
  );
}
