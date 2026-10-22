import { createCache, Cache } from 'cache-manager';
import { Type, Static } from '@sinclair/typebox';
import { otelLogger, SeverityNumber } from '../telemetry';
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
  url: Type.Union([Type.String(), Type.Null()]),
});

export const OfficialsResultSchema = Type.Object({
  state: Type.Object({ code: Type.String(), name: Type.String(), fips: Type.String() }),
  place: Type.Union([LocalGovSchema, Type.Null()]),
  county: Type.Union([LocalGovSchema, Type.Null()]),
  stateLegislators: Type.Array(LegislatorSchema),
});

export type LocalGov = Static<typeof LocalGovSchema>;
export type Legislator = Static<typeof LegislatorSchema>;
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
  place: { name: string; fips: string } | null;
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
    place: place ? { name: place.BASENAME, fips: place.GEOID } : null,
    upperDistrict: upper?.BASENAME ?? null,
    lowerDistrict: lower?.BASENAME ?? null,
  };
}

// Minimal RFC 4180 parser: Open States CSVs quote fields that contain commas,
// quotes, or newlines (biographies do), so a plain split(',') is not enough.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header, ...data] = rows;
  if (!header) return [];
  return data
    .filter(r => r.length > 1)
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
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
    // "links" is semicolon-separated; the first is the official legislature page
    url: row.links?.split(';')[0] || null,
  };
}

export function matchLegislators(all: Legislator[], lookup: CensusLookup): Legislator[] {
  const upper = lookup.upperDistrict ? normalizeDistrict(lookup.upperDistrict) : null;
  const lower = lookup.lowerDistrict ? normalizeDistrict(lookup.lowerDistrict) : null;
  return all.filter(l => {
    const d = normalizeDistrict(l.district);
    // Nebraska's unicameral legislature is reported by Census as "Upper"
    if (l.chamber === 'upper' || l.chamber === 'legislature') return d === upper;
    return d === lower;
  });
}

export class OfficialsService {
  async lookup(lat: number, lon: number): Promise<OfficialsResult | null> {
    // ~110m grid: every request for the same camera hits the same key
    const cacheKey = `officials:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const cached = await cache.get<OfficialsResult>(cacheKey);
    if (cached) return cached;

    const census = await this.censusLookup(lat, lon);
    if (!census) return null;

    // Legislators and websites are nice-to-have: a failure there still returns
    // the city/county/state names so the user can find contacts themselves.
    const [legislators, websites] = await Promise.all([
      this.stateLegislators(census.state.code).catch(err => { this.logSoftError('openstates', err); return []; }),
      this.localWebsites(census).catch(err => { this.logSoftError('wikidata', err); return {} as LocalInfo; }),
    ]);

    const result: OfficialsResult = {
      state: census.state,
      place: census.place ? {
        ...census.place,
        website: websites.place?.website ?? null,
        head: websites.place?.head ?? null,
      } : null,
      county: census.county ? {
        ...census.county,
        website: websites.county?.website ?? null,
        head: websites.county?.head ?? null,
      } : null,
      stateLegislators: matchLegislators(legislators, census),
    };

    await cache.set(cacheKey, result);
    return result;
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
    const cacheKey = `openstates:${code}`;
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

    const query = `SELECT ?kind ?site ?headLabel WHERE {
      { ?item wdt:P882 "${safe(countyFips)}" . BIND("county" AS ?kind) }
      UNION
      { ?item wdt:P774 "${safe(placeFips)}" . BIND("place" AS ?kind) }
      OPTIONAL { ?item wdt:P856 ?site }
      OPTIONAL { ?item wdt:P6 ?head }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;

    const response = await fetch(`${WIKIDATA_SPARQL_URL}?${new URLSearchParams({ query })}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/sparql-results+json' },
    });
    if (!response.ok) {
      throw new Error(`Wikidata error: ${response.status}`);
    }
    const json = await response.json() as any;
    const info: LocalInfo = {};
    for (const b of json?.results?.bindings ?? []) {
      const kind = b.kind?.value as 'county' | 'place' | undefined;
      if (!kind || info[kind]) continue;
      info[kind] = {
        website: b.site?.value ?? null,
        // A label that is just the Q-id means the item has no English name
        head: b.headLabel?.value && !/^Q\d+$/.test(b.headLabel.value) ? b.headLabel.value : null,
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
