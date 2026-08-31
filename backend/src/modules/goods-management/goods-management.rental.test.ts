import { beforeEach, describe, expect, it, vi } from "vitest";

// Hired kit on a job: scanned out to an engineer, scanned back to the warehouse, and NEVER consumed,
// NEVER written off as lost, and NEVER posted to an owned-stock ledger.
//
// The last three are the point of this file. Everything a hire does on a job LOOKS like the IRM path
// and is deliberately not it: an IRM cable can be used up, written off and credited to an inventory
// balance, and doing any of those to a fibre tester we are renting states something untrue about
// equipment somebody else owns.

vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("../../lib/realtime.js", () => ({ emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "jobs:office", RENTAL_WATCHERS_ROOM: "rentals:watchers" }));
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
  findLiveHiresByRentalItems: vi.fn(async () => []), findIssuableHiresByRentalItems: vi.fn(async () => []),
  findHireStockById: vi.fn(), findHireStockByIdTx: vi.fn(),
  adjustHireIssuedQtyTx: vi.fn(async () => true),
}));
vi.mock("#modules/purchase-order/hireCustodyExit.repository.js", () => ({
  createExitTx: vi.fn(async () => ({ id: "e1" })),
  CUSTODY_HELD_DAMAGED: "held_damaged",
  CUSTODY_LOST: "lost",
  CUSTODY_RECOVERED: "recovered",
  SETTLE_UNSETTLED: "unsettled",
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
import * as custodyExitRepo from "#modules/purchase-order/hireCustodyExit.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as realtime from "../../lib/realtime.js";
import * as audit from "#modules/audit/audit.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import { closeReconcile, getJobGoods, getJobKitTallies, getWarehouseDemand, postIssue, postReturn, recordConsumeAndComplete, scanLookup } from "./goods-management.service.js";

const JOB_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
const ENG_ID = "c".repeat(24);
const RENTAL_ID = "d".repeat(24);
const HIRE_ID = "e".repeat(24);
const HIRE_2_ID = "f".repeat(24);
const IRM_ID = "2".repeat(24);
const PO_ID = "9".repeat(24);

const mockJob = vi.mocked(jobRepo.findById);
const mockRentalByCode = vi.mocked(rentalItemRepo.findActiveByCode);
const mockRentalById = vi.mocked(rentalItemRepo.findById);
const mockLiveHires = vi.mocked(poRepo.findLiveHiresByRentalItems);
const mockIssuableHires = vi.mocked(poRepo.findIssuableHiresByRentalItems);

/**
 * Put the same rows behind BOTH hire lookups.
 *
 * The service asks a different question on each leg — `findIssuableHiresByRentalItems` on the way out
 * (hire period still running) and `findLiveHiresByRentalItems` on the way back (everything we hold,
 * expired included) — and the real narrowing is done by the predicate inside those queries, not here.
 * So for a test whose point is merely "these candidates exist", both should answer the same. The tests
 * that exist to prove the ASYMMETRY set the two apart deliberately, and say so.
 */
const setHires = (rows: unknown[]) => {
  mockLiveHires.mockResolvedValue(rows as never);
  mockIssuableHires.mockResolvedValue(rows as never);
};
const mockHireById = vi.mocked(poRepo.findHireStockById);
const mockHireByIdTx = vi.mocked(poRepo.findHireStockByIdTx);
const mockAdjustIssued = vi.mocked(poRepo.adjustHireIssuedQtyTx);
const mockCustodyExit = vi.mocked(custodyExitRepo.createExitTx);
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
  lostQuantity: 0,
  fieldDamageQty: 0,
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
  setHires([hire()]);
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
    setHires([oct, sept]); // deliberately out of order

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
    setHires([two, one]);

    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });

    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
    expect(m.remainingIssuable).toBe(2); // NOT 3 — this hire holds two
    expect(m.available).toBe(2);
  });

  it("refuses when every hired unit is already out or gone back", async () => {
    setHires([hire({ issuedQuantity: 3 })]);
    await expect(scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" }))
      .rejects.toThrow(/No Fibre Tester is available to issue at this warehouse/i);
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

  // The bound hire is ONE of possibly several, and the scan has to say so. A kit line issued 2 off two
  // different orders showed "Held: 1" against the first of them and nothing at all about the second —
  // so a warehouse looking at "issued 2" could stage only 1, with no way to tell whether the missing
  // unit was a bug, a loss, or simply behind another PO. It was the third, and only a re-scan AFTER
  // posting revealed it.
  it("on a RETURN, reports EVERY hire this line can be returned against, not just the bound one", async () => {
    const sept = hire({ id: HIRE_ID, poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z") });
    const oct = hire({ id: HIRE_2_ID, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") });
    setHires([oct, sept]); // both live at THIS warehouse, deliberately out of order
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });

    // The binding is unchanged — soonest deadline still leads, and `heldByEngineer` still describes
    // THAT hire alone, because that is what a post against it may carry.
    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
    expect(m.heldByEngineer).toBe(1);
    // …and the second hire is now visible in the same answer, so one scan can stage the whole 2.
    expect(m.hires).toEqual([
      { purchaseOrderRentalLineId: HIRE_ID, poCode: "PO-0042", hireEndDate: "2026-09-14T00:00:00.000Z", overdue: false, qty: 1 },
      { purchaseOrderRentalLineId: HIRE_2_ID, poCode: "PO-0051", hireEndDate: "2026-10-30T00:00:00.000Z", overdue: false, qty: 1 },
    ]);
  });

  it("lists the local hires and drops a holding belonging to another depot", async () => {
    // The mixed case, which neither the all-live nor the no-live fixture reaches: an engineer can hold
    // the same tester on a hire delivered HERE and one delivered elsewhere. Only the local one may be
    // staged — postReturn refuses the other with "that hire belongs to a different warehouse" — and the
    // local one must still be offered rather than the whole scan falling back to a single row.
    setHires([hire({ id: HIRE_ID, hireEndDate: new Date("2026-09-14T00:00:00Z") })]); // only HIRE_ID is live here
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      // Sorts FIRST by deadline, so a naive "soonest wins" would bind the foreign depot's hire.
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-08-01T00:00:00Z"), quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
    expect(m.hires?.map((h) => h.purchaseOrderRentalLineId)).toEqual([HIRE_ID]);
  });

  it("flags an overdue hire inside the breakdown, not only on the bound one", async () => {
    setHires([
      hire({ id: HIRE_ID, hireEndDate: new Date("2020-01-01T00:00:00Z") }),
      hire({ id: HIRE_2_ID, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") }),
    ]);
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2020-01-01T00:00:00Z"), quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.hires?.map((h) => h.overdue)).toEqual([true, false]);
  });

  it("never lets the hires it lists add up to more than the line still has out", async () => {
    // Two hires holding 3 each, but this line only ever had 4 out and 1 is already back. The list has
    // to spend that budget in deadline order — 3 on the soonest, 0 on the next — or the panel could
    // stage 6 units against a line that owes 3, and postReturn would refuse the surplus at the till.
    setHires([hire({ id: HIRE_ID, hireEndDate: new Date("2026-09-14T00:00:00Z") }), hire({ id: HIRE_2_ID, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") })]);
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 4, condition: "good" }] },
      { status: "posted", direction: "return", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 1, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 3 },
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 3 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });

    expect(m.hires?.map((h) => h.qty)).toEqual([3]); // 3 spends the budget; PO-0051 drops out
    expect(m.heldByEngineer).toBe(3);
  });

  // The no-live-hire fallback stays a SINGLE hire on purpose — see the note in scanLookup. A holding
  // whose hire is not live at this depot may well belong to another one, and postReturn refuses those;
  // staging a card per hire from that set would offer rows that can only fail on Post.
  it("falls back to one hire when none of the holdings is live at this warehouse", async () => {
    setHires([]); // nothing live here
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });

    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
    expect(m.hires).toEqual([
      { purchaseOrderRentalLineId: HIRE_ID, poCode: "PO-0042", hireEndDate: "2026-09-14T00:00:00.000Z", overdue: false, qty: 1 },
    ]);
  });

  // The ISSUE leg answers the same question in reverse: which hires would this line be drawn from, and
  // how much off each. It used to bind ONE and cap the stepper there, so 12 units spread over four
  // hires meant four scan→type→Post cycles — the warehouse doing the allocator's arithmetic by hand,
  // with a 409 waiting whenever they got it wrong. The split comes from allocateFromHires, the same
  // function the post commits through, so the preview and the commitment cannot disagree.
  it("on an ISSUE, reports every hire the line would be drawn from, earliest deadline first", async () => {
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [{ ...rentalKitLine, qty: 5 }] } as never);
    const sept = hire({ id: HIRE_ID, quantity: 2, receivedQuantity: 2, hireEndDate: new Date("2026-09-14T00:00:00Z") });
    const oct = hire({ id: HIRE_2_ID, quantity: 4, receivedQuantity: 4, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") });
    setHires([oct, sept]); // deliberately out of order

    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });

    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID); // binding unchanged — soonest deadline leads
    expect(m.remainingIssuable).toBe(2); // and the head's stepper still caps at ITS hire
    expect(m.hires).toEqual([
      { purchaseOrderRentalLineId: HIRE_ID, poCode: "PO-0042", hireEndDate: "2026-09-14T00:00:00.000Z", overdue: false, qty: 2, available: 2 },
      // 3 of the October hire's 4, because the LINE only needs 5 — `available` still reports its real 4.
      { purchaseOrderRentalLineId: HIRE_2_ID, poCode: "PO-0051", hireEndDate: "2026-10-30T00:00:00.000Z", overdue: false, qty: 3, available: 4 },
    ]);
  });

  it("stops the issue spread at what the depot can actually lend", async () => {
    // Planned 5, but only 3 units exist across both hires. A best-effort spread is right here: the
    // panel shows what can go out today and the kit line keeps the shortfall, which is exactly what a
    // partly-issued line means. (allocateFromHires alone returns null for an uncoverable qty — that
    // rule is about a POST, where issuing 3 of the 5 someone asked for silently would be wrong.)
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [{ ...rentalKitLine, qty: 5 }] } as never);
    setHires([
      hire({ id: HIRE_ID, quantity: 2, receivedQuantity: 2, hireEndDate: new Date("2026-09-14T00:00:00Z") }),
      hire({ id: HIRE_2_ID, quantity: 1, receivedQuantity: 1, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") }),
    ]);

    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.hires?.map((h) => h.qty)).toEqual([2, 1]);
  });

  it("offers nothing to issue once the line is fully issued", async () => {
    // The line is met, so there is no spread — but the scan still resolves, because "already fully
    // issued" is a different message from "this depot has none", and the panel picks it off the cap.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    setHires([hire({ id: HIRE_ID }), hire({ id: HIRE_2_ID, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") })]);

    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.remainingIssuable).toBe(0);
    expect(m.hires).toEqual([]);
  });
});

