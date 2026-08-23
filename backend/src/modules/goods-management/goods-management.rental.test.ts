import { beforeEach, describe, expect, it, vi } from "vitest";

// Hired kit on a job: scanned out to an engineer, scanned back to the warehouse, and NEVER consumed,
// NEVER written off as lost, and NEVER posted to an owned-stock ledger.
//
// The last three are the point of this file. Everything a hire does on a job LOOKS like the IRM path
// and is deliberately not it: an IRM cable can be used up, written off and credited to an inventory
// balance, and doing any of those to a fibre tester we are renting states something untrue about
// equipment somebody else owns.

vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("../../lib/realtime.js", () => ({ emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "jobs:office" }));
vi.mock("./goods-management.repository.js", () => ({
  createMovementWithCode: vi.fn(), findMovementsByJob: vi.fn(), findMovementsByJobs: vi.fn(), findIssuedQtyByKitLine: vi.fn(),
  getSummary: vi.fn(), getSummariesByJobs: vi.fn(), upsertSummaryTx: vi.fn(),
  upsertCustomerHoldingTx: vi.fn(), findCustomerHoldingTx: vi.fn(), insertCustomerHoldingTxnTx: vi.fn(),
  findCustomerHoldingsByEngineer: vi.fn(async () => []), findCustomerHoldingQuantitiesByEngineers: vi.fn(),
  adjustCustomerStockEntryQtyTx: vi.fn(), findCustomerStockEntryById: vi.fn(), findCustomerStockEntriesByIds: vi.fn(),
  findCustomerStockEntryByBarcode: vi.fn(async () => null),
  upsertDamagedBalanceTx: vi.fn(), insertDamagedTxnTx: vi.fn(), findDamagedByWarehouse: vi.fn(), findDamagedByCustomer: vi.fn(),
  findAllDamaged: vi.fn(), findOldIssueMovementsForJobs: vi.fn(), findSummariesByGoodsStatuses: vi.fn(), findCustomerHolding: vi.fn(),
  findLatestDamagedTxnsByBalances: vi.fn(), findDamagedBalance: vi.fn(), findDamagedTxnsByKey: vi.fn(), openReturnOnCancel: vi.fn(),
}));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn(), findActiveForGoodsManagement: vi.fn(), findActiveWithKitLines: vi.fn(), findKitLineTypesByJobs: vi.fn(), findGoodsActiveJobIds: vi.fn(), completeIfInProgressTx: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({ requireActiveIrmItem: vi.fn(), findActiveByCodeOrBarcode: vi.fn(async () => null) }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancePair: vi.fn(), findBalancesByItemsAndWarehouses: vi.fn(), findBalancePairTx: vi.fn(), upsertBalanceTx: vi.fn(), insertTransactionTx: vi.fn() }));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyOutbound: vi.fn(), applyInbound: vi.fn() }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({ upsertEngineerBalanceTx: vi.fn(), insertEngineerTxnTx: vi.fn(), findEngineerBalanceTx: vi.fn(), findEngineerBalance: vi.fn(), findEngineerBalances: vi.fn(async () => []), findBalanceQuantitiesByEngineers: vi.fn() }));
vi.mock("#modules/engineer-rental/engineer-rental.repository.js", () => ({
  upsertRentalHoldingTx: vi.fn(), insertRentalTxnTx: vi.fn(), findRentalHoldingTx: vi.fn(),
  findRentalHolding: vi.fn(), findRentalHoldingsByEngineer: vi.fn(async () => []), findRentalHoldingsByHireLines: vi.fn(async () => []),
  findRentalHoldingQuantitiesByEngineers: vi.fn(async () => []),
}));
vi.mock("#modules/rental-item/rental-item.repository.js", () => ({ findById: vi.fn(), findActiveByCode: vi.fn(async () => null) }));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  findLiveHiresByRentalItems: vi.fn(async () => []), findHireStockById: vi.fn(), findHireStockByIdTx: vi.fn(),
  adjustHireIssuedQtyTx: vi.fn(async () => true), flagHireDamagedTx: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn(), getOverdueAfterDays: vi.fn(async () => 14), getCompanyTimezone: vi.fn(async () => "Europe/London") }));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({ findVanSourcesByKitLines: vi.fn(async () => new Map()) }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findById: vi.fn(async () => ({ id: "b".repeat(24), name: "Leeds", code: "LDS" })) }));
