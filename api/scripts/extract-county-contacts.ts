// Fills the blank contact columns of data/county-contacts.csv by reading each
// county's own website: the homepage plus a few linked pages whose names
// suggest the governing body, its leader, the clerk, or a contact page.
//
//   bun scripts/extract-county-contacts.ts AR            # one state
//   bun scripts/extract-county-contacts.ts AR --refresh  # also re-check rows already "found"
//
// Results are marked status=found (never "verified") with the page they came
// from, so a person can check them. Rows marked verified are never touched.
// No AI: plain HTML parsing and scoring, so a run costs nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../services/csv';
import { COUNTY_COLUMNS, toCsv } from './build-county-contacts';

// Browser-style prefix because some county hosts reject unknown clients; still names us
const USER_AGENT = 'Mozilla/5.0 (compatible; DeFlockContactFinder/1.2; +https://deflock.org)';
const MAX_PAGES = 6;
const TIMEOUT_MS = 15000;
const CONCURRENCY = 4;

// Link text that likely leads to the people we want to write to
const PAGE_HINTS = /quorum court|commission|board of|supervisors|county council|fiscal court|county judge|county executive|county mayor|elected officials|county clerk|clerk|contact|directory|officials/i;
// Words near an email that suggest it reaches the governing body or its office
const GOOD_CONTEXT = /quorum court|commission|board|supervisor|council|judge|executive|mayor|clerk|county administrator|chair/i;
// Placeholder, tracking, and website-vendor addresses that are never a real contact
const JUNK_EMAIL = /@(example\.(com|org)|domain\.com|email\.com|yourdomain|sentry|[a-z0-9.-]*wixpress\.com|[a-z0-9.-]*sentry\.io|godaddy|squarespace|civicplus|revize|govoffice)|^(name|email|user|you|your\.?name|first\.?last)@|^[0-9a-f]{24,}@|n[o0]r?-?reply/i;
// Emails that reach someone else entirely
const BAD_EMAIL = /webmaster|web\.?admin|noreply|no-reply|donotreply|privacy|hr@|jobs|employment|recruit|911|sheriff|jail|assessor|collector|treasurer|coroner|extension|library|parks|animal|recorder|elections?@|vote|court\.clerk|circuit|probate|surveyor|road|911|ems|health|appraisal|tax/i;

interface Candidate { email: string; score: number; page: string; context: string }

async function fetchText(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null;
    return { url: res.url, html: await res.text() };
  } catch {
    return null;
  }
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Registrable-ish domain: "co.washington.ar.us" and "washingtoncountyar.gov" stay
// whole, "mail.foo.gov" -> "foo.gov". Good enough to tell "their own domain" apart
// from gmail.com and vendor domains.
function baseDomain(host: string): string {
  const parts = host.split('.');
  return parts.length > 3 && /\.(us)$/.test(host) ? host : parts.slice(-2).join('.');
}

// "judge@popecountyar.gov" on www.popecountyar.gov: same county. But a county
// page hosted on a shared state portal (portal.arkansas.gov) doesn't make
// every *.arkansas.gov address the county's: subdomains must match there.
export function sameOrganization(emailDomain: string, siteHost: string): boolean {
  if (emailDomain === siteHost) return true;
  const siteHasSubdomain = siteHost.split('.').length > baseDomain(siteHost).split('.').length;
  return !siteHasSubdomain && baseDomain(emailDomain) === baseDomain(siteHost);
}

export function findCandidates(html: string, page: string, siteHost: string): Candidate[] {
  const out: Candidate[] = [];
  const decoded = html.replace(/&#64;|&#x40;|\[at\]|\(at\)/gi, '@');
  const re = /(?:mailto:)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decoded))) {
    const email = m[1].replace(/\.$/, '').toLowerCase();
    if (/\.(png|jpe?g|gif|svg|webp)$/.test(email) || JUNK_EMAIL.test(email)) continue;
    const around = visibleText(decoded.slice(Math.max(0, m.index - 400), m.index + 200));
    let score = 0;
    if (GOOD_CONTEXT.test(around)) score += 3;
    if (GOOD_CONTEXT.test(email)) score += 2;
    const emailDomain = email.split('@')[1];
    if (sameOrganization(emailDomain, siteHost)) score += 2;
    // Another government's address (a state agency, a city) is the wrong office
    else if (/\.(gov|us)$/.test(emailDomain)) score -= 4;
    if (BAD_EMAIL.test(email)) score -= 6;
    out.push({ email, score, page, context: around.slice(0, 160) });
  }
  return out;
}

