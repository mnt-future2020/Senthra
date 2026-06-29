import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("../../lib/realtime.js", () => ({ emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "jobs:office" }));
vi.mock("./goods-management.repository.js", () => ({
  createMovementWithCode: vi.fn(), findMovementsByJob: vi.fn(), findMovementsByJobs: vi.fn(), getSummary: vi.fn(), getSummariesByJobs: vi.fn(), upsertSummaryTx: vi.fn(),
  upsertCustomerHoldingTx: vi.fn(), findCustomerHoldingTx: vi.fn(), insertCustomerHoldingTxnTx: vi.fn(), findCustomerHoldingsByEngineer: vi.fn(),
  adjustCustomerStockEntryQtyTx: vi.fn(), findCustomerStockEntryById: vi.fn(), findCustomerStockEntriesByIds: vi.fn(), findCustomerStockEntryByBarcode: vi.fn(),
  upsertDamagedBalanceTx: vi.fn(), insertDamagedTxnTx: vi.fn(), findDamagedByWarehouse: vi.fn(), findDamagedByCustomer: vi.fn(), findAllDamaged: vi.fn(), findRecentMovementsForOverdue: vi.fn(), findCustomerHolding: vi.fn(),
  findLatestDamagedTxnsByBalances: vi.fn(),
}));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn(), findActiveForGoodsManagement: vi.fn(), findActiveWithKitLines: vi.fn(), completeIfInProgressTx: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn(), findActiveByCodeOrBarcode: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancePair: vi.fn(), findBalancesByItemsAndWarehouses: vi.fn(), findBalancePairTx: vi.fn(), upsertBalanceTx: vi.fn(), insertTransactionTx: vi.fn() }));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyOutbound: vi.fn(), applyInbound: vi.fn() }));
vi.mock("#modules/goods-out/goods-out.repository.js", () => ({ upsertEngineerBalanceTx: vi.fn(), insertEngineerTxnTx: vi.fn(), findEngineerBalanceTx: vi.fn(), findEngineerBalance: vi.fn(), findEngineerBalances: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as repo from "./goods-management.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import { scanLookup } from "./goods-management.service.js";

const JOB_ID = "a".repeat(24), IRM_ID = "d".repeat(24), WH_ID = "b".repeat(24), CSE_ID = "f".repeat(24);
const mockJob = jobRepo.findById as ReturnType<typeof vi.fn>;
const mockIrm = irmService.findActiveByCodeOrBarcode as ReturnType<typeof vi.fn>;
const mockBal = inventoryRepo.findBalancePair as ReturnType<typeof vi.fn>;
const mockMoves = repo.findMovementsByJob as ReturnType<typeof vi.fn>;
const mockCseByBarcode = repo.findCustomerStockEntryByBarcode as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockJob.mockResolvedValue({ id: JOB_ID, status: "accepted", assignedEngineerId: "c".repeat(24),
    kitLines: [{ id: "k1", lineType: "irm", irmItemId: IRM_ID, warehouseId: WH_ID, itemName: "CAT6", qty: 10 }] });
  mockIrm.mockResolvedValue({ id: IRM_ID, code: "IRM-0004", name: "CAT6", baseUnit: "Box", barcode: "5012345678900", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false });
  mockBal.mockResolvedValue({ quantityOnHand: 4, quantityReserved: 0 });
  mockMoves.mockResolvedValue([]);
  // Default: no customer stock entry found (IRM path is primary)
  mockCseByBarcode.mockResolvedValue(null);
});

describe("scanLookup (issue)", () => {
  it("resolves an IRM code to its kit line and reports remaining + available", async () => {
    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "IRM-0004" });
    expect(m).toMatchObject({ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", plannedQty: 10, alreadyIssued: 0, remainingIssuable: 10, available: 4 });
  });
  it("rejects a code that isn't on the kit list", async () => {
    mockIrm.mockResolvedValue({ id: "e".repeat(24), code: "IRM-9999", name: "Other", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false });
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "IRM-9999" })).rejects.toThrow(/not on this job/i);
  });
  it("rejects an item whose pickup warehouse isn't the warehouse being managed", async () => {
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: "e".repeat(24), code: "IRM-0004" })).rejects.toThrow(/different warehouse/i);
  });
  it("rejects a serial-tracked item", async () => {
    mockIrm.mockResolvedValue({ id: IRM_ID, code: "IRM-0004", name: "SFP", trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: false });
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "IRM-0004" })).rejects.toThrow(/serial|batch/i);
  });

  // Customer stock path — IRM lookup returns null, falls through to barcode lookup.
  describe("customer stock path", () => {
    beforeEach(() => {
      // No IRM item matches — force the customer-stock branch.
      mockIrm.mockResolvedValue(null);
      // Job has a customer-stock kit line referencing CSE_ID.
      mockJob.mockResolvedValue({
        id: JOB_ID, status: "accepted", assignedEngineerId: "c".repeat(24),
        kitLines: [{ id: "k2", lineType: "customer_stock", customerStockEntryId: CSE_ID, warehouseId: WH_ID, itemName: "SFP-LX", qty: 5 }],
      });
      // Repository returns a matching customer stock entry.
      mockCseByBarcode.mockResolvedValue({ id: CSE_ID, itemName: "SFP-LX", uom: "Each", warehouseId: WH_ID, quantity: 3, status: "active" });
    });

    it("resolves a customer-stock barcode to its kit line and reports remaining + available", async () => {
      const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "CSE-00001" });
      expect(m).toMatchObject({
        source: "customer",
        customerStockEntryId: CSE_ID,
        jobKitLineId: "k2",
        itemName: "SFP-LX",
        plannedQty: 5,
        alreadyIssued: 0,
        remainingIssuable: 5,
        available: 3,
      });
    });

    it("rejects a customer barcode whose entry is not on the job kit list", async () => {
      // Entry exists but job has no kit line for it.
      mockJob.mockResolvedValue({
        id: JOB_ID, status: "accepted", assignedEngineerId: "c".repeat(24),
        kitLines: [], // no lines at all
      });
      await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "CSE-00001" })).rejects.toThrow(/not on this job/i);
    });

    it("rejects a code that matches neither IRM nor customer stock", async () => {
      mockCseByBarcode.mockResolvedValue(null);
      await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "UNKNOWN-XYZ" })).rejects.toThrow(/no item matches/i);
    });
  });
});

