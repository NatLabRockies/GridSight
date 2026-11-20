/**
 * captureView — render what the user sees (map + deck.gl layers + panels)
 * into one PNG, so that an agent can look at the app (MCP `capture_view`).
 *
 * The map is a WebGL canvas (MapLibre with deck.gl interleaved into the same
 * context). Its drawing buffer is cleared after each frame, so the map is
 * read inside MapLibre's 'render' event, right after a forced repaint. The
 * HTML on top (panels, charts, legends, clock) is rendered with
 * html-to-image, skipping the map canvas, and drawn over the map.
 */
import { toCanvas } from 'html-to-image';

function mapSnapshot(map, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!map) { resolve(null); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const canvas = map.getCanvas();
    map.once('render', () => {
      try {
        const img = document.createElement('canvas');
        img.width = canvas.width;
        img.height = canvas.height;
        img.getContext('2d').drawImage(canvas, 0, 0);
        finish({ canvas: img, rect: canvas.getBoundingClientRect() });
      } catch (e) {
        finish({ error: String(e) });
      }
    });
    map.triggerRepaint();
    // A background window does not repaint (requestAnimationFrame is
    // paused), so the 'render' event above never fires. Force one
    // synchronous frame with redraw(), then copy the canvas (the map keeps
    // its last frame: preserveDrawingBuffer).
    setTimeout(() => {
      try { map.redraw?.(); } catch { /* fall back to the last frame */ }
      try {
        const img = document.createElement('canvas');
        img.width = canvas.width;
        img.height = canvas.height;
        img.getContext('2d').drawImage(canvas, 0, 0);
        finish({ canvas: img, rect: canvas.getBoundingClientRect(), forced: true });
      } catch (e) {
        finish({ error: `map did not render in time (${e})` });
      }
    }, timeoutMs);
  });
}

/**
 * @param {object} opts
 * @param {object} opts.map           MapLibre map instance (may be null)
 * @param {boolean} [opts.includeUi]  draw the HTML panels over the map
 * @param {number} [opts.maxWidth]    scale the result down to this width
 * @returns {Promise<{png: string, width: number, height: number, notes: string[]}>}
 *          png is base64 without the data: prefix
 */
export async function captureView({ map, includeUi = true, maxWidth = 1600 } = {}) {
  const notes = [];
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(dpr, maxWidth / W);

  const out = document.createElement('canvas');
  out.width = Math.round(W * scale);
  out.height = Math.round(H * scale);
  const ctx = out.getContext('2d');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#111';
  ctx.fillRect(0, 0, out.width, out.height);

  const snap = await mapSnapshot(map);
  if (snap?.canvas) {
    if (snap.forced) notes.push('map: forced redraw (the window is in the background; animations and new data may lag)');
    const r = snap.rect;
    ctx.drawImage(snap.canvas, r.left * scale, r.top * scale, r.width * scale, r.height * scale);
  } else if (snap?.error) {
    notes.push(`map: ${snap.error}`);
  } else {
    notes.push('map: no map instance');
  }

  if (includeUi) {
    const mapCanvas = map?.getCanvas?.();
    // The map's ancestors (map container, app shell, body) have opaque
    // backgrounds that would hide the map in the panel image. Make them
    // transparent for the capture only, then restore them.
    const restored = [];
    for (let el = mapCanvas?.parentElement; el; el = el.parentElement) {
      restored.push([el, el.style.background]);
      el.style.background = 'transparent';
    }
    try {
      const t0 = performance.now();
      const ui = await Promise.race([
        toCanvas(document.body, {
          pixelRatio: scale,
          width: W,
          height: H,
          backgroundColor: 'transparent',
          cacheBust: false,
          // Embedding web fonts re-fetches every @font-face file, which can
          // hang behind the desktop protocol handler; system fallback fonts
          // are fine for an agent's screenshot.
          skipFonts: true,
          imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
          // The map is drawn above; WebGL canvases come out blank here anyway.
          filter: (node) => !(node instanceof HTMLCanvasElement && node === mapCanvas),
        }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('panel capture timed out after 12 s')), 12000)),
      ]);
      ctx.drawImage(ui, 0, 0, out.width, out.height);
      notes.push(`panels: ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      notes.push(`panels: ${String(e?.message || e)}`);
    } finally {
      for (const [el, bg] of restored) el.style.background = bg;
    }
  }

  // Health facts an agent cannot see in the picture: a lost WebGL context
  // or a basemap style that never finished loading both freeze the map
  // canvas on its last frame, so the image looks normal but is stale.
  try {
    const gl = map?.painter?.context?.gl ?? map?.getCanvas?.()?.getContext?.('webgl2');
    const health = {
      contextLost: gl?.isContextLost?.() ?? null,
      styleLoaded: map?.isStyleLoaded?.() ?? null,
      tilesLoaded: map?.areTilesLoaded?.() ?? null,
      moving: map?.isMoving?.() ?? null,
      center: map ? map.getCenter().toArray().map((v) => +v.toFixed(3)) : null,
      zoom: map ? +map.getZoom().toFixed(2) : null,
      deckLayersMissing: map
        ? (window.__gsDeckLayers || []).filter((l) => l && !map.getLayer(l.id)).length
        : null,
    };
    if (health.deckLayersMissing) notes.push(`map: ${health.deckLayersMissing} data layer(s) are not attached to the map and do not draw`);
    if (health.contextLost) notes.push('map: WebGL CONTEXT LOST; the map is frozen. Reload the window.');
    if (health.styleLoaded === false) notes.push('map: basemap style not loaded');
    notes.push(`map health: ${JSON.stringify(health)}`);
  } catch (e) {
    notes.push(`map health: unavailable (${e?.message || e})`);
  }

  const dataUrl = out.toDataURL('image/png');
  return {
    png: dataUrl.slice(dataUrl.indexOf(',') + 1),
    width: out.width,
    height: out.height,
    notes,
  };
}
