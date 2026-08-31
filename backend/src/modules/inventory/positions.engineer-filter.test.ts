import { beforeEach, describe, expect, it, vi } from "vitest";

// The engineer lens's FILTER reaching its own download — and the CONTRACT that filter carries.
//
// The lens is a roll-up (one row per engineer); its "Export field stock" is the per-item detail
// behind it, which is what a stock count is done against. The granularity differs on purpose — the
// SCOPE must not, and it did: the download sent neither of the lens's filters, so searching one
// engineer and pressing export produced every engineer's holdings.
//
// Three things are pinned here and each was a real defect:
//
//   1. Screen and file narrow by ONE predicate (`matchesEngineerLens`), so they cannot disagree.
//   2. `engineerSearch` is ENGINEER-SCOPED BY DEFINITION — a warehouse row has no engineer, so it is
//      excluded. The pair it replaced expressed that as a side effect of `holdingOnly`, which meant
//      `?holding=1` alone silently deleted every warehouse, customer and damaged row from a list
//      nobody had asked to narrow. The matrix below is what stops that returning.
//   3. A search matching NOBODY yields an EMPTY file, never an unfiltered one.

vi.mock("./inventory.repository.js", () => ({ findAllBalancesForAggregation: vi.fn(async () => []) }));
vi.mock("#modules/engineer/engineer.repository.js", () => ({
  findAllBalances: vi.fn(async () => []),
  findEngineers: vi.fn(async () => []),
}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  findAllCustomerHoldings: vi.fn(async () => []),
  findAllDamaged: vi.fn(async () => []),
}));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({ getOverdueSummary: vi.fn() }));
vi.mock("#modules/customer/customer.repository.js", () => ({ findActiveStockEntries: vi.fn(async () => []) }));
vi.mock("#modules/job/job.repository.js", () => ({ countActiveJobsByEngineer: vi.fn(async () => new Map()) }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getRegionalSettings: vi.fn(async () => ({ dateFormat: "dd/MM/yyyy", timezone: "Europe/London" })),
}));

import * as inventoryRepo from "./inventory.repository.js";
import * as engineerRepo from "#modules/engineer/engineer.repository.js";
import {
  exportAllPositionsCsv,
  listEngineerInventoryPaged,
  listStockPositions,
  matchesEngineerLens,
} from "./aggregation.service.js";

const KANSHA = "k".repeat(24);
const RAJ = "r".repeat(24);
/** An engineer on the roster who carries NOTHING — the case `holdingCount` exists for. */
const IDLE = "i".repeat(24);
const WAREHOUSE = "w".repeat(24);

const engineers = [
  { id: KANSHA, firstName: "Kansha", lastName: "Patel", email: "kansha@example.com" },
  { id: RAJ, firstName: "Raj", lastName: "Singh", email: "raj@example.com" },
  { id: IDLE, firstName: "Idle", lastName: "Engineer", email: "idle@example.com" },
];

const engBalance = (engineerId: string, code: string, engineer: (typeof engineers)[number]) => ({
  id: `bal-${engineerId}-${code}`,
  engineerId,
  engineer,
  irmItemId: `item-${code}`,
  quantityOnHand: 5,
  updatedAt: new Date("2026-08-01T09:00:00.000Z"),
  irmItem: { id: `item-${code}`, code, name: `Item ${code}`, sku: code, category: { name: "Cables" }, reorderLevel: 0 },
});

/** A company warehouse row — the kind that must survive an engineer-unrelated query. */
const whBalance = (code: string) => ({
  id: `wh-${code}`,
  warehouseId: WAREHOUSE,
  warehouse: { id: WAREHOUSE, name: "London Hub", code: "WH-0001" },
  irmItemId: `item-${code}`,
  quantityOnHand: 12,
  quantityReserved: 0,
  updatedAt: new Date("2026-08-01T09:00:00.000Z"),
  irmItem: { id: `item-${code}`, code, name: `Item ${code}`, sku: code, category: { name: "Cables" }, reorderLevel: 0, unitCostPence: 100 },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(engineerRepo.findEngineers).mockResolvedValue(engineers as never);
  vi.mocked(engineerRepo.findAllBalances).mockResolvedValue([
    engBalance(KANSHA, "CAT6", engineers[0]!),
    engBalance(RAJ, "SFP-LX", engineers[1]!),
  ] as never);
  vi.mocked(inventoryRepo.findAllBalancesForAggregation).mockResolvedValue([whBalance("WH-ONLY")] as never);
});

