// Shared logic for finding a government's contact email on its own website,
// used for both counties and cities (see extract-contacts.ts). The homepage
// plus a few linked pages whose names suggest the governing body, its leader,
// the clerk, or a contact page are scored for email addresses.
//
// No AI: plain HTML parsing and scoring, so a run costs nothing. The scoring
// favors a wrong-but-absent answer over a wrong-but-present one: a letter
// sent to the police department or a web vendor is worse than a blank.

// Browser-style prefix because some hosts reject unknown clients; still names us
const USER_AGENT = 'Mozilla/5.0 (compatible; DeFlockContactFinder/1.2; +https://deflock.org)';
const MAX_PAGES = 6;
const TIMEOUT_MS = 15000;

export type ContactKind = 'county' | 'city';

export interface FinderProfile {
  /** Link text or href that likely leads to the people we want to write to */
  pageHints: RegExp;
  /** Link text that marks the governing body's own page, which beats a generic contact page */
  bodyLink: RegExp;
  /** Words near an email that suggest it reaches the governing body or its office */
  goodContext: RegExp;
  /** Emails that reach someone else entirely */
  badEmail: RegExp;
  /** City domains often contain words like "water" or "parks" (cityofwaterloo.org), so cities test only the part before the @ */
  badEmailScope: 'email' | 'local';
  /**
   * Cities only: an address needs evidence that it reaches the governing body or
   * its office (a role in the text right beside it, or a role-like name before
   * the @). Directory pages list every staff member, and an unlabeled
   * "ncoulter@" could be anyone. Also penalizes unrelated non-government domains.
   */
  strict?: boolean;
}

// Placeholder, tracking, and website-vendor addresses that are never a real contact
const JUNK_EMAIL = /@(example\.(com|org)|domain\.com|email\.com|yourdomain|sentry|[a-z0-9.-]*wixpress\.com|[a-z0-9.-]*sentry\.io|godaddy|squarespace|civicplus|revize|govoffice|municode|granicus|opengov|CivicEngage|municipalimpact|townweb|vc3|tylertech)|^(name|email|user|you|your\.?name|first\.?last)@|^[0-9a-f]{24,}@|n[o0]r?-?reply/i;

const COUNTY_PROFILE: FinderProfile = {
  pageHints: /quorum court|commission|board of|supervisors|county council|fiscal court|county judge|county executive|county mayor|elected officials|county clerk|clerk|contact|directory|officials/i,
  bodyLink: /quorum court|commission|board|council|judge|executive|mayor/i,
  goodContext: /quorum court|commission|board|supervisor|council|judge|executive|mayor|clerk|county administrator|chair/i,
  badEmail: /webmaster|web\.?admin|noreply|no-reply|donotreply|privacy|hr@|jobs|employment|recruit|911|sheriff|jail|assessor|collector|treasurer|coroner|extension|library|parks|animal|recorder|elections?@|vote|court\.clerk|circuit|probate|surveyor|road|911|ems|health|appraisal|tax/i,
  badEmailScope: 'email',
};

const CITY_PROFILE: FinderProfile = {
  pageHints: /council|mayor|alderm[ae]n|trustee|select ?board|selectmen|commission|board of|clerk|recorder|city manager|town manager|administrator|city hall|town hall|village hall|contact|directory|officials|elected/i,
  bodyLink: /council|mayor|alderm[ae]n|trustee|select|commission|board|clerk|recorder/i,
  goodContext: /council|mayor|alderm[ae]n|trustee|select ?board|selectmen|commission|board|clerk|recorder|city manager|town manager|administrator|city hall|town hall|village hall|president|chair/i,
  badEmail: /webmaster|web\.?admin|noreply|no-reply|donotreply|privacy|^hr\b|hr@|jobs|employment|recruit|911|police|^pd\b|^cpd|sheriff|fire|^fd\b|ems\b|jail|dispatch|court|judge|attorney|water|sewer|utilit|electric|sanitation|trash|waste|streets?\b|public.?works|parks?\b|recreation|pool|library|animal|code|permit|planning|zoning|building|inspect|assessor|collector|payroll|billing|accounting|accounts|payable|receivable|finance|airport|cemetery|chamber|tourism|economic|events|senior|school|elections?|vote|health|tax/i,
  badEmailScope: 'local',
  strict: true,
};

export function profileFor(kind: ContactKind): FinderProfile {
  return kind === 'city' ? CITY_PROFILE : COUNTY_PROFILE;
}

export interface Candidate {
  email: string; score: number; page: string; context: string;
  /** Strict profiles only: this occurrence is labeled as another office, so the address is dropped even if it also appears unlabeled elsewhere */
  veto?: boolean;
}

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

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Locality domains like "springdale.ar.us" belong to one place. Unlike
// "state.ar.us" they are safe to treat as the owner even from a subdomain.
const LOCALITY_US = /^(?!state\.)[^.]+\.[a-z]{2}\.us$/;

