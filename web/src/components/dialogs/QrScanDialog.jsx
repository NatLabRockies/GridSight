/**
 * QrScanDialog — webcam QR scanner for joining a wall session.
 *
 * Point the camera at the QR shown in the wall's "Give Control" dialog. That
 * QR encodes `https://<wall-host>/control/<token>`, so once we decode a frame
 * we have both the host and the invite token — enough to redeem and join with
 * no typing. Decoding runs entirely client-side (jsQR over canvas frames); the
 * video stream never leaves the machine.
 *
 * On a desktop build (Tauri) the webview needs camera permission — macOS shows
 * its system prompt the first time, gated by NSCameraUsageDescription.
 */

import { useEffect, useRef, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import jsQR from 'jsqr';

import { parseControlUrl, decodeJoinCode } from '../../lib/stateBus.js';

/**
 * @param {object}   props
 * @param {boolean}  props.open
 * @param {() => void} props.onClose
 * @param {(code: {host: string, token: string}) => void} props.onDecode
 *        Called once with the extracted host+token when a usable QR is read.
 */
export default function QrScanDialog({ open, onClose, onDecode }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(0);
  const [status, setStatus] = useState('starting'); // starting | scanning | error
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setStatus('starting');
    setError(null);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      const video = videoRef.current;
      if (cancelled || !video) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(img.data, img.width, img.height, {
          inversionAttempts: 'dontInvert',
        });
        if (result?.data) {
          const code = parseControlUrl(result.data) || decodeJoinCode(result.data);
          if (code) {
            cancelled = true;
            onDecode(code);
            return;
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play();
        setStatus('scanning');
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setError(
          e?.name === 'NotAllowedError'
            ? 'Camera access was denied. Grant camera permission and try again, or enter the host + code manually.'
            : e?.name === 'NotFoundError'
              ? 'No camera was found on this device. Enter the host + code manually instead.'
              : `Could not start the camera: ${e?.message || e}`,
        );
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [open, onDecode]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Scan join QR</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Box
          sx={{
            position: 'relative',
            width: '100%',
            aspectRatio: '1 / 1',
            bgcolor: 'black',
            borderRadius: 1,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          {status === 'starting' && (
            <Box sx={{ position: 'absolute', color: 'white', textAlign: 'center' }}>
              <CircularProgress color="inherit" size={28} />
              <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
                Starting camera…
              </Typography>
            </Box>
          )}
          {status === 'scanning' && (
            <Box
              sx={{
                position: 'absolute',
                inset: '18%',
                border: '2px solid rgba(255,255,255,0.85)',
                borderRadius: 1,
                pointerEvents: 'none',
              }}
            />
          )}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          Point the camera at the QR code on the wall's “Give Control” screen.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
