import React, { useEffect, useRef, useState } from 'react';
import { viewportDebugEnabled, subscribeViewportDebug, setViewportDebug } from '../../lib/viewportDebug.js';
import { applyVerticalFillMinZoom } from '../../lib/mapCamera.js';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';

/**
 * ViewportDebugHUD — a tiny always-on-top panel for diagnosing large-display
 * camera/sync issues. Renders nothing unless `?debugViewport=1` (or
 * setViewportDebug(true)) is active. Shows the live camera, the container
 * size + device pixel ratio + display scale, the enforced minZoom, and the
 * last viewport message published/received over the bus.
 *
 * @param {{ mapRef: React.RefObject<any> }} props
 */
export default function ViewportDebugHUD({ mapRef }) {
  const enabled = viewportDebugEnabled();
  const { scale, mode } = useDisplayScale();
  const [, force] = useState(0);
  const liveRef = useRef({});

  // Poll the live MapLibre handle (the MapView is uncontrolled, so React
  // state doesn't reflect user pan/zoom).
  useEffect(() => {
    if (!enabled) return undefined;
    let raf = 0;
    const tick = () => {
      const m = mapRef?.current?.getMap?.();
      if (m) {
        const c = m.getCenter();
        const container = m.getContainer?.();
        liveRef.current = {
          lat: c.lat,
          lng: c.lng,
          zoom: m.getZoom(),
          minZoom: m.getMinZoom?.(),
          maxZoom: m.getMaxZoom?.(),
          cw: container?.clientWidth,
          ch: container?.clientHeight,
        };
      }
      force((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, mapRef]);

  const [bus, setBus] = useState({});
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeViewportDebug((snap) => setBus({ ...snap }));
  }, [enabled]);

  if (!enabled) return null;

  const L = liveRef.current;
  const fmt = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
  const pub = bus.publish;
  const recv = bus.receive;

  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span>{value}</span>
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        left: 8,
        zIndex: 4000,
        font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#d7ffd7',
        background: 'rgba(0,0,0,0.78)',
        border: '1px solid rgba(120,255,120,0.35)',
        borderRadius: 6,
        padding: '8px 10px',
        minWidth: 230,
        pointerEvents: 'auto',
        userSelect: 'text',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong style={{ color: '#9f9' }}>viewport debug</strong>
        <button
          onClick={() => setViewportDebug(false)}
          style={{ background: 'transparent', color: '#9f9', border: 0, cursor: 'pointer', fontSize: 12 }}
          title="Disable debug overlay"
        >×</button>
      </div>
      {row('lat / lng', `${fmt(L.lat)}, ${fmt(L.lng)}`)}
      {row('zoom', `${fmt(L.zoom, 3)}`)}
      {row('minZoom', `${fmt(L.minZoom, 3)}  (max ${fmt(L.maxZoom, 1)})`)}
      {row('container', `${L.cw ?? '—'} × ${L.ch ?? '—'}`)}
      {row('window', `${typeof window !== 'undefined' ? window.innerWidth : '—'} × ${typeof window !== 'undefined' ? window.innerHeight : '—'}`)}
      {row('dpr', `${typeof window !== 'undefined' ? window.devicePixelRatio : '—'}`)}
      {row('displayScale', `${scale} (${mode})`)}
      <div style={{ borderTop: '1px solid rgba(120,255,120,0.2)', margin: '5px 0' }} />
      {row('pub lat/lng/z', pub ? `${fmt(pub.latitude, 3)}, ${fmt(pub.longitude, 3)}, ${fmt(pub.zoom, 2)}` : '—')}
      {row('recv lat/lng/z', recv ? `${fmt(recv.latitude, 3)}, ${fmt(recv.longitude, 3)}, ${fmt(recv.zoom, 2)}` : '—')}
      <div style={{ borderTop: '1px solid rgba(120,255,120,0.2)', margin: '5px 0' }} />
      <button
        onClick={() => { const m = mapRef?.current?.getMap?.(); if (m) applyVerticalFillMinZoom(m); }}
        style={{ background: 'rgba(120,255,120,0.12)', color: '#9f9', border: '1px solid rgba(120,255,120,0.35)', borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '2px 6px', width: '100%' }}
        title="Recompute minZoom from container height"
      >re-apply minZoom</button>
    </div>
  );
}
