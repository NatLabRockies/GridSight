/**
 * AiChartPanel — wraps an AI-generated chart in a ChartFrame so it shares
 * the same chrome (anchor menu, combine, send-to-window, drag-to-combine)
 * as extension scenario charts.
 *
 * The AI chart's placement in chartDAG ('floating' | 'tray' | 'chat') is
 * orthogonal to ChartFrame's anchor mode — chartDAG carries "is this chart
 * tracked by the chat session at all" while anchorMode carries "where on
 * screen does it render". They overlap only for tray pinning.
 */

import { Suspense, lazy } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';

import { ANCHOR_MODE, makeAiDescriptor } from '../../lib/chartDescriptor.js';
import ChartFrame from './ChartFrame.jsx';

const ChartTabs = lazy(() => import('../interaction/ChartTabs.jsx'));

export default function AiChartPanel({
  chart,                    // AI chart object from chartDAG
  onClose,                  // user closed the frame (host decides whether to unregister)
  anchorMode = ANCHOR_MODE.FLOATING,
  onAnchorModeChange,
  frameKey,
  combineCandidates,
  onCombine,
  onTransfer,
  // Lock toggle (separate concept from anchor): when locked, AI chat
  // shouldn't be allowed to remove/replace the chart. The toggle sits in
  // the header so it's discoverable alongside the other actions.
  anchored = false,
  onAnchorToggle,
  webgpu = false,
  initialPos,
}) {
  const title = chart?.spec?.title || chart?.spec?.chart_type || 'Chart';
  const descriptor = makeAiDescriptor({
    chartId: chart?.id,
    title,
    spec: chart?.spec,
    plotlySpec: chart?.plotlySpec,
  });

  const headerExtras = onAnchorToggle ? (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <Tooltip title={anchored ? 'Unlock chart (allow AI changes)' : 'Lock chart (prevent AI changes)'}>
        <IconButton
          size="small"
          onClick={() => onAnchorToggle(chart.id)}
          sx={{ p: 0.25, color: anchored ? 'warning.main' : undefined }}
        >
          {anchored ? <LockIcon fontSize="small" /> : <LockOpenIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Box>
  ) : null;

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
      title={title}
      headerExtras={headerExtras}
      initialFloatPosition={initialPos}
    >
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <Suspense fallback={null}>
          <ChartTabs
            plotlySpec={chart?.plotlySpec}
            chart={chart}
            // Fill the body — the frame's body is sized by the ChartFrame
            // wrapper (which in turn is sized by the dock / RGL grid /
            // floating size), so ChartTabs just needs reasonable defaults.
            width={500}
            height={360}
            webgpu={webgpu}
            // Inside a ChartFrame: fill it and drop the inner resize handle so
            // the frame's corner handle is the single resize affordance.
            framed
          />
        </Suspense>
      </Box>
    </ChartFrame>
  );
}
