/**
 * chartRegistry.js
 *
 * Maps chart_type strings from extension ChartSpec to React component loaders.
 * Components are lazy-loaded to minimize initial bundle size.
 */

import { lazy } from 'react';

const PlotlyChart = lazy(() => import('../components/interaction/PlotlyChart.jsx'));
const LineBarRouter = lazy(() => import('../components/charts/LineBarRouter.jsx'));
const StackedAreaScrubber = lazy(() => import('./charts/StackedAreaScrubber.jsx'));
const LineScrubber = lazy(() => import('./charts/LineScrubber.jsx'));

/**
 * Chart type to component mapping.
 *
 * Each entry maps a chart_type string (from ChartSpec.chart_type) to a lazy React component.
 * "scrubber-*" types are scenario-scoped charts that bind bidirectionally to
 * the animation clock. Their components must accept `clockState` + `onScrub`
 * props in addition to the standard `data` + `chartOptions`.
 */
const CHART_COMPONENTS = {
  bar: LineBarRouter,
  line: LineBarRouter,
  scatter: LineBarRouter,
  plotly: PlotlyChart, // raw plotly_options escape hatch — keep on Plotly
  'scrubber-stacked-area': StackedAreaScrubber,
  'scrubber-line': LineScrubber,
  'scrubber-multi-line': LineScrubber,
};

/**
 * Get the React component for a given chart type.
 *
 * @param {string} chartType - e.g. "bar", "line", "scatter", "plotly"
 * @returns {React.LazyExoticComponent|null}
 */
export function getChartComponent(chartType) {
  return CHART_COMPONENTS[chartType] || null;
}

/**
 * Check if a chart type is supported.
 */
export function isChartTypeSupported(chartType) {
  return chartType in CHART_COMPONENTS;
}