vi.mock("#modules/notification/notification.service.js", () => ({ notify: vi.fn() }));

import * as repo from "./goods-management.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as rentalItemRepo from "#modules/rental-item/rental-item.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import { closeReconcile, getJobGoods, getJobKitTallies, getWarehouseDemand, postIssue, postReturn, recordConsumeAndComplete, scanLookup } from "./goods-management.service.js";

const JOB_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
const ENG_ID = "c".repeat(24);
const RENTAL_ID = "d".repeat(24);
const HIRE_ID = "e".repeat(24);
const HIRE_2_ID = "f".repeat(24);

const mockJob = vi.mocked(jobRepo.findById);
const mockRentalByCode = vi.mocked(rentalItemRepo.findActiveByCode);
const mockRentalById = vi.mocked(rentalItemRepo.findById);
const mockLiveHires = vi.mocked(poRepo.findLiveHiresByRentalItems);
const mockHireById = vi.mocked(poRepo.findHireStockById);
const mockHireByIdTx = vi.mocked(poRepo.findHireStockByIdTx);
const mockAdjustIssued = vi.mocked(poRepo.adjustHireIssuedQtyTx);
const mockFlagDamaged = vi.mocked(poRepo.flagHireDamagedTx);
const mockUpsertHolding = vi.mocked(rentalCustodyRepo.upsertRentalHoldingTx);
const mockFindHoldingTx = vi.mocked(rentalCustodyRepo.findRentalHoldingTx);
const mockHoldingsByEngineer = vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer);
const mockMoves = vi.mocked(repo.findMovementsByJob);
const mockCreate = vi.mocked(repo.createMovementWithCode);

const RENTAL_ITEM = { id: RENTAL_ID, code: "RNT-0007", name: "Fibre Tester", baseUnit: "Each", status: "active", deletedAt: null };

/** A live hire: 3 delivered, none back to the provider, none out with an engineer. */
const hire = (over: Record<string, unknown> = {}) => ({
  id: HIRE_ID,
  rentalItemId: RENTAL_ID,
  itemName: "Fibre Tester",
  baseUnit: "Each",
  quantity: 3,
  receivedQuantity: 3,
  returnedQuantity: 0,
  issuedQuantity: 0,
  hireEndDate: new Date("2026-09-14T00:00:00Z"),
  hireStatus: "on_hire",
  purchaseOrderId: "9".repeat(24),
  poCode: "PO-0042",
  warehouseId: WH_ID,
  warehouseName: "Leeds",
  warehouseCode: "LDS",
  orderLive: true,
  ...over,
});

const rentalKitLine = { id: "k1", lineType: "rental", irmItemId: null, rentalItemId: RENTAL_ID, customerStockEntryId: null, warehouseId: WH_ID, warehouseName: "Leeds", warehouseCode: "LDS", itemName: "Fibre Tester", qty: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [rentalKitLine] } as never);
  mockRentalByCode.mockResolvedValue(RENTAL_ITEM as never);
  mockRentalById.mockResolvedValue(RENTAL_ITEM as never);
  mockLiveHires.mockResolvedValue([hire()] as never);
  mockHireById.mockResolvedValue(hire() as never);
  // postIssue re-reads the hire INSIDE the transaction to catch an order cancelled mid-scan, so
  // the tx twin needs the same default as its pre-transaction counterpart above.
  mockHireByIdTx.mockResolvedValue(hire() as never);
  mockAdjustIssued.mockResolvedValue(true);
  mockMoves.mockResolvedValue([] as never);
  mockUpsertHolding.mockResolvedValue({ quantityOnHand: 2, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z") } as never);
  mockCreate.mockImplementation((async (_h: unknown, _l: unknown, apply: (tx: unknown, id: string, code: string) => Promise<void>) => {
    await apply({}, "m1", "GM-0001");
    return { id: "m1", code: "GM-0001", items: [] };
  }) as never);
});

