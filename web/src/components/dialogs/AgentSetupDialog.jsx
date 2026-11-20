/**
 * AgentSetupDialog — in-app instructions for wiring Meridian to an MCP client
 * (Claude Desktop, Claude Code, or any other agent that speaks MCP).
 *
 * Desktop-only: reads paths from Tauri so the config snippet always shows the
 * real installed locations. The "Auto-configure" button writes the entry
 * directly into claude_desktop_config.json so the user doesn't have to.
 */
import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Divider from '@mui/material/Divider';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { isTauri } from '../../lib/desktopBridge.js';

async function getMcpInfo() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('get_mcp_info');
}

async function configureClaudeDesktop() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('configure_claude_desktop');
}

function CopyableCode({ value }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Box sx={{ position: 'relative' }}>
      <Box
        component="pre"
        sx={{
          fontFamily: 'monospace',
          fontSize: 12,
          bgcolor: 'action.hover',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          p: 1.5,
          m: 0,
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          pr: 5,
        }}
      >
        {value}
      </Box>
      <Tooltip title={copied ? 'Copied!' : 'Copy to clipboard'}>
        <IconButton
          size="small"
          onClick={handleCopy}
          sx={{ position: 'absolute', top: 6, right: 6 }}
        >
          {copied
            ? <CheckCircleOutlineIcon fontSize="small" color="success" />
            : <ContentCopyIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

function Step({ number, title, children }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Box
        sx={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          mt: 0.25,
        }}
      >
        <Typography variant="caption" fontWeight={700}>{number}</Typography>
      </Box>
      <Box sx={{ flex: 1 }}>
        <Typography variant="body2" fontWeight={600} gutterBottom>{title}</Typography>
        {children}
      </Box>
    </Stack>
  );
}

export default function AgentSetupDialog({ open, onClose }) {
  const available = isTauri();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [configuredPath, setConfiguredPath] = useState(null);

  useEffect(() => {
    if (!open || !available) return;
    setError(null);
    setInfo(null);
    getMcpInfo()
      .then((i) => {
        setInfo(i);
        setConfigured(i.is_configured);
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, [open, available]);

  const handleAutoConfigure = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await configureClaudeDesktop();
      setConfigured(true);
      setConfiguredPath(path);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const configSnippet = info
    ? JSON.stringify(
        {
          mcpServers: {
            meridian: {
              command: info.python_bin,
              args: [info.mcp_server_path],
            },
          },
        },
        null,
        2
      )
    : '';

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <span>Agent Integration</span>
          {configured && (
            <Chip
              size="small"
              icon={<CheckCircleOutlineIcon />}
              label="Configured"
              color="success"
              variant="outlined"
            />
          )}
        </Stack>
      </DialogTitle>

      <DialogContent dividers>
        {!available ? (
          <Alert severity="info">
            Agent integration setup is only available in the Meridian desktop app.
          </Alert>
        ) : (
          <Stack spacing={2.5}>
            <Typography variant="body2" color="text.secondary">
              Meridian exposes an{' '}
              <strong>MCP (Model Context Protocol) server</strong> so AI agents
              can read data, control the map, and open charts directly — no
              copy-pasting required. Works with Claude Desktop, Claude Code, and
              any other MCP-compatible agent.
            </Typography>

            {error && <Alert severity="error">{error}</Alert>}
            {busy && <LinearProgress />}

            {configuredPath && (
              <Alert severity="success">
                Written to <code>{configuredPath}</code>. Restart your MCP
                client (Claude Desktop / Claude Code) to pick up the change.
              </Alert>
            )}

            <Divider />

            <Step number="1" title="Keep Meridian running">
              <Typography variant="body2" color="text.secondary">
                The MCP server proxies requests to the Meridian backend, so
                Meridian must be open whenever your agent wants to use it.
              </Typography>
            </Step>

            <Step number="2" title="Add Meridian to your MCP client">
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                <strong>Claude Desktop / Claude Code</strong> — use the button
                below to auto-configure, or paste the snippet manually into{' '}
                <code>claude_desktop_config.json</code>
                {info?.claude_config_path ? ` (${info.claude_config_path})` : ''}.
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                <strong>Other agents</strong> — add a stdio MCP server that
                runs the command shown below.
              </Typography>

              {info ? (
                <CopyableCode value={configSnippet} />
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Loading paths…
                </Typography>
              )}
            </Step>

            <Step number="3" title="Restart your MCP client">
              <Typography variant="body2" color="text.secondary">
                After saving the config, fully quit and relaunch your agent app
                so it picks up the new server entry.
              </Typography>
            </Step>

            <Step number="4" title="Try it">
              <Typography variant="body2" color="text.secondary">
                Ask your agent: <em>"What scenarios are loaded in Meridian?"</em>{' '}
                or <em>"Zoom the map to Texas."</em> The agent will call{' '}
                <code>list_scenarios</code> or <code>fit_map_to_bounds</code>{' '}
                automatically.
              </Typography>
            </Step>
          </Stack>
        )}
      </DialogContent>

      <DialogActions sx={{ justifyContent: 'space-between', px: 2 }}>
        <Button
          variant="contained"
          onClick={handleAutoConfigure}
          disabled={!info || busy || !available}
        >
          {configured ? 'Re-configure Claude Desktop' : 'Auto-configure Claude Desktop'}
        </Button>
        <Button onClick={onClose} disabled={busy}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
