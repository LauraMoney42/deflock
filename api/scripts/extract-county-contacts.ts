// Kept so the original command still works:
//   bun scripts/extract-county-contacts.ts AR [--refresh]
// The logic lives in extract-contacts.ts (shared with cities).

import { main } from './extract-contacts';

if (import.meta.main) {
  const [state, ...rest] = process.argv.slice(2);
  await main('county', state, rest);
}
