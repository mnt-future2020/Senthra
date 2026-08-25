import { beforeEach, describe, expect, it, vi } from "vitest";

// An engineer asking for hired kit mid-job.
//
// Rental joins IRM and customer stock as a requestable pool, but it is NOT interchangeable with
// either. Custody of a hire is anchored to the depot that took delivery and the provider collects it
// from there, so it can be fulfilled from a WAREHOUSE and never from a colleague's van — which is the
// one rule these tests exist to hold. Everything else (the trim, exclusion, resumability) is shared
// machinery already covered in job-kit-request.approve.test.ts.

vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/job/job.service.js", () => ({ appendKitFromRequest: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.service.js", () => ({ createJobTransfer: vi.fn(), assertTransferEngineers: vi.fn() }));
vi.mock("#modules/irm/irm.repository.js", () => ({ findById: vi.fn(), findMany: vi.fn(async () => []) }));
vi.mock("#modules/rental-item/rental-item.repository.js", () => ({ findById: vi.fn(), findMany: vi.fn(async () => ({ items: [], total: 0 })) }));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({ findLiveHiresByRentalItems: vi.fn(async () => []), findIssuableHiresByRentalItems: vi.fn(async () => []) }));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  findCustomerHoldingsByEngineer: vi.fn(async () => []), findCustomerStockEntriesByIds: vi.fn(async () => []),
  findCustomerEntryWarehousesByIds: vi.fn(async () => new Map()), findCustomerStockEntryById: vi.fn(), searchActiveCustomerStock: vi.fn(async () => []),
}));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({ jobCommittedByEngineer: vi.fn(async () => new Map()), getGoodsStatus: vi.fn(async () => "not_issued") }));
vi.mock("#modules/goods-management/demand.js", () => ({ getOpenDemand: vi.fn(async () => new Map()) }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({ findEngineerBalances: vi.fn(async () => []), findBalancesByItems: vi.fn(async () => []) }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findAllBalances: vi.fn(async () => []), findBalancesByItemsAndWarehouses: vi.fn(async () => []) }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findMany: vi.fn(async () => []), findLabelsByIds: vi.fn(async () => new Map([["w1".padEnd(24, "0"), { name: "Leeds", code: "LDS" }]])) }));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({ findHoldersForIrm: vi.fn(async () => []), findHoldersForCustomer: vi.fn(async () => []), findSourcesByIds: vi.fn(async () => []) }));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn(), getCompanyTimezone: vi.fn(async () => "Europe/London") }));
vi.mock("#modules/notification/notification.service.js", () => ({ notify: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({ emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "office:jobs" }));
vi.mock("./job-kit-request.repository.js", () => ({
  findById: vi.fn(), claimPending: vi.fn(async () => 1), revertToPending: vi.fn(), finalizeApproval: vi.fn(),
  stampLineKitIdsTx: vi.fn(), appendTransferIdTx: vi.fn(), setTransferIdTx: vi.fn(), createKitRequest: vi.fn(),
}));

import * as jobRepo from "#modules/job/job.repository.js";
import * as jobService from "#modules/job/job.service.js";
import * as transferService from "#modules/engineer-transfer/engineer-transfer.service.js";
import * as rentalItemRepo from "#modules/rental-item/rental-item.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as kitRequestRepo from "./job-kit-request.repository.js";
import { approve, create, searchItems } from "./job-kit-request.service.js";

const REQ_ID = "r".repeat(24);
const JOB_ID = "j".repeat(24);
const TO_ENG = "e1".padEnd(24, "0"); // the job's own engineer
const OTHER_ENG = "e2".padEnd(24, "0");
const WH = "w1".padEnd(24, "0");
const OTHER_WH = "w2".padEnd(24, "0");
const RENTAL = "d".repeat(24);
const L_RENTAL = "l1".padEnd(24, "0");

const actor = { id: "u".repeat(24), email: "pm@x.com" } as never;

const RENTAL_ITEM = { id: RENTAL, code: "RNT-0007", name: "Fibre Tester", baseUnit: "Each", status: "active", deletedAt: null };

const hire = (over: Record<string, unknown> = {}) => ({
  id: "h".repeat(24), rentalItemId: RENTAL, itemName: "Fibre Tester", baseUnit: "Each",
  quantity: 3, receivedQuantity: 3, returnedQuantity: 0, issuedQuantity: 0,
  hireEndDate: new Date("2026-12-01T00:00:00Z"), hireStatus: "on_hire",
  purchaseOrderId: "9".repeat(24), poCode: "PO-0042",
  warehouseId: WH, warehouseName: "Leeds", warehouseCode: "LDS", orderLive: true,
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  id: REQ_ID, code: "JKR-0031", status: "pending", jobId: JOB_ID, jobNumber: "JOB-2026-0035",
  requestedByEngineerId: TO_ENG, requestedByEngineerName: "Shahul FE", requestedByEngineerEmail: "fe@x.com",
  reason: "need another tester", notes: null, reviewedByUserId: null, reviewedByEmail: null, reviewedAt: null,
  decisionNote: null, fulfillmentMode: null, createdBy: null,
  createdAt: new Date("2026-08-24T00:00:00Z"), updatedAt: new Date("2026-08-24T00:00:00Z"),
  transferId: null, transferIds: [],
  lines: [
    { id: L_RENTAL, source: "rental", irmItemId: null, rentalItemId: RENTAL, customerStockEntryId: null, itemName: "Fibre Tester", qty: 1, jobKitLineId: null, sourceEngineerId: null },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jobRepo.findById).mockResolvedValue({ id: JOB_ID, jobNumber: "JOB-2026-0035", status: "in_progress", customerId: "c".repeat(24), assignedEngineerId: TO_ENG, assignedEngineerName: "Shahul FE", assignedEngineerEmail: "fe@x.com", kitLines: [] } as never);
  vi.mocked(kitRequestRepo.findById).mockResolvedValue(request() as never);
  vi.mocked(kitRequestRepo.claimPending).mockResolvedValue(1 as never);
  vi.mocked(kitRequestRepo.finalizeApproval).mockResolvedValue(request({ status: "approved" }) as never);
  vi.mocked(jobService.appendKitFromRequest).mockResolvedValue({ job: {}, jobKitLineIds: ["k1"] } as never);
  vi.mocked(rentalItemRepo.findById).mockResolvedValue(RENTAL_ITEM as never);
  vi.mocked(kitRequestRepo.createKitRequest).mockResolvedValue(request() as never);
  vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire()] as never);
});

