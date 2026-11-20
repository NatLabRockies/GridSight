/**
 * GiveControlDialog — operator-side modal for issuing a guest invite.
 *
 * Flow:
 *   1. Operator picks a permission tier ('story' | 'story+chat' | 'full').
 *   2. Operator clicks "Generate". We:
 *        a. Ensure we're in a remote session (start one if needed) so the
 *           generated invite has a valid sessionKey to bind to.
 *        b. POST /api/invites with the chosen tier.
 *      Response carries `{token, otp, ...}`. We render a large QR encoding
 *      the deep-link `${origin}/control/{token}` plus the 6-digit OTP in
 *      monospace.
 *   3. Live presence list (received over the bus's 'presence' channel)
 *      lets the operator watch guests join and revoke them in-place.
 *
 * Note: we use the `qrcode` package's `toDataURL` API for inline rendering;
 * a 256-px PNG with error-correction level M is plenty for phone cameras
 * at typical demo distances.
 */

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Link from '@mui/material/Link';
import QRCode from 'qrcode';

import bus, { applyRoleDefaults, wallBackendOrigin, encodeJoinCode } from '../../lib/stateBus.js';
import { createInvite, listInvites, revokeInvite } from '../../lib/loaders.js';

const TIER_LABELS = {
  story: 'Story navigation only',
  'story+chat': 'Story + AI chat',
  full: 'Full control (shadow login)',
};

