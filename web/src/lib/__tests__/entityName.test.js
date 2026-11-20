/**
 * Tests for entity-name resolution. The invariant: always prefer a real NAME
 * over a raw FIPS/id code, with the feature property winning, then a
 * 2-digit-FIPS → state-name fallback, then the bare id.
 */
import { describe, it, expect } from 'vitest';
import { resolveEntityName, stateNameForFips } from '../entityName.js';

describe('stateNameForFips', () => {
  it('maps 2-digit state FIPS to names', () => {
    expect(stateNameForFips('32')).toBe('Nevada');
    expect(stateNameForFips('34')).toBe('New Jersey');
    expect(stateNameForFips('46')).toBe('South Dakota');
    expect(stateNameForFips('06')).toBe('California');
  });
  it('does not guess county GEOIDs or unknown codes', () => {
    expect(stateNameForFips('34013')).toBeNull(); // county GEOID, not a state
    expect(stateNameForFips('99')).toBeNull();
    expect(stateNameForFips('')).toBeNull();
  });
});

describe('resolveEntityName', () => {
  it('prefers a feature NAME property', () => {
    expect(resolveEntityName({ properties: { NAME: 'Bergen' } }, '34013')).toBe('Bergen');
    expect(resolveEntityName({ properties: { name: 'Alabama' } }, '01')).toBe('Alabama');
  });
  it('skips numeric-looking property values', () => {
    // A NAME that's just the code shouldn't win over the FIPS lookup.
    expect(resolveEntityName({ properties: { NAME: '34' } }, '34')).toBe('New Jersey');
  });
  it('falls back to FIPS state name when no feature name', () => {
    expect(resolveEntityName(null, '32')).toBe('Nevada');
    expect(resolveEntityName({ properties: {} }, '06')).toBe('California');
  });
  it('falls back to the raw id when nothing resolves', () => {
    expect(resolveEntityName(null, '34013')).toBe('34013'); // county, no NAME
    expect(resolveEntityName(null, 'XYZ')).toBe('XYZ');
  });
  it('handles missing input', () => {
    expect(resolveEntityName(null, null)).toBeNull();
    expect(resolveEntityName(undefined, undefined)).toBeNull();
  });
});