describe("scanLookup (return cap = this warehouse's still-out qty, bounded by holding)", () => {
  // The return cap = what's still out FROM THIS warehouse's kit line (issued − used − returned),
  // bounded by the engineer's REAL global holding. Per-warehouse, so an item issued from two
  // warehouses can't be fully returned at one. Global bound also covers the cross-job drained case.
  const mockEngBal = goodsOutRepo.findEngineerBalance as ReturnType<typeof vi.fn>;
  const issue = (klId: string, qty: number) => ({ status: "posted", direction: "issue", items: [{ jobKitLineId: klId, qty }] });

  it("caps at this warehouse's out qty, not the (higher) global holding", async () => {
    mockMoves.mockResolvedValue([issue("k1", 5)]); // 5 issued from this warehouse's line
    mockEngBal.mockResolvedValue({ quantityOnHand: 8 }); // engineer holds 8 globally (also at another WH)
    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "IRM-0004" });
    expect(m).toMatchObject({ source: "irm", jobKitLineId: "k1", heldByEngineer: 5 }); // 5, not 8
  });

  it("is bounded by the real global holding (cross-job drained)", async () => {
    mockMoves.mockResolvedValue([issue("k1", 5)]);
    mockEngBal.mockResolvedValue({ quantityOnHand: 2 }); // only 2 left globally
    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "IRM-0004" });
    expect(m.heldByEngineer).toBe(2); // min(5, 2)
  });

  it("subtracts used + already-returned from the line's outstanding", async () => {
    mockMoves.mockResolvedValue([
      issue("k1", 5),
      { status: "posted", direction: "consume", items: [{ jobKitLineId: "k1", qty: 2 }] },
      { status: "posted", direction: "return", items: [{ jobKitLineId: "k1", qty: 1 }] },
    ]);
    mockEngBal.mockResolvedValue({ quantityOnHand: 10 });
    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "IRM-0004" });
    expect(m.heldByEngineer).toBe(2); // 5 − 2 − 1
  });

  it("reports 0 when nothing is out from this warehouse", async () => {
    mockMoves.mockResolvedValue([]); // nothing issued here
    mockEngBal.mockResolvedValue({ quantityOnHand: 8 });
    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "IRM-0004" });
    expect(m.heldByEngineer).toBe(0); // min(0, 8)
  });
});

import { listQueue, postIssue } from "./goods-management.service.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as goodsOutRepo from "#modules/goods-out/goods-out.repository.js";

const ENG_ID = "c".repeat(24);
const mockCreateMovement = repo.createMovementWithCode as ReturnType<typeof vi.fn>;
const mockApplyOutbound = inventoryService.applyOutbound as ReturnType<typeof vi.fn>;
const mockUpsertEng = goodsOutRepo.upsertEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockBalTx = inventoryRepo.findBalancePairTx as ReturnType<typeof vi.fn>;

describe("postIssue", () => {
  beforeEach(() => {
    mockBalTx.mockResolvedValue({ quantityOnHand: 100, quantityReserved: 0 });
    mockUpsertEng.mockResolvedValue({ quantityOnHand: 10 });
    // createMovementWithCode runs the apply() callback with a fake tx + ids, then returns a row.
    mockCreateMovement.mockImplementation(async (_h: unknown, _l: unknown, apply: (tx: unknown, id: string, code: string) => Promise<void>) => {
      await apply({}, "m1", "GM-0001");
      return { id: "m1", code: "GM-0001", direction: "issue", warehouseId: WH_ID, items: [], job: { id: JOB_ID } };
    });
  });

  it("decrements the warehouse and increments the engineer holding for an IRM issue", async () => {
    void ENG_ID;
    const mockRequireIrm = irmService.requireActiveIrmItem as ReturnType<typeof vi.fn>;
    mockRequireIrm.mockResolvedValue({ id: IRM_ID, code: "IRM-0004", name: "CAT6", baseUnit: "Box", trackSerialNumbers: false, trackBatchNumbers: false });
    await postIssue(JOB_ID, { direction: "issue", warehouseId: WH_ID, lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 10, scannedCode: "IRM-0004" }] }, { email: "wm@x.com" } as never);
    expect(mockApplyOutbound).toHaveBeenCalledTimes(1);
    expect(mockApplyOutbound.mock.calls[0][1]).toMatchObject({ irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 10, sourceType: "goods_management", sourceCode: "GM-0001" });
    expect(mockUpsertEng).toHaveBeenCalledWith({}, IRM_ID, ENG_ID, 10);
  });

  it("rejects issuing more than the kit-line remaining", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 6 }] }]);
    await expect(postIssue(JOB_ID, { direction: "issue", warehouseId: WH_ID, lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 6, scannedCode: "IRM-0004" }] }, { email: "wm@x.com" } as never)).rejects.toThrow(/remaining|kit/i);
    expect(mockCreateMovement).not.toHaveBeenCalled();
  });
});

describe("listQueue", () => {
  const mockFindActive = jobRepo.findActiveForGoodsManagement as ReturnType<typeof vi.fn>;
  const mockSummaries = repo.getSummariesByJobs as ReturnType<typeof vi.fn>;
  const mockMovesBatch = repo.findMovementsByJobs as ReturnType<typeof vi.fn>;
  const mockBalances = inventoryRepo.findBalancesByItemsAndWarehouses as ReturnType<typeof vi.fn>;
  const mockCseByIds = repo.findCustomerStockEntriesByIds as ReturnType<typeof vi.fn>;
  const mockEngBalances = goodsOutRepo.findEngineerBalances as ReturnType<typeof vi.fn>;
  const mockCustHoldings = repo.findCustomerHoldingsByEngineer as ReturnType<typeof vi.fn>;

  const A1 = "a1".padEnd(24, "0");
  const A2 = "a2".padEnd(24, "0");
  const job = (id: string, num: string) => ({
    id, jobNumber: num, name: "Test Job", customerId: "x".repeat(24), customerName: "Acme",
    assignedEngineerId: ENG_ID, assignedEngineerName: "Bob", status: "accepted",
    kitLines: [{ id: `${id}-k1`, lineType: "irm", irmItemId: IRM_ID, warehouseId: WH_ID, itemName: "CAT6", qty: 10, warehouseName: "WH1", warehouseCode: "W1", customerStockEntryId: null }],
  });

  beforeEach(() => {
    mockSummaries.mockResolvedValue([]);
    mockMovesBatch.mockResolvedValue([]);
    mockBalances.mockResolvedValue([]);
    mockCseByIds.mockResolvedValue([]);
    mockEngBalances.mockResolvedValue([]);
    mockCustHoldings.mockResolvedValue([]);
  });

  it("reports planned/issued/available from batched movements + balances and returns a page", async () => {
    mockFindActive.mockResolvedValue([job(JOB_ID, "JOB-2026-0001")]);
    mockMovesBatch.mockResolvedValue([{ jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 6 }] }]);
    mockBalances.mockResolvedValue([{ irmItemId: IRM_ID, warehouseId: WH_ID, quantityOnHand: 4, quantityReserved: 0 }]);

    const res = await listQueue({ warehouseId: WH_ID });
    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(res.rows[0].kitLines[0]).toMatchObject({ plannedQty: 10, issuedQty: 6, usedQty: 0, returnedQty: 0, available: 4 });
  });

  it("reports the engineer's REAL held balance per line (the cap for what can be returned)", async () => {
    mockFindActive.mockResolvedValue([job(JOB_ID, "JOB-1")]);
    mockEngBalances.mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 3 }]);
    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.rows[0].kitLines[0].engineerHeld).toBe(3);
  });

  it("splits a line into GROSS issued / used / returned for the lifecycle status", async () => {
    mockFindActive.mockResolvedValue([job(JOB_ID, "JOB-2026-0001")]);
    // 6 issued, 4 consumed on site, 1 returned → issuedQty stays 6 (gross), used 4, returned 1.
    mockMovesBatch.mockResolvedValue([
      { jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 6 }] },
      { jobId: JOB_ID, status: "posted", direction: "consume", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 4 }] },
      { jobId: JOB_ID, status: "posted", direction: "return", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 1 }] },
    ]);
    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.rows[0].kitLines[0]).toMatchObject({ issuedQty: 6, usedQty: 4, returnedQty: 1 });
  });

  it("excludes reconciled jobs from the default active view", async () => {
    mockFindActive.mockResolvedValue([job(A1, "JOB-1"), job(A2, "JOB-2")]);
    mockSummaries.mockResolvedValue([{ jobId: A1, goodsStatus: "issued" }, { jobId: A2, goodsStatus: "reconciled" }]);
    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.total).toBe(1);
    expect(res.rows[0].jobNumber).toBe("JOB-1");
  });

  it("returns ONLY reconciled jobs for the closed view (status=reconciled)", async () => {
    mockFindActive.mockResolvedValue([job(A1, "JOB-1"), job(A2, "JOB-2")]);
    mockSummaries.mockResolvedValue([{ jobId: A1, goodsStatus: "issued" }, { jobId: A2, goodsStatus: "reconciled" }]);
    const res = await listQueue({ warehouseId: WH_ID, status: "reconciled" });
    expect(res.total).toBe(1);
    expect(res.rows[0]).toMatchObject({ jobNumber: "JOB-2", goodsStatus: "reconciled" });
  });

  it("paginates (page 2 of pageSize 1)", async () => {
    mockFindActive.mockResolvedValue([job(A1, "JOB-1"), job(A2, "JOB-2")]);
    const res = await listQueue({ warehouseId: WH_ID, page: 2, pageSize: 1 });
    expect(res).toMatchObject({ total: 2, totalPages: 2, page: 2 });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].jobNumber).toBe("JOB-2");
  });

  it("trims + forwards the search term to the DB query", async () => {
    mockFindActive.mockResolvedValue([]);
    await listQueue({ warehouseId: WH_ID, search: "  CAT6  " });
    expect(mockFindActive).toHaveBeenCalledWith(WH_ID, "CAT6");
  });

  it("rejects an invalid status filter", async () => {
    await expect(listQueue({ warehouseId: WH_ID, status: "bogus" })).rejects.toThrow(/invalid status/i);
  });
});

