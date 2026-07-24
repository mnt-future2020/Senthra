import { describe, expect, it } from "vitest";

import { belongsToWarehouses, lineDone, lineRemaining, linesAllDone } from "./van-stock-request.repository.js";
import { assertRequestAccess, assertWalkInAvailability, computeProgress, isReviewer, isStale, pickCloseShortLines, requestAccessWarehouseIds, requestDoneAfter, resolveFulfilWarehouses, resolveLineApprovals, STALE_ACTIVE_DAYS, STALE_PENDING_DAYS, toPublic } from "./van-stock-request.service.js";
import type { RequestWithLines } from "./van-stock-request.repository.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-07-14T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

function req(over: Partial<{ status: string; createdAt: Date; reviewedAt: Date | null; lastFulfilledAt: Date | null }>) {
  return { status: "pending", createdAt: ago(0), reviewedAt: null, lastFulfilledAt: null, ...over };
}

describe("isStale", () => {
  it("flags pending older than the pending threshold", () => {
    expect(isStale(req({ createdAt: ago(STALE_PENDING_DAYS + 1) }), now)).toBe(true);
    expect(isStale(req({ createdAt: ago(STALE_PENDING_DAYS - 1) }), now)).toBe(false);
  });
  it("flags approved with no posting activity past the active threshold", () => {
    expect(isStale(req({ status: "approved", reviewedAt: ago(STALE_ACTIVE_DAYS + 1) }), now)).toBe(true);
    expect(isStale(req({ status: "approved", reviewedAt: ago(STALE_ACTIVE_DAYS - 1) }), now)).toBe(false);
  });
  it("measures partially_fulfilled from the LAST posting, not the review", () => {
    expect(isStale(req({ status: "partially_fulfilled", reviewedAt: ago(90), lastFulfilledAt: ago(STALE_ACTIVE_DAYS - 2) }), now)).toBe(false);
    expect(isStale(req({ status: "partially_fulfilled", reviewedAt: ago(90), lastFulfilledAt: ago(STALE_ACTIVE_DAYS + 2) }), now)).toBe(true);
  });
  it("never flags terminal states", () => {
    for (const status of ["fulfilled", "declined", "cancelled"]) {
      expect(isStale(req({ status, createdAt: ago(400) }), now)).toBe(false);
    }
  });
});

describe("belongsToWarehouses (line-level ownership)", () => {
  it("matches by request warehouseId, pending preferredWarehouseId, OR any line source", () => {
    const w = belongsToWarehouses(["W1"]);
    const json = JSON.stringify(w);
    expect(json).toContain("warehouseId"); // final-warehouse arm (returns/walk-in)
    expect(json).toContain("preferredWarehouseId"); // pending routing arm
    expect(json).toContain("sourceWarehouseId"); // NEW per-line arm
    expect(json).toContain("some"); // line-level relation filter
  });
});

