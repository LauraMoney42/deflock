import { describe, it, expect } from 'bun:test';
import { findCandidates, sameOrganization, pageLinks, nextRowState, profileFor, siteLooksLikePlace, type ExtractResult } from './contact-finder';

const city = profileFor('city');
const county = profileFor('county');
const best = (cs: ReturnType<typeof findCandidates>) => [...cs].sort((a, b) => b.score - a.score)[0];

describe('sameOrganization', () => {
  it('matches the site itself and its sibling subdomains', () => {
    expect(sameOrganization('popecountyar.gov', 'popecountyar.gov')).toBe(true);
    expect(sameOrganization('mail.popecountyar.gov', 'popecountyar.gov')).toBe(true);
  });

  it('does not treat a shared state portal as one organization', () => {
    expect(sameOrganization('adh.arkansas.gov', 'portal.arkansas.gov')).toBe(false);
    expect(sameOrganization('portal.arkansas.gov', 'portal.arkansas.gov')).toBe(true);
  });

  it('keeps locality .us domains of different places apart', () => {
    expect(sameOrganization('fayetteville.ar.us', 'springdale.ar.us')).toBe(false);
    expect(sameOrganization('springdale.ar.us', 'ci.springdale.ar.us')).toBe(true);
    expect(sameOrganization('adh.state.ar.us', 'ci.springdale.ar.us')).toBe(false);
  });

  it('rejects webmail and unrelated domains', () => {
    expect(sameOrganization('gmail.com', 'springdalear.gov')).toBe(false);
  });
});

describe('findCandidates (city)', () => {
  const page = 'https://springdalear.gov/contact';
  const host = 'springdalear.gov';

  it('scores a mayor or clerk address on the city domain highly', () => {
    const html = '<p>Mayor Doe: <a href="mailto:mayor@springdalear.gov">mayor@springdalear.gov</a></p>';
    const top = best(findCandidates(html, page, host, city));
    expect(top.email).toBe('mayor@springdalear.gov');
    expect(top.score).toBeGreaterThanOrEqual(4);
  });

  it('pushes police, utility, and parks addresses below the threshold', () => {
    const html = '<p>City Council contacts</p> police@springdalear.gov water@springdalear.gov parks@springdalear.gov';
    for (const c of findCandidates(html, page, host, city)) expect(c.score).toBeLessThan(4);
  });

  it('does not penalize a city whose domain contains a bad word', () => {
    const html = '<p>City Clerk</p> clerk@cityofwaterloo.org';
    const top = best(findCandidates(html, 'https://cityofwaterloo.org/', 'cityofwaterloo.org', city));
    expect(top.score).toBeGreaterThanOrEqual(4);
  });

  it("penalizes another government's address", () => {
    const html = '<p>City Council</p> info@washingtoncountyar.gov';
    expect(best(findCandidates(html, page, host, city)).score).toBeLessThan(4);
  });

  it('drops website vendors, placeholders, and image filenames', () => {
    const html = 'council support@civicplus.com name@example.com logo@2x.png you@domain.com';
    expect(findCandidates(html, page, host, city)).toEqual([]);
  });

  it('reads obfuscated addresses', () => {
    const html = '<p>Town Clerk: clerk[at]smithtown.gov</p>';
    expect(findCandidates(html, 'https://smithtown.gov/', 'smithtown.gov', city).map(c => c.email)).toEqual(['clerk@smithtown.gov']);
  });
});

describe('findCandidates (city, strict)', () => {
  const page = 'https://springdalear.gov/directory';
  const host = 'springdalear.gov';

  it('rejects a staff address whose label is another department', () => {
    const html = '<p>City Council and staff</p> <a>Email the Fire Department</a> <a href="mailto:cmoore@springdalear.gov">cmoore@springdalear.gov</a>';
    expect(best(findCandidates(html, page, host, city)).score).toBeLessThan(4);
  });

  it('rejects an unlabeled personal address on a directory page, accepts a labeled one', () => {
    const unlabeled = `<p>City Council members</p><p>${'Staff directory listing. '.repeat(5)}</p> <td>ncoulter@springdalear.gov</td>`;
    expect(best(findCandidates(unlabeled, page, host, city)).score).toBeLessThan(4);
    const labeled = '<p>Directory</p> <td>Email Mayor Elmore</td> <a href="mailto:jelmore@springdalear.gov">jelmore@springdalear.gov</a>';
    expect(best(findCandidates(labeled, page, host, city)).score).toBeGreaterThanOrEqual(4);
  });

  it('rejects one council member among many, but keeps the mayor and clerk', () => {
    const roster = '<p>City Council</p><p>Ward 1 Position 2<br><a href="mailto:rboone@springdalear.gov">rboone@springdalear.gov</a></p>';
    expect(best(findCandidates(roster, page, host, city)).score).toBeLessThan(4);
    const gmail = '<p>Council</p> <p>Walter Burgess councilmanburgess@gmail.com</p>';
    expect(best(findCandidates(gmail, 'https://bryantar.gov/', 'bryantar.gov', city)).score).toBeLessThan(4);
    const clerk = '<p>Ward 3 meeting. City Clerk</p> clerk@springdalear.gov';
    expect(best(findCandidates(clerk, page, host, city)).score).toBeGreaterThanOrEqual(4);
  });

  it('reads a caption after a link: the fire department label rejects the address', () => {
    const html = '<p>Directory</p><svg></svg><a href="mailto:cmoore@springdalear.gov"><span>Email the Fire Department</span></a>';
    expect(best(findCandidates(html, page, host, city)).score).toBeLessThan(4);
  });

  it('marks an address labeled as another office as vetoed', () => {
    const html = '<svg></svg><a href="mailto:cmoore@springdalear.gov">Email the Fire Department</a>';
    expect(findCandidates(html, page, host, city).every(c => c.veto)).toBe(true);
  });

  it('accepts an office address like cityhall@ or info@', () => {
    const html = '<p>City Council</p> cityhall@springdalear.gov';
    expect(best(findCandidates(html, page, host, city)).score).toBeGreaterThanOrEqual(4);
  });

  it('rejects a web designer or accountant domain, but accepts webmail and a related city domain', () => {
    const vendor = '<footer>Copyright City of Tontitown, site by info@lakedesigns.com</footer>';
    expect(best(findCandidates(vendor, 'https://tontitown.com/', 'tontitown.com', city)).score).toBeLessThan(4);
    const gmail = '<p>City Clerk</p> cityclerk@gmail.com';
    expect(best(findCandidates(gmail, 'https://keoar.com/', 'keoar.com', city)).score).toBeGreaterThanOrEqual(4);
    const alt = '<p>City Clerk</p> clerk@bentonvillear.com';
    expect(best(findCandidates(alt, 'https://www.bentonville.ar.gov/', 'bentonville.ar.gov', city)).score).toBeGreaterThanOrEqual(4);
  });
});

