import { useEffect } from 'react';

/**
 * Apply a new deck.gl layer list at once, in interleaved mode.
 *
 * deck.gl applies new layers only in its own animation-frame callback
 * (Deck._onRenderFrame -> layerManager.updateLayers). MapLibre draws the
 * layers that the layer manager already has. When that callback does not
 * run (seen after story chapter changes), the map keeps drawing the old
 * layers, or none, until something else starts a frame, e.g. toggling a
 * layer. So after each layer change: apply the pending layers now and ask
 * MapLibre to repaint.
 *
 * @param {object} overlay - the MapboxOverlay from useControl
 * @param {Array} layers - the deck.gl layers passed to the overlay
 */
export function useApplyDeckLayers(overlay, layers) {
  useEffect(() => {
    const deck = overlay?._deck;
    const lm = deck?.layerManager;
    if (!lm?.needsUpdate?.()) return;
    try {
      lm.updateLayers();
      overlay._map?.triggerRepaint();
      if (typeof window !== 'undefined') window.__gsLayerApplies = (window.__gsLayerApplies || 0) + 1;
    } catch (e) {
      console.error('[deck] applying layers failed:', e);
    }
  }, [overlay, layers]);
}
