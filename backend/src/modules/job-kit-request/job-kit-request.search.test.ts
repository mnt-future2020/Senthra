import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused unit tests for the composer item-search: IRM catalogue always, plus the JOB'S OWN customer's
// active in-stock consignment entries when a jobId is given. The service module pulls in a lot of
// cross-module deps at import time, so every one it imports is mocked to a no-op — only irmRepo, jobRepo
// and goodsManagementRepo matter for searchItems.
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/job/job.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/job/job.service.js", () => ({}));
vi.mock("#modules/engineer-transfer/engineer-transfer.service.js", () => ({}));
vi.mock("#modules/irm/irm.repository.js", () => ({ findMany: vi.fn() }));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({ searchActiveCustomerStock: vi.fn(), findCustomerStockEntriesByIds: vi.fn() }));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({ jobCommittedByEngineer: vi.fn() }));
vi.mock("#modules/goods-management/demand.js", () => ({ getOpenDemand: vi.fn() }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({ findBalancesByItems: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancesByItemsAndWarehouses: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findMany: vi.fn() }));
vi.mock("#modules/engineer-transfer/engineer-transfer.repository.js", () => ({}));
vi.mock("#modules/settings/settings.service.js", () => ({ getCloudinaryCreds: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({ emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(), OFFICE_JOBS_ROOM: "office:jobs" }));

import * as jobRepo from "#modules/job/job.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
import { getOpenDemand } from "#modules/goods-management/demand.js";
import { searchItems } from "./job-kit-request.service.js";

const JOB_ID = "a".repeat(24);
const CUSTOMER_ID = "c".repeat(24);
const OTHER_CUSTOMER_ID = "d".repeat(24);
const ENGINEER_ID = "b".repeat(24);
const WH_ID = "w".repeat(24);

const irmRow = () => ({ id: "i".repeat(24), code: "IRM-1", name: "CAT6 Cable", sku: "SKU1", baseUnit: "Box" });
const cseRow = () => ({
  id: "e".repeat(24),
  itemName: "mouse123",
  sku: "M1",
  uom: "Each",
  quantity: 4,
  serialNumber: null,
  warehouseId: "w".repeat(24),
  warehouseName: "Testing Ware",
  warehouseCode: "WH-9",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(irmRepo.findMany).mockResolvedValue([]);
  vi.mocked(goodsManagementRepo.searchActiveCustomerStock).mockResolvedValue([]);
  // itemAvailability owns the consignment quantity end-to-end, so the entry read is stubbed to agree
  // with whatever the search half returns.
  vi.mocked(goodsManagementRepo.findCustomerStockEntriesByIds).mockImplementation(
    async (ids: string[]) => ids.map((id) => ({ id, quantity: 4 })) as never,
  );
  vi.mocked(jobRepo.findById).mockResolvedValue({ id: JOB_ID, customerId: CUSTOMER_ID, assignedEngineerId: ENGINEER_ID } as never);
  vi.mocked(warehouseRepo.findMany).mockResolvedValue([{ id: WH_ID }] as never);
  vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([] as never);
  vi.mocked(engineerStockRepo.findBalancesByItems).mockResolvedValue([] as never);
  vi.mocked(getOpenDemand).mockResolvedValue(new Map() as never);
  vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
});

// Warehouse balance rows carry a warehouseId — free stock is computed PER warehouse, so demand at one
// site can never wipe out stock sitting at another.
const whRow = (quantityOnHand: number, warehouseId = WH_ID) => ({ irmItemId: irmRow().id, warehouseId, quantityOnHand });
const demandRow = (demand: number, warehouseId = WH_ID) => ({
  irmItemId: irmRow().id,
  customerStockEntryId: null,
  warehouseId,
  itemName: "CAT6 Cable",
  warehouseName: "WH",
  demand,
});
const demandMap = (...rows: ReturnType<typeof demandRow>[]) => new Map(rows.map((r, i) => [`k${i}`, r]));

describe("searchItems", () => {
  it("returns nothing for a blank term (never enumerates a catalogue)", async () => {
    const out = await searchItems("   ", JOB_ID);
    expect(out).toEqual([]);
    expect(irmRepo.findMany).not.toHaveBeenCalled();
    expect(goodsManagementRepo.searchActiveCustomerStock).not.toHaveBeenCalled();
  });

  it("searches IRM only when no jobId is given (backward-safe)", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    const out = await searchItems("cat");
    expect(goodsManagementRepo.searchActiveCustomerStock).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "irm", name: "CAT6 Cable" });
  });

  it("merges IRM + the job's customer stock, scoped to the job's customerId", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(goodsManagementRepo.searchActiveCustomerStock).mockResolvedValue([cseRow()] as never);
    const out = await searchItems("mouse", JOB_ID);

    // Customer-stock search must be scoped to the job's OWN customer, never a caller-supplied id.
    expect(goodsManagementRepo.searchActiveCustomerStock).toHaveBeenCalledWith(CUSTOMER_ID, "mouse", 20);
    expect(goodsManagementRepo.searchActiveCustomerStock).not.toHaveBeenCalledWith(OTHER_CUSTOMER_ID, expect.anything(), expect.anything());

    const cse = out.find((o) => o.source === "customer_stock");
    expect(cse).toMatchObject({
      source: "customer_stock",
      customerStockEntryId: cseRow().id,
      name: "mouse123",
      qty: 4,
      warehouseName: "Testing Ware",
      warehouseCode: "WH-9",
    });
  });

  it("stays resilient (IRM only) when the job is missing/soft-deleted", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(jobRepo.findById).mockResolvedValue(null);
    const out = await searchItems("cat", JOB_ID);
    expect(goodsManagementRepo.searchActiveCustomerStock).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("irm");
  });
});