// An EXPIRED hire is not offered to a new job, and this reversed a previous decision in this file —
// the old rule was "flagged, not blocked", on the reasoning that the job may genuinely need the kit
// today and the return trip is a separate logistics problem. It is not separate: the unit the provider
// is waiting to collect walks out of the building, and we are already being billed for the breach.
// The escape hatch is to EXTEND the hire, which is one action on the order and makes the same unit
// issuable again immediately (see extendHire, which moves the deadline on the engineer's holdings in
// the same transaction).
describe("scanLookup — an expired hire is not available to issue", () => {
  it("refuses the scan when every candidate hire has expired", async () => {
    // The issuable query is what the predicate narrows in production; here the mock stands in for
    // that narrowing returning nothing, while the live-hire query still holds the row — exactly the
    // state an expired hire is in.
    mockIssuableHires.mockResolvedValue([] as never);
    mockLiveHires.mockResolvedValue([hire({ hireEndDate: new Date("2020-01-01T00:00:00Z") })] as never);
    await expect(
      scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" }),
    ).rejects.toThrow(/period has ended|Extend the hire/i);
  });

  it("reads the ISSUABLE set on the way out, not the live set", async () => {
    mockIssuableHires.mockResolvedValue([] as never);
    mockLiveHires.mockResolvedValue([hire()] as never);
    await expect(
      scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" }),
    ).rejects.toThrow();
    // The point of the assertion: had the issue leg still asked the live query, that mock would have
    // supplied a perfectly good hire and the scan would have succeeded.
    expect(mockIssuableHires).toHaveBeenCalled();
  });

  it("still offers a hire that is within its period", async () => {
    setHires([hire({ hireEndDate: new Date("2099-01-01T00:00:00Z") })]);
    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.hire?.overdue).toBe(false);
    expect(m.remainingIssuable).toBeGreaterThan(0);
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

    // The 4th argument is the request-level company-local "today" — present on the way OUT so the
    // hire window is re-asserted inside the same conditional write. The RETURN assertions below pass
    // only three arguments on purpose: an expired hire must always be returnable.
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, 2, expect.any(Date));
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

  // The kit line's plan is a budget for the WHOLE request, not a per-line ceiling each line gets its
  // own copy of. Checked line by line against one movement snapshot, two lines of 2 against a line
  // planning 3 both read "3 remaining" and both passed — 4 units issued against a plan of 3, with the
  // engineer holding one nobody ordered. Unreachable while the panel could only ever send one line per
  // kit line; issuing across several hires in one post is exactly what makes it reachable.
  it("spends the kit line's plan ONCE across every line in the same post", async () => {
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [{ ...rentalKitLine, qty: 3 }] } as never);
    mockHireById.mockImplementation((async (id: string) => hire({ id })) as never);

    await expect(
      postIssue(JOB_ID, {
        direction: "issue",
        warehouseId: WH_ID,
        lines: [
          { source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_ID, jobKitLineId: "k1", qty: 2 },
          { source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_2_ID, jobKitLineId: "k1", qty: 2 },
        ],
      }),
    ).rejects.toThrow(/only 1 remaining on the kit list/i);
    expect(mockAdjustIssued).not.toHaveBeenCalled(); // refused before the transaction opened
  });

  it("issues one kit line across two hires in a single post", async () => {
    // The other side of the same budget: 2 + 1 against a plan of 3 is exactly right, and both hires
    // are drawn down in one movement rather than one post each.
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [{ ...rentalKitLine, qty: 3 }] } as never);
    mockHireById.mockImplementation((async (id: string) => hire({ id })) as never);
    mockHireByIdTx.mockImplementation((async (_tx: unknown, id: string) => hire({ id })) as never);

    await postIssue(JOB_ID, {
      direction: "issue",
      warehouseId: WH_ID,
      lines: [
        { source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_ID, jobKitLineId: "k1", qty: 2 },
        { source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_2_ID, jobKitLineId: "k1", qty: 1 },
      ],
    });

    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, 2, expect.any(Date));
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_2_ID, 1, expect.any(Date));
    // Each hire gets its OWN custody row — the engineer owes two different orders.
    expect(mockUpsertHolding).toHaveBeenCalledWith(expect.anything(), HIRE_ID, ENG_ID, 2, expect.anything());
    expect(mockUpsertHolding).toHaveBeenCalledWith(expect.anything(), HIRE_2_ID, ENG_ID, 1, expect.anything());
  });

  // Two DIFFERENT kit lines must keep two different budgets. Without this, a budget map keyed on
  // anything but the kit line (or on nothing at all) passes every other test in this file.
  it("keeps a separate plan budget per kit line", async () => {
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [
      { ...rentalKitLine, id: "k1", qty: 1 },
      { ...rentalKitLine, id: "k2", qty: 1 },
    ] } as never);
    mockHireById.mockImplementation((async (id: string) => hire({ id })) as never);
    mockHireByIdTx.mockImplementation((async (_tx: unknown, id: string) => hire({ id })) as never);

    await postIssue(JOB_ID, {
      direction: "issue",
      warehouseId: WH_ID,
      lines: [
        { source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_ID, jobKitLineId: "k1", qty: 1 },
        { source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_2_ID, jobKitLineId: "k2", qty: 1 },
      ],
    });

    // Both land: k1 spent its own 1, k2 spent its own. A shared budget would have refused the second.
    expect(mockAdjustIssued).toHaveBeenCalledTimes(2);
  });

  it("names the van reservation when it is what leaves no room", async () => {
    // The `vanReserved > 0` arm of the budget message — a colleague's pending transfer is already
    // bringing the planned unit, so the warehouse must be told WHY the line looks empty rather than
    // just that it is. Untested anywhere before, and the budget rewrite runs straight through it.
    // ...Once, deliberately: vi.clearAllMocks() keeps implementations, so a plain mockResolvedValue
    // here would leave a phantom van transfer on k1 for every test after this one.
    vi.mocked(transferRepo.findVanSourcesByKitLines).mockResolvedValueOnce(
      new Map([["k1", [{ status: "pending", quantity: 2 }]]]) as never,
    );
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [{ ...rentalKitLine, qty: 2 }] } as never);

    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(
      /only 0 left to issue here — 2 of the 2 planned are coming from another engineer's van/i,
    );
  });

  // Every hire movement moves a queue, and an ISSUE moves the same ones a return does: the order's own
  // page, the warehouse's on-hire pane, the deadline badges. postReturn has always said so; this leg
  // said nothing, so a scan-out left every one of them stale until somebody reloaded. One post can now
  // draw off several hires, so that was N stale panes per action, not one.
  it("tells the hire panes when kit goes OUT, once per order", async () => {
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [{ ...rentalKitLine, qty: 3 }] } as never);
    // Two hires on ONE order, plus one on another — two refreshes, not three.
    mockHireById.mockImplementation((async (id: string) => hire({ id, purchaseOrderId: id === HIRE_2_ID ? "8".repeat(24) : PO_ID, poCode: id === HIRE_2_ID ? "PO-0051" : "PO-0042" })) as never);
    mockHireByIdTx.mockImplementation((async (_tx: unknown, id: string) => hire({ id, purchaseOrderId: id === HIRE_2_ID ? "8".repeat(24) : PO_ID })) as never);

    await postIssue(JOB_ID, {
      direction: "issue",
      warehouseId: WH_ID,
      lines: [
        { source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_ID, jobKitLineId: "k1", qty: 1 },
        { source: "rental", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: HIRE_2_ID, jobKitLineId: "k1", qty: 1 },
      ],
    });

    const rooms = vi.mocked(realtime.emitToRoom).mock.calls.filter((c) => c[1] === "rental_hire:updated");
    expect(rooms.map((c) => (c[2] as { purchaseOrderId: string }).purchaseOrderId).sort()).toEqual([PO_ID, "8".repeat(24)].sort());
  });

  it("refuses an IRM line filed against a rental kit line", async () => {
    // The kit line comes from the CLIENT. The rental arm has always checked that the line it names is
    // actually this hired item's line; the IRM arm checked nothing, so a hand-built request could spend
    // a hire line's budget with an IRM movement and have every tally read it as the hired kit going out.
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [rentalKitLine] } as never);
    vi.mocked(irmService.requireActiveIrmItem).mockResolvedValue({ id: IRM_ID, name: "Cat6 Cable", baseUnit: "Each", trackSerialNumbers: false, trackBatchNumbers: false } as never);

    await expect(
      postIssue(JOB_ID, {
        direction: "issue",
        warehouseId: WH_ID,
        lines: [{ source: "irm", irmItemId: IRM_ID, jobKitLineId: "k1", qty: 1 }],
      }),
    ).rejects.toThrow(/isn't the item planned on that kit line/i);
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

  // ── THE STALE-TAB CASE ────────────────────────────────────────────────────────────────────────
  //
  // The read-side filter cannot close this on its own: the scan preview and this post are two
  // requests, and a browser tab can sit open across the deadline. So the post has to re-decide, and
  // this is the test that says it does — the availability answer the client is holding is irrelevant.
  it("refuses a hire whose period ended while the tab sat open", async () => {
    mockHireByIdTx.mockResolvedValue(hire({ hireEndDate: new Date("2020-01-01T00:00:00Z") }) as never);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/can no longer be issued|Extend the hire/i);
    // Refused BEFORE any counter moved, so a rejected post leaves the hire exactly as it was.
    expect(mockAdjustIssued).not.toHaveBeenCalled();
  });

  // The message has to name the real reason. A generic "stock changed" 409 sends the warehouse hunting
  // for a quantity problem that does not exist, and the actual fix — extend the hire — is one action
  // on the order that nobody would think to look for.
  it("names the deadline and the way out, rather than blaming stock levels", async () => {
    mockHireByIdTx.mockResolvedValue(hire({ hireEndDate: new Date("2026-08-16T00:00:00Z") }) as never);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/2026-08-16/);
    await expect(postIssue(JOB_ID, issueInput)).rejects.toThrow(/Extend the hire/i);
  });

  // Belt to that braces: even if the read-side check above were somehow passed, the window is also
  // asserted inside the conditional write. This pins that the date actually reaches it.
  it("hands the request-level date to the atomic write so the DB re-asserts the window", async () => {
    await postIssue(JOB_ID, issueInput);
    const dateArg = mockAdjustIssued.mock.calls[0]![3];
    expect(dateArg).toBeInstanceOf(Date);
    // A calendar day at UTC midnight — the convention every hire date in this codebase uses, so the
    // comparison against `hireEndDate` is exact.
    expect((dateArg as Date).toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  // A hire ending TODAY is still valid — a hire runs THROUGH its end date. Getting this boundary wrong
  // would silently shorten every hire in the system by a day.
  it("allows a hire that ends today", async () => {
    // Today's date IN THE COMPANY TIMEZONE (the harness mocks it to Europe/London), derived the same
    // way startOfDayIn derives it. Using the UTC date here instead would make this test fail for the
    // one hour a day when London is a day ahead of UTC — green all afternoon, red at 00:30 BST.
    const londonToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    mockHireByIdTx.mockResolvedValue(hire({ hireEndDate: new Date(`${londonToday}T00:00:00.000Z`) }) as never);
    await expect(postIssue(JOB_ID, issueInput)).resolves.toBeDefined();
  });
});

// The agreement between the preview and the commitment is the whole point of the multi-hire spread,
// and asserting it by reasoning about two separate fixtures is not the same as asserting it. These
// feed a real scanLookup result STRAIGHT into the post, exactly as the panel does.
describe("scan → post round trip", () => {
  it("issues every hire the scan offered, in one movement", async () => {
    mockJob.mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0117", status: "accepted", assignedEngineerId: ENG_ID, assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [{ ...rentalKitLine, qty: 5 }] } as never);
    setHires([
      hire({ id: HIRE_ID, quantity: 2, receivedQuantity: 2, hireEndDate: new Date("2026-09-14T00:00:00Z") }),
      hire({ id: HIRE_2_ID, quantity: 4, receivedQuantity: 4, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") }),
    ]);
    mockHireById.mockImplementation((async (id: string) => hire({ id, quantity: 4, receivedQuantity: 4 })) as never);
    mockHireByIdTx.mockImplementation((async (_tx: unknown, id: string) => hire({ id, quantity: 4, receivedQuantity: 4 })) as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "issue", warehouseId: WH_ID, code: "RNT-0007" });

    // Exactly what JobScanPanel builds from a fanned-out scan: one line per offered hire, at its cap.
    await postIssue(JOB_ID, {
      direction: "issue",
      warehouseId: WH_ID,
      lines: (m.hires ?? []).map((h) => ({
        source: "rental" as const,
        rentalItemId: RENTAL_ID,
        purchaseOrderRentalLineId: h.purchaseOrderRentalLineId,
        jobKitLineId: m.jobKitLineId!,
        qty: h.qty,
      })),
    });

    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, 2, expect.any(Date));
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_2_ID, 3, expect.any(Date));
  });

  it("returns every hire the scan offered, in one movement", async () => {
    setHires([
      hire({ id: HIRE_ID, hireEndDate: new Date("2026-09-14T00:00:00Z") }),
      hire({ id: HIRE_2_ID, poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z") }),
    ]);
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 },
    ] as never);
    mockHireById.mockImplementation((async (id: string) => hire({ id, issuedQuantity: 1 })) as never);
    mockHireByIdTx.mockImplementation((async (_tx: unknown, id: string) => hire({ id, issuedQuantity: 1 })) as never);
    mockFindHoldingTx.mockResolvedValue({ quantityOnHand: 1, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z") } as never);
    mockUpsertHolding.mockResolvedValue({ quantityOnHand: 0, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z") } as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });

    await postReturn(JOB_ID, {
      direction: "return",
      warehouseId: WH_ID,
      lines: (m.hires ?? []).map((h) => ({
        source: "rental" as const,
        rentalItemId: RENTAL_ID,
        purchaseOrderRentalLineId: h.purchaseOrderRentalLineId,
        jobKitLineId: m.jobKitLineId!,
        qty: h.qty,
      })),
    });

    // Both hires credited — the kit line's budget covered the pair, which is the surplus the old
    // single-hire cap could never have let the panel stage in the first place.
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, -1);
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_2_ID, -1);
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

  // A damaged return opens a custody exit keyed [sourceType, sourceId, hire, kind], and the movement is
  // the sourceId — so TWO damaged lines on the SAME hire in one post collide, and createExitTx treats
  // the collision as an idempotent retry and returns the first row. The second line's units would be
  // drained from custody and released back to the shelf by adjustHireIssuedQtyTx, with no exit holding
  // them: a damaged tester becomes issuable to the next job. The panel makes one card per hire so it
  // cannot send this, but a client-upheld invariant is not an invariant — and multi-hire posts are new.
  it("refuses two damaged lines against the same hire in one post", async () => {
    await expect(
      postReturn(JOB_ID, {
        direction: "return",
        warehouseId: WH_ID,
        lines: [
          returnLine({ qty: 1, condition: "damaged", damagePhotoUrl: "https://res.cloudinary.com/x/a.jpg", damageReason: "Cracked screen" }),
          returnLine({ qty: 1, condition: "damaged", damagePhotoUrl: "https://res.cloudinary.com/x/b.jpg", damageReason: "Snapped lead" }),
        ],
      }),
    ).rejects.toThrow(/one damaged line per hire/i);
    expect(mockCustodyExit).not.toHaveBeenCalled();
  });

  it("still allows a good line and a damaged line against the same hire", async () => {
    // The ordinary split — two lines, one hire, two conditions. Only ONE of them creates an exit, so
    // there is nothing to collide.
    await postReturn(JOB_ID, {
      direction: "return",
      warehouseId: WH_ID,
      lines: [
        returnLine({ qty: 1 }),
        returnLine({ qty: 1, condition: "damaged", damagePhotoUrl: "https://res.cloudinary.com/x/a.jpg", damageReason: "Cracked screen" }),
      ],
    });
    expect(mockCustodyExit).toHaveBeenCalledTimes(1);
  });

  it("drains custody and releases the units back into the hire's pool", async () => {
    await postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine()] });

    expect(mockUpsertHolding).toHaveBeenCalledWith(expect.anything(), HIRE_ID, ENG_ID, -2, expect.anything());
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, -2);
    expect(vi.mocked(rentalCustodyRepo.insertRentalTxnTx)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "job_return", quantityDelta: -2 }));
  });

  // ── THE ASYMMETRY ─────────────────────────────────────────────────────────────────────────────
  //
  // An EXPIRED hire is refused on the way out and must always be accepted on the way back. It is the
  // one that most needs to come back, and gating the return would strand overdue kit in a van with
  // nothing to scan it against — leaving it on the overdue badge forever with no way to clear it.
  it("takes back a hire whose period has long since ended", async () => {
    const expired = new Date("2020-01-01T00:00:00Z");
    mockFindHoldingTx.mockResolvedValue({ quantityOnHand: 2, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: expired } as never);
    mockHireByIdTx.mockResolvedValue(hire({ hireEndDate: expired, issuedQuantity: 2 }) as never);

    await expect(postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine()] })).resolves.toBeDefined();
    // Three arguments, not four: no date is passed on a return, so the window clause is never built.
    expect(mockAdjustIssued).toHaveBeenCalledWith(expect.anything(), HIRE_ID, -2);
  });

  it("never sends a hire-window date on the return leg", async () => {
    await postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine()] });
    for (const call of mockAdjustIssued.mock.calls) expect(call[3]).toBeUndefined();
  });

  it("does NOT touch the hire's supplier-facing returnedQuantity", async () => {
    await postReturn(JOB_ID, { direction: "return", warehouseId: WH_ID, lines: [returnLine()] });
    // Engineer→warehouse and warehouse→provider are two different events. Only the second one ends
    // the hire; conflating them would mark a hire collected while it sat on our own shelf.
    for (const call of mockAdjustIssued.mock.calls) expect(call[2]).toBeLessThan(0);
    expect(mockCustodyExit).not.toHaveBeenCalled();
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
    // ...and a damage custody exit is opened, which is what takes the unit out of the ISSUABLE pool
    // while leaving it held and supplier-returnable, and what the PM later settles into a damage note.
    expect(mockCustodyExit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purchaseOrderRentalLineId: HIRE_ID, kind: "damage", qty: 2, custodyState: "held_damaged", reason: "Screen cracked on site" }),
    );
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
    setHires([hire({ receivedQuantity: 3 }), hire({ id: HIRE_2_ID, receivedQuantity: 2 })]);
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
// Both are about the SAME invariant — hired kit leaves a job by being scanned back, declared lost, and
// by no other route. Neither shape is reachable through the happy path, which is exactly why they
// survived: the schema bars a rental consume, the validation enum bars `source: "rental"`, and the
// reconcile never writes hired kit off. Each of these got past all three.
//
// The guard no longer THROWS — a hire outstanding must not veto an unrelated company-stock write-off —
// so what these now pin is the rule that replaced it: the job does not reach its terminal, locking
// state while hired kit is still out, and the response says which hires are holding it open.
describe("closeReconcile — hired kit holds the job open without blocking the rest", () => {
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

  it("keeps the job out of its terminal state when a SECOND hired item is still out", async () => {
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

    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    // Named, so the screen can say what is still owed rather than silently doing nothing...
    expect(res.rentalOutstanding).toEqual([expect.objectContaining({ itemName: "OTDR", qty: 1 })]);
    // ...and NOT locked. `reconciled` refuses every later scan, so closing here would strand the OTDR
    // in the van with no way left to book it back in.
    expect(vi.mocked(repo.upsertSummaryTx)).toHaveBeenCalledWith(expect.anything(), JOB_ID, { goodsStatus: "awaiting_return" });
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
    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(res.rentalOutstanding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemName: "Fibre Tester", qty: 2 }),
        expect.objectContaining({ itemName: "OTDR", qty: 1 }),
      ]),
    );
    expect(res.rentalOutstanding).toHaveLength(2);
  });

  it("names the exact HIRE the outstanding units sit on, so the screen can offer the action", async () => {
    // The reconcile screen offers company shortfall a Write off button on the spot. Hired kit got a
    // toast telling the operator to declare it lost, with the only button that does that four clicks
    // away on the warehouse's hire pane. The list has to carry the hire, its order and the engineer, or
    // the panel can only restate the problem.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good", purchaseOrderRentalLineId: HIRE_ID }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      {
        purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042",
        hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 2,
        purchaseOrderRentalLine: { purchaseOrderId: PO_ID },
      },
    ] as never);

    const res = await closeReconcile(JOB_ID, {});
    expect(res.rentalOutstanding).toEqual([
      expect.objectContaining({
        itemName: "Fibre Tester",
        qty: 2,
        // The person it would be declared against — a loss writes off somebody else's equipment and
        // the name belongs on the record, so the server states it rather than the client guessing.
        engineerId: ENG_ID,
        engineerName: "Dave",
        hires: [{ purchaseOrderRentalLineId: HIRE_ID, purchaseOrderId: PO_ID, poCode: "PO-0042", qty: 2 }],
      }),
    ]);
  });

  it("still lists kit it cannot trace to a hire, just without the action", async () => {
    // A movement line written before hires carried an id. Dropping the row would hide equipment that is
    // genuinely still out; listing it with no hire is the honest degradation, and the guard that keeps
    // the job open reads the per-ITEM tally so it is unaffected either way.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 2 },
    ] as never);

    const res = await closeReconcile(JOB_ID, {});
    expect(res.rentalOutstanding).toHaveLength(1);
    expect(res.rentalOutstanding[0]!.qty).toBe(2);
    expect(res.rentalOutstanding[0]!.hires).toEqual([]);
    // …and it still holds the job open, which is the whole point of the guard.
    expect(vi.mocked(repo.upsertSummaryTx)).toHaveBeenCalledWith(expect.anything(), JOB_ID, { goodsStatus: "awaiting_return" });
  });

  it("does NOT record a reconcile in the audit log for a job it left open", async () => {
    // THE WORST OF THE THREE. The job correctly stayed `awaiting_return` — and the audit log said
    // `goods_management.reconciled` anyway. The trail is the artefact somebody checks months later,
    // and it was claiming a job closed that never did.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 2 },
    ] as never);

    await closeReconcile(JOB_ID, { writeOffLost: true });

    const actions = vi.mocked(audit.record).mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).not.toContain("goods_management.reconciled");
    expect(actions).toContain("goods_management.reconcile_deferred");
    // The line has to name what stopped it, or it explains nothing to whoever reads it later.
    const deferred = vi.mocked(audit.record).mock.calls.find((c) => (c[0] as { action: string }).action === "goods_management.reconcile_deferred");
    expect((deferred![0] as { targetLabel: string }).targetLabel).toMatch(/2 × Fibre Tester/);
  });

  it("tells the engineer's screen the job was DEFERRED, not reconciled", async () => {
    // An engineer's kit list locks itself on a reconcile event. Sending one while their van still holds
    // a hired tester would hide the one row they still have to act on.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 2 },
    ] as never);

    await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(vi.mocked(realtime.emitToUser)).toHaveBeenCalledWith(ENG_ID, "goods:returned", { jobId: JOB_ID, direction: "reconcile_deferred" });
  });

  it("records a real reconcile once the hired kit is back", async () => {
    // The other side of the same rule — the deferred action must not become the new default.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
      { status: "posted", direction: "return", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([] as never);

    const res = await closeReconcile(JOB_ID, {});
    expect(res.rentalOutstanding).toEqual([]);
    const actions = vi.mocked(audit.record).mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain("goods_management.reconciled");
    expect(vi.mocked(repo.upsertSummaryTx)).toHaveBeenCalledWith(expect.anything(), JOB_ID, { goodsStatus: "reconciled" });
    expect(vi.mocked(realtime.emitToUser)).toHaveBeenCalledWith(ENG_ID, "goods:returned", { jobId: JOB_ID, direction: "reconcile" });
  });

  it("writes off unaccounted COMPANY stock even while a hire is still out", async () => {
    // The defect the throw caused. Two different pools, two different owners, two different decisions —
    // and an outstanding hire used to refuse the whole reconcile, so the company shortfall could not be
    // booked either and the screen showed an error where the unaccounted list belonged.
    mockJob.mockResolvedValue({
      id: JOB_ID, jobNumber: "JOB-2026-0117", status: "completed", assignedEngineerId: ENG_ID,
      assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co",
      kitLines: [rentalKitLine, { id: "k3", lineType: "irm", irmItemId: IRM_ID, rentalItemId: null, customerStockEntryId: null, warehouseId: WH_ID, itemName: "Cat6 Box", qty: 1 }],
    } as never);
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [
        { jobKitLineId: "k1", qty: 2, condition: "good" },
        { jobKitLineId: "k3", qty: 1, condition: "good" },
      ] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 2 },
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 1 }] as never);

    const res = await closeReconcile(JOB_ID, { writeOffLost: true, writeOffReason: "not_returned" });

    // The company box was written off — one movement, and it names the IRM item, never the hire.
    expect(mockCreate).toHaveBeenCalled();
    const lines = mockCreate.mock.calls.at(-1)?.[1] as { source: string; itemName: string }[];
    expect(lines.map((l) => l.source)).toEqual(["irm"]);
    // The hire is untouched by the write-off and still holds the job open.
    expect(res.rentalOutstanding).toEqual([expect.objectContaining({ itemName: "Fibre Tester", qty: 2 })]);

    // …AND THE WRITE-OFF IS ON THE RECORD. It was the same independence one step further on: the
    // outcome entry used to be a single ternary asking `!canGoTerminal` FIRST, so a deferring hire
    // swallowed the write-off line entirely. Units left the ledger and the only entry written said
    // `reconcile_deferred` — no quantity, no reason. Nothing would ever say it either, because the
    // next run finds the holdings already drained and records a plain `reconciled`.
    const actions = vi.mocked(audit.record).mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain("goods_management.written_off_lost");
    expect(actions).toContain("goods_management.reconcile_deferred");
    expect(actions).not.toContain("goods_management.reconciled");
    const wrote = vi.mocked(audit.record).mock.calls.find((c) => (c[0] as { action: string }).action === "goods_management.written_off_lost");
    expect((wrote![0] as { targetLabel: string }).targetLabel).toMatch(/1 unit written off as lost: not_returned/);
  });

  it("still says only 'written off' on a clean close, not two lines for one run", async () => {
    // The other side of splitting them: a job that DID close after a write-off is fully described by
    // the write-off entry, and a second line saying the same run finished is noise in the trail.
    mockJob.mockResolvedValue({
      id: JOB_ID, jobNumber: "JOB-2026-0117", status: "completed", assignedEngineerId: ENG_ID,
      assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co",
      kitLines: [{ id: "k3", lineType: "irm", irmItemId: IRM_ID, rentalItemId: null, customerStockEntryId: null, warehouseId: WH_ID, itemName: "Cat6 Box", qty: 1 }],
    } as never);
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k3", qty: 1, condition: "good" }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 1 }] as never);

    await closeReconcile(JOB_ID, { writeOffLost: true, writeOffReason: "not_returned" });

    const actions = vi.mocked(audit.record).mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toEqual(["goods_management.written_off_lost"]);
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
//
// The date comes from THIS JOB'S movements intersected with the engineer's live holdings. Both halves
// appear in every fixture below — a movement that does not name its hire contributes no deadline,
// which is the correct reading and the reason these fixtures carry `purchaseOrderRentalLineId`.
describe("getJobKitTallies — the hire deadline is this job's, not the engineer's", () => {
  const DEADLINE = new Date("2026-09-14T00:00:00Z");
  const holding = (over: Record<string, unknown> = {}) => ({
    purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester",
    poCode: "PO-0042", hireEndDate: DEADLINE, quantityOnHand: 2, ...over,
  });
  const issuedTwo = [{ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good", purchaseOrderRentalLineId: HIRE_ID }] }];

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
      { status: "posted", direction: "return", warehouseId: WH_ID, items: [{ jobKitLineId: "k1", qty: 2, condition: "good", purchaseOrderRentalLineId: HIRE_ID }] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1).toMatchObject({ remaining: 0, hireEndDate: null, hireOverdue: false, hires: [] });
  });

  it("flags a deadline that has already passed", async () => {
    mockMoves.mockResolvedValue(issuedTwo as never);
    mockHoldingsByEngineer.mockResolvedValue([holding({ hireEndDate: new Date("2020-01-01T00:00:00Z") })] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1.hireOverdue).toBe(true);
  });

  it("takes the SOONEST deadline when THIS JOB drew the item off two hires", async () => {
    // One row, one date — and it has to be the one that bites first. Erring early is safe here;
    // erring late would tell someone they had until the 30th on kit due back on the 14th. The others
    // are not dropped: `hires` carries them so the row can offer the breakdown.
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [
        { jobKitLineId: "k1", qty: 1, condition: "good", purchaseOrderRentalLineId: HIRE_2_ID },
        { jobKitLineId: "k1", qty: 1, condition: "good", purchaseOrderRentalLineId: HIRE_ID },
      ] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_2_ID, hireEndDate: new Date("2026-10-30T00:00:00Z"), quantityOnHand: 1 }),
      holding({ quantityOnHand: 1 }),
    ] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1.hireEndDate).toEqual(DEADLINE);
    expect(t.k1.hires.map((h) => h.purchaseOrderRentalLineId)).toEqual([HIRE_ID, HIRE_2_ID]);
  });

  // `hireOverdue` describes the LINE — the soonest of its hires. Consumers that need to say how MANY
  // units are actually late cannot get there from it: a line holding 1 unit on an overdue hire and 2
  // on next month's is `hireOverdue: true` with `remaining: 3`, and the engineer's job page read that
  // as "3 are past their return date, bring them all back". Two of them were not due for weeks.
  it("marks overdue PER HIRE, not just for the line", async () => {
    mockMoves.mockResolvedValue([
      { status: "posted", direction: "issue", warehouseId: WH_ID, items: [
        { jobKitLineId: "k1", qty: 1, condition: "good", purchaseOrderRentalLineId: HIRE_ID },
        { jobKitLineId: "k1", qty: 2, condition: "good", purchaseOrderRentalLineId: HIRE_2_ID },
      ] },
    ] as never);
    mockHoldingsByEngineer.mockResolvedValue([
      holding({ hireEndDate: new Date("2020-01-01T00:00:00Z"), quantityOnHand: 1 }), // long gone
      holding({ purchaseOrderRentalLineId: HIRE_2_ID, hireEndDate: new Date("2026-12-31T00:00:00Z"), quantityOnHand: 2 }),
    ] as never);

    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1.hireOverdue).toBe(true); // the line as a whole still has something late
    expect(t.k1.hires.map((h) => [h.qty, h.overdue])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("never borrows a deadline from a hire this job never issued", async () => {
    // THE BUG THIS REPLACES. The engineer is holding the same catalogue item off two orders — one for
    // this job, one for another — and the old per-item aggregate took the earliest of BOTH. This job's
    // row showed a date, and an overdue flag, about units it never received.
    mockMoves.mockResolvedValue(issuedTwo as never);
    mockHoldingsByEngineer.mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_2_ID, poCode: "PO-0099", hireEndDate: new Date("2020-01-01T00:00:00Z"), quantityOnHand: 1 }),
      holding({ quantityOnHand: 2 }),
    ] as never);
    const t = await getJobKitTallies(JOB_ID);
    expect(t.k1.hireEndDate).toEqual(DEADLINE);
    expect(t.k1.hireOverdue).toBe(false);
    expect(t.k1.hires).toHaveLength(1);
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
    setHires([hire()]);
    const [row] = await getWarehouseDemand(WH_ID);
    expect(row).toEqual({ source: "rental", itemName: "Fibre Tester", inStock: 3, planned: 2, free: 1 });
  });

  it("nets units already out with an engineer out of the depot pool", async () => {
    // Same hire, but 2 of the 3 are in a van — only 1 is actually on the shelf to give out.
    setHires([hire({ issuedQuantity: 2 })]);
    const [row] = await getWarehouseDemand(WH_ID);
    expect(row).toMatchObject({ inStock: 1, planned: 2, free: -1 });
  });

  it("still reports a genuine shortfall when nothing is on hire here", async () => {
    setHires([]);
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
    setHires([hire({ id: HIRE_ID, hireEndDate: new Date("2026-10-30T00:00:00Z") })]);
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
    setHires([]);
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
    setHires([hire({ id: HIRE_ID }), hire({ id: HIRE_2_ID })]);
    mockHoldingsByEngineer.mockResolvedValue([
      { purchaseOrderRentalLineId: HIRE_2_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0051", hireEndDate: null, quantityOnHand: 1 },
      { purchaseOrderRentalLineId: HIRE_ID, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand: 1 },
    ] as never);

    const m = await scanLookup({ jobId: JOB_ID, direction: "return", warehouseId: WH_ID, code: "RNT-0007" });
    expect(m.purchaseOrderRentalLineId).toBe(HIRE_ID);
  });
});

