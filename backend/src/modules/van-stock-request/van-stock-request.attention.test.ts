import { beforeEach, describe, expect, it, vi } from "vitest";

// The per-warehouse split behind the Warehouses list's "Needs attention" column.
//
// This is the one attention count that CANNOT be a groupBy: "belongs to warehouse X" is a three-armed
// OR (final warehouse / a pending request's preferred warehouse / any line sourced there), not a
// column. So the rows are read and attributed in memory — and every rule in that attribution is a way
// to get a warehouse manager's number wrong:
//
//   • a request touching two warehouses must count at BOTH (each has its own stock to pick)
//   • a request touching one warehouse twice must count ONCE (it is one request to work)
//   • preferredWarehouseId only counts while the request is still pending — once it is approved the
//     final/source warehouses are decided and the preference is history
//   • a scoped actor must never see a sibling warehouse's share, even when the request they can see
//     also involves that sibling
vi.mock("../../lib/prisma.js", () => ({
  prisma: { vanStockRequest: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { countPendingByWarehouse, countReturnsToScanByWarehouse } from "./van-stock-request.repository.js";

const findMany = prisma.vanStockRequest.findMany as ReturnType<typeof vi.fn>;
const rows = (...r: unknown[]) => findMany.mockResolvedValue(r);
const req = (over: Record<string, unknown> = {}) => ({
  status: "pending",
  warehouseId: null,
  preferredWarehouseId: null,
  lines: [],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("countPendingByWarehouse", () => {
  it("counts a request at every warehouse it involves", async () => {
    rows(req({ lines: [{ sourceWarehouseId: "w1" }, { sourceWarehouseId: "w2" }] }));
    expect(await countPendingByWarehouse()).toEqual({ w1: 1, w2: 1 });
  });

  // The row counts are NOT a decomposition of the sidebar badge, and this is why: one request, two
  // warehouses, two rows of work. A UI that showed both next to the badge and expected them to add up
  // would be reading them wrong — which is why the aggregate chip bar was removed from that page.
  it("adds up to more than the flat count when work spans warehouses — by design", async () => {
    rows(req({ lines: [{ sourceWarehouseId: "w1" }, { sourceWarehouseId: "w2" }] }));
    const out = await countPendingByWarehouse();
    expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("counts a request ONCE at a warehouse it touches twice", async () => {
    // Final warehouse w1, and a line also sourced from w1 — one request, one job to do there.
    rows(req({ warehouseId: "w1", lines: [{ sourceWarehouseId: "w1" }, { sourceWarehouseId: "w1" }] }));
    expect(await countPendingByWarehouse()).toEqual({ w1: 1 });
  });

  it("honours the collection preference only while the request is still pending", async () => {
    rows(req({ status: "pending", preferredWarehouseId: "w1" }));
    expect(await countPendingByWarehouse()).toEqual({ w1: 1 });

    // Approved: sourcing is settled, so the preference is no longer anyone's queue.
    rows(req({ status: "approved", preferredWarehouseId: "w1", warehouseId: "w2" }));
    expect(await countPendingByWarehouse()).toEqual({ w2: 1 });
  });

  it("never reports a warehouse outside the actor's scope", async () => {
    // The actor can see w1 (so the request reaches them at all), but its other leg is at w2.
    rows(req({ lines: [{ sourceWarehouseId: "w1" }, { sourceWarehouseId: "w2" }] }));
    expect(await countPendingByWarehouse(["w1"])).toEqual({ w1: 1 });
  });

  it("skips lines with no source warehouse rather than bucketing them under a blank id", async () => {
    rows(req({ warehouseId: "w1", lines: [{ sourceWarehouseId: null }] }));
    expect(await countPendingByWarehouse()).toEqual({ w1: 1 });
  });

  it("returns an empty map when nothing is outstanding — a row shows a dash, not a zero", async () => {
    rows();
    expect(await countPendingByWarehouse()).toEqual({});
  });

  it("selects only the four fields the rule needs", async () => {
    await countPendingByWarehouse();
    expect(findMany.mock.calls[0][0].select).toEqual({
      status: true,
      warehouseId: true,
      preferredWarehouseId: true,
      lines: { select: { sourceWarehouseId: true } },
    });
  });
});

describe("countReturnsToScanByWarehouse", () => {
  it("asks for approved and partially-fulfilled RETURNS only", async () => {
    await countReturnsToScanByWarehouse();
    const [where] = findMany.mock.calls[0][0].where.AND;
    expect(where).toEqual({ type: "return", status: { in: ["approved", "partially_fulfilled"] }, deletedAt: null });
  });

  // A return is approved, so the pending arm of the attribution never applies to it — it is the final
  // and source warehouses that have stock to scan back in.
  it("ignores the collection preference on an approved return", async () => {
    rows(req({ type: "return", status: "approved", preferredWarehouseId: "w9", warehouseId: "w1" }));
    expect(await countReturnsToScanByWarehouse()).toEqual({ w1: 1 });
  });
});
