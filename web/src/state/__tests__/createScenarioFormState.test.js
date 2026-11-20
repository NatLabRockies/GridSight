/**
 * Tests for the create-scenario form reducer. Trivial set/reset
 * surface, but pinning the merge semantics prevents future
 * refactors from accidentally replacing the entire state.
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../createScenarioFormState.js';

describe('createScenarioFormState reducer', () => {
  it('initial state has empty form fields and default upload mode', () => {
    expect(INITIAL.spec).toBe(null);
    expect(INITIAL.loadingSpec).toBe(false);
    expect(INITIAL.projectName).toBe('');
    expect(INITIAL.scenarioName).toBe('');
    expect(INITIAL.description).toBe('');
    expect(INITIAL.systemMode).toBe('upload');
    expect(INITIAL.systemFile).toBe(null);
    expect(INITIAL.existingSystemPath).toBe('');
    expect(INITIAL.simFiles).toEqual([]);
  });

  it('set merges only the listed keys, leaving others alone', () => {
    const next = reducer(INITIAL, {
      type: 'set',
      patch: { projectName: 'Alpha', scenarioName: 'Beta' },
    });
    expect(next.projectName).toBe('Alpha');
    expect(next.scenarioName).toBe('Beta');
    expect(next.description).toBe('');
    expect(next.systemMode).toBe('upload');
  });

  it('set overwrites a previously set value', () => {
    const prev = { ...INITIAL, projectName: 'Old' };
    const next = reducer(prev, { type: 'set', patch: { projectName: 'New' } });
    expect(next.projectName).toBe('New');
  });

  it('set with empty patch returns equal state (shallow merge no-op)', () => {
    const next = reducer(INITIAL, { type: 'set', patch: {} });
    expect(next).toEqual(INITIAL);
  });

  it('set can flip systemMode to existing', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { systemMode: 'existing' } });
    expect(next.systemMode).toBe('existing');
  });

  it('set can store a File-like value for systemFile', () => {
    const fakeFile = { name: 'system.json', size: 123 };
    const next = reducer(INITIAL, { type: 'set', patch: { systemFile: fakeFile } });
    expect(next.systemFile).toBe(fakeFile);
  });

  it('set can store an array of sim files', () => {
    const files = [{ name: 'a.csv' }, { name: 'b.csv' }];
    const next = reducer(INITIAL, { type: 'set', patch: { simFiles: files } });
    expect(next.simFiles).toEqual(files);
  });

  it('set can update spec to an object', () => {
    const spec = { foo: 'bar' };
    const next = reducer(INITIAL, { type: 'set', patch: { spec } });
    expect(next.spec).toBe(spec);
  });

  it('set with multiple keys produces a single merged state', () => {
    const next = reducer(INITIAL, {
      type: 'set',
      patch: {
        projectName: 'P',
        scenarioName: 'S',
        description: 'D',
        systemMode: 'existing',
        existingSystemPath: '/foo',
      },
    });
    expect(next.projectName).toBe('P');
    expect(next.scenarioName).toBe('S');
    expect(next.description).toBe('D');
    expect(next.systemMode).toBe('existing');
    expect(next.existingSystemPath).toBe('/foo');
  });

  it('reset returns INITIAL identity from any dirty state', () => {
    const dirty = {
      ...INITIAL,
      projectName: 'X', scenarioName: 'Y', description: 'Z',
      systemMode: 'existing', existingSystemPath: '/p', simFiles: [{}],
    };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('set returns a new object reference (immutability)', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { projectName: 'X' } });
    expect(next).not.toBe(INITIAL);
  });
});
