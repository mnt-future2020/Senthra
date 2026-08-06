import type { KitItemOption } from "@/services/jobKitRequest.service";

// Whether an item can actually be fulfilled, and how to say so.
//
// A kit request is approved by sourcing every line from exactly one of two places: a warehouse, or a
// COLLEAGUE's van (the requesting engineer can never supply themselves). An item held by neither has
// no decision a planner could make — the approve dialog has nothing to pick, its button stays
// disabled, and the request sits pending indefinitely. So the composer decides requestability here
// and renders the option disabled, rather than letting an unfulfillable line be created at all.
//
// Pure, so it can be tested without a DOM (this suite is Node-only) — same split as jobAge.ts.

export interface KitItemAvailability {
  /** Everything approve() could draw on: warehouse stock + other engineers' vans. */
  total: number;
  /** False ⇒ the option must be disabled; no source could fulfil it. */
  requestable: boolean;
  /** Sub-line text: where the stock is, or why the item can't be picked. */
  label: string;
}

// The one phrasing for "where is this stock", used by BOTH the search rows and the composer's
// quantity steppers. Split on purpose: a warehouse figure and a colleague's van are different waits —
// one is a collection, the other a transfer the planner has to arrange — and a single merged total
// silently overstates how quickly the stock can be in the engineer's hands. It also made the same
// item read 1992 in the field-stock composer (warehouse-only, since a van restock has no van source)
// and 1995 here, with nothing on screen explaining the gap.
export function availabilityParts(warehouse: number, van: number): string {
  const parts: string[] = [];
  if (warehouse > 0) parts.push(`${warehouse} in stock`);
  if (van > 0) parts.push(`${van} on another van`);
  return parts.join(" · ");
}

export function kitItemAvailability(item: KitItemOption): KitItemAvailability {
  if (item.source === "customer_stock") {
    // Warehouse-only, unlike IRM. A field stock request carries no customerStockEntryId, so
    // consignment never reaches an engineer as free van stock — the only writes to
    // EngineerCustomerStockHolding are a job issue and a job-scoped transfer, so every unit an
    // engineer holds is committed to their job. There is no commitment figure to net off either:
    // jobCommittedByEngineer deliberately excludes this pool ("never field-returnable"). Counting it
    // would double-book another job's stock, and naming an engineer in the empty message would point
    // at a source the system can never offer.
    const shelf = item.qty ?? 0;
    if (shelf <= 0) return { total: 0, requestable: false, label: OUT_OF_STOCK_CONSIGNMENT };
    // The sub-line already reads "<warehouse> · N in stock", so adding anything here would print the
    // quantity twice.
    return { total: shelf, requestable: true, label: "" };
  }

  // Missing counts mean a response that predates these fields (an older client, a cached payload).
  // Defaulting those to 0 would disable the whole catalogue on a deploy skew, so absence is treated
  // as "unknown, allow it" — approve() still re-checks authoritatively before any stock moves.
  const wh = item.quantityOnHand;
  const van = item.heldByEngineers;
  if (typeof wh !== "number" || typeof van !== "number") {
    return { total: 0, requestable: true, label: "" };
  }

  const total = wh + van;
  if (total <= 0) return { total: 0, requestable: false, label: OUT_OF_STOCK };

  // Named separately on purpose: "7 available" would send an engineer to a warehouse holding none of
  // it. Van stock has to come off a colleague via a transfer the planner arranges, which is a
  // materially different wait.
  return { total, requestable: true, label: availabilityParts(wh, van) };
}

// IRM can come from a warehouse OR a colleague's van, so both are named. Consignment can only come
// off its own shelf — see the note in the customer_stock branch above.
const OUT_OF_STOCK = "Out of stock — no warehouse or engineer has this";
const OUT_OF_STOCK_CONSIGNMENT = "Out of stock — none of this customer's stock left here";