describe('siteLooksLikePlace', () => {
  it('trusts government domains and hosts carrying the city name', () => {
    expect(siteLooksLikePlace('nlr.ar.gov', 'North Little Rock city')).toBe(true);
    expect(siteLooksLikePlace('keoar.com', 'Keo town')).toBe(true);
    expect(siteLooksLikePlace('cityofcherokeevillage.org', 'Cherokee Village city')).toBe(true);
  });

  it('distrusts a chamber or development-group site', () => {
    expect(siteLooksLikePlace('pnpartnership.org', 'Prescott city')).toBe(false);
  });
});

describe('findCandidates (county)', () => {
  it('keeps the county scoring: a judge address on the county domain passes', () => {
    const html = '<p>County Judge</p> judge@popecountyar.gov';
    expect(best(findCandidates(html, 'https://popecountyar.gov/', 'popecountyar.gov', county)).score).toBeGreaterThanOrEqual(4);
  });

  it('keeps the sheriff out', () => {
    const html = '<p>Contact</p> sheriff@popecountyar.gov';
    expect(best(findCandidates(html, 'https://popecountyar.gov/', 'popecountyar.gov', county)).score).toBeLessThan(4);
  });

  it('defaults to the county profile', () => {
    const html = '<p>Quorum Court</p> clerk@popecountyar.gov';
    expect(findCandidates(html, 'https://popecountyar.gov/', 'popecountyar.gov')[0].score)
      .toBe(findCandidates(html, 'https://popecountyar.gov/', 'popecountyar.gov', county)[0].score);
  });
});

describe('pageLinks', () => {
  const html = `
    <a href="/contact">Contact Us</a>
    <a href="/council">City Council</a>
    <a href="https://other.org/council">Council</a>
    <a href="/agenda.pdf">City Council agenda</a>
    <a href="/parks">Parks</a>`;

  it('follows same-site links about the body or contact, body page first', () => {
    expect(pageLinks(html, 'https://springdalear.gov/', city)).toEqual([
      'https://springdalear.gov/council',
      'https://springdalear.gov/contact',
    ]);
  });
});

describe('nextRowState', () => {
  const today = '2026-10-22';
  const found: ExtractResult = { email: 'mayor@x.gov', phone: '479-555-0100', source: 'https://x.gov/contact', finalSite: 'https://x.gov/' };
  const none: ExtractResult = { email: '', phone: '', source: '', finalSite: 'https://x.gov/' };
  const prevFound = {
    status: 'found', email: 'old@x.gov', phone: '479-555-0199', contact_page: 'https://x.gov/old', source: 'https://x.gov/old',
    website: 'https://x.gov/', note: '', checked_on: '2026-10-01',
  };

  it('keeps a found contact when the site is unreachable, recording only the attempt', () => {
    const patch = nextRowState(prevFound, null, today);
    expect(patch).toEqual({ last_attempt: '2026-10-22 site unreachable' });
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('email');
  });

  it('marks site_unreachable only for rows that never had a contact', () => {
    expect(nextRowState({ status: 'todo', website: 'https://x.gov/' }, null, today))
      .toEqual({ status: 'site_unreachable', last_attempt: '2026-10-22 site unreachable' });
  });

  it('keeps a lone phone number too', () => {
    expect(nextRowState({ status: 'found', phone: '479-555-0100' }, null, today)).not.toHaveProperty('status');
  });

  it('clears an old pick only when the site loaded and nothing acceptable was found', () => {
    expect(nextRowState(prevFound, none, today)).toMatchObject({ email: '', phone: '', contact_page: '', source: '', status: 'no_email_found' });
  });

  it('records a new find as found, never verified', () => {
    const patch = nextRowState({ status: 'todo', website: 'https://x.gov/' }, found, today);
    expect(patch).toMatchObject({ email: 'mayor@x.gov', status: 'found', checked_on: today, contact_page: 'https://x.gov/contact' });
  });

  it('never touches verified rows', () => {
    const verified = { ...prevFound, status: 'verified' };
    expect(nextRowState(verified, null, today)).toEqual({});
    expect(nextRowState(verified, none, today)).toEqual({});
    expect(nextRowState(verified, found, today)).toEqual({});
  });

  it('corrects a moved website and notes it', () => {
    const patch = nextRowState({ status: 'todo', website: 'http://old.gov/', note: '' }, { ...found, finalSite: 'https://new.gov/' }, today);
    expect(patch.website).toBe('https://new.gov/');
    expect(patch.note).toBe('Website moved from http://old.gov/');
  });
});
