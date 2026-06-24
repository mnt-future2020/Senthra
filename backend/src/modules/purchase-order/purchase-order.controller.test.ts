import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./purchase-order.service.js", () => ({ listPurchaseOrders: vi.fn() }));
vi.mock("#modules/document/document.service.js", () => ({ generatePurchaseOrderPdf: vi.fn() }));

import * as poService from "./purchase-order.service.js";
import { listPurchaseOrders } from "./purchase-order.controller.js";

const mockList = poService.listPurchaseOrders as ReturnType<typeof vi.fn>;
const WH_ID = "b".repeat(24);

// Drive a controller through asyncHandler and resolve once its async body has settled.
async function run(req: Partial<Request>) {
  const json = vi.fn();
  const res = { json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  listPurchaseOrders(req as Request, res, next);
  await new Promise((r) => setImmediate(r));
  return { json, next };
}

describe("listPurchaseOrders controller — forwards the warehouse-access actor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ purchaseOrders: [], total: 0, page: 1, pageSize: 20, totalPages: 1 });
  });

  // Regression guard: the controller MUST pass the principal-derived actor as the 2nd arg, or the
  // service applies no warehouse scope and a restricted user's PO list leaks every warehouse.
  it("passes a scoped staff principal's assigned warehouses to the service", async () => {
    const req = {
      query: {},
      principal: { id: "u1", email: "wm@x.com", type: "user", permissions: [], assignedWarehouseIds: [WH_ID] },
    } as unknown as Request;
    await run(req);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList.mock.calls[0][1]).toMatchObject({ type: "user", assignedWarehouseIds: [WH_ID] });
  });

  it("passes an unrestricted (admin) actor through with no warehouse restriction", async () => {
    const req = {
      query: {},
      principal: { id: "a1", email: "a@x.com", type: "admin", permissions: [] },
    } as unknown as Request;
    await run(req);
    expect(mockList.mock.calls[0][1]).toMatchObject({ type: "admin", assignedWarehouseIds: null });
  });
});
