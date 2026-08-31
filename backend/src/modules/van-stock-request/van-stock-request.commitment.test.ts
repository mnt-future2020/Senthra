import { beforeEach, describe, expect, it, vi } from "vitest";

// WHAT AN ENGINEER MAY FIELD-RETURN, computed end to end through the REAL calculation.
//
// Every other Field Stock suite mocks `committedByEngineer` and asserts against the number it was
// handed. That is the right shape for testing the guards, and it is exactly why the production defect
// this file exists for survived: the bug was INSIDE the calculation, so a mocked figure could never
// expose it. So `goods-management.service` is deliberately NOT mocked here — only the repository layer
// is, and the assertions run the real commitment through the real `myHoldings` and the real `create`
// return guard, the two production consumers.
//
// ── THE INVARIANT ──────────────────────────────────────────────────────────────────────────────
//
// A hired unit enters an engineer's custody through exactly one of two doors, and must leave by the
// same one:
//
//   JOB door    job_issue / job_return / job_lost   → back through the job's scan-in, or declared lost
//   FIELD door  van_restock / van_return            → back through a Field Stock return
//
// Field Stock returnable = FIELD-door custody still held. Nothing else. Not "what an open job's
// movements say is outstanding", and emphatically not "everything held once the job is closed": a job
// closing does not carry units out of a van, so a completed or reconciled job must not CONVERT its
// units into Field-Stock-returnable ones. That conversion is the error this suite pins down, and it is
// the more dangerous of the two the calculation has had.
//
// Origin is read from the append-only custody ledger, which is the one record every rental lifecycle
// event writes to — including the two that write no job movement at all, loss and recovery.

vi.mock("../../lib/prisma.js", () => ({ withTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/notification/notification.service.js", () => ({ notify: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({
  emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(),
  VAN_STOCK_REVIEWERS_ROOM: "vsr:reviewers", OFFICE_JOBS_ROOM: "jobs:office", RENTAL_WATCHERS_ROOM: "rental:watchers",
}));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(), getCompanyTimezone: vi.fn(async () => "Europe/London"), getOverdueAfterDays: vi.fn(async () => 14),
}));
vi.mock("#modules/job/job.repository.js", () => ({
  findActiveByEngineerWithKitLines: vi.fn(async () => []),
  findById: vi.fn(), findActiveForGoodsManagement: vi.fn(), findActiveWithKitLines: vi.fn(async () => []),
  findKitLineTypesByJobs: vi.fn(async () => []), findGoodsActiveJobIds: vi.fn(async () => []), completeIfInProgressTx: vi.fn(),
}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  findMovementsByJobs: vi.fn(async () => []), findMovementsByJob: vi.fn(async () => []),
  getSummary: vi.fn(async () => null), getSummariesByJobs: vi.fn(async () => []),
  findCustomerHoldingsByEngineer: vi.fn(async () => []), findCustomerStockEntriesByIds: vi.fn(async () => []),
  findIssuedQtyByKitLine: vi.fn(async () => new Map()),
  upsertDamagedBalanceTx: vi.fn(), insertDamagedTxnTx: vi.fn(),
}));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({ findVanSourcesByKitLines: vi.fn(async () => new Map()) }));
vi.mock("#modules/irm/irm.repository.js", () => ({ findById: vi.fn(), findMany: vi.fn(async () => []) }));
vi.mock("#modules/irm/irm.service.js", () => ({ findActiveByCodeOrBarcode: vi.fn(async () => null), requireActiveIrmItem: vi.fn() }));
vi.mock("#modules/rental-item/rental-item.repository.js", () => ({
  findById: vi.fn(), findActiveByCode: vi.fn(), findByCodeAnyStatus: vi.fn(), findManyByIds: vi.fn(async () => []),
  findMany: vi.fn(async () => ({ items: [], total: 0 })),
}));
// The custody repository's TYPE CLASSIFICATION stays REAL — which transaction types count as the field
// door is the rule under test, and a copy of that list in this file would let the suite keep passing
// after production stopped agreeing with it. Only the queries are stubbed.
vi.mock("#modules/engineer-rental/engineer-rental.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#modules/engineer-rental/engineer-rental.repository.js")>()),
  findRentalHoldingsByEngineer: vi.fn(async () => []), findFieldOriginByHires: vi.fn(async () => new Map()),
  upsertRentalHoldingTx: vi.fn(), insertRentalTxnTx: vi.fn(),
  findRentalHoldingTx: vi.fn(async () => null), findRentalHolding: vi.fn(async () => null),
  findRentalHoldingsByHireLines: vi.fn(async () => []), findRentalHoldingQuantitiesByEngineers: vi.fn(async () => []),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  findIssuableHiresByRentalItems: vi.fn(async () => []), findLiveHiresByRentalItems: vi.fn(async () => []),
  findHireStockById: vi.fn(), findHireStockByIdTx: vi.fn(), adjustHireIssuedQtyTx: vi.fn(async () => true),
  findHireDepotsByIds: vi.fn(async () => []),
}));
vi.mock("#modules/purchase-order/hireCustodyExit.repository.js", () => ({
  createExitTx: vi.fn(), CUSTODY_HELD_DAMAGED: "held_damaged", CUSTODY_LOST: "lost", CUSTODY_RECOVERED: "recovered",
  SETTLE_UNSETTLED: "unsettled",
}));
vi.mock("#modules/purchase-order/rentalHire.realtime.js", () => ({ emitHireUpdated: vi.fn() }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({
  findEngineerBalances: vi.fn(async () => []), findEngineerBalance: vi.fn(async () => null),
  upsertEngineerBalanceTx: vi.fn(), insertEngineerTxnTx: vi.fn(), findEngineerBalanceTx: vi.fn(),
  findBalanceQuantitiesByEngineers: vi.fn(async () => []),
}));
vi.mock("#modules/inventory/inventory.repository.js", () => ({
  findBalancesByItemsAndWarehouses: vi.fn(async () => []), findBalancePair: vi.fn(async () => null),
  findBalancePairTx: vi.fn(), upsertBalanceTx: vi.fn(), insertTransactionTx: vi.fn(),
}));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyOutbound: vi.fn(), applyInbound: vi.fn() }));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findById: vi.fn(), findMany: vi.fn(async () => []) }));
vi.mock("./van-stock-request.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./van-stock-request.repository.js")>();
  return { ...actual, findById: vi.fn(), createRequest: vi.fn(), postFulfilment: vi.fn(), claimLinesForReview: vi.fn(), findOpenLineItems: vi.fn(async () => []) };
});