// ══ PART A ═════════════════════════════════════════════════════════════════════════════════════
// RECONCILE COUNTS HIRED KIT PER HIRE, NOT PER CATALOGUE ITEM
//
// The gate used to ask `min(this item's raw remainder, every hire of this item the engineer holds)`.
// Two orders of the same model are not interchangeable, so that compared one hire's movement ledger
// against another hire's custody — and it could land either way: block a job on units it never
// touched, or close one while its OWN hire was still out. Closing is the worse half, because
// `reconciled` refuses every later scan and the kit is then stranded in the van.
//
// Live proof, JOB-2026-0036 / RNT-0005: issued 3 off one hire, engineer holds 1 of THAT hire, a second
// hire of the same catalogue item carries 3 more. Item level saw min(3, 4) = 3. The truth is 1.

describe("closeReconcile — hired kit is counted per HIRE", () => {
  const OTHER_HIRE = "7".repeat(24);

  beforeEach(() => {
    vi.mocked(repo.getSummary).mockResolvedValue({ goodsStatus: "awaiting_return", workSummary: null, lastMovementAt: null } as never);
    mockJob.mockResolvedValue({
      id: JOB_ID, jobNumber: "JOB-2026-0036", status: "completed", assignedEngineerId: ENG_ID,
      assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines: [rentalKitLine],
    } as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([] as never);
  });

  /** One issue movement of `qty` off `hire`, filed against kit line `kl`. */
  const issued = (qty: number, hire: string, kl = "k1") =>
    ({ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: kl, qty, condition: "good", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: hire }] });
  const returned = (qty: number, hire: string, kl = "k1") =>
    ({ status: "posted", direction: "return", warehouseId: WH_ID, items: [{ jobKitLineId: kl, qty, condition: "good", rentalItemId: RENTAL_ID, purchaseOrderRentalLineId: hire }] });
  const holds = (hire: string, quantityOnHand: number) =>
    ({ purchaseOrderRentalLineId: hire, rentalItemId: RENTAL_ID, itemName: "Fibre Tester", poCode: "PO-0042", hireEndDate: new Date("2026-09-14T00:00:00Z"), quantityOnHand });
  /** A rental line written before hires carried an id — neither hire nor item on the movement line. */
  const legacyIssue = (qty: number, kl = "k1") =>
    ({ status: "posted", direction: "issue", warehouseId: WH_ID, items: [{ jobKitLineId: kl, qty, condition: "good" }] });

  // 10 + 1. The reported scenario, in its own numbers.
  it("counts only the job's OWN hire when another hire of the same item is in the van (JOB-2026-0036)", async () => {
    mockMoves.mockResolvedValue([issued(3, HIRE_ID)] as never);
    // 1 unit of the job's hire is left; a DIFFERENT hire of the same catalogue item carries 3 more.
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 1), holds(OTHER_HIRE, 3)] as never);

    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(res.rentalOutstanding).toEqual([expect.objectContaining({ qty: 1 })]);
    // The row's own hire breakdown must agree with its quantity — item level could disagree with it.
    expect(res.rentalOutstanding[0]!.hires.reduce((n, h) => n + h.qty, 0)).toBe(1);
    expect(res.rentalOutstanding[0]!.hires.map((h) => h.purchaseOrderRentalLineId)).toEqual([HIRE_ID]);
  });

  // THE DANGEROUS DIRECTION. A return binds its hire from CUSTODY, not from what the issue used, so a
  // job can legitimately issue off hire A and scan back against hire B. At item level those two net to
  // zero and the job reconciled — locking itself against every later scan with hire A still in the van
  // and nothing left that could book it in. Per hire, A still owes its units.
  it("does NOT close when a return was bound to a different hire than the issue", async () => {
    mockMoves.mockResolvedValue([issued(3, HIRE_ID), returned(3, OTHER_HIRE)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 3)] as never);

    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(res.rentalOutstanding).toEqual([expect.objectContaining({ qty: 3 })]);
    expect(res.rentalOutstanding[0]!.hires).toEqual([expect.objectContaining({ purchaseOrderRentalLineId: HIRE_ID, qty: 3 })]);
    expect(vi.mocked(repo.upsertSummaryTx)).toHaveBeenCalledWith(expect.anything(), JOB_ID, { goodsStatus: "awaiting_return" });
  });

  // 5. An unrelated hire, fully settled on this job, must not hold it open.
  it("closes the job when its own hire is square, however much of the item sits on another hire", async () => {
    mockMoves.mockResolvedValue([issued(2, HIRE_ID), returned(2, HIRE_ID)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(OTHER_HIRE, 5)] as never);

    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(res.rentalOutstanding).toEqual([]);
    expect(vi.mocked(repo.upsertSummaryTx)).toHaveBeenCalledWith(expect.anything(), JOB_ID, expect.objectContaining({ goodsStatus: "reconciled" }));
  });

  // 4. Its own hire genuinely outstanding still blocks — the rule must not have been loosened.
  it("keeps the job open while its own hire is genuinely still out", async () => {
    mockMoves.mockResolvedValue([issued(2, HIRE_ID)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 2)] as never);

    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(res.rentalOutstanding).toEqual([expect.objectContaining({ qty: 2 })]);
    expect(vi.mocked(repo.upsertSummaryTx)).toHaveBeenCalledWith(expect.anything(), JOB_ID, { goodsStatus: "awaiting_return" });
  });

  // 2. One job drawing on two hires of one item: each hire answers for its own units.
  it("adds up two hires of one item separately, never as a single pool", async () => {
    mockMoves.mockResolvedValue([issued(2, HIRE_ID), issued(3, OTHER_HIRE)] as never);
    // 1 of the first hire left, 2 of the second — the other units went back or were declared lost.
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 1), holds(OTHER_HIRE, 2)] as never);

    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(res.rentalOutstanding).toEqual([expect.objectContaining({ qty: 3 })]); // 1 + 2, not min(5, 3)
    expect(res.rentalOutstanding[0]!.hires.map((h) => h.qty).sort()).toEqual([1, 2]);
  });

  // 6. A job return settles the hire it names, and only that one.
  it("settles the hire the return was posted against", async () => {
    mockMoves.mockResolvedValue([issued(2, HIRE_ID), issued(2, OTHER_HIRE), returned(2, HIRE_ID)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 2), holds(OTHER_HIRE, 2)] as never);

    // HIRE_ID nets to 0 even though the engineer still holds 2 of it (those units are Field Stock's or
    // another job's); OTHER_HIRE still owes 2.
    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(res.rentalOutstanding[0]!.hires).toEqual([expect.objectContaining({ purchaseOrderRentalLineId: OTHER_HIRE, qty: 2 })]);
  });

  // 7 + 8. Loss and recovery move CUSTODY and write no job movement, so the clamp is what sees them.
  it("follows a declared loss down through custody without a job movement for it", async () => {
    // Issue 3, return 1 leaves the ledger saying 2 outstanding. One of those 2 was then declared lost,
    // which drained custody to 1 and wrote nothing on the job. Outstanding is 1, and the job stays open.
    mockMoves.mockResolvedValue([issued(3, HIRE_ID), returned(1, HIRE_ID)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 1)] as never);
    expect((await closeReconcile(JOB_ID, { writeOffLost: true })).rentalOutstanding).toEqual([expect.objectContaining({ qty: 1 })]);
  });

  it("lets the job close once the last unit is settled, by return or by loss", async () => {
    // The final unit went — scanned back, or declared lost and recovered to the DEPOT SHELF, which is
    // where recovery puts it. Either way custody is empty and nothing is outstanding.
    mockMoves.mockResolvedValue([issued(3, HIRE_ID), returned(1, HIRE_ID)] as never);
    mockHoldingsByEngineer.mockResolvedValue([] as never);
    const res = await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(res.rentalOutstanding).toEqual([]);
    expect(vi.mocked(repo.upsertSummaryTx)).toHaveBeenCalledWith(expect.anything(), JOB_ID, expect.objectContaining({ goodsStatus: "reconciled" }));
  });

  it("never writes hired kit off as our own loss, whatever it is counted per", async () => {
    mockMoves.mockResolvedValue([issued(2, HIRE_ID)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 2)] as never);
    await closeReconcile(JOB_ID, { writeOffLost: true });
    expect(mockCreate).not.toHaveBeenCalled(); // no consume/lost movement for a hire, ever
  });

  // 9. Missing hire identity must fail CLOSED.
  it("still holds the job open for a rental line that names no hire at all", async () => {
    mockMoves.mockResolvedValue([legacyIssue(2)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 2)] as never);
    expect((await closeReconcile(JOB_ID, { writeOffLost: true })).rentalOutstanding).toEqual([expect.objectContaining({ qty: 2 })]);
  });

  it("caps a hire-less line at what the engineer actually holds of that item", async () => {
    mockMoves.mockResolvedValue([legacyIssue(5)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 1)] as never);
    expect((await closeReconcile(JOB_ID, { writeOffLost: true })).rentalOutstanding).toEqual([expect.objectContaining({ qty: 1 })]);
  });

  it("does not let a hire-less line double-count on top of an identified hire", async () => {
    // 2 identified on HIRE_ID plus a legacy line for the same item: the legacy arm may only claim
    // custody the identified hires have not already claimed.
    mockMoves.mockResolvedValue([issued(2, HIRE_ID), legacyIssue(2)] as never);
    mockHoldingsByEngineer.mockResolvedValue([holds(HIRE_ID, 2)] as never);
    expect((await closeReconcile(JOB_ID, { writeOffLost: true })).rentalOutstanding).toEqual([expect.objectContaining({ qty: 2 })]);
  });
});

