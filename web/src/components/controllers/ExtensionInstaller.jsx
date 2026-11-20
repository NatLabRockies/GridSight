import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Divider from '@mui/material/Divider';
import { isTauri } from '../../lib/desktopBridge.js';

// ---------------------------------------------------------------------------
// Desktop-only panel for installing Python extensions into the bundled venv.
//
// Three install paths, all wrapping `uv pip install`:
//   - PyPI package name        →  invoke('install_extension_from_pypi')
//   - Git URL                  →  invoke('install_extension_from_git')
//   - Local wheel file (.whl)  →  invoke('install_extension_from_wheel') via
//                                 the OS file picker
//
// After install the new extension lives in site-packages but the FastAPI
// sidecar has already done its entry_points scan, so it isn't visible
// until the sidecar respawns. We surface that as an explicit button rather
// than restarting silently — most users will batch a few installs before
// reloading.
//
// TODO (post-M5): hot-reload entry_points instead of requiring a sidecar
// restart. FastAPI's importlib.metadata cache lives until process death.
// ---------------------------------------------------------------------------

const FIELD_HINT = {
  pypi: 'e.g. meridian-some-ext  or  meridian-some-ext==1.2.0',
  git: 'e.g. https://github.com/example/meridian-some-ext.git@main',
  wheel: 'Pick a .whl or bundle .zip from disk',
};

export default function ExtensionInstaller({ onChanged }) {
  if (!isTauri()) return null;

  const [pypiSpec, setPypiSpec] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, message, output }
  const [restartNeeded, setRestartNeeded] = useState(false);

  const handleInstall = async (cmd, args) => {
    setBusy(true);
    setResult(null);
    try {
      const { invoke } = window.__TAURI__.core;
      const report = await invoke(cmd, args);
      const ok = !!report?.ok;
      const out = (report?.stderr || '') + (report?.stdout ? `\n${report.stdout}` : '');
      setResult({
        ok,
        message: ok ? 'Install succeeded' : 'Install failed',
        output: out.trim(),
      });
      if (ok) setRestartNeeded(true);
    } catch (e) {
      setResult({ ok: false, message: String(e), output: '' });
    } finally {
      setBusy(false);
    }
  };

  const pickAndInstallWheel = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Python wheel or bundle', extensions: ['whl', 'zip'] }],
      });
      if (!path) {
        setBusy(false);
        return;
      }
      const { invoke } = window.__TAURI__.core;
      const report = await invoke('install_extension_from_wheel', { path });
      const ok = !!report?.ok;
      const out = (report?.stderr || '') + (report?.stdout ? `\n${report.stdout}` : '');
      setResult({
        ok,
        message: ok ? `Installed ${path.split('/').pop()}` : 'Install failed',
        output: out.trim(),
      });
      if (ok) setRestartNeeded(true);
    } catch (e) {
      setResult({ ok: false, message: String(e), output: '' });
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setBusy(true);
    try {
      const { invoke } = window.__TAURI__.core;
      await invoke('restart_sidecar');
      setRestartNeeded(false);
      setResult({ ok: true, message: 'Backend restarted. Reloading window…', output: '' });
      // Sidecar is on a new port; the simplest way to reset every cached
      // URL, WebSocket, and module state in the webview is a full reload.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setResult({ ok: false, message: `Restart failed: ${e}`, output: '' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Typography variant="overline" color="text.secondary">
        Install extension
      </Typography>

      {/* PyPI */}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          size="small"
          fullWidth
          label="PyPI package"
          placeholder={FIELD_HINT.pypi}
          value={pypiSpec}
          onChange={(e) => setPypiSpec(e.target.value)}
          disabled={busy}
        />
        <Button
          variant="outlined"
          disabled={busy || !pypiSpec.trim()}
          onClick={() => handleInstall('install_extension_from_pypi', { spec: pypiSpec.trim() })}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Install
        </Button>
      </Stack>

      {/* Git URL */}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          size="small"
          fullWidth
          label="Git URL"
          placeholder={FIELD_HINT.git}
          value={gitUrl}
          onChange={(e) => setGitUrl(e.target.value)}
          disabled={busy}
        />
        <Button
          variant="outlined"
          disabled={busy || !gitUrl.trim()}
          onClick={() => handleInstall('install_extension_from_git', { url: gitUrl.trim() })}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Install
        </Button>
      </Stack>

      {/* Wheel file */}
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {FIELD_HINT.wheel}
        </Typography>
        <Button variant="outlined" disabled={busy} onClick={pickAndInstallWheel} sx={{ whiteSpace: 'nowrap' }}>
          Choose wheel…
        </Button>
      </Stack>

      {busy && <LinearProgress />}

      {result && (
        <Alert severity={result.ok ? 'success' : 'error'} variant="outlined">
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{result.message}</Typography>
          {result.output && (
            <Box
              component="pre"
              sx={{
                mt: 1,
                fontSize: 11,
                maxHeight: 200,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              }}
            >
              {result.output}
            </Box>
          )}
        </Alert>
      )}

      {restartNeeded && (
        <Box>
          <Divider sx={{ mb: 1.5 }} />
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" sx={{ flex: 1 }}>
              Restart the backend to load installed extensions.
            </Typography>
            <Button variant="contained" disabled={busy} onClick={restart}>
              Restart backend
            </Button>
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