// ── shared mock aliases (used by both postReturn and recordConsumeAndComplete) ────────────────
const mockFindCustHoldingTx = repo.findCustomerHoldingTx as ReturnType<typeof vi.fn>;
const mockUpsertCustHoldingTx = repo.upsertCustomerHoldingTx as ReturnType<typeof vi.fn>;
const mockInsertCustHoldingTxnTx = repo.insertCustomerHoldingTxnTx as ReturnType<typeof vi.fn>;
const mockUpsertSummaryTx = repo.upsertSummaryTx as ReturnType<typeof vi.fn>;

// ── postReturn ───────────────────────────────────────────────────────────────────────────────
import { postReturn } from "./goods-management.service.js";

const mockApplyInbound = inventoryService.applyInbound as ReturnType<typeof vi.fn>;
const mockUpsertDamagedBalance = repo.upsertDamagedBalanceTx as ReturnType<typeof vi.fn>;
const mockInsertDamagedTxn = repo.insertDamagedTxnTx as ReturnType<typeof vi.fn>;
const mockFindEngBalTxForReturn = goodsOutRepo.findEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockUpsertEngForReturn = goodsOutRepo.upsertEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockAdjustCseQty = repo.adjustCustomerStockEntryQtyTx as ReturnType<typeof vi.fn>;

// Base job with kit lines covering both IRM and customer scenarios.
const returnBaseJob = {
  id: JOB_ID,
  status: "in_progress",
  assignedEngineerId: ENG_ID,
  assignedEngineerName: "Bob Smith",
  assignedEngineerEmail: "bob@x.com",
  kitLines: [
    { id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", qty: 10, warehouseName: "WH1", warehouseCode: "W1" },
    { id: "k2", lineType: "customer_stock", irmItemId: null, customerStockEntryId: CSE_ID, warehouseId: WH_ID, itemName: "SFP-LX", qty: 5, warehouseName: "WH1", warehouseCode: "W1" },
  ],
};

describe("postReturn", () => {
  beforeEach(() => {
    mockJob.mockResolvedValue({ ...returnBaseJob });
    // Both kit lines issued plenty, so the per-warehouse return cap passes by default.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 10 }, { jobKitLineId: "k2", qty: 10 }] },
    ]);
    // createMovementWithCode invokes the apply callback synchronously.
    mockCreateMovement.mockImplementation(async (_h: unknown, _l: unknown, apply: (tx: unknown, id: string, code: string) => Promise<void>) => {
      await apply({}, "m3", "GM-0003");
      return { id: "m3", code: "GM-0003", direction: "return", warehouseId: WH_ID, items: [], job: { id: JOB_ID } };
    });
    // Default: engineer holds 8 of the IRM item.
    mockFindEngBalTxForReturn.mockResolvedValue({ quantityOnHand: 8 });
    mockUpsertEngForReturn.mockResolvedValue({ quantityOnHand: 3 });
    // Customer stock holding: engineer holds 4.
    mockFindCustHoldingTx.mockResolvedValue({ quantityOnHand: 4, customerId: "cust1", itemName: "SFP-LX" });
    mockUpsertCustHoldingTx.mockResolvedValue({ quantityOnHand: 2 });
    mockAdjustCseQty.mockResolvedValue({ id: CSE_ID, itemName: "SFP-LX", quantity: 6, customerId: "cust1", uom: "Each", warehouseId: WH_ID });
    mockApplyInbound.mockResolvedValue(undefined);
    mockUpsertDamagedBalance.mockResolvedValue({ id: "dmg1", quantity: 1 });
    mockInsertDamagedTxn.mockResolvedValue({});
    mockUpsertSummaryTx.mockResolvedValue({});
  });

  it("good IRM return: calls applyInbound and drains the engineer holding", async () => {
    await postReturn(
      JOB_ID,
      {
        direction: "return", warehouseId: WH_ID,
        lines: [{ source: "irm", irmItemId: IRM_ID, qty: 3, condition: "good", scannedCode: "IRM-0004", jobKitLineId: "k1" }],
      },
      { email: "wm@x.com" } as never,
    );
    // Engineer balance pre-check + drain.
    expect(mockFindEngBalTxForReturn).toHaveBeenCalledWith({}, IRM_ID, ENG_ID);
    expect(mockUpsertEngForReturn).toHaveBeenCalledWith({}, IRM_ID, ENG_ID, -3);
    // Warehouse credited back via applyInbound.
    expect(mockApplyInbound).toHaveBeenCalledTimes(1);
    expect(mockApplyInbound.mock.calls[0][1]).toMatchObject({
      irmItemId: IRM_ID,
      warehouseId: WH_ID,
      quantity: 3,
      sourceType: "goods_management",
      sourceCode: "GM-0003",
    });
    // Damaged pool NOT touched.
    expect(mockUpsertDamagedBalance).not.toHaveBeenCalled();
  });

  it("damaged customer return: credits damaged pool (with photo + reason) and does NOT credit the customer stock pool", async () => {
    await postReturn(
      JOB_ID,
      {
        direction: "return", warehouseId: WH_ID,
        lines: [{
          source: "customer",
          customerStockEntryId: CSE_ID,
          qty: 2,
          condition: "damaged",
          damagePhotoUrl: "https://cdn.example.com/photo.jpg",
          damageReason: "Cracked housing",
          jobKitLineId: "k2",
        }],
      },
      { email: "wm@x.com" } as never,
    );
    // Engineer customer holding drained.
    expect(mockFindCustHoldingTx).toHaveBeenCalledWith({}, CSE_ID, ENG_ID);
    expect(mockUpsertCustHoldingTx).toHaveBeenCalledWith({}, CSE_ID, ENG_ID, -2, expect.objectContaining({ customerId: "cust1" }));
    // Damaged pool credited.
    expect(mockUpsertDamagedBalance).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ownerType: "customer", customerStockEntryId: CSE_ID }),
      2,
    );
    expect(mockInsertDamagedTxn).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        ownerType: "customer",
        photoUrl: "https://cdn.example.com/photo.jpg",
        reason: "Cracked housing",
        sourceType: "goods_management_return",
      }),
    );
    // Customer stock entry qty NOT credited back (damaged stock stays out).
    expect(mockAdjustCseQty).not.toHaveBeenCalled();
    // Warehouse also NOT credited (applyInbound not called).
    expect(mockApplyInbound).not.toHaveBeenCalled();
  });

  it("rejects returning more than THIS warehouse's kit line has out (multi-warehouse over-credit)", async () => {
    // Only 5 issued from this warehouse's line; engineer holds 8 globally (3 are out at another WH).
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 5 }] }]);
    mockFindEngBalTxForReturn.mockResolvedValue({ quantityOnHand: 8 });
    await expect(
      postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [{ source: "irm", irmItemId: IRM_ID, qty: 6, condition: "good", jobKitLineId: "k1" }] }, { email: "wm@x.com" } as never),
    ).rejects.toThrow(/can be returned at this warehouse/i);
    expect(mockApplyInbound).not.toHaveBeenCalled(); // no over-credit
  });

  it("allows returning exactly this warehouse's out qty even when global holding is higher", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 5 }] }]);
    mockFindEngBalTxForReturn.mockResolvedValue({ quantityOnHand: 8 });
    await postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [{ source: "irm", irmItemId: IRM_ID, qty: 5, condition: "good", jobKitLineId: "k1" }] }, { email: "wm@x.com" } as never);
    expect(mockApplyInbound).toHaveBeenCalledTimes(1);
    expect(mockApplyInbound.mock.calls[0][1]).toMatchObject({ warehouseId: WH_ID, quantity: 5 });
  });

  it("rejects returning more IRM than the engineer holds", async () => {
    // Engineer only holds 2, but 5 are requested.
    mockFindEngBalTxForReturn.mockResolvedValue({ quantityOnHand: 2 });
    await expect(
      postReturn(
        JOB_ID,
        {
          direction: "return", warehouseId: WH_ID,
          lines: [{ source: "irm", irmItemId: IRM_ID, qty: 5, condition: "good", jobKitLineId: "k1" }],
        },
        { email: "wm@x.com" } as never,
      ),
    ).rejects.toThrow(/doesn't hold|held/i);
    expect(mockUpsertEngForReturn).not.toHaveBeenCalled();
    expect(mockApplyInbound).not.toHaveBeenCalled();
  });
});