// Registrable-ish domain: "washingtoncountyar.gov" stays whole, "mail.foo.gov"
// -> "foo.gov", "ci.springdale.ar.us" -> "springdale.ar.us". Good enough to
// tell "their own domain" apart from gmail.com and vendor domains.
export function baseDomain(host: string): string {
  const parts = host.split('.');
  if (/\.[a-z]{2}\.us$/.test(host) && parts.length >= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// "judge@popecountyar.gov" on www.popecountyar.gov: same county. But a page
// hosted on a shared state portal (portal.arkansas.gov) doesn't make every
// *.arkansas.gov address theirs: subdomains must match there.
export function sameOrganization(emailDomain: string, siteHost: string): boolean {
  if (emailDomain === siteHost) return true;
  const base = baseDomain(siteHost);
  const siteHasSubdomain = siteHost.split('.').length > base.split('.').length;
  if (baseDomain(emailDomain) !== base) return false;
  return !siteHasSubdomain || LOCALITY_US.test(base);
}

const FREE_MAIL = /^(gmail|yahoo|aol|outlook|hotmail|live|msn|icloud|comcast|sbcglobal|att|bellsouth|cox|windstream|suddenlink|netzero|mac|me|protonmail)\./i;
// A local part that names an office rather than a person
const OFFICE_LOCAL = /^(info|contact|office|offices|admin|administration|general)\b|(city|town|village|borough)\.?hall/i;

// One member of the body among many (a council roster lists each ward seat).
// A letter meant for the whole body shouldn't go to one member's inbox.
const INDIVIDUAL_LABEL = /\bward\b|\bposition\b|alderman|alderwoman|alderperson|council ?(man|woman|member|person)|commissioner|trustee/i;
const INDIVIDUAL_LOCAL = /councilman|councilwoman|councilmember|alderman|alderwoman|ward\d/i;

// "bentonvillear.com" vs "bentonville.ar.gov": same place, different domain
function relatedDomains(a: string, b: string): boolean {
  const label = (d: string) => d.split('.')[0].replace(/[^a-z0-9]/g, '').replace(/^(cityof|townof|villageof|boroughof|the)/, '');
  const [x, y] = [label(a), label(b)];
  if (x.length < 5 || y.length < 5) return x === y;
  for (let i = 0; i + 5 <= x.length; i++) if (y.includes(x.slice(i, i + 5))) return true;
  return false;
}

export function findCandidates(html: string, page: string, siteHost: string, profile: FinderProfile = COUNTY_PROFILE): Candidate[] {
  const out: Candidate[] = [];
  const decoded = html.replace(/&#64;|&#x40;|\[at\]|\(at\)/gi, '@');
  const re = /(?:mailto:)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decoded))) {
    const email = m[1].replace(/\.$/, '').toLowerCase();
    if (/\.(png|jpe?g|gif|svg|webp)$/.test(email) || JUNK_EMAIL.test(email)) continue;
    const around = visibleText(decoded.slice(Math.max(0, m.index - 400), m.index + 200));
    const [local, emailDomain] = email.split('@');
    let score = 0;
    if (profile.goodContext.test(around)) score += 3;
    if (profile.goodContext.test(email)) score += 2;
    const own = sameOrganization(emailDomain, siteHost);
    if (own) score += 2;
    // Another government's address (a state agency, a county) is the wrong office
    else if (/\.(gov|us)$/.test(emailDomain)) score -= 4;
    if (profile.badEmail.test(profile.badEmailScope === 'local' ? local : email)) score -= 6;

    let veto = false;
    if (profile.strict) {
      // The few words right before the address are its label ("Email the Fire
      // Department", "Mayor Jim Renfrow"); the wider window mixes neighbors.
      // The text may come before the link (name above address) or after it (the
      // link's own "Email the Fire Department" caption), so look both ways.
      const end = m.index + m[0].length;
      const label = `${visibleText(decoded.slice(Math.max(0, m.index - 160), m.index)).slice(-60)} | ${visibleText(decoded.slice(end, end + 160)).slice(0, 60)}`;
      if (profile.badEmail.test(label)) { score -= 6; veto = true; }
      const roleLocal = /mayor|clerk|recorder|^council$|citycouncil/i.test(local) || OFFICE_LOCAL.test(local);
      if ((INDIVIDUAL_LABEL.test(label) || INDIVIDUAL_LOCAL.test(local)) && !roleLocal) score -= 4;
      const strong = profile.goodContext.test(label) || profile.goodContext.test(local) || OFFICE_LOCAL.test(local);
      // Weak evidence can't pass, and is capped low enough that repeating on many pages can't lift it either
      if (!strong) score = Math.min(score, 1);
      // A vendor, accountant, or partner organization, not the city or free webmail
      if (!own && !FREE_MAIL.test(emailDomain) && !/\.(gov|us)$/.test(emailDomain) && !relatedDomains(emailDomain, siteHost)) score -= 3;
    }
    out.push({ email, score, page, context: around.slice(0, 160), veto });
  }
  return out;
}