describe("scanLookup — a rental label resolves to a specific hire", () => {
  it("binds the scan to the hire whose deadline is soonest", async () => {
    // Two live hires of the same tester. The one ending in September must be the one that goes out:
    // leaving it on the shelf while the October hire is used is how a hire goes overdue holding kit
    // nobody was using.
    const sept = hire({ id: HIRE_ID, poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z") });
    const oct = hire({ id: HIRE_2_ID, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") });
    mockLiveHires.mockResolvedValue([oct, sept] as never); // deliberately out of order

    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });

    expect(m).toMatchObject({ source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_ID, jobKitLineId: "k1" });
    expect(m.hire).toMatchObject({ poCode: "PO-0042" });
    // The BOUND hire's figure, not the depot's 6. postIssue commits against this one row, so a
    // cross-hire total here advertised headroom the post would then refuse.
    expect(m.available).toBe(3);
  });

  it("caps the stepper at the bound hire, not at the kit line's own remainder", async () => {
    // Three planned, against hires of two and one. The ceiling used to be the kit line's remainder
    // alone, so the warehouse could type 3 — and the post, which commits against the ONE hire the
    // scan bound, refused with "no longer available on this hire". Re-scanning bound the same hire
    // and offered the same 3, so the line could never be issued at all. Two hires are two scans.
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [{ ...rentalKitLine, qty: 3 }] } as never);
    const two = hire({ id: HIRE_ID, quantity: 2, receivedQuantity: 2, hireEndDate: new Date("2026-09-14T00:00:00Z") });
    const one = hire({ id: HIRE_2_ID, quantity: 1, receivedQuantity: 1, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") });
    mockLiveHires.mockResolvedValue([two, one] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });

    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
    expect(m.remainingIssuable).toBe(2); // NOT 3 — this hire holds two
    expect(m.available).toBe(2);
  });

  it("refuses when every hired unit is already out or gone back", async () => {
    mockLiveHires.mockResolvedValue([hire({ issuedQuantity: 3 })] as never);
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" }))
      .rejects.toThrow(/No Fibre Tester is available at this warehouse/i);
  });

  it("refuses a rental that is not on the job's kit list", async () => {
    mockJob.mockResolvedValue({ id: JOB_ID, status: "accepted", assignedEngineerId: ENG_ID, kitLines: [] } as never);
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" }))
      .rejects.toThrow(/not on this job's kit list/i);
  });

  it("points at the right depot when the line is homed elsewhere", async () => {
    mockJob.mockResolvedValue({ id: JOB_ID, status: "accepted", assignedEngineerId: ENG_ID, kitLines: [{ ...rentalKitLine, warehouseId: "9".repeat(24) }] } as never);
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" }))
      .rejects.toThrow(/assigned to a different warehouse/i);
  });

  it("on a RETURN, resolves the hire from what the engineer actually holds", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] }] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });
    // Soonest deadline first again — returning against the most urgent hire is what clears the badge.
    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
    // ONE, not two: the engineer holds two units of this tester but they sit on DIFFERENT hires, and
    // this scan is bound to PO-0042 alone. Offering 2 here made postReturn 409 on the second unit,
    // which belongs to PO-0051 and needs its own scan.
    expect(m.heldByEngineer).toBe(1);
  });

  it("offers only the bound hire's units when one hire covers several", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 5, condition: "good" }] }] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 3 },
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 2 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
    expect(m.heldByEngineer).toBe(3); // the 2 on PO-0051 come back on their own scan
  });

  it("never offers more than the kit line still has outstanding", async () => {
    // Held 3 on the hire, but only 1 is still outstanding on this line (2 already returned).
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 3, condition: "good" }] },
      { status: "posted", direction: "return", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 3 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.heldByEngineer).toBe(1);
  });
});

describe("scanLookup — an overdue hire is flagged, not blocked", () => {
  it("marks a hire whose return date has passed", async () => {
    // Company timezone is Europe/London in the harness; the hire ended well before any plausible
    // "today", so this does not depend on when the suite runs.
    mockLiveHires.mockResolvedValue([hire({ hireEndDate: new Date("2020-01-01T00:00:00Z") })] as never);
    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.hire?.overdue).toBe(true);
    // Flagged, NOT refused — the job may genuinely need it today, and the return trip is a separate
    // logistics problem. Blocking here would strand real work.
    expect(m.remainingIssuable).toBeGreaterThan(0);
  });

  it("does not flag a hire that is still within its period", async () => {
    mockLiveHires.mockResolvedValue([hire({ hireEndDate: new Date("2099-01-01T00:00:00Z") })] as never);
    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.hire?.overdue).toBe(false);
  });
});

