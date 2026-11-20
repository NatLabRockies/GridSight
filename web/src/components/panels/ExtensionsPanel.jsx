/**
 * ExtensionsPanel — enable/disable data-provider extensions and browse
 * their scenario-scoped chart specs.
 *
 * Each enabled extension expands into a list of charts the operator can
 * open in this tab. When `onOpenChartAndMirror` is provided (command-
 * center hosts), each chart row also offers a "Open + Mirror" button
 * that pushes the chart to the main display via the 'charts' channel.
 *
 * Toggle calls `onToggleExtension(name, 'enabled'|'disabled')` exactly
 * like before; that path persists via setExtensionPreference and re-
 * bootstraps layers on the host. The accordion state is local — there's
 * no need to sync which extension a particular operator has expanded.
 */

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Switch from '@mui/material/Switch';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ScreenShareIcon from '@mui/icons-material/ScreenShare';

import { fetchExtensionCharts } from '../../lib/loaders.js';
import ExtensionScenarioPicker from '../controllers/ExtensionScenarioPicker.jsx';

export default function ExtensionsPanel({
  extensions,
  scenarioState,
  onScenarioChange,        // (newScenarioState) => void
  onToggleExtension,
  onOpenChart,             // (extName, spec) => void — open in this tab
  onOpenChartAndMirror,    // (extName, spec) => void — open + push to display
}) {
  const dataProviders = (extensions || []).filter(
    (e) => e?.capabilities?.includes('data_provider')
  );

  if (dataProviders.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 1 }}>
        <Typography variant="caption" color="text.secondary">
          No data-provider extensions installed.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', height: '100%', overflowY: 'auto' }}>
      {dataProviders.map((ext) => (
        <ExtensionRow
          key={ext.name}
          ext={ext}
          scenarioState={scenarioState}
          onScenarioChange={onScenarioChange}
          onToggleExtension={onToggleExtension}
          onOpenChart={onOpenChart}
          onOpenChartAndMirror={onOpenChartAndMirror}
        />
      ))}
    </Box>
  );
}

function ExtensionRow({
  ext, scenarioState, onScenarioChange,
  onToggleExtension, onOpenChart, onOpenChartAndMirror,
}) {
  const [expanded, setExpanded] = useState(false);
  const [specs, setSpecs] = useState(null); // null = unfetched
  const [loading, setLoading] = useState(false);

  const enabled = ext.state !== 'disabled';
  const label = ext.display_name || ext.name;

  // Lazy-load chart specs the first time the row is expanded. Cached on
  // the loader side, so re-expanding is instant.
  useEffect(() => {
    if (!expanded || !enabled || specs !== null) return;
    let cancelled = false;
    setLoading(true);
    fetchExtensionCharts(ext.name)
      .then((all) => {
        if (cancelled) return;
        const scenarioOnly = (all || []).filter(
          (c) => (c.scope ?? c.chart_options?.scope) === 'scenario'
        );
        setSpecs(scenarioOnly);
      })
      .catch(() => { if (!cancelled) setSpecs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, enabled, ext.name, specs]);

  return (
    <Accordion
      expanded={expanded && enabled}
      onChange={(_, isOpen) => setExpanded(isOpen)}
      disableGutters
      square
      sx={{
        boxShadow: 'none',
        borderBottom: 1,
        borderColor: 'divider',
        '&:before': { display: 'none' },
      }}
    >
      <AccordionSummary
        expandIcon={enabled ? <ExpandMoreIcon /> : null}
        sx={{ minHeight: 52, '& .MuiAccordionSummary-content': { my: 0.5 } }}
      >
        <Stack direction="row" alignItems="center" spacing={1} sx={{ flex: 1, minWidth: 0 }}>
          <Switch
            size="medium"
            checked={enabled}
            onClick={(e) => e.stopPropagation()}
            onChange={(_, next) => onToggleExtension?.(ext.name, next ? 'enabled' : 'disabled')}
          />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              noWrap
              sx={{ fontWeight: enabled ? 500 : 400,
                    color: enabled ? 'text.primary' : 'text.secondary' }}
            >
              {label}
            </Typography>
            {ext.description && (
              <Typography variant="caption" noWrap sx={{ color: 'text.secondary', display: 'block' }}>
                {ext.description}
              </Typography>
            )}
          </Box>
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0, pb: 1, px: 1 }}>
        {/* Project + scenario picker for this extension. Mirrors what
            the main sidebar shows under each extension entry, so the
            operator knows exactly which dataset is being driven. */}
        {onScenarioChange && (
          <Box sx={{ mb: 1 }}>
            <ExtensionScenarioPicker
              extension={ext}
              scenarioProp={scenarioState}
              onChange={onScenarioChange}
            />
          </Box>
        )}
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            <CircularProgress size={16} />
          </Box>
        )}
        {!loading && specs?.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            No scenario charts published by this extension.
          </Typography>
        )}
        {!loading && specs && specs.map((spec) => (
          <Stack
            key={spec.name}
            direction="row"
            alignItems="center"
            spacing={0.5}
            sx={{
              py: 0.5,
              borderBottom: 1,
              borderColor: 'divider',
              '&:last-child': { borderBottom: 0 },
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                {spec.display_name || spec.name}
              </Typography>
              {spec.description && (
                <Typography variant="caption" noWrap sx={{ color: 'text.secondary', display: 'block' }}>
                  {spec.description}
                </Typography>
              )}
            </Box>
            <Tooltip title="Open chart in this tab">
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<OpenInNewIcon sx={{ fontSize: 16 }} />}
                  onClick={() => onOpenChart?.(ext.name, spec)}
                  sx={{ minWidth: 0, px: 1, py: 0.25 }}
                >
                  Open
                </Button>
              </span>
            </Tooltip>
            {onOpenChartAndMirror && (
              <Tooltip title="Open and push to main display">
                <span>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<ScreenShareIcon sx={{ fontSize: 16 }} />}
                    onClick={() => onOpenChartAndMirror(ext.name, spec)}
                    sx={{ minWidth: 0, px: 1, py: 0.25 }}
                  >
                    Mirror
                  </Button>
                </span>
              </Tooltip>
            )}
          </Stack>
        ))}
      </AccordionDetails>
    </Accordion>
  );
}
