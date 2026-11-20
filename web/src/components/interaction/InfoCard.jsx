import React from 'react';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import { formatFieldLabel as formatColumnName } from '../../lib/formatFieldLabel.js';

/** True when a property value carries no information worth showing in
 * the info card. Generator metadata typically has many columns and most
 * are blank for any given row — rendering "—" rows for all of them
 * buries the actually-useful fields. */
function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === '—') return true;
    const lower = s.toLowerCase();
    if (lower === 'none' || lower === 'null' || lower === 'nan') return true;
    return false;
  }
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/**
 * InfoCard — displays geometry feature properties and the current timestep value.
 *
 * @param {{ feature: object, entityId: string|null, currentValue: number|null, layerConfig: object, dataRow: object|null }} props
 */
export default function InfoCard({ feature, entityId, currentValue, layerConfig, dataRow }) {
  const properties = feature?.properties ?? {};
  // Drop empty values so generators with sparse metadata don't show a
  // wall of "—" rows. Matches the "—" we used to render, just elides
  // the row entirely.
  const entries = Object.entries(properties).filter(([, v]) => !isEmptyValue(v));

  // Derive the column name from the primary fill color style mapping
  const fillMapping = layerConfig?.style_mappings?.find(
    (m) => m.visual_property === 'getFillColor'
  );
  const valueColumn = fillMapping?.column;
  const columnLabel = valueColumn ? formatColumnName(valueColumn) : null;

  // For static datasets, get the mapped column value from the data row
  const staticValue = dataRow && valueColumn ? dataRow[valueColumn] : null;
  const displayValue = currentValue ?? staticValue;
  const displayLabel = columnLabel ?? 'Current value';

  // The entity name itself is rendered at the panel top by
  // EntityInteractionManager so it stays visible when this section is
  // collapsed. ``entityId`` is still accepted for backward
  // compatibility but no longer drawn here.
  return (
    // Flexible width within reason: grow to fit content up to a comfortable cap
    // (so long fields fit on one line where they can) and wrap beyond it, rather
    // than forcing a horizontal scroll at a hard 320px.
    <Box sx={{ minWidth: 240, maxWidth: 460 }}>
      {displayValue != null && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary">{displayLabel}</Typography>
          <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace', wordBreak: 'break-word' }}>
            {typeof displayValue === 'number' ? displayValue.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(displayValue)}
          </Typography>
        </Box>
      )}

      {/* Show dataset columns when available (static datasets) */}
      {dataRow && typeof dataRow === 'object' && (
        <Table size="small" sx={{ tableLayout: 'fixed', width: '100%', '& td, & th': { py: 0.25, px: 0.75, fontSize: '0.75rem', whiteSpace: 'normal', wordBreak: 'break-word' }, mb: 0.5 }}>
          <TableBody>
            {Object.entries(dataRow)
              .filter(([key]) => key !== (layerConfig?.layer_datasets?.[0]?.data_join_key || layerConfig?.layer_datasets?.[0]?.dataset?.join_key))
              .filter(([, val]) => !isEmptyValue(val))
              .map(([key, val]) => (
                <TableRow key={key} sx={{ '&:last-child td': { border: 0 } }}>
                  <TableCell component="th" scope="row" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                    {formatColumnName(key)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                    {val === null || val === undefined
                      ? '—'
                      : typeof val === 'number'
                        ? val.toLocaleString(undefined, { maximumFractionDigits: 1 })
                        : String(val)}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}

      {/* Show raw geometry properties when no dataset row is available */}
      {!dataRow && entries.length > 0 && (
        <Table size="small" sx={{ tableLayout: 'fixed', width: '100%', '& td, & th': { py: 0.25, px: 0.75, fontSize: '0.75rem', whiteSpace: 'normal', wordBreak: 'break-word' } }}>
          <TableBody>
            {entries.map(([key, val]) => (
              <TableRow key={key} sx={{ '&:last-child td': { border: 0 } }}>
                <TableCell component="th" scope="row" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                  {key}
                </TableCell>
                <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
                  {val === null || val === undefined ? '—' : String(val)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}
