import { Suspense, lazy } from 'react';

const ChartDock = lazy(() => import('../charts/ChartDock.jsx'));

/**
 * ChartDocks — renders open chart frames in their anchor positions:
 *   - floating frames render at the app root
 *   - side-left / side-right / bottom render inside ChartDock edge
 *     containers that stack with independent resize and auto-hide
 *     when empty
 *
 * Tray-mode frames are NOT rendered here — they flow into the
 * ChartTray via ``ChartTrayContainer``.
 *
 * Receives the pre-grouped frame arrays from App.jsx so the
 * scenario/AI merge + render-fn invocation happens at the call site.
 */
export default function ChartDocks({
  floating,        // already-rendered JSX nodes
  sideLeft,
  sideRight,
  bottom,
  onBottomSizeChange,
}) {
  return (
    <Suspense fallback={null}>
      {floating}
      {sideLeft.length > 0 && <ChartDock edge="left">{sideLeft}</ChartDock>}
      {sideRight.length > 0 && <ChartDock edge="right">{sideRight}</ChartDock>}
      {bottom.length > 0 && (
        <ChartDock edge="bottom" onSizeChange={onBottomSizeChange}>{bottom}</ChartDock>
      )}
    </Suspense>
  );
}
