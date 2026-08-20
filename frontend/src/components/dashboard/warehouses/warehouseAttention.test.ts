import { describe, expect, it } from "vitest";

import { WAREHOUSE_KEY_PANE, followQuery, keysForPane, keysForTab, paneQuery } from "./warehouseAttention";

// The bug this file exists to prevent, as it actually happened: the Warehouses list showed "4" for a
// warehouse, the Incoming stock tab showed "4", and the pane that tab opens on held none of them —
// they were draft receipts (behind the Receipts switch) and customer intake (behind the Customer
// pill). Every level of the chain has to keep resolving, or the number is just a number.

// The catalog keys whose work is done inside a warehouse. Mirrors ATTENTION_ENTITY_SOURCES plus
// wh.overdue_holdings (which has no per-warehouse split but is still shown on the Goods tab).
const WAREHOUSE_KEYS = [
  "wh.grn_drafts",
  "wh.to_issue",
  "wh.awaiting_return",
  "wh.overdue_holdings",
  "wh.van_requests",
  "wh.van_returns",
  "wh.customer_intake",
  "wh.stock_entry_drafts",
  "wh.rental_intake",
];

describe("WAREHOUSE_KEY_PANE", () => {
  it("places every warehouse queue somewhere", () => {
    for (const key of WAREHOUSE_KEYS) {
      expect(Object.keys(WAREHOUSE_KEY_PANE), `"${key}" has no pane — its count would be unreachable`).toContain(key);
    }
  });

  it("does not place anything that isn't a warehouse queue", () => {
    for (const key of Object.keys(WAREHOUSE_KEY_PANE)) expect(WAREHOUSE_KEYS).toContain(key);
  });
});

// The property that makes the display honest: a tab's number IS its panes' numbers. Both are derived
// from this one map, so the test is really checking that the derivation helpers agree — which is what
// stops a future key being added to a tab and forgotten on the pill.
describe("a tab's count is exactly the sum of its panes'", () => {
  it("Incoming stock splits into Company (GRN), Customer and Rental with nothing left over", () => {
    expect(
      [
        ...keysForPane("incoming", "grn"),
        ...keysForPane("incoming", "customer"),
        ...keysForPane("incoming", "rental"),
      ].sort(),
    ).toEqual(keysForTab("incoming").sort());
  });

  // The pane that had no count at all. Every pane of this tab ends in someone pressing Receive, and
  // this was the only one that announced its work nowhere — so a hire sat there waiting to be
  // received with no badge on the tab, the pane, the sidebar row or the Warehouses list row.
  it("counts the hires waiting on the Rental deliveries pane", () => {
    expect(keysForPane("incoming", "rental")).toEqual(["wh.rental_intake"]);
  });

  it("Inventory's only queue is on the Customer pane, not the pane it opens on", () => {
    expect(keysForPane("inventory", "customer")).toEqual(["wh.stock_entry_drafts"]);
    expect(keysForPane("inventory", "irm")).toEqual([]);
    expect(keysForTab("inventory")).toEqual(["wh.stock_entry_drafts"]);
  });

  // Drafts belong to the Receipts pane (?inbound=received), never to Expected: Expected lists open
  // POs, and a draft is a receipt someone already started raising against one.
  it("keeps drafts on the Receipts pane — the one the tab does NOT open on", () => {
    expect(keysForPane("incoming", "grn", "received")).toEqual(["wh.grn_drafts"]);
    expect(keysForPane("incoming", "grn", "expected")).toEqual([]);
  });

  // These two tabs have no inner split, so the tab is the pane and no pill is needed.
  it("leaves the undivided tabs whole", () => {
    expect(keysForTab("goods").sort()).toEqual(["wh.awaiting_return", "wh.overdue_holdings", "wh.to_issue"]);
    expect(keysForTab("van").sort()).toEqual(["wh.van_requests", "wh.van_returns"]);
    expect(keysForPane("goods", undefined)).toEqual(keysForTab("goods"));
  });

  it("puts nothing on the tabs that hold no queue", () => {
    for (const tab of ["overview", "demand", "transactions", "audit"] as const) {
      expect(keysForTab(tab)).toEqual([]);
    }
  });
});