describe("toPublic scope propagation (regression: default-param must not coerce undefined→null)", () => {
  // Minimal RequestWithLines fixture — one line sourced to W1.
  const d = new Date("2026-07-15T00:00:00Z");
  const baseReq = {
    id: "r1", code: "VSR-0001", type: "restock", status: "approved", priority: "normal", createdVia: "engineer_request",
    engineerId: "e1", engineerName: "Eng", engineerEmail: null,
    preferredWarehouseId: null, preferredWarehouseName: null, preferredWarehouseCode: null,
    warehouseId: "W1", warehouseName: "WH1", warehouseCode: "W1",
    reason: "x", notes: null, attachments: [],
    reviewedByUserId: null, reviewedByEmail: null, reviewedAt: null, decisionNote: null,
    lastFulfilledAt: null, completionType: null, closedShortBy: null, closedShortAt: null, closeShortNote: null, cancelledAt: null,
    createdBy: null, createdAt: d, updatedAt: d, deletedAt: null,
    lines: [{ id: "l1", requestId: "r1", irmItemId: "i1", itemName: "Item", sku: null, uom: null, requestedQty: 1, approvedQty: 1, fulfilledQty: 0, sourceWarehouseId: "W1", sourceWarehouseName: "WH1", sourceWarehouseCode: "W1", closedShortQty: null, closedShortBy: null, closedShortNote: null, closedShortAt: null, createdAt: d }],
    fulfilments: [],
  } as unknown as RequestWithLines;

  it("undefined scope (unrestricted admin) ⇒ every line isMine=true", () => {
    const pub = toPublic(baseReq, d, undefined);
    expect(pub.lines[0].isMine).toBe(true); // the bug: default param coerced undefined→null ⇒ false
    expect(pub.myProgress).not.toBeNull();
    expect(pub.myProgress!.allMineDone).toBe(false); // 0/1 fulfilled
  });
  it("null scope (engineer) ⇒ isMine=false, myProgress null", () => {
    const pub = toPublic(baseReq, d, null);
    expect(pub.lines[0].isMine).toBe(false);
    expect(pub.myProgress).toBeNull();
  });
  it("scoped array ⇒ isMine only for in-scope sources", () => {
    expect(toPublic(baseReq, d, ["W1"]).lines[0].isMine).toBe(true);
    expect(toPublic(baseReq, d, ["W2"]).lines[0].isMine).toBe(false);
  });
  it("DTO remainingQty subtracts closedShortQty (regression: closed-short line must not read as still open)", () => {
    // approved 2, fulfilled 1, closed-short 1 ⇒ remainingQty 0, NOT 1 (else the UI shows a "+1 left"
    // chip and lists the closed-short line as fulfillable).
    const withClosedShort = {
      ...baseReq,
      lines: [{ ...(baseReq.lines[0] as object), requestedQty: 2, approvedQty: 2, fulfilledQty: 1, closedShortQty: 1 }],
    } as unknown as RequestWithLines;
    expect(toPublic(withClosedShort, d, undefined).lines[0].remainingQty).toBe(0);
    // and a normal partially-fulfilled line (no close-short) still reports the real remainder
    const partial = { ...baseReq, lines: [{ ...(baseReq.lines[0] as object), requestedQty: 3, approvedQty: 3, fulfilledQty: 1, closedShortQty: null }] } as unknown as RequestWithLines;
    expect(toPublic(partial, d, undefined).lines[0].remainingQty).toBe(2);
  });
});

describe("canonical line math (lineRemaining / lineDone / linesAllDone) — C1/H1 regression", () => {
  const L = (o: Partial<{ approvedQty: number | null; requestedQty: number; fulfilledQty: number; closedShortQty: number | null }>) =>
    ({ approvedQty: 5, requestedQty: 5, fulfilledQty: 0, closedShortQty: null, ...o });

  it("lineRemaining subtracts BOTH fulfilled AND closedShort (C1: closed-short qty not re-fulfillable)", () => {
    // approved 5, fulfilled 3, closed-short 2 ⇒ 0 left (NOT 2). Prevents re-issuing the written-off qty.
    expect(lineRemaining(L({ fulfilledQty: 3, closedShortQty: 2 }))).toBe(0);
    expect(lineRemaining(L({ fulfilledQty: 3 }))).toBe(2);
  });
  it("lineDone true when fulfilled+closedShort covers approved (H1: stuck partially_fulfilled)", () => {
    expect(lineDone(L({ fulfilledQty: 0, closedShortQty: 5 }))).toBe(true); // fully closed-short = done
    expect(lineDone(L({ fulfilledQty: 3, closedShortQty: 2 }))).toBe(true); // 3 issued + 2 written off
    expect(lineDone(L({ fulfilledQty: 3 }))).toBe(false); // 2 still outstanding
  });
  it("lineDone true for an excluded line (approvedQty 0)", () => {
    expect(lineDone(L({ approvedQty: 0 }))).toBe(true);
  });
  it("linesAllDone: split request done when one line fulfilled + other closed-short (H1 scenario)", () => {
    const lines = [L({ approvedQty: 5, fulfilledQty: 0, closedShortQty: 5 }), L({ approvedQty: 5, fulfilledQty: 5 })];
    expect(linesAllDone(lines)).toBe(true);
  });
  it("linesAllDone: all-excluded approval is immediately done (H3)", () => {
    expect(linesAllDone([L({ approvedQty: 0 }), L({ approvedQty: 0 })])).toBe(true);
  });
});