describe("postIssue — a hire goes out as CUSTODY, never as stock", () => {
  const issueInput = {
    direction: "issue" as const,
    warehouseId: WH_ID,
    lines: [{ source: "rental" as const, rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_ID, jobKitLineId: "k1", qty: 2 }],
  };

  it("moves the hire's issued count and opens an engineer custody row", async () => {
    await postIssue(JOB_ID, issueInput);

    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, 2);
    expect(mockUpsertHolding).toHaveBeenCalledWith(expect.anything(), HIRE_ID, ENG_ID, 2, expect.objectContaining({ itemName: "Fibre Tester", poCode: "PO-0042" }));
    expect(vi.mocked(rentalCustodyRepo.insertRentalTxnTx)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "job_issue", quantityDelta: 2, balanceAfter: 2 }));
  });

  it("writes NO owned-stock row — not an inventory movement, not engineer van stock", async () => {
    await postIssue(JOB_ID, issueInput);

    // This is the boundary the rental design exists to protect, asserted behaviourally rather than by
    // grepping source: a hire must never become an InventoryBalance or IRM van stock.
    expect(inventoryService.applyOutbound).not.toHaveBeenCalled();
    expect(inventoryService.applyInbound).not.toHaveBeenCalled();
    expect(engineerStockRepo.upsertEngineerBalanceTx).not.toHaveBeenCalled();
    expect(engineerStockRepo.insertEngineerTxnTx).not.toHaveBeenCalled();
  });

  it("records the hire on the movement line, not just the catalogue item", async () => {
    await postIssue(JOB_ID, issueInput);
    const lines = mockCreate.mock.calls[0][1];
    expect(lines[0]).toMatchObject({ source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_ID, irmItemId: null, customerStockEntryId: null });
  });

  it("rolls back when the units went while the scan was open", async () => {
    // adjustHireIssuedQtyTx is the atomic guard: it returns false when the conditional update matched
    // nothing, which is what a concurrent issue of the last unit looks like.
    mockAdjustIssued.mockResolvedValue(false);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/no longer available on this hire/i);
  });

  it("refuses a hire that belongs to a different warehouse", async () => {
    mockHireById.mockResolvedValue(hire({ warehouseId: "9".repeat(24) }) as never);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/delivered to a different warehouse/i);
  });

  it("refuses a hire that has not been received yet", async () => {
    mockHireById.mockResolvedValue(hire({ hireStatus: "awaiting_delivery" }) as never);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/isn't live/i);
  });

  it("refuses a hire belonging to a different catalogue item", async () => {
    mockHireById.mockResolvedValue(hire({ rentalItemId: "7".repeat(24) }) as never);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/different rental item/i);
  });

  // The scan only ever offers hires on a live order, but this path resolves one by a CLIENT-SUPPLIED
  // id and cannot lean on that. Lending against a cancelled or deleted order strands the units: the
  // supplier-return path loads the order and refuses, so they could never be handed back.
  it("refuses a hire whose purchase order has been cancelled or deleted", async () => {
    mockHireById.mockResolvedValue(hire({ orderLive: false }) as never);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/cancelled or removed/i);
  });

  it("refuses a hire whose order was cancelled AFTER the scan resolved it", async () => {
    // The guards above run before the transaction opens. adjustHireIssuedQtyTx is atomic about how
    // MANY units move, but it reads only the counters — an order cancelled in the seconds between
    // resolve and commit still satisfies it, and units lent against a dead order are stranded: the
    // supplier-return path loads the order and refuses, so they could never be handed back.
    mockHireByIdTx.mockResolvedValue(hire({ orderLive: false }) as never);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/no longer live/i);
    expect(mockAdjustIssued).not.toHaveBeenCalled();
  });
});