import * as jobRepo from "#modules/job/job.repository.js";
import * as gmRepo from "#modules/goods-management/goods-management.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as rentalItemRepo from "#modules/rental-item/rental-item.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as vsrRepo from "./van-stock-request.repository.js";
import { committedByEngineer } from "#modules/goods-management/goods-management.service.js";
import { create, myHoldings } from "./van-stock-request.service.js";

const ENG = "e".repeat(24);
const RENTAL = "d".repeat(24); // the reported catalogue item (RNT-0014)
const IRM = "1".repeat(24);
const WH = "w1".padEnd(24, "0");
const HIRE_A = "a1".padEnd(24, "0"); // an OLDER hire, drawn from by a job
const HIRE_B = "a2".padEnd(24, "0"); // a NEW hire, collected through Field Stock
const JOB_A = "j1".padEnd(24, "0");
const JOB_B = "j2".padEnd(24, "0");
const KIT_R = "k1".padEnd(24, "0");
const KIT_IRM = "k2".padEnd(24, "0");
const PO_ID = "9".repeat(24);
const REQ_ID = "r".repeat(24);
const LINE_ID = "l1".padEnd(24, "0");

const engineerActor = { id: ENG, email: "kansha@x.com", type: "user" } as never;
const RENTAL_ITEM = { id: RENTAL, code: "RNT-0014", name: "test fiber net 4", baseUnit: "Each", status: "active", deletedAt: null };
const IRM_ITEM = { id: IRM, code: "IRM-0004", name: "CAT6 U/UTP Cable", baseUnit: "Box", sku: null, status: "active", trackSerialNumbers: false, trackBatchNumbers: false };

// ── fixtures, shaped exactly as the repositories return them ────────────────────────────────────