describe("create — requesting hired kit", () => {
  it("snapshots the catalogue item and carries the rental id", async () => {
    await create({ jobId: JOB_ID, reason: "need another tester", lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 }] } as never, { id: TO_ENG, email: "fe@x.com" } as never);
    const [, lines] = vi.mocked(kitRequestRepo.createKitRequest).mock.calls[0]!;
    // The old create() ended in an unguarded `return { source: "misc", ... }`, so a rental line would
    // have been persisted as free text with the item id silently dropped — no error anywhere.
    expect(lines[0]).toMatchObject({ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 });
    // No SKU on a rental master by design; the code takes its place, which is what the label carries.
    expect(lines[0]!.sku).toBe("RNT-0007");
  });

  it("refuses a retired rental item", async () => {
    vi.mocked(rentalItemRepo.findById).mockResolvedValue({ ...RENTAL_ITEM, status: "inactive" } as never);
    await expect(
      create({ jobId: JOB_ID, reason: "x", lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 }] } as never, { id: TO_ENG, email: "fe@x.com" } as never),
    ).rejects.toThrow(/is not active/i);
  });
});

describe("approve — a rental is warehouse-only", () => {
  it("grows the kit as a rental line at the chosen depot", async () => {
    await approve(REQ_ID, { lineSources: [{ requestLineId: L_RENTAL, sourceType: "warehouse", warehouseId: WH }] } as never, actor);
    const [, appendLines] = vi.mocked(jobService.appendKitFromRequest).mock.calls[0]!;
    expect(appendLines[0]).toMatchObject({ source: "rental", rentalItemId: RENTAL, warehouseId: WH, qty: 1 });
    // No transfer: hired kit is collected, never handed over from a van.
    expect(transferService.createJobTransfer).not.toHaveBeenCalled();
  });

  // THE RULE. Custody of a hire is anchored to the depot that took delivery and the provider collects
  // it from there, so a van is never a source. The UI does not offer it; a stale tab or a direct call
  // would otherwise open a transfer of equipment we do not own.
  it("refuses to source a rental from an engineer's van", async () => {
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_RENTAL, sourceType: "engineer", engineerId: OTHER_ENG }] } as never, actor),
    ).rejects.toThrow(/rental item — hired equipment is collected from the depot/i);
    expect(kitRequestRepo.claimPending).not.toHaveBeenCalled();
  });

  it("refuses the legacy all-from-one-van shorthand too", async () => {
    // Same rule, different request shape. The shape of the request must not change the answer.
    await expect(
      approve(REQ_ID, { fulfillmentMode: "engineer_transfer", fromEngineerId: OTHER_ENG } as never, actor),
    ).rejects.toThrow(/rental item — hired equipment is collected from the depot/i);
  });

  it("demands a pickup depot", async () => {
    // Before rental was added to this arm it fell through to the customer-stock path, whose warehouse
    // is "derived downstream" — but nothing derives a depot for a hire, so the kit line was grown with
    // no warehouse and the engineer was told to collect it from nowhere.
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_RENTAL, sourceType: "warehouse" }] } as never, actor),
    ).rejects.toThrow(/Choose a pickup warehouse/i);
  });

  it("refuses more than the depot has free on hire", async () => {
    vi.mocked(kitRequestRepo.findById).mockResolvedValue(request({ lines: [{ ...request().lines[0], qty: 5 }] }) as never);
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_RENTAL, sourceType: "warehouse", warehouseId: WH }] } as never, actor),
    ).rejects.toThrow(/only 3 free on hire/i);
  });

  it("refuses a depot that holds no hire of this item", async () => {
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_RENTAL, sourceType: "warehouse", warehouseId: OTHER_WH }] } as never, actor),
    ).rejects.toThrow(/only 0 free on hire/i);
  });

  it("counts units already out with an engineer against the depot", async () => {
    // received 3, one already in a van ⇒ 2 collectable, so approving 3 must fail.
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire({ issuedQuantity: 1 })] as never);
    vi.mocked(kitRequestRepo.findById).mockResolvedValue(request({ lines: [{ ...request().lines[0], qty: 3 }] }) as never);
    await expect(
      approve(REQ_ID, { lineSources: [{ requestLineId: L_RENTAL, sourceType: "warehouse", warehouseId: WH }] } as never, actor),
    ).rejects.toThrow(/only 2 free on hire/i);
  });

  it("honours the reviewer's trim", async () => {
    vi.mocked(kitRequestRepo.findById).mockResolvedValue(request({ lines: [{ ...request().lines[0], qty: 5 }] }) as never);
    await approve(REQ_ID, { lineSources: [{ requestLineId: L_RENTAL, sourceType: "warehouse", warehouseId: WH, approvedQty: 2 }] } as never, actor);
    const [, appendLines] = vi.mocked(jobService.appendKitFromRequest).mock.calls[0]!;
    expect(appendLines[0]).toMatchObject({ source: "rental", qty: 2 });
  });
});

