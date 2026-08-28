import { beforeEach, describe, expect, it, vi } from "vitest";

// The ENGINEER's field-stock catalogue search. It decides which items are selectable at all, so its
// idea of "in stock" has to be the same one the composer shows per warehouse a moment later.
//
// It wasn't. availability() nets off other jobs' planned-but-unissued demand — that fix has its own
// note there, prompted by an engineer being told 2 were free and having them scanned onto their van
// out from under a job that had already planned them. This search kept using RAW on-hand, so the same
// item could pass the out-of-stock gate and then show "0 free" on the very next screen.
//
// The service pulls in a lot of cross-module deps at import; only the four this function touches are
// given real mocks.
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({}));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({ getOpenDemand: vi.fn(), jobCommittedByEngineer: vi.fn() }));
vi.mock("#modules/inventory/inventory.repository.js", () => ({ findBalancesByItemsAndWarehouses: vi.fn(), findInStockBalancesByWarehouse: vi.fn() }));
vi.mock("#modules/inventory/inventory.service.js", () => ({}));
vi.mock("#modules/irm/irm.repository.js", () => ({ findMany: vi.fn() }));
vi.mock("#modules/irm/irm.service.js", () => ({}));
// The counter serves BOTH pools now, so the browse and typed arms both reach the rental catalogue and
// the hire finder. Stubbed empty here on purpose: this file's subject is how PLANNED DEMAND is netted
// off COMPANY stock, and the rental pool is covered end-to-end in van-stock-request.rental.test.ts.
// Without these the arms would reach the real Prisma client, which this suite has no database for.
vi.mock("#modules/rental-item/rental-item.repository.js", () => ({
  findMany: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  findIssuableHiresByRentalItems: vi.fn(async () => []),
}));

// The counter now serves hired kit as well as company stock, so the browse arm resolves company-today
// to judge which hires are still issuable. A fixed timezone keeps these assertions about DEMAND, which
// is what this file is for.
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(), getCompanyTimezone: vi.fn(async () => "Europe/London"),
}));
vi.mock("#modules/user/user.repository.js", () => ({}));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findMany: vi.fn() }));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("#modules/notification/notification.service.js", () => ({ notify: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({ emitAttentionChanged: vi.fn(), emitToRoom: vi.fn(), emitToUser: vi.fn(), VAN_STOCK_REVIEWERS_ROOM: "vsr" }));
// The repository also exports pure helpers the service uses at module scope; stub the ones it binds.
vi.mock("./van-stock-request.repository.js", () => ({
  lineDone: vi.fn(),
  lineRemaining: vi.fn(),
  linesAllDone: vi.fn(),
  belongsToWarehouses: vi.fn(),
}));
vi.mock("../../lib/warehouse-access.js", () => ({
  assertWarehouseAccess: vi.fn(),
  getAccessibleWarehouseIds: vi.fn(),
  warehouseScopeFilter: vi.fn(),
}));

import * as irmRepo from "#modules/irm/irm.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import { getOpenDemand } from "#modules/goods-management/goods-management.service.js";
import { searchRequestableItems, searchWarehouseItems } from "./van-stock-request.service.js";

const ITEM = "i".repeat(24);
const WH = "w".repeat(24);
const OTHER_WH = "z".repeat(24);

const irmRow = () => ({ id: ITEM, code: "IRM-1", name: "CAT6 Cable", sku: null, baseUnit: "Box", reorderLevel: null, trackSerialNumbers: false, trackBatchNumbers: false });
const whRow = (quantityOnHand: number, warehouseId = WH) => ({ irmItemId: ITEM, warehouseId, quantityOnHand });
const demandMap = (demand: number, warehouseId = WH) =>
  new Map([["k", { irmItemId: ITEM, customerStockEntryId: null, warehouseId, itemName: "CAT6 Cable", warehouseName: "WH", demand }]]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(irmRepo.findMany).mockResolvedValue([irmRow()] as never);
  vi.mocked(warehouseRepo.findMany).mockResolvedValue([{ id: WH }, { id: OTHER_WH }] as never);
  vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([] as never);
  vi.mocked(getOpenDemand).mockResolvedValue(new Map() as never);
});

describe("searchRequestableItems — agrees with the composer's own 'N free'", () => {
  it("subtracts stock already planned onto active jobs", async () => {
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(5)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(3) as never);

    const [item] = await searchRequestableItems("cat");
    expect(item.quantityOnHand).toBe(2);
  });

  // The gate that matters: physically present, wholly committed ⇒ the composer must show it disabled
  // rather than letting the engineer request units another job is already counting on.
  it("reports zero when every unit is spoken for", async () => {
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(2)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(2) as never);

    const [item] = await searchRequestableItems("cat");
    expect(item.quantityOnHand).toBe(0);
  });

  // Floored per warehouse, as availability() does. Netting totals would let one over-committed site
  // wipe out real stock standing at another.
  it("floors each warehouse separately", async () => {
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(1), whRow(4, OTHER_WH)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(10) as never); // all at WH

    const [item] = await searchRequestableItems("cat");
    expect(item.quantityOnHand).toBe(4);
  });

  it("leaves stock untouched when nothing is planned", async () => {
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(6)] as never);
    const [item] = await searchRequestableItems("cat");
    expect(item.quantityOnHand).toBe(6);
  });
});