describe("postReturn — hired kit comes back to the shelf", () => {
  const returnLine = (over: Record<string, unknown> = {}) => ({
    source: "rental" as const, rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_ID, jobKitLineId: "k1", qty: 2, ...over,
  });

  beforeEach(() => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] }] as never);
    mockFindHoldingTx.mockResolvedValue({ quantityOnHand: 2, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z") } as never);
    mockUpsertHolding.mockResolvedValue({ quantityOnHand: 0, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z") } as never);
  });

  it("drains custody and releases the units back into the hire's pool", async () => {
    await postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine()] });

    expect(mockUpsertHolding).toHaveBeenCalledWith(expect.anything(), HIRE_ID, ENG_ID, -2, expect.anything());
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, -2);
    expect(vi.mocked(rentalCustodyRepo.insertRentalTxnTx)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "job_return", quantityDelta: -2 }));
  });

  it("does NOT touch the hire's supplier-facing returnedQuantity", async () => {
    await postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine()] });
    // Engineer→warehouse and warehouse→provider are two different events. Only the second one ends
    // the hire; conflating them would mark a hire collected while it sat on our own shelf.
    for (const call of mockAdjustIssued.mock.calls) expect(call[2]).toBeLessThan(0);
    expect(mockFlagDamaged).not.toHaveBeenCalled();
  });

  it("damaged kit still comes back, and flags the hire instead of the damaged pool", async () => {
    await postReturn(JOB_ID, {
      direction: "return",
      warehouseId: WH_ID,
      lines: [returnLine({ condition: "damaged", damagePhotoUrl: "https://res.cloudinary.com/x.jpg", damageReason: "Screen cracked on site" })],
    });

    // The unit is physically back on our shelf and still owed to the provider, so the custody move
    // happens either way — skipping it would strand the hire as permanently "issued".
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, -2);
    // Flagged on the hire for the PM to raise the damage note with the provider's real charge...
    expect(mockFlagDamaged).toHaveBeenCalledWith(expect.anything(), HIRE_ID, 2);
    // ...and NEVER into the damaged pool, which is for stock we own and would double-count a charge
    // the provider bills once.
    expect(repo.upsertDamagedBalanceTx).not.toHaveBeenCalled();
    expect(repo.insertDamagedTxnTx).not.toHaveBeenCalled();
  });

  it("refuses to return more than the engineer holds", async () => {
    mockFindHoldingTx.mockResolvedValue({ quantityOnHand: 1, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: null } as never);
    await expect(postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine()] }))
      .rejects.toThrow(/doesn't hold 2 of this hire/i);
  });
  it("refuses a hire belonging to a different catalogue item", async () => {
    // The hire id is client-supplied and the kit line was matched on the ITEM, so until both are
    // checked nothing ties the two together. An engineer holding a tester AND a splicer on two hires
    // at one depot could otherwise return the tester and have the SPLICER's custody drained — the
    // depot would then be short one splicer with the paperwork saying otherwise.
    mockHireById.mockResolvedValue(hire({ rentalItemId: "7".repeat(24) }) as never);
    await expect(postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine()] }))
      .rejects.toThrow(/that hire is for a different rental item/i);
  });

  it("files the return against the SERVER's kit line, not the id the client sent", async () => {
    // A well-formed id naming a different line of the same job passes validation. Filing the ledger
    // row against the resolved line while drawing the per-line budget from the client's meant one
    // return could be credited twice — once against each line's outstanding count.
    await postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine({ jobKitLineId: "k-a-different-line" })] });
    const movementLines = mockCreate.mock.calls[0][1] as unknown as { jobKitLineId: string | null }[];
    expect(movementLines[0].jobKitLineId).toBe("k1");
  });
});

