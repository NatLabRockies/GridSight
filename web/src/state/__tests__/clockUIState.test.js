/**
 * Tests for the clock-overlay UI reducer — just display knobs (position,
 * font size, color). No invariants beyond "the named setter writes its
 * field and nothing else".
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../clockUIState.js';

describe('clockUIState reducer', () => {
  it('initial state has default position, fontSize, and color', () => {
    expect(INITIAL.position).toEqual({ x: 700, y: 175 });
    expect(INITIAL.fontSize).toBe(28);
    expect(INITIAL.color).toBe('#f0f0f0');
  });

  it('set shallow-merges an arbitrary patch', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { fontSize: 40, color: '#000' } });
    expect(next.fontSize).toBe(40);
    expect(next.color).toBe('#000');
    expect(next.position).toEqual({ x: 700, y: 175 });
  });

  it('setPosition writes the position object whole', () => {
    const pos = { x: 100, y: 200 };
    const next = reducer(INITIAL, { type: 'setPosition', position: pos });
    expect(next.position).toBe(pos);
    expect(next.fontSize).toBe(28);
    expect(next.color).toBe('#f0f0f0');
  });

  it('setFontSize writes only the font size', () => {
    const next = reducer(INITIAL, { type: 'setFontSize', fontSize: 64 });
    expect(next.fontSize).toBe(64);
    expect(next.position).toEqual({ x: 700, y: 175 });
    expect(next.color).toBe('#f0f0f0');
  });

  it('setColor writes only the color', () => {
    const next = reducer(INITIAL, { type: 'setColor', color: '#ff0000' });
    expect(next.color).toBe('#ff0000');
    expect(next.fontSize).toBe(28);
  });

  it('reset returns INITIAL identity', () => {
    const dirty = { position: { x: 0, y: 0 }, fontSize: 99, color: '#abc' };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('set with empty patch produces an equal-but-new state', () => {
    const next = reducer(INITIAL, { type: 'set', patch: {} });
    expect(next).toEqual(INITIAL);
    expect(next).not.toBe(INITIAL);
  });

  it('setPosition does not mutate the previous position object', () => {
    const prev = { ...INITIAL };
    const prevPos = prev.position;
    reducer(prev, { type: 'setPosition', position: { x: 1, y: 2 } });
    expect(prev.position).toBe(prevPos);
    expect(prev.position).toEqual({ x: 700, y: 175 });
  });

  it('happy path: drag (setPosition) then style (setFontSize, setColor)', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'setPosition', position: { x: 500, y: 500 } });
    s = reducer(s, { type: 'setFontSize', fontSize: 36 });
    s = reducer(s, { type: 'setColor', color: '#00ff00' });
    expect(s.position).toEqual({ x: 500, y: 500 });
    expect(s.fontSize).toBe(36);
    expect(s.color).toBe('#00ff00');
    s = reducer(s, { type: 'reset' });
    expect(s).toBe(INITIAL);
  });
});
