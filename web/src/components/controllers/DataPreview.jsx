/**
 * DataPreview — paginated row preview for a single geometry or dataset.
 *
 * Lifted out of the old standalone DataInspector panel. The catalog
 * (DataManager) drives selection from its left nav and feeds the chosen
 * source in via the `source` prop; this component owns its own
 * preview/offset/partition/column-description state.
 *
 * Props:
 *   source: { type: 'geometry' | 'dataset', id: number, name: string,
 *             timestamp_col?: string } | null
 *
 * Renders nothing meaningful when `source` is null — callers should
 * gate on that themselves and show whatever empty state they prefer.
 */

import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import {
  previewGeometry,
  previewDataset,
  fetchDatasetPartitions,
  fetchColumnDescriptions,
} from '../../lib/loaders.js';

const PAGE_SIZE = 20;

function formatCell(value) {
  if (value == null) return '—';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(value);
}

export default function DataPreview({ source }) {
  const sourceType = source?.type ?? null;
  const sourceId = source?.id ?? null;
  const sourceName = source?.name ?? null;
  const timestampCol = source?.timestamp_col ?? null;

  const [partition, setPartition] = useState(null);
  const [partitions, setPartitions] = useState([]);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [colDescs, setColDescs] = useState(null);
  const [showDescs, setShowDescs] = useState(true);

  // Fetch column descriptions whenever the selected source changes. The
  // descriptions endpoint keys on table name, not id, so we lean on the
  // catalog supplying both.
  useEffect(() => {
    if (!sourceName) { setColDescs(null); return; }
    let cancelled = false;
    fetchColumnDescriptions(sourceName)
      .then((data) => { if (!cancelled) setColDescs(data); })
      .catch(() => { if (!cancelled) setColDescs({ columns: {} }); });
    return () => { cancelled = true; };
  }, [sourceName]);

  // Fetch partition list for timeseries datasets (timestamp_col present).
  // Geometry sources or non-timeseries datasets get an empty list and
  // the partition selector stays hidden.
  useEffect(() => {
    if (sourceType !== 'dataset' || !sourceId || !timestampCol) {
      setPartitions([]);
      setPartition(null);
      return;
    }
    let cancelled = false;
    fetchDatasetPartitions(sourceId)
      .then((data) => {
        if (cancelled) return;
        const result = data?.data ?? data;
        const dates = result?.dates ?? [];
        setPartitions(dates);
        if (dates.length > 0) setPartition(dates[0]);
      })
      .catch((e) => console.warn('[DataPreview] fetchPartitions:', e));
    return () => { cancelled = true; };
  }, [sourceType, sourceId, timestampCol]);

  // Reset offset when the source changes so we don't paginate into a
  // hole on a smaller table.
  useEffect(() => { setOffset(0); }, [sourceType, sourceId]);

  const loadPreview = useCallback(async (newOffset = 0) => {
    if (!sourceId || !sourceType) return;
    setLoading(true);
    try {
      let data;
      if (sourceType === 'geometry') {
        data = await previewGeometry(sourceId, { offset: newOffset, limit: PAGE_SIZE });
      } else {
        data = await previewDataset(sourceId, {
          offset: newOffset, limit: PAGE_SIZE, partition,
        });
      }
      setPreview(data);
      setOffset(newOffset);
    } catch (e) {
      console.error('[DataPreview] load error:', e);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [sourceId, sourceType, partition]);

  useEffect(() => {
    if (sourceId && sourceType) loadPreview(0);
    else setPreview(null);
    // loadPreview itself depends on sourceId/sourceType/partition; listing
    // it here is enough to re-run on any of those.
  }, [sourceId, sourceType, partition, loadPreview]);

  if (!source) return null;

  const total = preview?.total ?? 0;
  const hasNext = offset + PAGE_SIZE < total;
  const hasPrev = offset > 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Metadata bar */}
      {preview && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, py: 1, flexWrap: 'wrap' }}>
          <Chip label={`${total} rows`} size="small" />
          {colDescs?.description && (
            <Chip label={colDescs.description} size="small" variant="outlined" color="info" sx={{ maxWidth: 300 }} />
          )}
          {colDescs && (() => {
            const totalCols = preview.columns?.length || 0;
            const describedCols = preview.columns?.filter(c => colDescs.columns?.[c]?.description).length || 0;
            return totalCols > 0 && (
              <Chip
                label={`${describedCols}/${totalCols} fields described ${showDescs ? '(hide)' : '(show)'}`}
                size="small"
                variant={showDescs ? 'filled' : 'outlined'}
                color={describedCols === totalCols ? 'success' : describedCols > 0 ? 'warning' : 'default'}
                onClick={() => setShowDescs((v) => !v)}
                sx={{ cursor: 'pointer' }}
              />
            );
          })()}
          {preview.join_key && (
            <Chip label={`join_key: ${preview.join_key}`} size="small" color="primary" variant="outlined" />
          )}
          {preview.dtypes && Object.entries(preview.dtypes).map(([col, dtype]) => (
            <Chip key={col} label={`${col}: ${dtype}`} size="small" variant="outlined" sx={{ fontSize: 11 }} />
          ))}
          {partitions.length > 0 && (
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel>Partition</InputLabel>
              <Select
                value={partition ?? ''}
                label="Partition"
                onChange={(e) => setPartition(e.target.value)}
                size="small"
              >
                {partitions.map((p) => (
                  <MenuItem key={p} value={p}>{p}</MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
        </Stack>
      )}

      {/* Table */}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : preview ? (
        <TableContainer sx={{ flex: 1, overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 'bold', bgcolor: 'background.paper' }}>#</TableCell>
                {preview.columns.map((col) => (
                  <TableCell
                    key={col}
                    sx={{
                      fontWeight: 'bold',
                      bgcolor: 'background.paper',
                      color: col === preview.join_key ? 'primary.main' : 'text.primary',
                    }}
                  >
                    {col}
                  </TableCell>
                ))}
              </TableRow>
              {/* Description sub-header row — toggled via the "fields described" chip */}
              {colDescs && showDescs && (
                <TableRow>
                  <TableCell sx={{ bgcolor: 'background.paper', py: 0.5, borderBottom: 2, borderColor: 'divider', verticalAlign: 'top' }}>
                    <Typography variant="caption" sx={{ fontSize: 10, color: 'text.disabled' }}>desc</Typography>
                  </TableCell>
                  {preview.columns.map((col) => {
                    const desc = colDescs?.columns?.[col]?.description;
                    return (
                      <TableCell key={col} sx={{ bgcolor: 'background.paper', py: 0.5, borderBottom: 2, borderColor: 'divider', verticalAlign: 'top' }}>
                        <Typography
                          variant="caption"
                          sx={{
                            fontSize: 11,
                            fontStyle: desc ? 'normal' : 'italic',
                            color: desc ? 'info.main' : 'text.disabled',
                            whiteSpace: 'normal',
                            wordBreak: 'break-word',
                            minWidth: 80,
                            maxWidth: 220,
                            display: 'block',
                            lineHeight: 1.3,
                          }}
                        >
                          {desc || 'no description'}
                        </Typography>
                      </TableCell>
                    );
                  })}
                </TableRow>
              )}
            </TableHead>
            <TableBody>
              {preview.rows.map((row, i) => (
                <TableRow key={i} hover>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {offset + i + 1}
                  </TableCell>
                  {preview.columns.map((col) => (
                    <TableCell key={col} sx={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                      {formatCell(row[col])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1, p: 2 }}>
          <Typography color="text.secondary" variant="caption">
            No rows to preview.
          </Typography>
        </Box>
      )}

      {/* Pagination */}
      {preview && (
        <Box sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          px: 2,
          py: 1,
          borderTop: 1,
          borderColor: 'divider',
        }}>
          <Typography variant="body2" color="text.secondary">
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </Typography>
          <ButtonGroup size="small">
            <Button disabled={!hasPrev} onClick={() => loadPreview(offset - PAGE_SIZE)}>
              Previous
            </Button>
            <Button disabled={!hasNext} onClick={() => loadPreview(offset + PAGE_SIZE)}>
              Next
            </Button>
          </ButtonGroup>
        </Box>
      )}
    </Box>
  );
}