// The Goods-Management QUEUE is a second reader of the same facts as the scan panel, computed from a
// different code path. Every one of these was silently wrong for a rental line before: the queue said
// a hired item was unavailable and unscannable while the scan panel, reading the hires directly, said
// the opposite. Two screens disagreeing about one number is worse than either being wrong alone.
describe("goods queue — a rental line reads the same as the scan", () => {
  beforeEach(() => {
    vi.mocked(jobRepo.findActiveForGoodsManagement).mockResolvedValue([] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([] as never);
    vi.mocked(repo.findCustomerStockEntriesByIds).mockResolvedValue([] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([] as never);
    vi.mocked(repo.findCustomerHoldingsByEngineer).mockResolvedValue([] as never);
    vi.mocked(transferRepo.findVanSourcesByKitLines).mockResolvedValue(new Map() as never);
    vi.mocked(repo.findMovementsByJob).mockResolvedValue([] as never);
    vi.mocked(repo.getSummary).mockResolvedValue(null as never);
    vi.mocked(jobRepo.findById).mockResolvedValue({
      id: JOB_ID, jobNumber: "JOB-2026-0117", name: "Test", status: "accepted",
      customerId: "1".repeat(24), customerName: "Acme",
      assignedEngineerId: ENG_ID, assignedEngineerName: "Dave",
      kitLines: [{ ...rentalKitLine, rentalItem: { code: "RNT-0007" }, itemName: "RNT-0007 — Fibre Tester" }],
    } as never);
  });

  it("offers the RNT code as the scan token, strips it from the name, and reports the hire pool", async () => {
    mockLiveHires.mockResolvedValue([hire({ receivedQuantity: 3 }), hire({ id: HIRE_2_ID, receivedQuantity: 2 })] as never);
    const detail = await getJobGoods(JOB_ID);
    const line = detail.lines[0]!;
    expect(line.scanCode).toBe("RNT-0007");
    // The stored snapshot is the picker's label; repeating the code inside the name is noise once the
    // queue can copy it on click.
    expect(line.itemName).toBe("Fibre Tester");
    expect(line.available).toBe(5); // summed across BOTH live hires at this depot
  });

  it("reports what the engineer is actually holding on hire", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: null, quantityOnHand: 2 },
    ] as never);
    const detail = await getJobGoods(JOB_ID);
    // Custody is stored per HIRE and asked here per catalogue item, so it has to be summed on the way
    // in. Left unwired this read 0 and the return scan offered nothing to hand back.
    expect(detail.lines[0]!.engineerHeld).toBe(2);
  });
});

// ── The two doors into "a hire was never returned, but the job says it was" ────────────────────
//
// Both are about the SAME invariant — hired kit leaves a job by being scanned back and by no other
// route — and both were open. Neither is reachable through the happy path, which is exactly why they
// survived: the schema bars a rental consume, the validation enum bars `source: "rental"`, and the
// reconcile refuses hired kit. Each of these got past all three.
describe("closeReconcile — the hired-kit guard cannot be slipped past", () => {
  const TESTER_2_ID = "1".repeat(24);
  const secondRentalLine = { ...rentalKitLine, id: "k2", rentalItemId: TESTER_2_ID, itemName: "OTDR", qty: 1 };

  beforeEach(() => {
    vi.mocked(repo.getSummary).mockResolvedValue({ goodsStatus: "awaiting_return", workSummary: null, lastMovementAt: null } as never);
    mockJob.mockResolvedValue({
      id: JOB_ID, jobNumber: "JOB-2026-0117", status: "completed", assignedEngineerId: ENG_ID,
      assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co",
      kitLines: [rentalKitLine, secondRentalLine],
    } as never);
  });

  it("refuses when a SECOND hired item is still out and the first is already back", async () => {
    // The shape that used to slip through. Both hires are on one job; the Fibre Tester has been
    // returned in full (engineer holds none), the OTDR has not. Every rental tally keyed to the same
    // bucket, `held` was read from the FIRST entry only — which is 0 — so the whole bucket capped to
    // 0, `unaccountedItems` came out EMPTY, and the guard below never ran. The job reconciled and
    // locked with a hired OTDR still in a van.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [
        { jobKitLineId: "k1", qty: 2, condition: "good" },
        { jobKitLineId: "k2", qty: 1, condition: "good" },
      ] },
      { status: "posted", direction: "return", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: TESTER_2_ID, itemName: "OTDR", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    await expect(closeReconcile(JOB_ID, { writeOffLost: true }))
      .rejects.toThrow(/can't be reconciled while rental items are still out[\s\S]*OTDR/i);
  });

  it("names each outstanding hire separately instead of collapsing them into one", async () => {
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [
        { jobKitLineId: "k1", qty: 2, condition: "good" },
        { jobKitLineId: "k2", qty: 1, condition: "good" },
      ] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 2 },
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: TESTER_2_ID, itemName: "OTDR", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    // Both must be named — the old single bucket reported one row, titled with whichever item
    // happened to be first, carrying the other's quantity.
    const err = await closeReconcile(JOB_ID, { writeOffLost: true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/2 × Fibre Tester/);
    expect((err as Error).message).toMatch(/1 × OTDR/);
  });
});

