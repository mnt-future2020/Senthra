// Filtering for the Incoming stock → Customer pool worklist.
//
// The whole worklist arrives in one call (getPendingStockForWarehouse), so filtering is done in
// memory here rather than round-tripping the server — the same approach the Company (GRN) pool's
// Expected deliveries takes. Kept as pure functions in their own module so the matching rules are
// unit-testable without rendering the table (this app has no jsdom in its test setup; see the
// sibling ExpectedDeliveries helpers for the same split).

export const ALL = "all";

// Only the fields the filters read — so the helpers stay usable from tests without constructing a
// whole PendingStockItem.
export interface PendingRowLike {
  customerName: string;
  customerCode: string;
  itemName: string;
  status: string;
}

export interface PendingStockFilters {
  search: string;
  customerCode: string; // ALL, or an exact customer code
  status: string; // ALL, or an exact status
}

export const EMPTY_FILTERS: PendingStockFilters = { search: "", customerCode: ALL, status: ALL };

export function hasActiveFilter(f: PendingStockFilters): boolean {
  return f.search.trim() !== "" || f.customerCode !== ALL || f.status !== ALL;
}

// Search matches the item, the customer name, or the customer code — the three things a warehouse
// manager has in hand when hunting for a row (a delivery note names the item; a customer chases by
// name; the code is what's printed on the paperwork). Dropdowns AND search: every active filter
// must match.
export function filterPendingStock<T extends PendingRowLike>(rows: T[], f: PendingStockFilters): T[] {
  const term = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.customerCode !== ALL && r.customerCode !== f.customerCode) return false;
    if (f.status !== ALL && r.status !== f.status) return false;
    if (!term) return true;
    return (
      r.itemName.toLowerCase().includes(term) ||
      r.customerName.toLowerCase().includes(term) ||
      r.customerCode.toLowerCase().includes(term)
    );
  });
}

export interface FilterOption {
  value: string;
  label: string;
}

// The filters ACTUALLY in effect. Receiving a customer's last outstanding row removes them from the
// options, but the stored pick still names them — leaving the table on "No matching stock" until the
// user works out they have to clear a filter for a customer who is simply finished. Falling back to
// ALL shows the remaining work instead.
//
// DERIVED, never stored: if the rows come back (a new assignment lands) the pick comes back with
// them, and the explicit Clear still resets it for good. Mirrors ExpectedDeliveries' `effectiveFilter`.
export function effectiveFilters(
  f: PendingStockFilters,
  customerOptions: FilterOption[],
  statusOptions: FilterOption[],
): PendingStockFilters {
  const kept = (options: FilterOption[], value: string) =>
    options.some((o) => o.value === value) ? value : ALL;
  return {
    search: f.search, // free text can't go stale — it matches or it doesn't
    customerCode: kept(customerOptions, f.customerCode),
    status: kept(statusOptions, f.status),
  };
}

// Options are derived from the rows actually present, never hardcoded, so the menu can't offer a
// customer or a status that would filter the table down to nothing. Counts come from the WHOLE
// worklist (not the current filter), so they stay stable while you switch between them.
export function customerFilterOptions(rows: PendingRowLike[]): FilterOption[] {
  const byCode = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    const hit = byCode.get(r.customerCode);
    if (hit) hit.count += 1;
    else byCode.set(r.customerCode, { name: r.customerName, count: 1 });
  }
  const options = [...byCode.entries()]
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([code, v]) => ({ value: code, label: `${v.name} (${v.count})` }));
  return [{ value: ALL, label: `All customers (${rows.length})` }, ...options];
}

// Worklist order: nothing-received-yet first, then part-received. `received` shouldn't reach this
// list at all (the endpoint returns outstanding assignments), but it's mapped rather than dropped so
// an unexpected row is still filterable instead of silently unreachable.
const STATUS_ORDER = ["pending", "partially_received", "received"] as const;
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  partially_received: "Partially received",
  received: "Received",
};

const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

export function statusFilterOptions(rows: PendingRowLike[]): FilterOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  const known = STATUS_ORDER.filter((s) => counts.has(s));
  // Anything the map doesn't know about still gets an option, after the known ones.
  const unknown = [...counts.keys()].filter((s) => !STATUS_ORDER.includes(s as (typeof STATUS_ORDER)[number])).sort();

  return [
    { value: ALL, label: `All statuses (${rows.length})` },
    ...[...known, ...unknown].map((s) => ({ value: s, label: `${statusLabel(s)} (${counts.get(s) ?? 0})` })),
  ];
}
