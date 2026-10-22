// Builds data/county-contacts.csv: one row per US county (50 states + DC),
// pre-filled with what free sources know, and blank contact columns for
// people or the extraction script to fill in.
//
//   bun scripts/build-county-contacts.ts <census-gazetteer-counties.txt> <wikidata-websites.csv>
//
// Re-running keeps every value already in the spreadsheet; it only adds new
// counties and fills empty website cells, so hand-checked data is never lost.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../services/csv';
import { decideCountyGovernment } from '../services/CountyGovernment';

export const COUNTY_COLUMNS = [
  'fips', 'state', 'county', 'county_government', 'body_name', 'head_title', 'head_name',
  'email', 'phone', 'website', 'contact_page', 'source', 'checked_on', 'last_attempt', 'status', 'note',
] as const;

export function toCsv(rows: Record<string, string>[], columns: readonly string[]): string {
  const cell = (v = '') => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns.join(','), ...rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}

if (import.meta.main) {
  const [gazPath, wikidataPath] = process.argv.slice(2);
  if (!gazPath || !wikidataPath) {
    console.error('usage: bun scripts/build-county-contacts.ts <gazetteer.txt> <wikidata.csv>');
    process.exit(1);
  }
  const outPath = join(import.meta.dir, '../data/county-contacts.csv');

  const existing = new Map<string, Record<string, string>>();
  if (existsSync(outPath)) {
    for (const r of parseCsv(readFileSync(outPath, 'utf8'))) existing.set(r.fips, r);
  }

  const websites = new Map(parseCsv(readFileSync(wikidataPath, 'utf8')).map(r => [r.fips, r.website]));

  // Gazetteer is tab-separated: USPS, GEOID, ANSICODE, NAME, ...
  const lines = readFileSync(gazPath, 'utf8').trim().split('\n').slice(1);
  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    const [state, fips, , name] = line.split('\t').map(s => s.trim());
    if (state === 'PR') continue; // Puerto Rico municipios aren't covered by Open States or the templates

    const decision = decideCountyGovernment(state, { name, fips }, null);
    const prev = existing.get(fips) ?? {};
    rows.push({
      fips,
      state,
      county: name,
      county_government: decision.kind === 'government' ? 'yes' : 'no',
      ...prev,
      website: prev.website || websites.get(fips) || '',
      status: prev.status || (decision.kind === 'government' ? 'todo' : 'not_applicable'),
      note: prev.note || (decision.kind === 'none' ? decision.reason : ''),
    });
  }

  rows.sort((a, b) => a.fips.localeCompare(b.fips));
  writeFileSync(outPath, toCsv(rows, COUNTY_COLUMNS));
  const withSite = rows.filter(r => r.website).length;
  console.log(`Wrote ${rows.length} counties (${withSite} with a website) to ${outPath}`);
}
