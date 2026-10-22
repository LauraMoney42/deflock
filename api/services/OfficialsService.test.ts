import { describe, it, expect } from 'bun:test';
import {
  parseCensusResponse,
  parseCsv,
  cleanPlaceName,
  toLegislator,
  matchLegislators,
  applyOverrides,
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
    const { legislators, unfilledSeats } = matchLegislators(all, lookup);
    expect(legislators.map(l => l.name)).toEqual(['Sen A', 'Rep B']);
    expect(unfilledSeats).toEqual([]);
  });

  it('uses the first link as the profile url and null for a missing email', () => {
    const [sen] = matchLegislators(all, lookup).legislators;
    expect(sen.url).toBe('https://leg.example.gov/a');
    expect(sen.email).toBeNull();
    expect(sen.familyName).toBe('A');
  });

  it('matches lettered seats to a bare district number (Idaho 19A/19B)', () => {
    const idaho = [row('19', 'upper', 'Sen'), row('19A', 'lower', 'Rep A'), row('19B', 'lower', 'Rep B'), row('1A', 'lower', 'Other')];
    const lookupId = { ...lookup, upperDistrict: '19', lowerDistrict: '19' };
    expect(matchLegislators(idaho, lookupId).legislators.map(l => l.name)).toEqual(['Sen', 'Rep A', 'Rep B']);
  });

  it('keeps exact lettered matches when Census includes the letter (Minnesota 64A)', () => {
    const mn = [row('64', 'upper', 'Sen'), row('64A', 'lower', 'Rep A'), row('64B', 'lower', 'Rep B')];
    const lookupMn = { ...lookup, upperDistrict: '64', lowerDistrict: '64A' };
    expect(matchLegislators(mn, lookupMn).legislators.map(l => l.name)).toEqual(['Sen', 'Rep A']);
  });

  it('reports a district with nobody in it as an unfilled seat', () => {
    const lookupVacant = { ...lookup, lowerDistrict: '99' };
    expect(matchLegislators(all, lookupVacant).unfilledSeats).toEqual([{ chamber: 'lower', district: '99' }]);
  });
});

describe('applyOverrides', () => {
  const base = [toLegislator({
    name: 'Jane Doe', given_name: 'Jane', family_name: 'Doe', current_party: 'Independent',
    current_chamber: 'lower', current_district: '5', email: 'jane@leg.gov', links: '',
  })];

  it('fills blanks but never overwrites Open States values', () => {
    const [jane] = applyOverrides(base, 'XX', [
      { state: 'xx', chamber: 'lower', district: '05', name: 'jane doe', email: 'wrong@x.gov', phone: '555-0100' },
    ]);
    expect(jane.email).toBe('jane@leg.gov');
    expect(jane.phone).toBe('555-0100');
  });

  it('adds a legislator Open States is missing, and ignores other states', () => {
    const result = applyOverrides(base, 'XX', [
      { state: 'XX', chamber: 'upper', district: '9', name: 'New Member', email: 'new@leg.gov' },
      { state: 'YY', chamber: 'upper', district: '9', name: 'Elsewhere', email: 'e@leg.gov' },
    ]);
    expect(result.map(l => l.name)).toEqual(['Jane Doe', 'New Member']);
    expect(result[1].email).toBe('new@leg.gov');
  });
});

describe('cleanPlaceName', () => {
  it('trims consolidated city suffixes', () => {
    expect(cleanPlaceName('Indianapolis city (balance)')).toBe('Indianapolis');
    expect(cleanPlaceName('Nashville-Davidson metropolitan government (balance)')).toBe('Nashville-Davidson');
  });

  it('leaves real names that end in City alone', () => {
    expect(cleanPlaceName('Boise City')).toBe('Boise City');
  });
});