// ── recordConsumeAndComplete ──────────────────────────────────────────────────────────────────
import { recordConsumeAndComplete } from "./goods-management.service.js";

const mockCompleteIfInProgress = jobRepo.completeIfInProgressTx as ReturnType<typeof vi.fn>;
const mockFindEngBalTx = goodsOutRepo.findEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockUpsertEngBalTx = goodsOutRepo.upsertEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockInsertEngTxnTx = goodsOutRepo.insertEngineerTxnTx as ReturnType<typeof vi.fn>;
// Non-tx batch holdings used by closeReconcile / getJobKitTallies to cap "unaccounted" / "remaining"
// at the engineer's REAL held balance.
const mockFindEngBalancesAll = goodsOutRepo.findEngineerBalances as ReturnType<typeof vi.fn>;
const mockFindCustHoldingsAll = repo.findCustomerHoldingsByEngineer as ReturnType<typeof vi.fn>;

// A minimal JobWithRelations shape sufficient for recordConsumeAndComplete.
const baseJobForConsume = {
  id: JOB_ID,
  jobNumber: "JOB-2026-0001",
  status: "in_progress",
  assignedEngineerId: ENG_ID,
  assignedEngineerName: "Bob Smith",
  assignedEngineerEmail: "bob@x.com",
  kitLines: [
    { id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", qty: 10 },
    { id: "k2", lineType: "customer_stock", irmItemId: null, customerStockEntryId: CSE_ID, warehouseId: WH_ID, itemName: "SFP-LX", qty: 5 },
  ],
} as never;

describe("recordConsumeAndComplete", () => {
  beforeEach(() => {
    // createMovementWithCode invokes the apply callback synchronously in the fake tx.
    mockCreateMovement.mockImplementation(async (_h: unknown, _l: unknown, apply: (tx: unknown, id: string, code: string) => Promise<void>) => {
      await apply({}, "m2", "GM-0002");
      return { id: "m2", code: "GM-0002", direction: "consume", items: [], job: { id: JOB_ID } };
    });
    // Default: engineer holds 8 of the IRM item.
    mockFindEngBalTx.mockResolvedValue({ quantityOnHand: 8 });
    // Drain returns updated balance.
    mockUpsertEngBalTx.mockResolvedValue({ quantityOnHand: 3 });
    mockInsertEngTxnTx.mockResolvedValue({});
    // Default: engineer holds 4 of the customer stock item.
    mockFindCustHoldingTx.mockResolvedValue({ quantityOnHand: 4, customerId: "cust1", itemName: "SFP-LX" });
    mockUpsertCustHoldingTx.mockResolvedValue({ quantityOnHand: 2 });
    mockInsertCustHoldingTxnTx.mockResolvedValue({});
    // Job stamp succeeds.
    mockCompleteIfInProgress.mockResolvedValue({ count: 1 });
    mockUpsertSummaryTx.mockResolvedValue({});
  });

  it("drains engineer IRM holding and writes a job_consume ledger row", async () => {
    await recordConsumeAndComplete(
      baseJobForConsume,
      ENG_ID,
      "All done",
      [{ source: "irm", irmItemId: IRM_ID, qty: 5 }],
      "eng@x.com",
    );
    // Engineer balance reader was called inside the tx.
    expect(mockFindEngBalTx).toHaveBeenCalledWith({}, IRM_ID, ENG_ID);
    // Balance was decremented by 5.
    expect(mockUpsertEngBalTx).toHaveBeenCalledWith({}, IRM_ID, ENG_ID, -5);
    // Ledger row was written with type "job_consume".
    expect(mockInsertEngTxnTx).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ irmItemId: IRM_ID, quantityDelta: -5, type: "job_consume" }),
    );
  });

  it("files 'used' against the EXACT kit line by jobKitLineId (same item on two warehouses)", async () => {
    // Same IRM item on two kit lines (two warehouses). The used must land on k3 (what the engineer
    // declared), not k1 (the first item-id match) — otherwise the per-line tallies/status go wrong.
    const job = {
      id: JOB_ID, jobNumber: "JOB-2026-0001", status: "in_progress",
      assignedEngineerId: ENG_ID, assignedEngineerName: "Bob Smith", assignedEngineerEmail: "bob@x.com",
      kitLines: [
        { id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", qty: 1 },
        { id: "k3", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: "e".repeat(24), itemName: "CAT6", qty: 1 },
      ],
    } as never;
    await recordConsumeAndComplete(job, ENG_ID, null, [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k3", qty: 1 }], "eng@x.com");
    const movementLines = mockCreateMovement.mock.calls[0][1] as Array<{ jobKitLineId: string | null }>;
    expect(movementLines).toHaveLength(1);
    expect(movementLines[0].jobKitLineId).toBe("k3");
  });

  it("transitions job in_progress → completed and sets goodsStatus = awaiting_return (stock still held)", async () => {
    // Issued 10 (k1) + 5 (k2); engineer used only 3 → still holding stock → awaiting_return.
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 10 }, { jobKitLineId: "k2", qty: 5 }] }]);
    await recordConsumeAndComplete(
      baseJobForConsume,
      ENG_ID,
      "Work summary text",
      [{ source: "irm", irmItemId: IRM_ID, qty: 3 }],
      "eng@x.com",
    );
    // Job stamped completed.
    expect(mockCompleteIfInProgress).toHaveBeenCalledWith({}, JOB_ID, ENG_ID);
    // Summary upserted with goodsStatus = awaiting_return.
    expect(mockUpsertSummaryTx).toHaveBeenCalledWith(
      {},
      JOB_ID,
      expect.objectContaining({ goodsStatus: "awaiting_return", workSummary: "Work summary text" }),
    );
  });

  it("auto-reconciles when the engineer used EVERYTHING (nothing left to return)", async () => {
    // Issued 10 (k1) + 5 (k2), engineer used all of it → 0 outstanding → reconciled, no manual close.
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 10 }, { jobKitLineId: "k2", qty: 5 }] }]);
    mockFindEngBalTx.mockResolvedValue({ quantityOnHand: 10 });
    mockFindCustHoldingTx.mockResolvedValue({ quantityOnHand: 5, customerId: "cust1", itemName: "SFP-LX" });
    await recordConsumeAndComplete(
      baseJobForConsume, ENG_ID, "Used all",
      [{ source: "irm", irmItemId: IRM_ID, qty: 10 }, { source: "customer", customerStockEntryId: CSE_ID, qty: 5 }],
      "eng@x.com",
    );
    expect(mockUpsertSummaryTx).toHaveBeenCalledWith({}, JOB_ID, expect.objectContaining({ goodsStatus: "reconciled" }));
  });

  it("rejects a 'used' item that isn't on the job's kit list (off-job drain guard)", async () => {
    const FOREIGN = "f".repeat(24);
    await expect(
      recordConsumeAndComplete(baseJobForConsume, ENG_ID, null, [{ source: "irm", irmItemId: FOREIGN, qty: 1 }], "eng@x.com"),
    ).rejects.toThrow(/isn't on this job's kit list/i);
    expect(mockUpsertEngBalTx).not.toHaveBeenCalled();
  });

  it("rejects a 'used' line whose jobKitLineId no longer matches a kit line (edited)", async () => {
    await expect(
      recordConsumeAndComplete(baseJobForConsume, ENG_ID, null, [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "kGONE", qty: 1 }], "eng@x.com"),
    ).rejects.toThrow(/isn't on this job's kit list/i);
  });

  it("drains engineer customer-stock holding and writes a job_consume ledger row", async () => {
    await recordConsumeAndComplete(
      baseJobForConsume,
      ENG_ID,
      null,
      [{ source: "customer", customerStockEntryId: CSE_ID, qty: 2 }],
      "eng@x.com",
    );
    // Customer holding reader was called.
    expect(mockFindCustHoldingTx).toHaveBeenCalledWith({}, CSE_ID, ENG_ID);
    // Customer holding was decremented by 2.
    expect(mockUpsertCustHoldingTx).toHaveBeenCalledWith(
      {},
      CSE_ID,
      ENG_ID,
      -2,
      expect.objectContaining({ customerId: "cust1", itemName: "SFP-LX" }),
    );
    // Ledger row written with type "job_consume".
    expect(mockInsertCustHoldingTxnTx).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ customerStockEntryId: CSE_ID, quantityDelta: -2, type: "job_consume" }),
    );
  });

  it("rejects an IRM used qty greater than the engineer's held amount", async () => {
    // Engineer only holds 3, but 10 are requested.
    mockFindEngBalTx.mockResolvedValue({ quantityOnHand: 3 });
    await expect(
      recordConsumeAndComplete(
        baseJobForConsume,
        ENG_ID,
        null,
        [{ source: "irm", irmItemId: IRM_ID, qty: 10 }],
        "eng@x.com",
      ),
    ).rejects.toThrow(/doesn't hold|held/i);
    // Balance must not have been drained.
    expect(mockUpsertEngBalTx).not.toHaveBeenCalled();
  });

  it("rejects a customer used qty greater than the engineer's held amount", async () => {
    // Engineer only holds 1, but 5 are requested.
    mockFindCustHoldingTx.mockResolvedValue({ quantityOnHand: 1, customerId: "cust1", itemName: "SFP-LX" });
    await expect(
      recordConsumeAndComplete(
        baseJobForConsume,
        ENG_ID,
        null,
        [{ source: "customer", customerStockEntryId: CSE_ID, qty: 5 }],
        "eng@x.com",
      ),
    ).rejects.toThrow(/doesn't hold|held/i);
    expect(mockUpsertCustHoldingTx).not.toHaveBeenCalled();
  });

  it("rejects completion when the job stamp guard fails (concurrent race)", async () => {
    mockCompleteIfInProgress.mockResolvedValue({ count: 0 });
    await expect(
      recordConsumeAndComplete(
        baseJobForConsume,
        ENG_ID,
        null,
        [{ source: "irm", irmItemId: IRM_ID, qty: 2 }],
        "eng@x.com",
      ),
    ).rejects.toThrow(/can't be completed|refresh/i);
  });

  it("skips zero-qty used lines without touching balances", async () => {
    const completedSpy = mockCompleteIfInProgress;
    await recordConsumeAndComplete(
      baseJobForConsume,
      ENG_ID,
      null,
      [{ source: "irm", irmItemId: IRM_ID, qty: 0 }],
      "eng@x.com",
    );
    // No balance reads/writes for the zero-qty line.
    expect(mockFindEngBalTx).not.toHaveBeenCalled();
    expect(mockUpsertEngBalTx).not.toHaveBeenCalled();
    // But job still gets stamped and summary upserted.
    expect(completedSpy).toHaveBeenCalledTimes(1);
    expect(mockUpsertSummaryTx).toHaveBeenCalledTimes(1);
  });
});

// ── closeReconcile ───────────────────────────────────────────────────────────────────────────
import { closeReconcile } from "./goods-management.service.js";

const RECONCILE_JOB_ID = "a".repeat(24);

// Helper to build a posted movement stub with given direction + items.
// itemName is included so that the primary itemName path in computeTallies() is exercised
// (without it computeTallies falls back to the kit-line snapshot name, which is valid but untested).
function makeMovement(direction: string, items: { jobKitLineId: string; irmItemId: string | null; customerStockEntryId: string | null; qty: number; condition?: string; source?: string }[]) {
  return {
    status: "posted",
    direction,
    items: items.map((i) => ({
      ...i,
      itemName: "CAT6",
      source: i.source ?? (i.irmItemId ? "irm" : "customer"),
      condition: i.condition ?? "good",
    })),
  };
}

describe("closeReconcile", () => {
  // Common mocks reset per-test.
  beforeEach(() => {
    // A job in awaiting_return status, single IRM kit line.
    mockJob.mockResolvedValue({
      id: RECONCILE_JOB_ID,
      status: "completed",
      assignedEngineerId: ENG_ID,
      assignedEngineerName: "Bob Smith",
      assignedEngineerEmail: "bob@x.com",
      kitLines: [
        { id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", qty: 10, warehouseName: "WH1", warehouseCode: "W1" },
      ],
    });
    // Summary shows awaiting_return.
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummary.mockResolvedValue({ goodsStatus: "awaiting_return", workSummary: "Done", lastMovementAt: new Date() });
    // Default movement picture: 10 issued, 10 returned (balanced).
    mockMoves.mockResolvedValue([
      makeMovement("issue",  [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 10 }]),
      makeMovement("return", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 10, condition: "good" }]),
    ]);
    // createMovementWithCode invokes the apply callback synchronously.
    mockCreateMovement.mockImplementation(async (_h: unknown, _l: unknown, apply: (tx: unknown, id: string, code: string) => Promise<void>) => {
      await apply({}, "m4", "GM-0004");
      return { id: "m4", code: "GM-0004", direction: "consume", items: [], job: { id: RECONCILE_JOB_ID } };
    });
    // Engineer holds 0 by default (fully returned in the balanced scenario).
    mockFindEngBalTx.mockResolvedValue({ quantityOnHand: 0 });
    mockUpsertEngBalTx.mockResolvedValue({ quantityOnHand: 0 });
    mockInsertEngTxnTx.mockResolvedValue({});
    mockUpsertSummaryTx.mockResolvedValue({});
    // Engineer holds nothing by default (balanced scenario) — real-held caps "unaccounted".
    mockFindEngBalancesAll.mockResolvedValue([]);
    mockFindCustHoldingsAll.mockResolvedValue([]);
  });

  it("reconciles a balanced job (all returned) to goodsStatus = reconciled and returns no unaccounted", async () => {
    const result = await closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never);
    expect(result.unaccounted).toHaveLength(0);
    expect(mockUpsertSummaryTx).toHaveBeenCalledWith(
      expect.anything(), // tx
      RECONCILE_JOB_ID,
      expect.objectContaining({ goodsStatus: "reconciled" }),
    );
  });

  it("returns unaccounted list and leaves job open when writeOffLost is false/absent and there is a shortfall", async () => {
    // Only 6 returned out of 10 issued, 4 still with the engineer.
    mockMoves.mockResolvedValue([
      makeMovement("issue",  [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 10 }]),
      makeMovement("return", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 6, condition: "good" }]),
    ]);
    mockFindEngBalancesAll.mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 4 }]); // really holds 4
    const result = await closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never);
    expect(result.unaccounted).toHaveLength(1);
    expect(result.unaccounted[0]).toMatchObject({ itemName: "CAT6", qty: 4 });
    // Summary NOT set to reconciled — job stays open.
    expect(mockUpsertSummaryTx).not.toHaveBeenCalledWith(
      expect.anything(),
      RECONCILE_JOB_ID,
      expect.objectContaining({ goodsStatus: "reconciled" }),
    );
  });

  it("writes off lost units and reconciles when writeOffLost = true", async () => {
    // 4 still unaccounted.
    mockMoves.mockResolvedValue([
      makeMovement("issue",  [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 10 }]),
      makeMovement("return", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 6, condition: "good" }]),
    ]);
    // Engineer still holds 4.
    mockFindEngBalancesAll.mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 4 }]);
    mockFindEngBalTx.mockResolvedValue({ quantityOnHand: 4 });
    mockUpsertEngBalTx.mockResolvedValue({ quantityOnHand: 0 });

    const result = await closeReconcile(RECONCILE_JOB_ID, { writeOffLost: true }, { email: "wm@x.com" } as never);
    expect(result.unaccounted).toHaveLength(0);
    // Engineer holding was drained (lost write-off).
    expect(mockUpsertEngBalTx).toHaveBeenCalledWith({}, IRM_ID, ENG_ID, -4);
    // Ledger row written with type "job_lost".
    expect(mockInsertEngTxnTx).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ irmItemId: IRM_ID, quantityDelta: -4, type: "job_lost" }),
    );
    // Summary set to reconciled.
    expect(mockUpsertSummaryTx).toHaveBeenCalledWith(
      {},
      RECONCILE_JOB_ID,
      expect.objectContaining({ goodsStatus: "reconciled" }),
    );
  });

  it("does NOT flag unaccounted when the engineer's real holding is 0 (returned at another warehouse / another job)", async () => {
    // This job's per-line movements show 1 issued, 0 returned (a raw shortfall of 1) — but the engineer
    // handed it back at a different warehouse, or under another job (shared customer-stock entry), so
    // their real balance is 0. Nothing is genuinely outstanding → reconcile must close cleanly.
    mockMoves.mockResolvedValue([
      makeMovement("issue", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 1 }]),
    ]);
    mockFindEngBalancesAll.mockResolvedValue([]); // engineer holds 0
    const result = await closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never);
    expect(result.unaccounted).toHaveLength(0);
    expect(mockUpsertSummaryTx).toHaveBeenCalledWith(
      expect.anything(),
      RECONCILE_JOB_ID,
      expect.objectContaining({ goodsStatus: "reconciled" }),
    );
  });

  it("ignores movements against edited/removed kit lines (orphaned ids don't inflate unaccounted)", async () => {
    // k1 is balanced (10 issued, 10 returned). An older issue of 20 sits against kOLD — a kit line
    // id that no longer exists on the job (it was edited). It must NOT be counted as unaccounted.
    mockMoves.mockResolvedValue([
      makeMovement("issue",  [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 10 }]),
      makeMovement("return", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 10, condition: "good" }]),
      makeMovement("issue",  [{ jobKitLineId: "kOLD", irmItemId: IRM_ID, customerStockEntryId: null, qty: 20 }]),
    ]);
    const result = await closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never);
    expect(result.unaccounted).toHaveLength(0);
  });

  it("excludes misc kit lines from reconciliation (misc is not stock-tracked / never returned)", async () => {
    mockJob.mockResolvedValue({
      id: RECONCILE_JOB_ID, status: "completed", assignedEngineerId: ENG_ID,
      assignedEngineerName: "Bob Smith", assignedEngineerEmail: "bob@x.com",
      kitLines: [
        { id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", qty: 10, warehouseName: "WH1", warehouseCode: "W1" },
        { id: "km", lineType: "misc", irmItemId: null, customerStockEntryId: null, warehouseId: null, itemName: "cable", qty: 2 },
      ],
    });
    mockMoves.mockResolvedValue([
      makeMovement("issue",  [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 10 }]),
      makeMovement("return", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 10, condition: "good" }]),
      makeMovement("issue",  [{ jobKitLineId: "km", irmItemId: null, customerStockEntryId: null, qty: 2, source: "misc" }]),
    ]);
    const result = await closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never);
    expect(result.unaccounted).toHaveLength(0); // 'cable' (misc) must not appear
  });

  it("counts good + damaged returns together against the kit line", async () => {
    // Mirrors the WM split-return: held 2 → 1 good + 1 damaged returned → nothing unaccounted.
    mockMoves.mockResolvedValue([
      makeMovement("issue",   [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 20 }]),
      makeMovement("consume", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 18 }]),
      makeMovement("return",  [
        { jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 1, condition: "good" },
        { jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 1, condition: "damaged" },
      ]),
    ]);
    const result = await closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never);
    expect(result.unaccounted).toHaveLength(0); // 20 − 18 − 1 − 1 = 0
  });

  it("rejects reconciling a job that is already reconciled", async () => {
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummary.mockResolvedValue({ goodsStatus: "reconciled", workSummary: null, lastMovementAt: new Date() });
    await expect(closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never)).rejects.toThrow(/already reconciled/i);
  });

  it("rejects reconciling a job still in the ISSUED phase (engineer hasn't completed yet)", async () => {
    // Stock issued but the engineer hasn't completed/declared usage — reconciling now would write off
    // live stock as lost. Must wait for goodsStatus "awaiting_return".
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummary.mockResolvedValue({ goodsStatus: "issued", workSummary: null, lastMovementAt: new Date() });
    await expect(closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never)).rejects.toThrow(/after the engineer completes/i);
  });

  it("rejects reconciling a not_issued / no-summary job", async () => {
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummary.mockResolvedValue({ goodsStatus: "not_issued", workSummary: null, lastMovementAt: null });
    await expect(closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never)).rejects.toThrow(/after the engineer completes/i);
    mockGetSummary.mockResolvedValue(null);
    await expect(closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never)).rejects.toThrow(/after the engineer completes/i);
  });

  it("rejects issue when summary is already reconciled", async () => {
    // Simulate the postIssue reconciled-guard.
    const mockGetSummaryForIssue = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummaryForIssue.mockResolvedValue({ goodsStatus: "reconciled", workSummary: null, lastMovementAt: new Date() });
    mockJob.mockResolvedValue({
      id: RECONCILE_JOB_ID, status: "in_progress", assignedEngineerId: ENG_ID,
      assignedEngineerName: "Bob", assignedEngineerEmail: null,
      kitLines: [{ id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", qty: 10, warehouseName: "WH1", warehouseCode: "W1" }],
    });
    const mockRequireIrm = irmService.requireActiveIrmItem as ReturnType<typeof vi.fn>;
    mockRequireIrm.mockResolvedValue({ id: IRM_ID, name: "CAT6", baseUnit: "Box", trackSerialNumbers: false, trackBatchNumbers: false });
    await expect(
      postIssue(RECONCILE_JOB_ID, { direction: "issue", warehouseId: WH_ID, lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 1 }] }, { email: "wm@x.com" } as never),
    ).rejects.toThrow(/reconciled|locked/i);
  });

  it("rejects return when summary is already reconciled", async () => {
    const mockGetSummaryForReturn = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummaryForReturn.mockResolvedValue({ goodsStatus: "reconciled", workSummary: null, lastMovementAt: new Date() });
    mockJob.mockResolvedValue({
      id: RECONCILE_JOB_ID, status: "completed", assignedEngineerId: ENG_ID,
      assignedEngineerName: "Bob", assignedEngineerEmail: null,
      kitLines: [{ id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", qty: 10, warehouseName: "WH1", warehouseCode: "W1" }],
    });
    await expect(
      postReturn(RECONCILE_JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [{ source: "irm", irmItemId: IRM_ID, qty: 1, condition: "good", jobKitLineId: "k1" }] }, { email: "wm@x.com" } as never),
    ).rejects.toThrow(/reconciled|locked/i);
  });
});