// An engineer could request any ACTIVE catalogue item, whether or not a single unit existed anywhere.
// The request then reached a planner who could not action it: approve() sources every line from a
// warehouse or another engineer's van, and with neither holding any there is nothing to pick — the
// dialog's Approve stays disabled and the request sits pending forever. JKR-0026 was exactly this.
//
// So the search now reports what could actually fulfil the line: warehouse stock network-wide PLUS
// what other engineers hold. The item is still RETURNED when both are zero, not hidden — an engineer
// whose search silently drops an item they can see in the catalogue learns nothing; one that comes
// back marked "out of stock" learns why. The composer renders it disabled. Same call the van-stock
// composer already makes (searchRequestableItems).
describe("searchItems — availability, so an unfulfillable item can't be requested", () => {
  it("reports warehouse stock and other engineers' van stock separately", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([
      { irmItemId: irmRow().id, quantityOnHand: 7 },
    ] as never);
    vi.mocked(engineerStockRepo.findBalancesByItems).mockResolvedValue([
      { irmItemId: irmRow().id, quantityOnHand: 3 },
    ] as never);

    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ source: "irm", quantityOnHand: 7, heldByEngineers: 3 });
  });

  // The zero/zero case — the bug. Returned, not dropped, and both counts are explicitly 0 so the
  // composer has something unambiguous to disable on.
  it("returns the item with both counts at zero when nothing exists anywhere", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    const out = await searchItems("cat", JOB_ID);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ quantityOnHand: 0, heldByEngineers: 0 });
  });

  // An item held ONLY on another engineer's van is fulfillable — approve() can transfer it. Counting
  // warehouses alone would have marked it unavailable and blocked a legitimate request.
  it("counts a van-only item as available", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(engineerStockRepo.findBalancesByItems).mockResolvedValue([
      { irmItemId: irmRow().id, quantityOnHand: 2 },
    ] as never);
    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ quantityOnHand: 0, heldByEngineers: 2 });
  });

  // The requesting job's OWN engineer can't supply their own kit request — holdersByLine excludes
  // them, and approve() would reject it. Counting their van here would advertise stock that no
  // source could actually draw on, which is the same dead-end in a new disguise.
  it("excludes the job's own engineer from the van tally", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    await searchItems("cat", JOB_ID);
    expect(engineerStockRepo.findBalancesByItems).toHaveBeenCalledWith([irmRow().id], ENGINEER_ID);
  });

  it("sums stock spread across several warehouses", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([
      { irmItemId: irmRow().id, quantityOnHand: 4 },
      { irmItemId: irmRow().id, quantityOnHand: 6 },
    ] as never);
    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ quantityOnHand: 10 });
  });

  // Availability is advisory metadata on a search result. If the stock lookups fail the engineer must
  // still be able to find and request items — approve() re-checks authoritatively either way.
  it("degrades to zero counts rather than failing the whole search", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockRejectedValue(new Error("boom"));
    const out = await searchItems("cat", JOB_ID);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "irm", quantityOnHand: 0 });
  });

  it("does no stock work at all when the catalogue search found nothing", async () => {
    const out = await searchItems("nothing-matches", JOB_ID);
    expect(out).toEqual([]);
    expect(inventoryRepo.findBalancesByItemsAndWarehouses).not.toHaveBeenCalled();
    expect(engineerStockRepo.findBalancesByItems).not.toHaveBeenCalled();
  });
});

