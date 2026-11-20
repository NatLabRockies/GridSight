/**
 * useChatPanelState — chat history, input draft, generation flags,
 * and model/provider configuration for the ChatPanel.
 *
 * NOT included (intentionally kept as plain useState in the
 * component):
 *   - mirrorMenuAnchor: ephemeral DOM ref, no business logic
 *   - conversationId: immutable, computed once at mount
 */
import { useCallback, useReducer } from 'react';

export function makeInitial({ selectedModel = '', thinkingLevel = 0 } = {}) {
  return {
    messages: [],
    input: '',
    loading: false,
    chatConfig: null,
    providerGroups: [],
    selectedModel,
    thinkingLevel,
    pendingImages: [],
  };
}

export function reducer(state, action) {
  switch (action.type) {
    case 'set':              return { ...state, ...action.patch };
    case 'reset':            return action.initial;

    case 'appendMessage':    return { ...state, messages: [...state.messages, action.message] };
    case 'replaceMessages':  return { ...state, messages: action.value };
    case 'updateLastMessage':
      // Used by streaming code paths to mutate the in-flight assistant
      // message. Replaces the LAST message with a patched version.
      if (state.messages.length === 0) return state;
      return {
        ...state,
        messages: [
          ...state.messages.slice(0, -1),
          { ...state.messages[state.messages.length - 1], ...action.patch },
        ],
      };

    case 'appendImage':      return { ...state, pendingImages: [...state.pendingImages, action.image] };
    case 'removeImage':
      return { ...state, pendingImages: state.pendingImages.filter((_, i) => i !== action.index) };
    case 'clearImages':      return { ...state, pendingImages: [] };

    default:                 return state;
  }
}

export function useChatPanelState(opts = {}) {
  const initial = makeInitial(opts);
  const [state, dispatch] = useReducer(reducer, initial);

  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const reset = useCallback(() => dispatch({ type: 'reset', initial }), [initial]);

  const setInput = useCallback((input) => patch({ input }), [patch]);
  const setLoading = useCallback((loading) => patch({ loading: !!loading }), [patch]);
  const setChatConfig = useCallback((chatConfig) => patch({ chatConfig }), [patch]);
  const setProviderGroups = useCallback((providerGroups) => patch({ providerGroups }), [patch]);
  const setSelectedModel = useCallback((selectedModel) => patch({ selectedModel }), [patch]);
  const setThinkingLevel = useCallback((thinkingLevel) => patch({ thinkingLevel }), [patch]);

  const appendMessage = useCallback((message) => dispatch({ type: 'appendMessage', message }), []);
  const replaceMessages = useCallback(
    (value) => dispatch({ type: 'replaceMessages', value }), [],
  );
  const updateLastMessage = useCallback(
    (p) => dispatch({ type: 'updateLastMessage', patch: p }), [],
  );
  const setMessages = useCallback(
    (value) => dispatch(
      typeof value === 'function'
        ? { type: 'set', patch: { messages: value(state.messages) } }
        : { type: 'replaceMessages', value },
    ),
    [state.messages],
  );
  const appendImage = useCallback((image) => dispatch({ type: 'appendImage', image }), []);
  const removeImage = useCallback((index) => dispatch({ type: 'removeImage', index }), []);
  const clearImages = useCallback(() => dispatch({ type: 'clearImages' }), []);

  return {
    state, patch, reset,
    setInput, setLoading, setChatConfig, setProviderGroups,
    setSelectedModel, setThinkingLevel,
    appendMessage, replaceMessages, updateLastMessage, setMessages,
    appendImage, removeImage, clearImages,
  };
}
