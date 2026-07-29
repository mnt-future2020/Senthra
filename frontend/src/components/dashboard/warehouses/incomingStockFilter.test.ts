import { describe, expect, it } from "vitest";

import {
  ALL,
  EMPTY_FILTERS,
  customerFilterOptions,
  effectiveFilters,
  filterPendingStock,
  hasActiveFilter,
  statusFilterOptions,
  type PendingRowLike,
} from "./incomingStockFilter";

const row = (over: Partial<PendingRowLike> = {}): PendingRowLike => ({
  customerName: "LOBBI",
  customerCode: "CUST-0017",
  itemName: "item 2",
  status: "partially_received",
  ...over,
});

const ROWS: PendingRowLike[] = [
  row({ customerName: "Kansha Org", customerCode: "CUST-0018", itemName: "Eraser..", status: "partially_received" }),
  row({ itemName: "item 2", status: "partially_received" }),
  row({ itemName: "testing purposes 1", status: "partially_received" }),
  row({ itemName: "test purpose 2", status: "pending" }),
];

const names = (rows: PendingRowLike[]) => rows.map((r) => r.itemName);

describe("filterPendingStock", () => {
  it("returns everything when nothing is filtered", () => {
    expect(filterPendingStock(ROWS, EMPTY_FILTERS)).toHaveLength(4);
  });

  it("searches the item name", () => {
    expect(names(filterPendingStock(ROWS, { ...EMPTY_FILTERS, search: "test" }))).toEqual([
      "testing purposes 1",
      "test purpose 2",
    ]);
  });

  it("searches the customer name and code too", () => {
    // A warehouse manager may be holding paperwork that names the customer, not the item.
    expect(names(filterPendingStock(ROWS, { ...EMPTY_FILTERS, search: "kansha" }))).toEqual(["Eraser.."]);
    expect(names(filterPendingStock(ROWS, { ...EMPTY_FILTERS, search: "CUST-0018" }))).toEqual(["Eraser.."]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(filterPendingStock(ROWS, { ...EMPTY_FILTERS, search: "  ITEM 2  " })).toHaveLength(1);
  });

  it("treats a whitespace-only search as no search", () => {
    expect(filterPendingStock(ROWS, { ...EMPTY_FILTERS, search: "   " })).toHaveLength(4);
  });

  it("filters by customer", () => {
    expect(filterPendingStock(ROWS, { ...EMPTY_FILTERS, customerCode: "CUST-0017" })).toHaveLength(3);
  });

  it("filters by status", () => {
    expect(names(filterPendingStock(ROWS, { ...EMPTY_FILTERS, status: "pending" }))).toEqual(["test purpose 2"]);
  });

  it("ANDs every active filter together", () => {
    // LOBBI + pending + "test" → only the one row satisfies all three.
    expect(
      names(filterPendingStock(ROWS, { search: "test", customerCode: "CUST-0017", status: "pending" })),
    ).toEqual(["test purpose 2"]);
    // Same filters but a customer that has no pending row → empty, not a partial match.
    expect(
      filterPendingStock(ROWS, { search: "test", customerCode: "CUST-0018", status: "pending" }),
    ).toEqual([]);
  });

  it("returns an empty list rather than throwing on no rows", () => {
    expect(filterPendingStock([], { ...EMPTY_FILTERS, search: "anything" })).toEqual([]);
  });
});

describe("hasActiveFilter", () => {
  it("is false for the empty filter set", () => {
    expect(hasActiveFilter(EMPTY_FILTERS)).toBe(false);
  });

  it("is false for a whitespace-only search", () => {
    // Otherwise the "no matches" panel would offer to clear a filter that isn't doing anything.
    expect(hasActiveFilter({ ...EMPTY_FILTERS, search: "   " })).toBe(false);
  });

  it("is true once any filter is set", () => {
    expect(hasActiveFilter({ ...EMPTY_FILTERS, search: "x" })).toBe(true);
    expect(hasActiveFilter({ ...EMPTY_FILTERS, customerCode: "CUST-0017" })).toBe(true);
    expect(hasActiveFilter({ ...EMPTY_FILTERS, status: "pending" })).toBe(true);
  });
});

describe("customerFilterOptions", () => {
  it("lists each customer once, alphabetically, with its row count", () => {
    expect(customerFilterOptions(ROWS)).toEqual([
      { value: ALL, label: "All customers (4)" },
      { value: "CUST-0018", label: "Kansha Org (1)" },
      { value: "CUST-0017", label: "LOBBI (3)" },
    ]);
  });

  it("offers only the All option when there are no rows", () => {
    expect(customerFilterOptions([])).toEqual([{ value: ALL, label: "All customers (0)" }]);
  });
});

describe("effectiveFilters", () => {
  const custOpts = customerFilterOptions(ROWS);
  const statOpts = statusFilterOptions(ROWS);

  it("keeps a pick that still has an option", () => {
    const f = { search: "x", customerCode: "CUST-0017", status: "pending" };
    expect(effectiveFilters(f, custOpts, statOpts)).toEqual(f);
  });

  it("drops a customer whose rows have all been received", () => {
    // The WM filters to Kansha Org, receives their last row — the option disappears but the stored
    // pick doesn't. Without the fallback the table sits on "No matching stock" for a customer who
    // is simply finished.
    const remaining = ROWS.filter((r) => r.customerCode !== "CUST-0018");
    const f = { ...EMPTY_FILTERS, customerCode: "CUST-0018" };
    expect(effectiveFilters(f, customerFilterOptions(remaining), statOpts).customerCode).toBe(ALL);
  });

  it("drops a status that no row has any more", () => {
    const noPending = ROWS.filter((r) => r.status !== "pending");
    const f = { ...EMPTY_FILTERS, status: "pending" };
    expect(effectiveFilters(f, custOpts, statusFilterOptions(noPending)).status).toBe(ALL);
  });

  it("never touches the search term — free text can't go stale", () => {
    const f = { search: "nothing matches this", customerCode: ALL, status: ALL };
    expect(effectiveFilters(f, custOpts, statOpts).search).toBe("nothing matches this");
  });

  it("falls back independently — a dead customer pick doesn't reset a live status pick", () => {
    const remaining = ROWS.filter((r) => r.customerCode !== "CUST-0018");
    const f = { ...EMPTY_FILTERS, customerCode: "CUST-0018", status: "pending" };
    expect(effectiveFilters(f, customerFilterOptions(remaining), statOpts)).toEqual({
      ...EMPTY_FILTERS,
      customerCode: ALL,
      status: "pending",
    });
  });

  it("is derived, so the pick returns when its rows do", () => {
    const f = { ...EMPTY_FILTERS, customerCode: "CUST-0018" };
    const gone = customerFilterOptions(ROWS.filter((r) => r.customerCode !== "CUST-0018"));
    expect(effectiveFilters(f, gone, statOpts).customerCode).toBe(ALL);
    // Same stored filter, options back → the original pick is honoured again.
    expect(effectiveFilters(f, custOpts, statOpts).customerCode).toBe("CUST-0018");
  });
});

describe("statusFilterOptions", () => {
  it("orders by worklist urgency, not alphabetically, and counts each", () => {
    expect(statusFilterOptions(ROWS)).toEqual([
      { value: ALL, label: "All statuses (4)" },
      { value: "pending", label: "Pending (1)" },
      { value: "partially_received", label: "Partially received (3)" },
    ]);
  });

  it("omits a status no row has, so the menu can never filter to nothing", () => {
    const onlyPending = [row({ status: "pending" })];
    expect(statusFilterOptions(onlyPending).map((o) => o.value)).toEqual([ALL, "pending"]);
  });

  it("still surfaces an unrecognised status instead of hiding those rows", () => {
    const odd = [row({ status: "pending" }), row({ status: "on_hold" })];
    expect(statusFilterOptions(odd).map((o) => o.value)).toEqual([ALL, "pending", "on_hold"]);
  });
});
