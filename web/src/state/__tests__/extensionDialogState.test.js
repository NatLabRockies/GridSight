/**
 * Tests for the extension-dialog reducer — three dialog slots
 * (createScenario, busGeo, inspectSystem), each holding an extension
 * manifest or null.
 *
 * Pinned invariants:
 *   - opening one slot does not disturb the other two
 *   - closeAll clears all three (returns INITIAL)
 *   - close-one only nulls its own slot
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../extensionDialogState.js';

describe('extensionDialogState reducer', () => {
  it('initial state: all three dialog slots are null', () => {
    expect(INITIAL.createScenario).toBe(null);
    expect(INITIAL.busGeo).toBe(null);
    expect(INITIAL.inspectSystem).toBe(null);
  });

  it('set shallow-merges (escape hatch)', () => {
    const ext = { name: 'gat' };
    const next = reducer(INITIAL, { type: 'set', patch: { createScenario: ext } });
    expect(next.createScenario).toBe(ext);
    expect(next.busGeo).toBe(null);
    expect(next.inspectSystem).toBe(null);
  });

  it('openCreateScenario sets only the createScenario slot', () => {
    const ext = { name: 'gat' };
    const next = reducer(INITIAL, { type: 'openCreateScenario', ext });
    expect(next.createScenario).toBe(ext);
    expect(next.busGeo).toBe(null);
    expect(next.inspectSystem).toBe(null);
  });

  it('openBusGeo sets only the busGeo slot', () => {
    const ext = { name: 'demand-tldr' };
    const next = reducer(INITIAL, { type: 'openBusGeo', ext });
    expect(next.busGeo).toBe(ext);
    expect(next.createScenario).toBe(null);
    expect(next.inspectSystem).toBe(null);
  });

  it('openInspectSystem sets only the inspectSystem slot', () => {
    const ext = { name: 'gat' };
    const next = reducer(INITIAL, { type: 'openInspectSystem', ext });
    expect(next.inspectSystem).toBe(ext);
    expect(next.createScenario).toBe(null);
    expect(next.busGeo).toBe(null);
  });

  it('opening one slot does not clear another already-open slot', () => {
    const a = { name: 'a' };
    const b = { name: 'b' };
    let s = reducer(INITIAL, { type: 'openCreateScenario', ext: a });
    s = reducer(s, { type: 'openBusGeo', ext: b });
    expect(s.createScenario).toBe(a);
    expect(s.busGeo).toBe(b);
  });

  it('closeCreateScenario nulls only createScenario', () => {
    const prev = { createScenario: { name: 'a' }, busGeo: { name: 'b' }, inspectSystem: { name: 'c' } };
    const next = reducer(prev, { type: 'closeCreateScenario' });
    expect(next.createScenario).toBe(null);
    expect(next.busGeo).toEqual({ name: 'b' });
    expect(next.inspectSystem).toEqual({ name: 'c' });
  });

  it('closeBusGeo nulls only busGeo', () => {
    const prev = { createScenario: { name: 'a' }, busGeo: { name: 'b' }, inspectSystem: { name: 'c' } };
    const next = reducer(prev, { type: 'closeBusGeo' });
    expect(next.busGeo).toBe(null);
    expect(next.createScenario).toEqual({ name: 'a' });
    expect(next.inspectSystem).toEqual({ name: 'c' });
  });

  it('closeInspectSystem nulls only inspectSystem', () => {
    const prev = { createScenario: { name: 'a' }, busGeo: { name: 'b' }, inspectSystem: { name: 'c' } };
    const next = reducer(prev, { type: 'closeInspectSystem' });
    expect(next.inspectSystem).toBe(null);
    expect(next.createScenario).toEqual({ name: 'a' });
    expect(next.busGeo).toEqual({ name: 'b' });
  });

  it('closeAll clears every slot (returns INITIAL identity)', () => {
    const prev = { createScenario: { name: 'a' }, busGeo: { name: 'b' }, inspectSystem: { name: 'c' } };
    const next = reducer(prev, { type: 'closeAll' });
    expect(next).toBe(INITIAL);
  });

  it('reset returns INITIAL identity', () => {
    const prev = { createScenario: { name: 'a' }, busGeo: null, inspectSystem: null };
    expect(reducer(prev, { type: 'reset' })).toBe(INITIAL);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('happy path: open createScenario, close it, open inspectSystem, closeAll', () => {
    const a = { name: 'a' };
    const b = { name: 'b' };
    let s = INITIAL;
    s = reducer(s, { type: 'openCreateScenario', ext: a });
    expect(s.createScenario).toBe(a);
    s = reducer(s, { type: 'closeCreateScenario' });
    expect(s.createScenario).toBe(null);
    s = reducer(s, { type: 'openInspectSystem', ext: b });
    expect(s.inspectSystem).toBe(b);
    s = reducer(s, { type: 'closeAll' });
    expect(s).toBe(INITIAL);
  });
});
