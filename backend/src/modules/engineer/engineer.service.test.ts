import { beforeEach, describe, expect, it, vi } from "vitest";

// Pure unit test — every repository/service the engineer surface reads through is mocked, so no DB and
// none of their heavy import graphs. Confirms mapping, scoping (the passed engineerId is always the
// one used), the dashboard summary math, and the customer/misc aggregation.
vi.mock("./engineer.repository.js", () => ({
  findBalancesByEngineer: vi.fn(),
  findRecentTransactions: vi.fn(),
}));
// The overview composes the engineer's workload from the job + transfer + van-stock + kit services;
// mocking them keeps this a pure unit test (and their heavy import graphs out of it).
vi.mock("#modules/job/job.service.js", () => ({ listActiveJobsForEngineer: vi.fn(), listJobsForEngineer: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.service.js", () => ({ listMine: vi.fn(), countAwaitingSignature: vi.fn() }));
vi.mock("#modules/van-stock-request/van-stock-request.service.js", () => ({ countCollectible: vi.fn() }));
vi.mock("#modules/job-kit-request/job-kit-request.service.js", () => ({ listMine: vi.fn() }));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  findCustomerHoldingsByEngineer: vi.fn(),
  findCustomerNamesByIds: vi.fn(),
  findMiscIssueLinesByEngineer: vi.fn(),
}));
vi.mock("#modules/inventory/movement.service.js", () => ({ listEngineerMovements: vi.fn() }));

import * as engineerRepo from "./engineer.repository.js";
import * as jobService from "#modules/job/job.service.js";
import * as engineerTransferService from "#modules/engineer-transfer/engineer-transfer.service.js";
import * as vanStockRequestService from "#modules/van-stock-request/van-stock-request.service.js";
import * as kitRequestService from "#modules/job-kit-request/job-kit-request.service.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as movementService from "#modules/inventory/movement.service.js";
import {
  getOwnActivity,
  getOwnCustomerStock,
  getOwnMiscStock,
  getOwnMovements,
  getOwnOverview,
  getOwnStock,
} from "./engineer.service.js";

const ENG = "a".repeat(24);
const mockBalances = engineerRepo.findBalancesByEngineer as ReturnType<typeof vi.fn>;
const mockTxns = engineerRepo.findRecentTransactions as ReturnType<typeof vi.fn>;
const mockActiveJobs = jobService.listActiveJobsForEngineer as ReturnType<typeof vi.fn>;
const mockListMine = engineerTransferService.listMine as ReturnType<typeof vi.fn>;
const mockAwaitingSig = engineerTransferService.countAwaitingSignature as ReturnType<typeof vi.fn>;
const mockCollectible = vanStockRequestService.countCollectible as ReturnType<typeof vi.fn>;
const mockKitListMine = kitRequestService.listMine as ReturnType<typeof vi.fn>;
const mockCustHoldings = goodsManagementRepo.findCustomerHoldingsByEngineer as ReturnType<typeof vi.fn>;
const mockCustNames = goodsManagementRepo.findCustomerNamesByIds as ReturnType<typeof vi.fn>;
const mockMiscLines = goodsManagementRepo.findMiscIssueLinesByEngineer as ReturnType<typeof vi.fn>;
const mockMovements = movementService.listEngineerMovements as ReturnType<typeof vi.fn>;

const job = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  jobNumber: "JOB-2026-0001",
  name: "Rack build",
  customerName: "Acme",
  completionDate: null,
  priority: "normal",
  status: "assigned",
  ...over,
});

const bal = (over: Record<string, unknown> = {}) => ({
  irmItemId: "i1",
  quantityOnHand: 5,
  updatedAt: new Date("2026-06-01T00:00:00Z"),
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
  mockActiveJobs.mockResolvedValue([]);
  mockListMine.mockResolvedValue({ transfers: [], total: 0, page: 1, pageSize: 1, totalPages: 1 });
  mockAwaitingSig.mockResolvedValue(0);
  mockCollectible.mockResolvedValue(0);
  mockKitListMine.mockResolvedValue({ requests: [], total: 0, page: 1, pageSize: 1, totalPages: 1 });
  mockCustHoldings.mockResolvedValue([]);
  mockMiscLines.mockResolvedValue([]);
});

