/**
 * formatFieldLabel — turn a raw data column into a readable label, promoting a
 * trailing unit token to "(Unit)" and keeping known acronyms upper-case.
 *
 *   dc_capacity_mw    → "DC Capacity (MW)"
 *   selected_demand_mwh → "Selected Demand (MWh)"
 *   loading_pct       → "Loading (%)"
 *   state_name        → "State Name"
 *
 * Shared by the entity InfoCard and the map LegendPanel so a column reads the
 * same (and carries its unit) wherever it surfaces.
 */

const UNIT_TOKENS = {
  mwh: 'MWh', mw: 'MW', gwh: 'GWh', gw: 'GW', twh: 'TWh', tw: 'TW',
  kwh: 'kWh', kw: 'kW', btu: 'BTU', pct: '%', usd: 'USD',
};

const ACRONYMS = {
  dc: 'DC', ev: 'EV', gdp: 'GDP', us: 'US', co2: 'CO₂',
  geoid: 'GEOID', fips: 'FIPS', id: 'ID', hh: 'HH',
};

/**
 * Value-axis title from a chart spec's declared value_label + value_unit, e.g.
 * "Demand (MWh)". Falls back to the label alone, the unit alone, then the raw
 * column. Shared by the Plotly and ChartGPU renderers so a value axis reads the
 * same (and carries its unit) either way.
 */
export function valueAxisTitle(chartOptions, fallbackColumn) {
  const label = chartOptions?.value_label;
  const unit = chartOptions?.value_unit;
  if (label) return unit ? `${label} (${unit})` : label;
  if (unit) return unit;
  return fallbackColumn;
}

export function formatFieldLabel(col) {
  const parts = String(col ?? '').split('_').filter(Boolean);
  if (parts.length === 0) return String(col ?? '');
  let unit = null;
  if (parts.length > 1 && UNIT_TOKENS[parts[parts.length - 1].toLowerCase()]) {
    unit = UNIT_TOKENS[parts.pop().toLowerCase()];
  }
  const words = parts.map((w) => {
    const lw = w.toLowerCase();
    if (ACRONYMS[lw]) return ACRONYMS[lw];
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  const label = words.join(' ');
  return unit ? `${label} (${unit})` : label;
}
