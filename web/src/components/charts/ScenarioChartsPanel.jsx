/**
 * ScenarioChartsPanel — one ChartFrame containing N extension scenario
 * charts stacked vertically, sharing one toolbar (displayMode, windowSize,
 * unit, stackOrder).
 *
 * A "combine" menu in the frame header lets the user merge other open
 * scenario charts into this frame. A per-body split button extracts one
 * chart back into its own frame. The shared x-axis (time) + shared toolbar
 * make it easy to eyeball correlations between generation, load,
 * curtailment, transmission loading, etc.
 */

import { useEffect, useMemo, useState } from 'react';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Slider from '@mui/material/Slider';
import Tooltip from '@mui/material/Tooltip';

import { ANCHOR_MODE, makeExtScenarioDescriptor } from '../../lib/chartDescriptor.js';
import ChartFrame from './ChartFrame.jsx';
import ScenarioChartBody from './ScenarioChartBody.jsx';
import { fetchExtensionCharts } from '../../lib/loaders.js';
import { resolveEntityName } from '../../lib/entityName.js';

export default function ScenarioChartsPanel({
  charts,                  // Array<{ extName, spec }>  (len >= 1)
  project,
  scenario,
  clockState,
  updateClockState,
  onClose,
  anchorMode = ANCHOR_MODE.FLOATING,
  onAnchorModeChange,
  // Combine/split plumbing — supplied by App.jsx
  frameKey,                // App-level entry key; used as drag-to-combine payload
  combineCandidates,       // Array<{ key, title }>  — other open entries
  onCombine,               // (sourceKey) => void — merge that entry into this frame
  onSplit,                 // (chartIndex) => void — extract chart at index into own frame
  onTransfer,              // (targetTabId, mode) => void — cross-window send
  mirrored = false,        // forwarded to ChartFrame
  onMirrorToggle,          // forwarded to ChartFrame
  initialPos = { x: 320, y: 140 },
  geom,                    // synced viewport-fraction geometry → ChartFrame
  onGeomChange,            // (frac) => void on drag/resize/pinch end
  refreshKey = 0,          // input-control refresh → re-fetch spec + data
}) {
  // Shared toolbar state (applies to every body in the frame)
  const [displayMode, setDisplayMode] = useState('full'); // 'full' | 'rolling'
  const [windowSize, setWindowSize] = useState(24);
  const [unit, setUnit] = useState('GW');                  // 'MW' | 'GW' | 'TW'
  const [stackOrder, setStackOrder] = useState('display'); // 'total' | 'display' | 'variance'

  // Determine which toolbar controls to show based on the union of chart
  // capabilities. A toolbar control appears if AT LEAST ONE chart benefits
  // from it — charts that don't care just ignore it.
  const toolbarCaps = useMemo(() => {
    const caps = { scrubber: false, unit: false, stack: false };
    for (const { spec } of charts) {
      const opts = spec.chart_options || {};
      const isScrubber = String(spec.chart_type || '').startsWith('scrubber-');
      const vu = opts.value_unit;
      const unitApplies = !vu || ['MW', 'GW', 'TW'].includes(vu);
      const hasCategory = !!opts.category_axis;
      if (isScrubber) caps.scrubber = true;
      if (unitApplies) caps.unit = true;
      if (hasCategory) caps.stack = true;
    }
    return caps;
  }, [charts]);

  const handleScrub = (newIndex) => {
    if (!updateClockState) return;
    updateClockState((prev) => ({ ...prev, index: newIndex, animate: false }));
  };

  const multi = charts.length > 1;

  // ── Shared toolbar (headerExtras) ───────────────────────────────────────
  const headerExtras = toolbarCaps.scrubber ? (
    <Stack
      direction="column"
      alignItems="flex-start"
      spacing={1}
      // Rendered inside ChartFrame's options popover, so lay the groups out
      // vertically rather than as an inline header row. Nothing here competes
      // with the title for width any more.
      sx={{ minWidth: 0 }}
    >
      {/* Time-window mode */}
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="caption" sx={{ opacity: 0.7, fontSize: 10, fontWeight: 600 }}>
          Window
        </Typography>
        <Tooltip title="Show full data range">
          <Chip
            label="Full"
            size="small"
            color={displayMode === 'full' ? 'primary' : 'default'}
            variant={displayMode === 'full' ? 'filled' : 'outlined'}
            onClick={() => setDisplayMode('full')}
            sx={{ height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
          />
        </Tooltip>
        <Tooltip title="Rolling window centered on the playhead">
          <Chip
            label="Rolling"
            size="small"
            color={displayMode === 'rolling' ? 'primary' : 'default'}
            variant={displayMode === 'rolling' ? 'filled' : 'outlined'}
            onClick={() => setDisplayMode('rolling')}
            sx={{ height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
          />
        </Tooltip>
      </Stack>

      {toolbarCaps.unit && (
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Typography variant="caption" sx={{ opacity: 0.7, fontSize: 10, fontWeight: 600 }}>
            Unit
          </Typography>
          {['MW', 'GW', 'TW'].map((u) => (
            <Tooltip key={u} title={`Display power in ${u}`}>
              <Chip
                label={u}
                size="small"
                color={unit === u ? 'secondary' : 'default'}
                variant={unit === u ? 'filled' : 'outlined'}
                onClick={() => setUnit(u)}
                sx={{ height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
              />
            </Tooltip>
          ))}
        </Stack>
      )}

      {toolbarCaps.stack && (
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Typography variant="caption" sx={{ opacity: 0.7, fontSize: 10, fontWeight: 600 }}>
            Stack
          </Typography>
          {[
            ['total', 'Tot', 'Stack largest contributor at the bottom'],
            ['display', 'Disp', "Stack in extension's canonical display order"],
            ['variance', 'Var', 'Low-variance at bottom, high-variance at top'],
          ].map(([val, label, tip]) => (
            <Tooltip key={val} title={tip}>
              <Chip
                label={label}
                size="small"
                color={stackOrder === val ? 'info' : 'default'}
                variant={stackOrder === val ? 'filled' : 'outlined'}
                onClick={() => setStackOrder(val)}
                sx={{ height: 22, '& .MuiChip-label': { px: 1, fontSize: 11 } }}
              />
            </Tooltip>
          ))}
        </Stack>
      )}

      {displayMode === 'rolling' && (
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ flex: 1, ml: 0.5, minWidth: 160 }}>
          <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
            Win: {windowSize}
          </Typography>
          <Slider
            size="small"
            min={4}
            max={168}
            step={1}
            value={windowSize}
            onChange={(_, v) => setWindowSize(v)}
            sx={{ maxWidth: 200 }}
          />
        </Stack>
      )}
    </Stack>
  ) : null;

  // Frame title — chart title for 1-chart frames; "N charts" when combined.
  // For entity-scoped charts, suffix with the entity id so two pop-outs of
  // the same spec for different entities are visually distinct. Optional
  // chaining throughout because a story-applied frame may briefly land
  // here with an entry whose spec is null while applyViewState filters
  // through React's commit phase.
  // The frame title is the chart's display_name, which (for SEDS) encodes
  // control state like the year — e.g. "Top 15 States … (2020)". The open-
  // time spec is stale after a control change, so re-resolve the live
  // display_name on refreshKey (cache busted at the App level). Single-chart
  // frames only; multi-chart frames show a count.
  const titleChart = multi ? null : charts[0];
  const [liveDisplayName, setLiveDisplayName] = useState(null);
  useEffect(() => {
    setLiveDisplayName(null);
    if (!titleChart?.extName || !titleChart?.spec?.name) return undefined;
    let cancelled = false;
    fetchExtensionCharts(titleChart.extName)
      .then((specs) => {
        if (cancelled) return;
        const found = (specs || []).find((s) => s.name === titleChart.spec.name);
        if (found?.display_name) setLiveDisplayName(found.display_name);
      })
      .catch(() => { /* keep open-time title */ });
    return () => { cancelled = true; };
  }, [titleChart?.extName, titleChart?.spec?.name, refreshKey]);

  const frameTitle = (() => {
    if (multi) return `${charts.length} charts`;
    const c = charts[0];
    const base = liveDisplayName || c?.spec?.display_name || c?.spec?.name || 'Untitled chart';
    // Prefer the name carried from click time (works for counties, which the
    // FIPS→name fallback can't resolve from an id alone); then the fallback;
    // finally the raw id.
    const name = c?.entityName || resolveEntityName(null, c?.entityId) || c?.entityId;
    return c?.entityId ? `${base} — ${name}` : base;
  })();

  // Descriptor represents the first chart (identity for future transfer).
  // Multi-chart frame transfer in a later phase will send the whole set.
  const first = charts[0];
  const descriptor = first?.spec ? makeExtScenarioDescriptor({
    extensionName: first.extName,
    chartName: first.spec.name,
    project,
    scenario,
    chartSpec: first.spec,
  }) : null;

  return (
    <ChartFrame
      descriptor={descriptor}
      anchorMode={anchorMode}
      onAnchorModeChange={onAnchorModeChange}
      onClose={onClose}
      frameKey={frameKey}
      combineCandidates={combineCandidates}
      onCombine={onCombine}
      onTransfer={onTransfer}
      mirrored={mirrored}
      onMirrorToggle={onMirrorToggle}
      title={frameTitle}
      headerExtras={headerExtras}
      collapseHeaderExtras
      initialFloatPosition={initialPos}
      geom={geom}
      onGeomChange={onGeomChange}
    >
      {charts.filter((c) => c?.spec).map((c, idx) => (
        <ScenarioChartBody
          // Entity-scoped charts (popped out from a tooltip) carry an
          // entityId — include it in the React key so two charts of the
          // same spec for different entities don't collide.
          key={`${c.extName}::${c.spec.name}::${c.entityId || ''}`}
          extensionName={c.extName}
          chartSpec={c.spec}
          project={project}
          scenario={scenario}
          entityId={c.entityId || ''}
          clockState={clockState}
          onScrub={handleScrub}
          displayMode={displayMode}
          windowSize={windowSize}
          unit={unit}
          stackOrder={stackOrder}
          showTitle={multi}
          onSplit={multi && onSplit ? () => onSplit(idx) : undefined}
          refreshKey={refreshKey}
        />
      ))}
    </ChartFrame>
  );
}