describe("recordConsumeAndComplete — a hire can never be declared used", () => {
  const job = {
    id: JOB_ID, jobNumber: "JOB-2026-0117", status: "in_progress", assignedEngineerId: ENG_ID,
    assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [rentalKitLine],
  };

  it("rejects an IRM-sourced used line that points at a RENTAL kit line", async () => {
    // `completeJobSchema` bars `source: "rental"`, but it cannot see what a jobKitLineId points AT.
    // Aiming an `irm` used line at the rental line drained an unrelated IRM item and credited `used`
    // to the hire — whose remaining then fell to 0, so the line read fully accounted for and the
    // reconcile guard above found nothing to refuse. The hire was still in the van.
    await expect(
      recordConsumeAndComplete(job as never, ENG_ID, "Done", [{ source: "irm", irmItemId: "7".repeat(24), customerStockEntryId: undefined, jobKitLineId: "k1", qty: 2 }], "dave@x.co"),
    ).rejects.toThrow(/Fibre Tester is a hired item[\s\S]*returned to the warehouse, never consumed/i);
  });

  it("still rejects when the kit line id is omitted and only the item id is given", async () => {
    // The fallback branch matches on lineType already, so this was never the hole — pinned so a
    // future simplification of resolveUsedKitLine cannot open it.
    await expect(
      recordConsumeAndComplete(job as never, ENG_ID, "Done", [{ source: "irm", irmItemId: RENTAL_ID, customerStockEntryId: undefined, jobKitLineId: undefined, qty: 2 }], "dave@x.co"),
    ).rejects.toThrow(/isn't on this job's kit list/i);
  });
});

// ── The return deadline that reaches the engineer ──────────────────────────────────────────────
//
// getJobKitTallies is the ONLY producer of hireEndDate/hireOverdue, and three surfaces consume it:
// the engineer's kit row, the office job pack, and the completion audit record. None of it is typed
// distinctly from the tallies beside it, so a wrong predicate here fails silently everywhere.
describe("getJobKitTallies — the hire deadline rides on the custody snapshot", () => {
  const DEADLINE = new Date("2026-09-14T00:00:00Z");
  const holding = (over: Record<string, unknown> = {}) => ({
    purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester",
    poCode: "PO-0042", hireEndDate: DEADLINE, quantityOnHand: 2, ...over,
  });
  const issuedTwo = [{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] }];

  it("reports the deadline while units are still out", async () => {
    mockMoves.mockResolvedValue(issuedTwo as never);
    mockHoldingsByEngineer.mockResolvedValue([holding()] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1).toMatchObject({ issued: 2, remaining: 2, hireEndDate: DEADLINE, hireOverdue: false });
  });

  it("drops the deadline once the line is fully returned", async () => {
    // Nothing left to bring back, so there is no obligation to date. A date still sitting on a
    // settled line reads as something outstanding.
    mockMoves.mockResolvedValue([
      ...issuedTwo,
      { status: "posted", direction: "return", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1).toMatchObject({ remaining: 0, hireEndDate: null, hireOverdue: false });
  });

  it("flags a deadline that has already passed", async () => {
    mockMoves.mockResolvedValue(issuedTwo as never);
    mockHoldingsByEngineer.mockResolvedValue([holding({ hireEndDate: new Date("2020-01-01T00:00:00Z") })] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1.hireOverdue).toBe(true);
  });

  it("takes the SOONEST deadline when the engineer holds the item on two hires", async () => {
    // One row, one date — and it has to be the one that bites first. Erring early is safe here;
    // erring late would tell someone they had until the 30th on kit due back on the 14th.
    mockMoves.mockResolvedValue(issuedTwo as never);
    mockHoldingsByEngineer.mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_2_ID, hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 }),
      holding({ quantityOnHand: 1 }),
    ] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1.hireEndDate).toEqual(DEADLINE);
  });

  it("leaves a non-rental line's hire fields null", async () => {
    const irmJob = {
      id: JOB_ID, status: "in_progress", assignedEngineerId: ENG_ID,
      kitLines: [{ id: "k9", lineType: "irm", irmItemId: "8".repeat(24), rentalItemId: null, customerStockEntryId: null, warehouseId: WH_ID, itemName: "CAT6", qty: 1 }],
    };
    mockJob.mockResolvedValue(irmJob as never);
    mockMoves.mockResolvedValue([] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k9).toMatchObject({ hireEndDate: null, hireOverdue: false });
  });
});

