import { describe, it, expect } from 'bun:test';
import { decideCountyGovernment } from './CountyGovernment';

// Small stand-in for data/county-government-by-state.csv
const rows: any = {
  AR: { has_county_government: 'yes', body_name: 'Quorum Court', head_title: 'County Judge', varies: 'no' },
  NY: { has_county_government: 'yes', body_name: 'County Legislature', head_title: 'Chair', varies: 'yes' },
  CT: { has_county_government: 'no', body_name: '', head_title: '', varies: 'no' },
  VA: { has_county_government: 'yes', body_name: 'Board of Supervisors', head_title: 'Chair', varies: 'no' },
  CO: { has_county_government: 'yes', body_name: 'Board of County Commissioners', head_title: 'Chair', varies: 'no' },
  MA: { has_county_government: 'yes', body_name: 'Board of County Commissioners', head_title: 'Chair', varies: 'yes' },
};

describe('decideCountyGovernment', () => {
  it('uses the state default body and title', () => {
    expect(decideCountyGovernment('AR', { name: 'Washington County', fips: '05143' }, 'Springdale', rows)).toEqual({
      kind: 'government',
      government: { body: 'Quorum Court', headTitle: 'County Judge' },
    });
  });

  it("doesn't guess the body name where counties in the state differ", () => {
    expect(decideCountyGovernment('NY', { name: 'Albany County', fips: '36001' }, 'Albany', rows)).toEqual({
      kind: 'government',
      government: { body: null, headTitle: null },
    });
  });

  it('skips states with no county government', () => {
    expect(decideCountyGovernment('CT', { name: 'Capitol Planning Region', fips: '09110' }, 'Hartford', rows).kind).toBe('none');
  });

  it('skips independent cities', () => {
    const d = decideCountyGovernment('VA', { name: 'Richmond city', fips: '51760' }, 'Richmond', rows);
    expect(d).toEqual({ kind: 'none', reason: 'Richmond is an independent city, not part of a county.' });
  });

  it('skips the county for its consolidated city, but not for other towns in it', () => {
    expect(decideCountyGovernment('CO', { name: 'Denver County', fips: '08031' }, 'Denver', rows).kind).toBe('none');
    expect(decideCountyGovernment('CO', { name: 'Adams County', fips: '08001' }, 'Westminster', rows).kind).toBe('government');
  });

  it('skips abolished Massachusetts counties and NYC boroughs', () => {
    expect(decideCountyGovernment('MA', { name: 'Middlesex County', fips: '25017' }, 'Cambridge', rows).kind).toBe('none');
    expect(decideCountyGovernment('MA', { name: 'Plymouth County', fips: '25023' }, 'Brockton', rows).kind).toBe('government');
    expect(decideCountyGovernment('NY', { name: 'Kings County', fips: '36047' }, 'New York', rows).kind).toBe('none');
  });
});
