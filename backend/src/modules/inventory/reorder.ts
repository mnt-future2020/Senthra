// Reorder-workbench MATH — one pure function so the netting/rounding rules live in exactly one
// place (the suggestions read AND the generate-time revalidation both call it) and are unit-testable
// without mocks. Policy fields are GLOBAL on the IRM item; evaluation is per Item × Warehouse.
//
//   projected = (onHand − reserved) + incoming(open POs) + openPrf(open PRFs) − plannedDemand
//   trigger   = projected < 0  OR  (reorderLevel > 0 AND projected ≤ reorderLevel)
//   target    = maximumStock ?? reorderLevel        (see the note on `maximumStock` below)
//   suggested = max(1, target − projected), rounded UP to a packSize multiple when set
//
// Both incoming (open POs) and openPrf (open PRFs) are pending SUPPLY, so both ADD to the projected
// position. Open POs and open PRFs never overlap — a PRF that is converted becomes a PO and is no
// longer "open" — so summing both cannot double-count. Adding openPrf is what stops re-suggesting (or
// double-buying) stock a PM already put on a request: once the pipeline covers the target, the row
// stops triggering. The generate-time revalidation shares this maths, so a concurrent second user's
// draft PRF is already in openPrf and their duplicate row is skipped/capped — but only because
// generateReorderPrfs serialises recompute-then-create (see withReorderGenerateLock). The netting
// alone is not a concurrency guard: without the lock both callers read the same pre-PRF position.
//
// plannedDemand is pending DRAW: active jobs' kit lines that are planned but NOT yet issued — the
// remaining UNISSUED quantity only (Σ max(0, qty − grossIssued), from goods-management/demand.ts).
// It must NEVER include already-issued quantities: posting an issue decrements quantityOnHand at that
// moment, so an issued unit already left "available" — subtracting it here too would double-count the
// same demand. A row that triggers ONLY because of planned demand (physically healthy on the shelf)
// gets the dedicated `planned_demand` reason so the workbench can explain itself.
//
// A null/0 reorderLevel deliberately never triggers on its own (no policy = no nagging) — only a
// NEGATIVE projected position (oversold/over-reserved) forces a row through without a policy.

export type ReorderReason = "negative_stock" | "out_of_stock" | "below_reorder" | "planned_demand";

// Urgency order for the workbench's default sort — procurement works worst-first. planned_demand is
// future-dated draw (shelf still healthy), so it ranks after every physical shortage.
export const REORDER_REASON_RANK: Record<ReorderReason, number> = {
  negative_stock: 0,
  out_of_stock: 1,
  below_reorder: 2,
  planned_demand: 3,
};

export interface ReorderMathInput {
  onHand: number;
  reserved: number;
  incoming: number; // outstanding qty on open POs for this item × warehouse
  openPrf: number; // qty already on open (draft/submitted/approved) PRFs for this item × warehouse
  plannedDemand: number; // active jobs' planned-but-UNISSUED kit qty (qty − grossIssued; never issued stock)
  reorderLevel: number | null;
  criticalLevel: number | null; // a more-severe threshold below reorderLevel — drives "critical" urgency
  /**
   * The level stock is topped back up TO. `reorderQuantity` used to provide a second way to express
   * the same thing (`reorderLevel + reorderQuantity`), which meant two fields for one number and a
   * silent winner when both were set — maximumStock always won, so the quantity people typed was
   * quietly ignored. One field now.
   *
   * Null falls back to `reorderLevel`, which makes a DEGENERATE suggestion: it restores stock to
   * exactly the line that triggers reordering, so the row fires again immediately. That is a
   * misconfiguration, not a feature — the item form says so at the point of entry.
   */
  maximumStock: number | null;
  packSize: number | null;
}

export interface ReorderMath {
  available: number;
  projected: number;
  target: number;
  suggestedQty: number; // 0 for a covered row — nothing to buy
  reason: ReorderReason;
  covered: boolean; // physically at/below reorder, but incoming POs + open PRFs already lift it clear
  critical: boolean; // projected is negative or at/below the item's criticalLevel — buy first
}

// Returns null when the row is healthy (not even physically low). Otherwise returns a row that is
// EITHER actionable (covered=false, suggestedQty>0 — buy this) OR informational (covered=true,
// suggestedQty=0 — physically low but the on-order pipeline already covers it; shown only when the
// workbench's "show covered" toggle is on, never orderable).
export function computeReorderMath(i: ReorderMathInput): ReorderMath | null {
  const available = i.onHand - i.reserved;
  const projected = available + i.incoming + i.openPrf - i.plannedDemand;
  const reorderLevel = i.reorderLevel ?? 0;

  // Needs buying: even after counting the pipeline (supply) and planned demand (draw), the projected
  // position is short.
  const needsOrder = projected < 0 || (reorderLevel > 0 && projected <= reorderLevel);
  // Physically low: on-hand alone is short (what WOULD trigger with no pipeline). Physically low but
  // NOT needsOrder ⇒ "covered" — the incoming POs / open PRFs already cover the shortfall.
  const physicallyLow = available < 0 || (reorderLevel > 0 && available <= reorderLevel);
  if (!needsOrder && !physicallyLow) return null;

  const target = i.maximumStock ?? reorderLevel;
  // A physically-healthy shelf that triggers anyway is a planned-demand row — the workbench labels it
  // so the PM instantly sees the trigger is future job draw, not a shortage on the shelf today.
  const reason: ReorderReason =
    i.onHand < 0 ? "negative_stock"
    : i.onHand === 0 ? "out_of_stock"
    : needsOrder && !physicallyLow ? "planned_demand"
    : "below_reorder";
  const criticalLevel = i.criticalLevel ?? 0;

  // A covered row is never critical — the pipeline already lifts it clear.
  if (!needsOrder) return { available, projected, target, suggestedQty: 0, reason, covered: true, critical: false };

  const critical = projected < 0 || (criticalLevel > 0 && projected <= criticalLevel);
  let suggestedQty = Math.max(1, target - projected);
  if (i.packSize && i.packSize > 0) {
    suggestedQty = Math.ceil(suggestedQty / i.packSize) * i.packSize;
  }
  return { available, projected, target, suggestedQty, reason, covered: false, critical };
}
