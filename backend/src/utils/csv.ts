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

/**
 * A PLAIN NEGATIVE NUMBER — the one leading-`-` value that is data rather than a formula.
 *
 * The guard below neutralises anything starting with `-`, which is right for `-1+1+cmd|...` and
 * wrong for `-1`. Excel took the apostrophe literally on a value read from a FILE (unlike one typed
 * into a cell, where it is a hidden text marker), so "Days Remaining" on an overdue hire arrived as
 * the text `'-1`: left-aligned, unsummable, unsortable, and looking like a bug in the export.
 *
 * Deliberately narrow. `-1+1` does not match, `+44 20…` does not match (a leading `+` is left
 * escaped, as a phone number is not arithmetic anybody wants evaluated), and neither does anything
 * with a space, a currency symbol or an exponent. Only a bare integer or decimal passes.
 */
const PLAIN_NEGATIVE_NUMBER = /^-\d+(\.\d+)?$/;

/** Escape one cell: neutralise formula triggers, then quote if the value contains CSV syntax. */
export function csvEscape(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value) && !PLAIN_NEGATIVE_NUMBER.test(value);
  const safe = risky ? `'${value}` : value;
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

/**
 * The most rows any single export will render into memory.
 *
 * One number, not one per module. It was defined three times over (audit, inventory, customer) with
 * the same value and the same reasoning written out three times — which is fine right up until one
 * of them is tuned and the others silently disagree about what "capped" means.
 *
 * A cap, not a stream, because an export is built as one string: the ceiling is what stops a filter
 * that matches everything from asking the process to hold an unbounded document. Callers report the
 * truncation (see sendCsv's X-Export-Capped) rather than hiding it — a short file the user believes
 * is complete is worse than no file.
 */
export const EXPORT_MAX = 50_000;

/**
 * The paging an export hands to the list function it delegates to.
 *
 * Every CSV export that reuses a list function needs the same three values, and getting two of them
 * right was not enough. `pageSize: EXPORT_MAX + 1` asks for one row more than the cap so a full page
 * is distinguishable from a truncated one without a second count — but `paginate` bounds pageSize to
 * 100 for anything a client can ask for, so without `maxPageSize` the request was clamped, every
 * export stopped at 100 rows, and `capped` (measured on the same clamped length) said the file was
 * complete. Spreading this object is what keeps the pair in step.
 *
 * Lifting the cap is safe here precisely because it is NOT reachable from the wire: controllers build
 * their list params field by field from `req.query`, so `maxPageSize` only ever has the value an
 * export gives it, and EXPORT_MAX remains the real ceiling on rows rendered into memory.
 */
export const EXPORT_PAGING = {
  page: 1,
  pageSize: EXPORT_MAX + 1,
  maxPageSize: EXPORT_MAX + 1,
} as const;