// "In stock" has to mean the SAME thing here as on the job kit list and in the field-stock composer's
// "N free": on-hand minus stock already planned onto other jobs but not yet issued. Raw on-hand would
// let an engineer request units that are physically present but entirely spoken for — approve() then
// issues them and the job that had planned them comes up short. Field stock hit this exact bug and
// fixed it in availability(); the kit-request search must not reintroduce it.
describe("searchItems — availability nets off other jobs' planned demand", () => {
  it("subtracts open demand from warehouse stock", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(5)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(demandRow(3)) as never);

    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ quantityOnHand: 2 });
  });

  // The whole point: physically present, entirely committed, therefore not requestable.
  it("reports zero when every unit is already planned onto another job", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(2)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(demandRow(2)) as never);

    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ quantityOnHand: 0 });
  });

  // Floored per warehouse, exactly as availability() does it. Netting totals instead would let an
  // over-committed site eat real stock standing at another one.
  it("floors each warehouse at zero instead of letting one site's excess demand eat another's stock", async () => {
    const OTHER_WH = "z".repeat(24);
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(1), whRow(4, OTHER_WH)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(demandRow(10)) as never); // demand only at WH_ID

    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ quantityOnHand: 4 }); // not max(0, 5 - 10) = 0
  });

  // A colleague's van holding is only transferable if it isn't already committed to THEIR own job —
  // that stock has to go back through their job's reconcile, so offering it here would double-book it.
  it("subtracts a holder's own job commitments from the van tally", async () => {
    const HOLDER = "h".repeat(24);
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(engineerStockRepo.findBalancesByItems).mockResolvedValue([
      { irmItemId: irmRow().id, engineerId: HOLDER, quantityOnHand: 5 },
    ] as never);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map([[irmRow().id, 4]]) as never);

    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ heldByEngineers: 1 });
  });

  it("treats a fully-committed van as holding nothing spare", async () => {
    const HOLDER = "h".repeat(24);
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(engineerStockRepo.findBalancesByItems).mockResolvedValue([
      { irmItemId: irmRow().id, engineerId: HOLDER, quantityOnHand: 3 },
    ] as never);
    vi.mocked(goodsManagementService.jobCommittedByEngineer).mockResolvedValue(new Map([[irmRow().id, 3]]) as never);

    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ heldByEngineers: 0 });
  });

  // Commitments are per engineer, so the lookup must run once per DISTINCT holder — not once per
  // balance row, and not once for the whole result set.
  it("asks for commitments once per distinct holder", async () => {
    const A = "h".repeat(24);
    const B = "g".repeat(24);
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(engineerStockRepo.findBalancesByItems).mockResolvedValue([
      { irmItemId: irmRow().id, engineerId: A, quantityOnHand: 2 },
      { irmItemId: irmRow().id, engineerId: A, quantityOnHand: 1 },
      { irmItemId: irmRow().id, engineerId: B, quantityOnHand: 4 },
    ] as never);

    await searchItems("cat", JOB_ID);
    expect(goodsManagementService.jobCommittedByEngineer).toHaveBeenCalledTimes(2);
  });

  it("still degrades to raw counts if the demand lookup fails", async () => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(5)] as never);
    vi.mocked(getOpenDemand).mockRejectedValue(new Error("boom"));

    const [item] = await searchItems("cat", JOB_ID);
    expect(item).toMatchObject({ quantityOnHand: 5 });
  });
});

