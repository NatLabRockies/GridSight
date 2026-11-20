/**
 * entityName — resolve a human-readable label for a clicked map entity.
 *
 * Entities are keyed by an id that's often a FIPS code (e.g. "32" for a state,
 * "34013" for a county). We should always show the NAME, not the raw code.
 * The clicked GeoJSON feature usually carries it in a property; when only an
 * id is available (e.g. a chart frame that holds an entityId but not the
 * feature) we fall back to a 2-digit-FIPS → state-name table.
 */

// 2-digit state FIPS → name (50 states + DC + inhabited territories). Mirrors
// the extensions' state tables so a state-level entityId always resolves.
const FIPS_STATE = {
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas',
  '06': 'California', '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware',
  '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia', '15': 'Hawaii',
  '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa', '20': 'Kansas',
  '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine', '24': 'Maryland',
  '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota', '28': 'Mississippi',
  '29': 'Missouri', '30': 'Montana', '31': 'Nebraska', '32': 'Nevada',
  '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York',
  '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma',
  '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island', '45': 'South Carolina',
  '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas', '49': 'Utah',
  '50': 'Vermont', '51': 'Virginia', '53': 'Washington', '54': 'West Virginia',
  '55': 'Wisconsin', '56': 'Wyoming', '60': 'American Samoa', '66': 'Guam',
  '69': 'Northern Mariana Islands', '72': 'Puerto Rico', '78': 'U.S. Virgin Islands',
};

// Feature-property keys that hold a display name, in priority order: Census
// TIGER (NAME / NAMELSAD), generic, and common extension conventions.
const NAME_KEYS = [
  'NAME', 'name', 'display_name', 'NAMELSAD', 'label',
  'State', 'STATE_NAME', 'state_name', 'County', 'county_name',
];

const isNumericLike = (s) => /^\d+(\.\d+)?$/.test(s);

/** State name for a 2-digit FIPS code, or null. */
export function stateNameForFips(id) {
  const s = String(id ?? '').trim();
  // County GEOIDs (5 digits) start with the 2-digit state FIPS; with no
  // county lookup table we don't guess a county name, but a bare 2-digit id
  // is a state.
  return s.length === 2 && FIPS_STATE[s] ? FIPS_STATE[s] : null;
}

/**
 * Best display name for an entity. Prefers a name property on the clicked
 * feature; falls back to the FIPS→state table; finally the raw id.
 * @param {object|null} feature GeoJSON feature (has .properties)
 * @param {string|number|null} entityId
 * @returns {string|null}
 */
export function resolveEntityName(feature, entityId) {
  const props = feature?.properties || {};
  for (const k of NAME_KEYS) {
    const v = props[k];
    if (v != null) {
      const s = String(v).trim();
      if (s && !isNumericLike(s)) return s;
    }
  }
  const fromFips = stateNameForFips(entityId);
  if (fromFips) return fromFips;
  const id = String(entityId ?? '').trim();
  return id || null;
}
