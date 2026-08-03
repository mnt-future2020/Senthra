import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("../../lib/realtime.js", () => ({ emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "jobs:office" }));
vi.mock("./goods-management.repository.js", () => ({
  createMovementWithCode: vi.fn(), findMovementsByJob: vi.fn(), findMovementsByJobs: vi.fn(), findIssuedQtyByKitLine: vi.fn(), getSummary: vi.fn(), getSummariesByJobs: vi.fn(), upsertSummaryTx: vi.fn(),
  upsertCustomerHoldingTx: vi.fn(), findCustomerHoldingTx: vi.fn(), insertCustomerHoldingTxnTx: vi.fn(), findCustomerHoldingsByEngineer: vi.fn(),
  adjustCustomerStockEntryQtyTx: vi.fn(), findCustomerStockEntryById: vi.fn(), findCustomerStockEntriesByIds: vi.fn(), findCustomerStockEntryByBarcode: vi.fn(),
  upsertDamagedBalanceTx: vi.fn(), insertDamagedTxnTx: vi.fn(), findDamagedByWarehouse: vi.fn(), findDamagedByCustomer: vi.fn(), findAllDamaged: vi.fn(), findOldIssueMovementsForJobs: vi.fn(), findSummariesByGoodsStatuses: vi.fn(), findCustomerHolding: vi.fn(),
  findLatestDamagedTxnsByBalances: vi.fn(), findDamagedBalance: vi.fn(), findDamagedTxnsByKey: vi.fn(),
}));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn(), findActiveForGoodsManagement: vi.fn(), findActiveWithKitLines: vi.fn(), findKitLineTypesByJobs: vi.fn(), findGoodsActiveJobIds: vi.fn(), completeIfInProgressTx: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn(), findActiveByCodeOrBarcode: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancePair: vi.fn(), findBalancesByItemsAndWarehouses: vi.fn(), findBalancePairTx: vi.fn(), upsertBalanceTx: vi.fn(), insertTransactionTx: vi.fn() }));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyOutbound: vi.fn(), applyInbound: vi.fn() }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({ upsertEngineerBalanceTx: vi.fn(), insertEngineerTxnTx: vi.fn(), findEngineerBalanceTx: vi.fn(), findEngineerBalance: vi.fn(), findEngineerBalances: vi.fn() }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
// The overdue window comes from Settings now, so the service reaches for it whenever a caller doesn't
// pass an explicit `days`. Mocked to the shipped default so these tests stay about goods logic.
// getCompanyTimezone backs BOTH the due-date filter window and each row's due badge, so the queue
// reads it on every load now — not only when a due filter is applied.
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(),
  getOverdueAfterDays: vi.fn(async () => 14),
  getCompanyTimezone: vi.fn(async () => "Europe/London"),
}));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({ findVanSourcesByKitLines: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findById: vi.fn() }));

import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
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
  // Default: nothing came from another engineer's van.
  (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
});

// Stock that reached the engineer via another engineer's VAN never left a warehouse, so no warehouse
// is owed it back — it can be scanned in anywhere. Stock ISSUED by a warehouse must still go back to
// that warehouse, or its ledger is credited for units it never released (and the issuing one is left
// short). The split matters because a kit line MERGES both sources into one row.
describe("scanLookup (return) — where van-sourced stock may be handed back", () => {
  const OTHER_WH = "e".repeat(24);
  const mockEngBal = engineerStockRepo.findEngineerBalance as ReturnType<typeof vi.fn>;
  const mockVanSources = transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>;

  const vanSource = (quantity: number, status = "completed") => ({ transferCode: "ENG-0026", engineerName: "sahul FE", quantity, status });

  beforeEach(() => {
    mockEngBal.mockResolvedValue({ quantityOnHand: 4 });
  });

  it("accepts a purely van-sourced line at a DIFFERENT warehouse", async () => {
    // All 4 issued units were attributed from a completed van transfer.
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 4 }] }]);
    mockVanSources.mockResolvedValue(new Map([["k1", [vanSource(4)]]]));

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: OTHER_WH, code: "IRM-0004" });
    expect(m).toMatchObject({ source: "irm", jobKitLineId: "k1", heldByEngineer: 4 });
  });

  it("still refuses a WAREHOUSE-issued line at a different warehouse", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 4 }] }]);
    mockVanSources.mockResolvedValue(new Map()); // nothing came from a van

    await expect(scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: OTHER_WH, code: "IRM-0004" }))
      .rejects.toThrow(/different warehouse/i);
  });

  it("accepts a MIXED line elsewhere but CAPS the return at the van portion", async () => {
    // 6 issued, 2 of them from a van ⇒ only those 2 owe no warehouse and may land here; the other 4
    // must return to WH_ID. The cap is the van qty (2), not the whole line (6).
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 6 }] }]);
    mockVanSources.mockResolvedValue(new Map([["k1", [vanSource(2)]]]));
    mockEngBal.mockResolvedValue({ quantityOnHand: 6 }); // engineer physically holds all 6

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: OTHER_WH, code: "IRM-0004" });
    expect(m).toMatchObject({ jobKitLineId: "k1", heldByEngineer: 2 });
  });

  it("returns the FULL line at its home warehouse regardless of source mix", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 6 }] }]);
    mockVanSources.mockResolvedValue(new Map([["k1", [vanSource(2)]]]));
    mockEngBal.mockResolvedValue({ quantityOnHand: 6 });

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "IRM-0004" });
    expect(m).toMatchObject({ jobKitLineId: "k1", heldByEngineer: 6 }); // home takes van + warehouse
  });

  it("shrinks the elsewhere cap by van units already returned at another warehouse", async () => {
    // van 3; 1 already returned at OTHER_WH ⇒ only 2 van units remain returnable away from home.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 5 }] },
      { status: "posted", direction: "return", warehouseId: OTHER_WH, items: [{ jobKitLineId: "k1", qty: 1 }] },
    ]);
    mockVanSources.mockResolvedValue(new Map([["k1", [vanSource(3)]]]));
    mockEngBal.mockResolvedValue({ quantityOnHand: 4 });

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: OTHER_WH, code: "IRM-0004" });
    expect(m).toMatchObject({ jobKitLineId: "k1", heldByEngineer: 2 });
  });

  it("shrinks the elsewhere cap conservatively by consumed units (van assumed used first)", async () => {
    // van 3, consumed 2 ⇒ at most 1 van unit is still returnable away from home. Conservative so a
    // warehouse-owed unit can never be mis-credited to the wrong warehouse.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 5 }] },
      { status: "posted", direction: "consume", warehouseId: null, items: [{ jobKitLineId: "k1", qty: 2 }] },
    ]);
    mockVanSources.mockResolvedValue(new Map([["k1", [vanSource(3)]]]));
    mockEngBal.mockResolvedValue({ quantityOnHand: 3 });

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: OTHER_WH, code: "IRM-0004" });
    expect(m).toMatchObject({ jobKitLineId: "k1", heldByEngineer: 1 });
  });

  it("ignores a PENDING transfer — that stock hasn't been handed over yet", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 4 }] }]);
    mockVanSources.mockResolvedValue(new Map([["k1", [vanSource(4, "pending")]]]));

    await expect(scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: OTHER_WH, code: "IRM-0004" }))
      .rejects.toThrow(/different warehouse/i);
  });

  it("still resolves a van-sourced line at its own homed warehouse", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 4 }] }]);
    mockVanSources.mockResolvedValue(new Map([["k1", [vanSource(4)]]]));

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "IRM-0004" });
    expect(m).toMatchObject({ jobKitLineId: "k1" });
  });
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
  const mockEngBal = engineerStockRepo.findEngineerBalance as ReturnType<typeof vi.fn>;
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
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";