/** One custody row: what the engineer is physically holding on one hire. */
const holding = (over: Record<string, unknown> = {}) => ({
  purchaseOrderRentalLineId: HIRE_B, engineerId: ENG, rentalItemId: RENTAL, itemName: "test fiber net 4",
  poCode: "PO-0074", hireEndDate: new Date("2026-08-30T00:00:00Z"), quantityOnHand: 4,
  purchaseOrderRentalLine: { purchaseOrderId: PO_ID },
  ...over,
});

/**
 * The FIELD-door net per hire, as the ledger aggregation returns it: `van_restock − van_return`.
 *
 * Stated per hire rather than per item, because that is the only key under which the answer is
 * meaningful — and a hire absent from the map means "no field-door history", which must read as 0.
 */
const fieldOrigin = (byHire: Record<string, number>) =>
  vi.mocked(rentalCustodyRepo.findFieldOriginByHires).mockImplementation(
    (async (_eng: string, ids: string[]) => new Map(Object.entries(byHire).filter(([id]) => ids.includes(id)))) as never,
  );

const jobRow = (id: string, kitLines: Record<string, unknown>[]) => ({ id, kitLines });
const rentalKit = (over: Record<string, unknown> = {}) => ({ id: KIT_R, lineType: "rental", irmItemId: null, rentalItemId: RENTAL, ...over });
const irmKit = (over: Record<string, unknown> = {}) => ({ id: KIT_IRM, lineType: "irm", irmItemId: IRM, rentalItemId: null, ...over });
const move = (jobId: string, direction: string, items: Record<string, unknown>[], status = "posted") => ({
  id: `${jobId}-${direction}-${items.length}`, jobId, status, direction, warehouseId: WH, items,
});
const line = (qty: number, jobKitLineId: string | null) => ({ jobKitLineId, qty, condition: "good" });
const withMovements = (moves: Record<string, unknown>[]) =>
  vi.mocked(gmRepo.findMovementsByJobs).mockImplementation((async (ids: string[]) => moves.filter((m) => ids.includes(m.jobId as string))) as never);

const requestRow = () => ({
  id: REQ_ID, code: "VSR-0090", type: "return", status: "pending", priority: "normal",
  createdVia: "engineer_request", engineerId: ENG, engineerName: "Kansha M", engineerEmail: "kansha@x.com",
  preferredWarehouseId: null, preferredWarehouseName: null, preferredWarehouseCode: null,
  warehouseId: WH, warehouseName: "London Fulfillment Centre", warehouseCode: "LFC",
  reason: "done with it", notes: null, attachments: [],
  reviewedByUserId: null, reviewedByEmail: null, reviewedAt: null, decisionNote: null,
  lastFulfilledAt: null, completionType: null, closedShortBy: null, closedShortAt: null,
  closeShortNote: null, cancelledAt: null, deletedAt: null, createdBy: null,
  createdAt: new Date("2026-08-28T00:00:00Z"), updatedAt: new Date("2026-08-28T00:00:00Z"),
  lines: [{
    id: LINE_ID, requestId: REQ_ID, source: "rental", irmItemId: null, rentalItemId: RENTAL,
    itemName: "test fiber net 4", code: "RNT-0014", sku: null, uom: "Each",
    requestedQty: 3, approvedQty: 3, fulfilledQty: 0,
    sourceWarehouseId: WH, sourceWarehouseName: "London Fulfillment Centre", sourceWarehouseCode: "LFC", sourceWarehouse: null,
    reviewedByEmail: null, reviewedAt: null, decisionNote: null,
    closedShortQty: null, closedShortBy: null, closedShortNote: null, closedShortAt: null,
    cancelledQty: null, cancelledBy: null, cancelledAt: null, createdAt: new Date("2026-08-28T00:00:00Z"),
  }],
  fulfilments: [],
});

const returnInput = (qty: number) => ({
  type: "return", reason: "bringing it back", priority: "normal", warehouseId: WH,
  lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "test fiber net 4", qty }],
});

