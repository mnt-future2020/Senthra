import { describe, expect, it } from "vitest";

import {
  FILTER_PARAMS,
  activeFilterCount,
  clearFilterPatch,
  columnClass,
  tableMinWidth,
  visibleColumns,
  type StockCol,
} from "./columnPriority";

// Measured on a 1024×866 laptop: the All Inventory lens showed FOUR rows. The bands above the table
// looked like the cause but weren't — nine columns shared a flat 760px minimum (~84px each), so
// "London Fulfillment Centre" wrapped to three lines and every row stood ~72px instead of ~45px.

const ALL: StockCol[] = ["item", "sku", "ownership", "location", "qty", "available", "value", "status", "lastMovement"];

describe("column budget", () => {
  it("keeps everything on a wide screen", () => {
    expect(visibleColumns(ALL, "xl")).toEqual(ALL);
  });

  // What a person SCANS for stays; what answers a follow-up question steps aside.
  it("drops only the reference columns when space runs out", () => {
    expect(visibleColumns(ALL, "sm")).toEqual(["item", "ownership", "location", "qty", "available", "status"]);
  });

  it("never drops a column that rows are told apart by", () => {
    for (const col of ["item", "qty", "status", "ownership", "location", "warehouse", "customer"] as StockCol[]) {
      expect(columnClass(col), `"${col}" must never be hidden`).toBe("");
    }
  });

  it("brings last movement back one breakpoint earlier than the rest", () => {
    expect(visibleColumns(ALL, "lg")).toContain("lastMovement");
    expect(visibleColumns(ALL, "lg")).not.toContain("value");
  });
});

describe("tableMinWidth", () => {
  // The flat 760px was the bug: it let the browser resolve the overflow by WRAPPING text and growing
  // rows, on a screen already short of them, rather than by scrolling sideways.
  it("asks for more than the old flat 760px once there are nine columns", () => {
    expect(tableMinWidth(ALL)).toBeGreaterThan(760);
  });

  it("gives the item column extra room for its second line", () => {
    expect(tableMinWidth(["item"])).toBeGreaterThan(tableMinWidth(["sku"]));
  });

  it("scales with the column count, so a narrow lens still fits", () => {
    expect(tableMinWidth(["item", "qty"])).toBeLessThan(tableMinWidth(ALL));
  });
});

// Folding filters behind one control is only safe while you can still see that some are ON — a
// narrowed list must never be mistakable for a short one.
describe("activeFilterCount", () => {
  const params = (o: Record<string, string>) => (k: string) => o[k] ?? null;

  it("counts each configured filter that is set", () => {
    expect(activeFilterCount(["owner", "status"], params({ owner: "company", status: "low_stock" }))).toBe(2);
    expect(activeFilterCount(["owner", "status"], params({ owner: "company" }))).toBe(1);
    expect(activeFilterCount(["owner", "status"], params({}))).toBe(0);
  });

  // A stale param from another lens would otherwise report a narrowing this screen can neither show
  // nor clear — the trigger would say "1" with nothing behind it.
  it("ignores a set param the screen does not offer", () => {
    expect(activeFilterCount(["owner"], params({ owner: "company", customer: "c1" }))).toBe(1);
  });

  // Search sits outside the popover, in plain sight, so counting it would double-report.
  it("never counts the search box", () => {
    expect(activeFilterCount([...FILTER_PARAMS], params({ q: "fibre" }))).toBe(0);
  });

  it("treats an empty string as unset", () => {
    expect(activeFilterCount(["status"], params({ status: "" }))).toBe(0);
  });
});

describe("clearFilterPatch", () => {
  it("clears exactly the filters this screen configures", () => {
    expect(clearFilterPatch(["owner", "status"])).toEqual({ owner: null, status: null });
  });

  // Clearing a param the lens doesn't own would wipe state belonging to another screen.
  it("leaves unconfigured params alone", () => {
    expect(clearFilterPatch(["owner"])).not.toHaveProperty("customer");
  });

  it("is empty when nothing is configured", () => {
    expect(clearFilterPatch([])).toEqual({});
  });

  // The count and the clear must agree, or "Clear 2 filters" could leave one on.
  it("covers every param the count can report", () => {
    const configured = [...FILTER_PARAMS];
    const all = Object.fromEntries(FILTER_PARAMS.map((p) => [p, "x"]));
    expect(Object.keys(clearFilterPatch(configured)).length).toBe(
      activeFilterCount(configured, (k) => all[k] ?? null),
    );
  });
});
