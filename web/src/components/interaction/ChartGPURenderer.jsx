import { useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

let ChartGPUComponent = null;
let loadPromise = null;

function loadChartGPU() {
  if (!loadPromise) {
    loadPromise = import('chartgpu-react').then((mod) => {
      ChartGPUComponent = mod.ChartGPU || mod.default;
      return ChartGPUComponent;
    });
  }
  return loadPromise;
}

/**
 * ChartGPURenderer — WebGPU-accelerated chart renderer.
 * Automatically adapts to the active MUI theme (dark/light).
 *
 * Props:
 *   spec: { series, xAxis, yAxis, title?, ... } — ChartGPU options shape
 *   width: container width
 *   height: container height
 *   onReady: optional callback when chart initializes
 */
export default function ChartGPURenderer({ spec, width = 500, height = 380, onReady }) {
  const chartRef = useRef(null);
  const containerRef = useRef(null);
  const loadedRef = useRef(false);
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const chartTheme = theme.custom?.chart ?? {};

  // Lazy-load on first render
  if (!loadedRef.current && !ChartGPUComponent) {
    loadChartGPU().then(() => {
      loadedRef.current = true;
      containerRef.current?.dispatchEvent(new Event('chartgpu-loaded'));
    });
  }

  const handleReady = useCallback(() => {
    onReady?.(chartRef.current);
  }, [onReady]);

  if (!spec) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ p: 1 }}>
        No ChartGPU spec available
      </Typography>
    );
  }

  const gridOpacity = isDark ? 0.08 : 0.12;
  const gridColor = isDark ? '#ffffff' : '#000000';

  const options = {
    ...spec,
    width,
    height,
    gridLines: spec.gridLines ?? {
      show: true,
      color: gridColor,
      opacity: gridOpacity,
      horizontal: { show: true },
      vertical: { show: true },
    },
    tooltip: spec.tooltip ?? { show: true },
    ...(spec.autoScroll != null ? { autoScroll: spec.autoScroll } : {}),
  };

  // Build a custom theme config from the MUI theme
  const gpuTheme = isDark
    ? 'dark'
    : {
        backgroundColor: 'transparent',
        textColor: '#333',
        axisLineColor: '#ccc',
        axisTickColor: '#666',
        gridLineColor: 'rgba(0,0,0,0.08)',
        fontFamily: 'system-ui',
        fontSize: 12,
      };

  if (!ChartGPUComponent) {
    return (
      <Box
        ref={containerRef}
        sx={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary',
          fontSize: 13,
        }}
      >
        Loading ChartGPU...
      </Box>
    );
  }

  return (
    <ChartGPUComponent
      ref={chartRef}
      options={options}
      theme={gpuTheme}
      width={width}
      height={height}
      onReady={handleReady}
    />
  );
}

/**
 * Convert a simplified chart spec (similar to what AI generates) into
 * ChartGPU's options format.
 */
export function convertToChartGPUSpec(simpleSpec) {
  const { chart_type, x_column, y_column, color_column, title, rows } = simpleSpec;
  if (!rows?.length) return null;

  const series = [];

  if (color_column) {
    const groups = {};
    for (const row of rows) {
      const key = String(row[color_column] ?? '');
      if (!groups[key]) groups[key] = { x: [], y: [] };
      groups[key].x.push(row[x_column]);
      groups[key].y.push(row[y_column]);
    }
    for (const [name, { x, y }] of Object.entries(groups)) {
      series.push({
        type: chart_type === 'bar' ? 'bar' : 'line',
        name,
        data: { x, y },
        ...(chart_type === 'area' ? { areaStyle: { opacity: 0.5 } } : {}),
      });
    }
  } else {
    const x = rows.map((r) => r[x_column]);
    const y = rows.map((r) => r[y_column]);
    series.push({
      type: chart_type === 'bar' ? 'bar' : 'line',
      data: { x, y },
      ...(chart_type === 'area' ? { areaStyle: { opacity: 0.5 } } : {}),
      ...(chart_type === 'scatter' ? { type: 'scatter' } : {}),
    });
  }

  return {
    series,
    xAxis: { type: 'category', name: x_column },
    yAxis: { type: 'value', name: y_column },
    ...(title ? { title: { text: title } } : {}),
  };
}