/** What the engineer's Return composer offers for the hired item. */
const freeToReturn = async (): Promise<number> => (await myHoldings(ENG)).find((h) => h.rentalItemId === RENTAL)?.quantityOnHand ?? 0;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([] as never);
  withMovements([]);
  vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([] as never);
  fieldOrigin({});
  vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([] as never);
  vi.mocked(rentalItemRepo.findById).mockResolvedValue(RENTAL_ITEM as never);
  vi.mocked(rentalItemRepo.findManyByIds).mockResolvedValue([RENTAL_ITEM] as never);
  vi.mocked(irmRepo.findById).mockResolvedValue(IRM_ITEM as never);
  // Both hires live at WH, so the create-time depot guard is satisfied and the ORIGIN rule is what the
  // return tests are actually exercising.
  vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
    { id: HIRE_B, rentalItemId: RENTAL, warehouseId: WH, warehouseName: "London Fulfillment Centre" },
    { id: HIRE_A, rentalItemId: RENTAL, warehouseId: WH, warehouseName: "London Fulfillment Centre" },
  ] as never);
  vi.mocked(warehouseRepo.findById).mockResolvedValue({ id: WH, name: "London Fulfillment Centre", code: "LFC", status: "active" } as never);
  vi.mocked(userRepo.findById).mockResolvedValue({ id: ENG, firstName: "Kansha", lastName: "M", email: "kansha@x.com", status: "active", role: { canHoldStock: true } } as never);
  vi.mocked(vsrRepo.createRequest).mockResolvedValue(requestRow() as never);
});

// ── 1–2. The two doors, in isolation ───────────────────────────────────────────────────────────

describe("origin decides what is Field-Stock-returnable", () => {
  it("offers field-door custody in full", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 4 })] as never);
    fieldOrigin({ [HIRE_B]: 4 }); // van_restock +4
    expect(await freeToReturn()).toBe(4);
    await create(returnInput(4) as never, engineerActor);
    expect(vsrRepo.createRequest).toHaveBeenCalled();
  });

  it("never offers job-door custody, and the row drops out entirely", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 2 })] as never);
    fieldOrigin({}); // job_issue only — no field-door history at all
    expect(await freeToReturn()).toBe(0);
    expect((await myHoldings(ENG)).find((h) => h.source === "rental")).toBeUndefined();
    await expect(create(returnInput(1) as never, engineerActor)).rejects.toThrow(/only have 0 .*out on a job/i);
    expect(vsrRepo.createRequest).not.toHaveBeenCalled();
  });

  it("does not read job state to answer the question", async () => {
    // No jobs at all — every job this engineer ever had is closed, cancelled or deleted — and the
    // job-origin units are STILL held down. The old rule released them here.
    vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([] as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 2 })] as never);
    fieldOrigin({});
    expect(await freeToReturn()).toBe(0);
    expect((await committedByEngineer(ENG)).rental.get(RENTAL)).toBe(2);
  });
});

// ── 3–4. MIXED ORIGIN — the most important regression ──────────────────────────────────────────

describe("mixed origin on one hire", () => {
  // 2 units came in on a job, 3 through Field Stock. Custody row says 5.
  const mixed = () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 5 })] as never);
    fieldOrigin({ [HIRE_B]: 3 }); // van_restock +3; the other 2 are job_issue
  };

  it("offers only the field-door 3 of 5", async () => {
    mixed();
    expect(await freeToReturn()).toBe(3);
  });

  it("refuses a return of the job-door units at create", async () => {
    mixed();
    await expect(create(returnInput(4) as never, engineerActor)).rejects.toThrow(/only have 3 /i);
    await create(returnInput(3) as never, engineerActor);
    expect(vsrRepo.createRequest).toHaveBeenCalled();
  });

  it("STILL offers only 3 once the job is completed and reconciled", async () => {
    // The job is gone from the live window entirely — the strongest form of "completed and reconciled"
    // — and the answer must not move by one unit. A job closing does not carry kit out of a van.
    mixed();
    vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([] as never);
    expect(await freeToReturn()).toBe(3);
  });

  it("STILL offers only 3 while the job is wide open", async () => {
    mixed();
    vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([jobRow(JOB_A, [rentalKit()])] as never);
    withMovements([move(JOB_A, "issue", [line(2, KIT_R)])]);
    expect(await freeToReturn()).toBe(3);
  });
});

