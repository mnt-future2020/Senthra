// Free-text search over customer consignment stock entries.
//
// The same CustomerStockEntry list is rendered from two directions — a warehouse's Inventory tab
// (Customer pool) and a customer's own Inventory tab — and both load the whole list in one call, so
// the match runs in memory. Shared from lib/ rather than duplicated in each component: the two
// tables must agree on what "searching" means, and the Incoming-stock filter next door already
// showed how easily two copies of one rule drift apart.
//
// Both callers already have a server-side status filter; this is purely the text box.

// Only the fields the search reads, so tests (and either caller) don't have to build a whole entry.
export interface SearchableStockEntry {
  itemName: string;
  sku: string | null;
  barcode: string | null;
  customerName: string;
}

// Matches the item, its SKU, its barcode, or the customer — the four things printed on the
// paperwork or the sticker a warehouse manager is holding when they come looking. Barcode matters
// most: it's the one value they can scan or read off the physical unit.
export function searchStockEntries<T extends SearchableStockEntry>(entries: T[], term: string): T[] {
  const q = term.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.itemName.toLowerCase().includes(q) ||
      (e.sku ?? "").toLowerCase().includes(q) ||
      (e.barcode ?? "").toLowerCase().includes(q) ||
      e.customerName.toLowerCase().includes(q),
  );
}