// ── The warehouse Demand board ─────────────────────────────────────────────────────────────────
//
// A hire planned from this depot is NOT a shortfall. It had no stock lookup at all: with no
// irmItemId it fell through to the customer-entry map, missed, and came out as inStock 0 →
// free = −demand. This list sorts most-negative first, so every live hire pinned to the top of the
// board as a shortage that did not exist — and buried the real ones underneath.
describe("getWarehouseDemand — a hired item is not a shortfall", () => {
  const kitLine = { id: "k1", lineType: "rental", irmItemId: null, rentalItemId: RENTAL_ID, customerStockEntryId: null, warehouseId: WH_ID, itemName: "Fibre Tester", qty: 2 };

  beforeEach(() => {
    vi.mocked(jobRepo.findActiveWithKitLines).mockResolvedValue([{ id: JOB_ID, kitLines: [kitLine] }] as never);
    vi.mocked(repo.getSummariesByJobs).mockResolvedValue([] as never);
    vi.mocked(repo.findMovementsByJobs).mockResolvedValue([] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([] as never);
    vi.mocked(repo.findCustomerStockEntriesByIds).mockResolvedValue([] as never);
  });

  it("counts the hires available at this depot as stock, and labels the row rental", async () => {
    // 3 delivered here, none out, none back ⇒ 3 available against a demand of 2.
    mockLiveHires.mockResolvedValue([hire()] as never);
    const [row] = await getWarehouseDemand(WH_ID);
    expect(row).toEqual({ source: "rental", itemName: "Fibre Tester", inStock: 3, planned: 2, free: 1 });
  });

  it("nets units already out with an engineer out of the depot pool", async () => {
    // Same hire, but 2 of the 3 are in a van — only 1 is actually on the shelf to give out.
    mockLiveHires.mockResolvedValue([hire({ issuedQuantity: 2 })] as never);
    const [row] = await getWarehouseDemand(WH_ID);
    expect(row).toMatchObject({ inStock: 1, planned: 2, free: -1 });
  });

  it("still reports a genuine shortfall when nothing is on hire here", async () => {
    mockLiveHires.mockResolvedValue([] as never);
    const [row] = await getWarehouseDemand(WH_ID);
    expect(row).toMatchObject({ source: "rental", inStock: 0, free: -2 });
  });
});

// ── A return has to bind the hire that was DELIVERED HERE ──────────────────────────────────────
//
// EngineerRentalHolding carries no warehouse, so resolving the hire by deadline alone reached across
// depots. postReturn then refuses that exact case ("that hire belongs to a different warehouse") and
// the panel offers no second option — the units are physically on the counter and unscannable.
describe("scanLookup — a return binds a hire from THIS depot", () => {
  const OTHER_WH = "8".repeat(24);

  it("skips a sooner-expiring hire that was delivered somewhere else", async () => {
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 1, condition: "good" }] }] as never);
    // Only HIRE_ID is live at this warehouse; HIRE_2_ID belongs to the other depot and expires sooner.
    mockLiveHires.mockResolvedValue([hire({ id: HIRE_ID, hireEndDate: new Date("2026-10-30T00:00:00Z") })] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });
    // Deadline order alone would have picked PO-0051 and produced a scan postReturn always rejects.
    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
    expect(m.hire?.poCode).toBe("PO-0042");
  });

  it("still binds a hire whose order is no longer live, so the kit can come back at all", async () => {
    // Nothing live here — the fallback keeps the deliberate no-orderLive rule on the return leg.
    // Refusing the scan would strand the units in the van with no way to record their return.
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 1, condition: "good" }] }] as never);
    mockLiveHires.mockResolvedValue([] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: OTHER_WH === WH_ID ? WH_ID : WH_ID, code: "RNT-0007" });
    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
  });

  it("prefers a dated hire over one with no deadline snapshot", async () => {
    // `?? 0` sorted an undated holding to the epoch, so it beat every real deadline and was always
    // the hire picked. Undated now sorts last.
    mockMoves.mockResolvedValue([{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 1, condition: "good" }] }] as never);
    mockLiveHires.mockResolvedValue([hire({ id: HIRE_ID }), hire({ id: HIRE_2_ID })] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: null, quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
  });
});