// ── 5–7. Job return, job loss, recovery — the lifecycle events that move origin ─────────────────

describe("the job-side lifecycle moves job-origin custody only", () => {
  it("a job return reduces job-origin, never field-origin (Case A / §8)", async () => {
    // job_issue +2, job_return −1, van_restock +3 ⇒ custody 4, field door still 3.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 4 })] as never);
    fieldOrigin({ [HIRE_B]: 3 });
    expect(await freeToReturn()).toBe(3);
  });

  it("a job loss takes the lost unit out of custody, and out of nothing else (Case B / §7)", async () => {
    // job_issue +2, job_lost −1, van_restock +3 ⇒ custody 4, field door 3. The lost unit left custody
    // at the moment it was declared; the field figure never saw it.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 4 })] as never);
    fieldOrigin({ [HIRE_B]: 3 });
    expect(await freeToReturn()).toBe(3);
  });

  it("a recovery to the depot shelf gives Field Stock nothing (Case C / D)", async () => {
    // `recoverHireLoss` writes NO custody row and does not touch the holding — it books the unit back
    // onto the shelf by clearing the hire's lost counter. So custody and the field figure are both
    // exactly as they were after the loss, and the recovered unit cannot appear here.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 4 })] as never);
    fieldOrigin({ [HIRE_B]: 3 });
    expect(await freeToReturn()).toBe(3);
    expect((await committedByEngineer(ENG)).rental.get(RENTAL)).toBe(1); // the one job unit still out
  });

  it("job-origin genuinely still with the engineer stays out of reach (Case E)", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 3 })] as never);
    fieldOrigin({ [HIRE_B]: 0 });
    expect(await freeToReturn()).toBe(0);
  });

  it("clamps the field figure at the live holding when a job scan drained field units", async () => {
    // Goods Management's return scan binds a hire from custody without consulting origin, so it CAN
    // drain field-origin units: van_restock +5, then job_return −3 ⇒ custody 2 but field net still 5.
    // The clamp is what stops the ledger over-reporting what is physically there.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 2 })] as never);
    fieldOrigin({ [HIRE_B]: 5 });
    expect(await freeToReturn()).toBe(2);
  });

  it("treats a negative field net as zero, never as a credit", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 3 })] as never);
    fieldOrigin({ [HIRE_B]: -2 });
    expect(await freeToReturn()).toBe(0);
  });
});

// ── 8–10. Hire identity: one order's units are never another's ──────────────────────────────────

describe("per-hire attribution", () => {
  it("an old job's hire does not subtract from a new Field Stock hire (§9, the reported defect)", async () => {
    // Hire A: 1 unit, job-origin, from an old job. Hire B: 4 units, collected through Field Stock.
    // Same catalogue item. Only hire B's 4 may come back this way — and all 4 of them must.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_A, poCode: "PO-0072", quantityOnHand: 1, hireEndDate: new Date("2026-08-27T00:00:00Z") }),
      holding({ quantityOnHand: 4 }),
    ] as never);
    fieldOrigin({ [HIRE_B]: 4 }); // hire A has no field-door history
    expect(await freeToReturn()).toBe(4);
    await create(returnInput(4) as never, engineerActor);
    expect(vsrRepo.createRequest).toHaveBeenCalled();
  });

  it("keeps two hires of one catalogue item isolated in both directions (§10)", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_A, poCode: "PO-0072", quantityOnHand: 5 }),
      holding({ quantityOnHand: 4 }),
    ] as never);
    // Hire A: 5 held, 2 field-origin. Hire B: 4 held, 1 field-origin.
    fieldOrigin({ [HIRE_A]: 2, [HIRE_B]: 1 });
    expect(await freeToReturn()).toBe(3);
  });

  it("does not let one hire's field surplus cover another hire's job units", async () => {
    // Hire A: 2 held, all job-origin. Hire B: 2 held, and a field net of 6 — more than hire B holds and
    // more than the item's total. Clamped per hire, the answer is 2, not 4 and not 6.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_A, poCode: "PO-0072", quantityOnHand: 2 }),
      holding({ quantityOnHand: 2 }),
    ] as never);
    fieldOrigin({ [HIRE_B]: 6 });
    expect(await freeToReturn()).toBe(2);
  });

  it("asks the ledger once, for every hire the engineer holds", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_A, quantityOnHand: 1 }),
      holding({ quantityOnHand: 4 }),
    ] as never);
    fieldOrigin({ [HIRE_B]: 4 });
    await myHoldings(ENG);
    expect(rentalCustodyRepo.findFieldOriginByHires).toHaveBeenCalledTimes(1);
    expect(rentalCustodyRepo.findFieldOriginByHires).toHaveBeenCalledWith(ENG, [HIRE_A, HIRE_B]);
    expect(rentalCustodyRepo.findRentalHoldingsByEngineer).toHaveBeenCalledTimes(1);
  });
});

