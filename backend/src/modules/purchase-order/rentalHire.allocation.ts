// ── Which hire do these units come off? ─────────────────────────────────────────────────────────
//
// A job's kit line names a CATALOGUE item — "one fibre tester" — because at planning time nobody
// knows which of the testers on order the warehouse will reach for. The physical unit is only decided
// when someone scans it out, and at that moment the system has to pick a hire, because a hire is what
// carries the deadline and the provider we owe it back to.
//
// This module owns that choice, in one place, for the same reason `rentalHire.predicate.ts` owns the
// expiring/overdue rules: the scan preview and the posting transaction must allocate identically, and
// two implementations of "which one" would eventually hand the engineer a preview of one tester and
// commit another.

import type { HireStockRow } from "./purchase-order.repository.js";

/**
 * Units of this hire sitting at the warehouse right now.
 *
 * `received − returned − issued`: what turned up, minus what has gone back to the provider, minus
 * what is already out with an engineer. Clamped at zero — the counters are maintained together in one
 * transaction so this should never go negative, and if a hand-edit ever makes it so, an allocator
 * that treats the anomaly as "minus two available" would start handing out phantom units.
 */
export function hireAvailable(h: Pick<HireStockRow, "receivedQuantity" | "returnedQuantity" | "issuedQuantity">): number {
  return Math.max(0, h.receivedQuantity - h.returnedQuantity - h.issuedQuantity);
}

/** Total units of a catalogue item available across a set of hires. */
export function totalAvailable(hires: readonly HireStockRow[]): number {
  return hires.reduce((sum, h) => sum + hireAvailable(h), 0);
}

/** One hire, and how many units to take off it. */
export interface HireAllocation {
  hire: HireStockRow;
  qty: number;
}

/**
 * Spread `qty` units across the given hires, EARLIEST DEADLINE FIRST.
 *
 * The ordering is a real rule, not a tie-break. Issue from the hire with three weeks left while the
 * one due Friday sits on the shelf and that Friday hire goes overdue holding kit nobody was using —
 * the exact failure the deadline badge exists to prevent. Draining the soonest deadline first means
 * the units still on the shelf at any moment are always the ones with the most time left on them.
 *
 * Callers pass rows already filtered to live hires at the scanning warehouse; this function does not
 * re-filter, so that "which hires count" is decided once, by the query.
 *
 * Returns `null` when the hires cannot cover `qty` — the caller turns that into a message naming the
 * shortfall. A partial allocation is never returned: issuing three of the five an engineer came for
 * silently is worse than saying two are missing.
 */
export function allocateFromHires(hires: readonly HireStockRow[], qty: number): HireAllocation[] | null {
  if (qty <= 0) return [];
  const ordered = [...hires].sort((a, b) => {
    const byDeadline = a.hireEndDate.getTime() - b.hireEndDate.getTime();
    // Stable within a deadline: same-day hires allocate in a fixed order rather than whatever order
    // the driver happened to return, so a preview and its post agree.
    return byDeadline !== 0 ? byDeadline : a.id.localeCompare(b.id);
  });

  const out: HireAllocation[] = [];
  let left = qty;
  for (const hire of ordered) {
    if (left === 0) break;
    const take = Math.min(left, hireAvailable(hire));
    if (take <= 0) continue;
    out.push({ hire, qty: take });
    left -= take;
  }
  return left === 0 ? out : null;
}
