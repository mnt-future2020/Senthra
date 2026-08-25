import { describe, expect, it } from "vitest";

import { addsStockTrackedDemand } from "./job.service.js";

// ── New kit on a finished-looking job must still be demand ─────────────────────────────────────
//
// THE BUG THIS PINS. `getOpenDemand` skips any job at `issued` / `awaiting_return` / `reconciled`, on
// the correct premise that those states mean "no future warehouse draw left". Growing the kit
// falsifies that premise: an approved additional-kit request (or an edit that adds a line) creates a
// planned quantity nobody has issued, on a job every demand consumer has stopped counting. The units
// then existed on the kit list and in NO availability figure anywhere — not the reorder workbench, not
// the warehouse Demand board, not the caps the kit-request approve dialog enforces, not van-stock
// allocation. Four subsystems, all silently under-stating demand and over-offering stock.
//
// It is NOT a rental bug. The demand path is shared, so the same hole swallowed IRM and consignment
// lines identically — which is why the predicate below is about `lineType` and nothing else.
//
// Fixed at the TRANSITION (`reopenIssuanceForAddedKitTx`, called from both kit-growth paths) rather
// than by loosening the skip. The skip is right; what was wrong was leaving the status behind when the
// facts moved. Loosening it would drag every genuinely finished `awaiting_return` job back into demand
// and re-create the double-subtraction the demand contract exists to prevent.
describe("addsStockTrackedDemand — does this kit change create warehouse demand?", () => {
  const line = (lineType: string) => ({ lineType });

  // All three stock-tracked pools, because the bug was never rental-specific.
  it.each(["irm", "rental", "customer_stock"])("counts a %s line as demand", (lineType) => {
    expect(addsStockTrackedDemand([line(lineType)])).toBe(true);
  });

  // `misc` is excluded for exactly the reason getOpenDemand excludes it: a free-text line is not
  // stock-tracked, so nothing is ever drawn against it and no depot owes anything. Without this,
  // appending "site keys" to a finished job would drag it out of `awaiting_return` and block its
  // Close & Reconcile over an item no warehouse holds.
  it("does NOT count a misc line as demand", () => {
    expect(addsStockTrackedDemand([line("misc")])).toBe(false);
  });

  it("counts a mixed batch once any line is stock-tracked", () => {
    expect(addsStockTrackedDemand([line("misc"), line("irm")])).toBe(true);
  });

  // An empty batch is the no-structural-change path — nothing was added, so nothing is owed.
  it("treats an empty change as no demand", () => {
    expect(addsStockTrackedDemand([])).toBe(false);
  });
});
