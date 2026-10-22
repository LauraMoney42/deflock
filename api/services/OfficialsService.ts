import { createCache, Cache } from 'cache-manager';
import { Type, Static } from '@sinclair/typebox';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { otelLogger, SeverityNumber } from '../telemetry';
import { parseCsv } from './csv';
import { decideCountyGovernment, countyContact } from './CountyGovernment';
import { decideCityGovernment, cityContact, placeTypeFromName } from './CityGovernment';

export { parseCsv };
const { DiskStore } = require('cache-manager-fs-hash');

// Looks up who answers for a point on the map: the city (if incorporated),
// the county, and the state legislators whose districts contain it.
// Everything is derived from the camera's coordinates, never from the user.

const USER_AGENT = 'DeFlock/1.2 (https://deflock.org)';
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
const OPENSTATES_CSV_URL = 'https://data.openstates.org/people/current';
const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';

const LocalGovSchema = Type.Object({
  name: Type.String(),
  fips: Type.String(),
  website: Type.Union([Type.String(), Type.Null()]),
  head: Type.Union([Type.String(), Type.Null()]),
});

const LegislatorSchema = Type.Object({
  name: Type.String(),
  givenName: Type.String(),
  familyName: Type.String(),
  party: Type.String(),
  chamber: Type.Union([Type.Literal('upper'), Type.Literal('lower'), Type.Literal('legislature')]),
  district: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  url: Type.Union([Type.String(), Type.Null()]),
});

const UnfilledSeatSchema = Type.Object({
  chamber: Type.Union([Type.Literal('upper'), Type.Literal('lower')]),
  district: Type.String(),
});

// 'verified' = a person checked it; 'found' = pulled from the government's site, not yet checked
const ContactStatusSchema = Type.Union([Type.Literal('verified'), Type.Literal('found'), Type.Null()]);

const PlaceSchema = Type.Object({
  name: Type.String(),
  fips: Type.String(),
  website: Type.Union([Type.String(), Type.Null()]),
  head: Type.Union([Type.String(), Type.Null()]),
  // Census place type from the NAME suffix: "city", "town", "village", "borough", ...
  type: Type.Union([Type.String(), Type.Null()]),
  // From data/city-government-by-state.csv; null where places of this type in the state differ
  body: Type.Union([Type.String(), Type.Null()]),
  headTitle: Type.Union([Type.String(), Type.Null()]),
  // From data/city-contacts.csv when someone (or the extraction script) has filled it in
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  contactPage: Type.Union([Type.String(), Type.Null()]),
  contactStatus: ContactStatusSchema,
});

const CountySchema = Type.Object({
  name: Type.String(),
  fips: Type.String(),
  website: Type.Union([Type.String(), Type.Null()]),
  head: Type.Union([Type.String(), Type.Null()]),
  // From data/county-government-by-state.csv; null where counties in the state differ
  body: Type.Union([Type.String(), Type.Null()]),
  headTitle: Type.Union([Type.String(), Type.Null()]),
  // From data/county-contacts.csv when someone (or the extraction script) has filled it in
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  contactPage: Type.Union([Type.String(), Type.Null()]),
  contactStatus: ContactStatusSchema,
});

export const OfficialsResultSchema = Type.Object({
  state: Type.Object({ code: Type.String(), name: Type.String(), fips: Type.String() }),
  place: Type.Union([PlaceSchema, Type.Null()]),
  county: Type.Union([CountySchema, Type.Null()]),
  // Why there's no county card (no county government, independent city, ...)
  countyNote: Type.Union([Type.String(), Type.Null()]),
  stateLegislators: Type.Array(LegislatorSchema),
  // Districts that contain the camera but have no current member in our data,
  // usually a vacancy. Shown to the user instead of silently leaving a gap.
  unfilledSeats: Type.Array(UnfilledSeatSchema),
});

export type LocalGov = Static<typeof LocalGovSchema>;
export type Place = Static<typeof PlaceSchema>;
export type Legislator = Static<typeof LegislatorSchema>;
export type UnfilledSeat = Static<typeof UnfilledSeatSchema>;
export type OfficialsResult = Static<typeof OfficialsResultSchema>;

