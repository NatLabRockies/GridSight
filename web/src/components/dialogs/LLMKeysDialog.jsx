/**
 * LLMKeysDialog — manage OS-keychain-backed API keys for cloud LLM
 * providers (OpenAI, Anthropic, xAI, Gemini, Bedrock, ...). Desktop-only;
 * the dialog itself short-circuits to a notice in web mode.
 *
 * Flow:
 *   1. GET /api/chat/providers/catalog → list of {id, display_name, api_key_env}
 *   2. For each provider, call has_secret(api_key_env) to render "Set" / "Not set"
 *   3. Save → set_secret(name, value) → restart_sidecar → close
 *
 * We never read the value back into the UI; "rotate" means re-enter.
 */
import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import { fetchProviderCatalog } from '../../lib/loaders';
import {
  isSecretsAvailable,
  setSecret,
  hasSecret,
  deleteSecret,
  restartSidecar,
} from '../../lib/desktopSecrets';

export default function LLMKeysDialog({ open, onClose, onSaved }) {
  const available = isSecretsAvailable();
  const [providers, setProviders] = useState(null);
  const [values, setValues] = useState({}); // { [envName]: string }
  const [present, setPresent] = useState({}); // { [envName]: boolean }
  const [reveal, setReveal] = useState({}); // { [envName]: boolean }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !available) return;
    setError(null);
    setProviders(null);
    fetchProviderCatalog()
      .then(async (list) => {
        setProviders(list);
        const presence = {};
        await Promise.all(list.map(async (p) => {
          try { presence[p.api_key_env] = await hasSecret(p.api_key_env); }
          catch { presence[p.api_key_env] = false; }
        }));
        setPresent(presence);
        setValues({});
        setReveal({});
      })
      .catch((e) => setError(String(e?.message || e)));
  }, [open, available]);

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const entries = Object.entries(values).filter(([, v]) => v && v.trim().length > 0);
      for (const [name, value] of entries) {
        await setSecret(name, value.trim());
      }
      if (entries.length > 0) {
        await restartSidecar();
        onSaved?.();
      }
      onClose?.();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (envName) => {
    setBusy(true);
    setError(null);
    try {
      await deleteSecret(envName);
      setPresent((p) => ({ ...p, [envName]: false }));
      setValues((v) => ({ ...v, [envName]: '' }));
      await restartSidecar();
      onSaved?.();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>LLM Provider API Keys</DialogTitle>
      <DialogContent dividers>
        {!available ? (
          <Alert severity="info">
            API key management is only available in the Meridian desktop app.
            In web/server deployments, the administrator configures provider
            keys via environment variables on the server container.
          </Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Keys are stored in your operating system's keychain (macOS
              Keychain, Windows Credential Manager, Linux Secret Service).
              Saving will restart the local backend so new keys take effect.
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            {busy && <LinearProgress sx={{ mb: 2 }} />}
            {providers === null ? (
              <Typography variant="caption" color="text.secondary">Loading providers…</Typography>
            ) : providers.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                No cloud providers are declared in this build.
              </Typography>
            ) : (
              <Stack spacing={2}>
                {providers.map((p) => {
                  const env = p.api_key_env;
                  const isPresent = !!present[env];
                  const showVal = !!reveal[env];
                  return (
                    <Box key={p.id}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
                        <Typography variant="body2" fontWeight={600}>
                          {p.display_name}
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Chip
                            size="small"
                            label={isPresent ? 'Set' : 'Not set'}
                            color={isPresent ? 'success' : 'default'}
                            variant={isPresent ? 'filled' : 'outlined'}
                          />
                          {isPresent && (
                            <Tooltip title="Remove key">
                              <span>
                                <IconButton
                                  size="small"
                                  onClick={() => handleDelete(env)}
                                  disabled={busy}
                                >
                                  <DeleteOutlineIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          )}
                        </Box>
                      </Box>
                      <TextField
                        fullWidth
                        size="small"
                        type={showVal ? 'text' : 'password'}
                        placeholder={isPresent ? 'Enter new value to replace…' : `Paste ${env}`}
                        value={values[env] || ''}
                        onChange={(e) => setValues((v) => ({ ...v, [env]: e.target.value }))}
                        disabled={busy}
                        autoComplete="off"
                        slotProps={{
                          input: {
                            endAdornment: (
                              <IconButton
                                size="small"
                                onClick={() => setReveal((r) => ({ ...r, [env]: !r[env] }))}
                                edge="end"
                              >
                                {showVal ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                              </IconButton>
                            ),
                          },
                        }}
                      />
                      <Typography variant="caption" color="text.secondary">
                        Stored as <code>{env}</code>
                      </Typography>
                    </Box>
                  );
                })}
              </Stack>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Close</Button>
        {available && (
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={busy || !providers || providers.length === 0}
          >
            Save & Restart
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
