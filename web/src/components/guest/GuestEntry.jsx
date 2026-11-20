/**
 * GuestEntry — landing page for /control/{token} and /control.
 *
 * Two paths:
 *   - Deep-link  /control/{token}   → auto-redeems the token, lands in
 *                                      the command center.
 *   - OTP form   /control            → user types the 6-digit OTP and
 *                                      submits; same redeem path.
 *
 * On a successful redeem the Bun edge issues a `gs_guest` cookie. We then
 * navigate to `?view=control` which mounts `<ChartTrayApp mode="control">`;
 * AuthContext picks up the cookie and surfaces `mode: 'guest'` so the
 * tray can filter panels per the issued permission tier.
 */

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import { redeemGuest } from '../../lib/loaders.js';

function tokenFromPath() {
  const m = window.location.pathname.match(/^\/control\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function GuestEntry() {
  const initialToken = tokenFromPath();
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(!!initialToken);
  const [error, setError] = useState(null);

  // React 18 StrictMode runs effects twice on mount in dev. The ref
  // keyed by initialToken ensures we only ever fire one POST /auth/guest
  // per token — the second run early-returns. We deliberately do NOT use
  // a `cancelled` flag here: window.location.replace is a final commit,
  // and a setError on an unmounted component is at worst a benign warning.
  // If we used cancelled, StrictMode's first-mount cleanup would set it
  // true while the second mount's ref-check skips the new fetch — leaving
  // the original promise's .then a no-op (no redirect ever happens).
  const redemptionStartedRef = useRef(null);
  useEffect(() => {
    if (!initialToken) return;
    if (redemptionStartedRef.current === initialToken) return;
    redemptionStartedRef.current = initialToken;
    redeemGuest({ token: initialToken })
      .then((data) => {
        window.location.replace(
          `/?view=control&label=${encodeURIComponent(data.label || '')}`,
        );
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [initialToken]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp)) {
      setError('Enter the 6-digit code shown on the main display.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const data = await redeemGuest({ otp });
      window.location.replace(`/?view=control&label=${encodeURIComponent(data.label || '')}`);
    } catch (err) {
      const retryMsg = err.retryAfterMs
        ? ` Try again in ${Math.ceil(err.retryAfterMs / 60_000)} min.`
        : '';
      setError((err.message || 'Could not redeem code.') + retryMsg);
      setLoading(false);
    }
  }

  return (
    <Box sx={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      bgcolor: 'background.default',
      p: 2,
    }}>
      <Paper sx={{ p: 3, width: '100%', maxWidth: 360, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
          Join the session
        </Typography>
        {initialToken ? (
          loading ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, py: 2 }}>
              <CircularProgress size={28} />
              <Typography variant="caption" color="text.secondary">
                Connecting…
              </Typography>
            </Box>
          ) : (
            <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
          )
        ) : (
          <form onSubmit={handleSubmit}>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
              Enter the 6-digit code shown on the display.
            </Typography>
            <TextField
              autoFocus
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              inputProps={{
                inputMode: 'numeric',
                pattern: '\\d*',
                style: {
                  textAlign: 'center',
                  fontSize: 28,
                  letterSpacing: 8,
                  fontFamily: 'monospace',
                },
              }}
              sx={{ width: '100%', mb: 2 }}
              disabled={loading}
            />
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={loading || otp.length !== 6}
            >
              {loading ? 'Connecting…' : 'Join'}
            </Button>
          </form>
        )}
      </Paper>
    </Box>
  );
}