interface CensusGeo {
  GEOID: string;
  NAME: string;
  BASENAME: string;
  STUSAB?: string;
  STATE?: string;
  PLACE?: string;
}

export interface CensusLookup {
  state: { code: string; name: string; fips: string };
  county: { name: string; fips: string } | null;
  place: { name: string; fips: string; type: string | null } | null;
  upperDistrict: string | null;
  lowerDistrict: string | null;
}

const cache: Cache = createCache({
  stores: [new DiskStore({
    path: '/tmp/officials-cache',
    ttl: 3600 * 24, // 24 hours, same as the Nominatim cache; legislators change rarely, cameras never move
    maxsize: 1000 * 1000 * 50, // 50MB
    subdirs: true,
    zip: false,
  })]
});

// Census layer names carry a year ("2026 State Legislative Districts - Upper")
// that changes with each vintage, so match on the stable suffix instead.
function findLayer(geographies: Record<string, CensusGeo[]>, pattern: RegExp): CensusGeo | null {
  const key = Object.keys(geographies).find(k => pattern.test(k));
  return key ? geographies[key]?.[0] ?? null : null;
}

// "021" (Census) and "21" (Open States) name the same district.
export function normalizeDistrict(district: string): string {
  const trimmed = district.trim();
  return /^\d+$/.test(trimmed) ? String(parseInt(trimmed, 10)) : trimmed.toLowerCase();
}

// Consolidated city-counties come back as e.g. "Indianapolis city (balance)"
// or "Nashville-Davidson metropolitan government (balance)". Names without
// "(balance)" are left alone, since some cities really are named "Boise City".
export function cleanPlaceName(name: string): string {
  if (!/\(balance\)/.test(name)) return name;
  return name
    .replace(/\s*\(balance\)\s*$/, '')
    .replace(/\s+(city|town|metro government|metropolitan government|unified government|consolidated government|urban county)$/i, '')
    .trim();
}

export function parseCensusResponse(json: any): CensusLookup | null {
  const geographies: Record<string, CensusGeo[]> | undefined = json?.result?.geographies;
  if (!geographies) return null;

  const state = findLayer(geographies, /^States$/);
  if (!state?.STUSAB) return null;

  const county = findLayer(geographies, /^Counties$/);
  const place = findLayer(geographies, /^Incorporated Places$/);
  const upper = findLayer(geographies, /State Legislative Districts - Upper$/);
  const lower = findLayer(geographies, /State Legislative Districts - Lower$/);

  return {
    state: { code: state.STUSAB, name: state.NAME, fips: state.GEOID },
    county: county ? { name: county.NAME, fips: county.GEOID } : null,
    place: place ? { name: cleanPlaceName(place.BASENAME), fips: place.GEOID, type: placeTypeFromName(place.NAME) } : null,
    upperDistrict: upper?.BASENAME ?? null,
    lowerDistrict: lower?.BASENAME ?? null,
  };
}

export function toLegislator(row: Record<string, string>): Legislator {
  const chamber = row.current_chamber === 'upper' || row.current_chamber === 'lower'
    ? row.current_chamber
    : 'legislature';
  return {
    name: row.name,
    givenName: row.given_name || row.name.split(' ')[0],
    familyName: row.family_name || row.name.split(' ').slice(-1)[0],
    party: row.current_party,
    chamber,
    district: row.current_district,
    email: row.email || null,
    // Capitol office first: it's staffed during session, district offices often aren't
    phone: row.capitol_voice || row.district_voice || null,
    // "links" is semicolon-separated; the first is the official legislature page
    url: row.links?.split(';')[0] || null,
  };
}

// Idaho elects two House members per district as seats "19A" and "19B",
// while Census calls the district "19". When Census gives a bare number,
// lettered seats with that number share the whole district. Minnesota's
// letters are separate districts, but Census includes the letter there
// ("64A"), so the exact match wins and this fallback never applies.
function seatNumber(district: string): string | null {
  const m = district.trim().match(/^(\d+)[A-Za-z]$/);
  return m ? String(parseInt(m[1], 10)) : null;
}