// ── 11–12. The reported live cases ──────────────────────────────────────────────────────────────

describe("the reported live cases", () => {
  it("RNT-0014: 9 held on PO-0074, all field-origin, all 9 returnable", async () => {
    // The live ledger for this hire: job_issue +12, job_return −11, job_lost −1 (net 0) and
    // van_restock +9. The job door is square; every unit in the van came through Field Stock.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 9 })] as never);
    fieldOrigin({ [HIRE_B]: 9 });
    expect(await freeToReturn()).toBe(9);
  });

  it("RNT-0015: 10 held on PO-0073, all field-origin after 5 units were lost off jobs", async () => {
    // job_issue +38, job_return −33, job_lost −5 (net 0), van_restock +10.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_A, poCode: "PO-0073", quantityOnHand: 10 }),
    ] as never);
    fieldOrigin({ [HIRE_A]: 10 });
    expect(await freeToReturn()).toBe(10);
  });
});

// ── 13. Company stock: untouched ────────────────────────────────────────────────────────────────

describe("IRM commitment is unchanged", () => {
  const irmFree = async () => (await myHoldings(ENG)).find((h) => h.irmItemId === IRM)?.quantityOnHand ?? 0;

  beforeEach(() => {
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([
      { irmItemId: IRM, quantityOnHand: 10, irmItem: { code: "IRM-0004", name: "CAT6 U/UTP Cable", baseUnit: "Box", trackSerialNumbers: false, trackBatchNumbers: false } },
    ] as never);
  });

  it("still subtracts issued − used − returned over the engineer's live jobs", async () => {
    vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([jobRow(JOB_A, [irmKit()])] as never);
    withMovements([
      move(JOB_A, "issue", [line(5, KIT_IRM)]),
      move(JOB_A, "consume", [line(1, KIT_IRM)]),
      move(JOB_A, "return", [line(1, KIT_IRM)]),
    ]);
    expect(await irmFree()).toBe(7);
  });

  it("still counts every live job, and still ignores a draft movement", async () => {
    vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([
      jobRow(JOB_A, [irmKit()]),
      jobRow(JOB_B, [irmKit({ id: "k9".padEnd(24, "0") })]),
    ] as never);
    withMovements([
      move(JOB_A, "issue", [line(2, KIT_IRM)]),
      move(JOB_B, "issue", [line(3, "k9".padEnd(24, "0"))]),
      move(JOB_A, "issue", [line(4, KIT_IRM)], "draft"),
    ]);
    expect(await irmFree()).toBe(5);
  });

  it("reads no rental custody at all when only IRM is involved", async () => {
    vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([jobRow(JOB_A, [irmKit()])] as never);
    withMovements([move(JOB_A, "issue", [line(5, KIT_IRM)])]);
    await myHoldings(ENG);
    expect(rentalCustodyRepo.findFieldOriginByHires).not.toHaveBeenCalled();
  });
});

