// Builds data/city-contacts.csv: one row per incorporated place (city, town,
// village, borough, ...) in the 50 states + DC, pre-filled with what free
// sources know, and blank contact columns for people or the extraction
// script to fill in. Census-designated places are left out: they have no
// government to write to.
//
//   bun scripts/build-city-contacts.ts <census-gazetteer-places.txt> <wikidata-websites.csv>
//
// The Wikidata file is the output of one bulk query (CSV with columns fips,
// site):  SELECT ?fips ?site WHERE { ?item wdt:P774 ?fips . ?item wdt:P856 ?site }
// where P774 is FIPS 55-3, formatted "SS-PPPPP".
//
// Re-running keeps every value already in the spreadsheet; it only adds new
// places and fills empty website cells, so hand-checked data is never lost.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../services/csv';
import { placeTypeFromName } from '../services/CityGovernment';
import { toCsv } from './build-county-contacts';

export const CITY_COLUMNS = [
  'fips', 'state', 'city', 'place_type', 'body_name', 'head_title', 'head_name',
  'email', 'phone', 'website', 'contact_page', 'source', 'checked_on', 'last_attempt', 'status', 'note',
] as const;

// Gazetteer LSAD codes that are not governments: 57 = CDP, 55 and 62 = Puerto Rico
// comunidades and zonas urbanas. FUNCSTAT: A = active government, B = active but
// partly merged with another government, F = the "balance" of a consolidated
// city. Inactive (I), nonfunctioning (N), and statistical (S) places are skipped,
// except Washington, DC, which Census lists as nonfunctioning but is the place
// its geocoder returns.
export function isIncorporatedPlace(state: string, lsad: string, funcstat: string): boolean {
  if (state === 'PR' || ['57', '55', '62'].includes(lsad)) return false;
  return ['A', 'B', 'F'].includes(funcstat) || (state === 'DC' && funcstat === 'N');
}

// Wikidata gives "12-11285"; the Gazetteer GEOID is state + place with no hyphen
export function wikidataFipsToGeoid(fips: string): string | null {
  const digits = fips.replace(/\D/g, '');
  return digits.length === 7 ? digits : null;
}

// A web archive or social page is not the city's own site
const NOT_A_CITY_SITE = /web\.archive\.org|facebook\.com|twitter\.com|instagram\.com/i;

if (import.meta.main) {
  const [gazPath, wikidataPath] = process.argv.slice(2);
  if (!gazPath || !wikidataPath) {
    console.error('usage: bun scripts/build-city-contacts.ts <gazetteer-places.txt> <wikidata.csv>');
    process.exit(1);
  }
  const outPath = join(import.meta.dir, '../data/city-contacts.csv');

  const existing = new Map<string, Record<string, string>>();
  if (existsSync(outPath)) {
    for (const r of parseCsv(readFileSync(outPath, 'utf8'))) existing.set(r.fips, r);
  }

  // Some places have several sites on Wikidata; the first usable one wins
  const websites = new Map<string, string>();
  for (const r of parseCsv(readFileSync(wikidataPath, 'utf8'))) {
    const geoid = wikidataFipsToGeoid(r.fips ?? '');
    if (geoid && r.site && !NOT_A_CITY_SITE.test(r.site) && !websites.has(geoid)) websites.set(geoid, r.site);
  }

  // Gazetteer is tab-separated: USPS, GEOID, ANSICODE, NAME, LSAD, FUNCSTAT, ...
  const lines = readFileSync(gazPath, 'utf8').trim().split('\n').slice(1);
  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    const [state, fips, , name, lsad, funcstat] = line.split('\t').map(s => s.trim());
    if (!isIncorporatedPlace(state, lsad, funcstat)) continue;

    const prev = existing.get(fips) ?? {};
    rows.push({
      fips,
      state,
      city: name,
      place_type: placeTypeFromName(name) ?? '',
      ...prev,
      website: prev.website || websites.get(fips) || '',
      status: prev.status || 'todo',
    });
  }

  rows.sort((a, b) => a.fips.localeCompare(b.fips));
  writeFileSync(outPath, toCsv(rows, CITY_COLUMNS));
  const withSite = rows.filter(r => r.website).length;
  console.log(`Wrote ${rows.length} places (${withSite} with a website) to ${outPath}`);
}
