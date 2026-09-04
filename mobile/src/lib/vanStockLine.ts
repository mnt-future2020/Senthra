import type { VanStockLinePayload, VanStockLineSource } from "@/types";

// The two client-side rules that keep company stock and hired kit from being mistaken for each other.
// Ported from the web's van-requests/vanStockLine.ts and kept as its own module for the same reason:
// the screens around them are JSX, and these are the parts where getting it wrong writes the wrong
// item to the ledger.

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
 * would go unnoticed by the dedupe. Every React key, `lines.some(...)` membership test, availability
 * lookup and per-row callback goes through this.
 */
export function vanStockItemKey(o: VanStockItemRef): string {
  return o.source === "rental" ? `rental:${o.rentalItemId}` : `irm:${o.irmItemId}`;
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
 * rather than silently dropping one, so sending both fails the whole request — and sending the wrong
 * one would move company stock for a hire. Written once, here, rather than inline in each composer's
 * submit handler, because "which id goes with which source" is precisely the thing that must not be
 * re-derived in two places.
 */
export function toLinePayload(
  row: VanStockItemRef & { name: string; qty: number },
  warehouseId?: string,
): VanStockLinePayload {
  return {
    source: row.source,
    ...(row.source === "rental"
      ? { rentalItemId: row.rentalItemId ?? undefined }
      : { irmItemId: row.irmItemId ?? undefined }),
    itemName: row.name,
    qty: row.qty,
    ...(warehouseId ? { warehouseId } : {}),
  };
}