const codesIn = (csv: string) => ["CAT6", "SFP-LX", "WH-ONLY"].filter((c) => csv.includes(c));
const codesOf = async (f: Parameters<typeof listStockPositions>[0]) =>
  (await listStockPositions({ ...f, page: 1, pageSize: 100 })).positions.map((p) => p.itemCode);

describe("engineerSearch narrows the export to the engineers on screen", () => {
  it("returns only the searched engineer's items", async () => {
    const { csv } = await exportAllPositionsCsv({ locationType: "engineer", engineerSearch: "kansha" });
    expect(codesIn(csv)).toEqual(["CAT6"]);
  });

  it("matches on EMAIL as well as name — the two fields the lens searches", async () => {
    const { csv } = await exportAllPositionsCsv({ locationType: "engineer", engineerSearch: "raj@example.com" });
    expect(codesIn(csv)).toEqual(["SFP-LX"]);
  });

  it("returns every engineer when no search is applied", async () => {
    const { csv } = await exportAllPositionsCsv({ locationType: "engineer" });
    expect(codesIn(csv)).toEqual(["CAT6", "SFP-LX"]);
  });

  it("returns NOTHING when the search matches nobody — it must not fall back to unfiltered", async () => {
    // The regression that matters most. `engineerIds: []` means "asked, and nobody matched";
    // collapsing it to `undefined` would turn a zero-result filter into the whole field ledger.
    const { csv } = await exportAllPositionsCsv({ locationType: "engineer", engineerSearch: "nobody-by-this-name" });
    expect(codesIn(csv)).toEqual([]);
  });
});

// ── #2: the location/holding matrix ────────────────────────────────────────────────────────────
//
// Every one of these ran through the OLD `holdingOnly` pair, and the second row is the one it got
// wrong: `holding=true` with no location returned engineer rows ONLY.
describe("the engineer filter never silently implies a location", () => {
  it("no location, no engineer filter → every pool is present", async () => {
    expect(await codesOf({})).toEqual(expect.arrayContaining(["CAT6", "SFP-LX", "WH-ONLY"]));
  });

  it("no location + holding=true → still every pool (holding is not a position filter)", async () => {
    // `holding` is not part of PositionFilters at all now, so it cannot reach this call. Passing it
    // as an unknown key proves the type AND the runtime both ignore it rather than narrowing.
    const codes = await codesOf({ ...({ holdingOnly: true, holding: true } as object) });
    expect(codes).toContain("WH-ONLY");
    expect(codes).toEqual(expect.arrayContaining(["CAT6", "SFP-LX", "WH-ONLY"]));
  });

  it("no location + holding=false → identical to holding=true, and to neither", async () => {
    const off = await codesOf({ ...({ holdingOnly: false, holding: false } as object) });
    expect(off).toEqual(await codesOf({}));
  });

  it("location=engineer + engineerSearch → that engineer's rows, warehouse excluded", async () => {
    expect(await codesOf({ locationType: "engineer", engineerSearch: "kansha" })).toEqual(["CAT6"]);
  });

  it("location=warehouse + engineerSearch → empty, because a shelf has no engineer", async () => {
    // A contradictory query. It returns nothing rather than 400 — honest, and it NARROWS, which is
    // the only direction a filter is ever allowed to move an authorised set.
    expect(await codesOf({ locationType: "warehouse", engineerSearch: "kansha" })).toEqual([]);
  });

  it("location=warehouse alone → the warehouse row, untouched by anything engineer-related", async () => {
    expect(await codesOf({ locationType: "warehouse" })).toEqual(["WH-ONLY"]);
  });

  it("engineerSearch with NO location → engineer rows only, which is the filter's stated meaning", async () => {
    expect(await codesOf({ engineerSearch: "kansha" })).toEqual(["CAT6"]);
  });
});

