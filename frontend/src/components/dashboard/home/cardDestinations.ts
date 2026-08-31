// ── Where each Overview card goes ──────────────────────────────────────────────────────────────
//
// One place, because a destination is not decoration: it is the other half of the number printed on
// the card. Each entry here is the filter that selects the SAME rows the card's count measured, so
// the list's total is the figure the user clicked.
//
// They were written inline and four of them had drifted into naming a different set than the count:
//
//   Open POs           → /dashboard/purchase-orders   every PO ever raised, closed ones included
//   Active Jobs        → /dashboard/jobs              every job ever raised, completed ones included
//   Goods Received     → /dashboard/goods-in          every receipt ever booked, no date window
//   Expected This Week → ?status=sent                 one of three receivable statuses, blind to dates
//   Low Stock          → ?status=low_stock            dropped the out-of-stock rows the count includes
//   Overdue Holdings   → /dashboard/warehouses        a list that holds none of the counted jobs
//
// Nothing errored in any of those cases. The list simply was not the thing counted, which is the
// failure mode the attention catalog documents at length for `?status=rework` and `?status=draft`.
//
// The values in this file are the CLIENT half of a pair; the server half is the derived pseudo-status
// each one names (`open`, `active`, `due_this_week`, `below_reorder`), resolved in the owning
// repository's buildWhere against the very predicate the card counts with. Changing a filter name
// here without changing it there produces an empty list, not an error — hence the tests beside this.

/** The cards whose destination is a fixed, fully-determined filter. */
export const CARD_DESTINATIONS = {
  /** PRFs awaiting Finance review — `status: "submitted"`, what countSubmitted counts. */
  pendingPrfs: "/dashboard/purchase-requests?status=submitted",
  /** Non-terminal, not-fully-received orders — the OPEN_PO_STATUSES openSummary counts. */
  openPos: "/dashboard/purchase-orders?status=open",
  /** Assigned / accepted / in progress — the statuses countActive counts. */
  activeJobs: "/dashboard/jobs?status=active",
  /**
   * Company stock sitting in a warehouse, at or below its reorder level.
   *
   * All three dimensions are pinned because all three are in the count: `lowStockCounts` reads
   * InventoryBalance rows, which are exactly the company/warehouse positions, and its rule is
   * `positionStatus !== in_stock` — low OR out, which is what `below_reorder` means.
   */
  lowStock: "/dashboard/inventory?owner=company&location=warehouse&status=below_reorder",
  /** The reorder workbench itself, which hides covered rows by default — as getReorderSummary does. */
  reorderNeeded: "/dashboard/inventory?tab=reorder",
  /** Receivable orders due inside the window and not yet late — expectedDeliveries' `dueThisWeek`. */
  expectedThisWeek: "/dashboard/purchase-orders?status=due_this_week",
  /**
   * The OTHER half of the same split — receivable orders whose ETA has already passed.
   *
   * `expectedDeliveries` divides the open receivable set into two DISJOINT halves and the Expected
   * This Week card prints both: `dueThisWeek` as its headline, `overdue` on its secondary line. The
   * card could only open one of them, so the secondary was a dead end — it read "9 overdue — chase
   * the supplier" above a click that landed on an empty list, because an order cannot be in both
   * halves (see the `two halves never claim the same order` test).
   *
   * Same value the "Deliveries overdue" attention chip opens, deliberately: ONE authoritative overdue
   * predicate (`receivableWhere()` + `confirmed ?? expected < today`), resolved server-side in
   * buildWhere. This is a second ROUTE to it, never a second calculation.
   */
  expectedOverdue: "/dashboard/purchase-orders?status=overdue",
} as const;

/**
 * Completed goods receipts from the day the count was taken from.
 *
 * `receivedSince` comes off the payload, resolved in the COMPANY timezone — never recomputed here.
 * A browser deriving "seven days ago" from its own clock would open a different set for a viewer in
 * another zone, which is the drift the server reports its own window to avoid.
 *
 * A lower bound only, because the count has no upper bound either: a `receivedTo` would make the
 * list narrower than the number above it.
 */
export function goodsReceivedHref(receivedSince: string): string {
  return `/dashboard/goods-in?status=completed&receivedFrom=${encodeURIComponent(receivedSince)}`;
}

/**
 * A row in the Overdue Holdings drill-down: that warehouse's Goods tab, Overdue section.
 *
 * `engineerId` carries the panel's narrowing through to the destination, so picking an engineer and
 * then a warehouse lands on a list already filtered to their kit — `gmOvEng` is the param
 * OverdueHoldingsView reads. The card itself has no href at all: its count spans warehouses and the
 * work is done inside one, so no single list holds it.
 */
export function overdueWarehouseHref(code: string, engineerId?: string | null): string {
  const qs = new URLSearchParams({ tab: "goods", gmSection: "overdue" });
  if (engineerId) qs.set("gmOvEng", engineerId);
  return `/dashboard/warehouses/${encodeURIComponent(code)}?${qs.toString()}`;
}

// ── The Expected This Week card has TWO numbers and they are disjoint ──────────────────────────
//
// `expectedDeliveries` splits the open receivable set in two — already late, and due inside the
// window — and the card prints both: `dueThisWeek` as its headline, `overdue` on the line beneath.
// An order is in exactly one half (the `two halves never claim the same order` test pins it), so a
// single destination can only ever serve one of them. The card opened the headline's half, which
// left the louder, redder number with nowhere to go: "0 · 9 overdue — chase the supplier" above a
// click that lands on "No purchase orders match".
//
// So the card gets two actions. Pure, because the decision is "which of these numbers is worth
// offering" — not markup — and the empty-overdue case is the one that must never render a link.

export interface ExpectedThisWeekActions {
  /** The card's own destination — always present; the headline count is honest even at zero. */
  href: string;
  /** The secondary action, or null when there is nothing overdue and a link would open an empty list. */
  overdueHref: string | null;
}

export function expectedThisWeekActions(card: { dueThisWeek: number; overdue: number }): ExpectedThisWeekActions {
  return {
    // Never conditional. Redirecting the whole card to the overdue half when `dueThisWeek` is 0 would
    // make one card mean two things depending on the data, and the headline would stop opening its
    // own rows — the exact contract this file exists to hold.
    href: CARD_DESTINATIONS.expectedThisWeek,
    overdueHref: card.overdue > 0 ? CARD_DESTINATIONS.expectedOverdue : null,
  };
}

// ── StatCard accessible naming ────────────────────────────────────────────────────────────────
//
// The card's primary control carries an `aria-label`, which REPLACES the name a screen reader would
// otherwise compute from the card's contents. That is what silently dropped "£2,819.52 committed",
// "5 overdue · 2 due this week" and "2 critical" from assistive tech: sighted users could see them,
// nobody else could. The label names the card; the detail line comes back through
// `aria-describedby` — but only when it is TEXT.

/** "Pending PRFs, 4. Opens purchase requests awaiting Finance approval." */
export function statCardLabel(title: string, count: number, opens: string): string {
  return `${title}, ${count}. ${opens}`;
}

/**
 * Should the primary control describe itself with the secondary line?
 *
 * Yes for plain text — that is the information the label displaced. NO when the secondary is an
 * ACTION: it is a control of its own with its own accessible name, and describing the card with it
 * too would read the same queue out twice, once on a card that does not open it.
 */
export function statCardDescribesSecondary(opts: { hasSecondary: boolean; hasSecondaryAction: boolean }): boolean {
  return opts.hasSecondary && !opts.hasSecondaryAction;
}