describe("getOwnStock", () => {
  it("maps held balances to stock items with lastMovedAt (scoped to the engineer)", async () => {
    mockBalances.mockResolvedValue([
      bal(),
      bal({ irmItemId: "i2", quantityOnHand: 3, updatedAt: new Date("2026-06-02T00:00:00Z"), irmItem: { id: "i2", code: "IRM-0002", name: "RJ45", baseUnit: null } }),
    ]);
    const stock = await getOwnStock(ENG);
    expect(mockBalances).toHaveBeenCalledWith(ENG);
    expect(stock).toEqual([
      { irmItemId: "i1", itemCode: "IRM-0001", itemName: "CAT6 Cable", baseUnit: "Box", quantityOnHand: 5, lastMovedAt: "2026-06-01T00:00:00.000Z" },
      { irmItemId: "i2", itemCode: "IRM-0002", itemName: "RJ45", baseUnit: null, quantityOnHand: 3, lastMovedAt: "2026-06-02T00:00:00.000Z" },
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
  it("summarises stock, held customer/misc pools and recent activity, all scoped to the engineer", async () => {
    mockBalances.mockResolvedValue([bal({ quantityOnHand: 5 }), bal({ irmItemId: "i2", quantityOnHand: 3 })]);
    mockTxns.mockResolvedValue([txn()]);
    mockCustHoldings.mockResolvedValue([
      { id: "h1", customerStockEntryId: "e1", customerId: "c1", customerName: "Acme", itemName: "Router", quantityOnHand: 2 },
      { id: "h2", customerStockEntryId: "e2", customerId: "c2", customerName: "Beta", itemName: "Switch", quantityOnHand: 1 },
    ]);
    mockMiscLines.mockResolvedValue([{ itemName: "Cable ties", qty: 4 }]);

    const ov = await getOwnOverview(ENG);
    expect(ov.stock).toEqual({ lines: 2, totalQuantity: 8 });
    expect(ov.customerStock).toEqual({ lines: 2, totalQuantity: 3 });
    expect(ov.misc).toEqual({ lines: 1, totalQuantity: 4 });
    expect(ov.recentActivity).toHaveLength(1);
    expect(mockActiveJobs).toHaveBeenCalledWith(ENG);
  });

  it("returns clean zeros/empties for an engineer with no work", async () => {
    mockBalances.mockResolvedValue([]);
    mockTxns.mockResolvedValue([]);
    const ov = await getOwnOverview(ENG);
    expect(ov).toEqual({
      stock: { lines: 0, totalQuantity: 0 },
      customerStock: { lines: 0, totalQuantity: 0 },
      misc: { lines: 0, totalQuantity: 0 },
      jobs: { toAccept: 0, accepted: 0, inProgress: 0, overdue: 0, dueThisWeek: 0, next: [] },
      transfers: { incomingPending: 0, toSign: 0 },
      vanStock: { toCollect: 0 },
      kitRequests: { pending: 0 },
      recentActivity: [],
    });
  });

  it("summarises the workload: status counts, due maths, 'next' order and the action counts", async () => {
    mockBalances.mockResolvedValue([]);
    mockTxns.mockResolvedValue([]);
    const overdue = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
    // listActiveJobsForEngineer returns ONE flat array of the active set (assigned/accepted/in_progress).
    mockActiveJobs.mockResolvedValue([
      job({ id: "a1", status: "assigned", completionDate: soon }),
      job({ id: "b1", status: "accepted", completionDate: later }),
      job({ id: "c1", status: "in_progress", completionDate: overdue }),
      job({ id: "c2", status: "in_progress", completionDate: null }),
    ]);
    mockListMine.mockResolvedValue({ transfers: [], total: 3, page: 1, pageSize: 1, totalPages: 3 });
    mockAwaitingSig.mockResolvedValue(2);
    mockCollectible.mockResolvedValue(4);
    mockKitListMine.mockResolvedValue({ requests: [], total: 1, page: 1, pageSize: 1, totalPages: 1 });

    const ov = await getOwnOverview(ENG);
    expect(ov.jobs.toAccept).toBe(1);
    expect(ov.jobs.accepted).toBe(1);
    expect(ov.jobs.inProgress).toBe(2);
    expect(ov.jobs.overdue).toBe(1);
    expect(ov.jobs.dueThisWeek).toBe(1);
    // Soonest due first; the undated job sorts last.
    expect(ov.jobs.next.map((j) => j.id)).toEqual(["c1", "a1", "b1", "c2"]);
    expect(ov.transfers).toEqual({ incomingPending: 3, toSign: 2 });
    expect(ov.vanStock).toEqual({ toCollect: 4 });
    expect(ov.kitRequests).toEqual({ pending: 1 });
    // The incoming-transfer count asks for INCOMING + PENDING only, scoped to the engineer.
    expect(mockListMine).toHaveBeenCalledWith(ENG, { role: "incoming", status: "pending", pageSize: 1 });
    expect(mockAwaitingSig).toHaveBeenCalledWith(ENG);
    expect(mockCollectible).toHaveBeenCalledWith(ENG);
  });
});

describe("getOwnMovements", () => {
  it("forwards the AUTHENTICATED engineer id as the scoping arg (never a client-supplied one)", async () => {
    mockMovements.mockResolvedValue({ movements: [], nextCursor: null, hasMore: false });
    // A client could try to smuggle another engineer's id into the filters — the scoping arg is always
    // the authenticated ENG passed positionally, and listEngineerMovements overrides the filter anyway.
    const filters = { engineerId: "b".repeat(24) } as never;
    await getOwnMovements(ENG, filters, null, 20);
    expect(mockMovements).toHaveBeenCalledWith(ENG, filters, null, 20);
    expect(mockMovements.mock.calls[0][0]).toBe(ENG);
  });
});

describe("getOwnCustomerStock", () => {
  it("backfills the customer name for legacy holdings whose snapshot is null (resolved by id)", async () => {
    mockCustHoldings.mockResolvedValue([
      { id: "h1", customerStockEntryId: "e1", customerId: "c1", customerName: null, itemName: "Router", quantityOnHand: 2 },
      { id: "h2", customerStockEntryId: "e2", customerId: "c2", customerName: "Beta Ltd", itemName: "Switch", quantityOnHand: 1 },
    ]);
    mockCustNames.mockResolvedValue([{ id: "c1", name: "Acme Ltd" }]);

    const out = await getOwnCustomerStock(ENG);
    expect(mockCustHoldings).toHaveBeenCalledWith(ENG);
    // Only the holding with a missing snapshot triggers a name lookup.
    expect(mockCustNames).toHaveBeenCalledWith(["c1"]);
    expect(out[0].customerName).toBe("Acme Ltd"); // backfilled
    expect(out[1].customerName).toBe("Beta Ltd"); // snapshot kept
  });

  it("does not look up names when every holding already has its snapshot", async () => {
    mockCustHoldings.mockResolvedValue([
      { id: "h1", customerStockEntryId: "e1", customerId: "c1", customerName: "Acme Ltd", itemName: "Router", quantityOnHand: 2 },
    ]);
    await getOwnCustomerStock(ENG);
    expect(mockCustNames).not.toHaveBeenCalled();
  });
});

describe("getOwnMiscStock", () => {
  it("sums misc issue lines by item name (scoped to the engineer)", async () => {
    mockMiscLines.mockResolvedValue([
      { itemName: "Cable ties", qty: 2 },
      { itemName: "Cable ties", qty: 3 },
      { itemName: "Labels", qty: 1 },
    ]);
    const out = await getOwnMiscStock(ENG);
    expect(mockMiscLines).toHaveBeenCalledWith(ENG);
    expect(out).toEqual([
      { itemName: "Cable ties", quantityOnHand: 5 },
      { itemName: "Labels", quantityOnHand: 1 },
    ]);
  });
});
