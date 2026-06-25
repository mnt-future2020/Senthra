import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("../../lib/realtime.js", () => ({ emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "jobs:office" }));
vi.mock("./goods-management.repository.js", () => ({
  createMovementWithCode: vi.fn(), findMovementsByJob: vi.fn(), getSummary: vi.fn(), upsertSummaryTx: vi.fn(),
  upsertCustomerHoldingTx: vi.fn(), findCustomerHoldingTx: vi.fn(), insertCustomerHoldingTxnTx: vi.fn(), findCustomerHoldingsByEngineer: vi.fn(),
  adjustCustomerStockEntryQtyTx: vi.fn(), findCustomerStockEntryById: vi.fn(), findCustomerStockEntryByBarcode: vi.fn(),
  upsertDamagedBalanceTx: vi.fn(), insertDamagedTxnTx: vi.fn(), findDamagedByWarehouse: vi.fn(), findDamagedByCustomer: vi.fn(), findAllDamaged: vi.fn(), findRecentMovementsForOverdue: vi.fn(),
  findLatestDamagedTxnsByBalances: vi.fn(),
}));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn(), findActiveForGoodsManagement: vi.fn(), completeIfInProgressTx: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn(), findActiveByCodeOrBarcode: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancePair: vi.fn(), findBalancePairTx: vi.fn(), upsertBalanceTx: vi.fn(), insertTransactionTx: vi.fn() }));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyOutbound: vi.fn(), applyInbound: vi.fn() }));
vi.mock("#modules/goods-out/goods-out.repository.js", () => ({ upsertEngineerBalanceTx: vi.fn(), insertEngineerTxnTx: vi.fn(), findEngineerBalanceTx: vi.fn() }));
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
    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", code: "IRM-0004" });
    expect(m).toMatchObject({ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", plannedQty: 10, alreadyIssued: 0, remainingIssuable: 10, available: 4 });
  });
  it("rejects a code that isn't on the kit list", async () => {
    mockIrm.mockResolvedValue({ id: "e".repeat(24), code: "IRM-9999", name: "Other", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false });
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", code: "IRM-9999" })).rejects.toThrow(/not on this job/i);
  });
  it("rejects a serial-tracked item", async () => {
    mockIrm.mockResolvedValue({ id: IRM_ID, code: "IRM-0004", name: "SFP", trackInventory: true, trackSerialNumbers: true, trackBatchNumbers: false });
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", code: "IRM-0004" })).rejects.toThrow(/serial|batch/i);
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
      const m = await scanLookup({ jobId: JOB_ID, direction: "issue", code: "CSE-00001" });
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
      await expect(scanLookup({ jobId: JOB_ID, direction: "issue", code: "CSE-00001" })).rejects.toThrow(/not on this job/i);
    });

    it("rejects a code that matches neither IRM nor customer stock", async () => {
      mockCseByBarcode.mockResolvedValue(null);
      await expect(scanLookup({ jobId: JOB_ID, direction: "issue", code: "UNKNOWN-XYZ" })).rejects.toThrow(/no item matches/i);
    });
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
      return { id: "m1", code: "GM-0001", direction: "issue", items: [], job: { id: JOB_ID } };
    });
  });

  it("decrements the warehouse and increments the engineer holding for an IRM issue", async () => {
    void ENG_ID;
    const mockRequireIrm = irmService.requireActiveIrmItem as ReturnType<typeof vi.fn>;
    mockRequireIrm.mockResolvedValue({ id: IRM_ID, code: "IRM-0004", name: "CAT6", baseUnit: "Box", trackSerialNumbers: false, trackBatchNumbers: false });
    await postIssue(JOB_ID, { direction: "issue", lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 10, scannedCode: "IRM-0004" }] }, { email: "wm@x.com" } as never);
    expect(mockApplyOutbound).toHaveBeenCalledTimes(1);
    expect(mockApplyOutbound.mock.calls[0][1]).toMatchObject({ irmItemId: IRM_ID, warehouseId: WH_ID, quantity: 10, sourceType: "goods_management", sourceCode: "GM-0001" });
    expect(mockUpsertEng).toHaveBeenCalledWith({}, IRM_ID, ENG_ID, 10);
  });

  it("rejects issuing more than the kit-line remaining", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 6 }] }]);
    await expect(postIssue(JOB_ID, { direction: "issue", lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 6, scannedCode: "IRM-0004" }] }, { email: "wm@x.com" } as never)).rejects.toThrow(/remaining|kit/i);
    expect(mockCreateMovement).not.toHaveBeenCalled();
  });
});