// ── listDamaged ──────────────────────────────────────────────────────────────────────────────
import { listDamaged } from "./goods-management.service.js";

const mockFindDamagedByWarehouse = repo.findDamagedByWarehouse as ReturnType<typeof vi.fn>;
const mockFindDamagedByCustomer = repo.findDamagedByCustomer as ReturnType<typeof vi.fn>;
const mockFindAllDamaged = repo.findAllDamaged as ReturnType<typeof vi.fn>;
const mockFindLatestDamagedTxns = repo.findLatestDamagedTxnsByBalances as ReturnType<typeof vi.fn>;

const damagedRow = {
  id: "dmg1",
  warehouseId: WH_ID,
  ownerType: "company",
  irmItemId: IRM_ID,
  customerStockEntryId: null,
  customerId: null,
  itemName: "CAT6",
  quantity: 3,
  updatedAt: new Date(),
  warehouse: { name: "Main Warehouse" },
};

// ── getJobKitTallies (job-pack "remaining" reflects the engineer's real holding) ─────────────────
import { getJobKitTallies } from "./goods-management.service.js";

describe("getJobKitTallies", () => {
  it("caps per-line 'remaining' at the engineer's REAL holding (returns booked at another warehouse)", async () => {
    const WH2 = "wh2".padEnd(24, "0");
    mockJob.mockResolvedValue({
      id: JOB_ID, assignedEngineerId: ENG_ID,
      kitLines: [
        { id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, itemName: "CAT6", qty: 1, warehouseId: WH_ID },
        { id: "k2", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, itemName: "CAT6", qty: 1, warehouseId: WH2 },
      ],
    });
    // 1 issued from each warehouse; BOTH handed back at k1's warehouse (k1 returned 2, k2 returned 0).
    mockMoves.mockResolvedValue([
      makeMovement("issue",  [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 1 }]),
      makeMovement("issue",  [{ jobKitLineId: "k2", irmItemId: IRM_ID, customerStockEntryId: null, qty: 1 }]),
      makeMovement("return", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 2, condition: "good" }]),
    ]);
    mockFindEngBalancesAll.mockResolvedValue([]); // engineer holds 0 → nothing remaining anywhere
    mockFindCustHoldingsAll.mockResolvedValue([]);
    const tallies = await getJobKitTallies(JOB_ID);
    expect(tallies.k1.remaining).toBe(0);
    expect(tallies.k2.remaining).toBe(0); // raw would say 1, but the engineer holds 0
  });

  it("reports raw remaining when the engineer genuinely still holds the item", async () => {
    mockJob.mockResolvedValue({
      id: JOB_ID, assignedEngineerId: ENG_ID,
      kitLines: [{ id: "k1", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, itemName: "CAT6", qty: 5, warehouseId: WH_ID }],
    });
    mockMoves.mockResolvedValue([
      makeMovement("issue", [{ jobKitLineId: "k1", irmItemId: IRM_ID, customerStockEntryId: null, qty: 5 }]),
    ]);
    mockFindEngBalancesAll.mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 5 }]);
    mockFindCustHoldingsAll.mockResolvedValue([]);
    const tallies = await getJobKitTallies(JOB_ID);
    expect(tallies.k1).toMatchObject({ issued: 5, returned: 0, used: 0, remaining: 5 });
  });
});

