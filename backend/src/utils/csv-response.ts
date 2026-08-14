import type { Response } from "express";

/**
 * Send a built CSV as a file download. The ONE place an export answers the browser.
 *
 * Four things have to be right on every export, and each was previously retyped per module:
 *
 *   · the content type, so the browser downloads rather than renders it
 *   · the filename, stamped with the date the extract was taken
 *   · a UTF-8 BOM, without which Excel mangles accented text
 *   · the truncation flag, so a capped export is not passed off as complete
 *
 * The flag is the one that bites. It rides on a response header, and this API is ALWAYS cross-origin
 * from the dashboard — so the header must also be in EXPOSED_HEADERS (app.ts) or the browser strips
 * it and `capped` silently reads false. Every module used to invent its own name for it
 * (X-Audit-Export-Capped, X-Inventory-Export-Capped, X-Movement-Export-Capped…), which meant a new
 * export needed a matching CORS entry nobody would think to add, failing silently when they didn't.
 *
 * There is now ONE header for all of them: X-Export-Capped. A new export gets the behaviour by
 * calling this function, and there is nothing left to remember.
 */
export interface CsvExport {
  csv: string;
  capped: boolean;
}

/** The canonical truncation header. Exported so app.ts's CORS list names it rather than a string. */
export const EXPORT_CAPPED_HEADER = "X-Export-Capped";

/**
 * @param base filename WITHOUT extension or date — "purchase-orders", "suppliers". The date and
 *             `.csv` are appended here so every download reads the same way.
 */
export function sendCsv(res: Response, base: string, { csv, capped }: CsvExport): void {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}-${date}.csv"`);
  if (capped) res.setHeader(EXPORT_CAPPED_HEADER, "true");
  // The BOM is prepended here, once, rather than by each caller — a missing one is invisible until
  // a customer with an accented name opens the file.
  res.send("﻿" + csv);
}
