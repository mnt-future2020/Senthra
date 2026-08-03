import { describe, expect, it } from "vitest";

import { completionBadge, lineProgress, linesForWarehouse, postingsForLines, warehouseStatus } from "./vanRequestUi";

// Each source warehouse reviews and issues ONLY its own lines, so a request's own status describes
// the whole thing and not this warehouse's share of it. Showing the global status in a warehouse
// queue was actively misleading: it read "Approved" the moment ANY other warehouse approved, so a
// manager scrolled past work that was still theirs to do — and "Partially fulfilled" appeared
// because somebody else had issued their part.
const MINE = "WH-0005";
const OTHER = "WH-0003";

const line = (over: Partial<{ sourceWarehouseId: string | null; approvedQty: number | null; remainingQty: number; fulfilledQty: number }> = {}) => ({
  sourceWarehouseId: MINE as string | null,
  approvedQty: null as number | null,
  remainingQty: 0,
  fulfilledQty: 0,
  ...over,
});
const req = (status: string, lines: ReturnType<typeof line>[]) => ({ status, lines }) as never;

describe("linesForWarehouse", () => {
  it("keeps this warehouse's lines and drops other warehouses'", () => {
    const lines = [line(), line({ sourceWarehouseId: OTHER })];
    expect(linesForWarehouse(lines, MINE)).toHaveLength(1);
  });

  // Raised before per-line selection existed: nobody owns them, so whoever opens the request may act.
  it("keeps an UNDECIDED line with no source (legacy — claimable by whoever opens it)", () => {
    expect(linesForWarehouse([line({ sourceWarehouseId: null, approvedQty: null })], MINE)).toHaveLength(1);
  });

  // Excluding used to wipe a line's source, so an item one warehouse dropped had no owner and
  // surfaced in EVERY warehouse's queue — where it also blocked their Approve.
  it("drops an ANSWERED line with no source — it belongs to nobody now", () => {
    expect(linesForWarehouse([line({ sourceWarehouseId: null, approvedQty: 0 })], MINE)).toHaveLength(0);
  });
});

describe("warehouseStatus", () => {
  it("says PENDING while this warehouse still has a line to answer, even once another has approved", () => {
    // The exact confusion this fixes: the request is `approved` because WH-0003 answered, but the
    // London queue must still show its own line as outstanding work.
    const r = req("approved", [line({ approvedQty: null }), line({ sourceWarehouseId: OTHER, approvedQty: 4, remainingQty: 4 })]);
    expect(warehouseStatus(r, MINE).label).toBe("Pending");
  });

  it("says APPROVED once this warehouse has answered and still has stock to issue", () => {
    const r = req("approved", [line({ approvedQty: 5, remainingQty: 5 })]);
    expect(warehouseStatus(r, MINE).label).toBe("Approved");
  });

  it("says PARTIALLY FULFILLED only when THIS warehouse has issued some of its own", () => {
    const r = req("partially_fulfilled", [line({ approvedQty: 5, remainingQty: 2, fulfilledQty: 3 })]);
    expect(warehouseStatus(r, MINE).label).toBe("Partially fulfilled");
  });

  it("does NOT say partially fulfilled when the issuing was another warehouse's", () => {
    const r = req("partially_fulfilled", [
      line({ approvedQty: 5, remainingQty: 5 }), // mine, untouched
      line({ sourceWarehouseId: OTHER, approvedQty: 4, remainingQty: 0, fulfilledQty: 4 }),
    ]);
    expect(warehouseStatus(r, MINE).label).toBe("Approved");
  });

  it("says DONE HERE when this warehouse has nothing outstanding but the request is still open", () => {
    const r = req("partially_fulfilled", [
      line({ approvedQty: 5, remainingQty: 0, fulfilledQty: 5 }),
      line({ sourceWarehouseId: OTHER, approvedQty: 4, remainingQty: 4 }),
    ]);
    expect(warehouseStatus(r, MINE).label).toBe("Done here");
  });

  it("an EXCLUDED line counts as answered, not as outstanding", () => {
    expect(warehouseStatus(req("approved", [line({ approvedQty: 0, remainingQty: 0 })]), MINE).label).toBe("Done here");
  });

  // Terminal states describe the whole request — there is nothing left for any warehouse to do, so
  // scoping them per warehouse would only invent a distinction that doesn't exist.
  it.each([["declined", "Declined"], ["cancelled", "Cancelled"], ["fulfilled", "Fulfilled"]])(
    "reports %s globally",
    (status, label) => {
      expect(warehouseStatus(req(status, [line({ sourceWarehouseId: OTHER })]), MINE).label).toBe(label);
    },
  );
});