// ── getOpenDemand (cross-job planned-but-not-issued) ─────────────────────────────────────────────
import { getOpenDemand } from "./goods-management.service.js";

describe("getOpenDemand", () => {
  const mockActive = jobRepo.findActiveWithKitLines as ReturnType<typeof vi.fn>;
  const mockSummaries = repo.getSummariesByJobs as ReturnType<typeof vi.fn>;
  const mockMovesBatch = repo.findMovementsByJobs as ReturnType<typeof vi.fn>;
  const irmLine = (id: string, qty: number) => ({ id, lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", warehouseName: "WH1", qty });

  it("sums planned MINUS already-issued across active jobs, per item+warehouse", async () => {
    mockActive.mockResolvedValue([
      { id: "j1", kitLines: [irmLine("j1k", 10)] }, // not_issued → full 10
      { id: "j2", kitLines: [irmLine("j2k", 5)] },  // partially_issued, 2 issued → 3
    ]);
    mockSummaries.mockResolvedValue([{ jobId: "j2", goodsStatus: "partially_issued" }]); // j1 has no summary → not_issued
    mockMovesBatch.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "j2k", qty: 2 }] }]);
    const demand = await getOpenDemand();
    expect(demand.get(`irm|${IRM_ID}|${WH_ID}`)?.demand).toBe(13); // 10 + (5−2)
  });

  it("ignores jobs whose goods are fully issued / reconciled (no future warehouse draw)", async () => {
    mockActive.mockResolvedValue([{ id: "j1", kitLines: [irmLine("j1k", 10)] }]);
    mockSummaries.mockResolvedValue([{ jobId: "j1", goodsStatus: "reconciled" }]);
    mockMovesBatch.mockResolvedValue([]);
    const demand = await getOpenDemand();
    expect(demand.size).toBe(0);
  });
});

