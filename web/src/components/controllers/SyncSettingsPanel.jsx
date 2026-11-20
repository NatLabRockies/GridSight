/**
 * SyncSettingsPanel — session-based tab sync management.
 *
 * Shows:
 *   - Current session status (connected/disconnected)
 *   - List of discovered local tabs with their session status
 *   - Per-channel receive/publish toggles (when connected)
 *   - Create/join/leave session controls
 */

import React, { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import SyncIcon from '@mui/icons-material/Sync';
import SyncDisabledIcon from '@mui/icons-material/SyncDisabled';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import AddIcon from '@mui/icons-material/Add';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import Switch from '@mui/material/Switch';
import bus, {
  SYNC_CHANNELS,
  parseJoinInput,
  getLastRemoteHost,
  setLastRemoteHost,
  normalizeHost,
} from '../../lib/stateBus.js';
import { joinRemoteCrossEnv } from '../../lib/loaders.js';
import QrScanDialog from '../dialogs/QrScanDialog.jsx';
import { getViewportFitBounds, setViewportFitBounds, subscribeViewportFitBounds } from '../../lib/viewportSyncMode.js';

function SyncToggle({ enabled, onClick, icon: Icon, title, color }) {
  return (
    <Tooltip title={title} placement="top">
      <IconButton
        size="small"
        onClick={onClick}
        sx={{
          width: 24,
          height: 24,
          bgcolor: enabled ? `${color}.main` : 'transparent',
          color: enabled ? `${color}.contrastText` : 'text.disabled',
          border: 1,
          borderColor: enabled ? `${color}.main` : 'divider',
          '&:hover': { bgcolor: enabled ? `${color}.dark` : 'action.hover' },
        }}
      >
        <Icon sx={{ fontSize: 12 }} />
      </IconButton>
    </Tooltip>
  );
}

export default function SyncSettingsPanel({ onClose }) {
  const [syncState, setSyncState] = useState(() => bus.getSyncState());
  const [tabs, setTabs] = useState(() => bus.discovery.getTabs());

  useEffect(() => {
    const unsub1 = bus.onSyncChange((state) => setSyncState(state));
    const unsub2 = bus.discovery.onChange((t) => setTabs([...t]));
    return () => { unsub1(); unsub2(); };
  }, []);

  const [joinKeyInput, setJoinKeyInput] = useState('');
  const [hostInput, setHostInput] = useState(() => getLastRemoteHost());
  const [startingRemote, setStartingRemote] = useState(false);
  const [joinError, setJoinError] = useState(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [fitBounds, setFitBounds] = useState(() => getViewportFitBounds());
  useEffect(() => subscribeViewportFitBounds(setFitBounds), []);

  const handleCreateSession = useCallback(() => {
    bus.createSession();
  }, []);

  const handleJoinSession = useCallback((sessionId) => {
    bus.joinSession(sessionId);
  }, []);

  const handleLeaveSession = useCallback(() => {
    bus.leaveSession();
  }, []);

  const handleStartRemote = useCallback(async () => {
    setStartingRemote(true);
    try {
      await bus.startRemoteSession();
    } catch (e) {
      console.error('[SyncPanel] Failed to start remote session:', e);
    } finally {
      setStartingRemote(false);
    }
  }, []);

  // Unified remote-join entry. Whatever the user typed, pasted, or scanned is
  // classified by parseJoinInput against the Host field:
  //   • a scanned /control URL or pasted join code carries its own host+token
  //   • a 6-digit code is redeemed as an OTP against the Host field
  //   • a bare session key joins the current backend (same-deployment path)
  // Cross-env shapes funnel through joinRemoteCrossEnv (redeem → join → role).
  const doJoin = useCallback(async (rawInput, rawHost) => {
    const input = String(rawInput || '').trim();
    if (!input) return;
    setJoinError(null);
    const parsed = parseJoinInput(input, rawHost);
    if (!parsed) {
      setJoinError('Enter a 6-digit code with a host, or paste/scan a join code.');
      return;
    }
    setStartingRemote(true);
    try {
      if (parsed.kind === 'session-key') {
        bus.joinRemoteSession(parsed.key);
      } else {
        await joinRemoteCrossEnv(bus, {
          host: parsed.host, token: parsed.token, otp: parsed.otp,
        });
        setHostInput(parsed.host);
      }
      setJoinKeyInput('');
    } catch (e) {
      console.error('[SyncPanel] remote join failed:', e);
      setJoinError(e?.message || 'Join failed. Check the host and code, then try again.');
    } finally {
      setStartingRemote(false);
    }
  }, []);

  const handleJoinRemote = useCallback(
    () => doJoin(joinKeyInput, hostInput),
    [doJoin, joinKeyInput, hostInput],
  );

  // A scanned QR carries host + token directly — join immediately.
  const handleScanDecode = useCallback((code) => {
    setScanOpen(false);
    const host = normalizeHost(code.host);
    setHostInput(host);
    setLastRemoteHost(host);
    doJoin(`${host}/control/${code.token}`, host);
  }, [doJoin]);

  const handleHostChange = useCallback((e) => {
    setHostInput(e.target.value);
  }, []);

  const handleHostBlur = useCallback(() => {
    const normalized = normalizeHost(hostInput);
    if (normalized && normalized !== hostInput) setHostInput(normalized);
    if (normalized) setLastRemoteHost(normalized);
  }, [hostInput]);

  const handleToggle = useCallback((channel, field) => {
    const current = syncState.channels?.[channel] || { receive: true, publish: true };
    bus.setChannelSync(channel, { [field]: !current[field] });
  }, [syncState]);

  const handleFlashTab = useCallback((tabId) => {
    bus.discovery.flashTab(tabId);
  }, []);

  const handleCopyLink = useCallback(() => {
    const params = bus.buildPopoutParams();
    const base = window.location.origin + window.location.pathname;
    const url = `${base}?${params.toString()}`;
    navigator.clipboard.writeText(url);
  }, []);

  const connected = syncState.connected;
  const sessionColor = syncState.color;
  const sessionId = syncState.sessionId;
  const sessionType = syncState.sessionType;
  const remoteKey = syncState.remoteSessionKey;
  const remoteStatus = syncState.remoteStatus;

  // Find other tabs in the same session
  const sessionTabs = tabs.filter((t) => t.sessionId === sessionId && sessionId);
  // Tabs with their own sessions (that we could join)
  const otherSessions = tabs.filter((t) => t.sessionId && t.sessionId !== sessionId);
  // Tabs not in any session
  const idleTabs = tabs.filter((t) => !t.sessionId);

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'fixed',
        bottom: 52,
        left: 12,
        zIndex: 1500,
        width: 340,
        maxHeight: '70vh',
        overflow: 'auto',
        bgcolor: 'background.paper',
        borderRadius: 2,
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
        {connected
          ? <SyncIcon sx={{ fontSize: 18, color: sessionColor, mr: 1 }} />
          : <SyncDisabledIcon sx={{ fontSize: 18, color: 'text.disabled', mr: 1 }} />
        }
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          Tab Sync
        </Typography>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      {/* Session status */}
      <Box sx={{ px: 1.5, py: 1 }}>
        {connected ? (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: sessionColor, flexShrink: 0 }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="caption" fontWeight={600}>
                  {sessionType === 'remote' ? 'Remote Session' : 'Local Session'}
                  {sessionType === 'remote' && remoteStatus === 'connecting' && ' (connecting...)'}
                  {sessionType === 'remote' && remoteStatus === 'connected' && (
                    <Typography component="span" variant="caption" sx={{ color: 'success.main', ml: 0.5 }}>
                      Ready
                    </Typography>
                  )}
                  {sessionType === 'remote' && remoteStatus === 'disconnected' && (
                    <Typography component="span" variant="caption" sx={{ color: 'error.main', ml: 0.5 }}>
                      Disconnected (reconnecting...)
                    </Typography>
                  )}
                </Typography>
                {remoteKey && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, fontFamily: 'monospace' }}>
                      Key: {remoteKey}
                    </Typography>
                    <Tooltip title="Copy session key">
                      <IconButton size="small" onClick={() => navigator.clipboard.writeText(remoteKey)} sx={{ p: 0.25 }}>
                        <ContentCopyIcon sx={{ fontSize: 10 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                )}
                {!remoteKey && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9 }}>
                    {sessionId?.slice(0, 20)}
                  </Typography>
                )}
              </Box>
              {sessionType === 'local' && (
                <Tooltip title="Copy join link">
                  <IconButton size="small" onClick={handleCopyLink}><ContentCopyIcon sx={{ fontSize: 14 }} /></IconButton>
                </Tooltip>
              )}
              <Button size="small" variant="outlined" color="warning" onClick={handleLeaveSession}
                startIcon={<LinkOffIcon sx={{ fontSize: 14 }} />} sx={{ fontSize: 10, textTransform: 'none' }}>
                Leave
              </Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {/* Local session */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>Local (same machine):</Typography>
              <Button size="small" variant="contained" onClick={handleCreateSession}
                startIcon={<AddIcon sx={{ fontSize: 14 }} />} sx={{ fontSize: 10, textTransform: 'none' }}>
                New
              </Button>
            </Box>
            {/* Remote session */}
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  Remote (cross-machine):
                </Typography>
                <Button size="small" variant="contained" color="secondary" onClick={handleStartRemote}
                  disabled={startingRemote}
                  startIcon={startingRemote ? <CircularProgress size={12} /> : <AddIcon sx={{ fontSize: 14 }} />}
                  sx={{ fontSize: 10, textTransform: 'none', flexShrink: 0 }}>
                  Start
                </Button>
              </Box>

              {/* Join an existing wall: host (remembered) + short code, or scan. */}
              <TextField
                size="small"
                label="Wall host"
                placeholder="meridian.example.org"
                value={hostInput}
                onChange={handleHostChange}
                onBlur={handleHostBlur}
                fullWidth
                sx={{ mt: 1, '& input': { fontSize: 11, py: 0.5 }, '& label': { fontSize: 11 } }}
              />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                <TextField
                  size="small"
                  placeholder="6-digit code, join code, or key…"
                  value={joinKeyInput}
                  onChange={(e) => { setJoinKeyInput(e.target.value); if (joinError) setJoinError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleJoinRemote(); }}
                  sx={{ flex: 1, '& input': { fontSize: 11, py: 0.5, px: 1, fontFamily: 'monospace' } }}
                />
                <Tooltip title="Scan the wall's QR code">
                  <span>
                    <IconButton size="small" onClick={() => setScanOpen(true)} disabled={startingRemote}>
                      <QrCodeScannerIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </span>
                </Tooltip>
                <Button size="small" variant="outlined" onClick={handleJoinRemote}
                  disabled={!joinKeyInput.trim() || startingRemote}
                  startIcon={startingRemote
                    ? <CircularProgress size={12} />
                    : <LinkIcon sx={{ fontSize: 14 }} />}
                  sx={{ fontSize: 10, textTransform: 'none', flexShrink: 0 }}>
                  Join
                </Button>
              </Box>
              {joinError && (
                <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 0.5, fontSize: 10 }}>
                  {joinError}
                </Typography>
              )}
            </Box>
          </Box>
        )}
      </Box>

      <QrScanDialog open={scanOpen} onClose={() => setScanOpen(false)} onDecode={handleScanDecode} />

      <Divider />

      {/* Discovered tabs */}
      <Box sx={{ px: 1.5, py: 0.75 }}>
        <Typography variant="caption" fontWeight={600} color="text.secondary">
          Local Tabs ({tabs.length})
        </Typography>
      </Box>

      {tabs.length === 0 ? (
        <Box sx={{ px: 1.5, pb: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
            No other tabs detected
          </Typography>
        </Box>
      ) : (
        <Box sx={{ px: 0.5, pb: 0.5 }}>
          {/* Tabs in our session */}
          {sessionTabs.length > 0 && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ px: 1, fontSize: 9 }}>In this session:</Typography>
              {sessionTabs.map((tab) => (
                <TabRow key={tab.tabId} tab={tab} sessionColor={sessionColor} onFlash={handleFlashTab} />
              ))}
            </>
          )}

          {/* Tabs with other sessions (joinable) */}
          {otherSessions.length > 0 && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ px: 1, fontSize: 9, mt: 0.5, display: 'block' }}>Other sessions:</Typography>
              {otherSessions.map((tab) => (
                <TabRow key={tab.tabId} tab={tab} onFlash={handleFlashTab}
                  action={<Tooltip title="Join this session">
                    <IconButton size="small" onClick={() => handleJoinSession(tab.sessionId)}>
                      <LinkIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>}
                />
              ))}
            </>
          )}

          {/* Idle tabs */}
          {idleTabs.length > 0 && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ px: 1, fontSize: 9, mt: 0.5, display: 'block' }}>Not in a session:</Typography>
              {idleTabs.map((tab) => (
                <TabRow key={tab.tabId} tab={tab} onFlash={handleFlashTab} />
              ))}
            </>
          )}
        </Box>
      )}

      {/* Per-channel toggles (only when connected) */}
      {connected && (
        <>
          <Divider />
          <Box sx={{ px: 1.5, py: 0.5 }}>
            <Typography variant="caption" fontWeight={600} color="text.secondary">Channel Sync</Typography>
          </Box>
          {/* Column headers */}
          <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pb: 0.25 }}>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="Receive from other tabs"><Box sx={{ width: 32, textAlign: 'center' }}><ArrowDownwardIcon sx={{ fontSize: 10, color: 'text.secondary' }} /></Box></Tooltip>
            <Tooltip title="Publish to other tabs"><Box sx={{ width: 32, textAlign: 'center' }}><ArrowUpwardIcon sx={{ fontSize: 10, color: 'text.secondary' }} /></Box></Tooltip>
          </Box>
          <Box sx={{ px: 0.5, pb: 1 }}>
            {Object.entries(SYNC_CHANNELS).map(([channel, { label }]) => {
              const flags = syncState.channels?.[channel] || { receive: true, publish: true };
              return (
                <Box key={channel} sx={{ display: 'flex', alignItems: 'center', py: 0.25, px: 1, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}>
                  <Typography variant="body2" sx={{ flex: 1, fontSize: 11 }}>{label}</Typography>
                  <Box sx={{ width: 32, display: 'flex', justifyContent: 'center' }}>
                    <SyncToggle enabled={flags.receive} onClick={() => handleToggle(channel, 'receive')}
                      icon={ArrowDownwardIcon} title={flags.receive ? `Stop receiving ${label}` : `Receive ${label}`} color="info" />
                  </Box>
                  <Box sx={{ width: 32, display: 'flex', justifyContent: 'center' }}>
                    <SyncToggle enabled={flags.publish} onClick={() => handleToggle(channel, 'publish')}
                      icon={ArrowUpwardIcon} title={flags.publish ? `Stop publishing ${label}` : `Publish ${label}`} color="success" />
                  </Box>
                </Box>
              );
            })}
          </Box>
        </>
      )}

      {/* Viewport sync mode */}
      <Divider />
      <Box sx={{ px: 1.5, py: 0.75, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" fontWeight={600}>Fit to bounds</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9 }}>
            Match the visible map area across different-sized displays, instead of
            replicating exact zoom. Useful when a control screen and the wall differ.
          </Typography>
        </Box>
        <Switch
          size="small"
          checked={fitBounds}
          onChange={(e) => setViewportFitBounds(e.target.checked)}
          inputProps={{ 'aria-label': 'Fit map to bounds across displays' }}
        />
      </Box>

      {/* Footer */}
      <Box sx={{ px: 1.5, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9 }}>
          This tab: {bus.getTabId().slice(0, 16)}
        </Typography>
      </Box>
    </Paper>
  );
}

/** A single row in the tab list. */
function TabRow({ tab, sessionColor, onFlash, action }) {
  const color = tab.sessionId ? pickSessionColor(tab.sessionId) : null;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.25, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}>
      {color && <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="caption" noWrap sx={{ fontSize: 10 }}>{tab.tabId.slice(0, 16)}</Typography>
      </Box>
      <Tooltip title="Flash this tab's border">
        <IconButton size="small" onClick={() => onFlash(tab.tabId)} sx={{ p: 0.25 }}>
          <VisibilityIcon sx={{ fontSize: 12 }} />
        </IconButton>
      </Tooltip>
      {action || null}
    </Box>
  );
}

function pickSessionColor(sessionId) {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
  return SESSION_COLORS[Math.abs(hash) % SESSION_COLORS.length];
}

const SESSION_COLORS = [
  '#2196f3', '#4caf50', '#ff9800', '#e91e63', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b',
];
