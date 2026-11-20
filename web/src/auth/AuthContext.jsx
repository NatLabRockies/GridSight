import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Wrap your app with <AuthProvider> to make auth state available everywhere.
 *
 * Exposes:
 *   authenticated  {boolean}         – whether the user has a valid session
 *   user           {string | null}   – username returned by the server
 *   loading        {boolean}         – true while the initial session check is in-flight
 *   error          {string | null}   – last login error message
 *   login(username, password)        – POST /auth/login, returns { ok, error }
 *   logout()                         – POST /auth/logout
 */
export function AuthProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  // 'operator' for password-authenticated sessions, 'guest' for QR/OTP
  // sessions backed by an invite. Consumers can branch on this to gate
  // operator-only UI like Give-Control.
  const [mode, setMode] = useState(null);
  const [permissions, setPermissions] = useState(null);
  const [loading, setLoading] = useState(true);   // checking existing session on mount
  const [error, setError] = useState(null);

  // Re-fetch the server's view of the current session and apply it to
  // local state. Call on mount, on tab refocus, and after any operation
  // that could change permissions (e.g. give-control). Returns the new
  // permissions string for callers that want to branch on the result.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/auth/session', { credentials: 'include' });
      if (!res.ok) {
        setAuthenticated(false);
        setUser(null);
        setMode(null);
        setPermissions(null);
        return null;
      }
      const data = await res.json();
      if (data.authenticated) {
        setAuthenticated(true);
        setUser(data.user ?? null);
        setMode(data.mode || 'operator');
        setPermissions(data.permissions || null);
        return data.permissions || null;
      }
      setAuthenticated(false);
      setUser(null);
      setMode(null);
      setPermissions(null);
      return null;
    } catch (e) {
      console.warn('[AuthContext] Session check failed:', e.message);
      setAuthenticated(false);
      setUser(null);
      return null;
    }
  }, []);

  // ── Check existing session on mount + on tab refocus ────────────────────
  useEffect(() => {
    let cancelled = false;
    refresh().finally(() => { if (!cancelled) setLoading(false); });
    // Re-check on tab refocus so a long-lived tab notices server-side
    // permission changes (operator → guest demotion, give-control, etc.)
    // without needing to be reloaded.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  // ── Login ────────────────────────────────────────────────────────────────
  const login = useCallback(async (username, password) => {
    setError(null);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        setAuthenticated(true);
        setUser(data.user ?? username);
        setMode('operator');
        setPermissions(null);
        return { ok: true };
      } else {
        const message = data.error ?? 'Login failed. Please check your credentials.';
        setError(message);
        return { ok: false, error: message };
      }
    } catch (e) {
      const message = 'Unable to reach the server. Please try again.';
      setError(message);
      return { ok: false, error: message };
    }
  }, []);

  // ── Logout ───────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (e) {
      console.warn('[AuthContext] Logout request failed:', e.message);
    } finally {
      setAuthenticated(false);
      setUser(null);
      setError(null);
    }
  }, []);

  // ── Context value ────────────────────────────────────────────────────────
  const value = {
    authenticated,
    user,
    mode,
    permissions,
    loading,
    error,
    login,
    logout,
    refresh,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Access auth state from any component inside <AuthProvider>.
 *
 * @example
 * const { authenticated, user, login, logout } = useAuth();
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an <AuthProvider>');
  }
  return ctx;
}

export default AuthContext;