describe("listDamaged", () => {
  beforeEach(() => {
    mockFindDamagedByWarehouse.mockResolvedValue([damagedRow]);
    mockFindDamagedByCustomer.mockResolvedValue([]);
    mockFindAllDamaged.mockResolvedValue([damagedRow]);
    // Return an empty Map by default (no latest txn enrichment needed for basic assertions).
    mockFindLatestDamagedTxns.mockResolvedValue(new Map());
  });

  it("filters by warehouseId and returns rows without cost/value", async () => {
    const rows = await listDamaged({ warehouseId: WH_ID });
    expect(mockFindDamagedByWarehouse).toHaveBeenCalledWith(WH_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "dmg1", warehouseId: WH_ID, ownerType: "company", irmItemId: IRM_ID, quantity: 3 });
    // No cost/value fields exposed.
    expect(Object.keys(rows[0])).not.toContain("cost");
    expect(Object.keys(rows[0])).not.toContain("value");
  });

  it("filters by customerId and returns customer-owned damaged rows", async () => {
    const customerDamagedRow = { ...damagedRow, id: "dmg2", ownerType: "customer", customerId: "cust1", irmItemId: null, customerStockEntryId: CSE_ID, itemName: "SFP-LX", quantity: 1 };
    mockFindDamagedByCustomer.mockResolvedValue([customerDamagedRow]);
    const rows = await listDamaged({ customerId: "cust1" });
    expect(mockFindDamagedByCustomer).toHaveBeenCalledWith("cust1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "dmg2", ownerType: "customer", customerStockEntryId: CSE_ID, quantity: 1 });
  });

  it("returns all damaged rows for a global actor when no filter given", async () => {
    const rows = await listDamaged({});
    expect(mockFindAllDamaged).toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });
});