// The WALK-IN counter — stock handed over the desk and scanned out on the spot. Its search used raw
// on-hand, defended by a comment about mirroring "what the scan-out ledger guards on". That reasoning
// covers quantityReserved (dead — always 0) but predates demand netting, and it left the fastest way
// to drain a warehouse as the one door ignoring what jobs have planned: the counter can hand out the
// last 3 units a job's kit is counting on, and the job is stranded with no warning until its engineer
// turns up at the same counter. The engineer's own restock composer already nets demand; handing
// stock over a different door shouldn't obey different arithmetic.
describe("searchWarehouseItems — the walk-in counter respects planned demand", () => {
  const actor = { id: "u".repeat(24), email: "wm@x.com" } as never;

  it("nets this warehouse's planned demand off the counter's figure", async () => {
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(5)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(3) as never);

    const [item] = await searchWarehouseItems(actor, WH, "cat");
    expect(item.quantityOnHand).toBe(2);
  });

  // Fully committed ⇒ nothing to hand out. Dropped like any other unavailable line, matching what the
  // counter already does for an item with no balance here — it can't be issued either way.
  it("drops an item whose every unit is already planned onto a job", async () => {
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(2)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(2) as never);

    expect(await searchWarehouseItems(actor, WH, "cat")).toEqual([]);
  });

  // Demand is keyed by item+warehouse. Another site's commitments must not shrink what THIS counter
  // can hand out — different physical shelf.
  it("ignores demand booked against a different warehouse", async () => {
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(5)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(4, OTHER_WH) as never);

    const [item] = await searchWarehouseItems(actor, WH, "cat");
    expect(item.quantityOnHand).toBe(5);
  });

  it("leaves an unplanned item at its full on-hand", async () => {
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([whRow(6)] as never);
    const [item] = await searchWarehouseItems(actor, WH, "cat");
    expect(item.quantityOnHand).toBe(6);
  });
});

// The counter's BROWSE list (no query typed) is the same shelf answering the same question, so it has
// to net demand identically — otherwise typing a letter would change what the counter believes it can
// hand out.
describe("searchWarehouseItems — the browse list agrees with the typed search", () => {
  const actor = { id: "u".repeat(24), email: "wm@x.com" } as never;
  const browseRow = (quantityOnHand: number) => ({
    irmItemId: ITEM,
    quantityOnHand,
    irmItem: { code: "IRM-1", name: "CAT6 Cable", sku: null, baseUnit: "Box", reorderLevel: null, trackSerialNumbers: false, trackBatchNumbers: false },
  });

  it("nets planned demand off the browse figure", async () => {
    vi.mocked(inventoryRepo.findInStockBalancesByWarehouse).mockResolvedValue([browseRow(5)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(3) as never);

    const [item] = await searchWarehouseItems(actor, WH, "");
    expect(item.quantityOnHand).toBe(2);
  });

  it("drops a fully-committed item from the browse list", async () => {
    vi.mocked(inventoryRepo.findInStockBalancesByWarehouse).mockResolvedValue([browseRow(2)] as never);
    vi.mocked(getOpenDemand).mockResolvedValue(demandMap(2) as never);

    expect(await searchWarehouseItems(actor, WH, "")).toEqual([]);
  });
});