function matchChamber(all: Legislator[], chambers: Legislator['chamber'][], district: string | null): Legislator[] {
  if (!district) return [];
  const target = normalizeDistrict(district);
  const inChamber = all.filter(l => chambers.includes(l.chamber));
  const exact = inChamber.filter(l => normalizeDistrict(l.district) === target);
  if (exact.length || !/^\d+$/.test(target)) return exact;
  return inChamber.filter(l => seatNumber(l.district) === target);
}

export function matchLegislators(all: Legislator[], lookup: CensusLookup): { legislators: Legislator[]; unfilledSeats: UnfilledSeat[] } {
  // Nebraska's unicameral legislature is reported by Census as "Upper"
  const upper = matchChamber(all, ['upper', 'legislature'], lookup.upperDistrict);
  const lower = matchChamber(all, ['lower'], lookup.lowerDistrict);
  const unfilledSeats: UnfilledSeat[] = [];
  if (lookup.upperDistrict && !upper.length) unfilledSeats.push({ chamber: 'upper', district: normalizeDistrict(lookup.upperDistrict) });
  if (lookup.lowerDistrict && !lower.length) unfilledSeats.push({ chamber: 'lower', district: normalizeDistrict(lookup.lowerDistrict) });
  return { legislators: [...upper, ...lower], unfilledSeats };
}

// Hand-checked corrections and additions, kept as a spreadsheet so anyone can
// review or edit them (data/state-legislator-overrides.csv). A row fills in
// blank fields of the matching Open States legislator (same state, chamber,
// district, and name), or adds the person if Open States doesn't have them.
// Open States values are never overwritten by a blank cell.
export function applyOverrides(all: Legislator[], stateCode: string, overrides: Record<string, string>[]): Legislator[] {
  const result = all.map(l => ({ ...l }));
  for (const o of overrides) {
    if (o.state?.toUpperCase() !== stateCode.toUpperCase() || !o.name) continue;
    const chamber = (['upper', 'lower', 'legislature'].includes(o.chamber) ? o.chamber : 'lower') as Legislator['chamber'];
    const existing = result.find(l =>
      l.chamber === chamber &&
      normalizeDistrict(l.district) === normalizeDistrict(o.district) &&
      l.name.toLowerCase() === o.name.toLowerCase());
    if (existing) {
      existing.email = existing.email || o.email || null;
      existing.phone = existing.phone || o.phone || null;
      existing.url = existing.url || o.url || null;
    } else {
      result.push(toLegislator({
        name: o.name, given_name: '', family_name: '', current_party: o.party ?? '',
        current_chamber: chamber, current_district: o.district, email: o.email ?? '',
        capitol_voice: o.phone ?? '', links: o.url ?? '',
      }));
    }
  }
  return result;
}

let overridesCache: Record<string, string>[] | null = null;
function loadOverrides(): Record<string, string>[] {
  if (!overridesCache) {
    try {
      overridesCache = parseCsv(readFileSync(join(import.meta.dir, '../data/state-legislator-overrides.csv'), 'utf8'));
    } catch {
      overridesCache = [];
    }
  }
  return overridesCache;
}

// The spreadsheets change the response, but the disk cache outlives restarts
// for 24h, so the cache key carries a hash of their contents: edit a CSV,
// restart, and fresh results show immediately. Computed once at startup.
// Open States data is upstream and not covered, 24h is fine for it.
const DATA_FILES = [
  'state-legislator-overrides.csv',
  'county-government-by-state.csv',
  'county-contacts.csv',
  'city-government-by-state.csv',
  'city-contacts.csv',
];
let dataVersionCache: string | null = null;
export function dataVersion(): string {
  if (!dataVersionCache) {
    const hash = createHash('sha1');
    for (const file of DATA_FILES) {
      try {
        hash.update(file).update(readFileSync(join(import.meta.dir, '../data', file)));
      } catch {
        hash.update(`${file}:missing`);
      }
    }
    dataVersionCache = hash.digest('hex').slice(0, 8);
  }
  return dataVersionCache;
}

