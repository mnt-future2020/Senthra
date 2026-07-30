// CSV building, in one place.
//
// This function existed FOUR times — byte-identical copies in audit, inventory, aggregation and
// movement — and each new export added a fifth. That matters more than ordinary duplication because
// of what the first line does: it is a CSV-INJECTION guard, not formatting. A cell beginning `=`,
// `+`, `-`, `@`, tab or CR is treated by Excel and Sheets as a FORMULA, so a supplier named
// `=cmd|'/c calc'!A0` becomes code the moment someone opens the download. Prefixing an apostrophe
// makes the spreadsheet read it as text.
//
// Five copies of a security control is four chances to fix a hole in the wrong one. Anything that
// emits CSV must come through here.

/** Escape one cell: neutralise formula triggers, then quote if the value contains CSV syntax. */
export function csvEscape(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /["\n,\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Build a full CSV document from a header and rows. Cells may be any primitive — null/undefined
 * become empty, everything else is stringified — so callers don't litter `?? ""` at every field.
 *
 * Rows are joined with CRLF: it is what RFC 4180 specifies and what Excel expects, and a bare LF is
 * the reason a CSV occasionally opens as one long line on Windows.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map((v) => csvEscape(v == null ? "" : String(v))).join(","));
  }
  return lines.join("\r\n");
}
