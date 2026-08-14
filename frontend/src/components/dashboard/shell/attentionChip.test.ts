import { describe, expect, it } from "vitest";

import { clearedQuery, isChipActive } from "./attentionChip";

const url = (qs: string) => new URLSearchParams(qs);

describe("isChipActive", () => {
  it("matches when the chip's filters are all applied on the same path", () => {
    expect(isChipActive("/dashboard/jobs?status=overdue", "/dashboard/jobs", url("status=overdue"))).toBe(true);
  });

  it("ignores unrelated params — the chip claims its filters, not the whole address bar", () => {
    expect(
      isChipActive("/dashboard/jobs?status=overdue", "/dashboard/jobs", url("status=overdue&q=acme&page=3")),
    ).toBe(true);
  });

  it("does not match a different value, a missing param or another page", () => {
    expect(isChipActive("/dashboard/jobs?status=overdue", "/dashboard/jobs", url("status=draft"))).toBe(false);
    expect(isChipActive("/dashboard/jobs?status=overdue", "/dashboard/jobs", url(""))).toBe(false);
    expect(isChipActive("/dashboard/jobs?status=overdue", "/dashboard/customers", url("status=overdue"))).toBe(false);
  });

  it("requires EVERY filter of a multi-param chip", () => {
    const href = "/dashboard/warehouses/WH-A?tab=incoming&pool=customer";
    expect(isChipActive(href, "/dashboard/warehouses/WH-A", url("tab=incoming&pool=customer"))).toBe(true);
    // Right tab, wrong pane — the counted rows are not on screen, so the chip is not "current".
    expect(isChipActive(href, "/dashboard/warehouses/WH-A", url("tab=incoming"))).toBe(false);
  });

  // A count with no screen behind it renders as a plain number. If it were ever reported active it
  // would get the selected treatment and a clear-the-filter click that does nothing.
  it("is never active for a count with no destination", () => {
    expect(isChipActive(undefined, "/dashboard/warehouses", url("status=active"))).toBe(false);
  });

  // The bug this guard exists for: a bare route matches vacuously (no filters to check), so every
  // chip pointing at the module list would light up as "you are already here".
  it("is never active for a bare route with no filter", () => {
    expect(isChipActive("/dashboard/warehouses", "/dashboard/warehouses", url(""))).toBe(false);
  });
});

describe("clearedQuery", () => {
  it("removes only the chip's own params", () => {
    expect(clearedQuery("/dashboard/jobs?status=overdue", url("status=overdue&q=acme&sort=name"))).toBe(
      "q=acme&sort=name",
    );
  });

  it("drops the page too — a narrower list has fewer pages", () => {
    expect(clearedQuery("/dashboard/jobs?status=overdue", url("status=overdue&page=4"))).toBe("");
  });

  it("removes every param of a multi-param chip", () => {
    expect(clearedQuery("/w/WH-A?tab=incoming&pool=customer", url("tab=incoming&pool=customer&q=x"))).toBe("q=x");
  });

  it("leaves the screen alone when the chip has no destination", () => {
    expect(clearedQuery(undefined, url("status=active&q=x"))).toBe("status=active&q=x");
  });
});
