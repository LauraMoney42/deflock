import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv';

// What a city, town, village, or borough's governing body and leader are
// called. Census gives each incorporated place a type (the suffix of its
// NAME), and the names depend on state and type, so the defaults live in
// data/city-government-by-state.csv where they can be reviewed in a
// spreadsheet. A wrong name in a letter is worse than a neutral one, so
// varies=yes blanks the body name and the letter says "officials". It does
// not blank head_title: in many states every city has a mayor even though
// the council's name differs (Arkansas: City Council or Board of Directors).
// Leave head_title empty in a varies row when the leader's title differs too.

export interface CityGovernment {
  /** e.g. "City Council"; null where places of this type in the state differ */
  body: string | null;
  /** e.g. "Mayor"; null when unknown */
  headTitle: string | null;
}

interface TypeRow {
  body_name: string;
  head_title: string;
  varies: string;
}

// Longest suffixes first so "city and borough" isn't read as "borough".
// Matched against Census NAME, e.g. "Pleasantville village" or
// "Indianapolis city (balance)".
const PLACE_TYPES = [
  'city and borough', 'metropolitan government', 'metro government', 'unified government',
  'consolidated government', 'urban county', 'municipality', 'township', 'borough', 'village', 'town', 'city',
];

// Census names that end in a type word without carrying a type: Carson City is
// a consolidated city-county run by a Board of Supervisors, not a "city".
const UNTYPED_NAMES = new Set(['carson city']);

/** "Smithtown town" -> "town"; null when the name has no recognizable suffix ("Macon-Bibb County") */
export function placeTypeFromName(censusName: string): string | null {
  const name = censusName.replace(/\s*\(balance\)\s*$/, '').trim().toLowerCase();
  if (UNTYPED_NAMES.has(name)) return null;
  return PLACE_TYPES.find(t => name.endsWith(` ${t}`)) ?? null;
}

let table: Record<string, TypeRow> | null = null;
function typeTable(): Record<string, TypeRow> {
  if (!table) {
    const rows = parseCsv(readFileSync(join(import.meta.dir, '../data/city-government-by-state.csv'), 'utf8'));
    table = Object.fromEntries(rows.map(r => [`${r.state.toUpperCase()}|${r.place_type}`, r as unknown as TypeRow]));
  }
  return table;
}

export function decideCityGovernment(
  stateCode: string,
  placeType: string | null,
  rows: Record<string, TypeRow> = typeTable(),
): CityGovernment {
  if (!placeType) return { body: null, headTitle: null };
  // A state's own row wins; "default" covers the common case for the type
  const row = rows[`${stateCode.toUpperCase()}|${placeType}`] ?? rows[`DEFAULT|${placeType}`];
  if (!row) return { body: null, headTitle: null };
  return {
    body: row.varies === 'yes' ? null : row.body_name || null,
    headTitle: row.head_title || null,
  };
}

let contacts: Map<string, Record<string, string>> | null = null;
/** This place's row in data/city-contacts.csv, if any. fips is the 7-digit place GEOID. */
export function cityContact(fips: string): Record<string, string> | undefined {
  if (!contacts) {
    try {
      const rows = parseCsv(readFileSync(join(import.meta.dir, '../data/city-contacts.csv'), 'utf8'));
      contacts = new Map(rows.map(r => [r.fips, r]));
    } catch {
      contacts = new Map();
    }
  }
  return contacts.get(fips);
}
