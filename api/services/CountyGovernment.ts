import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv';

// Decides whether a camera's county has its own government worth writing to,
// and what its governing body and leader are called. The per-state defaults
// live in data/county-government-by-state.csv so they can be reviewed and
// corrected in a spreadsheet.

export interface CountyGovernment {
  /** e.g. "Quorum Court"; null when the state's counties vary and we don't know which this one uses */
  body: string | null;
  /** e.g. "County Judge"; null when unknown */
  headTitle: string | null;
}

export type CountyDecision =
  | { kind: 'government'; government: CountyGovernment }
  | { kind: 'none'; reason: string };

// Counties that share one government with the main city inside them. When the
// camera is in that city, the city council is the only body to write to, so a
// separate county card would just repeat it. Keyed by county FIPS; the value
// is how the city's Census name starts.
const CONSOLIDATED: Record<string, string> = {
  '02020': 'Anchorage',
  '02110': 'Juneau',
  '06075': 'San Francisco',
  '08014': 'Broomfield',
  '08031': 'Denver',
  '12031': 'Jacksonville',
  '13021': 'Macon',
  '13059': 'Athens',
  '13215': 'Columbus',
  '13245': 'Augusta',
  '18097': 'Indianapolis',
  '20209': 'Kansas City',
  '21067': 'Lexington',
  '21111': 'Louisville',
  '22033': 'Baton Rouge',
  '22071': 'New Orleans',
  '32510': 'Carson City',
  '42101': 'Philadelphia',
  '47037': 'Nashville',
};

// Massachusetts abolished these county governments (1997 to 2000); Suffolk's
// functions are run by Boston. The rest (Barnstable, Bristol, Dukes,
// Nantucket, Norfolk, Plymouth) still exist.
const MA_ABOLISHED = new Set(['25003', '25009', '25011', '25013', '25015', '25017', '25025', '25027']);

// New York City's five boroughs are counties on paper with no county government
const NYC_BOROUGHS = new Set(['36005', '36047', '36061', '36081', '36085']);

// Kalawao County, Hawaii (the Kalaupapa settlement) is run by the state
const NO_GOVERNMENT = new Set(['15005']);

interface StateRow {
  has_county_government: string;
  body_name: string;
  head_title: string;
  varies: string;
}

let table: Record<string, StateRow> | null = null;
function stateTable(): Record<string, StateRow> {
  if (!table) {
    const rows = parseCsv(readFileSync(join(import.meta.dir, '../data/county-government-by-state.csv'), 'utf8'));
    table = Object.fromEntries(rows.map(r => [r.state.toUpperCase(), r as unknown as StateRow]));
  }
  return table;
}

export function decideCountyGovernment(
  stateCode: string,
  county: { name: string; fips: string },
  placeName: string | null,
  rows: Record<string, StateRow> = stateTable(),
): CountyDecision {
  const row = rows[stateCode.toUpperCase()];

  if (!row || row.has_county_government === 'no') {
    return { kind: 'none', reason: `${stateCodeToName(stateCode)} has no county government, so the city or town is the local government.` };
  }
  if (MA_ABOLISHED.has(county.fips)) {
    return { kind: 'none', reason: `${county.name}'s government was abolished, so the city or town is the local government.` };
  }
  if (NO_GOVERNMENT.has(county.fips)) {
    return { kind: 'none', reason: `${county.name} has no county government.` };
  }
  if (NYC_BOROUGHS.has(county.fips)) {
    return { kind: 'none', reason: 'New York City\'s boroughs have no county government; the City Council is the local government.' };
  }
  // Virginia, Baltimore, and St. Louis independent cities: Census lists the city as its own "county"
  if (/ city$/.test(county.name)) {
    return { kind: 'none', reason: `${county.name.replace(/ city$/, '')} is an independent city, not part of a county.` };
  }
  // Alaska's Unorganized Borough is split into census areas with no borough government
  if (/Census Area$/.test(county.name)) {
    return { kind: 'none', reason: 'This area is in Alaska\'s Unorganized Borough, which has no borough government.' };
  }
  const consolidatedCity = CONSOLIDATED[county.fips];
  if (consolidatedCity && placeName?.startsWith(consolidatedCity)) {
    return { kind: 'none', reason: `${placeName} and ${county.name} share one government, so the city council covers both.` };
  }

  // Where counties in a state use different names, don't guess: the letter
  // falls back to neutral wording unless the county spreadsheet says more.
  const varies = row.varies === 'yes';
  return {
    kind: 'government',
    government: {
      body: varies ? null : row.body_name || null,
      headTitle: varies ? null : row.head_title || null,
    },
  };
}

const STATE_NAMES: Record<string, string> = { CT: 'Connecticut', RI: 'Rhode Island', VT: 'Vermont', DC: 'The District of Columbia' };
function stateCodeToName(code: string): string {
  return STATE_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

let contacts: Map<string, Record<string, string>> | null = null;
/** This county's row in data/county-contacts.csv, if any */
export function countyContact(fips: string): Record<string, string> | undefined {
  if (!contacts) {
    try {
      const rows = parseCsv(readFileSync(join(import.meta.dir, '../data/county-contacts.csv'), 'utf8'));
      contacts = new Map(rows.map(r => [r.fips, r]));
    } catch {
      contacts = new Map();
    }
  }
  return contacts.get(fips);
}
