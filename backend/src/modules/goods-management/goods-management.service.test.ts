import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("./goods-management.repository.js", () => ({
  createMovementWithCode: vi.fn(), findMovementsByJob: vi.fn(), getSummary: vi.fn(), upsertSummaryTx: vi.fn(),
  upsertCustomerHoldingTx: vi.fn(), findCustomerHoldingTx: vi.fn(), insertCustomerHoldingTxnTx: vi.fn(), findCustomerHoldingsByEngineer: vi.fn(),
  adjustCustomerStockEntryQtyTx: vi.fn(), findCustomerStockEntryById: vi.fn(), findCustomerStockEntryByBarcode: vi.fn(),
  upsertDamagedBalanceTx: vi.fn(), insertDamagedTxnTx: vi.fn(), findDamagedByWarehouse: vi.fn(), findDamagedByCustomer: vi.fn(), findRecentMovementsForOverdue: vi.fn(),
}));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn() }));
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
  void CSE_ID; // referenced in Task 8 postIssue / customer-line tests
  void mockCseByBarcode; // referenced in Task 8 postIssue / customer-line tests
  mockJob.mockResolvedValue({ id: JOB_ID, status: "accepted", assignedEngineerId: "c".repeat(24),
    kitLines: [{ id: "k1", lineType: "irm", irmItemId: IRM_ID, warehouseId: WH_ID, itemName: "CAT6", qty: 10 }] });
  mockIrm.mockResolvedValue({ id: IRM_ID, code: "IRM-0004", name: "CAT6", baseUnit: "Box", barcode: "5012345678900", trackInventory: true, trackSerialNumbers: false, trackBatchNumbers: false });
  mockBal.mockResolvedValue({ quantityOnHand: 4, quantityReserved: 0 });
  mockMoves.mockResolvedValue([]);
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
});

import { postIssue } from "./goods-management.service.js";
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