describe("the list and the export resolve the engineer filter identically", () => {
  it("returns the same item rows for the same filters", async () => {
    const filters = { locationType: "engineer" as const, engineerSearch: "kansha" };
    const listed = await listStockPositions({ ...filters, page: 1, pageSize: 100 });
    const { csv } = await exportAllPositionsCsv(filters);
    expect(listed.positions.map((p) => p.itemCode)).toEqual(["CAT6"]);
    expect(codesIn(csv)).toEqual(listed.positions.map((p) => p.itemCode));
  });

  it("the CSV row count equals the filtered list TOTAL, not the page", async () => {
    const filters = { locationType: "engineer" as const, engineerSearch: "kansha" };
    const listed = await listStockPositions({ ...filters, page: 1, pageSize: 1 }); // deliberately ONE per page
    const { csv } = await exportAllPositionsCsv(filters);
    expect(listed.positions).toHaveLength(1);
    expect(csv.split("\r\n").length - 1).toBe(listed.total);
  });
});

// ── #6: the read that was removed ──────────────────────────────────────────────────────────────
describe("holdingOnly does not reach the position layer", () => {
  it("resolves no engineer roster when only holding was asked for", async () => {
    // The roster read IS `findEngineers`. It used to fire for `holdingOnly` alone and could not
    // change the answer: an engineer's itemsHeld counts exactly the balance rows that become their
    // positions, so one it excluded had no rows to exclude.
    await listStockPositions({ ...({ holdingOnly: true } as object), page: 1, pageSize: 100 });
    expect(engineerRepo.findEngineers).not.toHaveBeenCalled();
  });

  it("still resolves the roster when an engineer SEARCH was asked for", async () => {
    await listStockPositions({ engineerSearch: "kansha", page: 1, pageSize: 100 });
    expect(engineerRepo.findEngineers).toHaveBeenCalledTimes(1);
  });

  it("reads the roster ONCE per export, not once per row", async () => {
    await exportAllPositionsCsv({ locationType: "engineer", engineerSearch: "kansha" });
    expect(engineerRepo.findEngineers).toHaveBeenCalledTimes(1);
  });
});

// ── #3's server half: the count the export button is disabled on ───────────────────────────────
describe("the lens reports how many matched engineers actually hold something", () => {
  it("counts only holders, not everyone matched", async () => {
    const page = await listEngineerInventoryPaged({});
    expect(page.total).toBe(3); // Kansha, Raj, Idle
    expect(page.holdingCount).toBe(2); // Idle carries nothing
  });

  it("is ZERO when the search matches only an engineer holding nothing", async () => {
    // The exact hole the disabled state closes: a screen showing one row whose export is empty.
    const page = await listEngineerInventoryPaged({ search: "idle" });
    expect(page.total).toBe(1);
    expect(page.holdingCount).toBe(0);
    const { csv } = await exportAllPositionsCsv({ locationType: "engineer", engineerSearch: "idle" });
    expect(csv.split("\r\n").length - 1).toBe(0);
  });

  it("is ZERO when the search matches nobody at all", async () => {
    expect((await listEngineerInventoryPaged({ search: "zzz" })).holdingCount).toBe(0);
  });

  it("counts across the whole match, not the current page", async () => {
    const page = await listEngineerInventoryPaged({ page: 1, pageSize: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.holdingCount).toBe(2);
  });

  it("still honours holdingOnly on the lens itself, where it means something", async () => {
    const page = await listEngineerInventoryPaged({ holdingOnly: true });
    expect(page.total).toBe(2);
    expect(page.holdingCount).toBe(2);
  });
});

describe("the shared lens predicate", () => {
  const row = { engineerId: KANSHA, name: "Kansha Patel", email: "kansha@example.com", itemsHeld: 0, totalQty: 0, activeJobs: 0 };

  it("excludes a non-holder when holdingOnly is set", () => {
    expect(matchesEngineerLens(row, { holdingOnly: true })).toBe(false);
    expect(matchesEngineerLens({ ...row, itemsHeld: 2 }, { holdingOnly: true })).toBe(true);
  });

  it("is case-insensitive and matches a substring, as the search box implies", () => {
    expect(matchesEngineerLens(row, { search: "PATEL" })).toBe(true);
    expect(matchesEngineerLens(row, { search: "  kan " })).toBe(true);
  });
});
