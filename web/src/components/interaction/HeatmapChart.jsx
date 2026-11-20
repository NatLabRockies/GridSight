import React, { useMemo } from 'react';
import VegaLiteRenderer from './VegaLiteRenderer.jsx';
import { reshapeToHeatmap, timeBinCount, timeBinLabel } from '../../lib/entityTimeseries.js';

/**
 * HeatmapChart — day-of-year × time-bin heatmap for a single entity.
 * Uses Vega-Lite rect mark with viridis color scale.
 *
 * @param {{
 *   timeseries: { timestamps: Date[], values: number[] },
 *   binMode: 'hour'|'minute'|'4hour'|'15min',
 * }} props
 */
export default function HeatmapChart({ timeseries, binMode = 'hour', width: containerWidth, height: containerHeight }) {
  const { data: heatData, vMin, vMax } = useMemo(
    () => reshapeToHeatmap(timeseries.timestamps, timeseries.values, binMode),
    [timeseries, binMode],
  );

  const yBins = timeBinCount(binMode);

  if (!heatData.length) {
    return <div style={{ color: '#888', fontSize: 12, padding: 8 }}>No heatmap data available</div>;
  }

  // Add human-readable time label to each data point for tooltips
  const values = heatData.map((d) => ({
    day: d.x,
    timeBin: d.y,
    timeLabel: timeBinLabel(d.y, binMode),
    value: Math.round(d.v * 100) / 100,
  }));

  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { values },
    mark: { type: 'rect' },
    encoding: {
      x: {
        field: 'day',
        type: 'quantitative',
        scale: { domain: [1, 366] },
        axis: { title: 'Day of Year', tickCount: 12, labelFontSize: 9 },
      },
      y: {
        field: 'timeBin',
        type: 'quantitative',
        scale: { domain: [0, yBins - 1] },
        axis: {
          title: 'Time',
          labelFontSize: 9,
          labelExpr: binMode === 'hour'
            ? "format(datum.value, '02') + ':00'"
            : binMode === '4hour'
              ? "format(datum.value * 4, '02') + ':00'"
              : null,
        },
      },
      color: {
        field: 'value',
        type: 'quantitative',
        scale: {
          scheme: 'viridis',
          domain: [vMin, vMax],
        },
        legend: { title: 'Value', labelFontSize: 9 },
      },
      tooltip: [
        { field: 'day', type: 'quantitative', title: 'Day of Year' },
        { field: 'timeLabel', type: 'nominal', title: 'Time' },
        { field: 'value', type: 'quantitative', title: 'Value' },
      ],
    },
    width: (containerWidth || 480) - 60,
    height: (containerHeight || 200) - 20,
  };

  return (
    <div style={{ width: containerWidth || '100%' }}>
      <VegaLiteRenderer spec={spec} width={containerWidth || 480} height={containerHeight || 200} />
    </div>
  );
}