describe("requestAccessWarehouseIds (getOne access mirrors belongsToWarehouses)", () => {
  it("includes the request warehouseId, pending preferredWarehouseId, AND every line source", () => {
    const req = {
      status: "fulfilled",
      warehouseId: "WH-0005",
      preferredWarehouseId: "WH-0005",
      lines: [{ sourceWarehouseId: "WH-0005" }, { sourceWarehouseId: "WH-0003" }],
    };
    const ids = requestAccessWarehouseIds(req);
    // A manager assigned ONLY WH-0003 owns line 2's source ⇒ must be granted access.
    expect(ids).toContain("WH-0003");
    expect(ids).toContain("WH-0005");
  });
  it("for a pending request, includes preferredWarehouseId", () => {
    const req = { status: "pending", warehouseId: null, preferredWarehouseId: "WH-0003", lines: [] };
    expect(requestAccessWarehouseIds(req)).toContain("WH-0003");
  });
  it("does NOT include preferredWarehouseId once the request is past pending (final warehouse governs)", () => {
    const req = { status: "approved", warehouseId: "WH-0005", preferredWarehouseId: "WH-0003", lines: [{ sourceWarehouseId: "WH-0005" }] };
    const ids = requestAccessWarehouseIds(req);
    expect(ids).toContain("WH-0005");
    expect(ids).not.toContain("WH-0003"); // pref no longer routes once approved
  });
  it("drops null sources", () => {
    const req = { status: "pending", warehouseId: null, preferredWarehouseId: null, lines: [{ sourceWarehouseId: null }] };
    expect(requestAccessWarehouseIds(req)).toEqual([]);
  });
});

