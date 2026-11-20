import React, { useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";

/**
 * Login form component.
 *
 * Props:
 *   onLogin(username, password) – should be AuthContext.login, which POSTs
 *                                 to /auth/login and updates global auth state.
 *                                 Must return Promise<{ ok: boolean, error?: string }>.
 */
export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!username.trim() || !password.trim()) {
      setError("Please enter both username and password.");
      return;
    }

    setLoading(true);
    try {
      const result = await onLogin(username.trim(), password);
      if (!result.ok) {
        setError(
          result.error ?? "Login failed. Please check your credentials.",
        );
      }
      // On success, AuthContext updates `authenticated` which causes AppShell
      // to unmount this component and render <App /> instead.
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          bgcolor: "background.default",
        }}
      >
        <Paper
          elevation={6}
          sx={{
            width: "100%",
            maxWidth: 420,
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          {/* ── Header ─────────────────────────────────────────────────── */}
          <Box
            sx={{
              bgcolor: "primary.main",
              color: "primary.contrastText",
              py: 3,
              px: 4,
              textAlign: "center",
            }}
          >
            <Typography variant="h4" fontWeight={700} letterSpacing={1}>
              GridSight
            </Typography>
            <Typography variant="body2" sx={{ opacity: 0.85, mt: 0.5 }}>
              Geospatial Analytics Platform
            </Typography>
          </Box>

          {/* ── Form ───────────────────────────────────────────────────── */}
          <Box
            component="form"
            onSubmit={handleSubmit}
            noValidate
            sx={{ px: 4, py: 4 }}
          >
            <Stack spacing={2.5}>
              {error && (
                <Alert severity="error" onClose={() => setError(null)}>
                  {error}
                </Alert>
              )}

              <TextField
                label="Username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
                fullWidth
                disabled={loading}
                slotProps={{ inputLabel: { shrink: true } }}
              />

              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                fullWidth
                disabled={loading}
                slotProps={{ inputLabel: { shrink: true } }}
              />

              <Button
                type="submit"
                variant="contained"
                size="large"
                fullWidth
                disabled={loading}
                sx={{ py: 1.25, fontWeight: 600, borderRadius: 2 }}
              >
                {loading ? (
                  <CircularProgress size={22} color="inherit" />
                ) : (
                  "Sign In"
                )}
              </Button>
            </Stack>
          </Box>
        </Paper>
      </Box>
  );
}