export default function GiveControlDialog({ open, onClose }) {
  const [tier, setTier] = useState('story');
  const [label, setLabel] = useState('Guest');
  const [maxUses, setMaxUses] = useState(1);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState(null);

  const [activeInvite, setActiveInvite] = useState(null);   // freshly minted
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [invites, setInvites] = useState([]);               // server list
  const [presence, setPresence] = useState([]);             // live roster
  const [copied, setCopied] = useState(false);              // brief copy-icon flip

  // Once any guest joins the session, the operator's job is done — hide
  // the generation form + the just-minted invite display so the dialog
  // doesn't keep nudging "create another invite". The active invites
  // list + connected peers stay visible so the operator can still revoke.
  const guestConnected = presence.some((p) => p?.role === 'guest');

  // ── Load existing invites whenever the dialog opens ─────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listInvites().then((data) => {
      if (!cancelled) setInvites(data?.invites || []);
    }).catch(() => { if (!cancelled) setInvites([]); });
    return () => { cancelled = true; };
  }, [open]);

  // ── Subscribe to presence broadcasts so guest joins show up live ────────
  // Seed from the bus's permanent presence cache on open — the server
  // only broadcasts presence on join/leave, so a dialog opened AFTER a
  // guest joined would otherwise start with an empty roster.
  useEffect(() => {
    if (!open) return;
    setPresence(bus._lastPresence || []);
    const unsub = bus.subscribe('presence', (payload) => {
      if (payload?.peers) setPresence(payload.peers);
    });
    return unsub;
  }, [open]);

  // The host a desktop app types into its "Wall host" field to reach this wall.
  const wallHost = useMemo(() => wallBackendOrigin(), []);

  // ── QR rendering whenever we have an active invite ──────────────────────
  useEffect(() => {
    if (!activeInvite?.token) { setQrDataUrl(null); return; }
    const link = `${wallHost}/control/${activeInvite.token}`;
    QRCode.toDataURL(link, { width: 256, errorCorrectionLevel: 'M', margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [activeInvite]);

  const guestUrl = useMemo(
    () => activeInvite?.token
      ? `${wallHost}/control/${activeInvite.token}`
      : null,
    [activeInvite, wallHost],
  );

  // Cross-environment join code: encodes this wall's backend host + the invite
  // token. Paste it into another client's Sync Settings → "join code" field to
  // control this wall from the desktop app or a browser on another machine.
  const joinCode = useMemo(
    () => activeInvite?.token
      ? encodeJoinCode({ host: wallBackendOrigin(), token: activeInvite.token })
      : null,
    [activeInvite],
  );
  const [codeCopied, setCodeCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleGenerate = async () => {
    setError(null);
    setIssuing(true);
    try {
      // Ensure a remote session exists; the invite has to bind to one.
      let sessionKey = bus.getRemoteSessionKey();
      if (!sessionKey) {
        sessionKey = await bus.startRemoteSession();
      }
      // From now on this tab is the DISPLAY: receive state changes from
      // the control panel, never publish back. Stops the two-map fight.
      applyRoleDefaults(bus, 'display');
      const invite = await createInvite({
        permissions: tier, sessionKey, label, maxUses: Number(maxUses) || 1,
      });
      setActiveInvite(invite);
      // Refresh the list so the new invite shows up below.
      const data = await listInvites();
      setInvites(data?.invites || []);
    } catch (e) {
      setError(e.message || 'Failed to issue invite.');
    } finally {
      setIssuing(false);
    }
  };

  const handleRevoke = async (id) => {
    try {
      await revokeInvite(id);
      const data = await listInvites();
      setInvites(data?.invites || []);
      if (activeInvite?.id === id) {
        setActiveInvite(null);
      }
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Give Control</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Stack spacing={2}>
          {guestConnected && (
            <Alert severity="success">
              A guest has joined this session. Manage their access from the
              lists below.
            </Alert>
          )}

          {!guestConnected && (
            <>
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                <FormControl size="small" sx={{ minWidth: 220 }}>
                  <InputLabel>Permission</InputLabel>
                  <Select value={tier} label="Permission"
                    onChange={(e) => setTier(e.target.value)}>
                    {Object.entries(TIER_LABELS).map(([k, v]) => (
                      <MenuItem key={k} value={k}>{v}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField size="small" label="Label"
                  value={label} onChange={(e) => setLabel(e.target.value)} />
                <TextField size="small" label="Max uses" type="number"
                  value={maxUses} inputProps={{ min: 1, max: 20 }}
                  onChange={(e) => setMaxUses(e.target.value)} sx={{ width: 100 }} />
                <Button variant="contained" onClick={handleGenerate} disabled={issuing}>
                  {issuing ? <CircularProgress size={20} /> : 'Generate invite'}
                </Button>
              </Box>

              {tier === 'full' && (
                <Alert severity="warning">
                  <strong>Full</strong> tier grants the guest the same data and
                  control surface you have. Use for trusted collaborators only.
                </Alert>
              )}

              {activeInvite && (
                <Box sx={{
                  display: 'flex', gap: 3, alignItems: 'center',
                  p: 2, bgcolor: 'background.default', borderRadius: 1,
                }}>
                  {qrDataUrl ? (
                    <Box component="img" src={qrDataUrl}
                      alt="Scan to join" sx={{ width: 192, height: 192 }} />
                  ) : (
                    <CircularProgress />
                  )}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="caption" color="text.secondary">
                      Desktop app: enter this host + code in <strong>Tab Sync → Remote</strong>,
                      or scan the QR.
                    </Typography>
                    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 1, minWidth: 0 }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>Host:</Typography>
                      <Typography variant="caption" sx={{ fontFamily: 'monospace', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
                        {wallHost}
                      </Typography>
                      <Tooltip title="Copy host">
                        <IconButton
                          size="small"
                          onClick={() => { navigator.clipboard.writeText(wallHost).catch(() => {}); }}
                        >
                          <ContentCopyIcon sx={{ fontSize: 12 }} />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      6-digit code
                    </Typography>
                    <Typography sx={{
                      fontSize: 36, fontFamily: 'monospace',
                      letterSpacing: 6, fontWeight: 700, mb: 1.5,
                    }}>
                      {activeInvite.otp}
                    </Typography>
                    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
                      <Link
                        href={guestUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        underline="hover"
                        variant="caption"
                        sx={{
                          flex: 1, minWidth: 0,
                          wordBreak: 'break-all',
                          display: 'inline-flex', alignItems: 'center', gap: 0.5,
                        }}
                      >
                        <OpenInNewIcon sx={{ fontSize: 12 }} />
                        {guestUrl}
                      </Link>
                      <Tooltip title={copied ? 'Copied!' : 'Copy link'}>
                        <IconButton
                          size="small"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(guestUrl);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1500);
                            } catch (e) {
                              console.warn('[GiveControl] clipboard copy failed:', e);
                            }
                          }}
                        >
                          {copied
                            ? <CheckIcon sx={{ fontSize: 14, color: 'success.main' }} />
                            : <ContentCopyIcon sx={{ fontSize: 14 }} />}
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                      Permission: <Chip size="small" label={tier} sx={{ ml: 0.5 }} />
                    </Typography>

                    {joinCode && (
                      <Box sx={{ mt: 1.5 }}>
                        <Link
                          component="button"
                          type="button"
                          variant="caption"
                          underline="hover"
                          onClick={() => setShowAdvanced((v) => !v)}
                        >
                          {showAdvanced ? 'Hide' : 'Advanced:'} one-paste join code
                        </Link>
                        <Collapse in={showAdvanced}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                          Bundles host + token; paste into Sync Settings where clipboard sharing works.
                        </Typography>
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <TextField
                            size="small"
                            value={joinCode}
                            InputProps={{ readOnly: true, sx: { fontFamily: 'monospace', fontSize: 11 } }}
                            onFocus={(e) => e.target.select()}
                            sx={{ flex: 1, minWidth: 0 }}
                          />
                          <Tooltip title={codeCopied ? 'Copied!' : 'Copy join code'}>
                            <IconButton
                              size="small"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(joinCode);
                                  setCodeCopied(true);
                                  setTimeout(() => setCodeCopied(false), 1500);
                                } catch (e) {
                                  console.warn('[GiveControl] join-code copy failed:', e);
                                }
                              }}
                            >
                              {codeCopied
                                ? <CheckIcon sx={{ fontSize: 14, color: 'success.main' }} />
                                : <ContentCopyIcon sx={{ fontSize: 14 }} />}
                            </IconButton>
                          </Tooltip>
                        </Stack>
                        </Collapse>
                      </Box>
                    )}
                  </Box>
                </Box>
              )}
            </>
          )}

          <Divider />

          <Typography variant="subtitle2">
            Active invites ({invites.length})
          </Typography>
          {invites.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              None active. Generate an invite above.
            </Typography>
          )}
          {invites.map((inv) => (
            <Stack key={inv.id} direction="row" alignItems="center" spacing={1}
              sx={{ borderBottom: 1, borderColor: 'divider', py: 1 }}>
              <Chip size="small" label={inv.permissions} />
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {inv.label} · uses {inv.usedCount}/{inv.maxUses} · guests {inv.guestCount}
              </Typography>
              <Tooltip title="Revoke this invite and disconnect any active guest">
                <IconButton size="small" onClick={() => handleRevoke(inv.id)}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}

          <Divider />

          <Typography variant="subtitle2">
            Connected peers ({presence.length})
          </Typography>
          {presence.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              No peers connected yet.
            </Typography>
          )}
          {presence.map((p, i) => (
            <Stack key={`${p.role}-${i}`} direction="row" alignItems="center" spacing={1}>
              <Chip size="small"
                label={p.role}
                color={p.role === 'guest' ? 'warning' : 'default'} />
              <Typography variant="caption">
                {p.label || p.inviteId || 'unnamed'}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
