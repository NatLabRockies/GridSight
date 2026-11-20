import React, { useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import TuneIcon from '@mui/icons-material/Tune';
import StorageIcon from '@mui/icons-material/Storage';
import CodeIcon from '@mui/icons-material/Code';
import BarChartIcon from '@mui/icons-material/BarChart';
import ChartRenderer from './ChartRenderer.jsx';
import ResizableChartContainer from './ResizableChartContainer.jsx';
import { useCategoryColors } from '../../lib/categoryColors.jsx';

// ── Color injection helpers ──────────────────────────────────────────────────

/** Apply shared category colors to Plotly traces by trace.name. */
function colorPlotlySpec(spec, colorMap, toPlotly) {
  if (!spec?.data?.length) return spec;
  const colored = spec.data.map(trace => {
    if (!trace.name || !colorMap[trace.name]) return trace;
    const css = toPlotly(colorMap[trace.name]);
    const patched = { ...trace };
    if (trace.type === 'pie') {
      if (trace.labels) {
        patched.marker = { ...trace.marker, colors: trace.labels.map(l => colorMap[l] ? toPlotly(colorMap[l]) : undefined) };
      }
    } else {
      patched.marker = { ...trace.marker, color: css };
      if (trace.mode?.includes('lines') || trace.type === 'scatter') {
        patched.line = { ...trace.line, color: css };
      }
    }
    return patched;
  });
  return { ...spec, data: colored };
}

/** Apply shared category colors to a Vega-Lite spec via encoding.color.scale. */
function colorVegaLiteSpec(spec, colorMap, toHex) {
  if (!spec?.encoding?.color?.field) return spec;
  const cats = Object.keys(colorMap);
  if (cats.length === 0) return spec;
  const domain = cats.sort();
  const range = domain.map(c => toHex(colorMap[c]));
  return {
    ...spec,
    encoding: {
      ...spec.encoding,
      color: {
        ...spec.encoding.color,
        scale: { domain, range },
      },
    },
  };
}

/** Apply shared category colors to ChartGPU series by series.name. */
function colorChartGPUSpec(spec, colorMap, toHex) {
  if (!spec?.series?.length) return spec;
  const colored = spec.series.map(s => {
    if (!s.name || !colorMap[s.name]) return s;
    return { ...s, color: toHex(colorMap[s.name]) };
  });
  return { ...spec, series: colored };
}

/**
 * ChartTabs — tabbed view for a chart: Visualization, JSON, Data, SQL, DAG.
 *
 * Props:
 *   plotlySpec: { data, layout } — the Plotly JSON object (for plotly format)
 *   chart: the full chart object from useChartDAG (has spec, datasets, source, format, etc.)
 *   width: initial container width for the chart (default 480)
 *   height: initial container height for the chart (default 340)
 *   webgpu: boolean — whether WebGPU is available
 *   framed: boolean — true when wrapped by a ChartFrame that owns resizing, so
 *           the chart fills the frame and the redundant inner resize handle is hidden
 */
export default function ChartTabs({ plotlySpec, chart, width = 480, height = 340, webgpu = false, framed = false }) {
  const [tab, setTab] = useState(0);
  // Track the current resized dimensions so non-chart tabs can adapt
  const [chartSize, setChartSize] = useState({ width, height });

  const { colorMap, rgbaToHex, rgbaToPlotlyCss } = useCategoryColors();

  const spec = chart?.spec || {};
  const format = chart?.format || 'plotly';
  const datasets = chart?.datasets || [];
  const sql = spec.sql || '';

  const rawSpec = format === 'plotly' ? plotlySpec
    : format === 'vega-lite' ? (chart?.vegaLiteSpec || spec)
    : spec;

  // Inject shared category colors into the spec for the active format.
  const coloredPlotlySpec = useMemo(
    () => format === 'plotly' && plotlySpec ? colorPlotlySpec(plotlySpec, colorMap, rgbaToPlotlyCss) : plotlySpec,
    [plotlySpec, colorMap, format, rgbaToPlotlyCss],
  );
  const coloredRawSpec = useMemo(() => {
    if (format === 'vega-lite') return colorVegaLiteSpec(rawSpec, colorMap, rgbaToHex);
    if (format === 'chartgpu') return colorChartGPUSpec(rawSpec, colorMap, rgbaToHex);
    return rawSpec;
  }, [rawSpec, colorMap, format, rgbaToHex]);

  const tableData = React.useMemo(() => {
    if (format === 'vega-lite') {
      const values = rawSpec?.data?.values;
      if (!values?.length) return null;
      return values;
    }
    if (!plotlySpec?.data?.length) return null;
    const rows = [];
    for (const trace of plotlySpec.data) {
      if (trace.type === 'pie') {
        for (let i = 0; i < (trace.labels?.length || 0); i++) {
          rows.push({ label: trace.labels[i], value: trace.values?.[i], series: trace.name || '' });
        }
      } else {
        for (let i = 0; i < (trace.x?.length || 0); i++) {
          rows.push({ x: trace.x[i], y: trace.y?.[i], series: trace.name || '' });
        }
      }
    }
    return rows;
  }, [plotlySpec, rawSpec, format]);

  const hasSeries = plotlySpec?.data?.length > 1 || plotlySpec?.data?.[0]?.name;
  const isPie = plotlySpec?.data?.[0]?.type === 'pie';
  const vlColumns = format === 'vega-lite' && tableData?.length ? Object.keys(tableData[0]) : [];

  return (
    // When framed, this must be a full-height flex column: the chart tab's
    // ResizableChartContainer fills its PARENT, so if that parent is
    // auto-height there is nothing to fill and the chart stays pinned at its
    // initial size while the frame resizes around it.
    <Box sx={framed
      ? { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }
      : undefined}>
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{
          minHeight: 32,
          '& .MuiTab-root': { minHeight: 32, py: 0.5, px: 1.5, fontSize: 12, textTransform: 'none' },
        }}
      >
        <Tab label="Chart" />
        <Tab label="JSON" />
        <Tab label="Data" />
        <Tab label="SQL" />
        <Tab label="DAG" />
      </Tabs>

      {/* Tab 0: Chart visualization (resizable) */}
      {tab === 0 && (
        <Box sx={framed
          ? { mt: 0.5, flex: 1, minHeight: 0, position: 'relative' }
          : { mt: 0.5 }}>
          <ResizableChartContainer
            initialWidth={width}
            initialHeight={height}
            onResize={setChartSize}
            embedded={framed}
          >
            {({ width: w, height: h }) => (
              <ChartRenderer
                format={format}
                spec={format !== 'plotly' ? coloredRawSpec : undefined}
                plotlySpec={coloredPlotlySpec}
                width={w}
                height={h}
                webgpu={webgpu}
              />
            )}
          </ResizableChartContainer>
        </Box>
      )}

      {/* Tab 1: Raw JSON spec */}
      {tab === 1 && (
        <Box
          sx={{
            mt: 0.5,
            bgcolor: 'grey.900',
            borderRadius: 1,
            p: 1,
            width: chartSize.width,
            maxHeight: chartSize.height + 40,
            overflow: 'auto',
            position: 'relative',
          }}
        >
          {rawSpec && (
            <Tooltip title="Copy JSON">
              <IconButton
                size="small"
                onClick={() => navigator.clipboard.writeText(JSON.stringify(rawSpec, null, 2))}
                sx={{ position: 'absolute', top: 4, right: 4, color: 'text.secondary', '&:hover': { color: 'text.primary' } }}
              >
                <ContentCopyIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#ccc' }}>
            {rawSpec ? JSON.stringify(rawSpec, null, 2) : `No ${format} spec available`}
          </pre>
        </Box>
      )}

      {/* Tab 2: Data table */}
      {tab === 2 && (
        <TableContainer sx={{ mt: 0.5, width: chartSize.width, maxHeight: chartSize.height + 40, bgcolor: 'grey.900', borderRadius: 1 }}>
          {tableData?.length ? (
            format === 'vega-lite' && vlColumns.length ? (
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {vlColumns.map((col) => (
                      <TableCell key={col} sx={{ fontSize: 11, fontWeight: 600, bgcolor: 'grey.800' }}>{col}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tableData.slice(0, 200).map((row, i) => (
                    <TableRow key={i}>
                      {vlColumns.map((col) => (
                        <TableCell key={col} sx={{ fontSize: 11 }}>
                          {typeof row[col] === 'number' ? row[col].toLocaleString() : String(row[col] ?? '')}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {hasSeries && <TableCell sx={{ fontSize: 11, fontWeight: 600, bgcolor: 'grey.800' }}>Series</TableCell>}
                    <TableCell sx={{ fontSize: 11, fontWeight: 600, bgcolor: 'grey.800' }}>
                      {isPie ? 'Label' : (plotlySpec?.layout?.xaxis?.title?.text || 'X')}
                    </TableCell>
                    <TableCell sx={{ fontSize: 11, fontWeight: 600, bgcolor: 'grey.800' }} align="right">
                      {isPie ? 'Value' : (plotlySpec?.layout?.yaxis?.title?.text || 'Y')}
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tableData.slice(0, 200).map((row, i) => (
                    <TableRow key={i}>
                      {hasSeries && <TableCell sx={{ fontSize: 11 }}>{row.series}</TableCell>}
                      <TableCell sx={{ fontSize: 11 }}>{isPie ? row.label : row.x}</TableCell>
                      <TableCell sx={{ fontSize: 11 }} align="right">
                        {typeof (isPie ? row.value : row.y) === 'number'
                          ? (isPie ? row.value : row.y).toLocaleString()
                          : (isPie ? row.value : row.y)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          ) : (
            <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
              No data available
            </Typography>
          )}
        </TableContainer>
      )}

      {/* Tab 3: SQL query */}
      {tab === 3 && (
        <Box
          sx={{
            mt: 0.5,
            bgcolor: 'grey.900',
            borderRadius: 1,
            p: 1.5,
            width: chartSize.width,
            maxHeight: chartSize.height + 40,
            overflow: 'auto',
            position: 'relative',
          }}
        >
          {sql && (
            <Tooltip title="Copy SQL">
              <IconButton
                size="small"
                onClick={() => navigator.clipboard.writeText(sql)}
                sx={{ position: 'absolute', top: 4, right: 4, color: 'text.secondary', '&:hover': { color: 'text.primary' } }}
              >
                <ContentCopyIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
          {sql ? (
            <pre style={{ margin: 0, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#a5d6ff' }}>
              {sql}
            </pre>
          ) : (
            <Typography variant="caption" sx={{ color: '#888' }}>
              No SQL query associated with this chart
            </Typography>
          )}
        </Box>
      )}

      {/* Tab 4: DAG lineage */}
      {tab === 4 && (
        <Box sx={{ mt: 0.5, p: 1.5, width: chartSize.width }}>
          <Box sx={{ mb: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <TuneIcon sx={{ fontSize: 16, color: 'info.main' }} />
              <Typography variant="caption" fontWeight={600} color="info.main">Input Controls</Typography>
            </Box>
            {spec.input_controls?.length > 0 ? (
              <Box sx={{ pl: 3, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                {spec.input_controls.map((ctrl) => (
                  <Box key={`${ctrl.extension}:${ctrl.name}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Chip
                      label={ctrl.display_name || ctrl.name}
                      size="small"
                      variant="outlined"
                      color="info"
                      sx={{ fontSize: 10 }}
                    />
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                      = {ctrl.current_value}{ctrl.unit ? ` ${ctrl.unit}` : ''}
                    </Typography>
                  </Box>
                ))}
              </Box>
            ) : (
              <Box sx={{ pl: 3 }}>
                <Chip label="Input Control" size="small" variant="outlined" color="info" sx={{ fontSize: 10 }} />
              </Box>
            )}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 0.5 }}>
            <ArrowDownwardIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
            <StorageIcon sx={{ fontSize: 16, color: 'success.main' }} />
            {datasets.length > 0 ? (
              datasets.map((ds) => (
                <Chip key={ds} label={ds} size="small" variant="outlined" color="success" sx={{ fontSize: 11 }} />
              ))
            ) : (
              <Chip label="Unknown dataset" size="small" variant="outlined" />
            )}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 0.5 }}>
            <ArrowDownwardIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
          </Box>

          <Box sx={{ mb: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <CodeIcon sx={{ fontSize: 16, color: 'warning.main' }} />
              <Chip label="SQL Transform" size="small" variant="outlined" color="warning" />
              <Chip label={chart?.source === 'ai' ? 'AI' : 'Extension'} size="small" sx={{ fontSize: 10 }} />
            </Box>
            {sql && (
              <Box
                sx={{
                  bgcolor: 'grey.800',
                  borderRadius: 1,
                  p: 1,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  maxHeight: 80,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  color: 'text.secondary',
                }}
              >
                {sql}
              </Box>
            )}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 0.5 }}>
            <ArrowDownwardIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <BarChartIcon sx={{ fontSize: 16, color: 'primary.main' }} />
            <Chip
              label={spec.title || spec.chart_type || 'Chart'}
              size="small"
              variant="outlined"
              color="primary"
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