// What a line's PROGRESS says to the engineer. A warehouse can write off what it can't supply
// (close short); before this, such a line fell through to the "Awaiting" fallback — so the engineer
// was told stock was still coming for something the warehouse had already given up on, while the
// request header said Done. The reason was captured at close-short and shown to nobody.
describe("lineProgress", () => {
  const l = (over: Partial<{ approvedQty: number | null; requestedQty: number; fulfilledQty: number; closedShortQty: number | null; cancelledQty: number | null }> = {}) =>
    ({ approvedQty: 6, requestedQty: 6, fulfilledQty: 0, closedShortQty: null, cancelledQty: null, ...over }) as never;

  // "Closed short", never "written off": this app reserves write-off for goods-management's ledger-
  // draining job_lost. Nothing leaves a ledger here — the line was approved but never issued.
  it("says CLOSED SHORT for a line closed with nothing issued — not 'Awaiting'", () => {
    expect(lineProgress(l({ closedShortQty: 6 })).label).toBe("Closed short");
  });

  it("shows what WAS issued when a partly-issued line is then closed short", () => {
    expect(lineProgress(l({ fulfilledQty: 2, closedShortQty: 4 })).label).toBe("2/6 — rest closed short");
  });

  it("still says Awaiting when nothing has happened yet", () => {
    expect(lineProgress(l()).label).toBe("Awaiting");
  });

  it("a fully issued line reads Fulfilled, even if a token qty was closed after", () => {
    expect(lineProgress(l({ fulfilledQty: 6 })).label).toBe("Fulfilled");
  });

  it("an excluded line still reads Excluded", () => {
    expect(lineProgress(l({ approvedQty: 0 })).label).toBe("Excluded");
  });

  // Cancel-remaining is the ENGINEER giving up on the rest, not the warehouse failing to supply it.
  // It used to leave the line untouched entirely, so it fell through to "Awaiting" — the engineer was
  // told their own cancelled stock was still coming, on a request already marked Done.
  it("says CANCELLED for a line the engineer cancelled with nothing issued", () => {
    expect(lineProgress(l({ cancelledQty: 6 })).label).toBe("Cancelled");
  });

  it("shows what WAS issued when a partly-issued line is then cancelled", () => {
    expect(lineProgress(l({ fulfilledQty: 2, cancelledQty: 4 })).label).toBe("2/6 — rest cancelled");
  });

  // Close-short is checked first: if a warehouse had already given up on the line, that is the more
  // specific story and the one the engineer needs (it explains a shortfall they didn't choose).
  it("prefers CLOSED SHORT over cancelled when a line somehow carries both", () => {
    expect(lineProgress(l({ closedShortQty: 3, cancelledQty: 3 })).label).toBe("Closed short");
  });
});

// A warehouse's queue shows only its own lines, so its "Issued" log must match. The log carries no
// warehouse of its own — only the request line each posted row points at knows — so it is narrowed by
// line. Without this, an item issued by another warehouse (and absent from the table above) appeared
// in this warehouse's history as though it had handed the stock over.
describe("postingsForLines", () => {
  const post = (seq: number, lineIds: string[]) =>
    ({ id: `f${seq}`, sequence: seq, performedBy: "a@x.com", postedAt: "", lines: lineIds.map((id, i) => ({ id: `${seq}-${i}`, lineId: id })) }) as never;

  it("keeps only postings against the given lines", () => {
    const out = postingsForLines([post(1, ["mine"]), post(2, ["theirs"])], new Set(["mine"]));
    expect(out.map((f) => f.sequence)).toEqual([1]);
  });

  it("trims a mixed posting down to the matching rows", () => {
    const out = postingsForLines([post(1, ["mine", "theirs"])], new Set(["mine"]));
    expect(out[0]!.lines).toHaveLength(1);
  });

  it("drops a posting left with nothing", () => {
    expect(postingsForLines([post(1, ["theirs"])], new Set(["mine"]))).toEqual([]);
  });

  // The ENGINEER collects from every warehouse on the request, so their view passes no filter and
  // must keep the complete history.
  it("returns everything when no filter is given", () => {
    const all = [post(1, ["mine"]), post(2, ["theirs"])];
    expect(postingsForLines(all, undefined)).toHaveLength(2);
  });
});

// `fulfilled` is the terminal "closed" state reached three different ways, so a request the engineer
// called off with nothing collected wears the identical FULFILLED chip as one fully handed over. Same
// argument as the walk-in badge, which exists because a status chip alone reads as something it isn't.
describe("completionBadge", () => {
  const got = [{ fulfilledQty: 3 }];
  const none = [{ fulfilledQty: 0 }, { fulfilledQty: 0 }];

  // completionType records the last ACTION, not the OUTCOME. A request where 3 of 4 items were
  // collected and the remainder called off carries the same `cancelled_remaining` as one where
  // nothing was ever handed over — so a flat "Cancelled" on the first claims the engineer got
  // nothing, which is untrue and exactly what made the list misread.
  it("says CANCELLED only when nothing at all was collected", () => {
    expect(completionBadge("cancelled_remaining", none)?.label).toBe("Cancelled");
  });

  it("says REST CANCELLED when part of the request was collected", () => {
    expect(completionBadge("cancelled_remaining", got)?.label).toBe("Rest cancelled");
  });

  it("makes the same distinction for a warehouse shortfall", () => {
    expect(completionBadge("closed_short", none)?.label).toBe("Closed short");
    expect(completionBadge("closed_short", got)?.label).toBe("Rest closed short");
  });

  // Grey for a cancellation, amber for a shortfall: nobody failed when the engineer simply stopped
  // needing it, and colouring the two alike would blame the warehouse for the engineer's decision.
  it("colours them apart", () => {
    expect(completionBadge("cancelled_remaining", none)!.cls).not.toBe(completionBadge("closed_short", none)!.cls);
  });

  // A badge on every finished request is noise that trains people to ignore it on the ones that count.
  it("stays silent for a request that simply completed", () => {
    expect(completionBadge("complete", got)).toBeNull();
    expect(completionBadge(null, got)).toBeNull();
  });
});