function findPhones(text: string): string[] {
  const re = /\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) found.add(`${m[1]}-${m[2]}-${m[3]}`);
  return [...found];
}

function pageLinks(html: string, base: string): string[] {
  const links: { url: string; weight: number }[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = visibleText(m[2]).trim();
    const href = m[1];
    if (!PAGE_HINTS.test(text) && !PAGE_HINTS.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (!/^https?:$/.test(url.protocol) || hostOf(url.href) !== hostOf(base)) continue;
      if (/\.(pdf|docx?|xlsx?|jpg|png)$/i.test(url.pathname)) continue;
      // The governing body's own page beats a generic contact page
      const weight = /quorum court|commission|board|council|judge|executive|mayor/i.test(text) ? 2 : 1;
      links.push({ url: url.href, weight });
    } catch { /* bad href */ }
  }
  const seen = new Set<string>();
  return links
    .sort((a, b) => b.weight - a.weight)
    .map(l => l.url)
    .filter(u => !seen.has(u) && seen.add(u));
}

// Wikidata often has the old http:// address; try https and the bare/www
// variants before giving up on a site.
async function fetchHome(website: string) {
  const url = new URL(website);
  const host = url.hostname.replace(/^www\./, '');
  const tries = [website, `https://${url.hostname}${url.pathname}`, `https://www.${host}/`, `https://${host}/`];
  for (const t of [...new Set(tries)]) {
    const page = await fetchText(t);
    if (page) return page;
  }
  return null;
}

export async function extractCounty(website: string): Promise<{ email: string; phone: string; source: string; finalSite: string } | null> {
  const home = await fetchHome(website);
  if (!home) return null;
  const siteHost = hostOf(home.url);
  const pages = [home, ...(await Promise.all(pageLinks(home.html, home.url).slice(0, MAX_PAGES - 1).map(fetchText)))]
    .filter((p): p is { url: string; html: string } => !!p);

  const candidates = pages.flatMap(p => findCandidates(p.html, p.url, siteHost));
  // Same address on several pages is a better sign it's the main contact
  const byEmail = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = byEmail.get(c.email);
    byEmail.set(c.email, prev ? { ...prev, score: Math.max(prev.score, c.score) + 1 } : c);
  }
  const best = [...byEmail.values()].sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 4) return { email: '', phone: '', source: '', finalSite: home.url };

  const bestPage = pages.find(p => p.url === best.page);
  const phone = bestPage ? findPhones(visibleText(bestPage.html))[0] ?? '' : '';
  return { email: best.email, phone, source: best.page, finalSite: home.url };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

if (import.meta.main) {
  const state = process.argv[2]?.toUpperCase();
  const refresh = process.argv.includes('--refresh');
  if (!state) {
    console.error('usage: bun scripts/extract-county-contacts.ts <STATE> [--refresh]');
    process.exit(1);
  }
  const path = join(import.meta.dir, '../data/county-contacts.csv');
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  const targets = rows.filter(r =>
    r.state === state && r.county_government === 'yes' && r.website && r.status !== 'verified' &&
    (refresh || ['todo', '', 'site_unreachable'].includes(r.status)));

  let found = 0;
  await pool(targets, CONCURRENCY, async r => {
    const result = await extractCounty(r.website);
    if (!result) {
      r.status = 'site_unreachable';
    } else if (result.email) {
      Object.assign(r, { email: result.email, phone: result.phone, contact_page: result.source, source: result.source, checked_on: today, status: 'found' });
      found++;
    } else {
      // Clear anything an earlier run found, so a bad pick can't linger
      Object.assign(r, { email: '', phone: '', contact_page: '', source: '', checked_on: today, status: 'no_email_found' });
    }
    // Follow redirects so stale Wikidata URLs get corrected
    if (result?.finalSite && hostOf(result.finalSite) !== hostOf(r.website)) {
      r.note = [r.note, `Website moved from ${r.website}`].filter(Boolean).join('; ');
      r.website = result.finalSite;
    }
    console.log(`${r.county.padEnd(28)} ${r.status.padEnd(17)} ${r.email}`);
  });

  writeFileSync(path, toCsv(rows, COUNTY_COLUMNS));
  console.log(`\n${state}: ${found} of ${targets.length} counties with a website got an email (status=found, needs a person to verify).`);
}