// The pickup label. Customer stock is located by its entry; an approved rental is located by the
// depot the reviewer chose. The resolver used to key its map by ENTRY id, which could only ever
// describe the first — so a rental line came back with no location and the engineer's app had nothing
// to print under "collect from".
describe("getOne — an approved rental line names its depot", () => {
  it("labels the line with the depot it was sourced from", async () => {
    vi.mocked(kitRequestRepo.findById).mockResolvedValue(
      request({
        status: "approved",
        lines: [{ ...request().lines[0], sourceType: "warehouse", sourceWarehouseId: WH, approvedQty: 1 }],
      }) as never,
    );
    const { getOne } = await import("./job-kit-request.service.js");
    const out = await getOne(REQ_ID, { ...(actor as object), permissions: ["jobs.kit_request.review"] } as never);
    expect(out.lines[0]).toMatchObject({ source: "rental", warehouseName: "Leeds", warehouseCode: "LDS" });
  });
});

describe("searchItems — hired kit in the composer", () => {
  it("offers rental items with their free-on-hire total and depots", async () => {
    vi.mocked(rentalItemRepo.findMany).mockResolvedValue({ items: [RENTAL_ITEM], total: 1 } as never);
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire(), hire({ id: "h2", warehouseId: OTHER_WH, warehouseName: "York", receivedQuantity: 1 })] as never);

    const out = await searchItems("fibre", JOB_ID);
    const rental = out.find((o) => o.source === "rental");
    expect(rental).toMatchObject({ rentalItemId: RENTAL, code: "RNT-0007", quantityOnHand: 4 });
    // Never van-sourceable — pinned structurally so the composer renders "none on a van" rather than
    // an absent field the UI would read as unknown.
    expect(rental && "heldByEngineers" in rental && rental.heldByEngineers).toBe(0);
    // Fullest depot first — the one a reviewer will pick.
    expect(rental && "depots" in rental && rental.depots.map((d) => d.available)).toEqual([3, 1]);
  });

  it("still returns an item with nothing on hire, so the composer can say why", async () => {
    vi.mocked(rentalItemRepo.findMany).mockResolvedValue({ items: [RENTAL_ITEM], total: 1 } as never);
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([] as never);
    const out = await searchItems("fibre", JOB_ID);
    // Hidden, it would just get retyped. Returned with zeroes, the row can be disabled and explained.
    expect(out.find((o) => o.source === "rental")).toMatchObject({ quantityOnHand: 0, depots: [] });
  });
});