const ENG_ID = "c".repeat(24);
const mockCreateMovement = repo.createMovementWithCode as ReturnType<typeof vi.fn>;
const mockApplyOutbound = inventoryService.applyOutbound as ReturnType<typeof vi.fn>;
const mockUpsertEng = engineerStockRepo.upsertEngineerBalanceTx as ReturnType<typeof vi.fn>;
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
  const mockEngBalances = engineerStockRepo.findEngineerBalances as ReturnType<typeof vi.fn>;
  const mockCustHoldings = repo.findCustomerHoldingsByEngineer as ReturnType<typeof vi.fn>;
  const mockIssuedByLine = repo.findIssuedQtyByKitLine as ReturnType<typeof vi.fn>;
  // Stage issued-per-kit-line totals for the pre-pagination "is there work here?" filter. Kept as an
  // explicit helper rather than derived from the movement fixtures: the two feed different stages
  // (this one filters ALL candidates, findMovementsByJobs enriches only the page), so stating each
  // test's totals outright is what makes a divergence between them visible instead of silent.
  const stageIssued = (totals: Record<string, number> = {}) =>
    mockIssuedByLine.mockResolvedValue(new Map(Object.entries(totals)));

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
    stageIssued(); // nothing issued unless a test says otherwise
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

  // The last-activity window bounds the Closed view, whose candidate set otherwise grows forever.
  // Filtering happens BEFORE pagination, so `total` has to shrink too — a window that only trimmed the
  // visible page would leave the pager promising rows that aren't there.
  describe("last-activity window", () => {
    const staged = () => {
      mockFindActive.mockResolvedValue([job(A1, "JOB-1"), job(A2, "JOB-2")]);
      mockSummaries.mockResolvedValue([
        { jobId: A1, goodsStatus: "reconciled", lastMovementAt: new Date("2026-07-05T10:00:00.000Z") },
        { jobId: A2, goodsStatus: "reconciled", lastMovementAt: new Date("2026-08-20T10:00:00.000Z") },
      ]);
    };

    it("keeps only jobs whose last activity is on/after activityFrom", async () => {
      staged();
      const res = await listQueue({ warehouseId: WH_ID, status: "reconciled", activityFrom: "2026-08-01" });
      expect(res.total).toBe(1);
      expect(res.rows[0].jobNumber).toBe("JOB-2");
    });

    it("keeps only jobs whose last activity is on/before activityTo", async () => {
      staged();
      const res = await listQueue({ warehouseId: WH_ID, status: "reconciled", activityTo: "2026-07-31" });
      expect(res.total).toBe(1);
      expect(res.rows[0].jobNumber).toBe("JOB-1");
    });

    // The inclusive-end rule, end to end: a "To" of the activity's own date must keep it. Cutting off
    // at midnight would drop everything closed on the last day of the range.
    it("treats activityTo as inclusive of that whole day", async () => {
      staged();
      const res = await listQueue({ warehouseId: WH_ID, status: "reconciled", activityTo: "2026-07-05" });
      expect(res.total).toBe(1);
      expect(res.rows[0].jobNumber).toBe("JOB-1");
    });

    it("excludes a job with no recorded activity when a window is set", async () => {
      mockFindActive.mockResolvedValue([job(A1, "JOB-1")]);
      mockSummaries.mockResolvedValue([{ jobId: A1, goodsStatus: "reconciled", lastMovementAt: null }]);
      const res = await listQueue({ warehouseId: WH_ID, status: "reconciled", activityFrom: "2026-01-01" });
      expect(res.total).toBe(0);
    });

    it("ignores an unparseable date rather than returning nothing", async () => {
      staged();
      const res = await listQueue({ warehouseId: WH_ID, status: "reconciled", activityFrom: "not-a-date" });
      expect(res.total).toBe(2);
    });
  });

  // Ordering exists to surface NEGLECTED work: nothing else does. listOverdue keys off issue movements,
  // so a job that was never issued can't appear there, and under the default newest-first order it just
  // sinks below newer jobs forever.
  describe("ordering", () => {
    // JOB-1 raised first but touched recently; JOB-2 raised later and untouched since.
    const staged = () => {
      mockFindActive.mockResolvedValue([job(A1, "JOB-1"), job(A2, "JOB-2")]);
      mockSummaries.mockResolvedValue([
        { jobId: A1, goodsStatus: "issued", lastMovementAt: new Date("2026-08-20T10:00:00.000Z") },
        { jobId: A2, goodsStatus: "issued", lastMovementAt: new Date("2026-07-01T10:00:00.000Z") },
      ]);
    };

    it("keeps the query's newest-first order by default", async () => {
      staged();
      const res = await listQueue({ warehouseId: WH_ID });
      expect(res.rows.map((r) => r.jobNumber)).toEqual(["JOB-1", "JOB-2"]);
    });

    it("puts the least-recently-touched job first for activity_asc", async () => {
      staged();
      const res = await listQueue({ warehouseId: WH_ID, sort: "activity_asc" });
      expect(res.rows.map((r) => r.jobNumber)).toEqual(["JOB-2", "JOB-1"]);
    });

    it("puts the most-recently-touched job first for activity_desc", async () => {
      staged();
      const res = await listQueue({ warehouseId: WH_ID, sort: "activity_desc" });
      expect(res.rows.map((r) => r.jobNumber)).toEqual(["JOB-1", "JOB-2"]);
    });

    // A job with no movement has to age from when it was RAISED, or a never-touched request would
    // either pin to one end of the list or never surface at all — the exact blind spot this fixes.
    it("ages a never-moved job from its createdAt", async () => {
      mockFindActive.mockResolvedValue([
        { ...job(A1, "JOB-OLD"), createdAt: new Date("2026-01-01T00:00:00.000Z") },
        { ...job(A2, "JOB-NEW"), createdAt: new Date("2026-08-01T00:00:00.000Z") },
      ]);
      mockSummaries.mockResolvedValue([]); // neither has ever moved
      const res = await listQueue({ warehouseId: WH_ID, sort: "activity_asc" });
      expect(res.rows.map((r) => r.jobNumber)).toEqual(["JOB-OLD", "JOB-NEW"]);
    });

    it("orders across the WHOLE candidate set, not just the page on screen", async () => {
      staged();
      const res = await listQueue({ warehouseId: WH_ID, sort: "activity_asc", page: 1, pageSize: 1 });
      expect(res.rows.map((r) => r.jobNumber)).toEqual(["JOB-2"]);
      expect(res.total).toBe(2);
    });

    it("rejects an unknown sort", async () => {
      await expect(listQueue({ warehouseId: WH_ID, sort: "sideways" })).rejects.toThrow(/invalid sort/i);
    });
  });

  // The dates the Closed view displays. Without these the filter would narrow on a value the screen
  // never shows, leaving the user no way to tell whether it did the right thing.
  it("returns the job's createdAt and last activity on each row", async () => {
    const moved = new Date("2026-08-20T10:00:00.000Z");
    mockFindActive.mockResolvedValue([{ ...job(A1, "JOB-1"), createdAt: new Date("2026-08-01T00:00:00.000Z") }]);
    mockSummaries.mockResolvedValue([{ jobId: A1, goodsStatus: "issued", lastMovementAt: moved }]);
    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.rows[0]).toMatchObject({ createdAt: new Date("2026-08-01T00:00:00.000Z"), lastActivityAt: moved });
  });

  it("reports lastActivityAt as null for a job that has never moved", async () => {
    mockFindActive.mockResolvedValue([job(A1, "JOB-1")]);
    mockSummaries.mockResolvedValue([]);
    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.rows[0].lastActivityAt).toBeNull();
  });

  // The queue greys out any line not homed at the warehouse being managed, because only that
  // warehouse may take it back. Van-sourced stock is the exception — no warehouse released it, so
  // any may receive it — and the row has to say so or the WM standing in front of the engineer sees
  // a greyed line and turns them away.
  it("flags a fully van-sourced line as actionable at any warehouse", async () => {
    mockFindActive.mockResolvedValue([job(JOB_ID, "JOB-1")]);
    mockSummaries.mockResolvedValue([{ jobId: JOB_ID, goodsStatus: "issued" }]);
    stageIssued({ [`${JOB_ID}-k1`]: 10 });
    mockMovesBatch.mockResolvedValue([
      { jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 10 }] },
    ]);
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([[`${JOB_ID}-k1`, [{ transferCode: "ENG-1", engineerName: "sahul FE", quantity: 10, status: "completed" }]]]),
    );

    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.rows[0].kitLines[0].vanReturnableQty).toBe(10);
  });

  it("reports 0 van-returnable for a warehouse-issued line", async () => {
    mockFindActive.mockResolvedValue([job(JOB_ID, "JOB-1")]);
    mockMovesBatch.mockResolvedValue([
      { jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 10 }] },
    ]);
    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.rows[0].kitLines[0].vanReturnableQty).toBe(0);
  });

  // Discoverability: a job's van stock is homed at one warehouse but returnable at any. It must
  // surface in EVERY warehouse's queue that could receive it — no search needed — so a WM anywhere
  // can process the return. The DB query widens via JobKitLine.hasVanSource (mocked: mockFindActive
  // returns the job, simulating that widened match); the service then filters per line.
  it("surfaces a van job at a warehouse where its stock isn't homed, without a search", async () => {
    const OTHER_WH = "e2".padEnd(24, "0"); // k1 is homed at WH_ID, we query OTHER_WH
    mockFindActive.mockResolvedValue([job(JOB_ID, "JOB-1")]);
    mockMovesBatch.mockResolvedValue([{ jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 10 }] }]);
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([[`${JOB_ID}-k1`, [{ transferCode: "ENG-1", engineerName: "sahul FE", quantity: 10, status: "completed" }]]]),
    );

    const res = await listQueue({ warehouseId: OTHER_WH }); // NO search
    expect(res.total).toBe(1);
    expect(res.rows[0].kitLines[0].vanReturnableQty).toBe(10);
  });

  it("does NOT surface a van job elsewhere once its van stock is fully returned", async () => {
    const OTHER_WH = "e2".padEnd(24, "0");
    mockFindActive.mockResolvedValue([job(JOB_ID, "JOB-1")]);
    // Issued 10 from a van, all 10 already returned at OTHER_WH ⇒ nothing left to receive anywhere.
    mockMovesBatch.mockResolvedValue([
      { jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 10 }] },
      { jobId: JOB_ID, status: "posted", direction: "return", warehouseId: OTHER_WH, items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 10 }] },
    ]);
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([[`${JOB_ID}-k1`, [{ transferCode: "ENG-1", engineerName: "sahul FE", quantity: 10, status: "completed" }]]]),
    );

    const res = await listQueue({ warehouseId: OTHER_WH });
    expect(res.total).toBe(0);
  });

  it("does not surface a NON-van job at a warehouse where it has no line", async () => {
    const OTHER_WH = "e2".padEnd(24, "0");
    mockFindActive.mockResolvedValue([job(JOB_ID, "JOB-1")]); // homed at WH_ID, not OTHER_WH
    // No van sources (default empty map) ⇒ nothing returnable away ⇒ not surfaced here.
    mockMovesBatch.mockResolvedValue([{ jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: `${JOB_ID}-k1`, qty: 10 }] }]);

    const res = await listQueue({ warehouseId: OTHER_WH });
    expect(res.total).toBe(0);
  });

  // A job reaches this warehouse's queue via `some kitLine: warehouseId = here OR lineType = misc`.
  // The misc arm is warehouse-blind, so a job whose ONLY tie to this warehouse is a misc line shows
  // up in EVERY warehouse's queue. That's wanted while the misc item is still outstanding (someone
  // has to hand it over), but once it's fully issued there is nothing left to do here and the row
  // renders entirely greyed out — pure noise that also inflates the "Total: N jobs" count.
  const OTHER_WH = "w2".padEnd(24, "0");
  const miscOnlyJob = (id: string, num: string) => ({
    id, jobNumber: num, name: "Elsewhere Job", customerId: "x".repeat(24), customerName: "Acme",
    assignedEngineerId: ENG_ID, assignedEngineerName: "Bob", status: "accepted",
    kitLines: [
      // Real line belongs to ANOTHER warehouse — greyed out here, not actionable.
      { id: `${id}-k1`, lineType: "irm", irmItemId: IRM_ID, warehouseId: OTHER_WH, itemName: "CAT6", qty: 3, warehouseName: "WH2", warehouseCode: "W2", customerStockEntryId: null },
      // Misc line — no warehouse at all; this is what dragged the job in here.
      { id: `${id}-k2`, lineType: "misc", irmItemId: null, warehouseId: null, itemName: "ckgkgkgkgk", qty: 2, warehouseName: null, warehouseCode: null, customerStockEntryId: null },
    ],
  });

  it("drops a misc-only job from another warehouse's queue once its misc line is fully issued", async () => {
    mockFindActive.mockResolvedValue([miscOnlyJob(A1, "JOB-0015")]);
    // Every line issued in full ⇒ postIssue would have stamped goodsStatus "issued".
    mockSummaries.mockResolvedValue([{ jobId: A1, goodsStatus: "issued" }]);
    stageIssued({ [`${A1}-k1`]: 3, [`${A1}-k2`]: 2 }); // both lines fully issued (misc 2/2)

    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.total).toBe(0);
    expect(res.rows).toHaveLength(0);
  });

  it("KEEPS a misc-only job visible everywhere while its misc line is still outstanding", async () => {
    mockFindActive.mockResolvedValue([miscOnlyJob(A1, "JOB-0015")]);
    // Misc still pending ⇒ postIssue keeps the job "partially_issued".
    mockSummaries.mockResolvedValue([{ jobId: A1, goodsStatus: "partially_issued" }]);
    stageIssued({ [`${A1}-k1`]: 3 }); // misc line (k2) still 0/2 → outstanding

    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.total).toBe(1);
    expect(res.rows[0].jobNumber).toBe("JOB-0015");
  });

  it("drops a misc-done job whose only OUTSTANDING line belongs to another warehouse", async () => {
    // The real-world case: job-level goodsStatus is "partially_issued", but that's driven by a real
    // line at ANOTHER warehouse — the misc line here is already 2/2. Nothing is actionable at this
    // warehouse, so the job must not appear. Proves the filter can't lean on goodsStatus alone.
    mockFindActive.mockResolvedValue([miscOnlyJob(A1, "JOB-0015")]);
    mockSummaries.mockResolvedValue([{ jobId: A1, goodsStatus: "partially_issued" }]);
    // Misc line fully issued (2/2); the other-warehouse real line is still short (0/3) — which is
    // what keeps the JOB-level status at "partially_issued" while leaving nothing to do HERE.
    stageIssued({ [`${A1}-k2`]: 2 });

    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.total).toBe(0);
    expect(res.rows).toHaveLength(0);
  });

  it("keeps a job with a real line at THIS warehouse even when everything is issued", async () => {
    // Guards the fix: filtering must key on "no actionable line here", never on goodsStatus alone —
    // a fully-issued job still needs its returns processed at the warehouse that issued it.
    mockFindActive.mockResolvedValue([job(A1, "JOB-0024")]);
    mockSummaries.mockResolvedValue([{ jobId: A1, goodsStatus: "issued" }]);
    const res = await listQueue({ warehouseId: WH_ID });
    expect(res.total).toBe(1);
    expect(res.rows[0].jobNumber).toBe("JOB-0024");
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
const mockFindEngBalTxForReturn = engineerStockRepo.findEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockUpsertEngForReturn = engineerStockRepo.upsertEngineerBalanceTx as ReturnType<typeof vi.fn>;
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

  // A van-sourced line's kit line is homed at some other warehouse, so it carries no snapshot that is
  // valid HERE. Persisting null would leave the movement without the warehouse labels that keep
  // history readable after a rename, so the receiving warehouse's own labels are resolved instead.
  it("van return at another warehouse: credits the SCANNING warehouse and snapshots its labels", async () => {
    const OTHER_WH = "e".repeat(24);
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["k1", [{ transferCode: "ENG-1", engineerName: "sahul FE", quantity: 10, status: "completed" }]]]),
    );
    (warehouseRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: OTHER_WH, name: "London Logistics Hub", code: "WH-0005" });

    await postReturn(
      JOB_ID,
      {
        direction: "return", warehouseId: OTHER_WH,
        lines: [{ source: "irm", irmItemId: IRM_ID, qty: 3, condition: "good", scannedCode: "IRM-0004", jobKitLineId: "k1" }],
      },
      { email: "wm@x.com" } as never,
    );

    // Stock lands where it physically arrived, not at the line's nominal home.
    expect(mockApplyInbound.mock.calls[0][1]).toMatchObject({ warehouseId: OTHER_WH, quantity: 3 });
    const header = mockCreateMovement.mock.calls[0][0];
    expect(header).toMatchObject({ warehouseId: OTHER_WH, warehouseName: "London Logistics Hub", warehouseCode: "WH-0005" });
  });

  it("MIXED line: accepts the van portion at another warehouse and credits it", async () => {
    const OTHER_WH = "e".repeat(24);
    // k1 issued 10, of which 4 came from a van ⇒ 4 returnable away from home, crediting OTHER_WH.
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 10 }] }]);
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["k1", [{ transferCode: "ENG-1", engineerName: "sahul FE", quantity: 4, status: "completed" }]]]),
    );
    (warehouseRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: OTHER_WH, name: "London Logistics Hub", code: "WH-0005" });

    await postReturn(
      JOB_ID,
      { direction: "return", warehouseId: OTHER_WH, lines: [{ source: "irm", irmItemId: IRM_ID, qty: 4, condition: "good", scannedCode: "IRM-0004", jobKitLineId: "k1" }] },
      { email: "wm@x.com" } as never,
    );
    expect(mockApplyInbound.mock.calls[0][1]).toMatchObject({ warehouseId: OTHER_WH, quantity: 4 });
  });

  it("MIXED line: rejects more than the van portion at another warehouse", async () => {
    const OTHER_WH = "e".repeat(24);
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 10 }] }]);
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["k1", [{ transferCode: "ENG-1", engineerName: "sahul FE", quantity: 4, status: "completed" }]]]),
    );
    (warehouseRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: OTHER_WH, name: "London Logistics Hub", code: "WH-0005" });

    // 5 requested but only 4 are van-sourced ⇒ the 5th owes its home warehouse.
    await expect(
      postReturn(JOB_ID, { direction: "return", warehouseId: OTHER_WH, lines: [{ source: "irm", irmItemId: IRM_ID, qty: 5, condition: "good", scannedCode: "IRM-0004", jobKitLineId: "k1" }] }, { email: "wm@x.com" } as never),
    ).rejects.toThrow(/came from a van|home warehouse/i);
    expect(mockApplyInbound).not.toHaveBeenCalled();
  });

  it("resolves the EXACT scanned kit line for an away return, not a fresh capacity re-pick", async () => {
    // Same IRM item on TWO kit lines homed at TWO different warehouses (WH-A, WH-B), returned at a
    // THIRD (WH-C). The client sends the line it scanned (kA). A capacity-based re-pick would prefer
    // kB (van 10 > kA's 3) and then size kA's budget with kB's home — miscounting kA's own home-return
    // at WH-A as "away" and wrongly rejecting. Using the client's line keeps home/van consistent.
    const WH_A = "a".repeat(24), WH_B = "e".repeat(24), WH_C = "f".repeat(24);
    mockJob.mockResolvedValue({
      ...returnBaseJob,
      kitLines: [
        { id: "kA", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_A, itemName: "CAT6", qty: 5, warehouseName: "A", warehouseCode: "A" },
        { id: "kB", lineType: "irm", irmItemId: IRM_ID, customerStockEntryId: null, warehouseId: WH_B, itemName: "CAT6", qty: 10, warehouseName: "B", warehouseCode: "B" },
      ],
    });
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", items: [{ jobKitLineId: "kA", qty: 5 }, { jobKitLineId: "kB", qty: 10 }] },
      // kA already had 2 returned at its OWN home (WH-A) — a home return, must NOT count against kA's away budget.
      { status: "posted", direction: "return", warehouseId: WH_A, items: [{ jobKitLineId: "kA", qty: 2 }] },
    ]);
    (transferRepo.findVanSourcesByKitLines as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([
        ["kA", [{ transferCode: "ENG-1", engineerName: "sahul FE", quantity: 3, status: "completed" }]],
        ["kB", [{ transferCode: "ENG-2", engineerName: "ravi FE", quantity: 10, status: "completed" }]],
      ]),
    );
    (warehouseRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: WH_C, name: "London Logistics Hub", code: "WH-0005" });

    // kA: van 3, one already returned away? No — the 2 at WH-A are home returns. So 3 still returnable
    // away. Returning 2 of kA's van at WH-C must SUCCEED (budget 3 ≥ 2), not be rejected.
    await postReturn(
      JOB_ID,
      { direction: "return", warehouseId: WH_C, lines: [{ source: "irm", irmItemId: IRM_ID, qty: 2, condition: "good", scannedCode: "IRM-0004", jobKitLineId: "kA" }] },
      { email: "wm@x.com" } as never,
    );
    expect(mockApplyInbound.mock.calls[0][1]).toMatchObject({ warehouseId: WH_C, quantity: 2 });
  });

  it("ordinary same-warehouse return keeps the kit line's snapshot (no extra warehouse lookup)", async () => {
    await postReturn(
      JOB_ID,
      {
        direction: "return", warehouseId: WH_ID,
        lines: [{ source: "irm", irmItemId: IRM_ID, qty: 3, condition: "good", scannedCode: "IRM-0004", jobKitLineId: "k1" }],
      },
      { email: "wm@x.com" } as never,
    );
    expect(mockCreateMovement.mock.calls[0][0]).toMatchObject({ warehouseName: "WH1", warehouseCode: "W1" });
    expect(warehouseRepo.findById).not.toHaveBeenCalled();
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
const mockFindEngBalTx = engineerStockRepo.findEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockUpsertEngBalTx = engineerStockRepo.upsertEngineerBalanceTx as ReturnType<typeof vi.fn>;
const mockInsertEngTxnTx = engineerStockRepo.insertEngineerTxnTx as ReturnType<typeof vi.fn>;
// Non-tx batch holdings used by closeReconcile / getJobKitTallies to cap "unaccounted" / "remaining"
// at the engineer's REAL held balance.
const mockFindEngBalancesAll = engineerStockRepo.findEngineerBalances as ReturnType<typeof vi.fn>;
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

// ── getDamagedHistory ────────────────────────────────────────────────────────────────────────
import { getDamagedHistory } from "./goods-management.service.js";

const mockFindDamagedBalance = repo.findDamagedBalance as ReturnType<typeof vi.fn>;
const mockFindDamagedTxnsByKey = repo.findDamagedTxnsByKey as ReturnType<typeof vi.fn>;

const COMPANY_KEY = { warehouseId: WH_ID, ownerType: "company", irmItemId: IRM_ID, customerStockEntryId: null };
const txn = (over: Record<string, unknown> = {}) => ({
  id: "t1", createdAt: new Date("2026-07-21T10:00:00Z"), quantityDelta: 1, balanceAfter: 1,
  reason: "Crushed in transit", notes: null, photoUrl: "https://cdn/p1.jpg",
  sourceType: "goods_management_return", sourceCode: "GM-0001", createdBy: "wh@x.com", ...over,
});

describe("getDamagedHistory", () => {
  beforeEach(() => {
    mockFindDamagedBalance.mockResolvedValue({
      id: "dmg1", warehouseId: WH_ID, ownerType: "company", irmItemId: IRM_ID,
      customerStockEntryId: null, itemName: "CAT6", quantity: 2,
    });
    mockFindDamagedTxnsByKey.mockResolvedValue([txn()]);
  });

  it("returns EVERY report — not just the latest, which is the whole point of the drill-down", async () => {
    // Two reports for the SAME item: the list row can only show reason #2 next to a quantity of 2,
    // so report #1's reason and photo must come back here or they are unreachable in the product.
    mockFindDamagedTxnsByKey.mockResolvedValue([
      txn({ id: "t2", reason: "Water damage", photoUrl: "https://cdn/p2.jpg", balanceAfter: 2 }),
      txn({ id: "t1", reason: "Crushed in transit", photoUrl: "https://cdn/p1.jpg", balanceAfter: 1 }),
    ]);
    const res = await getDamagedHistory(COMPANY_KEY);
    expect(res.entries).toHaveLength(2);
    expect(res.entries.map((e) => e.reason)).toEqual(["Water damage", "Crushed in transit"]);
    expect(res.entries.map((e) => e.photoUrl)).toEqual(["https://cdn/p2.jpg", "https://cdn/p1.jpg"]);
    expect(res.quantity).toBe(2); // the balance total the entries reconcile to
  });

  it("derives the entry type from the sign of quantityDelta", async () => {
    mockFindDamagedTxnsByKey.mockResolvedValue([
      txn({ id: "t2", quantityDelta: -1, reason: "restore", balanceAfter: 0 }),
      txn({ id: "t1", quantityDelta: 2, balanceAfter: 1 }),
    ]);
    const res = await getDamagedHistory(COMPANY_KEY);
    expect(res.entries.map((e) => e.type)).toEqual(["restore", "write_off"]);
  });

  it("404s when no damaged balance exists for the key", async () => {
    mockFindDamagedBalance.mockResolvedValue(null);
    await expect(getDamagedHistory(COMPANY_KEY)).rejects.toMatchObject({ status: 404 });
    expect(mockFindDamagedTxnsByKey).not.toHaveBeenCalled();
  });

  it("403s for a warehouse-scoped actor drilling into a warehouse they aren't assigned", async () => {
    const actor = { type: "user" as const, email: "wm@x.com", assignedWarehouseIds: ["other".padEnd(24, "0")] };
    await expect(getDamagedHistory(COMPANY_KEY, actor)).rejects.toMatchObject({ status: 403 });
    // Guard runs BEFORE any read — a 403 must not leak whether the balance even exists.
    expect(mockFindDamagedBalance).not.toHaveBeenCalled();
  });

  it("allows a warehouse-scoped actor for a warehouse they ARE assigned", async () => {
    const actor = { type: "user" as const, email: "wm@x.com", assignedWarehouseIds: [WH_ID] };
    const res = await getDamagedHistory(COMPANY_KEY, actor);
    expect(res.entries).toHaveLength(1);
  });

  it("reports truncation instead of silently dropping older entries", async () => {
    // The repo is asked for cap+1 so a full page is distinguishable; 201 rows ⇒ 200 shown + flag.
    mockFindDamagedTxnsByKey.mockResolvedValue(Array.from({ length: 201 }, (_, i) => txn({ id: `t${i}` })));
    const res = await getDamagedHistory(COMPANY_KEY);
    expect(res.entries).toHaveLength(200);
    expect(res.truncated).toBe(true);
  });

  it("is not truncated at exactly the cap", async () => {
    mockFindDamagedTxnsByKey.mockResolvedValue(Array.from({ length: 200 }, (_, i) => txn({ id: `t${i}` })));
    const res = await getDamagedHistory(COMPANY_KEY);
    expect(res.entries).toHaveLength(200);
    expect(res.truncated).toBe(false);
  });

  it("queries with the customer socket for customer-owned damage", async () => {
    const key = { warehouseId: WH_ID, ownerType: "customer", irmItemId: null, customerStockEntryId: CSE_ID };
    mockFindDamagedBalance.mockResolvedValue({
      id: "dmg2", warehouseId: WH_ID, ownerType: "customer", irmItemId: null,
      customerStockEntryId: CSE_ID, itemName: "SFP-LX", quantity: 1,
    });
    await getDamagedHistory(key);
    expect(mockFindDamagedTxnsByKey).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "customer", customerStockEntryId: CSE_ID, irmItemId: null }),
      expect.any(Number),
    );
  });

  it("exposes no cost or value fields", async () => {
    const res = await getDamagedHistory(COMPANY_KEY);
    for (const e of res.entries) {
      expect(Object.keys(e)).not.toContain("cost");
      expect(Object.keys(e)).not.toContain("value");
    }
  });
});

