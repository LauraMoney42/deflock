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
- `bun scripts/extract-county-contacts.ts AR` fills blank contacts for one state from county websites. `--refresh` re-checks rows already `found`.
- Restart the API after editing either file.
