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
