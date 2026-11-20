/**
 * chartDescriptor.js
 *
 * Portable identity for a chart across browser tabs. A ChartFrame takes a
 * descriptor and the receiving tab uses it to re-hydrate the same chart
 * (either by re-fetching from the server or by unpacking an embedded spec).
 *
 * Three kinds:
 *   - 'ai'           — AI-generated chart; spec travels with the descriptor
 *                      (no server ID exists yet)
 *   - 'ext-scenario' — scenario-scoped extension chart (no entity)
 *   - 'ext-entity'   — entity-scoped extension chart
 *
 * Descriptors are plain JSON; they serialize cleanly over BroadcastChannel
 * and WebSocket.
 */

export const CHART_KIND = Object.freeze({
  AI: 'ai',
  EXT_SCENARIO: 'ext-scenario',
  EXT_ENTITY: 'ext-entity',
});

/** Stable key for dedupe ("is this chart already open?"). */
export function descriptorKey(d) {
  if (!d || !d.kind) return '';
  switch (d.kind) {
    case CHART_KIND.AI:
      // AI charts are ephemeral; use the client-side id the DAG assigned.
      return `ai:${d.chartId}`;
    case CHART_KIND.EXT_SCENARIO:
      return `ext-scenario:${d.extensionName}:${d.chartName}:${d.project}:${d.scenario}`;
    case CHART_KIND.EXT_ENTITY:
      return `ext-entity:${d.extensionName}:${d.chartName}:${d.entityId}:${d.project}:${d.scenario}`;
    default:
      return '';
  }
}

export function makeAiDescriptor({ chartId, title, spec, plotlySpec }) {
  return {
    kind: CHART_KIND.AI,
    chartId,
    title: title || spec?.title || 'Chart',
    spec,
    plotlySpec,
  };
}

export function makeExtScenarioDescriptor({
  extensionName, chartName, project, scenario, title, chartSpec,
}) {
  return {
    kind: CHART_KIND.EXT_SCENARIO,
    extensionName,
    chartName,
    project,
    scenario,
    title: title || chartSpec?.display_name || chartName,
    chartSpec,
  };
}

export function makeExtEntityDescriptor({
  extensionName, chartName, entityId, project, scenario, title, chartSpec,
}) {
  return {
    kind: CHART_KIND.EXT_ENTITY,
    extensionName,
    chartName,
    entityId,
    project,
    scenario,
    title: title || chartSpec?.display_name || chartName,
    chartSpec,
  };
}

/**
 * Anchor modes — where the ChartFrame mounts itself.
 *
 *   floating   — position: fixed, user-positioned, draggable, resizable
 *   tray       — embedded as a flex child inside ChartTray (no drag/resize)
 *   bottom     — fixed to bottom edge, full viewport width (8760 timeline view)
 *   side-left  — fixed to left edge, full viewport height
 *   side-right — fixed to right edge, full viewport height
 */
export const ANCHOR_MODE = Object.freeze({
  FLOATING: 'floating',
  TRAY: 'tray',
  BOTTOM: 'bottom',
  SIDE_LEFT: 'side-left',
  SIDE_RIGHT: 'side-right',
});

export const ANCHOR_MODES = [
  ANCHOR_MODE.FLOATING,
  ANCHOR_MODE.TRAY,
  ANCHOR_MODE.BOTTOM,
  ANCHOR_MODE.SIDE_LEFT,
  ANCHOR_MODE.SIDE_RIGHT,
];