// ── listOverdue ──────────────────────────────────────────────────────────────────────────────
import { listOverdue } from "./goods-management.service.js";

const mockFindRecentMovementsForOverdue = repo.findRecentMovementsForOverdue as ReturnType<typeof vi.fn>;

describe("listOverdue", () => {
  beforeEach(() => {
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    // Default: one overdue issue movement, job not yet reconciled.
    mockFindRecentMovementsForOverdue.mockResolvedValue([
      {
        id: "m1",
        code: "GM-0001",
        jobId: JOB_ID,
        direction: "issue",
        status: "posted",
        engineerId: ENG_ID,
        engineerName: "Bob Smith",
        warehouseId: WH_ID,
        createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago
        job: { id: JOB_ID, jobNumber: "JOB-0001", name: "Test Job", customerId: "cust1", customerName: "Acme" },
        items: [{ source: "irm", irmItemId: IRM_ID, customerStockEntryId: null, itemName: "CAT6", qty: 5, condition: "good" }],
      },
    ]);
    mockGetSummary.mockResolvedValue({ goodsStatus: "issued", workSummary: null, lastMovementAt: new Date() });
  });

  it("returns issue movements older than the cutoff whose job is not reconciled", async () => {
    const rows = await listOverdue();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jobId: JOB_ID,
      jobNumber: "JOB-0001",
      engineerName: "Bob Smith",
      goodsStatus: "issued",
    });
    expect(rows[0].lines).toHaveLength(1);
    expect(rows[0].lines[0]).toMatchObject({ source: "irm", irmItemId: IRM_ID, qty: 5 });
  });

  it("excludes jobs that are already reconciled", async () => {
    const mockGetSummaryReconciled = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummaryReconciled.mockResolvedValue({ goodsStatus: "reconciled", workSummary: null, lastMovementAt: new Date() });
    const rows = await listOverdue();
    expect(rows).toHaveLength(0);
  });

  it("deduplicates the same job appearing in multiple issue movements", async () => {
    // Two issue movements for the same job.
    const baseMovement = {
      id: "m1",
      code: "GM-0001",
      jobId: JOB_ID,
      direction: "issue",
      status: "posted",
      engineerId: ENG_ID,
      engineerName: "Bob Smith",
      warehouseId: WH_ID,
      createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      job: { id: JOB_ID, jobNumber: "JOB-0001", name: "Test Job", customerId: "cust1", customerName: "Acme" },
      items: [{ source: "irm", irmItemId: IRM_ID, customerStockEntryId: null, itemName: "CAT6", qty: 5, condition: "good" }],
    };
    mockFindRecentMovementsForOverdue.mockResolvedValue([
      { ...baseMovement },
      { ...baseMovement, id: "m2", code: "GM-0002" },
    ]);
    const rows = await listOverdue();
    // The same job appears only once even with two issue movements.
    expect(rows).toHaveLength(1);
  });
});
