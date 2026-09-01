import { describe, expect, it } from "vitest";

import {
  CARD_DESTINATIONS,
  expectedThisWeekActions,
  goodsReceivedHref,
  overdueWarehouseHref,
  statCardDescribesSecondary,
  statCardLabel,
} from "./cardDestinations";
import { PO_DERIVED_STATUS_OPTIONS } from "@/components/dashboard/purchase-orders/poStatus";
import { JOB_DERIVED_STATUS_OPTIONS } from "@/components/dashboard/jobs/jobStatus";
import { STATUS_OPTIONS as POSITION_STATUS_OPTIONS } from "@/components/dashboard/inventory/StockPositionTable";

// ── "The card opens its own rows" ──────────────────────────────────────────────────────────────
//
// A dashboard card is a count taken one way and a link taken another, and nothing in the type system
// joins the two: a filter value that the destination list does not understand produces an EMPTY list,
// not an error. So these tests pin both halves of the join that live on this side of the wire —
// the exact query strings, and the fact that every derived status they name is one the destination
// module actually offers. The server half (each pseudo-status resolving to the predicate its card
// counts with) is pinned in backend/src/modules/dashboard/__tests__/card-destinations.test.ts.

const paramsOf = (href: string) => new URLSearchParams(href.split("?")[1] ?? "");
const pathOf = (href: string) => href.split("?")[0];

describe("card destinations — the exact filter each card opens", () => {
  it("Pending PRFs opens the submitted queue, not the whole module", () => {
    expect(pathOf(CARD_DESTINATIONS.pendingPrfs)).toBe("/dashboard/purchase-requests");
    expect(paramsOf(CARD_DESTINATIONS.pendingPrfs).get("status")).toBe("submitted");
  });

  it("Open POs opens the in-flight queue, not every PO ever raised", () => {
    expect(pathOf(CARD_DESTINATIONS.openPos)).toBe("/dashboard/purchase-orders");
    expect(paramsOf(CARD_DESTINATIONS.openPos).get("status")).toBe("open");
  });

  it("Active Jobs opens the in-flight queue, not every job ever raised", () => {
    expect(pathOf(CARD_DESTINATIONS.activeJobs)).toBe("/dashboard/jobs");
    expect(paramsOf(CARD_DESTINATIONS.activeJobs).get("status")).toBe("active");
  });

  it("Expected This Week opens the due-window filter, not the bare sent status", () => {
    expect(paramsOf(CARD_DESTINATIONS.expectedThisWeek).get("status")).toBe("due_this_week");
    // The regression guard: `sent` is a different queue ("Awaiting supplier acceptance") and takes
    // no notice of a delivery date at all.
    expect(CARD_DESTINATIONS.expectedThisWeek).not.toContain("status=sent");
  });

  // All three dimensions matter: the count is over company stock sitting in a warehouse, and it
  // includes the empty shelves. Dropping any one of them opens a different set than it counted.
  it("Low Stock pins ownership, location AND the low-or-out union", () => {
    const p = paramsOf(CARD_DESTINATIONS.lowStock);
    expect(pathOf(CARD_DESTINATIONS.lowStock)).toBe("/dashboard/inventory");
    expect(p.get("owner")).toBe("company");
    expect(p.get("location")).toBe("warehouse");
    expect(p.get("status")).toBe("below_reorder");
  });

  it("Reorder Needed opens the workbench, which is the only screen listing shortfalls as items", () => {
    expect(paramsOf(CARD_DESTINATIONS.reorderNeeded).get("tab")).toBe("reorder");
  });
});

describe("Goods Received — the window travels with the number", () => {
  it("filters completed receipts from the day the server counted from", () => {
    const href = goodsReceivedHref("2026-08-01");
    const p = paramsOf(href);
    expect(pathOf(href)).toBe("/dashboard/goods-in");
    expect(p.get("status")).toBe("completed");
    expect(p.get("receivedFrom")).toBe("2026-08-01");
  });

  // A lower bound ONLY. The count has no upper bound either, and a `receivedTo` would make the list
  // narrower than the number printed above it.
  it("sets no upper bound, matching the count", () => {
    expect(paramsOf(goodsReceivedHref("2026-08-01")).get("receivedTo")).toBeNull();
  });

  it("never re-derives the date — whatever the server reported is what is passed", () => {
    expect(paramsOf(goodsReceivedHref("2025-12-25")).get("receivedFrom")).toBe("2025-12-25");
  });
});

describe("Overdue Holdings drill-down rows", () => {
  it("opens that warehouse's Goods tab on its Overdue section", () => {
    const p = paramsOf(overdueWarehouseHref("WH-BRS"));
    expect(p.get("tab")).toBe("goods");
    expect(p.get("gmSection")).toBe("overdue");
    expect(p.get("gmOvEng")).toBeNull();
  });

  it("carries the panel's engineer narrowing through to the destination", () => {
    // `gmOvEng` is the param OverdueHoldingsView reads, so the list arrives already filtered — the
    // drill-down's narrowing is not thrown away at the moment the user follows it.
    expect(paramsOf(overdueWarehouseHref("WH-BRS", "eng-1")).get("gmOvEng")).toBe("eng-1");
  });

  it("ignores an empty engineer id rather than filtering to nobody", () => {
    expect(paramsOf(overdueWarehouseHref("WH-BRS", "")).get("gmOvEng")).toBeNull();
    expect(paramsOf(overdueWarehouseHref("WH-BRS", null)).get("gmOvEng")).toBeNull();
  });

  it("escapes a warehouse code that needs it", () => {
    expect(pathOf(overdueWarehouseHref("WH/A B"))).toBe("/dashboard/warehouses/WH%2FA%20B");
  });
});

