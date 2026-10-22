// Fills the blank contact columns of data/county-contacts.csv or
// data/city-contacts.csv by reading each government's own website.
//
//   bun scripts/extract-contacts.ts city AR              # one state
//   bun scripts/extract-contacts.ts county AR --refresh  # also re-check rows already "found"
//   bun scripts/extract-contacts.ts city AR --limit 120  # only the first 120 rows to check
//
// Results are marked status=found (never "verified") with the page they came
// from, so a person can check them. Rows marked verified are never touched,
// and a site that fails to load never erases a contact already on file.
// No AI: see contact-finder.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../services/csv';
import { COUNTY_COLUMNS, toCsv } from './build-county-contacts';
import { CITY_COLUMNS } from './build-city-contacts';
import { extractContact, nextRowState, pool, type ContactKind } from './contact-finder';

const CONFIG = {
  county: { file: 'county-contacts.csv', columns: COUNTY_COLUMNS, nameColumn: 'county', plural: 'counties' },
  city: { file: 'city-contacts.csv', columns: CITY_COLUMNS, nameColumn: 'city', plural: 'places' },
} as const;

function flagValue(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  const n = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function main(kind: ContactKind, state: string | undefined, args: string[]) {
  if (!state) {
    console.error(`usage: bun scripts/extract-contacts.ts ${kind} <STATE> [--refresh] [--limit N] [--concurrency N]`);
    process.exit(1);
  }
  state = state.toUpperCase();
  const cfg = CONFIG[kind];
  const refresh = args.includes('--refresh');
  const limit = flagValue(args, '--limit');
  const concurrency = flagValue(args, '--concurrency') ?? 6;
  const path = join(import.meta.dir, '../data', cfg.file);
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  let targets = rows.filter(r =>
    r.state === state && (kind === 'city' || r.county_government === 'yes') && r.website && r.status !== 'verified' &&
    (refresh || ['todo', '', 'site_unreachable'].includes(r.status)));
  if (limit) targets = targets.slice(0, limit);

  let found = 0;
  await pool(targets, concurrency, async r => {
    Object.assign(r, nextRowState(r, await extractContact(r.website, kind, r[cfg.nameColumn]), today));
    if (r.status === 'found') found++;
    console.log(`${r[cfg.nameColumn].padEnd(30)} ${r.status.padEnd(17)} ${r.email}`);
  });

  writeFileSync(path, toCsv(rows, cfg.columns));
  console.log(`\n${state}: ${found} of ${targets.length} ${cfg.plural} with a website are status=found (needs a person to verify).`);
}

if (import.meta.main) {
  const [kind, state, ...rest] = process.argv.slice(2);
  if (kind !== 'city' && kind !== 'county') {
    console.error('usage: bun scripts/extract-contacts.ts <city|county> <STATE> [--refresh] [--limit N] [--concurrency N]');
    process.exit(1);
  }
  await main(kind, state, rest);
}