// MIRRORS attention.registry.ts's `warehouseQuery`, which the server turns into a deep link for an
// actor scoped to a single warehouse. If these drift, that badge opens the right warehouse on the
// wrong pane — the same near-miss as before, one level down.
describe("paneQuery matches the backend catalog's warehouseQuery", () => {
  const BACKEND_WAREHOUSE_QUERY: Record<string, string> = {
    "wh.to_issue": "tab=goods",
    "wh.awaiting_return": "tab=goods",
    "wh.overdue_holdings": "tab=goods",
    "wh.van_requests": "tab=van",
    "wh.van_returns": "tab=van",
    "wh.customer_intake": "tab=incoming&pool=customer",
    "wh.stock_entry_drafts": "tab=inventory&pool=customer",
  };

  it("builds the same query string for every key the catalog deep-links", () => {
    for (const [key, expected] of Object.entries(BACKEND_WAREHOUSE_QUERY)) {
      expect(paneQuery(key), `"${key}" would open a different pane than the badge promises`).toBe(expected);
    }
  });

  // Not in the backend map: it has a real cross-warehouse screen of its own
  // (/dashboard/goods-in?status=draft), so the catalog gives it an href rather than a warehouseQuery.
  // It still needs a pane here, because that is where the per-warehouse count is shown.
  it("still routes grn_drafts to its pane, including the Received switch", () => {
    expect(paneQuery("wh.grn_drafts")).toBe("tab=incoming&pool=grn&inbound=received");
  });

  it("returns null for a key it doesn't know", () => {
    expect(paneQuery("cust.stock_requests")).toBeNull();
  });
});

// Reaching the right PANE is not reaching the right ROWS. GRN history holds every completed receipt
// this warehouse ever booked, and the customer pool holds every active entry — so "Received 3"
// landing on an unfiltered list is the same broken promise as a link that narrows nothing. It only
// looks correct while the warehouse is new and its history happens to be empty.
describe("following a count lands on the counted rows", () => {
  const has = (...withWork: string[]) => (key: string) => (withWork.includes(key) ? 1 : 0);

  it("narrows GRN history to the drafts", () => {
    expect(paneQuery("wh.grn_drafts", true)).toBe("tab=incoming&pool=grn&inbound=received&status=draft");
    expect(followQuery(keysForPane("incoming", "grn"), has("wh.grn_drafts")))
      .toBe("tab=incoming&pool=grn&inbound=received&status=draft");
  });

  it("narrows the customer stock pool to the entries still to catalogue", () => {
    expect(followQuery(keysForPane("inventory", "customer"), has("wh.stock_entry_drafts")))
      .toBe("tab=inventory&pool=customer&stockFilter=draft");
  });

  // Applying a filter to an empty queue would hide the history behind a list showing nothing.
  it("navigates plainly when the pane has no outstanding work", () => {
    expect(followQuery(keysForPane("incoming", "grn"), has())).toBeNull();
    expect(followQuery(keysForPane("inventory", "customer"), has())).toBeNull();
  });

  // The intake pane lists nothing but intake, so there is no filter to add and none is invented.
  it("adds nothing to a pane that already shows only its queue", () => {
    expect(paneQuery("wh.customer_intake", true)).toBe(paneQuery("wh.customer_intake"));
    expect(followQuery(keysForPane("incoming", "customer"), has("wh.customer_intake")))
      .toBe("tab=incoming&pool=customer");
  });

  // Two queues on one pane have no single filter that shows both, so the pane itself is the answer.
  it("declines to pick a filter when a pane holds more than one live queue", () => {
    expect(followQuery(["wh.van_requests", "wh.van_returns"], has("wh.van_requests", "wh.van_returns"))).toBeNull();
    // …but with only one of them outstanding it can still resolve.
    expect(followQuery(["wh.van_requests", "wh.van_returns"], has("wh.van_requests"))).toBe("tab=van");
  });
});