// Customer consignment is the one non-IRM pool a kit request can draw on, and it has exactly the same
// exposure: getOpenDemand keys customer lines as `cse|<entryId>|<warehouseId>`, so the demand is
// tracked — but every consumer filters on `d.irmItemId`, which silently drops those rows. The entry's
// raw `quantity` therefore reached the engineer as "in stock" even when another job's kit had already
// planned every unit. Same bug as the IRM side, on the pool the IRM fix didn't reach.
describe("searchItems — customer stock nets its own planned demand", () => {
  const CSE_ID = "e".repeat(24);
  const cseDemand = (demand: number) =>
    new Map([["cse", { irmItemId: null, customerStockEntryId: CSE_ID, warehouseId: WH_ID, itemName: "mouse123", warehouseName: "WH", demand }]]);

  beforeEach(() => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([]);
    vi.mocked(goodsManagementRepo.searchActiveCustomerStock).mockResolvedValue([cseRow()] as never); // quantity 4
  });

  it("subtracts demand planned against the consignment entry", async () => {
    vi.mocked(getOpenDemand).mockResolvedValue(cseDemand(3) as never);
    const [item] = await searchItems("mouse", JOB_ID);
    expect(item).toMatchObject({ source: "customer_stock", qty: 1 });
  });

  it("reports zero when the whole entry is planned onto another job", async () => {
    vi.mocked(getOpenDemand).mockResolvedValue(cseDemand(4) as never);
    const [item] = await searchItems("mouse", JOB_ID);
    expect(item).toMatchObject({ qty: 0 });
  });

  it("leaves an unplanned entry at its full quantity", async () => {
    const [item] = await searchItems("mouse", JOB_ID);
    expect(item).toMatchObject({ qty: 4 });
  });

  // IRM demand must not be netted off a consignment entry — different pool, different key.
  it("ignores demand booked against an IRM item", async () => {
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(demandRow(9)) as never);
    const [item] = await searchItems("mouse", JOB_ID);
    expect(item).toMatchObject({ qty: 4 });
  });
});

// Consignment is WAREHOUSE-ONLY here, and an earlier version of this file assumed otherwise.
//
// A field stock request carries only irmItemId — its validation has no customerStockEntryId — so this
// pool never reaches an engineer as free van stock. The only writes to EngineerCustomerStockHolding
// are a JOB ISSUE and a job-scoped transfer, so every unit an engineer holds is already committed to
// their job. That is exactly why jobCommittedByEngineer refuses to cover customer stock ("never
// field-returnable"): there is no commitment figure to net off, so counting the raw holding would
// double-book another job's stock. A planner can still re-allocate it deliberately at approve time
// via holdersByLine — that is a decision, not availability.
describe("searchItems — consignment availability ignores engineer holdings", () => {
  beforeEach(() => {
    vi.mocked(irmRepo.findMany).mockResolvedValue([]);
    vi.mocked(goodsManagementRepo.searchActiveCustomerStock).mockResolvedValue([cseRow()] as never);
  });

  it("reports the shelf quantity and no van figure at all", async () => {
    const [item] = await searchItems("mouse", JOB_ID);
    expect(item).toMatchObject({ source: "customer_stock", qty: 4 });
    expect(item).not.toHaveProperty("heldByEngineers");
  });
});
