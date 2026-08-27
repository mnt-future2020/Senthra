import type { VanStockLinePayload, VanStockLineSource } from "@/services/vanStockRequest.service";

// The two client-side rules that keep company stock and hired kit from being mistaken for each other.
// Extracted from the composers so they can be tested directly — the .tsx files around them are JSX,
// and these are the parts where getting it wrong writes the wrong item to the ledger.

/** Anything that names one catalogue item: a search hit, a cart row, an open-request line, a holding. */
export interface VanStockItemRef {
  source: VanStockLineSource;
  irmItemId: string | null;
  rentalItemId: string | null;
}

/**
 * The stable identity of a cart row / search hit / holding.
 *
 * COMPOSITE, because the two catalogues have INDEPENDENT id spaces. Keyed on a bare item id an IRM
 * item and a rental item could collide as "the same row" — and, worse, the same tester added twice
 * would go unnoticed by the dedupe. Every React key, exclude-set membership, availability lookup and
 * per-row callback goes through this.
 */
export function vanStockItemKey(o: VanStockItemRef): string {
  return o.source === "rental" ? `rental:${o.rentalItemId}` : `irm:${o.irmItemId}`;
}

/**
 * A hire's return deadline, rendered the way every other date in Senthra is: "30 Sept 2026".
 *
 * TWO things this fixes over a bare `toLocaleDateString()`, and both matter:
 *
 *   LOCALE — pinned to en-GB. The app promises UK dates on screen (see lib/formatDate) and renders
 *   them everywhere else; a bare call follows the VIEWER's locale, so the same deadline read
 *   "9/30/2026" in the scan panel and "30 Sept 2026" on the engineer's own Hired tab.
 *
 *   TIMEZONE — pinned to UTC, which is the correctness half. A hire deadline is a CALENDAR DAY stored
 *   at UTC midnight, not an instant. Formatted in the viewer's zone it shows THE DAY BEFORE for anyone
 *   behind UTC — telling an engineer their kit was due yesterday, or that today's deadline is
 *   tomorrow. Same rule, and the same reason, as `formatDueDay` in goods-management/jobAge.ts.
 */
export function formatHireDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Split a set of composite keys back into the two id lists the availability endpoint takes. */
export function splitItemKeys(keys: string[]): { irmItemIds: string[]; rentalItemIds: string[] } {
  return {
    irmItemIds: keys.filter((k) => k.startsWith("irm:")).map((k) => k.slice(4)),
    rentalItemIds: keys.filter((k) => k.startsWith("rental:")).map((k) => k.slice(7)),
  };
}

/**
 * Build the line a composer sends.
 *
 * EXACTLY ONE id travels with the discriminator. The server rejects a line carrying both outright
 * rather than silently dropping one, so sending both would fail the whole request — and sending the
 * wrong one would move company stock for a hire. Written once, here, rather than inline in each
 * composer's submit handler, because "which id goes with which source" is precisely the thing that
 * must not be re-derived in three places.
 */
export function toLinePayload(
  row: VanStockItemRef & { name: string; qty: number },
  warehouseId?: string,
): VanStockLinePayload {
  return {
    source: row.source,
    ...(row.source === "rental" ? { rentalItemId: row.rentalItemId ?? undefined } : { irmItemId: row.irmItemId ?? undefined }),
    itemName: row.name,
    qty: row.qty,
    ...(warehouseId ? { warehouseId } : {}),
  };
}
