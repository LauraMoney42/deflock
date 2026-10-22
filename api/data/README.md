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
