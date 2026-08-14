import { apiFile } from "@/lib/api";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";

// Downloading a server-built CSV, in one place.
//
// This was four byte-similar copies (audit, inventory, stock positions, the customer portal) and
// every new export added a fifth. Two of the steps are easy to get subtly wrong, and both fail
// quietly rather than loudly:
//
//   · `apiFile`, not `api` — the latter parses JSON, and the former is what keeps the shared
//     client's silent refresh-on-401. Without it an export fired seconds after the access token
//     expired just fails, instead of refreshing and replaying.
//   · the CAPPED flag rides on a response header. The API is always cross-origin from the
//     dashboard, so an unexposed header is stripped by the browser and reads as `false` — handing
//     the user a truncated file they believe is complete. There is now one header name for every
//     export (X-Export-Capped, see utils/csv-response.ts on the server) so there is nothing
//     per-export to remember on either side.

/**
 * Strip paging from a filter object. An export is "everything matching what I'm looking at", never
 * the page on screen — a caller that forgets this ships the user 20 rows of a 4,000-row answer.
 */
// Constrained on the two keys it removes, NOT on Record<string, unknown>: every caller passes a
// declared interface (AuditListParams, PortalListParams…), and an interface without an index
// signature does not satisfy Record — so the broader-looking constraint is the one that fits less.
export function withoutPaging<T extends { page?: number; pageSize?: number }>(params: T): Omit<T, "page" | "pageSize"> {
  const { page: _page, pageSize: _pageSize, ...rest } = params;
  void _page;
  void _pageSize;
  return rest;
}

/**
 * Fetch `url` as a file and hand it to the browser as a download.
 *
 * @param url          full API path INCLUDING its query string — each service keeps its own
 *                     query-string builder, because the param names are that endpoint's contract
 *                     and a generic builder here would only be able to guess at them.
 * @param fallbackName filename stem used if the response carries no Content-Disposition (the date
 *                     and extension are appended). The server normally supplies the real one.
 * @returns `capped: true` when the server stopped short of the full result set.
 */
export async function downloadCsv(url: string, fallbackName: string): Promise<{ capped: boolean }> {
  const { blob, headers } = await apiFile(url);
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, filenameFromDisposition(headers["content-disposition"] ?? null, `${fallbackName}-${date}.csv`));
  return { capped: String(headers["x-export-capped"] ?? "") === "true" };
}
