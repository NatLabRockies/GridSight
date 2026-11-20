/**
 * useClockUIState — *display* knobs for the on-canvas clock overlay
 * (position, font size, color).
 *
 * Distinct from ``clockState`` / ``useClockEngine``: that hook owns
 * the animation index, frequency, timestamps array, etc. This one is
 * pure UI.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  position: { x: 700, y: 175 },
  fontSize: 28,
  color: '#f0f0f0',
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':         return { ...state, ...action.patch };
    case 'setPosition': return { ...state, position: action.position };
    case 'setFontSize': return { ...state, fontSize: action.fontSize };
    case 'setColor':    return { ...state, color: action.color };
    case 'reset':       return INITIAL;
    default:            return state;
  }
}

export function useClockUIState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const setPosition = useCallback(
    (position) => dispatch({ type: 'setPosition', position }), [],
  );
  const setFontSize = useCallback(
    (fontSize) => dispatch({ type: 'setFontSize', fontSize }), [],
  );
  const setColor = useCallback(
    (color) => dispatch({ type: 'setColor', color }), [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  return { state, patch, setPosition, setFontSize, setColor, reset };
}
