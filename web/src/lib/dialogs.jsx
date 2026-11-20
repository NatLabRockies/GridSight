/**
 * dialogs.jsx — Promise-returning MUI dialog replacements for
 * `window.prompt` / `window.confirm` / `window.alert`.
 *
 * Why: Tauri's macOS WebKit WebView returns `null` / `false` immediately
 * from the three native dialog functions without ever showing UI. Every
 * call site that used them in Meridian (story create/delete, story
 * chapter add/overwrite/delete, perspective save/overwrite/delete, layer
 * delete confirm) silently no-ops on desktop. This module provides
 * portable replacements that work identically in browser and Tauri.
 *
 * Usage:
 *
 *   const prompt = usePrompt();
 *   const name = await prompt({ title: 'New story name', label: 'Name' });
 *   if (name == null) return;             // user cancelled
 *
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: 'Delete story?', message: 'Removes all chapters.',
 *     confirmText: 'Delete', destructive: true,
 *   });
 *   if (!ok) return;
 *
 *   const alert = useAlert();
 *   await alert({ title: 'Save failed', message: String(e) });
 *
 * Mount <DialogProvider> once high in the tree (we do this in main.jsx
 * inside AppProviders); every consumer below it can use the hooks.
 */

import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
} from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';

const DialogRequestContext = createContext(null);

/**
 * Provider — holds a FIFO queue of pending dialog requests so a click
 * that fires multiple at once still shows them one after the other
 * (rather than collapsing into a single visible dialog). In practice
 * the queue is almost always 0 or 1 long.
 */
export function DialogProvider({ children }) {
  const [queue, setQueue] = useState([]);
  const nextIdRef = useRef(1);

  const request = useCallback((kind, payload) => {
    return new Promise((resolve) => {
      const id = nextIdRef.current++;
      setQueue((q) => [...q, { id, kind, payload, resolve }]);
    });
  }, []);

  const close = useCallback((id, result) => {
    setQueue((q) => {
      const target = q.find((item) => item.id === id);
      if (target) target.resolve(result);
      return q.filter((item) => item.id !== id);
    });
  }, []);

  const head = queue[0] || null;
  const value = useMemo(() => ({ request }), [request]);

  return (
    <DialogRequestContext.Provider value={value}>
      {children}
      {head && (
        <DialogRenderer
          key={head.id}
          kind={head.kind}
          payload={head.payload}
          onClose={(result) => close(head.id, result)}
        />
      )}
    </DialogRequestContext.Provider>
  );
}

function useRequest() {
  const ctx = useContext(DialogRequestContext);
  if (!ctx) {
    throw new Error(
      '[dialogs] usePrompt/useConfirm/useAlert called outside <DialogProvider>. ' +
        'Mount the provider once near the root of the app (see main.jsx AppProviders).',
    );
  }
  return ctx.request;
}

/**
 * usePrompt() — returns ({ title, message?, label?, defaultValue?,
 *   confirmText?, cancelText?, multiline?, rows?, maxWidth?, minRows?,
 *   maxRows? }) => Promise<string | null>. Resolves with the trimmed input on
 *   confirm, or null on cancel / Esc. Pass maxWidth ('sm'|'md'|…) + minRows/
 *   maxRows for a roomy long-form editor that grows with its content.
 */
export function usePrompt() {
  const request = useRequest();
  return useCallback((payload = {}) => request('prompt', payload), [request]);
}

/**
 * useConfirm() — returns ({ title, message?, confirmText?, cancelText?,
 *   destructive? }) => Promise<boolean>.
 */
export function useConfirm() {
  const request = useRequest();
  return useCallback((payload = {}) => request('confirm', payload), [request]);
}

/**
 * useAlert() — returns ({ title?, message, confirmText? }) => Promise<void>.
 */
export function useAlert() {
  const request = useRequest();
  return useCallback((payload = {}) => request('alert', payload), [request]);
}

// ── Renderer ────────────────────────────────────────────────────────────────

function DialogRenderer({ kind, payload, onClose }) {
  if (kind === 'prompt')  return <PromptDialog  payload={payload} onClose={onClose} />;
  if (kind === 'confirm') return <ConfirmDialog payload={payload} onClose={onClose} />;
  if (kind === 'alert')   return <AlertDialog   payload={payload} onClose={onClose} />;
  // Unknown kind — release the request rather than block the queue.
  onClose(null);
  return null;
}

function PromptDialog({ payload, onClose }) {
  const {
    title = '',
    message = '',
    label = '',
    defaultValue = '',
    confirmText = 'OK',
    cancelText = 'Cancel',
    multiline = false,
    rows = 4,
    // Wider dialog + auto-growing textarea for long-form editors (e.g. the
    // story guiding prompt). When minRows/maxRows are given the field grows
    // with the content between those bounds instead of a fixed `rows` height.
    maxWidth = 'xs',
    minRows,
    maxRows,
  } = payload;
  const [value, setValue] = useState(defaultValue);
  const autoGrow = multiline && (minRows != null || maxRows != null);

  const submit = () => onClose(value.trim() === '' ? null : value.trim());

  return (
    <Dialog
      open
      onClose={() => onClose(null)}
      // Enter submits unless we're multiline (let newlines through).
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !multiline && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
      }}
      fullWidth
      maxWidth={maxWidth}
    >
      {title && <DialogTitle>{title}</DialogTitle>}
      <DialogContent>
        {message && (
          <DialogContentText sx={{ mb: 1.5, whiteSpace: 'pre-line' }}>
            {message}
          </DialogContentText>
        )}
        <TextField
          autoFocus
          fullWidth
          size="small"
          variant="outlined"
          label={label || undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          multiline={multiline}
          {...(multiline
            ? (autoGrow ? { minRows: minRows ?? 6, maxRows } : { rows })
            : {})}
          // Native autocomplete is unwanted for one-off names.
          autoComplete="off"
          spellCheck={false}
          // DialogContent zeroes its top padding when it follows a
          // DialogTitle. The outlined TextField's floating label sits
          // ABOVE the input border, so without this margin its top half
          // gets clipped by the dialog header.
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(null)}>{cancelText}</Button>
        <Button onClick={submit} variant="contained" disabled={value.trim() === ''}>
          {confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ConfirmDialog({ payload, onClose }) {
  const {
    title = 'Confirm',
    message = '',
    confirmText = 'OK',
    cancelText = 'Cancel',
    destructive = false,
  } = payload;
  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      fullWidth
      maxWidth="xs"
      // Enter confirms, Esc cancels — match native dialog ergonomics.
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onClose(true); }
      }}
    >
      <DialogTitle>{title}</DialogTitle>
      {message && (
        <DialogContent>
          <DialogContentText sx={{ whiteSpace: 'pre-line' }}>
            {message}
          </DialogContentText>
        </DialogContent>
      )}
      <DialogActions>
        <Button onClick={() => onClose(false)}>{cancelText}</Button>
        <Button
          onClick={() => onClose(true)}
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          autoFocus
        >
          {confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AlertDialog({ payload, onClose }) {
  const {
    title = '',
    message = '',
    confirmText = 'OK',
  } = payload;
  return (
    <Dialog
      open
      onClose={() => onClose()}
      fullWidth
      maxWidth="xs"
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onClose(); }
      }}
    >
      {title && <DialogTitle>{title}</DialogTitle>}
      <DialogContent>
        <DialogContentText sx={{ whiteSpace: 'pre-line' }}>
          {message}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose()} variant="contained" autoFocus>
          {confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Stub export so a future test can mount the provider in isolation.
export const __test__ = { DialogRenderer };