describe("listQueue", () => {
  it("reports planned: 10, issued: 6, available: 4 given existing movements and balance", async () => {
    const mockFindActive = jobRepo.findActiveForGoodsManagement as ReturnType<typeof vi.fn>;
    mockFindActive.mockResolvedValue([{
      id: JOB_ID, jobNumber: "JOB-2026-0001", name: "Test Job", customerId: "x".repeat(24),
      customerName: "Acme", assignedEngineerId: ENG_ID, assignedEngineerName: "Bob", status: "accepted",
      kitLines: [{ id: "k1", lineType: "irm", irmItemId: IRM_ID, warehouseId: WH_ID, itemName: "CAT6", qty: 10, warehouseName: "WH1", warehouseCode: "W1", customerStockEntryId: null }],
    }]);
    // 6 already issued
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", items: [{ jobKitLineId: "k1", qty: 6 }] }]);
    // 4 available in warehouse
    mockBal.mockResolvedValue({ quantityOnHand: 4, quantityReserved: 0 });
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummary.mockResolvedValue(null);

    const queue = await listQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].kitLines[0]).toMatchObject({ planned: 10, issued: 6, available: 4 });
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
    // createMovementWithCode invokes the apply callback synchronously.
    mockCreateMovement.mockImplementation(async (_h: unknown, _l: unknown, apply: (tx: unknown, id: string, code: string) => Promise<void>) => {
      await apply({}, "m3", "GM-0003");
      return { id: "m3", code: "GM-0003", direction: "return", items: [], job: { id: JOB_ID } };
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
        direction: "return",
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
        direction: "return",
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

  it("rejects returning more IRM than the engineer holds", async () => {
    // Engineer only holds 2, but 5 are requested.
    mockFindEngBalTxForReturn.mockResolvedValue({ quantityOnHand: 2 });
    await expect(
      postReturn(
        JOB_ID,
        {
          direction: "return",
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

  it("transitions job in_progress → completed and sets goodsStatus = awaiting_return", async () => {
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

  it("rejects reconciling a job that is already reconciled", async () => {
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummary.mockResolvedValue({ goodsStatus: "reconciled", workSummary: null, lastMovementAt: new Date() });
    await expect(closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never)).rejects.toThrow(/already reconciled/i);
  });

  it("rejects reconciling a job whose goodsStatus is not_issued (no stock has moved)", async () => {
    // Summary exists but status is not_issued — no movements have happened yet.
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummary.mockResolvedValue({ goodsStatus: "not_issued", workSummary: null, lastMovementAt: null });
    await expect(closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never)).rejects.toThrow(/not had stock issued/i);
  });

  it("rejects reconciling a job with no summary at all (no stock has ever moved)", async () => {
    // No summary at all — job has never had stock issued.
    const mockGetSummary = repo.getSummary as ReturnType<typeof vi.fn>;
    mockGetSummary.mockResolvedValue(null);
    await expect(closeReconcile(RECONCILE_JOB_ID, {}, { email: "wm@x.com" } as never)).rejects.toThrow(/not had stock issued/i);
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
      postIssue(RECONCILE_JOB_ID, { direction: "issue", lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 1 }] }, { email: "wm@x.com" } as never),
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
      postReturn(RECONCILE_JOB_ID, { direction: "return", lines: [{ source: "irm", irmItemId: IRM_ID, qty: 1, condition: "good", jobKitLineId: "k1" }] }, { email: "wm@x.com" } as never),
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
