/**
 * Tests for the chat-panel reducer. Initial state is arg-driven.
 * The message-list mutations (append / replace / updateLast) need
 * to be safe when messages is empty — pin the no-op behavior.
 */
import { describe, it, expect } from 'vitest';
import { reducer, makeInitial } from '../chatPanelState.js';

describe('chatPanelState reducer', () => {
  it('makeInitial uses defaults when called without args', () => {
    const s = makeInitial();
    expect(s.messages).toEqual([]);
    expect(s.input).toBe('');
    expect(s.loading).toBe(false);
    expect(s.chatConfig).toBe(null);
    expect(s.providerGroups).toEqual([]);
    expect(s.selectedModel).toBe('');
    expect(s.thinkingLevel).toBe(0);
    expect(s.pendingImages).toEqual([]);
  });

  it('makeInitial honors selectedModel and thinkingLevel opts', () => {
    const s = makeInitial({ selectedModel: 'gpt-oss:20B', thinkingLevel: 2 });
    expect(s.selectedModel).toBe('gpt-oss:20B');
    expect(s.thinkingLevel).toBe(2);
  });

  it('set merges patch shallowly', () => {
    const init = makeInitial();
    const next = reducer(init, { type: 'set', patch: { input: 'hello', loading: true } });
    expect(next.input).toBe('hello');
    expect(next.loading).toBe(true);
    expect(next.messages).toEqual([]);
  });

  it('reset returns whatever initial the action carries', () => {
    const init = makeInitial({ selectedModel: 'foo' });
    const dirty = { ...init, input: 'typed', messages: [{ role: 'user' }] };
    const next = reducer(dirty, { type: 'reset', initial: init });
    expect(next).toBe(init);
  });

  it('appendMessage adds to end of messages', () => {
    const init = makeInitial();
    const next = reducer(init, {
      type: 'appendMessage',
      message: { role: 'user', content: 'hi' },
    });
    expect(next.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('appendMessage twice yields ordered list', () => {
    let s = makeInitial();
    s = reducer(s, { type: 'appendMessage', message: { role: 'user', content: 'a' } });
    s = reducer(s, { type: 'appendMessage', message: { role: 'assistant', content: 'b' } });
    expect(s.messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });

  it('replaceMessages replaces the entire list', () => {
    const init = { ...makeInitial(), messages: [{ role: 'user' }] };
    const next = reducer(init, {
      type: 'replaceMessages',
      value: [{ role: 'system' }],
    });
    expect(next.messages).toEqual([{ role: 'system' }]);
  });

  it('updateLastMessage on empty array is a no-op (returns same state)', () => {
    const init = makeInitial();
    const next = reducer(init, { type: 'updateLastMessage', patch: { content: 'x' } });
    expect(next).toBe(init);
  });

  it('updateLastMessage patches the last entry only', () => {
    const init = {
      ...makeInitial(),
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'partial' },
      ],
    };
    const next = reducer(init, {
      type: 'updateLastMessage',
      patch: { content: 'complete' },
    });
    expect(next.messages[0]).toEqual({ role: 'user', content: 'q' });
    expect(next.messages[1]).toEqual({ role: 'assistant', content: 'complete' });
  });

  it('updateLastMessage merges new fields without removing old ones', () => {
    const init = {
      ...makeInitial(),
      messages: [{ role: 'assistant', content: 'hi', tokens: 5 }],
    };
    const next = reducer(init, {
      type: 'updateLastMessage',
      patch: { content: 'hi there' },
    });
    expect(next.messages[0]).toEqual({ role: 'assistant', content: 'hi there', tokens: 5 });
  });

  it('appendImage adds to pendingImages', () => {
    const init = makeInitial();
    const img = { dataUrl: 'data:image/png;base64,...' };
    const next = reducer(init, { type: 'appendImage', image: img });
    expect(next.pendingImages).toEqual([img]);
  });

  it('removeImage removes by index', () => {
    const init = {
      ...makeInitial(),
      pendingImages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    };
    const next = reducer(init, { type: 'removeImage', index: 1 });
    expect(next.pendingImages).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('removeImage with out-of-range index leaves array unchanged in content', () => {
    const init = { ...makeInitial(), pendingImages: [{ id: 'a' }] };
    const next = reducer(init, { type: 'removeImage', index: 99 });
    expect(next.pendingImages).toEqual([{ id: 'a' }]);
  });

  it('clearImages empties pendingImages', () => {
    const init = { ...makeInitial(), pendingImages: [{ id: 'a' }, { id: 'b' }] };
    const next = reducer(init, { type: 'clearImages' });
    expect(next.pendingImages).toEqual([]);
  });

  it('unknown action returns same state reference', () => {
    const init = makeInitial();
    expect(reducer(init, { type: 'noop' })).toBe(init);
  });

  it('append → updateLast streaming pattern', () => {
    let s = makeInitial();
    s = reducer(s, { type: 'appendMessage', message: { role: 'assistant', content: '' } });
    s = reducer(s, { type: 'updateLastMessage', patch: { content: 'Hel' } });
    s = reducer(s, { type: 'updateLastMessage', patch: { content: 'Hello' } });
    expect(s.messages).toEqual([{ role: 'assistant', content: 'Hello' }]);
  });
});
