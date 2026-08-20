// ── Where each warehouse queue is actually worked ──────────────────────────────────────────────
//
// One map, because a count has to keep resolving until it reaches the rows. The chain is:
//
//   sidebar badge  →  Warehouses list row  →  warehouse tab  →  the pane inside that tab
//
// and it is only useful if every link holds. It did not: the Incoming stock tab showed "4" and then
// opened on the Company (GRN) pane's Expected list, where none of those 4 were — they were draft
// receipts (GRN → Received) and customer intake (the Customer pane), both behind a control nobody had
// pressed. A number you cannot follow to a row is the same failure as a link that goes nowhere.
//
// Deriving the tab totals FROM this map (rather than listing keys per tab and again per pane) makes
// "a tab's count is the sum of its panes" true by construction. Adding a queue is one line here.
//
// MIRRORS the backend catalog's `warehouseQuery` (attention.registry.ts), which builds the deep link
// for an actor scoped to a single warehouse. `paneQuery` below reproduces it, and the sibling test
// pins the two together — if they drift, that badge lands on the wrong pane.

export type WarehouseTab =
  | "overview" | "incoming" | "inventory" | "goods" | "van" | "demand" | "transactions" | "audit";

export interface WarehousePane {
  tab: WarehouseTab;
  /** the tab's inner owner toggle (?pool=), where it has one */
  pool?: string;
  /** the Company (GRN) pane's Expected/Received switch (?inbound=) */
  inbound?: string;
  /**
   * Extra URL filters that narrow the pane to just this queue's rows.
   *
   * Reaching the right pane is not the same as reaching the right ROWS. Draft receipts land in GRN
   * history, which also holds every completed receipt this warehouse has ever booked; customer stock
   * drafts land in a list that also holds every active entry. Following a count of 3 into a list of
   * 53 is the same broken promise as a link that filters nothing — it only looks fine while the
   * warehouse is new and the history happens to be empty.
   *
   * Only applied when FOLLOWING the count. Toggling the pane by hand leaves the list unfiltered,
   * because then the user is browsing, not chasing a number.
   */
  filter?: Record<string, string>;
}

export const WAREHOUSE_KEY_PANE: Record<string, WarehousePane> = {
  // A draft receipt is a GRN RECORD, not an expected delivery — the tab opens on Expected, so without
  // the inbound hop this one is invisible on arrival. (`inbound=received` is the stored value; the
  // pane is labelled "Receipts", because a draft is precisely stock that has NOT been received yet.)
  "wh.grn_drafts": { tab: "incoming", pool: "grn", inbound: "received", filter: { status: "draft" } },
  // The Customer pane IS the intake worklist — it lists nothing else, so there is nothing to narrow.
  "wh.customer_intake": { tab: "incoming", pool: "customer" },
  // Same for the Rental pane: it lists hires awaiting delivery here and nothing else. This was the
  // one receiving pane on the tab with no count — the tab, the pill, the sidebar row and the
  // Warehouses list row all stayed silent while a hire sat waiting for someone to press Receive.
  "wh.rental_intake": { tab: "incoming", pool: "rental" },
  "wh.stock_entry_drafts": { tab: "inventory", pool: "customer", filter: { stockFilter: "draft" } },
  // The Goods Management and Field Stock tabs have no inner split, so the tab IS the pane.
  "wh.to_issue": { tab: "goods" },
  "wh.awaiting_return": { tab: "goods" },
  "wh.overdue_holdings": { tab: "goods" },
  "wh.van_requests": { tab: "van" },
  "wh.van_returns": { tab: "van" },
};

/** Every key whose work lives on this tab — what the tab's own count sums. */
export function keysForTab(tab: WarehouseTab): string[] {
  return Object.entries(WAREHOUSE_KEY_PANE)
    .filter(([, pane]) => pane.tab === tab)
    .map(([key]) => key);
}

/** Every key shown on one pane of a tab — what that pane's pill counts. */
export function keysForPane(tab: WarehouseTab, pool?: string, inbound?: string): string[] {
  return Object.entries(WAREHOUSE_KEY_PANE)
    .filter(([, p]) => p.tab === tab && p.pool === pool && (inbound === undefined || p.inbound === inbound))
    .map(([key]) => key);
}

/**
 * The query string that opens a key's pane.
 *
 * `withFilter` adds the pane's narrowing params — pass it when the user is FOLLOWING the count (a
 * badge, or the pill on a pane control), so they land on the rows that were counted and not on the
 * list those rows live in. Leave it off to name the pane alone.
 *
 * The unfiltered form is the same shape the backend's `warehouseQuery` emits; the sibling test pins
 * the two together.
 */
export function paneQuery(key: string, withFilter = false): string | null {
  const pane = WAREHOUSE_KEY_PANE[key];
  if (!pane) return null;
  const parts = [`tab=${pane.tab}`];
  if (pane.pool) parts.push(`pool=${pane.pool}`);
  if (pane.inbound) parts.push(`inbound=${pane.inbound}`);
  if (withFilter) for (const [k, v] of Object.entries(pane.filter ?? {})) parts.push(`${k}=${v}`);
  return parts.join("&");
}

/**
 * Where a pane control should send someone who clicks it BECAUSE of the count on it.
 *
 * Returns null when that pane has no outstanding work, which is the signal to navigate normally: a
 * pane with nothing waiting must not silently apply a filter that empties it.
 */
export function followQuery(keys: string[], countOf: (key: string) => number): string | null {
  const withWork = keys.filter((k) => countOf(k) > 0);
  // Two queues sharing one pane have no single filter to apply, so send them to the pane itself.
  return withWork.length === 1 ? paneQuery(withWork[0], true) : null;
}