// The half that fails SILENTLY: a card naming a filter value its destination's picker does not
// offer opens an empty list, because the status filter is a free string all the way to the server.
describe("every derived status a card names is one its destination offers", () => {
  const poValues = PO_DERIVED_STATUS_OPTIONS.map((o) => o.value);
  const jobValues = JOB_DERIVED_STATUS_OPTIONS.map((o) => o.value);

  it("the Purchase Orders list offers `open` and `due_this_week`", () => {
    expect(poValues).toContain(paramsOf(CARD_DESTINATIONS.openPos).get("status"));
    expect(poValues).toContain(paramsOf(CARD_DESTINATIONS.expectedThisWeek).get("status"));
  });

  it("the Jobs list offers `active`", () => {
    expect(jobValues).toContain(paramsOf(CARD_DESTINATIONS.activeJobs).get("status"));
  });

  it("the stock table offers `below_reorder`", () => {
    const values = POSITION_STATUS_OPTIONS.map((o) => o.value);
    expect(values).toContain(paramsOf(CARD_DESTINATIONS.lowStock).get("status"));
  });

  // Each derived value is a distinct queue, so two of them sharing a destination would mean one
  // card's count opening another card's rows.
  it("no two derived PO statuses collide", () => {
    expect(new Set(poValues).size).toBe(poValues.length);
  });
});

// ── Expected This Week: two numbers, two actions ───────────────────────────────────────────────
//
// The card prints `dueThisWeek` as its headline and `overdue` beneath it, and the two are DISJOINT —
// so one destination can only ever serve one of them. The headline's half was the one the card
// opened, which left the red number with nowhere to go: "0 · 9 overdue — chase the supplier" above a
// click that landed on "No purchase orders match". Every case below fails against that version.
describe("Expected This Week — the headline and the overdue line each get their own destination", () => {
  const actions = (dueThisWeek: number, overdue: number) => expectedThisWeekActions({ dueThisWeek, overdue });

  it("opens the due-this-week half from the card itself", () => {
    expect(paramsOf(actions(4, 0).href).get("status")).toBe("due_this_week");
  });

  it("offers the overdue half as its own action when there is anything overdue", () => {
    expect(paramsOf(actions(4, 9).href).get("status")).toBe("due_this_week");
    expect(paramsOf(actions(4, 9).overdueHref!).get("status")).toBe("overdue");
  });

  // THE regression. Zero expected, nine overdue: the card's own count is honestly 0, and the 9 must
  // still be reachable rather than printed above an empty list.
  it("still gives the overdue line a destination when nothing is due this week", () => {
    const a = actions(0, 9);
    expect(a.overdueHref).toBe("/dashboard/purchase-orders?status=overdue");
    expect(paramsOf(a.href).get("status")).toBe("due_this_week");
  });

  it("offers no overdue action when nothing is overdue — a link to an empty list is the same lie", () => {
    expect(actions(4, 0).overdueHref).toBeNull();
    expect(actions(0, 0).overdueHref).toBeNull();
  });

  // The card must mean ONE thing regardless of the data. Silently re-pointing the headline at the
  // overdue half when `dueThisWeek` is 0 would make the same card open two different sets.
  it("never redirects the main card to the overdue half", () => {
    for (const [due, over] of [[0, 0], [0, 9], [4, 0], [4, 9]] as const) {
      expect(actions(due, over).href, `${due}/${over}`).toBe(CARD_DESTINATIONS.expectedThisWeek);
      expect(actions(due, over).href).not.toContain("status=overdue");
    }
  });

  // One authoritative overdue predicate: the secondary action opens exactly what the "Deliveries
  // overdue" attention chip opens, so there is one route added, not a second calculation.
  it("reuses the existing overdue destination rather than inventing one", () => {
    expect(actions(0, 9).overdueHref).toBe(CARD_DESTINATIONS.expectedOverdue);
    expect(CARD_DESTINATIONS.expectedOverdue).toBe("/dashboard/purchase-orders?status=overdue");
  });
});

// ── StatCard accessible naming ─────────────────────────────────────────────────────────────────
//
// `aria-label` REPLACES the name a screen reader computes from an element's contents. Naming the card
// therefore silently deleted its detail line from assistive tech — sighted users kept seeing
// "£2,819.52 committed" / "5 overdue · 2 due this week" / "2 critical"; nobody else did.
describe("StatCard accessible name and description", () => {
  it("names the card by what it measures, how many, and where it goes", () => {
    expect(statCardLabel("Pending PRFs", 4, "Opens purchase requests awaiting Finance approval.")).toBe(
      "Pending PRFs, 4. Opens purchase requests awaiting Finance approval.",
    );
  });

  it("keeps a zero count in the name rather than dropping it", () => {
    expect(statCardLabel("Expected This Week", 0, "Opens deliveries due.")).toContain(", 0.");
  });

  // The fix: the detail the label displaced comes back as a description.
  it("describes the card with its plain secondary line", () => {
    expect(statCardDescribesSecondary({ hasSecondary: true, hasSecondaryAction: false })).toBe(true);
  });

  it("adds no description when there is no secondary line at all", () => {
    expect(statCardDescribesSecondary({ hasSecondary: false, hasSecondaryAction: false })).toBe(false);
  });

  // An action is a control with its OWN accessible name. Describing the card with it too would read
  // the same queue out twice — once on a card that does not open it.
  it("does not describe the card with an actionable secondary", () => {
    expect(statCardDescribesSecondary({ hasSecondary: false, hasSecondaryAction: true })).toBe(false);
    expect(statCardDescribesSecondary({ hasSecondary: true, hasSecondaryAction: true })).toBe(false);
  });
});
