import { describe, it, expect } from 'bun:test';
import { decideCityGovernment, placeTypeFromName } from './CityGovernment';

// Small stand-in for data/city-government-by-state.csv
const rows: any = {
  'DEFAULT|city': { body_name: 'City Council', head_title: 'Mayor', varies: 'no' },
  'DEFAULT|town': { body_name: '', head_title: '', varies: 'yes' },
  'MO|city': { body_name: '', head_title: 'Mayor', varies: 'yes' },
  'NY|village': { body_name: 'Board of Trustees', head_title: 'Mayor', varies: 'no' },
  'NY|town': { body_name: 'Town Board', head_title: 'Supervisor', varies: 'no' },
};

describe('placeTypeFromName', () => {
  it('reads the type from the Census name suffix', () => {
    expect(placeTypeFromName('Westminster city')).toBe('city');
    expect(placeTypeFromName('Smithtown town')).toBe('town');
    expect(placeTypeFromName('Pleasantville village')).toBe('village');
    expect(placeTypeFromName('Doylestown borough')).toBe('borough');
    expect(placeTypeFromName('Juneau city and borough')).toBe('city and borough');
  });

  it('handles consolidated governments marked (balance)', () => {
    expect(placeTypeFromName('Indianapolis city (balance)')).toBe('city');
    expect(placeTypeFromName('Nashville-Davidson metropolitan government (balance)')).toBe('metropolitan government');
  });

  it('returns null when there is no type word, instead of guessing', () => {
    expect(placeTypeFromName('Carson City')).toBeNull();
    expect(placeTypeFromName('Town')).toBeNull();
    expect(placeTypeFromName('Boise City city')).toBe('city');
  });
});

describe('decideCityGovernment', () => {
  it('uses a state-and-type row', () => {
    expect(decideCityGovernment('NY', 'village', rows)).toEqual({ body: 'Board of Trustees', headTitle: 'Mayor' });
    expect(decideCityGovernment('NY', 'town', rows)).toEqual({ body: 'Town Board', headTitle: 'Supervisor' });
  });

  it('falls back to the default row for the type', () => {
    expect(decideCityGovernment('CO', 'city', rows)).toEqual({ body: 'City Council', headTitle: 'Mayor' });
  });

  it("doesn't guess the body where places of that type differ, but keeps a shared title", () => {
    expect(decideCityGovernment('MO', 'city', rows)).toEqual({ body: null, headTitle: 'Mayor' });
    expect(decideCityGovernment('CO', 'town', rows)).toEqual({ body: null, headTitle: null });
  });

  it('returns nulls for an unknown or missing type', () => {
    expect(decideCityGovernment('CO', null, rows)).toEqual({ body: null, headTitle: null });
    expect(decideCityGovernment('CO', 'township', rows)).toEqual({ body: null, headTitle: null });
  });
});
