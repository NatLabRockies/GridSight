/**
 * Tests for the upload-progress state machine reducer.
 *
 * The reducer is the single place that enforces "starting an upload
 * clears the previous error", "success clears saving + message",
 * etc. — these are the regressions a future careless dispatch could
 * reintroduce. Pin every transition.
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../uploadProgressState.js';

describe('uploadProgressState reducer', () => {
  it('initial state is idle', () => {
    expect(INITIAL.phase).toBe(null);
    expect(INITIAL.loaded).toBe(0);
    expect(INITIAL.total).toBe(0);
    expect(INITIAL.saving).toBe(false);
    expect(INITIAL.error).toBe('');
    expect(INITIAL.message).toBe('');
    expect(INITIAL.rateBytesPerSec).toBe(0);
  });

  it('startUploading zeros byte counts and clears previous error', () => {
    const prev = { ...INITIAL, phase: 'error', error: 'old fail', loaded: 100, total: 200 };
    const next = reducer(prev, { type: 'startUploading' });
    expect(next.phase).toBe('uploading');
    expect(next.saving).toBe(true);
    expect(next.error).toBe('');
    expect(next.loaded).toBe(0);
    expect(next.total).toBe(0);
    expect(next.message).toBe('Uploading files…');
  });

  it('startUploading accepts a custom message', () => {
    const next = reducer(INITIAL, { type: 'startUploading', message: 'Sending…' });
    expect(next.message).toBe('Sending…');
  });

  it('uploadProgress updates byte counts without changing phase', () => {
    const prev = { ...INITIAL, phase: 'uploading', saving: true };
    const next = reducer(prev, { type: 'uploadProgress', loaded: 50, total: 100 });
    expect(next.phase).toBe('uploading');
    expect(next.loaded).toBe(50);
    expect(next.total).toBe(100);
    expect(next.saving).toBe(true);
  });

  it('rate update is independent of phase', () => {
    const prev = { ...INITIAL, phase: 'uploading' };
    const next = reducer(prev, { type: 'rate', rateBytesPerSec: 12345 });
    expect(next.rateBytesPerSec).toBe(12345);
    expect(next.phase).toBe('uploading');
  });

  it('pending sets phase and default message', () => {
    const prev = { ...INITIAL, phase: 'uploading' };
    const next = reducer(prev, { type: 'pending' });
    expect(next.phase).toBe('pending');
    expect(next.message).toBe('Queued on server…');
  });

  it('running carries a custom message', () => {
    const next = reducer(INITIAL, { type: 'running', message: 'Ingesting… (12s)' });
    expect(next.phase).toBe('running');
    expect(next.message).toBe('Ingesting… (12s)');
  });

  it('success clears saving, message, and error', () => {
    const prev = { ...INITIAL, phase: 'running', saving: true, message: 'busy', error: '' };
    const next = reducer(prev, { type: 'success' });
    expect(next.phase).toBe('success');
    expect(next.saving).toBe(false);
    expect(next.message).toBe('');
    expect(next.error).toBe('');
  });

  it('error sets error, clears saving, falls back to default message', () => {
    const prev = { ...INITIAL, phase: 'uploading', saving: true };
    const next = reducer(prev, { type: 'error', error: 'boom' });
    expect(next.phase).toBe('error');
    expect(next.error).toBe('boom');
    expect(next.saving).toBe(false);
    expect(next.message).toBe('');
  });

  it('error with empty error string falls back to default text', () => {
    const next = reducer(INITIAL, { type: 'error', error: '' });
    expect(next.error).toBe('Upload failed.');
  });

  it('reset returns to INITIAL identity', () => {
    const dirty = {
      phase: 'error', loaded: 9, total: 10, rateBytesPerSec: 5,
      message: 'x', error: 'y', saving: true,
    };
    expect(reducer(dirty, { type: 'reset' })).toEqual(INITIAL);
  });

  it('set is an escape hatch that does shallow merge', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { saving: true, message: 'hi' } });
    expect(next.saving).toBe(true);
    expect(next.message).toBe('hi');
    // unmentioned fields preserved
    expect(next.phase).toBe(null);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('full happy path: idle → uploading → pending → running → success', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'startUploading' });
    expect(s.phase).toBe('uploading');
    s = reducer(s, { type: 'uploadProgress', loaded: 100, total: 100 });
    s = reducer(s, { type: 'pending' });
    expect(s.phase).toBe('pending');
    s = reducer(s, { type: 'running', message: 'Working…' });
    expect(s.phase).toBe('running');
    s = reducer(s, { type: 'success' });
    expect(s.phase).toBe('success');
    expect(s.saving).toBe(false);
  });

  it('failure path: uploading → error preserves byte counts for debugging', () => {
    let s = reducer(INITIAL, { type: 'startUploading' });
    s = reducer(s, { type: 'uploadProgress', loaded: 42, total: 100 });
    s = reducer(s, { type: 'error', error: 'net down' });
    expect(s.phase).toBe('error');
    expect(s.loaded).toBe(42);  // not reset — useful for "uploaded 42% then failed" displays
    expect(s.total).toBe(100);
  });
});