export function findPhones(text: string): string[] {
  const re = /\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) found.add(`${m[1]}-${m[2]}-${m[3]}`);
  return [...found];
}

export function pageLinks(html: string, base: string, profile: FinderProfile = COUNTY_PROFILE): string[] {
  const links: { url: string; weight: number }[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = visibleText(m[2]).trim();
    const href = m[1];
    if (!profile.pageHints.test(text) && !profile.pageHints.test(href)) continue;
    try {
      const url = new URL(href, base);
      if (!/^https?:$/.test(url.protocol) || hostOf(url.href) !== hostOf(base)) continue;
      if (/\.(pdf|docx?|xlsx?|jpg|png)$/i.test(url.pathname)) continue;
      // The governing body's own page beats a generic contact page
      const weight = profile.bodyLink.test(text) ? 2 : 1;
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
  let url: URL;
  try { url = new URL(website); } catch { return null; }
  const host = url.hostname.replace(/^www\./, '');
  const tries = [website, `https://${url.hostname}${url.pathname}`, `https://www.${host}/`, `https://${host}/`];
  for (const t of [...new Set(tries)]) {
    const page = await fetchText(t);
    if (page) return page;
  }
  return null;
}

export interface ExtractResult { email: string; phone: string; source: string; finalSite: string }

// Wikidata's "official website" for a small town is sometimes a chamber of
// commerce or development group. A city's real site is on a .gov/.us domain or
// has the city's name in the host; anything else is not trusted for emails.
export function siteLooksLikePlace(host: string, placeName: string): boolean {
  if (/\.(gov|us)$/.test(host)) return true;
  const token = placeName
    .replace(/\s*\(balance\)\s*$/, '')
    .replace(/\s+(city and borough|city|town|village|borough|township|municipality)$/i, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  return token.length > 0 && host.replace(/[^a-z0-9]/g, '').includes(token.slice(0, 6));
}

/** null = the site could not be loaded; an empty email = it loaded but nothing acceptable was on it */
export async function extractContact(website: string, kind: ContactKind, placeName?: string): Promise<ExtractResult | null> {
  const profile = profileFor(kind);
  const home = await fetchHome(website);
  if (!home) return null;
  const siteHost = hostOf(home.url);
  if (kind === 'city' && placeName && !siteLooksLikePlace(siteHost, placeName)) {
    return { email: '', phone: '', source: '', finalSite: home.url };
  }
  const pages = [home, ...(await Promise.all(pageLinks(home.html, home.url, profile).slice(0, MAX_PAGES - 1).map(fetchText)))]
    .filter((p): p is { url: string; html: string } => !!p);

  const candidates = pages.flatMap(p => findCandidates(p.html, p.url, siteHost, profile));
  // Same address on several pages is a better sign it's the main contact
  const byEmail = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = byEmail.get(c.email);
    // The bonus only applies to an address that already looks right: a vendor's
    // footer link repeats on every page and must not climb on repetition alone.
    const top = prev ? Math.max(prev.score, c.score) : c.score;
    byEmail.set(c.email, prev ? { ...prev, score: top >= 2 ? top + 1 : top, veto: prev.veto || c.veto } : c);
  }
  const best = [...byEmail.values()].filter(c => !c.veto).sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 4) return { email: '', phone: '', source: '', finalSite: home.url };

  const bestPage = pages.find(p => p.url === best.page);
  const phone = bestPage ? findPhones(visibleText(bestPage.html))[0] ?? '' : '';
  return { email: best.email, phone, source: best.page, finalSite: home.url };
}

/**
 * What to write back to a spreadsheet row after one check of its website.
 * A flaky run must never make a contact disappear:
 * - site unreachable: keep any email/phone/status, only record the attempt;
 *   rows that never had a contact become site_unreachable
 * - site loaded, nothing acceptable: clear the old pick (a bad one can't linger)
 * - site loaded, email found: status=found (never "verified")
 * Verified rows are never changed.
 */
export function nextRowState(
  prev: Record<string, string>,
  result: ExtractResult | null,
  today: string,
): Record<string, string> {
  if (prev.status === 'verified') return {};

  if (!result) {
    const hadContact = !!(prev.email || prev.phone);
    return hadContact
      ? { last_attempt: `${today} site unreachable` }
      : { status: 'site_unreachable', last_attempt: `${today} site unreachable` };
  }

  // Follow redirects so stale Wikidata URLs get corrected
  const moved = result.finalSite && hostOf(result.finalSite) !== hostOf(prev.website ?? '')
    ? { website: result.finalSite, note: [prev.note, `Website moved from ${prev.website}`].filter(Boolean).join('; ') }
    : {};

  if (result.email) {
    return {
      email: result.email, phone: result.phone, contact_page: result.source, source: result.source,
      checked_on: today, last_attempt: `${today} found`, status: 'found', ...moved,
    };
  }
  return {
    email: '', phone: '', contact_page: '', source: '',
    checked_on: today, last_attempt: `${today} no email found`, status: 'no_email_found', ...moved,
  };
}

export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