// ── reportWarehouseDamage (damage found on stock already in the warehouse) ────────────────────
import { reportWarehouseDamage } from "./goods-management.service.js";

// mockUpsertDamagedBalance / mockInsertDamagedTxn are already declared above (the postReturn block).
const mockFindCustomerEntry = repo.findCustomerStockEntryById as ReturnType<typeof vi.fn>;
const mockAdjustCustomerQty = repo.adjustCustomerStockEntryQtyTx as ReturnType<typeof vi.fn>;
const mockUpsertInvBalance = inventoryRepo.upsertBalanceTx as ReturnType<typeof vi.fn>;
const mockInsertInvTxn = inventoryRepo.insertTransactionTx as ReturnType<typeof vi.fn>;
const mockWarehouseById = warehouseRepo.findById as ReturnType<typeof vi.fn>;
const mockRequireIrm = irmService.requireActiveIrmItem as ReturnType<typeof vi.fn>;

const COMPANY_DAMAGE = {
  warehouseId: WH_ID, ownerType: "company" as const, irmItemId: IRM_ID, customerStockEntryId: undefined,
  quantity: 2, reason: "Crushed by forklift", damagePhotoUrl: "https://cdn/dmg.jpg", notes: "aisle 3",
};

describe("reportWarehouseDamage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWarehouseById.mockResolvedValue({ id: WH_ID, name: "London Hub" });
    mockRequireIrm.mockResolvedValue({ id: IRM_ID, name: "CAT6", trackSerialNumbers: false, trackBatchNumbers: false });
    mockUpsertDamagedBalance.mockResolvedValue({ id: "dmg1", quantity: 5 });
    mockUpsertInvBalance.mockResolvedValue({ quantityOnHand: 8 });
    mockAdjustCustomerQty.mockResolvedValue({ quantity: 13 });
    mockFindCustomerEntry.mockResolvedValue({
      id: CSE_ID, warehouseId: WH_ID, itemName: "Router", customerId: "cust1", quantity: 15,
    });
  });

  it("moves company stock OUT of inventory and INTO the damaged pool", async () => {
    const res = await reportWarehouseDamage(COMPANY_DAMAGE);
    // Usable stock decremented by the damaged quantity (negative delta).
    expect(mockUpsertInvBalance).toHaveBeenCalledWith({}, IRM_ID, WH_ID, -2);
    // Damaged pool credited by the same amount.
    expect(mockUpsertDamagedBalance).toHaveBeenCalledWith({}, expect.objectContaining({ ownerType: "company", irmItemId: IRM_ID }), 2);
    expect(res).toMatchObject({ quantityDamaged: 2, damagedBalanceAfter: 5, usableBalanceAfter: 8 });
  });

  it("writes the reason and photo to the damaged ledger — the evidence the pool exists for", async () => {
    await reportWarehouseDamage(COMPANY_DAMAGE);
    expect(mockInsertDamagedTxn).toHaveBeenCalledWith({}, expect.objectContaining({
      quantityDelta: 2,
      reason: "Crushed by forklift",
      photoUrl: "https://cdn/dmg.jpg",
      notes: "aisle 3",
      sourceType: "warehouse_damage_report",
      balanceAfter: 5,
    }));
  });

  it("labels the inventory movement 'write_off' so the movement history reads correctly", async () => {
    await reportWarehouseDamage(COMPANY_DAMAGE);
    expect(mockInsertInvTxn).toHaveBeenCalledWith({}, expect.objectContaining({
      quantityDelta: -2, type: "write_off", sourceType: "warehouse_damage_report",
    }));
  });

  it("debits the customer's entry — NOT company inventory — for customer-owned stock", async () => {
    const res = await reportWarehouseDamage({
      ...COMPANY_DAMAGE, ownerType: "customer", irmItemId: undefined, customerStockEntryId: CSE_ID,
    });
    expect(mockAdjustCustomerQty).toHaveBeenCalledWith({}, CSE_ID, -2);
    expect(mockUpsertInvBalance).not.toHaveBeenCalled(); // company inventory untouched
    expect(res.usableBalanceAfter).toBe(13);
  });

  it("nulls the unused owner socket so the damaged row is keyed correctly", async () => {
    // A company balance is stored with customerStockEntryId null (and vice versa) — carrying both
    // would create a row neither the damaged list nor the history drill-down could ever match.
    await reportWarehouseDamage({ ...COMPANY_DAMAGE, customerStockEntryId: CSE_ID });
    expect(mockUpsertDamagedBalance).toHaveBeenCalledWith(
      {}, expect.objectContaining({ irmItemId: IRM_ID, customerStockEntryId: null }), 2,
    );
  });

  it("403s for a warehouse-scoped actor reporting into a warehouse they aren't assigned", async () => {
    const actor = { type: "user" as const, email: "wm@x.com", assignedWarehouseIds: ["other".padEnd(24, "0")] };
    await expect(reportWarehouseDamage(COMPANY_DAMAGE, actor)).rejects.toMatchObject({ status: 403 });
    expect(mockUpsertDamagedBalance).not.toHaveBeenCalled(); // rejected before any write
  });

  it("refuses serial/batch-tracked items (the damaged pool is quantity-only)", async () => {
    mockRequireIrm.mockResolvedValue({ id: IRM_ID, name: "Router", trackSerialNumbers: true, trackBatchNumbers: false });
    await expect(reportWarehouseDamage(COMPANY_DAMAGE)).rejects.toMatchObject({ status: 409 });
    expect(mockUpsertDamagedBalance).not.toHaveBeenCalled();
  });

  it("refuses customer stock that isn't held at this warehouse", async () => {
    mockFindCustomerEntry.mockResolvedValue({ id: CSE_ID, warehouseId: "zzz".padEnd(24, "0"), itemName: "Router", customerId: "cust1" });
    await expect(
      reportWarehouseDamage({ ...COMPANY_DAMAGE, ownerType: "customer", irmItemId: undefined, customerStockEntryId: CSE_ID }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mockUpsertDamagedBalance).not.toHaveBeenCalled();
  });

  it("404s when the customer stock entry doesn't exist", async () => {
    mockFindCustomerEntry.mockResolvedValue(null);
    await expect(
      reportWarehouseDamage({ ...COMPANY_DAMAGE, ownerType: "customer", irmItemId: undefined, customerStockEntryId: CSE_ID }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ── restoreDamaged — warehouse scoping ───────────────────────────────────────────────────────
import { restoreDamaged } from "./goods-management.service.js";

describe("restoreDamaged (warehouse scoping)", () => {
  it("403s for a warehouse-scoped actor restoring into a warehouse they aren't assigned", async () => {
    // A restore WRITES: it takes units out of the damaged pool and credits usable stock at that
    // warehouse. The balance is addressed by its natural key, not by an id the caller could only
    // have got from a permitted read — so the guard is the only thing stopping a scoped manager
    // from crediting stock into someone else's warehouse. It was missing until this was added.
    mockFindDamagedBalance.mockClear();
    const actor = { type: "user" as const, email: "wm@x.com", assignedWarehouseIds: ["other".padEnd(24, "0")] };
    await expect(
      restoreDamaged({ warehouseId: WH_ID, ownerType: "company", irmItemId: IRM_ID, quantity: 1, notes: "n" }, actor),
    ).rejects.toMatchObject({ status: 403 });
    // Rejected before ANY read or write — nothing about the other warehouse's stock is disclosed.
    expect(mockFindDamagedBalance).not.toHaveBeenCalled();
  });
});

// ── listOverdue ──────────────────────────────────────────────────────────────────────────────
import { getOverdueSummary, getOverdueView, listOverdue } from "./goods-management.service.js";
import * as settingsService from "#modules/settings/settings.service.js";

const mockFindRecentMovementsForOverdue = repo.findOldIssueMovementsForJobs as ReturnType<typeof vi.fn>;

describe("listOverdue", () => {
  // The read now STARTS from open jobs (indexed goodsStatus) and only then looks at their movements,
  // so the cost tracks work in flight instead of the whole ledger. These two mocks are that order.
  const mockOverdueSummaries = repo.getSummariesByJobs as ReturnType<typeof vi.fn>;
  const mockActiveJobIds = jobRepo.findGoodsActiveJobIds as ReturnType<typeof vi.fn>;
  const mockKitLineTypes = jobRepo.findKitLineTypesByJobs as ReturnType<typeof vi.fn>;
  const mockAllMovements = repo.findMovementsByJobs as ReturnType<typeof vi.fn>;
  const KIT_LINE = "k-overdue";

  // A job is only overdue while stock is genuinely still out, so every case here has to stage the
  // netting inputs: one stock-tracked kit line, and the job's full movement history.
  const stageOutstanding = (issued: number, used = 0, returned = 0) => {
    mockKitLineTypes.mockResolvedValue([{ id: JOB_ID, kitLines: [{ id: KIT_LINE, lineType: "irm" }] }]);
    const moves = [{ jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: KIT_LINE, qty: issued }] }];
    if (used) moves.push({ jobId: JOB_ID, status: "posted", direction: "consume", items: [{ jobKitLineId: KIT_LINE, qty: used }] });
    if (returned) moves.push({ jobId: JOB_ID, status: "posted", direction: "return", items: [{ jobKitLineId: KIT_LINE, qty: returned }] });
    mockAllMovements.mockResolvedValue(moves);
  };

  beforeEach(() => {
    mockActiveJobIds.mockResolvedValue([{ id: JOB_ID }]);
    stageOutstanding(5); // 5 issued, nothing back — genuinely out
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
    mockOverdueSummaries.mockResolvedValue([{ jobId: JOB_ID, goodsStatus: "issued" }]);
  });

  it("returns issue movements older than the cutoff whose job is not reconciled", async () => {
    const { rows } = await listOverdue();
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

  // The ledger only grows; open jobs track work in flight. Asking the summaries FIRST and constraining
  // the movement query to those job ids is what stops this read getting slower every month on its own.
  it("drives from open jobs and scopes the movement query to them", async () => {
    await listOverdue();
    expect(mockActiveJobIds).toHaveBeenCalledTimes(1);
    expect(mockFindRecentMovementsForOverdue).toHaveBeenCalledWith([JOB_ID], expect.any(Date), undefined);
  });

  it("does no movement work at all when nothing is open", async () => {
    mockActiveJobIds.mockResolvedValue([]);
    const page = await listOverdue();
    expect(page.rows).toHaveLength(0);
    expect(page.total).toBe(0);
    expect(mockFindRecentMovementsForOverdue).not.toHaveBeenCalled();
  });

  // The Goods Management tab is per-warehouse and its other sections are scoped, but this one asked
  // for every warehouse the actor could reach — so Warehouse A's tab listed Warehouse B's overdue
  // jobs. Scoping happens in the QUERY, not after the fact.
  it("scopes the query to one warehouse when given a warehouseId", async () => {
    await listOverdue(undefined, { warehouseId: "wh-A" });
    expect(mockFindRecentMovementsForOverdue).toHaveBeenCalledWith([JOB_ID], expect.any(Date), "wh-A");
  });

  it("asks for every warehouse when no warehouseId is given (the company-wide read)", async () => {
    await listOverdue();
    expect(mockFindRecentMovementsForOverdue).toHaveBeenCalledWith([JOB_ID], expect.any(Date), undefined);
  });

  it("excludes a job once its summary says reconciled", async () => {
    mockOverdueSummaries.mockResolvedValue([{ jobId: JOB_ID, goodsStatus: "reconciled" }]);
    expect((await listOverdue()).rows).toHaveLength(0);
  });

  // The direction matters: jobs are excluded by PROOF of reconciliation, never included by proof of
  // openness. `recomputeGoodsStatus` is best-effort and swallows failures, so an unreturned issue can
  // exist with no summary row at all — dropping it would be a silent false negative on a chase list,
  // and listQueue makes the same call (missing summary → "not_issued", not excluded).
  it("keeps a job that has NO summary row at all", async () => {
    mockOverdueSummaries.mockResolvedValue([]);
    const { rows } = await listOverdue();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: JOB_ID, goodsStatus: "issued" });
  });

  // The status lookup is ONE query, however many jobs and movements the window spans. It used to run
  // per iteration, and a reconciled job re-queried on every one of its movements because it
  // `continue`d without being marked seen.
  it("looks up job status in a single batched query", async () => {
    await listOverdue();
    expect(mockOverdueSummaries).toHaveBeenCalledTimes(1);
  });

  // "Overdue" has to mean stock is genuinely still out. Posting a return leaves the job at
  // "awaiting_return" no matter what came back, and only an explicit Close & reconcile clears that —
  // so testing the status alone kept fully-returned jobs on the chase list, day count climbing,
  // offering to write off as lost stock that was already back on the shelf.
  describe("only lists stock that is actually still out", () => {
    it("drops a job whose stock has all been returned, even though it isn't reconciled yet", async () => {
      stageOutstanding(5, 0, 5); // 5 issued, 5 returned → nothing out
      expect((await listOverdue()).rows).toHaveLength(0);
    });

    it("drops a job whose stock was all consumed on site", async () => {
      stageOutstanding(5, 5, 0);
      expect((await listOverdue()).rows).toHaveLength(0);
    });

    it("keeps a job that is only PARTLY back", async () => {
      stageOutstanding(5, 1, 2); // 5 − 1 used − 2 returned = 2 still out
      expect((await listOverdue()).rows).toHaveLength(1);
    });

    // misc lines are free-text and never stock-tracked, so they can't be handed back. Counting them
    // as outstanding would pin the job to this list permanently.
    it("ignores misc lines when deciding whether anything is out", async () => {
      mockKitLineTypes.mockResolvedValue([{ id: JOB_ID, kitLines: [{ id: "k-misc", lineType: "misc" }] }]);
      mockAllMovements.mockResolvedValue([
        { jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: "k-misc", qty: 3 }] },
      ]);
      expect((await listOverdue()).rows).toHaveLength(0);
    });
  });

  // These three were declared by the frontend's OverdueRow but never sent, so the "Days out" column
  // and the movement code rendered blank and every row's React key was undefined.
  it("returns the movement identity and a server-computed daysOut", async () => {
    const { rows } = await listOverdue();
    expect(rows[0]).toMatchObject({ movementId: "m1", movementCode: "GM-0001" });
    expect(rows[0].daysOut).toBe(20); // the staged movement is 20 days old
  });

  // Paging and search exist because this list is NOT guaranteed small — a busy operation can have
  // hundreds of jobs overdue at once. Both are applied AFTER the still-out filter, so `total` and the
  // page numbers describe the same set the user is looking at rather than the raw candidate pool.
  describe("paging and search", () => {
    const JOB_B = "b".repeat(24);
    // Two overdue jobs: the staged one (JOB-0001 / Bob Smith) plus a second, newer one.
    const stageTwoJobs = () => {
      mockActiveJobIds.mockResolvedValue([{ id: JOB_ID }, { id: JOB_B }]);
      mockOverdueSummaries.mockResolvedValue([
        { jobId: JOB_ID, goodsStatus: "issued" },
        { jobId: JOB_B, goodsStatus: "issued" },
      ]);
      mockFindRecentMovementsForOverdue.mockResolvedValue([
        { id: "m1", code: "GM-0001", jobId: JOB_ID, direction: "issue", status: "posted", engineerId: ENG_ID, engineerName: "Bob Smith", warehouseId: WH_ID, createdAt: new Date(Date.now() - 40 * 86_400_000), job: { id: JOB_ID, jobNumber: "JOB-0001", name: "Fibre install" }, items: [] },
        { id: "m2", code: "GM-0002", jobId: JOB_B, direction: "issue", status: "posted", engineerId: ENG_ID, engineerName: "Ann Green", warehouseId: WH_ID, createdAt: new Date(Date.now() - 20 * 86_400_000), job: { id: JOB_B, jobNumber: "JOB-0002", name: "Patch panel" }, items: [] },
      ]);
      mockKitLineTypes.mockResolvedValue([
        { id: JOB_ID, kitLines: [{ id: "ka", lineType: "irm" }] },
        { id: JOB_B, kitLines: [{ id: "kb", lineType: "irm" }] },
      ]);
      mockAllMovements.mockResolvedValue([
        { jobId: JOB_ID, status: "posted", direction: "issue", items: [{ jobKitLineId: "ka", qty: 5 }] },
        { jobId: JOB_B, status: "posted", direction: "issue", items: [{ jobKitLineId: "kb", qty: 5 }] },
      ]);
    };

    it("pages the result, longest overdue first", async () => {
      stageTwoJobs();
      const first = await listOverdue(undefined, { page: 1, pageSize: 1 });
      expect(first).toMatchObject({ total: 2, totalPages: 2, page: 1 });
      expect(first.rows.map((r) => r.jobNumber)).toEqual(["JOB-0001"]); // 40 days out

      const second = await listOverdue(undefined, { page: 2, pageSize: 1 });
      expect(second.rows.map((r) => r.jobNumber)).toEqual(["JOB-0002"]); // 20 days out
    });

    it("clamps a page beyond the end rather than returning nothing", async () => {
      stageTwoJobs();
      const page = await listOverdue(undefined, { page: 99, pageSize: 1 });
      expect(page.page).toBe(2);
      expect(page.rows).toHaveLength(1);
    });

    it("searches job number, job name and engineer name", async () => {
      stageTwoJobs();
      expect((await listOverdue(undefined, { search: "JOB-0002" })).rows.map((r) => r.jobNumber)).toEqual(["JOB-0002"]);
      expect((await listOverdue(undefined, { search: "patch" })).rows.map((r) => r.jobNumber)).toEqual(["JOB-0002"]);
      expect((await listOverdue(undefined, { search: "bob" })).rows.map((r) => r.jobNumber)).toEqual(["JOB-0001"]);
    });

    // A search that narrows to one row must say "1", not "2 with one shown" — the count and the rows
    // have to come from the same filtered set or the pager offers pages that aren't there.
    it("counts the SEARCHED set, not the whole one", async () => {
      stageTwoJobs();
      expect(await listOverdue(undefined, { search: "patch" })).toMatchObject({ total: 1, totalPages: 1 });
    });

    // Regex-special characters are why this matches in memory rather than through a Mongo `contains`.
    it("treats a regex-special search term as plain text", async () => {
      stageTwoJobs();
      expect((await listOverdue(undefined, { search: "JOB-000(" })).rows).toHaveLength(0);
    });

    // The Hub wants the number, not the rows — asking for a 1-row page keeps it from building
    // hundreds of row objects just to read a length off them.
    it("getOverdueSummary returns the full total from a one-row page", async () => {
      stageTwoJobs();
      expect((await getOverdueSummary()).count).toBe(2);
    });
  });

  // The window is configuration, not a constant. An admin who sets 30 days must move the Overdue list
  // AND the Hub figure together; an explicit `days` is only an ad-hoc override for one read.
  describe("configured window", () => {
    const mockConfiguredDays = settingsService.getOverdueAfterDays as ReturnType<typeof vi.fn>;

    it("uses the configured window when the caller passes no days", async () => {
      mockConfiguredDays.mockResolvedValue(30);
      await listOverdue();
      const cutoff = mockFindRecentMovementsForOverdue.mock.calls[0][1] as Date;
      expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(30);
    });

    // There is deliberately NO way for a caller to ask for a different window — that override was the
    // seam through which a caller could produce a list of jobs that aren't overdue by the company's
    // rule, which is exactly the bug the UI picker caused. Settings is the only input.
    it("takes the window ONLY from settings — no caller override exists", async () => {
      mockConfiguredDays.mockResolvedValue(30);
      await listOverdue(undefined, { warehouseId: "wh-A" });
      const cutoff = mockFindRecentMovementsForOverdue.mock.calls[0][1] as Date;
      expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(30);
    });

    // The Hub has no window control of its own — it must follow Settings, never a hardcoded fortnight.
    it("getOverdueSummary follows the configured window", async () => {
      mockConfiguredDays.mockResolvedValue(45);
      await getOverdueSummary();
      const cutoff = mockFindRecentMovementsForOverdue.mock.calls[0][1] as Date;
      expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(45);
    });

    // The screen prints this number, so it has to be the one the query actually ran with.
    it("getOverdueView reports back the window it used", async () => {
      mockConfiguredDays.mockResolvedValue(21);
      expect((await getOverdueView()).days).toBe(21);
    });

    // One settings read per request, not one per layer — the view resolves the window and hands it
    // down rather than the list looking it up again.
    it("reads the setting once per request", async () => {
      mockConfiguredDays.mockClear().mockResolvedValue(21);
      await getOverdueView();
      expect(mockConfiguredDays).toHaveBeenCalledTimes(1);
    });
  });

  // One implementation, so the Hub card and the Overdue tab cannot drift apart again.
  it("getOverdueSummary counts jobs, not movements", async () => {
    mockFindRecentMovementsForOverdue.mockResolvedValue([
      { id: "m1", code: "GM-0001", jobId: JOB_ID, direction: "issue", status: "posted", engineerId: ENG_ID, engineerName: "Bob", warehouseId: WH_ID, createdAt: new Date(Date.now() - 20 * 86_400_000), job: { id: JOB_ID, jobNumber: "JOB-0001", name: "T", customerId: "c", customerName: "A" }, items: [] },
      { id: "m2", code: "GM-0002", jobId: JOB_ID, direction: "issue", status: "posted", engineerId: ENG_ID, engineerName: "Bob", warehouseId: WH_ID, createdAt: new Date(Date.now() - 19 * 86_400_000), job: { id: JOB_ID, jobNumber: "JOB-0001", name: "T", customerId: "c", customerName: "A" }, items: [] },
    ]);
    expect((await getOverdueSummary()).count).toBe(1);
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
    const { rows } = await listOverdue();
    // The same job appears only once even with two issue movements.
    expect(rows).toHaveLength(1);
  });
});

import { dueStateOf, dueWindow } from "./goods-management.service.js";

// The due window is resolved from the SERVER's clock. It is the only date filter on the active queue,
// and it deliberately reads Job.completionDate rather than the last-activity timestamp the Closed tab
// uses: a job raised for today with nothing issued has NO activity, so an activity window would hide
// exactly the work "what's due today" is asking about.
describe("dueWindow", () => {
  // Mid-afternoon, so a naive implementation using `now` as an edge would visibly cut the day short.
  const now = new Date("2026-08-03T15:30:00.000Z");
  const TZ = "Europe/London";

  it("overdue = strictly before today began", () => {
    const w = dueWindow("overdue", now, TZ);
    expect(w.from).toBeUndefined(); // no floor — everything still outstanding counts
    expect(w.to!.toISOString()).toBe("2026-08-02T23:59:59.999Z");
  });

  it("today covers the WHOLE day, not up to the current moment", () => {
    const w = dueWindow("today", now, TZ);
    expect(w.from!.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(w.to!.toISOString()).toBe("2026-08-03T23:59:59.999Z");
  });

  it("week is today plus the next six days, inclusive", () => {
    const w = dueWindow("week", now, TZ);
    expect(w.from!.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(w.to!.toISOString()).toBe("2026-08-09T23:59:59.999Z");
  });

  // Overdue is its own filter; a planning horizon that silently swept in last month's misses would
  // make "this week" the only filter anyone ever needed and hide the distinction that matters.
  it("week does NOT reach backwards into overdue work", () => {
    expect(dueWindow("week", now, TZ).from!.getTime()).toBe(dueWindow("today", now, TZ).from!.getTime());
  });
  // 00:30 BST on 4 Aug is 23:30 UTC on the 3rd. Deriving the day from getUTCDate() answered "3 Aug"
  // — so for the first hour of every British Summer Time day, a UK manager was shown YESTERDAY's due
  // jobs, and the dashboard card above the queue said the same. Seven months of the year.
  it("uses the UK calendar day, not UTC, during BST", () => {
    const justAfterUkMidnight = new Date("2026-08-03T23:30:00.000Z"); // 00:30 on 4 Aug in London
    const w = dueWindow("today", justAfterUkMidnight, "Europe/London");
    expect(w.from!.toISOString()).toBe("2026-08-04T00:00:00.000Z");
  });

  // In winter the UK is on UTC, so nothing shifts — the fix must not move a date that was correct.
  it("is unchanged in winter, when the UK is on UTC", () => {
    const w = dueWindow("today", new Date("2026-01-15T23:30:00.000Z"), "Europe/London");
    expect(w.from!.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("falls back to UTC rather than throwing on an unusable timezone", () => {
    expect(dueWindow("today", now, "Not/AZone").from!.toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });
});

// The badge on each queue row. It must agree with dueWindow by construction: a row the "Past due"
// filter selected has to WEAR "Past due", or the filter looks broken to the person reading the list.
// That is the whole reason this is computed on the server — a browser deriving it from its own clock
// would disagree the moment the two were in different days.
describe("dueStateOf", () => {
  const now = new Date("2026-08-03T15:30:00.000Z");
  const TZ = "Europe/London";
  const on = (d: string) => new Date(`${d}T00:00:00.000Z`); // how <input type="date"> is stored

  it("reads a date before today as past due", () => {
    expect(dueStateOf(on("2026-08-02"), now, TZ)).toBe("past_due");
  });

  it("reads today's date as today, all day long", () => {
    expect(dueStateOf(on("2026-08-03"), now, TZ)).toBe("today");
  });

  it("reads a later date as upcoming", () => {
    expect(dueStateOf(on("2026-08-04"), now, TZ)).toBe("upcoming");
  });

  // Not a state — the row renders "No due date". Such a job is invisible to EVERY due filter, so the
  // badge is the only thing that explains why it vanishes the moment one is applied.
  it("returns null when the job has no completion date", () => {
    expect(dueStateOf(null, now, TZ)).toBeNull();
  });

  // The pairing that matters: whatever the filter selects, the badge must confirm.
  it("agrees with dueWindow — anything the overdue window admits is badged past due", () => {
    const w = dueWindow("overdue", now, TZ);
    const d = on("2026-08-02");
    expect(d <= w.to!).toBe(true);
    expect(dueStateOf(d, now, TZ)).toBe("past_due");
  });

  it("agrees with dueWindow — the today window's edges both badge as today", () => {
    const w = dueWindow("today", now, TZ);
    expect(dueStateOf(w.from!, now, TZ)).toBe("today");
    expect(dueStateOf(w.to!, now, TZ)).toBe("today");
  });

  // Same BST trap as the window: 23:30 UTC is already tomorrow in London, so a job due 4 Aug must
  // read "today" — not "upcoming" — for the first hour of a British Summer Time day.
  it("uses the UK calendar day during BST", () => {
    const justAfterUkMidnight = new Date("2026-08-03T23:30:00.000Z"); // 00:30 on 4 Aug in London
    expect(dueStateOf(on("2026-08-04"), justAfterUkMidnight, TZ)).toBe("today");
    expect(dueStateOf(on("2026-08-03"), justAfterUkMidnight, TZ)).toBe("past_due");
  });
});
