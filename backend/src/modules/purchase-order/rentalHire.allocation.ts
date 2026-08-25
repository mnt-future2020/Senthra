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

// ── The custody arithmetic ──────────────────────────────────────────────────────────────────────
//
// THE INVARIANT every function below is derived from:
//
//     received = returned + lost + issued + onShelf
//
// Each received unit sits in exactly ONE of four buckets at any moment — gone back to the provider,
// gone for good, out in a van, or on our shelf. That is what makes the arithmetic safe: every term
// is subtracted exactly once, so no physical unit can be deducted twice however the formulas are
// combined.
//
// DAMAGE IS NOT A FIFTH BUCKET. A damaged tester is standing on the shelf: it is still ours to hand
// back, the provider will still collect it, and they will still charge us for it. It is a PROPERTY of
// a unit already counted in `onShelf`, which is why it narrows only `hireIssuable` and appears in
// neither `hireHeldByUs` nor `hireAtWarehouse`. Subtracting it from those would make a damaged hire
// un-returnable — the precise dead-end this module's callers exist to avoid.
//
// THREE questions, three functions, and callers must pick the one they actually mean:
//
//   hireHeldByUs      "how much of the provider's kit is ours to account for?"  — shelf AND vans
//   hireAtWarehouse   "how much can a collecting driver take today?"            — shelf only
//   hireIssuable      "how much can go out to a new job?"                       — shelf and fit
//   hireUntouched     "how much can still be said never to have arrived?"       — shelf, fit, unclaimed
//
// Every one clamps at zero. The counters move together inside one transaction so none of these should
// ever go negative; if a hand-edit or a legacy row makes it so, a caller reading "minus two" would
// start handing out phantom units.

/** What a hire line holds for the provider — on the shelf and in vans. Lost units are gone, so they leave. */
export function hireHeldByUs(h: Pick<HireStockRow, "receivedQuantity" | "returnedQuantity" | "lostQuantity">): number {
  // `?? 0` on the newer terms, and it is not defensive noise: NaN is the one wrong answer that does
  // not announce itself. Every comparison against it is false, so an allocator would silently take
  // nothing and report a stocked hire as empty rather than throwing. A row that reaches here without
  // the column reads as "none lost", which is the only honest reading of its absence.
  return Math.max(0, h.receivedQuantity - h.returnedQuantity - (h.lostQuantity ?? 0));
}

/**
 * Units physically on our shelf: what we hold, minus what is out with an engineer.
 *
 * This is the SUPPLIER-RETURNABLE figure, and it deliberately includes damaged units — a broken unit
 * still goes back on the collection note, with the damage recorded against it.
 */
export function hireAtWarehouse(
  h: Pick<HireStockRow, "receivedQuantity" | "returnedQuantity" | "lostQuantity" | "issuedQuantity">,
): number {
  return Math.max(0, hireHeldByUs(h) - (h.issuedQuantity ?? 0));
}

/**
 * Units on the shelf AND fit to send out — the only figure an allocator or an issue guard may use.
 *
 * `fieldDamageQty` is the hire's cached count of OPEN damage custody exits (see the column's note in
 * schema.prisma). Clamped against what is actually on the shelf: that counter is recomputed from the
 * exit rows and the two cannot normally disagree, but a stale or legacy row must never be able to
 * push this below zero or, worse, past it.
 */
export function hireIssuable(
  h: Pick<HireStockRow, "receivedQuantity" | "returnedQuantity" | "lostQuantity" | "issuedQuantity" | "fieldDamageQty">,
): number {
  const shelf = hireAtWarehouse(h);
  return Math.max(0, shelf - Math.min(shelf, h.fieldDamageQty ?? 0));
}

/**
 * Units of a hire that NOTHING has happened to yet — the most a delivery reversal may unwind.
 *
 * Reversing a delivery note asserts that its units never arrived. That is only true of a unit still
 * standing on our shelf, whole, and claimed by nobody: a unit already handed back, declared lost,
 * sitting in an engineer's van, or reported damaged is a unit whose existence here is on the record,
 * and un-delivering it would leave that record describing equipment we never received.
 *
 * THE SAME NUMBER AS `hireIssuable`, and deliberately not a second formula. The two questions —
 * "may this go out to a job?" and "may this be un-delivered?" — have one answer because both ask
 * whether anything has a claim on the unit. Written as a delegation rather than repeated arithmetic:
 * a copy would be free to drift, and a reversal guard that disagrees with the issue guard is how a
 * unit gets un-delivered out of an engineer's van.
 *
 * Damage recorded ON ARRIVAL is not counted here, and that is correct: it creates no custody exit
 * (only the damage-report path does), so it never reaches `fieldDamageQty`. It is the supplier's own
 * damage, evidenced on their own note, and it travels back with the note if that note is reversed.
 */
export function hireUntouched(
  h: Pick<HireStockRow, "receivedQuantity" | "returnedQuantity" | "lostQuantity" | "issuedQuantity" | "fieldDamageQty">,
): number {
  return hireIssuable(h);
}

/** Total units of a catalogue item ISSUABLE across a set of hires. */
export function totalAvailable(hires: readonly HireStockRow[]): number {
  return hires.reduce((sum, h) => sum + hireIssuable(h), 0);
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
    const take = Math.min(left, hireIssuable(hire));
    if (take <= 0) continue;
    out.push({ hire, qty: take });
    left -= take;
  }
  return left === 0 ? out : null;
}