// ══ PART B ═════════════════════════════════════════════════════════════════════════════════════
// A WRITE-OFF SETTLES THE KIT LINE IT WAS BOOKED FOR
//
// `closeReconcile` used to post its `consume/lost` line with `jobKitLineId: null`, because the
// unaccounted list is grouped per ITEM. Every per-kit-line tally in this module matches on
// `jobKitLineId`, so the write-off was invisible to all of them: the line's remainder never fell,
// for ever, while the stock had already left the engineer's balance.
//
// Live proof, JOB-2026-0015 / IRS-0007: issue 8, a declared consume of 4, then GM-0113 consume/lost
// 4 with no kit line and a matching job_lost -4 on the engineer ledger. Truth outstanding: 0. Every
// tally said 4. Fixed at the source (the write-off now names its lines) AND on the read side, so the
// two rows already written read correctly without rewriting either of them.

describe("closeReconcile — IRM write-offs settle their own kit line", () => {
  const IRM_2 = "8".repeat(24);
  const irmLine = (id: string, irmItemId: string, itemName: string, qty: number) =>
    ({ id, lineType: "irm", irmItemId, rentalItemId: null, customerStockEntryId: null, warehouseId: WH_ID, itemName, qty });
  const irmJob = (kitLines: unknown[]) => ({
    id: JOB_ID, jobNumber: "JOB-2026-0015", status: "completed", assignedEngineerId: ENG_ID,
    assignedEngineerName: "Dave", assignedEngineerEmail: "dave@x.co", kitLines,
  });
  const mv = (direction: string, items: Record<string, unknown>[]) => ({ status: "posted", direction, warehouseId: WH_ID, items });

  beforeEach(() => {
    vi.mocked(repo.getSummary).mockResolvedValue({ goodsStatus: "awaiting_return", workSummary: null, lastMovementAt: null } as never);
    mockHoldingsByEngineer.mockResolvedValue([] as never);
    mockJob.mockResolvedValue(irmJob([irmLine("k3", IRM_ID, "Cat6 Box", 10)]) as never);
    vi.mocked(engineerStockRepo.findEngineerBalanceTx).mockResolvedValue({ quantityOnHand: 4 } as never);
    vi.mocked(engineerStockRepo.upsertEngineerBalanceTx).mockResolvedValue({ quantityOnHand: 0 } as never);
  });

  // 14. The phantom, where the balance clamp cannot mask it.
  it("reads a historical write-off that named no kit line as settled, not as still outstanding", async () => {
    // issued 10, declared consume 3, written off 7 (unattributed) ⇒ nothing unresolved. The engineer
    // still holds 10 of the same item from OTHER work, which is what makes this the discriminating
    // shape: `min(rawRemaining, balance)` has nothing to clamp against, so the phantom shows through
    // as 7 units the screen would ask to be written off a SECOND time.
    mockMoves.mockResolvedValue([
      mv("issue", [{ jobKitLineId: "k3", qty: 10, condition: "good", irmItemId: IRM_ID }]),
      mv("consume", [{ jobKitLineId: "k3", qty: 3, condition: "good", irmItemId: IRM_ID }]),
      mv("consume", [{ jobKitLineId: null, qty: 7, condition: "lost", irmItemId: IRM_ID }]),
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 10 }] as never);

    expect((await closeReconcile(JOB_ID, {})).unaccounted).toEqual([]);
  });

  it("still reports the part a write-off did NOT cover", async () => {
    // issued 10, declared consume 3, written off 4 ⇒ 3 genuinely unresolved, and the engineer holds
    // plenty of the item, so the answer is the kit line's own truth rather than a clamp.
    mockMoves.mockResolvedValue([
      mv("issue", [{ jobKitLineId: "k3", qty: 10, condition: "good", irmItemId: IRM_ID }]),
      mv("consume", [{ jobKitLineId: "k3", qty: 3, condition: "good", irmItemId: IRM_ID }]),
      mv("consume", [{ jobKitLineId: null, qty: 4, condition: "lost", irmItemId: IRM_ID }]),
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 10 }] as never);

    expect((await closeReconcile(JOB_ID, {})).unaccounted).toEqual([expect.objectContaining({ itemName: "Cat6 Box", qty: 3 })]);
  });

  it("reports nothing unaccounted once the write-off covers the whole remainder", async () => {
    mockMoves.mockResolvedValue([
      mv("issue", [{ jobKitLineId: "k3", qty: 8, condition: "good", irmItemId: IRM_ID }]),
      mv("consume", [{ jobKitLineId: "k3", qty: 4, condition: "good", irmItemId: IRM_ID }]),
      mv("consume", [{ jobKitLineId: null, qty: 4, condition: "lost", irmItemId: IRM_ID }]),
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 4 }] as never);

    const res = await closeReconcile(JOB_ID, {});
    expect(res.unaccounted).toEqual([]);
    expect(vi.mocked(repo.upsertSummaryTx)).toHaveBeenCalledWith(expect.anything(), JOB_ID, expect.objectContaining({ goodsStatus: "reconciled" }));
  });

  // 12. The fix at the SOURCE: a write-off written today names the line it settles.
  it("writes the kit line onto every lost movement line it posts", async () => {
    mockMoves.mockResolvedValue([mv("issue", [{ jobKitLineId: "k3", qty: 3, condition: "good", irmItemId: IRM_ID }])] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 3 }] as never);

    await closeReconcile(JOB_ID, { writeOffLost: true, writeOffReason: "not_returned" });
    const lines = mockCreate.mock.calls.at(-1)?.[1] as { jobKitLineId: string | null; qty: number; condition: string }[];
    expect(lines).toEqual([expect.objectContaining({ jobKitLineId: "k3", qty: 3, condition: "lost" })]);
  });

  it("splits one item's write-off across the kit lines it actually came from", async () => {
    // Same catalogue item on two kit lines, both short. The screen still shows ONE row for the item;
    // the ledger records which line each unit came off.
    mockJob.mockResolvedValue(irmJob([irmLine("k3", IRM_ID, "Cat6 Box", 2), irmLine("k4", IRM_ID, "Cat6 Box", 3)]) as never);
    mockMoves.mockResolvedValue([
      mv("issue", [{ jobKitLineId: "k3", qty: 2, condition: "good", irmItemId: IRM_ID }, { jobKitLineId: "k4", qty: 3, condition: "good", irmItemId: IRM_ID }]),
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 5 }] as never);

    // The confirmation pass still shows ONE row for the item — that grouping is deliberate and unchanged.
    expect((await closeReconcile(JOB_ID, {})).unaccounted).toEqual([expect.objectContaining({ qty: 5 })]);
    // …and the ledger it then writes says which line each unit came off.
    await closeReconcile(JOB_ID, { writeOffLost: true, writeOffReason: "not_returned" });
    const lines = mockCreate.mock.calls.at(-1)?.[1] as { jobKitLineId: string | null; qty: number }[];
    expect(lines.map((l) => [l.jobKitLineId, l.qty])).toEqual([["k3", 2], ["k4", 3]]);
  });

  // 11 + 13 + 17. The ordinary arithmetic is untouched.
  it("keeps issue + return arithmetic exactly as it was", async () => {
    mockMoves.mockResolvedValue([
      mv("issue", [{ jobKitLineId: "k3", qty: 10, condition: "good", irmItemId: IRM_ID }]),
      mv("return", [{ jobKitLineId: "k3", qty: 3, condition: "good", irmItemId: IRM_ID }]),
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 7 }] as never);
    expect((await closeReconcile(JOB_ID, {})).unaccounted).toEqual([expect.objectContaining({ qty: 7 })]);
  });

  it("keeps issue + return + declared consume arithmetic exactly as it was", async () => {
    mockMoves.mockResolvedValue([
      mv("issue", [{ jobKitLineId: "k3", qty: 10, condition: "good", irmItemId: IRM_ID }]),
      mv("return", [{ jobKitLineId: "k3", qty: 3, condition: "good", irmItemId: IRM_ID }]),
      mv("consume", [{ jobKitLineId: "k3", qty: 5, condition: "good", irmItemId: IRM_ID }]),
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 2 }] as never);
    expect((await closeReconcile(JOB_ID, {})).unaccounted).toEqual([expect.objectContaining({ qty: 2 })]);
  });

  it("never credits a line more than that line was short by", async () => {
    // A write-off larger than the line's own remainder (the balance had already been drained
    // elsewhere) must not turn into a credit against a line that owes nothing.
    mockJob.mockResolvedValue(irmJob([irmLine("k3", IRM_ID, "Cat6 Box", 2), irmLine("k4", IRM_2, "Other", 2)]) as never);
    mockMoves.mockResolvedValue([
      mv("issue", [{ jobKitLineId: "k3", qty: 2, condition: "good", irmItemId: IRM_ID }, { jobKitLineId: "k4", qty: 2, condition: "good", irmItemId: IRM_2 }]),
      mv("consume", [{ jobKitLineId: null, qty: 9, condition: "lost", irmItemId: IRM_ID }]),
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([
      { irmItemId: IRM_ID, quantityOnHand: 0 }, { irmItemId: IRM_2, quantityOnHand: 2 },
    ] as never);

    // k3 is settled by its own write-off; k4 belongs to a different item and is untouched by it.
    expect((await closeReconcile(JOB_ID, {})).unaccounted).toEqual([expect.objectContaining({ itemName: "Other", qty: 2 })]);
  });

  // 15 + 16. Another job's history cannot reach this one.
  it("reads only THIS job's movements, so another job's write-off cannot settle this one", async () => {
    // findMovementsByJob is per job by construction — asserted here so a future optimisation that
    // widened it would fail loudly rather than silently crediting one job's loss to another.
    mockMoves.mockResolvedValue([
      mv("issue", [{ jobKitLineId: "k3", qty: 4, condition: "good", irmItemId: IRM_ID }]),
      // A line filed against a kit line this job does not own — another job's row.
      mv("consume", [{ jobKitLineId: "kX", qty: 4, condition: "lost", irmItemId: IRM_ID }]),
    ] as never);
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([{ irmItemId: IRM_ID, quantityOnHand: 4 }] as never);
    expect((await closeReconcile(JOB_ID, {})).unaccounted).toEqual([expect.objectContaining({ qty: 4 })]);
    expect(mockMoves).toHaveBeenCalledWith(JOB_ID);
  });
});