describe("assertRequestAccess (shared reviewer gate — getOne / scanLookup / closeShort)", () => {
  const scoped = (ids: string[]) => ({ type: "user" as const, permissions: ["van_stock_request.review"], assignedWarehouseIds: ids });
  const split = { status: "approved", warehouseId: "WH-0005", preferredWarehouseId: null, lines: [{ sourceWarehouseId: "WH-0005" }, { sourceWarehouseId: "WH-0003" }] };

  it("allows a scoped reviewer who owns ANY of the request's warehouses (incl. a split line source)", () => {
    expect(() => assertRequestAccess(scoped(["WH-0005"]), split)).not.toThrow();
    expect(() => assertRequestAccess(scoped(["WH-0003"]), split)).not.toThrow(); // owns only line 2's source
  });
  it("denies a scoped reviewer who owns none of them", () => {
    expect(() => assertRequestAccess(scoped(["WH-0009"]), split)).toThrow(/don't have access/);
  });
  it("never restricts an unrestricted actor (admin)", () => {
    expect(() => assertRequestAccess({ type: "admin" as const, permissions: [] }, split)).not.toThrow();
    expect(() => assertRequestAccess({ type: "user" as const, permissions: ["*"], assignedWarehouseIds: null }, split)).not.toThrow();
  });
  it("FAILS CLOSED for a scoped reviewer when NO warehouse owns the request — SECURITY", () => {
    // Regression: the old getOne gate had `accessIds.length > 0 &&`, which short-circuited the whole
    // check for an unowned request and let ANY scoped reviewer read another engineer's request.
    const unowned = { status: "pending", warehouseId: null, preferredWarehouseId: null, lines: [{ sourceWarehouseId: null }] };
    expect(requestAccessWarehouseIds(unowned)).toEqual([]);
    expect(() => assertRequestAccess(scoped(["WH-0005"]), unowned)).toThrow(/don't have access/);
    // …but an admin still reaches it (mirrors decline()'s rule).
    expect(() => assertRequestAccess({ type: "admin" as const, permissions: [] }, unowned)).not.toThrow();
  });
  it("denies a scoped reviewer with an EMPTY assigned set", () => {
    expect(() => assertRequestAccess(scoped([]), split)).toThrow(/don't have access/);
  });
});

describe("isReviewer", () => {
  it("true for an explicit admin type", () => {
    expect(isReviewer({ type: "admin", permissions: [] })).toBe(true);
  });
  it("true for the '*' or review permission", () => {
    expect(isReviewer({ type: "user", permissions: ["*"] })).toBe(true);
    expect(isReviewer({ type: "user", permissions: ["van_stock_request.review"] })).toBe(true);
  });
  it("FALSE for a plain field engineer (not warehouse-scoped, no review perm) — SECURITY: must not count as reviewer", () => {
    // Regression for H2: a field engineer's role isn't warehouse-scoped ⇒ assignedWarehouseIds is null.
    // The old `=== null` arm wrongly made them a reviewer, letting them getOne ANY engineer's request.
    // They reach their OWN request via the isOwner branch, never via isReviewer.
    expect(isReviewer({ type: "user", permissions: ["engineer.van_stock.request"], assignedWarehouseIds: null })).toBe(false);
    expect(isReviewer({ type: "user", permissions: [] })).toBe(false);
  });
  it("false for a warehouse-SCOPED actor without the review perm", () => {
    expect(isReviewer({ type: "user", permissions: [], assignedWarehouseIds: ["W1"] })).toBe(false);
  });
});

describe("computeProgress", () => {
  const line = (over = {}) => ({ approvedQty: 2, requestedQty: 2, fulfilledQty: 0, closedShortQty: null, sourceWarehouseId: "W1", ...over });

  // A PENDING restock line has approvedQty null (set only on approve) — the canonical math falls back
  // to requestedQty. The old inline `approvedQty ?? 0` read that as "approved 0 ⇒ done", so an
  // untouched pending request rendered "1/1 done · 0 qty" and flipped allMineDone → "your part is
  // complete" before a single unit was issued.
  it("pending line (approvedQty null) is NOT done and counts its requested qty", () => {
    const p = computeProgress([line({ approvedQty: null, requestedQty: 5 })], undefined);
    expect(p.progress.lines).toBe(1);
    expect(p.progress.linesDone).toBe(0);
    expect(p.progress.qty).toBe(5); // falls back to requestedQty, not 0
    expect(p.myProgress!.allMineDone).toBe(false);
  });

  it("overall: counts non-excluded lines and their fulfil state", () => {
    const p = computeProgress([line({ fulfilledQty: 2 }), line({ approvedQty: 0 })], undefined);
    expect(p.progress.lines).toBe(1); // excluded (approvedQty 0) not counted
    expect(p.progress.linesDone).toBe(1); // the fulfilled one
    expect(p.progress.qty).toBe(2);
    expect(p.progress.qtyFulfilled).toBe(2);
  });

  it("myProgress: only lines whose source is in scope; allMineDone true when my lines complete", () => {
    const lines = [line({ sourceWarehouseId: "W1", fulfilledQty: 2 }), line({ sourceWarehouseId: "W2", fulfilledQty: 0 })];
    const p = computeProgress(lines, ["W1"]);
    expect(p.myProgress).not.toBeNull();
    expect(p.myProgress!.lines).toBe(1);
    expect(p.myProgress!.linesDone).toBe(1);
    expect(p.myProgress!.allMineDone).toBe(true); // my only line (W1) is done, even though W2 isn't
    expect(p.myProgress!.warehouseIds).toEqual(["W1"]);
  });

  it("closed-short line counts as done", () => {
    const p = computeProgress([line({ fulfilledQty: 0, closedShortQty: 2 })], ["W1"]);
    expect(p.progress.linesDone).toBe(1);
    expect(p.myProgress!.allMineDone).toBe(true);
  });

  it("engineer read (null scope): myProgress null", () => {
    const p = computeProgress([line()], null); // null sentinel = engineer, no warehouse role
    expect(p.myProgress).toBeNull();
  });
});

describe("resolveLineApprovals (approve sourcing + hard-block)", () => {
  const reqLines = [
    { id: "L1", irmItemId: "I1", itemName: "Cable Ties", requestedQty: 2 },
    { id: "L2", irmItemId: "I2", itemName: "CAT6", requestedQty: 2 },
  ];
  const wh = { id: "PRIMARY", name: "Primary WH", code: "WH-1" };
  const activeWarehouse = async (id: string) => (id === "PRIMARY" ? wh : id === "LONDON" ? { id: "LONDON", name: "London", code: "WH-2" } : null);

  it("defaults each line's source to the primary warehouse", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }, { irmItemId: "I2", warehouseId: "PRIMARY", quantityOnHand: 5 }];
    const out = await resolveLineApprovals(reqLines, [], wh, activeWarehouse, async () => balances);
    expect(out.every((l) => l.sourceWarehouseId === "PRIMARY")).toBe(true);
    expect(out.map((l) => l.approvedQty)).toEqual([2, 2]);
  });

  it("uses an explicit per-line source when provided", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }, { irmItemId: "I2", warehouseId: "LONDON", quantityOnHand: 5 }];
    const out = await resolveLineApprovals(reqLines, [{ lineId: "L2", approvedQty: 2, sourceWarehouseId: "LONDON" }], wh, activeWarehouse, async () => balances);
    expect(out.find((l) => l.lineId === "L2")!.sourceWarehouseId).toBe("LONDON");
  });

  it("hard-blocks: throws when a line's source has less than approvedQty", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }, { irmItemId: "I2", warehouseId: "PRIMARY", quantityOnHand: 0 }];
    await expect(resolveLineApprovals(reqLines, [], wh, activeWarehouse, async () => balances)).rejects.toThrow(/CAT6/);
  });

  it("excluded line (approvedQty 0) skips source + availability", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }]; // I2 has NO stock anywhere
    const out = await resolveLineApprovals(reqLines, [{ lineId: "L2", approvedQty: 0 }], wh, activeWarehouse, async () => balances);
    const l2 = out.find((l) => l.lineId === "L2")!;
    expect(l2.approvedQty).toBe(0);
    expect(l2.sourceWarehouseId).toBeNull(); // excluded ⇒ no source
  });

  it("rejects an inactive/unknown source warehouse", async () => {
    const balances = [{ irmItemId: "I1", warehouseId: "PRIMARY", quantityOnHand: 5 }, { irmItemId: "I2", warehouseId: "PRIMARY", quantityOnHand: 5 }];
    await expect(resolveLineApprovals(reqLines, [{ lineId: "L2", approvedQty: 2, sourceWarehouseId: "GONE" }], wh, activeWarehouse, async () => balances)).rejects.toThrow(/no longer exists|not active|warehouse/i);
  });
});