export class OfficialsService {
  async lookup(lat: number, lon: number): Promise<OfficialsResult | null> {
    // ~110m grid: every request for the same camera hits the same key.
    // Bump vN when the response shape changes; dataVersion() covers CSV edits.
    const cacheKey = `officials:v9:${dataVersion()}:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const cached = await cache.get<OfficialsResult>(cacheKey);
    if (cached) return cached;

    const census = await this.censusLookup(lat, lon);
    if (!census) return null;

    // Legislators and websites are nice-to-have: a failure there still returns
    // the city/county/state names so the user can find contacts themselves.
    const [openStates, websites] = await Promise.all([
      this.stateLegislators(census.state.code).catch(err => { this.logSoftError('openstates', err); return []; }),
      this.localWebsites(census).catch(err => { this.logSoftError('wikidata', err); return {} as LocalInfo; }),
    ]);

    const legislators = applyOverrides(openStates, census.state.code, loadOverrides());
    const countyDecision = census.county
      ? decideCountyGovernment(census.state.code, census.county, census.place?.name ?? null)
      : null;
    const { legislators: matched, unfilledSeats } = matchLegislators(legislators, census);

    const result: OfficialsResult = {
      state: census.state,
      place: census.place ? this.buildPlace(census.state.code, census.place, websites.place) : null,
      county: census.county && countyDecision?.kind === 'government'
        ? this.buildCounty(census.county, websites.county, countyDecision.government)
        : null,
      countyNote: countyDecision?.kind === 'none' ? countyDecision.reason : null,
      stateLegislators: matched,
      unfilledSeats,
    };

    await cache.set(cacheKey, result);
    return result;
  }

  // Same precedence as buildCounty: spreadsheet, then Wikidata, then the
  // state/type defaults. The mayor from Wikidata is kept as is.
  private buildPlace(
    stateCode: string,
    place: { name: string; fips: string; type: string | null },
    wiki: { website: string | null; head: string | null } | undefined,
  ): Place {
    const sheet = cityContact(place.fips);
    const government = decideCityGovernment(stateCode, place.type);
    const status = sheet?.status === 'verified' || sheet?.status === 'found' ? sheet.status : null;
    return {
      ...place,
      website: sheet?.website || wiki?.website || null,
      head: sheet?.head_name || wiki?.head || null,
      body: sheet?.body_name || government.body,
      headTitle: sheet?.head_title || government.headTitle,
      email: (status && sheet?.email) || null,
      phone: (status && sheet?.phone) || null,
      contactPage: sheet?.contact_page || null,
      contactStatus: status && (sheet?.email || sheet?.phone) ? status : null,
    };
  }

  // Spreadsheet values win over Wikidata and the state defaults: they're
  // specific to this county and, when verified, checked by a person.
  private buildCounty(
    county: { name: string; fips: string },
    wiki: { website: string | null; head: string | null } | undefined,
    government: { body: string | null; headTitle: string | null },
  ) {
    const sheet = countyContact(county.fips);
    const status = sheet?.status === 'verified' || sheet?.status === 'found' ? sheet.status : null;
    return {
      ...county,
      website: sheet?.website || wiki?.website || null,
      head: sheet?.head_name || wiki?.head || null,
      body: sheet?.body_name || government.body,
      headTitle: sheet?.head_title || government.headTitle,
      email: (status && sheet?.email) || null,
      phone: (status && sheet?.phone) || null,
      contactPage: sheet?.contact_page || null,
      contactStatus: status && (sheet?.email || sheet?.phone) ? status : null,
    };
  }

  async censusLookup(lat: number, lon: number): Promise<CensusLookup | null> {
    const params = new URLSearchParams({
      x: lon.toString(),
      y: lat.toString(),
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      format: 'json',
    });
    const response = await fetch(`${CENSUS_URL}?${params}`, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      throw new Error(`Census geocoder error: ${response.status}`);
    }
    return parseCensusResponse(await response.json());
  }

  async stateLegislators(stateCode: string): Promise<Legislator[]> {
    const code = stateCode.toLowerCase();
    const cacheKey = `openstates:v2:${code}`;
    const cached = await cache.get<Legislator[]>(cacheKey);
    if (cached) return cached;

    const response = await fetch(`${OPENSTATES_CSV_URL}/${code}.csv`, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      throw new Error(`Open States error: ${response.status}`);
    }
    const legislators = parseCsv(await response.text()).map(toLegislator);
    await cache.set(cacheKey, legislators);
    return legislators;
  }

  async localWebsites(census: CensusLookup): Promise<LocalInfo> {
    // Wikidata keys: P882 = 5-digit county FIPS, P774 = "SS-PPPPP" place FIPS
    const countyFips = census.county?.fips ?? '';
    const placeFips = census.place ? `${census.place.fips.slice(0, 2)}-${census.place.fips.slice(2)}` : '';
    // Values are digits/hyphens from Census, but strip anything else before
    // they go into the query text.
    const safe = (s: string) => s.replace(/[^0-9-]/g, '');

    // Mayors appear two ways on Wikidata: a "head of government" (P6) on the
    // city itself, or an office like "Mayor of Springdale" (P1313) whose
    // officeholder (P1308) is listed there. Only best-ranked statements count
    // (editors mark the current one "preferred"), and any with an end date
    // (P582) are former officials and are skipped.
    const query = `SELECT ?kind ?site ?headLabel ?holderLabel WHERE {
      { ?item wdt:P882 "${safe(countyFips)}" . BIND("county" AS ?kind) }
      UNION
      { ?item wdt:P774 "${safe(placeFips)}" . BIND("place" AS ?kind) }
      OPTIONAL { ?item wdt:P856 ?site }
      OPTIONAL { ?item p:P6 ?hs . ?hs a wikibase:BestRank ; ps:P6 ?head . FILTER NOT EXISTS { ?hs pq:P582 ?hEnd } }
      OPTIONAL { ?item wdt:P1313 ?office . ?office p:P1308 ?os . ?os a wikibase:BestRank ; ps:P1308 ?holder . FILTER NOT EXISTS { ?os pq:P582 ?oEnd } }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;

    const response = await fetch(`${WIKIDATA_SPARQL_URL}?${new URLSearchParams({ query })}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/sparql-results+json' },
    });
    if (!response.ok) {
      throw new Error(`Wikidata error: ${response.status}`);
    }
    const json = await response.json() as any;
    // A label that is just the Q-id means the item has no English name
    const label = (v?: string) => (v && !/^Q\d+$/.test(v) ? v : null);
    const seen: Record<string, { sites: string[]; heads: Set<string>; holders: Set<string> }> = {};
    for (const b of json?.results?.bindings ?? []) {
      const kind = b.kind?.value as 'county' | 'place' | undefined;
      if (!kind) continue;
      const k = (seen[kind] ??= { sites: [], heads: new Set(), holders: new Set() });
      if (b.site?.value && !k.sites.includes(b.site.value)) k.sites.push(b.site.value);
      const head = label(b.headLabel?.value);
      const holder = label(b.holderLabel?.value);
      if (head) k.heads.add(head);
      if (holder) k.holders.add(holder);
    }

    // Prefer the place's own head of government. Officeholder lists often
    // have past mayors with no end date, so they're only used as a fallback,
    // and only when exactly one person is listed: a blank beats a wrong name.
    const only = (names: Set<string>) => (names.size === 1 ? [...names][0] : null);
    const info: LocalInfo = {};
    for (const kind of ['county', 'place'] as const) {
      const k = seen[kind];
      if (!k) continue;
      info[kind] = {
        website: k.sites[0] ?? null,
        head: k.heads.size ? only(k.heads) : only(k.holders),
      };
    }
    return info;
  }

  private logSoftError(source: string, err: unknown) {
    otelLogger.emit({
      severityNumber: SeverityNumber.WARN,
      severityText: 'WARN',
      body: `Officials lookup: ${source} failed`,
      attributes: {
        'officials.source': source,
        'exception.message': err instanceof Error ? err.message : String(err),
      },
    });
  }
}

type LocalInfo = Partial<Record<'county' | 'place', { website: string | null; head: string | null }>>;
