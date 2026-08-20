// ── Where a hire goes back — ONE definition, every reader ──────────────────────────────────────
//
// A hire is a round trip. The order used to state only the outbound leg: "Deliver to: 3/359 Ayyanar
// Nagar". Nothing anywhere said where the supplier collects it from at the end, so the question was
// answered by phone, differently each time.
//
// The line stores a MODE, not a bare address, because a bare optional address is blank on almost
// every line and a blank answers nothing. A mode always resolves to a real place, which is what lets
// the order document print a definite collection point on every rental line.
//
// This resolver is shared by the PDF builder, the API DTO and (through the DTO) the on-hire list, for
// the same reason the hire predicates are shared: a document and a screen that computed the pickup
// point separately would eventually name two different addresses for one collection.

/** The three answers a line can give. Stored verbatim in `returnMode`. */
export const RETURN_MODES = ["delivery", "warehouse", "other"] as const;
export type ReturnMode = (typeof RETURN_MODES)[number];

/** What the caller must supply — the line's own fields plus the two fallbacks it can resolve to. */
export interface ReturnContext {
  returnMode: string;
  returnAddress: string | null;
  /** The line's own delivery address, when it has one. */
  deliveryAddress: string | null;
  /** The order header's delivery-address override, if any. */
  orderDeliveryAddress: string | null;
  /** The destination warehouse: its name, and its address as a single block. */
  warehouseName: string | null;
  warehouseAddress: string | null;
}

export interface ReturnLocation {
  /** Short label for a screen — "Same as delivery", "Leeds Depot", or "Other address". */
  label: string;
  /** The address itself, resolved. Null only when the fallback it points at is itself empty. */
  address: string | null;
}

/**
 * Resolve where a hire is DELIVERED — the outbound leg.
 *
 * The line's own address, then the order's "deliver to a different address" override, then the
 * warehouse. Exported because the screens were each deciding this for themselves, and getting it
 * wrong: a line with no address of its own rendered the words "Delivery warehouse" on an order whose
 * header overrode the destination, so the row named a depot the kit was never going to.
 *
 * The label is what to show when there is no address worth printing — the depot's own name, or the
 * fact that the ORDER carries the address, which the header states in full.
 */
export function resolveDeliveryLocation(ctx: ReturnContext): ReturnLocation {
  const own = ctx.deliveryAddress?.trim();
  if (own) return { label: "This line's address", address: own };
  const override = ctx.orderDeliveryAddress?.trim();
  if (override) return { label: "Order delivery address", address: override };
  return { label: ctx.warehouseName ?? "Delivery warehouse", address: ctx.warehouseAddress };
}

/** Whether a stored value is one of the three modes this module knows how to resolve. */
export function isReturnMode(value: string): value is ReturnMode {
  return (RETURN_MODES as readonly string[]).includes(value);
}

/**
 * Resolve a hire's collection point.
 *
 * `delivery` walks the outbound leg's chain THROUGH `resolveDeliveryLocation`, so "same as delivery"
 * means exactly that, wherever delivery actually resolved to — and the two legs cannot drift apart,
 * which they would the moment either one grew a fallback the other did not.
 *
 * A value outside RETURN_MODES cannot arrive through the API — `rentalLineSchema` is a `z.enum` over
 * exactly these three and the column defaults to `delivery` — so reaching the branch below means the
 * database was written to by hand. It resolves as `delivery` rather than throwing, because the
 * alternative is a purchase order document that cannot render at all, and `delivery` is the value
 * every row carried before the field existed. But it does NOT do so quietly: silently reinterpreting
 * one business meaning as another is how corrupt data survives, so the anomaly is logged with the
 * value that caused it. `returnMode: { notIn: [...] }` finds the rows.
 */
export function resolveReturnLocation(ctx: ReturnContext): ReturnLocation {
  if (ctx.returnMode === "other") {
    return { label: "Other address", address: ctx.returnAddress?.trim() || null };
  }
  if (ctx.returnMode === "warehouse") {
    return { label: ctx.warehouseName ?? "Delivery warehouse", address: ctx.warehouseAddress };
  }
  if (!isReturnMode(ctx.returnMode)) {
    console.error(
      `[rental] unrecognised returnMode ${JSON.stringify(ctx.returnMode)} on a rental line — resolved as "delivery". ` +
        `Only ${RETURN_MODES.join(" | ")} are valid; this value cannot have come through the API.`,
    );
  }
  return { label: "Same as delivery", address: resolveDeliveryLocation(ctx).address };
}

/**
 * The one-line form the order document prints under a rental line.
 *
 * When there is no address to print, it falls back to the resolved LABEL — the place's own name —
 * which is exactly what that label is for (see resolveDeliveryLocation). It used to print the words
 * "the delivery address" instead, and that is not a weaker answer but a WRONG one: every Warehouse
 * address column is optional, so a line that chose the depot told the supplier to collect from the
 * SITE the moment that depot had no address on file — the opposite of what was picked.
 *
 * `delivery` mode resolves the outbound leg's own label rather than the words "Same as delivery",
 * because a supplier reading a collection instruction needs a place, not a cross-reference.
 */
export function returnLocationLine(ctx: ReturnContext): string {
  const { label, address } = resolveReturnLocation(ctx);
  const where =
    address?.replace(/\r?\n/g, ", ") ??
    (isReturnMode(ctx.returnMode) && ctx.returnMode !== "delivery" ? label : resolveDeliveryLocation(ctx).label);
  return `Collection at end of hire: ${where}`;
}
