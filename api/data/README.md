# API data files

## state-legislator-overrides.csv

Hand-checked fixes for state legislator contacts, applied on top of Open States data by `services/OfficialsService.ts`. Edit it in any spreadsheet app and save as CSV.

| Column | Meaning |
| --- | --- |
| state | Two-letter code, e.g. `CO` |
| chamber | `upper`, `lower`, or `legislature` (Nebraska) |
| district | As Open States writes it, e.g. `21`, `19A`, `Hillsborough 13` |
| name | Full name, matching Open States exactly to fill gaps for an existing legislator |
| party, email, phone, url | Values to fill in. Blank cells change nothing |
| source | Where the value came from (official page URL) |
| checked_on | Date someone confirmed it, `YYYY-MM-DD` |
| note | Free text |

Rules:
- A row only fills **blank** fields of an existing legislator. It never overwrites Open States data.
- A row whose name isn't in Open States for that district adds a new legislator (for example, someone who filled a vacancy).
- Rows with no email/phone/url are a to-check list and have no effect.
- The API reads this file once at startup, so restart it after editing.

## county-government-by-state.csv

What each state's county governing body and its leader are usually called, used to write the county letter's greeting ("Dear County Judge Smith and Members of the Washington County Quorum Court,").

- `has_county_government`: `no` for Connecticut, Rhode Island, Vermont, and DC.
- `varies`: `yes` where counties in the state use different names. The letter then says "Dear Washington County officials," instead of guessing.
- Fact-checked 2026-10-22. Delaware and Oregon were checked against official sources; the other rows were reviewed but not each checked against a source.

Special cases (consolidated city-counties, independent cities, abolished Massachusetts counties, NYC boroughs, Alaska census areas) are in `services/CountyGovernment.ts`.

## county-contacts.csv

One row per US county (50 states + DC). Values here win over Wikidata and the state defaults.

| Column | Meaning |
| --- | --- |
| fips | 5-digit county FIPS code (don't edit) |
| state, county | Census names (don't edit) |
| county_government | `no` where the county has no government to write to |
| body_name, head_title, head_name | Override the state default for this county, e.g. a Nebraska county that uses a Board of Supervisors |
| email, phone | Main contact for the governing body or its leader. A clerk's address is fine ("please share with all members") |
| website, contact_page | County site and the page the contact came from |
| source, checked_on | Where the value came from and when |
| status | `todo`, `found` (filled by the script, not yet checked), `verified` (a person checked it), `no_email_found`, `site_unreachable`, `not_applicable` |
| note | Free text |

To verify a row: open `contact_page`, confirm the email reaches the county judge, commission, or clerk, then set `status` to `verified` and `checked_on` to today. The extraction script never touches verified rows.

Commands (run from `api/`):
- `bun scripts/build-county-contacts.ts <gazetteer.txt> <wikidata.csv>` adds new counties and fills empty websites; it keeps everything already in the sheet.
- `bun scripts/extract-contacts.ts county AR` fills blank contacts for one state from county websites. `--refresh` re-checks rows already `found`. (`bun scripts/extract-county-contacts.ts AR` still works.)
- Restart the API after editing any file in this folder. The response cache key includes a hash of the CSVs, so a restart is enough to show edits.

A site that fails to load never erases a contact: a `found` row keeps its email, phone, and status, and only `last_attempt` records the failed check. Only rows that never had a contact become `site_unreachable`. An old email is cleared only when the site loaded fine and no acceptable address was on it.

`last_attempt` is the date and outcome of the most recent automatic check, e.g. `2026-10-22 site unreachable`.

## city-government-by-state.csv

What a city, town, village, or borough's governing body and leader are usually called, used to write the city letter's greeting ("Dear Mayor McNally and Members of the Westminster City Council,").

Census gives every incorporated place a type in its name ("Westminster city", "Smithtown town", "Pleasantville village", "Doylestown borough"). Rows are keyed by `state` + `place_type`; a `default` state row covers a type where no state row exists.

- `varies`: `yes` where places of that type in the state commonly differ (council-manager vs. aldermen, commission vs. council, and so on). The body name is then blank and the letter says "Dear Ashland officials," (or "Dear Mayor Smith and Ashland officials," when the mayor is known) instead of guessing. `head_title` still applies in a varies row, because in many states every city has a mayor even when the council's name differs; leave it empty if the leader's title differs too. A wrong name is worse than a neutral one, so when in doubt use `yes`.
- `note`: confidence and examples. States and types with no row fall back to `default`: cities get "City Council" / "Mayor", every other type is neutral.
- Written 2026-10-22 from knowledge of state municipal codes; not each row checked against a source. Treat `no` rows for TX, NC, IL, OH, and the `default` city row as medium confidence.

## city-contacts.csv

One row per incorporated place in the 50 states + DC (about 19,500: cities, towns, villages, boroughs, and similar). Census-designated places and Puerto Rico are left out because they have no government to write to. Values here win over Wikidata and the type defaults.

| Column | Meaning |
| --- | --- |
| fips | 7-digit Census place GEOID, state + place (don't edit) |
| state, city | Census names, e.g. `Westminster city` (don't edit) |
| place_type | Suffix of the Census name: `city`, `town`, `village`, `borough`, ... (don't edit) |
| body_name, head_title, head_name | Override the table default for this place, e.g. a Missouri city that has a Board of Aldermen |
| email, phone | Main contact for the governing body or its leader. A clerk's address is fine ("please share with all members") |
| website, contact_page | City site and the page the contact came from |
| source, checked_on | Where the value came from and when |
| last_attempt | Date and outcome of the last automatic check |
| status | `todo`, `found` (filled by the script, not yet checked), `verified` (a person checked it), `no_email_found`, `site_unreachable`, `not_applicable` |
| note | Free text |

To verify a row: open `contact_page`, confirm the email reaches the council, mayor, or clerk, then set `status` to `verified` and `checked_on` to today. The extraction script never touches verified rows.

Commands (run from `api/`):
- `bun scripts/build-city-contacts.ts <gazetteer-places.txt> <wikidata.csv>` adds new places and fills empty websites; it keeps everything already in the sheet. Inputs: the Census 2024 Gazetteer places file (`2024_Gaz_place_national.txt`, from https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip) and a CSV with columns `fips,site` from one Wikidata query: `SELECT ?fips ?site WHERE { ?item wdt:P774 ?fips . ?item wdt:P856 ?site }` (P774 is "SS-PPPPP"). Keep downloads out of the repo.
- `bun scripts/extract-contacts.ts city AR` fills blank contacts for one state from city websites. `--refresh` re-checks rows already `found`, `--limit N` checks only the first N rows, `--concurrency N` sets parallel fetches (default 6).
- Restart the API after editing either city file.
