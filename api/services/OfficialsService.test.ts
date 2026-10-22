import { describe, it, expect } from 'bun:test';
import {
  parseCensusResponse,
  parseCsv,
  toLegislator,
  matchLegislators,
  normalizeDistrict,
  type CensusLookup,
} from './OfficialsService';

// Trimmed from a real Census response for a Westminster, CO camera
const censusFixture = {
  result: {
    geographies: {
      'States': [{ GEOID: '08', NAME: 'Colorado', BASENAME: 'Colorado', STUSAB: 'CO' }],
      'Counties': [{ GEOID: '08001', NAME: 'Adams County', BASENAME: 'Adams' }],
      'Incorporated Places': [{ GEOID: '0883835', NAME: 'Westminster city', BASENAME: 'Westminster' }],
      '2026 State Legislative Districts - Upper': [{ GEOID: '08021', NAME: 'State Senate District 21', BASENAME: '21' }],
      '2026 State Legislative Districts - Lower': [{ GEOID: '08035', NAME: 'State House District 35', BASENAME: '35' }],
    },
  },
};

describe('parseCensusResponse', () => {
  it('extracts state, county, place, and both districts', () => {
    expect(parseCensusResponse(censusFixture)).toEqual({
      state: { code: 'CO', name: 'Colorado', fips: '08' },
      county: { name: 'Adams County', fips: '08001' },
      place: { name: 'Westminster', fips: '0883835' },
      upperDistrict: '21',
      lowerDistrict: '35',
    });
  });

  it('returns a null place for unincorporated areas', () => {
    const { 'Incorporated Places': _, ...rest } = censusFixture.result.geographies;
    expect(parseCensusResponse({ result: { geographies: rest } })?.place).toBeNull();
  });

  it('returns null outside the US (no state layer)', () => {
    expect(parseCensusResponse({ result: { geographies: {} } })).toBeNull();
  });
});

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes, and newlines inside fields', () => {
    const csv = 'name,biography,email\r\n"Doe, Jane","Said ""hi""\nthen left",jane@example.gov\r\n';
    expect(parseCsv(csv)).toEqual([
      { name: 'Doe, Jane', biography: 'Said "hi"\nthen left', email: 'jane@example.gov' },
    ]);
  });
});

describe('normalizeDistrict', () => {
  it('treats zero-padded numbers as equal', () => {
    expect(normalizeDistrict('021')).toBe(normalizeDistrict('21'));
  });

  it('keeps named districts, case-insensitive', () => {
    expect(normalizeDistrict('Hillsborough 12')).toBe('hillsborough 12');
  });
});

describe('matchLegislators', () => {
  const row = (district: string, chamber: string, name: string) => toLegislator({
    name, given_name: '', family_name: '', current_party: 'Democratic',
    current_chamber: chamber, current_district: district, email: '', links: 'https://leg.example.gov/a;https://other',
  });
  const all = [row('21', 'upper', 'Sen A'), row('35', 'lower', 'Rep B'), row('21', 'lower', 'Rep C')];
  const lookup = parseCensusResponse(censusFixture) as CensusLookup;

  it('picks the senator for the upper district and the rep for the lower district', () => {
    expect(matchLegislators(all, lookup).map(l => l.name)).toEqual(['Sen A', 'Rep B']);
  });

  it('uses the first link as the profile url and null for a missing email', () => {
    const [sen] = matchLegislators(all, lookup);
    expect(sen.url).toBe('https://leg.example.gov/a');
    expect(sen.email).toBeNull();
    expect(sen.familyName).toBe('A');
  });
});
