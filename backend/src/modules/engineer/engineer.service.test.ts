import { beforeEach, describe, expect, it, vi } from "vitest";

// Pure unit test — the repository (engineer-stock reads) is mocked, so no DB. Confirms mapping,
// scoping (the passed engineerId is used), and the overview summary math.
vi.mock("./engineer.repository.js", () => ({
  findBalancesByEngineer: vi.fn(),
  findRecentTransactions: vi.fn(),
}));

import * as engineerRepo from "./engineer.repository.js";
import { getOwnActivity, getOwnOverview, getOwnStock } from "./engineer.service.js";

const ENG = "a".repeat(24);
const mockBalances = engineerRepo.findBalancesByEngineer as ReturnType<typeof vi.fn>;
const mockTxns = engineerRepo.findRecentTransactions as ReturnType<typeof vi.fn>;

const bal = (over: Record<string, unknown> = {}) => ({
  irmItemId: "i1",
  quantityOnHand: 5,
  irmItem: { id: "i1", code: "IRM-0001", name: "CAT6 Cable", baseUnit: "Box" },
  ...over,
});
const txn = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  type: "goods_out",
  quantityDelta: 5,
  balanceAfter: 5,
  sourceCode: "GDN-0001",
  notes: null,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  irmItem: { code: "IRM-0001", name: "CAT6 Cable" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOwnStock", () => {
  it("maps held balances to stock items (scoped to the engineer)", async () => {
    mockBalances.mockResolvedValue([
      bal(),
      bal({ irmItemId: "i2", quantityOnHand: 3, irmItem: { id: "i2", code: "IRM-0002", name: "RJ45", baseUnit: null } }),
    ]);
    const stock = await getOwnStock(ENG);
    expect(mockBalances).toHaveBeenCalledWith(ENG);
    expect(stock).toEqual([
      { irmItemId: "i1", itemCode: "IRM-0001", itemName: "CAT6 Cable", baseUnit: "Box", quantityOnHand: 5 },
      { irmItemId: "i2", itemCode: "IRM-0002", itemName: "RJ45", baseUnit: null, quantityOnHand: 3 },
    ]);
  });
});

describe("getOwnActivity", () => {
  it("maps ledger rows and labels the type", async () => {
    mockTxns.mockResolvedValue([txn(), txn({ id: "t2", type: "return", quantityDelta: -2, balanceAfter: 3 })]);
    const acts = await getOwnActivity(ENG, 10);
    expect(mockTxns).toHaveBeenCalledWith(ENG, 10);
    expect(acts[0]).toMatchObject({ type: "goods_out", label: "Collected", itemName: "CAT6 Cable", quantityDelta: 5, sourceCode: "GDN-0001" });
    expect(acts[1]).toMatchObject({ type: "return", label: "Returned", quantityDelta: -2, balanceAfter: 3 });
  });
});

describe("getOwnOverview", () => {
  it("summarises stock (lines + total qty) + recent activity, all scoped to the engineer", async () => {
    mockBalances.mockResolvedValue([bal({ quantityOnHand: 5 }), bal({ irmItemId: "i2", quantityOnHand: 3 })]);
    mockTxns.mockResolvedValue([txn()]);

    const ov = await getOwnOverview(ENG);
    expect(ov.stock).toEqual({ lines: 2, totalQuantity: 8 });
    expect(ov.recentActivity).toHaveLength(1);
  });

  it("returns clean zeros/empties for an engineer with no stock", async () => {
    mockBalances.mockResolvedValue([]);
    mockTxns.mockResolvedValue([]);
    const ov = await getOwnOverview(ENG);
    expect(ov).toEqual({ stock: { lines: 0, totalQuantity: 0 }, recentActivity: [] });
  });
});