// ── PART B, where the phantom is NOT masked by a clamp ──────────────────────────────────────────
//
// `closeReconcile` compares its per-item remainder against the engineer's balance, so a phantom there
// is often capped out of sight. This path has no such clamp: it subtracts the job's remainder FROM the
// balance, so an unattributed write-off shows through directly as stock the engineer cannot return —
// units already gone from their van, still being held down by the job that wrote them off.
describe("IRM: a write-off that named no kit line is settled quantity", () => {
  const irmFree = async () => (await myHoldings(ENG)).find((h) => h.irmItemId === IRM)?.quantityOnHand ?? 0;
  const lost = (qty: number, kitLineId: string | null = null) => ({ jobKitLineId: kitLineId, qty, condition: "lost", irmItemId: IRM });

  beforeEach(() => {
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([
      { irmItemId: IRM, quantityOnHand: 10, irmItem: { code: "IRM-0004", name: "CAT6 U/UTP Cable", baseUnit: "Box", trackSerialNumbers: false, trackBatchNumbers: false } },
    ] as never);
    vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([jobRow(JOB_A, [irmKit()])] as never);
  });

  it("stops holding down stock the write-off already removed from the van", async () => {
    // The live shape of JOB-2026-0015: issued 8, a declared consume of 4, then a write-off of 4 posted
    // with no kit line and a matching job_lost on the engineer ledger. Nothing is outstanding.
    withMovements([
      move(JOB_A, "issue", [line(8, KIT_IRM)]),
      move(JOB_A, "consume", [line(4, KIT_IRM)]),
      move(JOB_A, "consume", [lost(4)]),
    ]);
    expect(await irmFree()).toBe(10);
    expect((await committedByEngineer(ENG)).irm.get(IRM) ?? 0).toBe(0);
  });

  it("still holds down the part the write-off did not cover", async () => {
    withMovements([
      move(JOB_A, "issue", [line(8, KIT_IRM)]),
      move(JOB_A, "consume", [line(4, KIT_IRM)]),
      move(JOB_A, "consume", [lost(1)]),
    ]);
    expect(await irmFree()).toBe(7); // 10 on the van − 3 still genuinely out on the job
  });

  it("counts an ATTRIBUTED write-off exactly once", async () => {
    // What closeReconcile writes from now on. It lands in `consumed` through the ordinary path, and the
    // unattributed sweep must not credit it a second time.
    withMovements([
      move(JOB_A, "issue", [line(8, KIT_IRM)]),
      move(JOB_A, "consume", [line(4, KIT_IRM)]),
      move(JOB_A, "consume", [lost(4, KIT_IRM)]),
    ]);
    expect(await irmFree()).toBe(10);
  });

  it("never credits a line more than that line was short by", async () => {
    withMovements([
      move(JOB_A, "issue", [line(3, KIT_IRM)]),
      move(JOB_A, "consume", [lost(9)]),
    ]);
    expect(await irmFree()).toBe(10); // the surplus write-off cannot push the line negative
  });

  it("keeps one job's write-off out of another job's kit line", async () => {
    // Two jobs, same catalogue item. Job B wrote off 5 with no kit line; Job A still has 3 out and
    // must keep them committed — the sweep runs per job, over that job's own movements only.
    const KIT_B = "k8".padEnd(24, "0");
    vi.mocked(jobRepo.findActiveByEngineerWithKitLines).mockResolvedValue([
      jobRow(JOB_A, [irmKit()]),
      jobRow(JOB_B, [irmKit({ id: KIT_B })]),
    ] as never);
    withMovements([
      move(JOB_A, "issue", [line(3, KIT_IRM)]),
      move(JOB_B, "issue", [line(5, KIT_B)]),
      move(JOB_B, "consume", [lost(5)]),
    ]);
    expect(await irmFree()).toBe(7); // 10 − Job A's 3; Job B is settled
  });

  it("ignores a lost line on a DRAFT movement", async () => {
    withMovements([
      move(JOB_A, "issue", [line(4, KIT_IRM)]),
      move(JOB_A, "consume", [lost(4)], "draft"),
    ]);
    expect(await irmFree()).toBe(6);
  });

  it("leaves the rental origin figure completely alone", async () => {
    // The two pools are answered by different rules and must not interfere: a company-stock write-off
    // has nothing to say about which door a hired unit came in through.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 4 })] as never);
    fieldOrigin({ [HIRE_B]: 4 });
    withMovements([
      move(JOB_A, "issue", [line(8, KIT_IRM)]),
      move(JOB_A, "consume", [lost(8)]),
    ]);
    expect(await freeToReturn()).toBe(4);
    expect(await irmFree()).toBe(10);
  });
});
