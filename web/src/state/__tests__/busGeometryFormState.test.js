/**
 * Tests for the bus-geometry form reducer. The key invariant is
 * `clearPreview` zeroing BOTH `preview` and `previewError` in a
 * single action — the UI relies on these clearing together.
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../busGeometryFormState.js';

describe('busGeometryFormState reducer', () => {
  it('initial state has empty file selection and column mappings', () => {
    expect(INITIAL.spec).toBe(null);
    expect(INITIAL.loadingSpec).toBe(false);
    expect(INITIAL.file).toBe(null);
    expect(INITIAL.preview).toBe(null);
    expect(INITIAL.previewing).toBe(false);
    expect(INITIAL.previewError).toBe('');
    expect(INITIAL.busIdCol).toBe('');
    expect(INITIAL.latCol).toBe('');
    expect(INITIAL.lonCol).toBe('');
    expect(INITIAL.systemBusIdCol).toBe('');
    expect(INITIAL.reMatching).toBe(false);
  });

  it('set merges only the listed keys', () => {
    const next = reducer(INITIAL, {
      type: 'set',
      patch: { busIdCol: 'id', latCol: 'lat' },
    });
    expect(next.busIdCol).toBe('id');
    expect(next.latCol).toBe('lat');
    expect(next.lonCol).toBe('');
  });

  it('set can store a preview object', () => {
    const preview = { rows: [{ a: 1 }], columns: ['a'] };
    const next = reducer(INITIAL, { type: 'set', patch: { preview } });
    expect(next.preview).toBe(preview);
  });

  it('set can flip previewing flag', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { previewing: true } });
    expect(next.previewing).toBe(true);
  });

  it('set can record a previewError', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { previewError: 'bad columns' } });
    expect(next.previewError).toBe('bad columns');
  });

  it('clearPreview clears BOTH preview and previewError in one go', () => {
    const dirty = {
      ...INITIAL,
      preview: { rows: [] },
      previewError: 'something went wrong',
      busIdCol: 'id',  // unrelated field, must be preserved
    };
    const next = reducer(dirty, { type: 'clearPreview' });
    expect(next.preview).toBe(null);
    expect(next.previewError).toBe('');
    expect(next.busIdCol).toBe('id');
  });

  it('clearPreview preserves all other fields', () => {
    const dirty = {
      ...INITIAL,
      file: { name: 'x.csv' },
      latCol: 'latitude', lonCol: 'longitude',
      previewing: true,
      preview: { rows: [1] },
      previewError: 'oops',
    };
    const next = reducer(dirty, { type: 'clearPreview' });
    expect(next.file).toEqual({ name: 'x.csv' });
    expect(next.latCol).toBe('latitude');
    expect(next.lonCol).toBe('longitude');
    expect(next.previewing).toBe(true);
  });

  it('clearPreview on already-clear state still returns a fresh object', () => {
    const next = reducer(INITIAL, { type: 'clearPreview' });
    expect(next).not.toBe(INITIAL);
    expect(next.preview).toBe(null);
    expect(next.previewError).toBe('');
  });

  it('reset returns INITIAL identity from dirty state', () => {
    const dirty = {
      ...INITIAL,
      file: { name: 'foo' }, busIdCol: 'x', latCol: 'y', lonCol: 'z',
      preview: { rows: [] }, previewing: true, previewError: 'err',
      reMatching: true,
    };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('set can flip reMatching', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { reMatching: true } });
    expect(next.reMatching).toBe(true);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('set returns a new object reference', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { busIdCol: 'x' } });
    expect(next).not.toBe(INITIAL);
  });

  it('happy path: file → preview → clearPreview → reset', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'set', patch: { file: { name: 'g.csv' } } });
    s = reducer(s, { type: 'set', patch: { previewing: true } });
    s = reducer(s, { type: 'set', patch: { preview: { rows: [1, 2] }, previewing: false } });
    expect(s.preview).toEqual({ rows: [1, 2] });
    s = reducer(s, { type: 'clearPreview' });
    expect(s.preview).toBe(null);
    s = reducer(s, { type: 'reset' });
    expect(s).toBe(INITIAL);
  });
});
