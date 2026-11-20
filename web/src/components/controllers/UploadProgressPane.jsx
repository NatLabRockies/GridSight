import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

/**
 * UploadProgressPane — shared progress UI for `uploadToExtension`.
 *
 * Renders a determinate bar with bytes/rate/ETA during the XHR upload
 * phase and an indeterminate bar with a status message during server-
 * side queueing/ingest. Stateless — the parent owns the upload state
 * and feeds it in via props from the `onProgress` callback.
 *
 * Props:
 *   phase: 'uploading' | 'pending' | 'running' | null
 *   loaded: number    bytes uploaded (uploading phase)
 *   total: number     bytes total   (uploading phase, 0 = unknown)
 *   rateBytesPerSec: number   smoothed throughput
 *   message: string   status text shown during pending/running
 */
export default function UploadProgressPane({
  phase,
  loaded = 0,
  total = 0,
  rateBytesPerSec = 0,
  message = "",
}) {
  if (phase === "uploading") {
    const determinate = total > 0;
    const pct = determinate ? Math.min(100, (loaded / total) * 100) : 0;
    const remaining = total > loaded ? total - loaded : 0;
    return (
      <Box>
        <LinearProgress
          variant={determinate ? "determinate" : "indeterminate"}
          value={pct}
        />
        <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            {formatBytes(loaded)} / {formatBytes(total)}
            {determinate && ` · ${pct.toFixed(1)}%`}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatRate(rateBytesPerSec)}
            {rateBytesPerSec > 0 && remaining > 0 && (
              ` · ${formatEta(remaining / rateBytesPerSec)} left`
            )}
          </Typography>
        </Stack>
      </Box>
    );
  }
  if (phase === "pending" || phase === "running") {
    return (
      <Box>
        <LinearProgress />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {message || "Processing on server…"}
        </Typography>
      </Box>
    );
  }
  return null;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m - h * 60).toString().padStart(2, "0")}m`;
}