describe("assertWalkInAvailability (walk-in availability hard-block)", () => {
  const lines = [
    { irmItemId: "I1", itemName: "Fibre Panel", requestedQty: 2 },
    { irmItemId: "I2", itemName: "CAT6", requestedQty: 1 },
  ];
  it("passes when every line's on-hand covers the requested qty", () => {
    const onHand = new Map([["I1", 2], ["I2", 5]]);
    expect(() => assertWalkInAvailability(lines, "London Logistics Hub", onHand)).not.toThrow();
  });
  it("throws naming the short item + warehouse when on-hand is below requested", () => {
    const onHand = new Map([["I1", 1], ["I2", 5]]);
    expect(() => assertWalkInAvailability(lines, "London Logistics Hub", onHand)).toThrow(/Fibre Panel.*only 1.*London Logistics Hub/);
  });
  it("treats a missing (unstocked) item balance as 0 on-hand", () => {
    const onHand = new Map([["I2", 5]]); // I1 absent ⇒ 0 on-hand
    expect(() => assertWalkInAvailability(lines, "London Logistics Hub", onHand)).toThrow(/Fibre Panel.*only 0/);
  });
});

describe("resolveFulfilWarehouses (split fulfil)", () => {
  const lines = [
    { id: "L1", irmItemId: "I1", itemName: "Ties", sourceWarehouseId: "W1", sourceWarehouseName: "Warehouse 1" },
    { id: "L2", irmItemId: "I2", itemName: "CAT6", sourceWarehouseId: "W2", sourceWarehouseName: "Warehouse 2" },
  ];
  it("maps each entry to its line's source warehouse", () => {
    const out = resolveFulfilWarehouses(lines, [{ lineId: "L1", qty: 1 }, { lineId: "L2", qty: 1 }], undefined);
    expect(out.find((e) => e.lineId === "L1")!.warehouseId).toBe("W1");
    expect(out.find((e) => e.lineId === "L2")!.warehouseId).toBe("W2");
  });
  it("rejects an entry whose line source is outside the actor's scope", () => {
    expect(() => resolveFulfilWarehouses(lines, [{ lineId: "L2", qty: 1 }], ["W1"])).toThrow(/access|another warehouse/i);
  });
  it("out-of-scope entry throws a 403 (forbidden), not a generic error", () => {
    try {
      resolveFulfilWarehouses(lines, [{ lineId: "L2", qty: 1 }], ["W1"]);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      expect((e as { statusCode?: number; status?: number }).statusCode ?? (e as { status?: number }).status).toBe(403);
    }
  });
  it("rejects an entry whose line has no source (unapproved/excluded)", () => {
    const bad = [{ id: "L3", irmItemId: "I3", itemName: "X", sourceWarehouseId: null, sourceWarehouseName: null }];
    expect(() => resolveFulfilWarehouses(bad, [{ lineId: "L3", qty: 1 }], undefined)).toThrow(/not been sourced|no source|can't be fulfilled/i);
  });
});

describe("per-warehouse close-short", () => {
  const lines = [
    { id: "L1", approvedQty: 2, requestedQty: 2, fulfilledQty: 0, closedShortQty: null, sourceWarehouseId: "W1", itemName: "Ties" },
    { id: "L2", approvedQty: 2, requestedQty: 2, fulfilledQty: 2, closedShortQty: null, sourceWarehouseId: "W2", itemName: "CAT6" },
  ];
  it("picks only the acting warehouse's own outstanding lines", () => {
    const picked = pickCloseShortLines(lines, "W1");
    expect(picked.map((l) => l.id)).toEqual(["L1"]); // W1's outstanding line
  });
  // Scoped to ONE warehouse (the tab) — even an admin closing short from W1's tab never touches W2's
  // lines on a split request, and vice-versa. This is the per-tab consistency with scan/fulfil.
  it("never picks another warehouse's lines (per-tab scope, admins included)", () => {
    expect(pickCloseShortLines(lines, "W2").map((l) => l.id)).toEqual([]); // L2 is W2 but already fulfilled
    expect(pickCloseShortLines(lines, "W1").map((l) => l.id)).toEqual(["L1"]); // W1 only
  });
  // Guards the switch to the canonical lineDone(): it (correctly) reports an UNAPPROVED line as NOT
  // done, where the old inline copy said done. An unapproved line must still never be close-short-able
  // — it's held out by the source-warehouse match (a source is stamped only at approval), and
  // closeShort() additionally requires status partially_fulfilled, which is post-approval. Belt and braces.
  it("never picks an unapproved line (approvedQty null ⇒ no source yet)", () => {
    const pending = [{ id: "L9", approvedQty: null, requestedQty: 4, fulfilledQty: 0, closedShortQty: null, sourceWarehouseId: null, itemName: "Unapproved" }];
    expect(pickCloseShortLines(pending, "W1")).toEqual([]);
  });
  it("request done once L1 is written off and L2 already fulfilled", () => {
    const after = lines.map((l) => (l.id === "L1" ? { ...l, closedShortQty: 2 } : l));
    expect(requestDoneAfter(after)).toBe(true);
  });
  it("request still open when a non-actor line remains unfulfilled", () => {
    const three = [...lines, { id: "L3", approvedQty: 5, requestedQty: 5, fulfilledQty: 0, closedShortQty: null, sourceWarehouseId: "W3", itemName: "Screws" }];
    const after = three.map((l) => (l.id === "L1" ? { ...l, closedShortQty: 2 } : l));
    expect(requestDoneAfter(after)).toBe(false); // L3 (W3) still open
  });
});
